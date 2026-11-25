import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import {
  DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, MemoryIdempotencyStore, createEnvelope, serializeEnvelope,
  type Delivery, type DispatchAdapter, type DispatchSettings, type IdempotencyStore, type Subscription,
} from "../src/index.ts";
import { RedisIdempotencyStore, connectRedis } from "../src/redis.ts";
import { RabbitMqAdapter } from "../src/rabbitmq.ts";
import { KafkaAdapter } from "../src/kafka.ts";
// @ts-expect-error plain ESM script shared with the Java tests
import { up, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";

/**
 * Concurrent consumers and the idempotency claim (REL-01). The defect: the runtime asked the store "seen?", ran the handler and
 * recorded the id afterwards, so two instances that received the same event at the same moment both ran it (entered=2, effects=2).
 * Now the id is claimed atomically before the handler runs. What is proven here, against a real Redis:
 *   - any number of simultaneous deliveries of one event id run the handler once while the claim is held;
 *   - a claim of a consumer that died expires (nothing blocks forever) and a failed handler gives its claim back;
 *   - an owner can never complete or release a claim that is no longer its own;
 *   - a store that cannot be reached never means "not seen": the handler does not run.
 * The guarantee stays at-least-once: see the lease-expiry test for the window that remains.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 30_000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(20); } };
const rnd = () => randomBytes(4).toString("hex");

/** A transport reduced to what these tests need: deliver(body) hands one message to the subscribed runtime and records ack / nack. */
class Direct implements DispatchAdapter {
  readonly capabilities = { provider: "memory", publishAck: "test", ordering: "none", consumerGroups: true, redelivery: true, delayedRetry: false, deadLetter: true, lag: false } as unknown as DispatchAdapter["capabilities"];
  sub: Subscription | undefined; acks = 0; nacks = 0; readonly dead: string[] = [];
  async connect(): Promise<void> { /* nothing to connect */ }
  async publish(): Promise<never> { throw new Error("not used"); }
  async publishRaw(channel: string): Promise<{ id: string; channel: string; provider: string; position: string; acknowledgement: string }> { this.dead.push(channel); return { id: "x", channel, provider: "memory", position: "0", acknowledgement: "test" }; }
  async subscribe(s: Subscription): Promise<{ stop(): Promise<void> }> { this.sub = s; return { stop: async () => undefined }; }
  async health(): Promise<{ status: "up"; detail: string }> { return { status: "up", detail: "test" }; }
  async close(): Promise<void> { /* nothing */ }
  deliver(body: Buffer): Promise<void> {
    const d: Delivery = { channel: this.sub!.channel, body, headers: {}, ack: async () => { this.acks++; }, nack: async () => { this.nacks++; } };
    return this.sub!.onMessage(d);
  }
}

interface Instance { rt: DispatchRuntime; tx: Direct }
async function instance(store: IdempotencyStore | undefined, handler: () => unknown, o: Partial<DispatchSettings> = {}): Promise<Instance> {
  const registry = new EventRegistry();
  registry.add({ name: "t.event", version: 1, channel: "c" });
  const tx = new Direct();
  const rt = new DispatchRuntime({ settings: { source: "svc-service", ...DEFAULT_SETTINGS, retry: { enabled: false, maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, multiplier: 1 }, ...o }, adapter: tx, registry, ...(store ? { idempotency: store } : {}) });
  rt.registerFunction("t.event", handler, { group: "g" });
  await rt.start();
  return { rt, tx };
}
const event = (id = `evt-${rnd()}`): Buffer => Buffer.from(serializeEnvelope(createEnvelope({ type: "t.event", version: 1, source: "svc-service", payload: { n: 1 }, id })));

let env: Record<string, string> | undefined;
let skip: string | false = false;
before(async () => {
  if (process.env["PSO_TEST_REDIS_URL"]) { env = process.env as Record<string, string>; return; }
  if (!dockerAvailable()) { skip = "no Docker engine: real Redis tests not run"; return; }
  try { env = await up(); } catch (e) { skip = `brokers unavailable: ${(e as Error).message}`; }
});
const opened: Array<{ close(): unknown }> = [];
after(async () => { for (const c of opened.splice(0)) await Promise.resolve(c.close()).catch(() => undefined); });
/** every "instance" gets its OWN connection and store object, like separate processes; they share only the Redis keys */
const redisStore = (prefix: string, url = env!["PSO_TEST_REDIS_URL"]!): RedisIdempotencyStore => { const s = new RedisIdempotencyStore(url, prefix); opened.push(s); return s; };

for (const kind of ["memory", "redis"] as const) {
  test(`[${kind}] the audit's reproduction: the same event delivered to 2 and to 10 consumers at the same moment runs the handler once`, { timeout: 60_000 }, async (t) => {
    if (kind === "redis" && skip) return t.skip(skip);
    for (const n of [2, 10]) {
      const prefix = `pso:test:idem:${rnd()}:`;
      const shared = new MemoryIdempotencyStore();
      let entered = 0, effects = 0, running = 0, overlap = 0;
      const handler = async (): Promise<void> => { entered++; running++; overlap = Math.max(overlap, running); await sleep(150); effects++; running--; };
      const all: Instance[] = [];
      for (let i = 0; i < n; i++) all.push(await instance(kind === "redis" ? redisStore(prefix) : shared, handler));
      const body = event();
      await Promise.all(all.map((x) => x.tx.deliver(body)));
      assert.deepEqual({ entered, effects, overlap }, { entered: 1, effects: 1, overlap: 1 }, `${n} simultaneous deliveries: the handler ran exactly once`);
      assert.equal(all.reduce((s, x) => s + x.tx.acks, 0), n, "every delivery was acknowledged: one after handling, the others as duplicates once the first had completed");
      assert.equal(all.reduce((s, x) => s + x.rt.metrics().duplicates, 0), n - 1);
      assert.equal(all.reduce((s, x) => s + x.rt.metrics().consumed, 0), 1);
      // a later redelivery (after everything completed) is a duplicate as before
      await all[0]!.tx.deliver(body);
      assert.equal(entered, 1);
      for (const x of all) await x.rt.stop();
    }
  });

  test(`[${kind}] a failed handler gives its claim back: the dead-lettered event can be redelivered and handled (a legitimate retry is not a duplicate)`, { timeout: 60_000 }, async (t) => {
    if (kind === "redis" && skip) return t.skip(skip);
    const store = kind === "redis" ? redisStore(`pso:test:idem:${rnd()}:`) : new MemoryIdempotencyStore();
    let calls = 0, fail = true;
    const a = await instance(store, () => { calls++; if (fail) throw new Error("boom"); });
    const body = event();
    await a.tx.deliver(body);
    assert.deepEqual({ calls, dead: a.tx.dead, acks: a.tx.acks }, { calls: 1, dead: ["c.dlq"], acks: 1 }, "failed once: dead-lettered, not recorded as processed");
    fail = false;
    await a.tx.deliver(body); // the operator replays it, or the broker redelivers
    assert.equal(calls, 2, "the claim of the failed attempt was released: the event is handled now");
    await a.tx.deliver(body);
    assert.equal(calls, 2, "and only now is it a duplicate");
    assert.equal(a.rt.metrics().duplicates, 1);
    await a.rt.stop();
  });

  test(`[${kind}] a consumer that died after claiming blocks nobody past its lease; a slow handler keeps its claim alive`, { timeout: 60_000 }, async (t) => {
    if (kind === "redis" && skip) return t.skip(skip);
    const prefix = `pso:test:idem:${rnd()}:`;
    const shared = new MemoryIdempotencyStore();
    const store = (): IdempotencyStore => (kind === "redis" ? redisStore(prefix) : shared);
    // crash after claim: the claim exists, nobody renews it, nobody completes it
    const body = event("evt-crash-" + rnd());
    const id = JSON.parse(body.toString()).id as string;
    assert.equal(await store().claim!(`g:${id}`, "dead-consumer", 400), "claimed");
    let calls = 0;
    const b = await instance(store(), () => { calls++; }, { idempotencyLeaseMs: 400 });
    const started = Date.now();
    await b.tx.deliver(body);
    assert.equal(calls, 1, "handled by the surviving consumer once the dead one's lease expired");
    assert.ok(Date.now() - started >= 250 && Date.now() - started < 5000, `waited for the lease, not forever (${Date.now() - started} ms)`);
    await b.rt.stop();

    // a handler that runs for several lease periods: the claim is renewed, a second delivery never overlaps it
    let running = 0, overlap = 0, effects = 0;
    const slow = async (): Promise<void> => { running++; overlap = Math.max(overlap, running); await sleep(1300); running--; effects++; };
    const c = await instance(store(), slow, { idempotencyLeaseMs: 300 }), d = await instance(store(), slow, { idempotencyLeaseMs: 300 });
    const body2 = event();
    const first = c.tx.deliver(body2);
    await sleep(500); // well past one un-renewed lease
    await Promise.all([first, d.tx.deliver(body2)]);
    assert.deepEqual({ effects, overlap }, { effects: 1, overlap: 1 }, "the lease was renewed while the handler ran");
    assert.equal(c.rt.metrics().leaseLost, 0);
    // the second consumer waited one lease period and then either gave the delivery back (nack) or, the first having finished, saw a duplicate
    assert.equal(d.tx.acks + d.tx.nacks, 1);
    await c.rt.stop(); await d.rt.stop();
  });

  test(`[${kind}] ownership: a stale owner cannot complete or release another owner's claim; a completion record survives; retention expiry allows a replay`, { timeout: 60_000 }, async (t) => {
    if (kind === "redis" && skip) return t.skip(skip);
    const s = kind === "redis" ? redisStore(`pso:test:idem:${rnd()}:`) : new MemoryIdempotencyStore();
    assert.equal(await s.claim!("k", "A", 150), "claimed");
    assert.equal(await s.claim!("k", "A", 150), "claimed", "re-claiming one's own lease extends it");
    assert.equal(await s.claim!("k", "B", 150), "busy");
    assert.equal(await s.renew!("k", "B", 150), false, "B cannot renew A's lease");
    await sleep(250); // A's lease expires (A was too slow or died)
    assert.equal(await s.renew!("k", "A", 150), false, "an expired lease cannot be renewed");
    assert.equal(await s.claim!("k", "B", 5000), "claimed", "after expiry another owner may claim");
    assert.equal(await s.complete!("k", "A", 60_000), false, "the stale owner is told it lost the claim");
    await s.release!("k", "A");
    assert.equal(await s.claim!("k", "C", 5000), "busy", "the stale owner's release did not remove B's claim");
    assert.equal(await s.complete!("k", "B", 400), true);
    assert.equal(await s.claim!("k", "C", 5000), "done");
    assert.equal(await s.has("k"), true, "has() sees the completion record (the original contract)");
    await s.release!("k", "B");
    assert.equal(await s.claim!("k", "C", 5000), "done", "releasing after completion does not erase the record");
    await sleep(550); // the retention (400 ms here, 24 h by default) ends
    assert.equal(await s.claim!("k", "C", 5000), "claimed", "after the retention an event id is new again: a replay older than dispatch.idempotency.retention is handled");
    // compatibility: a record written by add() (earlier versions) is a completion to claim()
    await s.add("old", 60_000);
    assert.equal(await s.claim!("old", "X", 1000), "done");
  });
}

test("a handler that outlives a lease that could not be renewed is REPORTED (leaseLost): the remaining at-least-once window is visible, not silent", { timeout: 30_000 }, async () => {
  const inner = new MemoryIdempotencyStore();
  // a store whose renewals fail (a partitioned consumer): the lease of the slow handler expires and another consumer takes the event
  const partitioned: IdempotencyStore = { has: (k) => inner.has(k), add: (k, t) => inner.add(k, t), claim: (k, o, l) => inner.claim(k, o, l), renew: async () => false, complete: (k, o, t) => inner.complete(k, o, t), release: (k, o) => inner.release(k, o) };
  let effects = 0;
  const logs: string[] = [];
  const registry = new EventRegistry();
  registry.add({ name: "t.event", version: 1, channel: "c" });
  const tx = new Direct();
  const slow = new DispatchRuntime({ settings: { source: "svc-service", ...DEFAULT_SETTINGS, idempotencyLeaseMs: 150 }, adapter: tx, registry, idempotency: partitioned, log: (_l, m) => logs.push(m) });
  slow.registerFunction("t.event", async () => { await sleep(600); effects++; }, { group: "g" });
  await slow.start();
  const other = await instance(inner, () => { effects++; }, { idempotencyLeaseMs: 150 });
  const body = event();
  const p = tx.deliver(body);
  await sleep(250);
  await other.tx.deliver(body); // the lease expired un-renewed: this consumer legitimately takes the event
  await p;
  assert.equal(effects, 2, "this is the at-least-once window: a handler must be idempotent for effects outside the store");
  assert.equal(slow.metrics().leaseLost, 1, "counted");
  assert.ok(logs.some((m) => /claim had expired/.test(m)), "and logged");
  await slow.stop(); await other.rt.stop();
});

test("a store with only has()/add() (a custom store written before claims existed) keeps working with the original contract", async () => {
  const seen = new Set<string>();
  const legacy: IdempotencyStore = { has: async (k) => seen.has(k), add: async (k) => { seen.add(k); } };
  let calls = 0;
  const a = await instance(legacy, () => { calls++; });
  const body = event();
  await a.tx.deliver(body); await a.tx.deliver(body);
  assert.deepEqual({ calls, acks: a.tx.acks, duplicates: a.rt.metrics().duplicates }, { calls: 1, acks: 2, duplicates: 1 });
  await a.rt.stop();
});

test("[redis] an unreachable store never means 'not seen': the handler does not run and the message stays with the broker; after reconnection it is handled once", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  // a TCP relay in front of the real Redis: closing it is an outage of the store only, nothing else on the machine is touched
  const target = new URL(env!["PSO_TEST_REDIS_URL"]!);
  const sockets = new Set<net.Socket>();
  let up_ = true;
  const relay = net.createServer((c) => {
    if (!up_) return c.destroy();
    const u = net.connect(Number(target.port), target.hostname);
    sockets.add(c); sockets.add(u);
    c.pipe(u); u.pipe(c);
    const end = (): void => { c.destroy(); u.destroy(); sockets.delete(c); sockets.delete(u); };
    c.on("error", end); u.on("error", end); c.on("close", end); u.on("close", end);
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const url = `redis://127.0.0.1:${(relay.address() as net.AddressInfo).port}`;
  const cut = (): void => { up_ = false; for (const s of sockets) s.destroy(); };
  try {
    const store = redisStore(`pso:test:idem:${rnd()}:`, url);
    store.timeoutMs = 700;
    let calls = 0;
    const logs: string[] = [];
    const registry = new EventRegistry();
    registry.add({ name: "t.event", version: 1, channel: "c" });
    const tx = new Direct();
    const rt = new DispatchRuntime({ settings: { source: "svc-service", ...DEFAULT_SETTINGS }, adapter: tx, registry, idempotency: store, log: (_l, m) => logs.push(m) });
    rt.registerFunction("t.event", () => { calls++; }, { group: "g" });
    await rt.start();
    const first = event();
    await tx.deliver(first);
    assert.deepEqual({ calls, acks: tx.acks }, { calls: 1, acks: 1 });

    cut();
    const second = event();
    await tx.deliver(second);
    assert.deepEqual({ calls, acks: tx.acks, nacks: tx.nacks }, { calls: 1, acks: 1, nacks: 1 }, "store down: not handled, not acknowledged, given back to the broker");
    assert.ok(logs.some((m) => /idempotency store unavailable/.test(m)), "and it is logged as an error");
    await tx.deliver(first);
    assert.equal(calls, 1, "a duplicate is not handled 'just in case' either");

    up_ = true; // Redis is back: the client reconnects on its own
    await until(async () => { await tx.deliver(second); return calls === 2; }, 30_000);
    await tx.deliver(second); await tx.deliver(first);
    assert.equal(calls, 2, "each event handled exactly once across the outage");
    await rt.stop();
  } finally { cut(); await new Promise<void>((r) => relay.close(() => r())); }
});

test("[redis] consumer restart: a new process (new store object, new connection) recognises what the old one completed", { timeout: 30_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const prefix = `pso:test:idem:${rnd()}:`;
  let calls = 0;
  const body = event();
  const a = await instance(redisStore(prefix), () => { calls++; });
  await a.tx.deliver(body);
  await a.rt.stop();
  const b = await instance(redisStore(prefix), () => { calls++; });
  await b.tx.deliver(body);
  assert.deepEqual({ calls, duplicates: b.rt.metrics().duplicates }, { calls: 1, duplicates: 1 });
  await b.rt.stop();
  // the keys really are leases / records with an expiry: nothing is left without a TTL
  const r = await connectRedis(env!["PSO_TEST_REDIS_URL"]!);
  opened.push({ close: () => r.disconnect() });
  const keys = (await r.keys(prefix + "*")) as string[];
  assert.equal(keys.length, 1);
  assert.ok((await r.pttl(keys[0])) > 0, "the completion record expires with the retention");
});

for (const provider of ["rabbitmq", "kafka"] as const) {
  test(`[${provider}] real broker: one event id published twice to two consumer instances with a shared Redis store runs the handler once`, { timeout: 180_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const channel = `idem-${provider}-${rnd()}`, group = `g-${rnd()}`, prefix = `pso:test:idem:${rnd()}:`;
    const adapter = (): DispatchAdapter => { const a = provider === "rabbitmq" ? new RabbitMqAdapter({ url: env!["PSO_TEST_RABBITMQ_URL"]!, exchangePrefix: "pso.test." }) : new KafkaAdapter({ brokers: [env!["PSO_TEST_KAFKA_BROKERS"]!], clientId: `pso-test-${rnd()}`, topicCreation: "auto", partitions: 2, replicationFactor: 1, ssl: false }); opened.push(a); return a; };
    let entered = 0, running = 0, overlap = 0;
    const markers = new Set<number>();
    const make = async (): Promise<DispatchRuntime> => {
      const registry = new EventRegistry();
      registry.add({ name: "t.event", version: 1, channel });
      const rt = new DispatchRuntime({ settings: { source: "svc-service", ...DEFAULT_SETTINGS, shutdownTimeoutMs: 5000 }, adapter: adapter(), registry, idempotency: redisStore(prefix) });
      rt.registerFunction("t.event", async (p) => { const n = (p as { n: number }).n; if (n !== 1) { markers.add(n); return; } entered++; running++; overlap = Math.max(overlap, running); await sleep(400); running--; }, { group });
      await rt.start();
      return rt;
    };
    const a = await make(), b = await make();
    if (provider === "kafka") await sleep(6000); // both members joined the group and own a partition
    const dup = event();
    // the same event id twice, without a key: RabbitMQ hands one copy to each consumer at once; Kafka may put them on different partitions
    await a.adapter.publishRaw(channel, dup); await a.adapter.publishRaw(channel, dup);
    for (const n of [2, 3]) await a.adapter.publishRaw(channel, Buffer.from(serializeEnvelope(createEnvelope({ type: "t.event", version: 1, source: "svc-service", payload: { n } }))));
    await until(() => markers.size === 2 && a.metrics().consumed + b.metrics().consumed === 3 && a.metrics().duplicates + b.metrics().duplicates === 1, 90_000);
    await sleep(500);
    assert.deepEqual({ entered, overlap }, { entered: 1, overlap: 1 }, "the duplicated event ran once");
    assert.equal(a.metrics().duplicates + b.metrics().duplicates, 1);
    await a.stop(); await b.stop();
  });
}
