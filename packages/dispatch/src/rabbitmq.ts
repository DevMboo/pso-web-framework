import type { Capabilities, Delivery, DispatchAdapter, DispatchHealth, PublishOptions, PublishResult, Subscription, SubscriptionHandle } from "./adapter.ts";
import type { DispatchConfig } from "./config.ts";
import { DispatchError, serializeEnvelope, type DispatchEnvelope } from "./envelope.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * RabbitMQ: durable topic exchange per channel (routing key = event type), one durable queue per consumer group, persistent
 * messages with publisher confirms, manual acknowledgements, prefetch = concurrency, and a durable <channel>.dlq exchange and queue.
 * Topology is declared with fixed arguments: if a queue or exchange already exists with different arguments RabbitMQ refuses the
 * declaration and the error is surfaced; PSO never deletes or redeclares existing topology.
 */
export class RabbitMqAdapter implements DispatchAdapter {
  readonly capabilities: Capabilities = { provider: "rabbitmq", publishAck: "publisher confirm for a persistent message routed to a durable queue", ordering: "none", consumerGroups: true, redelivery: true, delayedRetry: false, deadLetter: true, lag: false };
  private readonly cfg: DispatchConfig["rabbitmq"];
  private conn: any;
  private pub: any;
  private closing = false;
  /** false between a lost connection and its recovery: health() must not report a dead connection object as "up" */
  private connected = false;
  private readonly subs: Array<{ s: Subscription; ch?: any; tag?: string; inFlight: number; active: boolean }> = [];
  private readonly declared = new Set<string>();
  private readonly returned = new Set<string>();

  constructor(cfg: DispatchConfig["rabbitmq"]) { this.cfg = cfg; }

  private ex(channel: string): string { return `${this.cfg.exchangePrefix}${channel}`; }

  async connect(): Promise<void> {
    try { await this.open(); }
    catch (e) { throw new DispatchError("PSO_DISPATCH_CONNECT", `cannot connect to RabbitMQ (${(e as Error).name})`, { cause: e }); }
  }

  private async open(): Promise<void> {
    const mod: any = await import("amqplib");
    const amqp = mod.default ?? mod;
    this.conn = await amqp.connect(this.cfg.url, { heartbeat: 15 });
    this.conn.on("error", () => undefined);
    this.conn.on("close", () => { this.connected = false; if (!this.closing) void this.recover(); });
    this.pub = await this.conn.createConfirmChannel();
    this.pub.on("error", () => undefined);
    this.pub.on("return", (m: any) => { const id = m?.properties?.messageId; if (id) this.returned.add(id); });
    this.declared.clear();
    this.connected = true;
  }

  private async recover(): Promise<void> {
    for (let attempt = 1; !this.closing; attempt++) {
      try {
        await this.open();
        for (const sub of this.subs) if (sub.active) await this.consume(sub);
        return;
      } catch { await sleep(Math.min(attempt * 500, 5000)); }
    }
  }

  private async declareExchange(ch: any, channel: string): Promise<void> {
    if (this.declared.has(channel)) return;
    await ch.assertExchange(this.ex(channel), "topic", { durable: true });
    this.declared.add(channel);
  }

  async publish(channel: string, envelope: DispatchEnvelope, o: PublishOptions = {}): Promise<PublishResult> {
    return this.send(channel, Buffer.from(serializeEnvelope(envelope)), envelope.type, envelope.id, o);
  }

  async publishRaw(channel: string, body: Buffer, o: PublishOptions = {}): Promise<PublishResult> {
    if (channel.endsWith(".dlq")) await this.declareDlq(channel);
    return this.send(channel, body, "dead", undefined, o);
  }

  private async declareDlq(channel: string): Promise<void> {
    await this.declareExchange(this.pub, channel);
    await this.pub.assertQueue(this.ex(channel), { durable: true });
    await this.pub.bindQueue(this.ex(channel), this.ex(channel), "#");
  }

  private async send(channel: string, body: Buffer, routingKey: string, id: string | undefined, o: PublishOptions): Promise<PublishResult> {
    if (!this.pub) throw new DispatchError("PSO_DISPATCH_NOT_CONNECTED", "RabbitMQ adapter is not connected");
    await this.declareExchange(this.pub, channel);
    const messageId = id ?? `raw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const op = new Promise<void>((resolve, reject) => {
      this.pub.publish(this.ex(channel), routingKey, body, { persistent: true, mandatory: true, contentType: "application/json", messageId, headers: o.headers ?? {} }, (err: Error | null) => (err ? reject(err) : resolve()));
    });
    await (o.timeoutMs ? Promise.race([op, sleep(o.timeoutMs).then(() => { throw new DispatchError("PSO_DISPATCH_TIMEOUT", `publish to ${channel} timed out`); })]) : op);
    if (this.returned.delete(messageId)) throw new DispatchError("PSO_DISPATCH_UNROUTABLE", `no queue is bound to "${channel}" yet (no consumer group has declared its queue): the message was not accepted`);
    return { id: id ?? messageId, channel, provider: "rabbitmq", acknowledgement: this.capabilities.publishAck };
  }

  async subscribe(s: Subscription): Promise<SubscriptionHandle> {
    const sub: (typeof this.subs)[number] = { s, inFlight: 0, active: true };
    this.subs.push(sub);
    await this.consume(sub);
    return {
      stop: async (timeoutMs) => {
        sub.active = false;
        try { if (sub.tag) await sub.ch.cancel(sub.tag); } catch { /* connection already gone */ }
        const end = Date.now() + timeoutMs;
        while (sub.inFlight > 0 && Date.now() < end) await sleep(10);
        try { await sub.ch?.close(); } catch { /* ignore */ }
      },
    };
  }

  private async consume(sub: (typeof this.subs)[number]): Promise<void> {
    const { s } = sub;
    const ch = await this.conn.createChannel();
    ch.on("error", () => undefined);
    sub.ch = ch;
    await this.declareExchange(ch, s.channel);
    const queue = `${this.ex(s.channel)}.${s.group}`;
    await ch.assertQueue(queue, { durable: true });
    await ch.bindQueue(queue, this.ex(s.channel), "#");
    await this.declareDlq(`${s.channel}.dlq`);
    await ch.prefetch(s.concurrency);
    const { consumerTag } = await ch.consume(queue, (msg: any) => {
      if (!msg) return;
      sub.inFlight++;
      const d: Delivery = {
        channel: s.channel, body: msg.content, headers: Object.fromEntries(Object.entries(msg.properties.headers ?? {}).map(([k, v]) => [k, String(v)])), deliveryCount: msg.fields.redelivered ? 2 : 1,
        ack: async () => { try { ch.ack(msg); } finally { sub.inFlight--; } },
        // never an immediate requeue loop: the message goes back after a pause
        nack: async () => { sub.inFlight--; await sleep(1000); try { ch.nack(msg, false, true); } catch { /* channel closed: the broker requeues unacked messages itself */ } },
      };
      void s.onMessage(d).catch(async () => { await d.nack(); });
    }, { noAck: false });
    sub.tag = consumerTag;
  }

  async health(): Promise<DispatchHealth> {
    return this.conn && this.pub && this.connected && !this.closing ? { status: "up", detail: "connection open" } : { status: "down", detail: this.closing ? "closing" : this.conn ? "connection lost; reconnecting" : "not connected" };
  }

  async close(): Promise<void> {
    this.closing = true;
    try { await this.pub?.close(); } catch { /* ignore */ }
    try { await this.conn?.close(); } catch { /* ignore */ }
  }
}
