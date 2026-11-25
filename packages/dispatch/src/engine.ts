import { randomUUID } from "node:crypto";
import type { DispatchAdapter, Delivery, DispatchHealth, IdempotencyStore, PublishResult, SubscriptionHandle } from "./adapter.ts";
import { MemoryIdempotencyStore } from "./adapter.ts";
import { createEnvelope, DispatchError, parseEnvelope, serializeEnvelope, type DispatchEnvelope } from "./envelope.ts";
import { CONSUMER_META, type ConsumeContext, type ConsumerClass, type ConsumerMeta, type EventRegistry } from "./events.ts";
import { validate } from "./schema.ts";
import { NO_TRUST, SIGNATURE_HEADER, signMessage, verifyMessage, type DispatchTrust } from "./trust.ts";

export interface DispatchSettings {
  /** the service name: becomes the envelope source and the default consumer group */
  source: string;
  consumer: { concurrency: number; batchSize: number };
  retry: { enabled: boolean; maxAttempts: number; initialDelayMs: number; maxDelayMs: number; multiplier: number };
  deadLetter: { enabled: boolean };
  maxMessageBytes: number;
  idempotencyTtlMs: number;
  /**
   * How long a claim on an event id lives without being renewed (default 30 s). The runtime renews it while the handler runs, so this
   * is not a limit on handler duration: it is how long a claim of a consumer that died blocks the others.
   */
  idempotencyLeaseMs?: number;
  shutdownTimeoutMs: number;
  /** publisher authentication (see trust.ts); absent = off, exactly the behaviour before signatures existed */
  trust?: DispatchTrust;
}

export const DEFAULT_SETTINGS: Omit<DispatchSettings, "source"> = {
  consumer: { concurrency: 1, batchSize: 10 },
  retry: { enabled: true, maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 30_000, multiplier: 2 },
  deadLetter: { enabled: true },
  maxMessageBytes: 1_048_576, idempotencyTtlMs: 24 * 3600_000, shutdownTimeoutMs: 10_000,
};

export interface PublishInput { correlationId?: string; causationId?: string; key?: string; id?: string; timeoutMs?: number; signal?: AbortSignal; trace?: DispatchEnvelope["trace"] }

/** The provider-independent application API. */
export abstract class Dispatch {
  /**
   * Validates the payload against the declared contract and hands the event to the transport. The result's `acknowledgement` states
   * exactly what the transport guaranteed when publish resolved (see the provider capabilities); publish never means "consumed".
   */
  abstract publish(type: string, payload: unknown, options?: PublishInput): Promise<PublishResult>;
  abstract health(): Promise<DispatchHealth>;
  abstract metrics(): DispatchMetrics;
}

// Stable injection token (see makeContainer in @pso/http): another physical copy of this package declares a different class object
// for the same thing; the container recognises it by this token instead of constructing an unconnected instance. `contract` changes
// only when the injected API changes incompatibly.
Object.defineProperty(Dispatch, Symbol.for("pso.di.token"), { value: { id: "pso.dispatch.Dispatch", contract: 1 } });

export interface DispatchMetrics {
  published: number; publishFailed: number; consumed: number; failed: number; retried: number; deadLettered: number; dropped: number; duplicates: number; poison: number;
  /** messages refused because their publisher could not be authenticated (dead-lettered, never handled) */
  untrusted: number;
  /** messages handled without an authenticated publisher (trust mode "permissive"): must reach zero before switching to "required" */
  unverified: number;
  /** deliveries given back to the broker because another consumer was still processing the same event id */
  contended?: number;
  /** handlers that finished after their claim had expired and been taken by another consumer (the handler may have run twice) */
  leaseLost?: number;
  processing: { count: number; totalMs: number; maxMs: number };
  byType: Record<string, { published: number; consumed: number; failed: number }>;
}

const emptyMetrics = (): DispatchMetrics => ({ published: 0, publishFailed: 0, consumed: 0, failed: 0, retried: 0, deadLettered: 0, dropped: 0, duplicates: 0, poison: 0, untrusted: 0, unverified: 0, contended: 0, leaseLost: 0, processing: { count: 0, totalMs: 0, maxMs: 0 }, byType: {} });

