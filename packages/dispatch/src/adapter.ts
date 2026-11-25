import type { DispatchEnvelope } from "./envelope.ts";

/** What a transport can and cannot do. The runtime refuses a configuration the provider cannot honour instead of faking it. */
export interface Capabilities {
  provider: string;
  /** what "published" means: the strongest statement this transport makes when publish() resolves */
  publishAck: string;
  /** ordering guarantee between messages with the same key */
  ordering: "none" | "per-key";
  consumerGroups: true;
  /** messages delivered but not acknowledged are redelivered after a consumer crash */
  redelivery: true;
  /** delayed (scheduled) redelivery is NOT provided by any adapter: retries run in-process with backoff */
  delayedRetry: false;
  /** a dead-letter destination is a dedicated channel named <channel>.dlq written by the runtime */
  deadLetter: true;
  lag: boolean;
}

/** A message handed to the runtime. It stays unacknowledged (and is redelivered after a crash) until ack() or nack() is called. */
export interface Delivery {
  channel: string;
  body: Buffer;
  headers: Record<string, string>;
  /** how many times the transport has delivered this message (1 on first delivery), when it knows */
  deliveryCount?: number;
  ack(): Promise<void>;
  /** give the message back for redelivery */
  nack(): Promise<void>;
}

export interface Subscription {
  channel: string;
  group: string;
  /** messages processed at the same time */
  concurrency: number;
  batchSize: number;
  onMessage(delivery: Delivery): Promise<void>;
}

export interface SubscriptionHandle {
  /** stop fetching, wait (bounded) for messages in flight, release the consumer */
  stop(timeoutMs: number): Promise<void>;
}

export interface PublishOptions { key?: string; timeoutMs?: number; signal?: AbortSignal; headers?: Record<string, string> }
export interface PublishResult { id: string; channel: string; provider: string; /** provider position (stream id, offset, ...) when known */ position?: string; acknowledgement: string }

export interface DispatchHealth { status: "up" | "down"; detail: string }

/** The stable contract between the runtime and a transport. Adapters never retry business failures: the runtime owns retry policy. */
export interface DispatchAdapter {
  readonly capabilities: Capabilities;
  connect(): Promise<void>;
  publish(channel: string, envelope: DispatchEnvelope, options?: PublishOptions): Promise<PublishResult>;
  /** publishes raw bytes (used for dead letters, which may hold messages that are not valid envelopes) */
  publishRaw(channel: string, body: Buffer, options?: PublishOptions): Promise<PublishResult>;
  subscribe(subscription: Subscription): Promise<SubscriptionHandle>;
  health(): Promise<DispatchHealth>;
  close(): Promise<void>;
}

/** Outcome of an atomic claim: "claimed" (this owner may run the handler), "busy" (another owner holds a live lease), "done" (already processed). */
export type ClaimResult = "claimed" | "busy" | "done";

/**
 * Remembers processed event ids per consumer group. Production use needs a durable, shared store (see the Redis one).
 *
 * `has` / `add` are the original contract (check, run, record): they are NOT atomic, so two consumers that receive the same event at
 * the same moment both run the handler. A store that also implements the claim methods closes that window: the runtime claims the id
 * atomically BEFORE the handler runs, keeps the lease alive while it runs and turns it into a completion record afterwards. The
 * stores shipped with the framework implement them; a custom store with only has/add keeps working with the original guarantee.
 */
export interface IdempotencyStore {
  has(key: string): Promise<boolean>;
  add(key: string, ttlMs: number): Promise<void>;
  /** Atomically: completed -> "done"; live lease of another owner -> "busy"; otherwise take (or extend) the lease for `owner`. */
  claim?(key: string, owner: string, leaseMs: number): Promise<ClaimResult>;
  /** Extends the lease when `owner` still holds it; false means the lease was lost (expired and possibly taken by someone else). */
  renew?(key: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Records completion. True when recorded (the owner held the lease, or nobody did); false when ANOTHER owner holds it now. */
  complete?(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Gives the lease back (the handler failed): only the owner's own lease is removed, never another owner's or a completion record. */
  release?(key: string, owner: string): Promise<void>;
}

/** Bounded in-memory store: oldest entries are evicted and entries expire. Per process only; it does not survive a restart. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Map<string, number>();
  /** leases of handlers that are running right now: key -> owner and expiry */
  private readonly leases = new Map<string, { owner: string; exp: number }>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(maxEntries = 50_000, now: () => number = Date.now) { this.maxEntries = maxEntries; this.now = now; }
  async has(key: string): Promise<boolean> {
    const exp = this.seen.get(key);
    if (exp === undefined) return false;
    if (exp < this.now()) { this.seen.delete(key); return false; }
    return true;
  }
  async add(key: string, ttlMs: number): Promise<void> {
    this.seen.delete(key);
    if (this.seen.size >= this.maxEntries) this.seen.delete(this.seen.keys().next().value as string);
    this.seen.set(key, this.now() + ttlMs);
  }
  // single-threaded: each method runs to completion without yielding between its check and its write, so it is atomic in the process
  async claim(key: string, owner: string, leaseMs: number): Promise<ClaimResult> {
    const exp = this.seen.get(key);
    if (exp !== undefined) { if (exp >= this.now()) return "done"; this.seen.delete(key); }
    const l = this.leases.get(key);
    if (l && l.owner !== owner && l.exp >= this.now()) return "busy";
    this.leases.set(key, { owner, exp: this.now() + leaseMs });
    return "claimed";
  }
  async renew(key: string, owner: string, leaseMs: number): Promise<boolean> {
    const l = this.leases.get(key);
    if (!l || l.owner !== owner || l.exp < this.now()) return false;
    l.exp = this.now() + leaseMs;
    return true;
  }
  async complete(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const l = this.leases.get(key);
    if (l && l.owner !== owner && l.exp >= this.now()) return false;
    this.leases.delete(key);
    await this.add(key, ttlMs);
    return true;
  }
  async release(key: string, owner: string): Promise<void> { if (this.leases.get(key)?.owner === owner) this.leases.delete(key); }
}
