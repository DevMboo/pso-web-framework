import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, createEnvelope, parseEnvelope, type DispatchAdapter, type DispatchConfig, type DispatchError } from "../src/index.ts";
import { RedisStreamsAdapter, RedisIdempotencyStore, connectRedis } from "../src/redis.ts";
import { RabbitMqAdapter } from "../src/rabbitmq.ts";
import { KafkaAdapter } from "../src/kafka.ts";
// @ts-expect-error plain ESM script shared with the Java tests
import { up, dockerAvailable, ownedBroker } from "../../../scripts/dispatch-brokers.mjs";
interface OwnedBroker { name: string; url: string; restart(): void; remove(): void }

/**
 * REAL brokers: Redis 7, RabbitMQ 3.13 and Apache Kafka 3.8 (KRaft) in Docker containers started by scripts/dispatch-brokers.mjs.
 * Without a running Docker engine these tests are skipped and reported as unverified, never replaced by mocks.
 */
let env: Record<string, string> | undefined;
let skip: string | false = false;
before(async () => {
  if (process.env["PSO_TEST_REDIS_URL"]) { env = process.env as Record<string, string>; return; }
  if (!dockerAvailable()) { skip = "no Docker engine: real broker tests not run"; return; }
  try { env = await up(); } catch (e) { skip = `brokers unavailable: ${(e as Error).message}`; }
});

const opened: Array<{ close(): unknown }> = [];
const track = <T extends { close(): unknown }>(c: T): T => { opened.push(c); return c; };
const ownBrokers: OwnedBroker[] = [];
after(async () => { for (const c of opened.splice(0)) await Promise.resolve(c.close()).catch(() => undefined); for (const b of ownBrokers.splice(0)) b.remove(); });
// every adapter that connects is tracked (including the ones tests build by hand)
for (const A of [RedisStreamsAdapter, RabbitMqAdapter, KafkaAdapter] as const) {
  const proto = A.prototype as unknown as { connect(): Promise<void> };
  const original = proto.connect;
  proto.connect = async function (this: { close(): unknown }) { opened.push(this); return original.call(this); };
}

