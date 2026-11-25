import { randomBytes } from "node:crypto";
import type { Capabilities, ClaimResult, Delivery, DispatchAdapter, DispatchHealth, IdempotencyStore, PublishOptions, PublishResult, Subscription, SubscriptionHandle } from "./adapter.ts";
import type { DispatchConfig } from "./config.ts";
import { DispatchError, serializeEnvelope, type DispatchEnvelope } from "./envelope.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type RedisClient = any;

async function client(url: string): Promise<RedisClient> {
  const mod: any = await import("ioredis");
  const Redis = mod.Redis ?? mod.default;
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, enableReadyCheck: true, retryStrategy: (n: number) => Math.min(n * 200, 5000) });
  r.on("error", () => undefined); // surfaced through health() and failed operations; never logged with the URL
  try { await r.connect(); } catch (e) { r.disconnect(); throw e; } // a failed connect must not leave a client retrying forever
  return r;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fieldsToObject = (f: string[]): Record<string, string> => { const o: Record<string, string> = {}; for (let i = 0; i + 1 < f.length; i += 2) o[f[i]!] = f[i + 1]!; return o; };

/**
 * Redis Streams (never Pub/Sub): XADD with approximate MAXLEN retention, consumer groups, XREADGROUP, XACK only after processing,
 * and recovery of stale pending entries (XAUTOCLAIM) so a crashed consumer's messages are processed by another one.
 */
export class RedisStreamsAdapter implements DispatchAdapter {
  readonly capabilities: Capabilities = { provider: "redis", publishAck: "XADD acknowledged by Redis: in memory, durable only if the server persists (AOF) or replicates", ordering: "per-key", consumerGroups: true, redelivery: true, delayedRetry: false, deadLetter: true, lag: true };
  private readonly cfg: DispatchConfig["redis"];
  private redis: RedisClient | undefined;
  private readonly extra: RedisClient[] = [];
  /** stop switches of every consumer loop: close() must end them even when the subscription handle is never stopped (a crashed consumer) */
  private readonly loops: Array<() => void> = [];
  private readonly consumer = `c-${process.pid}-${randomBytes(4).toString("hex")}`;

  constructor(cfg: DispatchConfig["redis"]) { this.cfg = cfg; }

  async connect(): Promise<void> {
    try { this.redis = await client(this.cfg.url); await this.redis.ping(); }
    catch (e) { throw new DispatchError("PSO_DISPATCH_CONNECT", `cannot connect to Redis (${(e as Error).name})`, { cause: e }); }
  }

  async publish(channel: string, envelope: DispatchEnvelope, o: PublishOptions = {}): Promise<PublishResult> {
    return this.publishRaw(channel, Buffer.from(serializeEnvelope(envelope)), { ...o, headers: { ...(o.headers ?? {}) } }, envelope.id);
  }

  async publishRaw(channel: string, body: Buffer, o: PublishOptions = {}, id?: string): Promise<PublishResult> {
    if (!this.redis) throw new DispatchError("PSO_DISPATCH_NOT_CONNECTED", "Redis adapter is not connected");
    const args: (string | Buffer)[] = [channel, "MAXLEN", "~", String(this.cfg.maxLength), "*", "envelope", body];
    if (o.key) args.push("key", o.key);
    for (const [k, v] of Object.entries(o.headers ?? {})) args.push(`h:${k}`, v);
    const op = this.redis.xadd(...args) as Promise<string>;
    const guarded = o.timeoutMs ? Promise.race([op, sleep(o.timeoutMs).then(() => { throw new DispatchError("PSO_DISPATCH_TIMEOUT", `publish to ${channel} timed out`); })]) : op;
    const position = await guarded;
    return { id: id ?? position, channel, provider: "redis", position, acknowledgement: this.capabilities.publishAck };
  }

