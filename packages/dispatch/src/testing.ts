import type { Capabilities, Delivery, DispatchAdapter, DispatchHealth, PublishOptions, PublishResult, Subscription, SubscriptionHandle } from "./adapter.ts";
import { serializeEnvelope, type DispatchEnvelope } from "./envelope.ts";

/**
 * An in-process adapter for TESTS ONLY. It follows the adapter contract (consumer groups, redelivery after nack, no loss on a crash of
 * a handler) but it is not a broker: nothing is durable and it proves nothing about Redis, RabbitMQ or Kafka behaviour.
 */
export class MemoryAdapter implements DispatchAdapter {
  readonly capabilities: Capabilities = { provider: "memory", publishAck: "accepted in process memory (not durable)", ordering: "per-key", consumerGroups: true, redelivery: true, delayedRetry: false, deadLetter: true, lag: false };
  /** every message ever published, per channel (inspectable by tests) */
  readonly log = new Map<string, Array<{ body: Buffer; headers: Record<string, string> }>>();
  private readonly cursors = new Map<string, number>(); // channel\0group -> next index
  private readonly redeliver = new Map<string, number[]>();
  private readonly loops: SubscriptionHandle[] = [];
  private connected = false;
  failPublish: Error | undefined;

  async connect(): Promise<void> { this.connected = true; }
  async publish(channel: string, envelope: DispatchEnvelope, o: PublishOptions = {}): Promise<PublishResult> { return this.publishRaw(channel, Buffer.from(serializeEnvelope(envelope)), o, envelope.id); }
  async publishRaw(channel: string, body: Buffer, o: PublishOptions = {}, id?: string): Promise<PublishResult> {
    if (!this.connected) throw new Error("not connected");
    if (this.failPublish) throw this.failPublish;
    const list = this.log.get(channel) ?? [];
    list.push({ body, headers: o.headers ?? {} });
    this.log.set(channel, list);
    return { id: id ?? String(list.length), channel, provider: "memory", position: String(list.length - 1), acknowledgement: this.capabilities.publishAck };
  }

  async subscribe(s: Subscription): Promise<SubscriptionHandle> {
    const key = `${s.channel}\u0000${s.group}`;
    if (!this.cursors.has(key)) this.cursors.set(key, 0);
    let running = true;
    let inFlight = 0;
    const attempts = new Map<number, number>();
    const tick = async (): Promise<void> => {
      while (running) {
        if (inFlight >= s.concurrency) { await new Promise((r) => setTimeout(r, 5)); continue; } // decide capacity BEFORE taking a message
        const redo = this.redeliver.get(key) ?? [];
        const list = this.log.get(s.channel) ?? [];
        const next = this.cursors.get(key)!;
        const idx = redo.length ? redo.shift()! : next < list.length ? (this.cursors.set(key, next + 1), next) : -1;
        if (idx < 0 || inFlight >= s.concurrency) { await new Promise((r) => setTimeout(r, 5)); continue; }
        inFlight++;
        const m = list[idx]!;
        attempts.set(idx, (attempts.get(idx) ?? 0) + 1);
        const d: Delivery = { channel: s.channel, body: m.body, headers: m.headers, deliveryCount: attempts.get(idx)!, ack: async () => { inFlight--; }, nack: async () => { inFlight--; this.redeliver.set(key, [...(this.redeliver.get(key) ?? []), idx]); } };
        void s.onMessage(d).catch(async () => { await d.nack(); });
      }
    };
    const loop = tick();
    const handle = { stop: async (timeoutMs: number) => { running = false; const end = Date.now() + timeoutMs; while (inFlight > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); await loop; } };
    this.loops.push(handle);
    return handle;
  }
  async health(): Promise<DispatchHealth> { return { status: this.connected ? "up" : "down", detail: "in-memory test adapter" }; }
  async close(): Promise<void> { this.connected = false; }
}

export { createEnvelope, parseEnvelope, serializeEnvelope } from "./envelope.ts";