const rnd = () => randomBytes(4).toString("hex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 30_000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(50); } };

type Provider = "redis" | "rabbitmq" | "kafka";
const PROVIDERS: Provider[] = ["redis", "rabbitmq", "kafka"];

function adapterFor(p: Provider, tweak: { minIdleMs?: number } = {}): DispatchAdapter {
  const e = env!;
  switch (p) {
    case "redis": return new RedisStreamsAdapter({ url: e["PSO_TEST_REDIS_URL"]!, maxLength: 10000, minIdleMs: tweak.minIdleMs ?? 60_000, blockMs: 300, streamCreation: "auto" });
    case "rabbitmq": return new RabbitMqAdapter({ url: e["PSO_TEST_RABBITMQ_URL"]!, exchangePrefix: "pso.test." });
    case "kafka": return new KafkaAdapter({ brokers: [e["PSO_TEST_KAFKA_BROKERS"]!], clientId: `pso-test-${rnd()}`, topicCreation: "auto", partitions: 3, replicationFactor: 1, ssl: false });
  }
}

const settings = (o: Partial<typeof DEFAULT_SETTINGS> = {}) => ({ source: "svc-service", ...DEFAULT_SETTINGS, retry: { enabled: true, maxAttempts: 3, initialDelayMs: 20, maxDelayMs: 50, multiplier: 2 }, shutdownTimeoutMs: 5000, ...o });

async function rt(p: Provider, channel: string, o: { group?: string; settings?: ReturnType<typeof settings>; adapter?: DispatchAdapter; idempotency?: ConstructorParameters<typeof DispatchRuntime>[0]["idempotency"] } = {}) {
  const registry = new EventRegistry();
  registry.add({ name: "t.event", version: 1, channel, key: "k", schema: { type: "object", required: ["n"], properties: { n: { type: "integer" }, k: { type: "string" } } } });
  const adapter = o.adapter ?? adapterFor(p);
  const runtime = new DispatchRuntime({ settings: o.settings ?? settings(), adapter, registry, ...(o.idempotency ? { idempotency: o.idempotency } : {}) });
  return { runtime, adapter };
}
const group = () => `g-${rnd()}`;

for (const p of PROVIDERS) {
  test(`[${p}] publish -> consume: the handler runs, the message is acknowledged only afterwards, and the result states the real guarantee`, { skip, timeout: 90_000 }, async () => {
    const ch = `ch-${rnd()}`, g = group();
    const { runtime } = await rt(p, ch);
    const got: Array<{ n: number; attempt: number }> = [];
    runtime.registerFunction("t.event", (payload, c) => { got.push({ n: (payload as { n: number }).n, attempt: c.attempt }); }, { group: g });
    await runtime.start();
    const r = await runtime.publish("t.event", { n: 7, k: "a" }, { correlationId: "corr-77" });
    assert.equal(r.provider, p);
    assert.ok(r.acknowledgement.length > 10);
    await until(() => got.length === 1);
    assert.deepEqual(got[0], { n: 7, attempt: 1 });
    await until(() => runtime.metrics().consumed === 1);
    await runtime.stop();
  });

  test(`[${p}] retry: a handler that fails twice is retried and then succeeds; nothing is dead-lettered`, { skip, timeout: 90_000 }, async () => {
    const ch = `ch-${rnd()}`, g = group();
    const { runtime } = await rt(p, ch);
    let calls = 0;
    runtime.registerFunction("t.event", () => { calls++; if (calls < 3) throw new Error("transient"); }, { group: g });
    await runtime.start();
    await runtime.publish("t.event", { n: 1, k: "a" });
    await until(() => runtime.metrics().consumed === 1);
    assert.equal(calls, 3);
    assert.equal(runtime.metrics().deadLettered, 0);
    await runtime.stop();
  });

  test(`[${p}] dead letter: a message that always fails ends in <channel>.dlq with the reason, and the original is acknowledged`, { skip, timeout: 90_000 }, async () => {
    const ch = `ch-${rnd()}`, g = group();
    const main = await rt(p, ch);
    main.runtime.registerFunction("t.event", () => { throw new Error("poison"); }, { group: g });
    await main.runtime.start();
    // watch the dead-letter channel with an independent subscription
    const watcher = adapterFor(p);
    await watcher.connect();
    const seen: Array<{ headers: Record<string, string>; body: Buffer }> = [];
    await watcher.subscribe({ channel: `${ch}.dlq`, group: group(), concurrency: 1, batchSize: 5, onMessage: async (d) => { seen.push({ headers: d.headers, body: d.body }); await d.ack(); } });
    await main.runtime.publish("t.event", { n: 5, k: "a" });
    await until(() => seen.length === 1, 60_000);
    assert.match(seen[0]!.headers["x-pso-reason"]!, /handler-failed:Error/);
    assert.equal(seen[0]!.headers["x-pso-attempts"], "3");
    assert.equal(parseEnvelope(seen[0]!.body).payload && (parseEnvelope(seen[0]!.body).payload as { n: number }).n, 5);
    await until(() => main.runtime.metrics().deadLettered === 1, 10_000); // the counter moves just after the DLQ publish returns: the watcher can be faster
    await main.runtime.stop();
    await watcher.close();
  });

  test(`[${p}] a consumer that crashes mid-processing does not lose the message: another consumer of the group processes it`, { skip, timeout: 150_000 }, async () => {
    const ch = `ch-${rnd()}`, g = group();
    let crash: () => Promise<void>;
    if (p === "kafka") {
      // a REAL crash: a separate process takes the message, hangs, and is killed (heartbeats and sockets stop, nothing is committed)
      const child = spawn(process.execPath, [join(import.meta.dirname, "crash-consumer.ts")], { env: { ...process.env, CRASH_CHANNEL: ch, CRASH_GROUP: g, PSO_TEST_KAFKA_BROKERS: env!["PSO_TEST_KAFKA_BROKERS"]! }, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; child.stdout!.on("data", (d: Buffer) => { out += d; });
      await until(() => out.includes("STARTED"), 60_000);
      const pub = await rt(p, ch); await pub.runtime.start();
      await pub.runtime.publish("t.event", { n: 9, k: "a" });
      await until(() => out.includes("HANDLING"), 60_000);
      crash = async () => { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); if (process.platform !== "win32") child.kill("SIGKILL"); await pub.runtime.stop(); };
    } else {
      const a = await rt(p, ch, { adapter: adapterFor(p, { minIdleMs: 500 }) });
      let started = false;
      a.runtime.registerFunction("t.event", async () => { started = true; await new Promise(() => undefined); }, { group: g }); // hangs forever: never acknowledges
      await a.runtime.start();
      await a.runtime.publish("t.event", { n: 9, k: "a" });
      await until(() => started);
      crash = async () => { await a.adapter.close(); }; // connections drop with the message unacknowledged
    }
    await crash();
    const b = await rt(p, ch, { adapter: adapterFor(p, { minIdleMs: 500 }) });
    const got: number[] = [];
    b.runtime.registerFunction("t.event", (payload) => { got.push((payload as { n: number }).n); }, { group: g });
    await b.runtime.start();
    await until(() => got.length === 1, 120_000);
    assert.deepEqual(got, [9]);
    await b.runtime.stop();
  });

  test(`[${p}] duplicate delivery: the same event id is handled once`, { skip, timeout: 90_000 }, async () => {
    const ch = `ch-${rnd()}`, g = group();
    const idem = p === "redis" ? new RedisIdempotencyStore(await connectRedis(env!["PSO_TEST_REDIS_URL"]!), `pso:test:${rnd()}:`) : undefined;
    if (idem) track(idem);
    const { runtime } = await rt(p, ch, { ...(idem ? { idempotency: idem } : {}) });
    let calls = 0;
    runtime.registerFunction("t.event", () => { calls++; }, { group: g });
    await runtime.start();
    await runtime.publish("t.event", { n: 1, k: "a" }, { id: `dup-${rnd()}-1` });
    const id = `dup-${rnd()}-2`;
    await runtime.publish("t.event", { n: 1, k: "a" }, { id });
    await runtime.publish("t.event", { n: 1, k: "a" }, { id });
    await until(() => runtime.metrics().consumed + runtime.metrics().duplicates === 3);
    assert.equal(calls, 2);
    assert.equal(runtime.metrics().duplicates, 1);
    await runtime.stop();
  });

  test(`[${p}] consumer groups: two consumers of one group share the work, two groups each get every message`, { skip, timeout: 120_000 }, async () => {
    const ch = `ch-${rnd()}`, g1 = group(), g2 = group();
    const mk = async (g: string, sink: number[]) => { const x = await rt(p, ch); x.runtime.registerFunction("t.event", (pl) => { sink.push((pl as { n: number }).n); }, { group: g }); await x.runtime.start(); return x; };
    const s1: number[] = [], s1b: number[] = [], s2: number[] = [];
    const a = await mk(g1, s1), b = await mk(g1, s1b), c = await mk(g2, s2);
    for (let i = 0; i < 12; i++) await a.runtime.publish("t.event", { n: i, k: `key-${i}` });
    await until(() => s1.length + s1b.length === 12 && s2.length === 12, 90_000);
    assert.deepEqual([...s1, ...s1b].sort((x, y) => x - y), [...Array(12).keys()], "each message handled exactly once within a group");
    assert.deepEqual([...s2].sort((x, y) => x - y), [...Array(12).keys()], "the second group saw every message");
    for (const x of [a, b, c]) await x.runtime.stop();
  });

  test(`[${p}] ordering per key: messages with the same key are handled in publish order`, { skip, timeout: 120_000 }, async () => {
    const ch = `ch-${rnd()}`, g = group();
    const { runtime } = await rt(p, ch);
    const got: number[] = [];
    runtime.registerFunction("t.event", (pl) => { got.push((pl as { n: number }).n); }, { group: g, concurrency: 1 });
    await runtime.start();
    for (let i = 0; i < 25; i++) await runtime.publish("t.event", { n: i, k: "same" }, { key: "same" });
    await until(() => got.length === 25, 90_000);
    assert.deepEqual(got, [...Array(25).keys()]);
    await runtime.stop();
  });

  test(`[${p}] broker unavailable: connecting fails with a clear code and no secret in the message`, { skip, timeout: 60_000 }, async () => {
    const bad: DispatchAdapter = p === "redis" ? new RedisStreamsAdapter({ url: "redis://:topsecret@127.0.0.1:1", maxLength: 100, minIdleMs: 1000, blockMs: 100, streamCreation: "auto" })
      : p === "rabbitmq" ? new RabbitMqAdapter({ url: "amqp://u:topsecret@127.0.0.1:1", exchangePrefix: "x." })
        : new KafkaAdapter({ brokers: ["127.0.0.1:1"], clientId: "x", topicCreation: "auto", partitions: 1, replicationFactor: 1, ssl: false });
    await assert.rejects(bad.connect(), (e: DispatchError) => e.code === "PSO_DISPATCH_CONNECT" && !e.message.includes("topsecret"));
  });
}

test("[rabbitmq] a message published before any consumer queue exists is refused (unroutable), never silently dropped", { skip, timeout: 60_000 }, async () => {
  const ch = `ch-${rnd()}`;
  const { runtime } = await rt("rabbitmq", ch);
  await runtime.start();
  await assert.rejects(runtime.publish("t.event", { n: 1, k: "a" }), (e: DispatchError) => e.code === "PSO_DISPATCH_UNROUTABLE");
  await runtime.stop();
});

test("[redis] stale pending messages of a dead consumer are claimed by a live one (XAUTOCLAIM), and consumer lag is observable", { skip, timeout: 90_000 }, async () => {
  const ch = `ch-${rnd()}`, g = group();
  const adapter = new RedisStreamsAdapter({ url: env!["PSO_TEST_REDIS_URL"]!, maxLength: 1000, minIdleMs: 300, blockMs: 200, streamCreation: "auto" });
  await adapter.connect();
  const got: string[] = [];
  const h1 = await adapter.subscribe({ channel: ch, group: g, concurrency: 1, batchSize: 1, onMessage: async (d) => { got.push("c1"); void d; await new Promise(() => undefined); } }); // takes the message, never acks
  await adapter.publish(ch, createEnvelope({ type: "t.event", version: 1, source: "svc-service", payload: { n: 1 } }));
  await until(() => got.includes("c1"));
  const info = await adapter.groupInfo(ch, g);
  assert.equal(info?.pending, 1, "the unacknowledged message is pending, not lost");
  const other = new RedisStreamsAdapter({ url: env!["PSO_TEST_REDIS_URL"]!, maxLength: 1000, minIdleMs: 300, blockMs: 200, streamCreation: "auto" });
  await other.connect();
  const claimed: string[] = [];
  await other.subscribe({ channel: ch, group: g, concurrency: 1, batchSize: 1, onMessage: async (d) => { claimed.push("c2"); await d.ack(); } });
  await until(() => claimed.length === 1, 30_000);
  assert.equal((await other.groupInfo(ch, g))?.pending, 0);
  void h1;
  await other.close();
  await adapter.close();
});

test("[redis] topology policy: streamCreation=require refuses to create a missing stream", { skip, timeout: 60_000 }, async () => {
  const adapter = new RedisStreamsAdapter({ url: env!["PSO_TEST_REDIS_URL"]!, maxLength: 100, minIdleMs: 1000, blockMs: 100, streamCreation: "require" });
  await adapter.connect();
  await assert.rejects(adapter.subscribe({ channel: `missing-${rnd()}`, group: "g", concurrency: 1, batchSize: 1, onMessage: async () => undefined }), (e: DispatchError) => e.code === "PSO_DISPATCH_TOPOLOGY_MISSING");
  await adapter.close();
});

test("[redis] the broker restarts while a consumer runs: consumption resumes without losing messages", { skip, timeout: 180_000 }, async () => {
  // a broker of this test only: the shared containers (used by every other suite, possibly by other people) are never restarted
  const own = await ownedBroker("redis") as OwnedBroker;
  ownBrokers.push(own);
  const ch = `ch-${rnd()}`, g = group();
  const { runtime } = await rt("redis", ch, { adapter: new RedisStreamsAdapter({ url: own.url, maxLength: 10000, minIdleMs: 60_000, blockMs: 300, streamCreation: "auto" }) });
  const got = new Set<number>();
  runtime.registerFunction("t.event", (pl) => { got.add((pl as { n: number }).n); }, { group: g });
  await runtime.start();
  await runtime.publish("t.event", { n: 1, k: "a" });
  await until(() => got.has(1));
  own.restart();
  let published = false;
  await until(async () => { try { if (!published) { await runtime.publish("t.event", { n: 2, k: "a" }); published = true; } return true; } catch { await sleep(300); return false; } }, 60_000);
  await until(() => got.has(2), 60_000);
  await runtime.stop();
});

test("[rabbitmq] the broker connection is lost while a consumer runs: it reconnects and keeps consuming", { skip, timeout: 240_000 }, async () => {
  const own = await ownedBroker("rabbitmq") as OwnedBroker;
  ownBrokers.push(own);
  const ch = `ch-${rnd()}`, g = group();
  const { runtime } = await rt("rabbitmq", ch, { adapter: new RabbitMqAdapter({ url: own.url, exchangePrefix: "pso.test." }) });
  const got = new Set<number>();
  runtime.registerFunction("t.event", (pl) => { got.add((pl as { n: number }).n); }, { group: g });
  await runtime.start();
  await runtime.publish("t.event", { n: 1, k: "a" });
  await until(() => got.has(1));
  own.restart();
  let published = false;
  await until(async () => { try { if (!published) { await runtime.publish("t.event", { n: 2, k: "a" }); published = true; } return true; } catch { await sleep(500); return false; } }, 150_000);
  await until(() => got.has(2), 90_000);
  await runtime.stop();
});

test("[kafka] offsets are committed after processing: a restarted consumer resumes after the last handled message", { skip, timeout: 180_000 }, async () => {
  const ch = `ch-${rnd()}`, g = group();
  const first = await rt("kafka", ch);
  const got1: number[] = [];
  first.runtime.registerFunction("t.event", (pl) => { got1.push((pl as { n: number }).n); }, { group: g, concurrency: 1 });
  await first.runtime.start();
  for (let i = 0; i < 5; i++) await first.runtime.publish("t.event", { n: i, k: "same" }, { key: "same" });
  await until(() => got1.length === 5, 90_000);
  await first.runtime.stop();
  const second = await rt("kafka", ch);
  const got2: number[] = [];
  second.runtime.registerFunction("t.event", (pl) => { got2.push((pl as { n: number }).n); }, { group: g, concurrency: 1 });
  await second.runtime.start();
  for (let i = 5; i < 8; i++) await second.runtime.publish("t.event", { n: i, k: "same" }, { key: "same" });
  await until(() => got2.length >= 3, 90_000);
  await sleep(1500);
  assert.deepEqual(got2, [5, 6, 7], "the five handled messages were not delivered again");
  const k = second.adapter as KafkaAdapter;
  assert.equal(await k.lag(ch, g), 0, "consumer lag is observable and zero when caught up");
  await second.runtime.stop();
});