/** a held claim on one event id: `lost` turns true when a renewal finds the lease gone; stop() ends the renewals */
interface Claim { owner: string; lost: boolean; stop(): void }
const DEFAULT_LEASE_MS = 30_000;

interface HandlerReg { type: string; group: string; concurrency: number; requireVerified?: boolean; name?: string; invoke: (payload: unknown, ctx: ConsumeContext) => Promise<unknown> }

export interface RuntimeOptions {
  settings: DispatchSettings; adapter: DispatchAdapter; registry: EventRegistry; idempotency?: IdempotencyStore;
  sleep?: (ms: number) => Promise<void>; log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export class DispatchRuntime extends Dispatch {
  readonly settings: DispatchSettings;
  readonly adapter: DispatchAdapter;
  readonly registry: EventRegistry;
  private readonly idem: IdempotencyStore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: NonNullable<RuntimeOptions["log"]>;
  private readonly handlers: HandlerReg[] = [];
  private readonly handles: SubscriptionHandle[] = [];
  private readonly m = emptyMetrics();
  private state: "new" | "started" | "stopped" = "new";
  private readonly trust: DispatchTrust;

  constructor(o: RuntimeOptions) {
    super();
    this.settings = o.settings; this.adapter = o.adapter; this.registry = o.registry;
    this.trust = o.settings.trust ?? NO_TRUST;
    this.idem = o.idempotency ?? new MemoryIdempotencyStore();
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log ?? (() => undefined);
  }

  /** Registers an explicit consumer instance. The event must be declared; the class must carry @DispatchConsumer. */
  register(instance: InstanceType<ConsumerClass>): void {
    if (this.state !== "new") throw new DispatchError("PSO_DISPATCH_STATE", "consumers must be registered before start()");
    const meta = Reflect.getOwnMetadata(CONSUMER_META, instance.constructor) as ConsumerMeta | undefined;
    if (!meta) throw new DispatchError("PSO_DISPATCH_CONSUMER", `${instance.constructor.name} is not decorated with @DispatchConsumer`);
    if (!this.registry.get(meta.event)) throw new DispatchError("PSO_DISPATCH_CONSUMER", `${instance.constructor.name} handles "${meta.event}", which is not declared in any EVENTS.pso`);
    this.handlers.push({ type: meta.event, group: meta.group ?? this.settings.source, concurrency: meta.concurrency ?? this.settings.consumer.concurrency, ...(meta.requireVerified ? { requireVerified: true } : {}), name: instance.constructor.name, invoke: async (p, c) => instance.handle(p as never, c) });
  }

  registerFunction(type: string, handler: (payload: unknown, ctx: ConsumeContext) => unknown, o: { group?: string; concurrency?: number; requireVerified?: boolean } = {}): void {
    if (!this.registry.get(type)) throw new DispatchError("PSO_DISPATCH_CONSUMER", `"${type}" is not a declared event`);
    this.handlers.push({ type, group: o.group ?? this.settings.source, concurrency: o.concurrency ?? this.settings.consumer.concurrency, ...(o.requireVerified ? { requireVerified: true } : {}), name: `function consumer of "${type}"`, invoke: async (p, c) => handler(p, c) });
  }

  async start(): Promise<void> {
    if (this.state !== "new") return;
    // a consumer that requires a verified publisher cannot work without any verification key: refuse to start instead of dead-lettering everything
    const privileged = this.handlers.filter((h) => h.requireVerified);
    if (privileged.length && this.trust.keys.size === 0) throw new DispatchError("PSO_DISPATCH_TRUST_KEYS", `${privileged.map((h) => h.name).join(", ")} require${privileged.length === 1 ? "s" : ""} a verified publisher (requireVerified) but no verification key is configured: set PSO_DISPATCH_TRUST_KEY_<SERVICE> for each publishing service (and PSO_DISPATCH_SIGNING_KEY on the publishers)`);
    await this.adapter.connect();
    const groups = new Map<string, HandlerReg[]>();
    for (const h of this.handlers) {
      const channel = this.registry.get(h.type)!.channel;
      const k = `${channel}\u0000${h.group}`;
      groups.set(k, [...(groups.get(k) ?? []), h]);
    }
    for (const [k, hs] of groups) {
      const [channel, group] = k.split("\u0000") as [string, string];
      this.handles.push(await this.adapter.subscribe({
        channel, group, concurrency: Math.max(...hs.map((h) => h.concurrency)), batchSize: this.settings.consumer.batchSize,
        onMessage: (d) => this.process(d, group, hs),
      }));
    }
    this.state = "started";
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";
    // the transport is always closed, even when a consumer could not be stopped cleanly: nothing keeps reconnecting after stop()
    try { await Promise.allSettled(this.handles.map((h) => h.stop(this.settings.shutdownTimeoutMs))); }
    finally { await this.adapter.close(); }
  }

  override async publish(type: string, payload: unknown, o: PublishInput = {}): Promise<PublishResult> {
    const decl = this.registry.get(type);
    if (!decl) throw new DispatchError("PSO_DISPATCH_UNKNOWN_EVENT", `event "${type}" is not declared in an EVENTS.pso: declare it before publishing`);
    if (decl.publish === false) throw new DispatchError("PSO_DISPATCH_NOT_PUBLISHER", `event "${type}" is declared as consume-only in this service`);
    if (decl.schemaObject) {
      const bad = validate(decl.schemaObject, payload);
      if (bad.length) throw new DispatchError("PSO_DISPATCH_SCHEMA", `payload of "${type}" violates its schema: ${bad.slice(0, 5).join("; ")}`);
    }
    const key = o.key ?? (decl.key ? String(decl.key.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), payload) ?? "") || undefined : undefined);
    const env = createEnvelope({ type, version: decl.version, source: this.settings.source, payload, ...(o.correlationId ? { correlationId: o.correlationId } : {}), ...(o.causationId ? { causationId: o.causationId } : {}), ...(o.id ? { id: o.id } : {}), ...(o.trace ? { trace: o.trace } : {}) });
    const body = Buffer.from(serializeEnvelope(env)); // the canonical bytes every adapter sends: what the signature covers
    if (body.length > this.settings.maxMessageBytes) throw new DispatchError("PSO_DISPATCH_ENVELOPE_TOO_LARGE", `event "${type}" exceeds ${this.settings.maxMessageBytes} bytes`);
    const headers = this.trust.signingKey ? { [SIGNATURE_HEADER]: signMessage(this.trust.signingKey, decl.channel, body) } : undefined;
    const t = this.m.byType[type] ??= { published: 0, consumed: 0, failed: 0 };
    try {
      const r = await this.adapter.publish(decl.channel, env, { ...(key ? { key } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(headers ? { headers } : {}) });
      this.m.published++; t.published++;
      return r;
    } catch (e) {
      this.m.publishFailed++;
      throw e instanceof DispatchError ? e : new DispatchError("PSO_DISPATCH_PUBLISH_FAILED", `publishing "${type}" failed (${e instanceof Error ? e.name : "error"})`, { cause: e });
    }
  }

