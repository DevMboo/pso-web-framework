import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Channels configuration. Layers (low to high): defaults < `channels` object of pso.config.json < pso.config.<env>.json < PSO_CHANNELS_* variables.
 * Everything is validated at start-up; an invalid or insecure value stops the process and names the key. Channels are on only when a
 * module registers channel classes (explicit) and `enabled` is not false.
 */
export interface ChannelsConfig {
  enabled: boolean;
  /** WebSocket endpoint path on the existing HTTP server */
  path: string;
  /** browser Origins allowed to connect (exact). Required in production; "*" is refused. A request without Origin (non-browser client) is judged by authentication alone. */
  allowedOrigins: string[];
  /** accept connections that never authenticate (they can reach public channels only). Default false: they are closed after authTimeoutMs. */
  allowAnonymous: boolean;
  authTimeoutMs: number;
  heartbeatMs: number;
  idleTimeoutMs: number;
  maxConnections: number;
  maxSubscriptionsPerConnection: number;
  maxMessageBytes: number;
  /** messages per second per connection (token bucket; `burst` is its capacity) */
  ratePerSecond: number;
  burst: number;
  /** outbound bytes allowed to queue per connection before it is closed as a slow consumer */
  maxBufferedBytes: number;
  shutdownGraceMs: number;
  bus: "local" | "redis";
  redisUrl?: string;
  redisPrefix: string;
  /**
   * Shared secret of the orchestrator instances for the Redis bus (PSO_CHANNELS_BUS_SECRET only, never a file; 32+ characters). When set
   * every bus message is signed and an instance delivers only messages with a valid signature. Without it, whoever can publish to the
   * Redis topic can make instances deliver events (they are still validated against the channel contracts).
   */
  busSecret?: string;
  /** secrets still accepted while rotating (PSO_CHANNELS_BUS_SECRET_PREVIOUS, comma separated); never used to sign */
  busPreviousSecrets: string[];
  /**
   * MIGRATION ONLY (PSO_CHANNELS_BUS_ACCEPT_UNSIGNED=true, needs the secret): this instance signs what it publishes but still delivers
   * unsigned bus messages, so a fleet can be moved to a signed bus one instance at a time. While it is on the bus is NOT
   * authenticated; every accepted unsigned message is counted and reported. Remove it once every instance has the secret.
   */
  busAcceptUnsigned: boolean;
  /**
   * Set only by PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED=true in production: the operator accepted a Redis bus without a secret
   * (a legacy installation). Insecure by declaration; reported at every start.
   */
  busUnauthenticatedAccepted?: boolean;
  /** extra service names accepted as the source of an event received from the bus, besides this service and each channel's publishers */
  trustedSources: string[];
}

export class ChannelsConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`invalid channels configuration:\n - ${problems.join("\n - ")}`); this.name = "ChannelsConfigError"; this.problems = problems; }
}

export const DEFAULTS: ChannelsConfig = {
  enabled: true, path: "/channels", allowedOrigins: [], allowAnonymous: false, authTimeoutMs: 10_000, heartbeatMs: 30_000, idleTimeoutMs: 900_000,
  maxConnections: 1000, maxSubscriptionsPerConnection: 50, maxMessageBytes: 65_536, ratePerSecond: 20, burst: 40, maxBufferedBytes: 1_048_576,
  shutdownGraceMs: 2000, bus: "local", redisPrefix: "pso:channels", busPreviousSecrets: [], busAcceptUnsigned: false, trustedSources: [],
};

