import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rate limiting for the orchestrator: one abstraction, two providers.
 *  - local: in-process token buckets, bounded key cardinality (development, single instance).
 *  - redis: shared state for several instances; ONE atomic Lua script per decision (no read-modify-write race), time taken from the
 *    Redis server so instance clock skew cannot grant extra tokens. Redis is optional: nothing connects unless configured.
 * Both are token buckets: \`burst\` tokens, refilled at \`limit\` per \`windowSeconds\`.
 */
export interface RatePolicy { limit: number; windowSeconds: number; burst: number }
export interface RateDecision { allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number; backendFailed?: boolean }
export interface RateStats { allowed: number; denied: number; backendFailures: number; keys: number }

export interface RateLimiter {
  readonly kind: "local" | "redis";
  check(key: string, policy: RatePolicy): Promise<RateDecision>;
  stats(): RateStats;
  /** availability of the shared backend (only limiters that have one); used by readiness, never by a request */
  health?(): Promise<{ up: boolean; detail?: string }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- local provider
export class LocalRateLimiter implements RateLimiter {
  readonly kind = "local" as const;
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly maxKeys: number;
  private allowed = 0;
  private denied = 0;
  constructor(maxKeys: number) { this.maxKeys = maxKeys; }
  async check(key: string, p: RatePolicy, now = Date.now()): Promise<RateDecision> {
    const refillPerMs = p.limit / (p.windowSeconds * 1000);
    let b = this.buckets.get(key);
    if (b) this.buckets.delete(key); // re-inserted below: the Map order is the LRU order
    else {
      while (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string); // bounded cardinality
      b = { tokens: p.burst, last: now };
    }
    b.tokens = Math.min(p.burst, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; this.allowed++; return { allowed: true, limit: p.limit, remaining: Math.floor(b.tokens), retryAfterSeconds: 0 }; }
    this.denied++;
    return { allowed: false, limit: p.limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000)) };
  }
  stats(): RateStats { return { allowed: this.allowed, denied: this.denied, backendFailures: 0, keys: this.buckets.size }; }
  async close(): Promise<void> { this.buckets.clear(); }
}

// ---------------------------------------------------------------- redis provider
const LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local d = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(d[1])
local last = tonumber(d[2])
if tokens == nil then tokens = capacity; last = now end
tokens = math.min(capacity, tokens + (now - last) * refill)
local allowed = 0
local retry = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 else retry = math.ceil((1 - tokens) / refill / 1000) end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'l', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, math.floor(tokens), retry }
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class RedisRateLimiter implements RateLimiter {
  readonly kind = "redis" as const;
  private client: any;
  private allowed = 0;
  private denied = 0;
  private failures = 0;
  private readonly url: string;
  private readonly prefix: string;
  private readonly policyOnFailure: "open" | "closed";
  constructor(url: string, prefix: string, onFailure: "open" | "closed") { this.url = url; this.prefix = prefix; this.policyOnFailure = onFailure; }

  /** Connects and verifies the script once at start-up so a misconfiguration stops the application instead of failing per request. */
  async init(): Promise<void> {
    let mod: any;
    try { mod = await import("ioredis"); } catch { throw new Error("rate limit provider \"redis\" needs the ioredis package: npm install ioredis"); }
    const Redis = mod.Redis ?? mod.default;
    this.client = new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 250, connectTimeout: 2000, retryStrategy: (n: number) => Math.min(n * 200, 2000) });
    this.client.on("error", () => undefined); // never logged: the URL may carry credentials
    try { await this.client.connect(); await this.client.ping(); }
    catch (e) { this.client.disconnect(); throw new Error(`cannot connect to Redis for rate limiting (${(e as Error).name})`); }
  }

  async check(key: string, p: RatePolicy): Promise<RateDecision> {
    const refillPerMs = p.limit / (p.windowSeconds * 1000);
    const ttl = Math.max(1000, Math.ceil((p.burst / refillPerMs) * 2));
    try {
      const r = (await this.client.eval(LUA, 1, this.prefix + key, String(p.burst), String(refillPerMs), String(ttl))) as [number, number, number];
      if (r[0] === 1) { this.allowed++; return { allowed: true, limit: p.limit, remaining: r[1], retryAfterSeconds: 0 }; }
      this.denied++;
      return { allowed: false, limit: p.limit, remaining: 0, retryAfterSeconds: Math.max(1, r[2]) };
    } catch {
      this.failures++;
      return this.policyOnFailure === "open"
        ? { allowed: true, limit: p.limit, remaining: -1, retryAfterSeconds: 0, backendFailed: true }
        : { allowed: false, limit: p.limit, remaining: 0, retryAfterSeconds: 1, backendFailed: true };
    }
  }
  stats(): RateStats { return { allowed: this.allowed, denied: this.denied, backendFailures: this.failures, keys: -1 }; }
  async health(): Promise<{ up: boolean; detail?: string }> {
    try { await this.client.ping(); return { up: true, detail: "PING answered" }; }
    catch (e) { return { up: false, detail: `PING failed (${(e as Error).name})` }; }
  }
  async close(): Promise<void> { try { this.client?.disconnect(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------- configuration
export interface RateLimitConfig {
  enabled: boolean;
  provider: "local" | "redis";
  redisUrl?: string;
  onFailure: "open" | "closed";
  policy: RatePolicy;
  perPrincipal: boolean;
  maxKeys: number;
  prefix: string;
  trustedProxies: string[];
  /** "METHOD /path" -> policy, from pso.config.json http.rateLimit.routes */
  routes: Map<string, RatePolicy>;
}
export class RateLimitConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`invalid rate limit configuration:\n - ${problems.join("\n - ")}`); this.name = "RateLimitConfigError"; this.problems = problems; }
}

const int = (raw: string | undefined, name: string, def: number, min: number, max: number, problems: string[]): number => {
  if (raw === undefined || raw.trim() === "") return def;
  if (!/^\d+$/.test(raw.trim())) { problems.push(`${name} must be a whole number`); return def; }
  const n = Number(raw.trim());
  if (n < min || n > max) { problems.push(`${name} must be between ${min} and ${max} (got ${n})`); return def; }
  return n;
};

function readRoutes(projectDir: string | undefined, problems: string[]): Map<string, RatePolicy> {
  const out = new Map<string, RatePolicy>();
  if (!projectDir) return out;
  let doc: any;
  try { doc = JSON.parse(readFileSync(join(projectDir, "pso.config.json"), "utf8").replace(/^﻿/, "")); } catch { return out; }
  const list = doc?.http?.rateLimit?.routes;
  if (list === undefined) return out;
  if (!Array.isArray(list)) { problems.push("http.rateLimit.routes must be an array"); return out; }
  list.forEach((r: any, i: number) => {
    const where = `http.rateLimit.routes[${i}]`;
    if (typeof r?.route !== "string" || !/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(r.route)) { problems.push(`${where}.route must look like "POST /users"`); return; }
    const limit = Number(r.limit), windowSeconds = Number(r.windowSeconds ?? 60), burst = Number(r.burst ?? r.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) { problems.push(`${where}.limit must be a whole number between 1 and 1000000`); return; }
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) { problems.push(`${where}.windowSeconds must be between 1 and 86400`); return; }
    if (!Number.isInteger(burst) || burst < 1 || burst > 1_000_000) { problems.push(`${where}.burst must be a whole number between 1 and 1000000`); return; }
    out.set(r.route, { limit, windowSeconds, burst });
  });
  return out;
}

export function loadRateLimitConfig(env: NodeJS.ProcessEnv, projectDir?: string): RateLimitConfig {
  const problems: string[] = [];
  const perMinute = int(env["RATE_LIMIT_PER_MINUTE"], "RATE_LIMIT_PER_MINUTE", 600, 0, 10_000_000, problems);
  const burst = int(env["RATE_LIMIT_BURST"], "RATE_LIMIT_BURST", perMinute || 1, 1, 10_000_000, problems);
  const provider = (env["RATE_LIMIT_PROVIDER"] ?? "local").trim();
  if (provider !== "local" && provider !== "redis") problems.push('RATE_LIMIT_PROVIDER must be "local" or "redis"');
  const onFailure = (env["RATE_LIMIT_FAILURE"] ?? "closed").trim();
  if (onFailure !== "open" && onFailure !== "closed") problems.push('RATE_LIMIT_FAILURE must be "open" or "closed"');
  const redisUrl = env["RATE_LIMIT_REDIS_URL"]?.trim();
  if (provider === "redis") {
    if (!redisUrl) problems.push("RATE_LIMIT_REDIS_URL is required when RATE_LIMIT_PROVIDER=redis");
    else if (!/^rediss?:\/\//.test(redisUrl)) problems.push("RATE_LIMIT_REDIS_URL must start with redis:// or rediss://");
    else if (env["NODE_ENV"] === "production" && redisUrl.startsWith("redis://") && !/^redis:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(redisUrl)) problems.push("in production a non-local Redis for rate limiting must use rediss:// (TLS)");
  }
  const trustedProxies = (env["RATE_LIMIT_TRUSTED_PROXIES"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of trustedProxies) { const [addr, bits] = t.split("/"); if (!isIP(addr ?? "") || (bits !== undefined && !/^\d+$/.test(bits))) problems.push(`RATE_LIMIT_TRUSTED_PROXIES contains an invalid address or CIDR "${t.slice(0, 50)}"`); }
  const maxKeys = int(env["RATE_LIMIT_MAX_KEYS"], "RATE_LIMIT_MAX_KEYS", 10_000, 100, 5_000_000, problems);
  const perPrincipal = (env["RATE_LIMIT_PER_PRINCIPAL"] ?? "true") !== "false";
  const routes = readRoutes(projectDir, problems);
  if (problems.length) throw new RateLimitConfigError(problems);
  return { enabled: perMinute > 0, provider: provider as "local" | "redis", ...(redisUrl ? { redisUrl } : {}), onFailure: onFailure as "open" | "closed", policy: { limit: perMinute, windowSeconds: 60, burst }, perPrincipal, maxKeys, prefix: env["RATE_LIMIT_PREFIX"]?.trim() || "pso:rl:", trustedProxies, routes };
}

// ---------------------------------------------------------------- client identity
export function trustedList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split("/") as [string, string | undefined];
    const fam = isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(addr, fam); else list.addSubnet(addr, Number(bits), fam);
  }
  return list;
}
const norm = (a: string | undefined): string => (a ?? "unknown").replace(/^::ffff:/i, "");
const isTrusted = (list: BlockList, a: string): boolean => { const fam = isIP(a); return fam !== 0 && list.check(a, fam === 6 ? "ipv6" : "ipv4"); };

/**
 * The client address used for limiting. X-Forwarded-For is honoured ONLY when the TCP peer is a configured trusted proxy; the chain is
 * read from the right, skipping trusted hops, so a client cannot choose its own identity by prepending values.
 */
export function clientAddress(req: IncomingMessage, trusted: BlockList | undefined): string {
  const peer = norm(req.socket.remoteAddress);
  if (!trusted || !isTrusted(trusted, peer)) return peer;
  const header = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((s) => norm(s.trim())).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    if (isIP(hop) === 0) return peer; // garbage in the chain: do not guess
    if (!isTrusted(trusted, hop)) return hop;
  }
  return peer;
}

// ---------------------------------------------------------------- the orchestrator-facing facade
export interface RateLimiting {
  readonly config: RateLimitConfig;
  readonly limiter: RateLimiter | undefined;
  trusted: BlockList | undefined;
  close(): Promise<void>;
}

export async function createRateLimiting(env: NodeJS.ProcessEnv, projectDir?: string): Promise<RateLimiting> {
  const config = loadRateLimitConfig(env, projectDir);
  let limiter: RateLimiter | undefined;
  if (config.enabled || config.routes.size > 0) {
    if (config.provider === "redis") { const r = new RedisRateLimiter(config.redisUrl!, config.prefix, config.onFailure); await r.init(); limiter = r; }
    else limiter = new LocalRateLimiter(config.maxKeys);
  }
  return { config, limiter, trusted: config.trustedProxies.length ? trustedList(config.trustedProxies) : undefined, close: async () => { await limiter?.close(); } };
}

/** Headers for a decision (RateLimit-* follow the IETF draft names; Retry-After is the standard one). */
export function rateHeaders(d: RateDecision): Record<string, string> {
  const h: Record<string, string> = { "ratelimit-limit": String(d.limit) };
  if (d.remaining >= 0) h["ratelimit-remaining"] = String(d.remaining);
  if (!d.allowed) { h["retry-after"] = String(d.retryAfterSeconds); h["ratelimit-reset"] = String(d.retryAfterSeconds); }
  return h;
}