  private async process(d: Delivery, group: string, handlers: HandlerReg[]): Promise<void> {
    let env: DispatchEnvelope;
    try { env = parseEnvelope(d.body, this.settings.maxMessageBytes); }
    catch (e) { this.m.poison++; await this.deadLetter(d, group, 0, e instanceof DispatchError ? e.code : "PSO_DISPATCH_ENVELOPE_INVALID"); return; }
    const mine = handlers.filter((h) => h.type === env.type);
    if (mine.length === 0) { await d.ack(); return; } // another consumer of the same channel handles this type
    const decl = this.registry.get(env.type)!;
    const t = this.m.byType[env.type] ??= { published: 0, consumed: 0, failed: 0 };
    if (env.version !== decl.version && !(decl.accepts ?? []).includes(env.version)) { this.m.poison++; await this.deadLetter(d, group, 0, "PSO_DISPATCH_UNSUPPORTED_VERSION"); return; }
    if (env.version === decl.version && decl.schemaObject && validate(decl.schemaObject, env.payload).length) { this.m.poison++; await this.deadLetter(d, group, 0, "PSO_DISPATCH_SCHEMA"); return; }
    // who published this? `env.source` is only a claim; with trust enabled it must be backed by a signature of that service's key
    let verifiedSource: string | undefined;
    const privileged = mine.some((h) => h.requireVerified); // such a consumer never runs on a claim, whatever the mode is
    if (this.trust.mode !== "off" || privileged) {
      const verdict = verifyMessage(this.trust, d.channel, d.body, d.headers[SIGNATURE_HEADER], env.source);
      if (verdict === "verified") verifiedSource = env.source;
      else if (this.trust.mode === "required" || verdict === "invalid" || privileged) {
        this.m.untrusted++; this.m.poison++;
        this.log("warn", "message refused: the publisher is not authenticated", { event: env.type, id: env.id, claimedSource: env.source, reason: verdict, channel: d.channel });
        await this.deadLetter(d, group, 0, `PSO_DISPATCH_UNTRUSTED:${verdict}`); // never handled, never retried: retrying cannot make it authentic
        return;
      } else this.m.unverified++;
    }
    const idemKey = `${group}:${env.id}`;
    // one consumer at a time per (group, event id): the id is claimed atomically BEFORE the handler runs. A store failure is not
    // "unseen": the message is not handled and goes back to the broker
    let claim: Claim | "done" | "busy";
    try { claim = await this.acquire(idemKey); }
    catch (e) {
      this.log("error", "idempotency store unavailable; the message is not handled and stays with the broker", { event: env.type, id: env.id, error: e instanceof Error ? e.name : "error" });
      await new Promise((r) => { setTimeout(r, 250); }); // no hot redelivery loop while the store is down
      await d.nack();
      return;
    }
    if (claim === "done") { this.m.duplicates++; await d.ack(); return; }
    if (claim === "busy") { this.m.contended = (this.m.contended ?? 0) + 1; await d.nack(); return; } // the other consumer is still running: redelivered later, then a duplicate or claimable
    const max = this.settings.retry.enabled ? this.settings.retry.maxAttempts : 1;
    let attempt = 0, delay = this.settings.retry.initialDelayMs, last = "error";
    const started = Date.now();
    try {
      while (attempt < max && this.state !== "stopped") {
        attempt++;
        let ok = false;
        try {
          for (const h of mine) await h.invoke(env.payload, { envelope: env, attempt, group, ...(verifiedSource !== undefined ? { verifiedSource } : {}) });
          ok = true;
        } catch (e) {
          last = e instanceof Error ? e.name : "error";
          this.m.failed++; t.failed++;
          this.log("warn", "consumer failed", { event: env.type, id: env.id, attempt, error: last });
          if (attempt < max) { this.m.retried++; await this.sleep(delay); delay = Math.min(this.settings.retry.maxDelayMs, Math.round(delay * this.settings.retry.multiplier)); }
        }
        if (ok) {
          const ms = Date.now() - started;
          this.m.consumed++; t.consumed++; this.m.processing.count++; this.m.processing.totalMs += ms; this.m.processing.maxMs = Math.max(this.m.processing.maxMs, ms);
          await this.finish(claim, idemKey, env);
          await d.ack(); // acknowledged only AFTER the handler succeeded
          return;
        }
      }
      await this.giveBack(claim, idemKey); // not processed: the id must be claimable again (by a redelivery or a replayed dead letter)
      if (this.state === "stopped" && attempt < max) { await d.nack(); return; } // shutting down mid-retry: let the transport redeliver
      await this.deadLetter(d, group, attempt, `handler-failed:${last}`);
    } finally { claim.stop(); }
  }

