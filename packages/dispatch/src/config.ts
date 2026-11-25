import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coerce, envLayer, resolveConfig, type Layers } from "@pso/core";
import { DEFAULT_SETTINGS, type DispatchSettings } from "./engine.ts";
import { DispatchError } from "./envelope.ts";
import { TRUST_MODES, loadTrustKeys, type TrustMode } from "./trust.ts";

export type ProviderName = "none" | "redis" | "rabbitmq" | "kafka";

export interface DispatchConfig {
  enabled: boolean;
  provider: ProviderName;
  settings: DispatchSettings;
  observability: boolean;
  /**
   * Where processed event ids are remembered. "memory" is per process: it does not survive a restart and is not shared between
   * instances, so a redelivery after a restart (or to another instance) runs the handler again. "redis" is durable and shared.
   */
  idempotency?: { store: "memory" | "redis"; redisUrl?: string };
  redis: { url: string; maxLength: number; minIdleMs: number; blockMs: number; streamCreation: "auto" | "require" };
  rabbitmq: { url: string; exchangePrefix: string };
  kafka: { brokers: string[]; clientId: string; topicCreation: "auto" | "require"; partitions: number; replicationFactor: number; ssl: boolean; sasl?: { mechanism: "plain" | "scram-sha-256" | "scram-sha-512"; username: string; password: string } };
}

export interface ConfigIssue { code: string; key?: string; message: string }
export class DispatchConfigError extends DispatchError {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super("PSO_DISPATCH_CONFIG", `invalid dispatch configuration:\n${issues.map((i) => ` - ${i.code}${i.key ? ` (${i.key})` : ""}: ${i.message}`).join("\n")}`);
    this.issues = issues;
  }
}

export function parseDuration(v: unknown): number | undefined {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(v).trim());
  if (!m) return undefined;
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[m[2] as "ms" | "s" | "m" | "h"];
}

function readJson(file: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try { const v = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); return v && typeof v === "object" ? v : undefined; }
  catch (e) { issues.push({ code: "PSO_DISPATCH_CONFIG_FILE", message: `cannot read ${file}: ${(e as Error).message}` }); return undefined; }
}

const ALIASES: Record<string, string> = {
  PSO_DISPATCH_ENABLED: "dispatch.enabled", PSO_DISPATCH_PROVIDER: "dispatch.provider", PSO_DISPATCH_REDIS_URL: "dispatch.redis.url",
  PSO_DISPATCH_RABBITMQ_URL: "dispatch.rabbitmq.url", PSO_DISPATCH_KAFKA_BROKERS: "dispatch.kafka.brokers", PSO_DISPATCH_TRUST_MODE: "dispatch.trust.mode",
  PSO_DISPATCH_IDEMPOTENCY_STORE: "dispatch.idempotency.store", PSO_DISPATCH_IDEMPOTENCY_REDIS_URL: "dispatch.idempotency.redisUrl",
};

/**
 * Loads `dispatch.*` through the PSO configuration system (defaults, pso.config.json, pso.config.<env>.json, PSO_CFG_*, PSO_DISPATCH_*).
 * Secrets use ${env:NAME} references. Every problem is reported together; nothing is connected while `enabled` is false.
 */
