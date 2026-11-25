import type { Capabilities, Delivery, DispatchAdapter, DispatchHealth, PublishOptions, PublishResult, Subscription, SubscriptionHandle } from "./adapter.ts";
import type { DispatchConfig } from "./config.ts";
import { DispatchError, serializeEnvelope, type DispatchEnvelope } from "./envelope.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Kafka (and Redpanda): topic = channel, partition key = the event key (ordering only per key / partition, never global), producer
 * acks=all with idempotence, consumer groups, offsets committed only AFTER the handler succeeded (or the message was dead-lettered).
 * Because offsets only move forward, a message that is being retried blocks later messages of the same partition: retries are bounded.
 */
export class KafkaAdapter implements DispatchAdapter {
  readonly capabilities: Capabilities = { provider: "kafka", publishAck: "acks=all: acknowledged by all in-sync replicas (durability depends on min.insync.replicas)", ordering: "per-key", consumerGroups: true, redelivery: true, delayedRetry: false, deadLetter: true, lag: true };
  private readonly cfg: DispatchConfig["kafka"];
  private kafka: any;
  private producer: any;
  private admin: any;
  private readonly consumers: any[] = [];
  private readonly topics = new Set<string>();

  constructor(cfg: DispatchConfig["kafka"]) { this.cfg = cfg; }

  /** How long start-up waits for the cluster before it gives up (kafkajs alone retries for about a minute). */
  static readonly CONNECT_TIMEOUT_MS = 15_000;