  /**
   * Claims the event id for this delivery. With a store that only has has()/add() this is the original check (not atomic). With a
   * claiming store: "done" when already processed; while another consumer holds a live lease it waits (bounded by one lease period,
   * because a holder that died stops renewing) and then answers "busy". The lease is renewed in the background until stop().
   */
  private async acquire(key: string): Promise<Claim | "done" | "busy"> {
    const idem = this.idem;
    if (!idem.claim) return (await idem.has(key)) ? "done" : { owner: "", lost: false, stop: () => undefined };
    const owner = randomUUID(), lease = this.settings.idempotencyLeaseMs ?? DEFAULT_LEASE_MS;
    const deadline = Date.now() + lease + 1000;
    for (;;) {
      const r = await idem.claim(key, owner, lease);
      if (r === "done") return "done";
      if (r === "claimed") break;
      if (this.state === "stopped" || Date.now() >= deadline) return "busy";
      await new Promise((res) => { setTimeout(res, Math.min(200, Math.max(10, lease / 10))); });
    }
    let timer: NodeJS.Timeout | undefined;
    const c: Claim = { owner, lost: false, stop: () => clearInterval(timer) };
    timer = setInterval(() => {
      if (!idem.renew) return;
      idem.renew(key, owner, lease).then((held) => { if (!held && !c.lost) { c.lost = true; this.log("warn", "the claim on an event id expired while its handler was still running; another consumer may run it too", { key }); } }, () => undefined);
    }, Math.max(5, Math.floor(lease / 3)));
    timer.unref();
    return c;
  }