  async subscribe(s: Subscription): Promise<SubscriptionHandle> {
    if (!this.redis) throw new DispatchError("PSO_DISPATCH_NOT_CONNECTED", "Redis adapter is not connected");
    try {
      await this.redis.xgroup("CREATE", s.channel, s.group, "0", ...(this.cfg.streamCreation === "auto" ? ["MKSTREAM"] : []));
    } catch (e) {
      const m = String((e as Error).message);
      if (!m.includes("BUSYGROUP")) throw new DispatchError(m.includes("requires the key to exist") ? "PSO_DISPATCH_TOPOLOGY_MISSING" : "PSO_DISPATCH_SUBSCRIBE", m.includes("requires the key to exist") ? `stream "${s.channel}" does not exist and dispatch.redis.streamCreation is "require"` : `cannot create consumer group (${(e as Error).name})`, { cause: e });
    }
    const reader = await client(this.cfg.url); // a dedicated connection: XREADGROUP BLOCK would stall everything else
    this.extra.push(reader);
    let running = true, inFlight = 0, lastClaim = 0;
    // stopping must never wait for Redis: while the reader is reconnecting, a blocked read stays queued inside the client and would
    // never settle (not even after disconnect()), so the loop races every read against this signal and leaves at once
    let halt: () => void = () => undefined;
    const halted = new Promise<undefined>((r) => { halt = () => r(undefined); });
    const read = <T>(op: Promise<T>): Promise<T | undefined> => { op.catch(() => undefined); return Promise.race([op, halted]); };
    this.loops.push(() => { running = false; halt(); });
    const toDelivery = (id: string, f: string[]): Delivery => {
      const o = fieldsToObject(f);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if (k.startsWith("h:")) headers[k.slice(2)] = v;
      return { channel: s.channel, body: Buffer.from(o["envelope"] ?? ""), headers, ack: async () => { await this.redis.xack(s.channel, s.group, id); inFlight--; }, nack: async () => { inFlight--; /* stays pending: reclaimed after dispatch.redis.minIdle */ } };
    };
    const run = (id: string, f: string[]) => { inFlight++; const d = toDelivery(id, f); void s.onMessage(d).catch(async () => { await d.nack(); }); };
    const loop = (async () => {
      while (running) {
        try {
          const free = s.concurrency - inFlight;
          if (free <= 0) { await sleep(10); continue; }
          const count = Math.min(free, s.batchSize);
          if (Date.now() - lastClaim > Math.max(500, this.cfg.minIdleMs / 2)) {
            lastClaim = Date.now();
            const claimed = await read(reader.xautoclaim(s.channel, s.group, this.consumer, this.cfg.minIdleMs, "0-0", "COUNT", count) as Promise<unknown[]>);
            if (!running) break;
            for (const [id, f] of (claimed?.[1] ?? []) as Array<[string, string[]]>) if (f) run(id, f);
            if (s.concurrency - inFlight <= 0) continue;
          }
          const res = await read(reader.xreadgroup("GROUP", s.group, this.consumer, "COUNT", count, "BLOCK", this.cfg.blockMs, "STREAMS", s.channel, ">") as Promise<unknown>);
          if (!running) break;
          for (const [, entries] of (res ?? []) as Array<[string, Array<[string, string[]]>]>) for (const [id, f] of entries) run(id, f);
        } catch (e) {
          if (!running) break;
          await sleep(500); // transient connection problems: ioredis reconnects; pending messages remain pending
          void e;
        }
      }
    })();
    return {
      stop: async (timeoutMs) => {
        running = false; halt();
        const end = Date.now() + timeoutMs;
        while (inFlight > 0 && Date.now() < end) await sleep(10);
        reader.disconnect();
        await loop.catch(() => undefined);
      },
    };
  }

  /** Consumer lag and pending counts of a group (for diagnostics and Studio). */
  async groupInfo(channel: string, group: string): Promise<{ pending: number; lag: number | null } | undefined> {
    try {
      const groups = (await this.redis.xinfo("GROUPS", channel)) as Array<unknown[]>;
      for (const g of groups) { const o = fieldsToObject(g.map(String)); if (o["name"] === group) return { pending: Number(o["pending"]), lag: o["lag"] === undefined || o["lag"] === "" ? null : Number(o["lag"]) }; }
    } catch { /* no such stream */ }
    return undefined;
  }