const RANGES: Record<string, [number, number]> = {
  authTimeoutMs: [1000, 120_000], heartbeatMs: [1000, 300_000], idleTimeoutMs: [5000, 86_400_000], maxConnections: [1, 1_000_000],
  maxSubscriptionsPerConnection: [1, 10_000], maxMessageBytes: [256, 4_194_304], ratePerSecond: [1, 10_000], burst: [1, 100_000], maxBufferedBytes: [1024, 1_073_741_824], shutdownGraceMs: [0, 60_000],
};
const ENV: ReadonlyArray<readonly [string, keyof ChannelsConfig, "bool" | "num" | "str" | "list"]> = [
  ["PSO_CHANNELS_ENABLED", "enabled", "bool"], ["PSO_CHANNELS_PATH", "path", "str"], ["PSO_CHANNELS_ALLOWED_ORIGINS", "allowedOrigins", "list"], ["PSO_CHANNELS_ALLOW_ANONYMOUS", "allowAnonymous", "bool"],
  ["PSO_CHANNELS_AUTH_TIMEOUT_MS", "authTimeoutMs", "num"], ["PSO_CHANNELS_HEARTBEAT_MS", "heartbeatMs", "num"], ["PSO_CHANNELS_IDLE_TIMEOUT_MS", "idleTimeoutMs", "num"],
  ["PSO_CHANNELS_MAX_CONNECTIONS", "maxConnections", "num"], ["PSO_CHANNELS_MAX_SUBSCRIPTIONS", "maxSubscriptionsPerConnection", "num"], ["PSO_CHANNELS_MAX_MESSAGE_BYTES", "maxMessageBytes", "num"],
  ["PSO_CHANNELS_RATE_PER_SECOND", "ratePerSecond", "num"], ["PSO_CHANNELS_BURST", "burst", "num"], ["PSO_CHANNELS_MAX_BUFFERED_BYTES", "maxBufferedBytes", "num"],
  ["PSO_CHANNELS_BUS", "bus", "str"], ["PSO_CHANNELS_REDIS_URL", "redisUrl", "str"], ["PSO_CHANNELS_REDIS_PREFIX", "redisPrefix", "str"],
  ["PSO_CHANNELS_BUS_SECRET", "busSecret", "str"], ["PSO_CHANNELS_BUS_SECRET_PREVIOUS", "busPreviousSecrets", "list"], ["PSO_CHANNELS_TRUSTED_SOURCES", "trustedSources", "list"],
  ["PSO_CHANNELS_BUS_ACCEPT_UNSIGNED", "busAcceptUnsigned", "bool"],
];

function readJson(file: string, problems: string[]): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try { const v = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as { channels?: unknown }; return v.channels && typeof v.channels === "object" && !Array.isArray(v.channels) ? (v.channels as Record<string, unknown>) : {}; }
  catch (e) { problems.push(`cannot read ${file}: ${(e as Error).message}`); return {}; }
}