export function loadDispatchConfig(opts: { projectDir: string; source: string; env?: NodeJS.ProcessEnv; environment?: string }): DispatchConfig {
  const env = opts.env ?? process.env;
  const environment = opts.environment ?? env["PSO_ENV"] ?? "development";
  const issues: ConfigIssue[] = [];
  const layers: Layers = {};
  const base = readJson(join(opts.projectDir, "pso.config.json"), issues);
  if (base) layers.service = { source: "pso.config.json", values: base };
  const envFile = readJson(join(opts.projectDir, `pso.config.${environment}.json`), issues);
  if (envFile) layers["environment-file"] = { source: `pso.config.${environment}.json`, values: envFile };
  const fromEnv: Record<string, unknown> = { ...envLayer(env) };
  for (const [v, key] of Object.entries(ALIASES)) if (env[v] !== undefined && env[v] !== "") fromEnv[key] = coerce(env[v]!);
  if (Object.keys(fromEnv).length) layers["environment-variables"] = { source: "environment", values: fromEnv };
  const resolved = resolveConfig(layers);
  for (const d of resolved.diagnostics) if (d.severity === "error" && /dispatch/.test(d.message + (d.file ?? ""))) issues.push({ code: d.code, message: d.message });

  const get = (key: string): unknown => {
    const v = resolved.values.get(key)?.value;
    const deref = (x: unknown): unknown => {
      if (typeof x !== "string") return x;
      const m = /^\$\{env:([A-Za-z0-9_./-]+)\}$/.exec(x);
      if (!m) { if (/^\$\{/.test(x)) issues.push({ code: "PSO_DISPATCH_REF_UNSUPPORTED", key, message: "only ${env:NAME} references are supported here" }); return x; }
      const val = env[m[1]!];
      if (val === undefined || val === "") { issues.push({ code: "PSO_DISPATCH_ENV_MISSING", key, message: `environment variable ${m[1]} (referenced here) is not set` }); return undefined; }
      return val;
    };
    return Array.isArray(v) ? v.map(deref) : deref(v);
  };
  const num = (k: string, d: number): number => { const v = get(k); return typeof v === "number" ? v : d; };
  const dur = (k: string, d: number): number => {
    const raw = get(k);
    if (raw === undefined) return d;
    const ms = parseDuration(raw);
    if (ms === undefined) { issues.push({ code: "PSO_DISPATCH_DURATION", key: k, message: `"${String(raw)}" is not a duration (examples: 500ms, 2s, 5m)` }); return d; }
    return ms;
  };
  const list = (k: string): string[] => { const v = get(k); return (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : []).map((s) => s.trim()).filter(Boolean); };

  const enabled = get("dispatch.enabled") === true;
  const provider = String(get("dispatch.provider") ?? "none") as ProviderName;
  const settings: DispatchSettings = {
    source: opts.source,
    consumer: { concurrency: num("dispatch.consumer.concurrency", 1), batchSize: num("dispatch.consumer.batchSize", 10) },
    retry: { enabled: get("dispatch.retry.enabled") !== false, maxAttempts: num("dispatch.retry.maxAttempts", 3), initialDelayMs: dur("dispatch.retry.initialDelay", 1000), maxDelayMs: dur("dispatch.retry.maxDelay", 30_000), multiplier: num("dispatch.retry.multiplier", 2) },
    deadLetter: { enabled: get("dispatch.deadLetter.enabled") !== false },
    maxMessageBytes: num("dispatch.maxMessageBytes", DEFAULT_SETTINGS.maxMessageBytes),
    idempotencyTtlMs: dur("dispatch.idempotency.retention", DEFAULT_SETTINGS.idempotencyTtlMs), shutdownTimeoutMs: DEFAULT_SETTINGS.shutdownTimeoutMs,
    idempotencyLeaseMs: dur("dispatch.idempotency.lease", 30_000),
  };
  if (settings.idempotencyLeaseMs! < 1000 || settings.idempotencyLeaseMs! > 3_600_000) issues.push({ code: "PSO_DISPATCH_LEASE", key: "dispatch.idempotency.lease", message: "dispatch.idempotency.lease must be between 1s and 1h (it is renewed while a handler runs; it bounds how long a crashed consumer blocks an event)" });
  // publisher authentication: the mode is ordinary configuration; keys are secrets and come from the environment only
  const mode = String(get("dispatch.trust.mode") ?? "off") as TrustMode;
  if (!TRUST_MODES.includes(mode)) issues.push({ code: "PSO_DISPATCH_TRUST_MODE", key: "dispatch.trust.mode", message: `dispatch.trust.mode must be one of ${TRUST_MODES.join(", ")}` });
  const trustKeys = loadTrustKeys(env, opts.source, issues);
  if (mode !== "off" || trustKeys.signingKey || trustKeys.keys.size > 0) settings.trust = { mode: TRUST_MODES.includes(mode) ? mode : "off", ...trustKeys };
  // production: an unauthenticated Dispatch is a decision someone states, never the silent default. The explicit legacy switch keeps
  // an existing installation running while its services get their keys; it grants nothing to consumers that require a verified publisher.
  const production = (env["PSO_ENV"] ?? env["NODE_ENV"] ?? "development") === "production";
  const legacyAck = env["PSO_DISPATCH_ALLOW_UNAUTHENTICATED"];
  if (enabled && production && mode === "off" && legacyAck !== "true") issues.push({ code: "PSO_DISPATCH_TRUST_REQUIRED", key: "dispatch.trust.mode", message: `production requires publisher authentication: set dispatch.trust.mode to "required" (or "permissive" while migrating) with PSO_DISPATCH_SIGNING_KEY on publishers and PSO_DISPATCH_TRUST_KEY_<SERVICE> on consumers. To keep a legacy installation running unauthenticated, set PSO_DISPATCH_ALLOW_UNAUTHENTICATED=true (insecure, reported at every start)${legacyAck !== undefined && legacyAck !== "" ? '; PSO_DISPATCH_ALLOW_UNAUTHENTICATED must be exactly "true"' : ""}` });
  if (enabled && mode === "required" && !trustKeys.signingKey && trustKeys.keys.size === 0) issues.push({ code: "PSO_DISPATCH_TRUST_KEYS", key: "dispatch.trust.mode", message: 'dispatch.trust.mode is "required" but no key is configured: set PSO_DISPATCH_SIGNING_KEY (to publish) and PSO_DISPATCH_TRUST_KEY_<SERVICE> for every service this one consumes from' });
  if (settings.retry.initialDelayMs > settings.retry.maxDelayMs) issues.push({ code: "PSO_DISPATCH_RETRY", key: "dispatch.retry.initialDelay", message: "initialDelay must not exceed maxDelay" });
  if (enabled && provider === "none") issues.push({ code: "PSO_DISPATCH_PROVIDER", key: "dispatch.provider", message: "dispatch.enabled is true but no provider is selected; run `pso dispatch:install <redis|rabbitmq|kafka>`" });

  const redisUrl = String(get("dispatch.redis.url") ?? "");
  // the idempotency store is a stated choice, never an accident of the provider
  const storeRaw = String(get("dispatch.idempotency.store") ?? "auto");
  const idemUrl = String(get("dispatch.idempotency.redisUrl") ?? "") || (provider === "redis" ? redisUrl : "");
  const idempotency: NonNullable<DispatchConfig["idempotency"]> = storeRaw === "redis" || (storeRaw === "auto" && provider === "redis") ? { store: "redis", redisUrl: idemUrl } : { store: "memory" };
  if (enabled && storeRaw === "redis" && !/^rediss?:\/\//.test(idemUrl)) issues.push({ code: "PSO_DISPATCH_MISSING", key: "dispatch.idempotency.redisUrl", message: 'dispatch.idempotency.store is "redis": a redis:// or rediss:// URL is required in dispatch.idempotency.redisUrl (use ${env:NAME}) unless the provider itself is redis' });
  const rabbitUrl = String(get("dispatch.rabbitmq.url") ?? "");
  const brokers = list("dispatch.kafka.brokers");
  if (enabled && provider === "redis" && !/^rediss?:\/\//.test(redisUrl)) issues.push({ code: "PSO_DISPATCH_MISSING", key: "dispatch.redis.url", message: "a redis:// or rediss:// URL is required (use ${env:REDIS_URL})" });
  if (enabled && provider === "rabbitmq" && !/^amqps?:\/\//.test(rabbitUrl)) issues.push({ code: "PSO_DISPATCH_MISSING", key: "dispatch.rabbitmq.url", message: "an amqp:// or amqps:// URL is required (use ${env:RABBITMQ_URL})" });
  if (enabled && provider === "kafka" && brokers.length === 0) issues.push({ code: "PSO_DISPATCH_MISSING", key: "dispatch.kafka.brokers", message: "at least one broker (host:port) is required" });
  for (const b of brokers) if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(b)) issues.push({ code: "PSO_DISPATCH_BROKER", key: "dispatch.kafka.brokers", message: `"${b}" is not host:port` });
  const mech = get("dispatch.kafka.sasl.mechanism") as "plain" | "scram-sha-256" | "scram-sha-512" | undefined;
  const user = get("dispatch.kafka.sasl.username"), pass = get("dispatch.kafka.sasl.password");
  if (mech && (!user || !pass)) issues.push({ code: "PSO_DISPATCH_MISSING", key: "dispatch.kafka.sasl", message: "SASL needs username and password (use ${env:...} references)" });
  if (mech && get("dispatch.kafka.ssl") !== true) issues.push({ code: "PSO_DISPATCH_INSECURE", key: "dispatch.kafka.ssl", message: "SASL credentials must travel over TLS: set dispatch.kafka.ssl to true" });
  if (issues.length) throw new DispatchConfigError(issues);

  return {
    enabled, provider, settings, observability: get("dispatch.observability.enabled") !== false, idempotency,
    redis: { url: redisUrl, maxLength: num("dispatch.redis.maxLength", 100000), minIdleMs: dur("dispatch.redis.minIdle", 60_000), blockMs: dur("dispatch.redis.block", 2000), streamCreation: get("dispatch.redis.streamCreation") === "require" ? "require" : "auto" },
    rabbitmq: { url: rabbitUrl, exchangePrefix: String(get("dispatch.rabbitmq.exchangePrefix") ?? "pso.") },
    kafka: { brokers, clientId: String(get("dispatch.kafka.clientId") ?? opts.source), topicCreation: get("dispatch.kafka.topicCreation") === "require" ? "require" : "auto", partitions: num("dispatch.kafka.partitions", 1), replicationFactor: num("dispatch.kafka.replicationFactor", 1), ssl: get("dispatch.kafka.ssl") === true, ...(mech && user && pass ? { sasl: { mechanism: mech, username: String(user), password: String(pass) } } : {}) },
  };
}

/** The effective idempotency store of a configuration (one built by hand, without the field, keeps the rule it always had). */
export const idempotencyOf = (c: DispatchConfig): NonNullable<DispatchConfig["idempotency"]> => c.idempotency ?? (c.provider === "redis" ? { store: "redis", redisUrl: c.redis.url } : { store: "memory" });

/** A description safe to print: URLs lose their credentials, secrets are never included. */
export function describeDispatchConfig(c: DispatchConfig): Record<string, unknown> {
  const strip = (u: string) => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return u ? "(set)" : ""; } };
  return {
    enabled: c.enabled, provider: c.provider, consumer: c.settings.consumer, retry: c.settings.retry, deadLetter: c.settings.deadLetter, maxMessageBytes: c.settings.maxMessageBytes,
    idempotency: { store: idempotencyOf(c).store, durable: idempotencyOf(c).store === "redis", retentionMs: c.settings.idempotencyTtlMs },
    trust: { mode: c.settings.trust?.mode ?? "off", signing: !!c.settings.trust?.signingKey, verifiedSources: [...(c.settings.trust?.keys.keys() ?? [])].sort() }, // never a key
    ...(c.provider === "redis" ? { redis: { url: strip(c.redis.url), maxLength: c.redis.maxLength, streamCreation: c.redis.streamCreation } } : {}),
    ...(c.provider === "rabbitmq" ? { rabbitmq: { url: strip(c.rabbitmq.url), exchangePrefix: c.rabbitmq.exchangePrefix } } : {}),
    ...(c.provider === "kafka" ? { kafka: { brokers: c.kafka.brokers, clientId: c.kafka.clientId, topicCreation: c.kafka.topicCreation, partitions: c.kafka.partitions, ssl: c.kafka.ssl, sasl: c.kafka.sasl ? { mechanism: c.kafka.sasl.mechanism } : null } } : {}),
  };
}
