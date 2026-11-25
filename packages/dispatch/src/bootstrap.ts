import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DispatchAdapter, DispatchHealth, IdempotencyStore } from "./adapter.ts";
import { idempotencyOf, loadDispatchConfig, type DispatchConfig } from "./config.ts";
import { Dispatch, DispatchRuntime, type DispatchMetrics, type PublishInput } from "./engine.ts";
import { DispatchError } from "./envelope.ts";
import { CONSUMER_META, EVENTS_BRAND, EventRegistry, definitionProblems, type ConsumerClass, type EventsDefinition } from "./events.ts";
import { schemaProblems, type Schema } from "./schema.ts";

/** What the application gets while dispatch is disabled: a clear error on use, no connection, no background work. */
export class DisabledDispatch extends Dispatch {
  override async publish(type: string): Promise<never> { throw new DispatchError("PSO_DISPATCH_DISABLED", `cannot publish "${type}": dispatch is disabled (dispatch.enabled=false). Install a provider with \`pso dispatch:install\` and enable it.`); }
  override async health(): Promise<DispatchHealth> { return { status: "down", detail: "dispatch is disabled" }; }
  override metrics(): DispatchMetrics { return { published: 0, publishFailed: 0, consumed: 0, failed: 0, retried: 0, deadLettered: 0, dropped: 0, duplicates: 0, poison: 0, untrusted: 0, unverified: 0, processing: { count: 0, totalMs: 0, maxMs: 0 }, byType: {} }; }
}

export async function createAdapter(cfg: DispatchConfig): Promise<DispatchAdapter> {
  switch (cfg.provider) {
    case "redis": return new (await import("./redis.ts")).RedisStreamsAdapter(cfg.redis);
    case "rabbitmq": return new (await import("./rabbitmq.ts")).RabbitMqAdapter(cfg.rabbitmq);
    case "kafka": return new (await import("./kafka.ts")).KafkaAdapter(cfg.kafka);
    default: throw new DispatchError("PSO_DISPATCH_PROVIDER", `unsupported provider "${cfg.provider}"`);
  }
}

export interface LoadedModule { dir: string; def: EventsDefinition; consumers: ConsumerClass[]; problems: string[] }

/**
 * Loads the compiled dispatch modules of `dispatchDir` (dist/dispatch): only EVENTS.pso.js of each directory is required, so a
 * handler or producer class that is not declared there is never even loaded. Payload schema files are resolved relative to it.
 */
export function loadDispatchModules(dispatchDir: string, registry: EventRegistry): LoadedModule[] {
  if (!existsSync(dispatchDir)) return [];
  const out: LoadedModule[] = [];
  for (const dir of readdirSync(dispatchDir).sort()) {
    const file = join(dispatchDir, dir, "EVENTS.pso.js");
    if (!existsSync(file)) continue;
    const req = createRequire(file);
    const problems: string[] = [];
    let def: EventsDefinition | undefined;
    try { def = (req(file) as { default?: EventsDefinition }).default; } catch (e) { problems.push(`EVENTS.pso could not be loaded: ${(e as Error).message}`); }
    if (!def || !(def as unknown as Record<symbol, unknown>)[EVENTS_BRAND]) { problems.push("EVENTS.pso must default-export defineEvents({...})"); out.push({ dir, def: { events: [] }, consumers: [], problems }); continue; }
    problems.push(...definitionProblems(def));
    for (const e of def.events) {
      let schema: Schema | undefined;
      if (typeof e.schema === "string") {
        try { schema = (req(resolve(dispatchDir, dir, e.schema.replace(/\.ts$/, ".js"))) as { default?: Schema }).default; } catch (err) { problems.push(`schema of "${e.name}" could not be loaded: ${(err as Error).message}`); }
        if (schema) problems.push(...schemaProblems(schema).map((x) => `schema of "${e.name}": ${x}`));
      }
      try { registry.add(e, schema); } catch (err) { problems.push((err as Error).message); }
    }
    out.push({ dir, def, consumers: [...(def.consumers ?? [])], problems });
  }
  return out;
}