  async health(): Promise<DispatchHealth> {
    try { await this.redis?.ping(); return this.redis ? { status: "up", detail: "PING answered" } : { status: "down", detail: "not connected" }; }
    catch (e) { return { status: "down", detail: `PING failed (${(e as Error).name})` }; }
  }

  async close(): Promise<void> {
    for (const stop of this.loops.splice(0)) stop();
    for (const r of this.extra) r.disconnect();
    const r = this.redis;
    this.redis = undefined;
    if (r) {
      // graceful first; if the server is gone quit() fails or hangs, and a client left in "reconnecting" would retry forever
      try { await Promise.race([r.quit(), sleep(1000)]); } catch { /* the connection is already broken */ }
      r.disconnect();
    }
  }
}

// Each script is one atomic step on the server. A completion record is the value "1" (what earlier versions wrote, so their records
// stay valid); a lease is "p:<owner>" with its own expiry, so a consumer that crashed after claiming blocks nobody past the lease.
const CLAIM = `local v = redis.call('GET', KEYS[1])
if v == '1' then return 'done' end
if v and v ~= ARGV[1] then return 'busy' end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 'claimed'`;
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end return 0`;
const COMPLETE = `local v = redis.call('GET', KEYS[1])
if v and v ~= '1' and v ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], '1', 'PX', ARGV[2])
return 1`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/**
 * Durable, shared idempotency: duplicates are detected across restarts and instances, and the claim is atomic (one Lua step), so two
 * instances that receive the same event at the same moment cannot both run its handler while the first one holds its lease.
 * Connects on first use. A Redis failure is an error to the caller (the message is not handled and stays with the broker): the
 * store never answers "not seen" because it could not ask.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private redis: RedisClient | undefined;
  private readonly source: string | RedisClient;
  private readonly prefix: string;
  constructor(source: string | RedisClient, prefix = "pso:idem:") { this.source = source; this.prefix = prefix; }
  private async conn(): Promise<RedisClient> {
    if (this.redis) return this.redis;
    if (typeof this.source !== "string") return (this.redis = this.source);
    try { this.redis = await client(this.source); } catch (e) { throw new DispatchError("PSO_DISPATCH_CONNECT", `cannot connect to Redis for idempotency (${(e as Error).name})`); }
    return this.redis;
  }
  async has(key: string): Promise<boolean> { return (await (await this.conn()).exists(this.prefix + key)) === 1; }
  async add(key: string, ttlMs: number): Promise<void> { await (await this.conn()).set(this.prefix + key, "1", "PX", ttlMs); }
  /** bound of one store command (ms): a store that cannot answer must fail, not hang the consumer (or shutdown) forever */
  timeoutMs = 5000;
  private async run<T>(script: string, key: string, a: string, b?: number): Promise<T> {
    const r = await this.conn();
    const op = (b === undefined ? r.eval(script, 1, this.prefix + key, a) : r.eval(script, 1, this.prefix + key, a, String(Math.max(1, Math.round(b))))) as Promise<T>;
    op.catch(() => undefined);
    let t: NodeJS.Timeout | undefined;
    try { return await Promise.race([op, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new DispatchError("PSO_DISPATCH_IDEMPOTENCY_UNAVAILABLE", "the idempotency store did not answer in time")), this.timeoutMs); })]); }
    finally { clearTimeout(t); }
  }
  async claim(key: string, owner: string, leaseMs: number): Promise<ClaimResult> { return this.run<ClaimResult>(CLAIM, key, "p:" + owner, leaseMs); }
  async renew(key: string, owner: string, leaseMs: number): Promise<boolean> { return (await this.run<number>(RENEW, key, "p:" + owner, leaseMs)) === 1; }
  async complete(key: string, owner: string, ttlMs: number): Promise<boolean> { return (await this.run<number>(COMPLETE, key, "p:" + owner, ttlMs)) === 1; }
  async release(key: string, owner: string): Promise<void> { await this.run<number>(RELEASE, key, "p:" + owner); }
  close(): void { this.redis?.disconnect(); }
}

export { client as connectRedis };