export function loadChannelsConfig(projectDir: string | undefined, env: NodeJS.ProcessEnv = process.env, environment = env["PSO_ENV"] ?? env["NODE_ENV"] ?? "development"): ChannelsConfig {
  const problems: string[] = [];
  const raw: Record<string, unknown> = { ...(projectDir ? readJson(join(projectDir, "pso.config.json"), problems) : {}), ...(projectDir ? readJson(join(projectDir, `pso.config.${environment}.json`), problems) : {}) };
  for (const k of ["busSecret", "busPreviousSecrets"]) if (k in raw) { problems.push(`channels.${k} is a secret and must not be written in a file: set ${k === "busSecret" ? "PSO_CHANNELS_BUS_SECRET" : "PSO_CHANNELS_BUS_SECRET_PREVIOUS"} in the environment`); delete raw[k]; }
  for (const [name, key, kind] of ENV) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    raw[key] = kind === "bool" ? v === "true" ? true : v === "false" ? false : v : kind === "num" ? (/^\d+$/.test(v.trim()) ? Number(v) : v) : kind === "list" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
  }
  const known = new Set(Object.keys(DEFAULTS).concat("redisUrl", "busSecret"));
  for (const k of Object.keys(raw)) if (!known.has(k)) problems.push(`unknown key "channels.${k}"`);
  const cfg = { ...DEFAULTS, ...raw } as ChannelsConfig;
  for (const k of ["enabled", "allowAnonymous", "busAcceptUnsigned"] as const) if (typeof cfg[k] !== "boolean") problems.push(`channels.${k} must be true or false`);
  for (const [k, [lo, hi]] of Object.entries(RANGES)) { const n = (cfg as unknown as Record<string, unknown>)[k]; if (typeof n !== "number" || !Number.isInteger(n) || n < lo || n > hi) problems.push(`channels.${k} must be a whole number between ${lo} and ${hi}`); }
  if (typeof cfg.path !== "string" || !/^\/[A-Za-z0-9/_-]{1,100}$/.test(cfg.path) || cfg.path.includes("//") || cfg.path.startsWith("/health") || cfg.path.startsWith("/_pso")) problems.push('channels.path must be a path such as "/channels" (not /health or /_pso)');
  if (!Array.isArray(cfg.allowedOrigins) || cfg.allowedOrigins.some((o) => typeof o !== "string")) problems.push("channels.allowedOrigins must be a list of origins");
  else for (const o of cfg.allowedOrigins) if (o === "*" || !/^https?:\/\/[^/\s*]+$/.test(o)) problems.push(`channels.allowedOrigins entry "${o}" is not an exact origin (scheme://host[:port]; wildcards are refused)`);
  if (cfg.bus !== "local" && cfg.bus !== "redis") problems.push('channels.bus must be "local" or "redis"');
  if (cfg.bus === "redis") {
    if (!cfg.redisUrl) problems.push("channels.bus=redis needs channels.redisUrl (or PSO_CHANNELS_REDIS_URL)");
    else if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(String(cfg.redisUrl)) && !env["PSO_CHANNELS_REDIS_URL"]) problems.push("channels.redisUrl contains credentials in a file: set PSO_CHANNELS_REDIS_URL in the environment instead");
  }
  for (const s of [...(cfg.busSecret !== undefined ? [cfg.busSecret] : []), ...(Array.isArray(cfg.busPreviousSecrets) ? cfg.busPreviousSecrets : [])]) if (typeof s !== "string" || s.length < 32) { problems.push("PSO_CHANNELS_BUS_SECRET (and each previous secret) must be at least 32 characters"); break; }
  if (cfg.busAcceptUnsigned === true && cfg.busSecret === undefined) problems.push("PSO_CHANNELS_BUS_ACCEPT_UNSIGNED is a migration switch of a SIGNED bus: it needs PSO_CHANNELS_BUS_SECRET (without a secret every message is unsigned anyway)");
  if (cfg.busSecret !== undefined && cfg.bus !== "redis") problems.push('PSO_CHANNELS_BUS_SECRET is set but channels.bus is not "redis": the secret signs the Redis bus only');
  if (!Array.isArray(cfg.trustedSources) || cfg.trustedSources.some((s) => typeof s !== "string" || !/^[a-z][a-z0-9.-]{0,62}$/.test(s))) problems.push("channels.trustedSources must be a list of service names (lower-case letters, digits, dots and hyphens)");
  if (cfg.burst < cfg.ratePerSecond) problems.push("channels.burst must be at least channels.ratePerSecond");
  if (environment === "production") {
    if (cfg.enabled && cfg.allowedOrigins.length === 0) problems.push("production requires channels.allowedOrigins (browsers must be restricted to your own origins)");
    if (cfg.enabled && cfg.allowAnonymous) problems.push("production does not allow channels.allowAnonymous: public channels are reachable only after authentication there, or set it per deployment deliberately outside production");
    if (cfg.enabled && cfg.bus === "local" && env["PSO_CHANNELS_ACK_SINGLE_INSTANCE"] !== "true") problems.push('production with channels.bus="local" delivers only to clients connected to the instance that publishes: use bus "redis", or set PSO_CHANNELS_ACK_SINGLE_INSTANCE=true when exactly one orchestrator instance runs');
  }
  // a distributed bus in production is authenticated, or the operator says in so many words that it is not (never an implicit default)
  if (environment === "production" && cfg.enabled && cfg.bus === "redis" && cfg.busSecret === undefined) {
    const ack = env["PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED"];
    if (ack === "true") cfg.busUnauthenticatedAccepted = true;
    else problems.push(`production with channels.bus="redis" requires PSO_CHANNELS_BUS_SECRET (the same 32+ character value on every orchestrator instance): without it anyone able to publish to the Redis topic can make instances deliver events. To keep a legacy installation running while you roll the secret out, set PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED=true (insecure, reported at every start)${ack !== undefined && ack !== "" ? '; PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED must be exactly "true"' : ""}`);
  }
  if (problems.length) throw new ChannelsConfigError(problems);
  return cfg;
}
