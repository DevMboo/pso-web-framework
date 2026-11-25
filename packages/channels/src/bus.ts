import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ChannelEnvelope } from "./protocol.ts";

/**
 * Where a bus message came from. "local": produced by this process after the hub validated it. "remote": received from outside the
 * process (another instance through Redis) and therefore UNTRUSTED until the hub validates it again. A bus that does not say is
 * treated as "local" (the behaviour before origins existed; an in-process bus only ever carries validated events).
 */
export type BusOrigin = "local" | "remote";
export type BusListener = (env: ChannelEnvelope, origin?: BusOrigin) => void;

/**
 * Cross-instance fan-out of server events. A bus is delivery plumbing for browsers, not a message broker: it is fire-and-forget
 * (no persistence, no replay, no retry); durable inter-service messaging stays with PSO Dispatch.
 */
export interface ChannelBus {
  readonly kind: "local" | "redis";
  publish(env: ChannelEnvelope): Promise<void>;
  onMessage(cb: BusListener): void;
  /** availability of the shared transport (buses that have one); read by readiness, never per message */
  health?(): Promise<{ status: "up" | "down"; detail: string }>;
  close(): Promise<void>;
}

/** Single instance (development, one orchestrator): delivery happens in this process only. Not distributed. */
export class LocalBus implements ChannelBus {
  readonly kind = "local" as const;
  #cb: BusListener | undefined;
  async publish(env: ChannelEnvelope): Promise<void> { const cb = this.#cb; if (cb) queueMicrotask(() => cb(env, "local")); }
  onMessage(cb: BusListener): void { this.#cb = cb; }
  async close(): Promise<void> { this.#cb = undefined; }
}

export interface RedisBusOptions {
  /**
   * Shared secret of the orchestrator instances (32+ characters). When set, every message is signed (HMAC-SHA256) and a received message
   * without a valid signature is dropped: only a holder of the secret can make an instance deliver an event. Without it the bus trusts
   * whoever can publish to the Redis topic (restrict that with Redis ACLs and network policy).
   */
  secret?: string;
  /** secrets still accepted for verification during a rotation (never used to sign) */
  previousSecrets?: readonly string[];
  /**
   * MIGRATION ONLY, with `secret`: still deliver messages that carry no signature (instances not upgraded yet). A message that carries
   * a signature must always verify. Each accepted unsigned message is reported through onUnsigned.
   */
  acceptUnsigned?: boolean;
  /** called for every unsigned message delivered because of acceptUnsigned */
  onUnsigned?: () => void;
  /** largest raw bus message accepted (bytes); larger messages are dropped before they are parsed */
  maxBytes?: number;
  onError?: (e: Error) => void;
  /** called (with a stable reason, never the content) for every received message that is dropped */
  onReject?: (reason: "oversized" | "malformed" | "unsigned" | "bad-signature") => void;
}

const sign = (secret: string, topic: string, instance: string, body: string): string => createHmac("sha256", secret).update(`${topic}\n${instance}\n${body}`).digest("base64url");

/** Redis pub/sub between orchestrator instances. Every instance delivers to the connections it owns; no global connection table exists. */
export class RedisBus implements ChannelBus {
  readonly kind = "redis" as const;
  readonly #instance = randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #pub: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #sub: any;
  #cb: BusListener | undefined;
  readonly #topic: string;
  readonly #url: string;
  readonly #o: RedisBusOptions;
  /** `options` may be the legacy error callback */
  constructor(url: string, prefix: string, options: RedisBusOptions | ((e: Error) => void) = {}) {
    this.#url = url; this.#topic = `${prefix}:events`;
    this.#o = typeof options === "function" ? { onError: options } : options;
  }
  get authenticated(): boolean { return !!this.#o.secret; }

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("ioredis");
    const Redis = mod.default?.default ?? mod.default ?? mod.Redis;
    // the FIRST connection is explicit and bounded: an unreachable Redis fails start-up instead of waiting forever on a reconnecting
    // client. Once started, ioredis reconnects (and re-subscribes) on its own after an outage.
    this.#pub = new Redis(this.#url, { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.#sub = new Redis(this.#url, { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: null });
    for (const c of [this.#pub, this.#sub]) c.on("error", (e: Error) => this.#o.onError?.(e));
    try { await Promise.all([this.#pub.connect(), this.#sub.connect()]); await this.#sub.subscribe(this.#topic); }
    catch (e) { // a failed start leaves no client reconnecting in the background; the message never carries the URL
      this.#pub.disconnect(); this.#sub.disconnect(); this.#pub = undefined; this.#sub = undefined;
      throw new Error(`cannot connect to Redis for the channels bus (${(e as Error).name})`);
    }
    this.#sub.on("message", (_t: string, data: string) => this.#receive(data));
  }

  /** Transport-level checks of one received message: size, shape, origin instance and (when a secret is configured) the signature. */
  #receive(data: string): void {
    if (typeof data !== "string" || Buffer.byteLength(data) > (this.#o.maxBytes ?? 1_048_576)) return void this.#o.onReject?.("oversized");
    let m: { i?: unknown; e?: unknown; s?: unknown };
    try { m = JSON.parse(data) as typeof m; } catch { return void this.#o.onReject?.("malformed"); }
    if (typeof m !== "object" || m === null || typeof m.i !== "string" || typeof m.e !== "object" || m.e === null) return void this.#o.onReject?.("malformed");
    if (m.i === this.#instance) return; // this instance's own copy: already delivered locally (never re-delivered, never re-published)
    if (this.#o.secret) {
      if (m.s === undefined && this.#o.acceptUnsigned) { this.#o.onUnsigned?.(); this.#cb?.(m.e as ChannelEnvelope, "remote"); return; } // explicit migration window; a present signature is never waved through
      if (typeof m.s !== "string") return void this.#o.onReject?.("unsigned");
      const body = JSON.stringify(m.e);
      const got = Buffer.from(m.s);
      const ok = [this.#o.secret, ...(this.#o.previousSecrets ?? [])].some((k) => { const want = Buffer.from(sign(k, this.#topic, m.i as string, body)); return want.length === got.length && timingSafeEqual(want, got); });
      if (!ok) return void this.#o.onReject?.("bad-signature");
    }
    this.#cb?.(m.e as ChannelEnvelope, "remote"); // still untrusted content: the hub validates it before any fan-out
  }

  async publish(env: ChannelEnvelope): Promise<void> {
    if (!this.#pub) throw new Error("redis bus is not started");
    const body = JSON.stringify(env);
    await this.#pub.publish(this.#topic, this.#o.secret ? `{"i":${JSON.stringify(this.#instance)},"e":${body},"s":${JSON.stringify(sign(this.#o.secret, this.#topic, this.#instance, body))}}` : `{"i":${JSON.stringify(this.#instance)},"e":${body}}`);
    this.#cb?.(env, "local"); // local delivery without the round trip; other instances receive it from Redis (this one ignores its own copy)
  }
  onMessage(cb: BusListener): void { this.#cb = cb; }
  async health(): Promise<{ status: "up" | "down"; detail: string }> {
    if (!this.#pub || !this.#sub) return { status: "down", detail: "not started" };
    if (this.#sub.status !== "ready") return { status: "down", detail: "subscriber connection is not ready" };
    try { await this.#pub.ping(); return { status: "up", detail: "PING answered" }; }
    catch (e) { return { status: "down", detail: `PING failed (${(e as Error).name})` }; }
  }
  async close(): Promise<void> {
    this.#cb = undefined;
    const sub = this.#sub, pub = this.#pub;
    // graceful first; with the server gone quit() can wait forever on a reconnecting client, so it is bounded and then cut
    await Promise.race([Promise.allSettled([sub?.quit(), pub?.quit()]), new Promise((r) => { setTimeout(r, 1000).unref(); })]);
    sub?.disconnect(); pub?.disconnect();
  }
}