  /** Turns the claim into a completion record. The handler already ran: a record that cannot be written is reported, never hidden. */
  private async finish(c: Claim, key: string, env: DispatchEnvelope): Promise<void> {
    c.stop();
    const idem = this.idem;
    for (let i = 0; ; i++) {
      try {
        if (!idem.complete) { await idem.add(key, this.settings.idempotencyTtlMs); return; }
        if (!(await idem.complete(key, c.owner, this.settings.idempotencyTtlMs)) || c.lost) {
          this.m.leaseLost = (this.m.leaseLost ?? 0) + 1;
          this.log("warn", "an event was handled after its claim had expired: another consumer may have handled it as well (raise dispatch.idempotency.lease or make the handler idempotent)", { event: env.type, id: env.id });
        }
        return;
      } catch (e) {
        if (i >= 2) { this.log("error", "the event was handled but its completion could not be recorded: a later redelivery will run the handler again", { event: env.type, id: env.id, error: e instanceof Error ? e.name : "error" }); return; }
        await new Promise((r) => { setTimeout(r, 100 * (i + 1)); });
      }
    }
  }

  private async giveBack(c: Claim, key: string): Promise<void> {
    c.stop();
    try { await this.idem.release?.(key, c.owner); } catch { /* the lease expires on its own */ }
  }

  /** Writes the message to <channel>.dlq and only then acknowledges it. If that fails the message stays unacknowledged (redelivered), never lost. */
  private async deadLetter(d: Delivery, group: string, attempts: number, reason: string): Promise<void> {
    if (!this.settings.deadLetter.enabled) { this.m.dropped++; this.log("error", "message dropped (dead-letter disabled)", { channel: d.channel, reason }); await d.ack(); return; }
    try {
      await this.adapter.publishRaw(`${d.channel}.dlq`, d.body, { headers: { "x-pso-reason": reason.slice(0, 200), "x-pso-attempts": String(attempts), "x-pso-group": group, "x-pso-original-channel": d.channel, "x-pso-dead-letter-id": randomUUID() } });
    } catch (e) {
      this.log("error", "dead-letter publish failed; the message stays unacknowledged", { channel: d.channel, error: e instanceof Error ? e.name : "error" });
      await d.nack();
      return;
    }
    this.m.deadLettered++;
    await d.ack();
  }

  override async health(): Promise<DispatchHealth> { return this.adapter.health(); }
  override metrics(): DispatchMetrics { return structuredClone(this.m); }
}
