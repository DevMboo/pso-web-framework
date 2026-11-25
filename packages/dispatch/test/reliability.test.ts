import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, MemoryIdempotencyStore, createEnvelope, serializeEnvelope, loadDispatchConfig, describeDispatchConfig, idempotencyOf, DispatchConfigError,
  type DispatchAdapter, type DispatchConfig, type IdempotencyStore, type SubscriptionHandle,
} from "../src/index.ts";
import { MemoryAdapter } from "../src/testing.ts";
import { RedisIdempotencyStore, connectRedis } from "../src/redis.ts";
import { RabbitMqAdapter } from "../src/rabbitmq.ts";
// @ts-expect-error plain ESM script shared with the Java tests
import { up, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";

/**
 * Reliability details that the delivery contract (at-least-once) depends on: where processed event ids are remembered and what that
 * means across a consumer restart, and that stopping a runtime always releases its transport.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 30_000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(25); } };
const rnd = () => randomBytes(4).toString("hex");

test("the idempotency store is an explicit, validated choice; the default is what it always was", () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-idem-"));
  const load = (dispatch: Record<string, unknown>, env: Record<string, string> = {}): DispatchConfig => { writeFileSync(join(dir, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, ...dispatch } })); return loadDispatchConfig({ projectDir: dir, source: "orders-service", env }); };
  try {
    // auto (default): the provider's own Redis when the provider is redis, otherwise this process's memory -- unchanged behaviour
    assert.deepEqual(load({ provider: "redis", redis: { url: "redis://cache:6379" } }).idempotency, { store: "redis", redisUrl: "redis://cache:6379" });
    assert.deepEqual(load({ provider: "rabbitmq", rabbitmq: { url: "amqp://mq" } }).idempotency, { store: "memory" });
    assert.deepEqual(load({ provider: "kafka", kafka: { brokers: ["k:9092"] } }).idempotency, { store: "memory" });
    // durable, shared deduplication for RabbitMQ and Kafka consumers
    const durable = load({ provider: "rabbitmq", rabbitmq: { url: "amqp://mq" }, idempotency: { store: "redis", redisUrl: "${env:IDEM_URL}" } }, { IDEM_URL: "rediss://:s3cr3t@cache.internal:6380/2" });
    assert.deepEqual(durable.idempotency, { store: "redis", redisUrl: "rediss://:s3cr3t@cache.internal:6380/2" });
    const described = describeDispatchConfig(durable) as { idempotency: unknown };
    assert.deepEqual(described.idempotency, { store: "redis", durable: true, retentionMs: 24 * 3600_000 });
    assert.ok(!JSON.stringify(described).includes("s3cr3t") && !JSON.stringify(described).includes("cache.internal"), "the printable description never contains the store's URL");
    assert.deepEqual(load({ provider: "kafka", kafka: { brokers: ["k:9092"] } }, { PSO_DISPATCH_IDEMPOTENCY_STORE: "redis", PSO_DISPATCH_IDEMPOTENCY_REDIS_URL: "redis://cache:6379" }).idempotency, { store: "redis", redisUrl: "redis://cache:6379" }, "variables work too");
    assert.deepEqual(load({ provider: "redis", redis: { url: "redis://cache:6379" }, idempotency: { store: "memory" } }).idempotency, { store: "memory" }, "memory can be chosen deliberately");
    // refused: a durable store without anywhere to keep it, and an unknown store
    assert.throws(() => load({ provider: "rabbitmq", rabbitmq: { url: "amqp://mq" }, idempotency: { store: "redis" } }), (e: unknown) => e instanceof DispatchConfigError && /dispatch\.idempotency\.redisUrl/.test(e.message));
    assert.throws(() => load({ provider: "rabbitmq", rabbitmq: { url: "amqp://mq" }, idempotency: { store: "postgres" } }), (e: unknown) => e instanceof DispatchConfigError && /"dispatch\.idempotency\.store" must be one of auto, memory, redis/.test(e.message));
    // a configuration object built by hand (before the field existed) keeps the rule it always had
    const { idempotency: _dropped, ...legacy } = load({ provider: "redis", redis: { url: "redis://cache:6379" } });
    assert.deepEqual(idempotencyOf(legacy), { store: "redis", redisUrl: "redis://cache:6379" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function runtime(adapter: DispatchAdapter, idempotency: IdempotencyStore | undefined, channel: string, onEvent: (n: number) => void, group: string) {
  const registry = new EventRegistry();
  registry.add({ name: "t.event", version: 1, channel });
  const rt = new DispatchRuntime({ settings: { source: "svc-service", ...DEFAULT_SETTINGS, retry: { enabled: true, maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, multiplier: 1 }, shutdownTimeoutMs: 3000 }, adapter, registry, ...(idempotency ? { idempotency } : {}) });
  rt.registerFunction("t.event", (p) => { onEvent((p as { n: number }).n); }, { group });
  return rt;
}

test("stop() always closes the transport, even when a consumer cannot be stopped cleanly, and is idempotent", async () => {
  let closed = 0;
  const base = new MemoryAdapter();
  const failing: DispatchAdapter = {
    capabilities: base.capabilities, connect: () => base.connect(), publish: (c, e, o) => base.publish(c, e, o), publishRaw: (c, b, o) => base.publishRaw(c, b, o), health: () => base.health(),
    subscribe: async (s): Promise<SubscriptionHandle> => { const h = await base.subscribe(s); return { stop: async (t) => { await h.stop(t); throw new Error("the consumer could not be released"); } }; },
    close: async () => { closed++; await base.close(); },
  };
  const rt = runtime(failing, undefined, "c.events", () => undefined, "g");
  await rt.start();
  await rt.stop();
  await rt.stop();
  assert.equal(closed, 1, "the adapter was closed exactly once although stopping the consumer failed");
});

// ------------------------------------------------------------------------------------------------ real broker + real Redis
let env: Record<string, string> | undefined;
let skip: string | false = false;
before(async () => {
  if (process.env["PSO_TEST_REDIS_URL"]) { env = process.env as Record<string, string>; return; }
  if (!dockerAvailable()) { skip = "no Docker engine: real broker tests not run"; return; }
  try { env = await up(); } catch (e) { skip = `brokers unavailable: ${(e as Error).message}`; }
});
const opened: Array<{ close(): unknown }> = [];
after(async () => { for (const c of opened.splice(0)) await Promise.resolve(c.close()).catch(() => undefined); });

test("consumer restart: with the durable store a redelivered event is NOT handled again; with the in-memory store it is (the documented limit)", { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const rabbit = (): RabbitMqAdapter => { const a = new RabbitMqAdapter({ url: env!["PSO_TEST_RABBITMQ_URL"]!, exchangePrefix: "pso.test." }); opened.push(a); return a; };
  for (const durable of [true, false]) {
    const channel = `restart-${durable ? "durable" : "memory"}-${rnd()}`, group = `g-${rnd()}`, prefix = `pso:test:idem:${rnd()}:`;
    const redis = await connectRedis(env!["PSO_TEST_REDIS_URL"]!);
    opened.push({ close: () => redis.disconnect() });
    const store = (): IdempotencyStore => (durable ? new RedisIdempotencyStore(redis, prefix) : new MemoryIdempotencyStore());
    const handled: number[] = [];
    const event = Buffer.from(serializeEnvelope(createEnvelope({ type: "t.event", version: 1, source: "svc-service", payload: { n: 1 }, id: `evt-${rnd()}` })));

    // first life of the consumer: the event is handled and acknowledged
    const first = runtime(rabbit(), store(), channel, (n) => handled.push(n), group);
    await first.start();
    await first.adapter.publishRaw(channel, event);
    await until(() => first.metrics().consumed === 1);
    await first.stop();

    // the same event arrives again while the consumer is down (a redelivery, an outbox relay that published twice, a replay)
    const publisher = rabbit();
    await publisher.connect();
    await publisher.publishRaw(channel, event);
    await publisher.publishRaw(channel, Buffer.from(serializeEnvelope(createEnvelope({ type: "t.event", version: 1, source: "svc-service", payload: { n: 2 } })))); // a marker: a different event

    // second life: a NEW process would have an empty in-memory store; the durable one remembers
    const second = runtime(rabbit(), store(), channel, (n) => handled.push(n), group);
    await second.start();
    await until(() => handled.includes(2));
    await sleep(300);
    if (durable) {
      assert.deepEqual(handled, [1, 2], "the duplicate was recognised after the restart and acknowledged without running the handler");
      assert.equal(second.metrics().duplicates, 1);
    } else {
      assert.deepEqual(handled, [1, 1, 2], "in-memory deduplication does not survive a restart: the handler ran again (handlers must be idempotent)");
      assert.equal(second.metrics().duplicates, 0);
    }
    await second.stop();
  }
});