  async connect(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const mod: any = await import("kafkajs");
      const { Kafka, logLevel, Partitioners } = mod;
      this.kafka = new Kafka({
        clientId: this.cfg.clientId, brokers: this.cfg.brokers, logLevel: logLevel.NOTHING, retry: { retries: 8, initialRetryTime: 200 },
        ...(this.cfg.ssl ? { ssl: true } : {}), ...(this.cfg.sasl ? { sasl: { mechanism: this.cfg.sasl.mechanism, username: this.cfg.sasl.username, password: this.cfg.sasl.password } } : {}),
      });
      this.admin = this.kafka.admin();
      const establish = (async () => {
        await this.admin.connect();
        this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1, createPartitioner: Partitioners.DefaultPartitioner });
        await this.producer.connect();
      })();
      establish.catch(() => undefined); // if the deadline wins, a later failure of this attempt is already handled
      await Promise.race([establish, new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("connect timeout"), { name: "ConnectTimeout" })), KafkaAdapter.CONNECT_TIMEOUT_MS); })]);
    } catch (e) {
      // a failed connect must not leave kafkajs clients retrying in the background (leaked sockets and timers, a process that never exits)
      const admin = this.admin, producer = this.producer;
      this.admin = undefined; this.producer = undefined;
      await Promise.race([Promise.allSettled([admin?.disconnect(), producer?.disconnect()]), new Promise((r) => setTimeout(r, 3000))]);
      throw new DispatchError("PSO_DISPATCH_CONNECT", `cannot connect to Kafka (${(e as Error).name})`, { cause: e });
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Metadata is briefly inconsistent while topics are being created (by this client or by another one): retry those answers, a bounded number of times. */
  private async transientRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (attempt >= 6 || !/does not host this topic-partition|leader not available|not available/i.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }

  private async ensureTopic(topic: string): Promise<void> {
    if (this.topics.has(topic)) return;
    const existing: string[] = await this.transientRetry(() => this.admin.listTopics());
    if (!existing.includes(topic)) {
      if (this.cfg.topicCreation === "require") throw new DispatchError("PSO_DISPATCH_TOPOLOGY_MISSING", `topic "${topic}" does not exist and dispatch.kafka.topicCreation is "require"`);
      // waitForLeaders asks for metadata right after creation, which can answer "unknown topic-partition" for a moment
      await this.transientRetry(() => this.admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: this.cfg.partitions, replicationFactor: this.cfg.replicationFactor }] }));
    }
    this.topics.add(topic);
  }

  async publish(channel: string, envelope: DispatchEnvelope, o: PublishOptions = {}): Promise<PublishResult> {
    return this.send(channel, Buffer.from(serializeEnvelope(envelope)), o, envelope.id);
  }
  async publishRaw(channel: string, body: Buffer, o: PublishOptions = {}): Promise<PublishResult> { return this.send(channel, body, o); }

  private async send(channel: string, body: Buffer, o: PublishOptions, id?: string): Promise<PublishResult> {
    if (!this.producer) throw new DispatchError("PSO_DISPATCH_NOT_CONNECTED", "Kafka adapter is not connected");
    await this.ensureTopic(channel);
    // a topic another instance has just created can answer "does not host this topic-partition" / "leader not available" for a
    // moment; those errors mean nothing was written, so only they are retried (transientRetry), never a timeout or an unknown outcome
    const producer = this.producer;
    const op = this.transientRetry<[{ partition: number; baseOffset: string }]>(() => producer.send({ topic: channel, acks: -1, ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}), messages: [{ ...(o.key ? { key: o.key } : {}), value: body, headers: o.headers ?? {} }] }));
    const [r] = await op;
    return { id: id ?? `${r.partition}:${r.baseOffset}`, channel, provider: "kafka", position: `${r.partition}:${r.baseOffset}`, acknowledgement: this.capabilities.publishAck };
  }

  async subscribe(s: Subscription): Promise<SubscriptionHandle> {
    await this.ensureTopic(s.channel);
    const consumer = this.kafka.consumer({ groupId: s.group, allowAutoTopicCreation: false, maxWaitTimeInMs: 500, sessionTimeout: 15000, heartbeatInterval: 3000 });
    this.consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: s.channel, fromBeginning: true });
    let inFlight = 0;
    await consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: s.concurrency,
      eachMessage: async ({ topic, partition, message, heartbeat }: any) => {
        inFlight++;
        let done: () => void = () => undefined;
        const finished = new Promise<void>((r) => { done = r; });
        let acked = false;
        const hb = setInterval(() => { void heartbeat().catch(() => undefined); }, 3000); // retries can outlast the session timeout
        const d: Delivery = {
          channel: s.channel, body: Buffer.from(message.value ?? ""), headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)])),
          ack: async () => { await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]); acked = true; done(); },
          nack: async () => { acked = false; done(); throw new Error("nack"); }, // throwing makes kafkajs re-deliver from the uncommitted offset
        };
        try { await s.onMessage(d); await finished; } finally { clearInterval(hb); inFlight--; }
        if (!acked) throw new Error("not acknowledged");
      },
    });
    return {
      stop: async (timeoutMs) => {
        const end = Date.now() + timeoutMs;
        while (inFlight > 0 && Date.now() < end) await sleep(20);
        await consumer.stop().catch(() => undefined);
        await consumer.disconnect().catch(() => undefined);
      },
    };
  }

  /** Lag of a consumer group on a topic (for diagnostics and Studio). */
  async lag(channel: string, group: string): Promise<number | undefined> {
    try {
      const latest = await this.admin.fetchTopicOffsets(channel);
      const committed = await this.admin.fetchOffsets({ groupId: group, topics: [channel] });
      const cm = new Map<number, number>((committed[0]?.partitions ?? []).map((p: any) => [p.partition, Number(p.offset)]));
      return latest.reduce((n: number, p: any) => n + Math.max(0, Number(p.offset) - Math.max(0, cm.get(p.partition) ?? 0)), 0);
    } catch { return undefined; }
  }

  async health(): Promise<DispatchHealth> {
    try { await this.admin.listTopics(); return { status: "up", detail: "metadata request answered" }; }
    catch (e) { return { status: "down", detail: `metadata request failed (${(e as Error).name})` }; }
  }

  async close(): Promise<void> {
    for (const c of this.consumers) await c.disconnect().catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
    await this.admin?.disconnect().catch(() => undefined);
  }
}