export interface StartOptions {
  appDir: string; projectDir: string; source: string; env?: NodeJS.ProcessEnv;
  /** builds a consumer instance (use the application's dependency container); defaults to `new Class()` */
  resolve?: (c: ConsumerClass) => InstanceType<ConsumerClass>;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export interface Started { dispatch: Dispatch; runtime: DispatchRuntime | undefined; start(resolve?: StartOptions["resolve"]): Promise<void>; stop(): Promise<void> }

/**
 * Phase one of start-up: configuration -> (disabled? nothing else happens, nothing connects) -> load and validate the declared
 * modules -> build the runtime. The application can inject `dispatch` right away; nothing is connected or consumed until start().
 * Any problem aborts here, before anything is consumed.
 */
export async function prepareDispatch(o: StartOptions): Promise<Started> {
  const cfg = loadDispatchConfig({ projectDir: o.projectDir, source: o.source, ...(o.env ? { env: o.env } : {}) });
  if (!cfg.enabled) return { dispatch: new DisabledDispatch(), runtime: undefined, start: async () => undefined, stop: async () => undefined };
  const registry = new EventRegistry();
  const mods = loadDispatchModules(join(o.appDir, "dispatch"), registry);
  const problems = mods.flatMap((m) => m.problems.map((p) => `dispatch/${m.dir}: ${p}`));
  if (problems.length) throw new DispatchError("PSO_DISPATCH_INVALID", `dispatch declarations are invalid; nothing was started:\n - ${problems.join("\n - ")}`);
  if (registry.all().length === 0) throw new DispatchError("PSO_DISPATCH_INVALID", "dispatch is enabled but no events are declared (src/dispatch/<module>/EVENTS.pso.ts)");
  const adapter = await createAdapter(cfg);
  let idem: IdempotencyStore | undefined;
  const store = idempotencyOf(cfg);
  if (store.store === "redis") { const { RedisIdempotencyStore } = await import("./redis.ts"); idem = new RedisIdempotencyStore(store.redisUrl!); }
  // stated at every start: with the in-memory store a redelivery after a restart, or to another instance, runs the handler again
  o.log?.("info", "dispatch idempotency store", { component: "dispatch", store: store.store, durable: store.store === "redis", shared: store.store === "redis", retentionMs: cfg.settings.idempotencyTtlMs });
  if (store.store === "memory" && (o.env ?? process.env)["PSO_ENV"] === "production") o.log?.("warn", 'dispatch remembers processed events in memory only: after a restart, or on another instance, a redelivered event runs its handler again. Set dispatch.idempotency.store to "redis" (with dispatch.idempotency.redisUrl) or make every handler idempotent', { component: "dispatch" });
  const runtime = new DispatchRuntime({ settings: cfg.settings, adapter, registry, ...(idem ? { idempotency: idem } : {}), ...(o.log ? { log: o.log } : {}) });
  const trust = cfg.settings.trust;
  // the trust posture is stated once at start-up: what is signed, which sources can be verified, and whether verification is enforced
  o.log?.("info", "dispatch publisher trust", { component: "dispatch", mode: trust?.mode ?? "off", signing: !!trust?.signingKey, verifiedSources: [...(trust?.keys.keys() ?? [])].sort() });
  if ((trust?.mode ?? "off") === "off" && ((o.env ?? process.env)["PSO_ENV"] ?? (o.env ?? process.env)["NODE_ENV"]) === "production") o.log?.("warn", 'INSECURE legacy mode (PSO_DISPATCH_ALLOW_UNAUTHENTICATED): dispatch does not authenticate publishers; the "source" of a consumed event is whatever its producer wrote. Set PSO_DISPATCH_SIGNING_KEY on publishers, PSO_DISPATCH_TRUST_KEY_<SERVICE> on consumers and dispatch.trust.mode=required, then remove the setting', { component: "dispatch" });
  if (trust?.mode === "permissive") o.log?.((o.env ?? process.env)["PSO_ENV"] === "production" ? "warn" : "info", 'dispatch trust mode "permissive": unsigned messages are still handled (counted as "unverified"); it is a migration step, not authentication. Switch to "required" when the counter stays at zero', { component: "dispatch" });
  return {
    dispatch: runtime, runtime,
    async start(resolve) {
      for (const m of mods) for (const c of m.consumers) {
        if (!Reflect.getOwnMetadata(CONSUMER_META, c)) throw new DispatchError("PSO_DISPATCH_CONSUMER", `${c.name} is not decorated with @DispatchConsumer`);
        runtime.register((resolve ?? o.resolve) ? (resolve ?? o.resolve)!(c) : new (c as unknown as new () => InstanceType<ConsumerClass>)());
      }
      await runtime.start();
    },
    // the idempotency store owns a connection of its own (opened on first use): released with the runtime, never left reconnecting
    stop: async () => { try { await runtime.stop(); } finally { (idem as { close?: () => void } | undefined)?.close?.(); } },
  };
}

/** prepareDispatch + start in one call (for programs that do not need to inject the API before consumers start). */
export async function startDispatch(o: StartOptions): Promise<Started> {
  const s = await prepareDispatch(o);
  await s.start();
  return s;
}

export type { PublishInput };
