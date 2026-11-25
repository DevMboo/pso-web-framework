import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, SIGNATURE_HEADER, signMessage, verifyMessage, loadTrustKeys, loadDispatchConfig, describeDispatchConfig, DispatchConfigError,
  type ConsumeContext, type DispatchAdapter, type DispatchTrust, type TrustMode,
} from "../src/index.ts";
import { MemoryAdapter } from "../src/testing.ts";
import { RedisStreamsAdapter } from "../src/redis.ts";
import { RabbitMqAdapter } from "../src/rabbitmq.ts";
import { KafkaAdapter } from "../src/kafka.ts";
// @ts-expect-error plain ESM script shared with the Java tests
import { up, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";

/**
 * Trusted service identity for Dispatch: the envelope's `source` is a claim; a signature made with that service's key is the proof.
 * The contract tests use the in-memory adapter; the last test sends signed, unsigned and forged messages through real Redis, RabbitMQ
 * and Kafka, because the signature travels in transport headers and every transport carries headers differently.
 */
const K = { billing: "billing-key-".padEnd(40, "b"), users: "users-key-".padEnd(40, "u"), rogue: "rogue-key-".padEnd(40, "r"), billingOld: "billing-old-".padEnd(40, "o") };
const CHANNEL = "billing.events";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(10); } };
const trust = (mode: TrustMode, keys: Record<string, string[]>, signingKey?: string): DispatchTrust => ({ mode, keys: new Map(Object.entries(keys)), ...(signingKey ? { signingKey } : {}) });

function service(adapter: DispatchAdapter, source: string, t?: DispatchTrust, channel = CHANNEL) {
  const registry = new EventRegistry();
  registry.add({ name: "billing.invoice-paid", version: 1, channel, schema: { type: "object", required: ["invoice"], properties: { invoice: { type: "string" }, amount: { type: "integer" } } } });
  const logs: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const rt = new DispatchRuntime({ settings: { source, ...DEFAULT_SETTINGS, retry: { enabled: true, maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 1 }, shutdownTimeoutMs: 3000, ...(t ? { trust: t } : {}) }, adapter, registry, sleep: async () => undefined, log: (_l, msg, fields) => { logs.push({ msg, fields }); } });
  const seen: Array<{ invoice: string; claimed: string; verified: string | undefined }> = [];
  const consume = (group: string): void => rt.registerFunction("billing.invoice-paid", (p, c: ConsumeContext) => { seen.push({ invoice: (p as { invoice: string }).invoice, claimed: c.envelope.source, verified: c.verifiedSource }); }, { group });
  return { rt, seen, logs, consume };
}
const dlqReasons = (a: MemoryAdapter, channel = CHANNEL): string[] => (a.log.get(`${channel}.dlq`) ?? []).map((m) => m.headers["x-pso-reason"]!);

test("the signature: covers the channel and the exact bytes, verifies only with the claimed source's key, and is constant-length", () => {
  const body = Buffer.from('{"envelopeVersion":1,"id":"a"}');
  const sig = signMessage(K.billing, CHANNEL, body);
  assert.match(sig, /^v1=[A-Za-z0-9_-]{43}$/);
  const t = trust("required", { "billing-service": [K.billing], "users-service": [K.users] });
  assert.equal(verifyMessage(t, CHANNEL, body, sig, "billing-service"), "verified");
  assert.equal(verifyMessage(t, CHANNEL, body, sig, "users-service"), "invalid", "billing's signature does not prove users-service sent it");
  assert.equal(verifyMessage(t, "other.events", body, sig, "billing-service"), "invalid", "a message moved to another channel no longer verifies");
  assert.equal(verifyMessage(t, CHANNEL, Buffer.from('{"envelopeVersion":1,"id":"b"}'), sig, "billing-service"), "invalid", "any change to the bytes invalidates it");
  assert.equal(verifyMessage(t, CHANNEL, body, undefined, "billing-service"), "unsigned");
  assert.equal(verifyMessage(t, CHANNEL, body, "", "billing-service"), "unsigned");
  assert.equal(verifyMessage(t, CHANNEL, body, sig, "payments-service"), "unknown-source", "no key is held for that service");
  for (const bad of ["v2=" + sig.slice(3), sig.slice(3), "v1=", "v1=AAAA", "v1=" + "A".repeat(400), sig + "x", "v1=!!!not-base64!!!"]) assert.equal(verifyMessage(t, CHANNEL, body, bad, "billing-service"), "invalid", bad.slice(0, 20));
  assert.equal(verifyMessage(trust("required", { "billing-service": [K.billingOld, K.billing] }), CHANNEL, body, sig, "billing-service"), "verified", "several keys per source: rotation");
});

test("signature fixtures shared with Java: both runtimes produce and accept exactly the same signatures", () => {
  const fx = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures/contracts/dispatch", "signatures.json"), "utf8")) as { header: string; cases: Array<{ name: string; key: string; channel: string; body: string; signature: string }> };
  assert.equal(fx.header, SIGNATURE_HEADER);
  assert.ok(fx.cases.length >= 5);
  for (const c of fx.cases) {
    assert.equal(signMessage(c.key, c.channel, Buffer.from(c.body, "utf8")), c.signature, c.name);
    assert.equal(verifyMessage(trust("required", { "some-service": [c.key] }), c.channel, Buffer.from(c.body, "utf8"), c.signature, "some-service"), "verified", c.name);
  }
});

test("authorized publication: a signed message is consumed and the handler learns WHO was verified", async () => {
  const bus = new MemoryAdapter();
  const billing = service(bus, "billing-service", trust("off", {}, K.billing));
  const orders = service(bus, "orders-service", trust("required", { "billing-service": [K.billing] }));
  orders.consume("orders");
  await billing.rt.start(); await orders.rt.start();
  await billing.rt.publish("billing.invoice-paid", { invoice: "inv-1", amount: 10 });
  await until(() => orders.seen.length === 1);
  assert.deepEqual(orders.seen, [{ invoice: "inv-1", claimed: "billing-service", verified: "billing-service" }]);
  assert.match(bus.log.get(CHANNEL)![0]!.headers[SIGNATURE_HEADER]!, /^v1=/);
  assert.deepEqual([orders.rt.metrics().consumed, orders.rt.metrics().untrusted, orders.rt.metrics().unverified], [1, 0, 0]);
  await billing.rt.stop(); await orders.rt.stop();
});

test("forged source metadata: a service that signs with ITS key but claims another service's name is refused, unprocessed", async () => {
  const bus = new MemoryAdapter();
  // the consumer trusts both services, each with its own key
  const orders = service(bus, "orders-service", trust("required", { "billing-service": [K.billing], "rogue-service": [K.rogue] }));
  orders.consume("orders");
  // rogue-service holds only its own key and writes "billing-service" into the envelope
  const forger = service(bus, "billing-service", trust("off", {}, K.rogue));
  const honest = service(bus, "rogue-service", trust("off", {}, K.rogue));
  await orders.rt.start(); await forger.rt.start(); await honest.rt.start();
  await forger.rt.publish("billing.invoice-paid", { invoice: "forged", amount: 1_000_000 });
  await honest.rt.publish("billing.invoice-paid", { invoice: "honest", amount: 1 });
  await until(() => orders.seen.length === 1 && dlqReasons(bus).length === 1);
  assert.deepEqual(orders.seen, [{ invoice: "honest", claimed: "rogue-service", verified: "rogue-service" }], "the same key is perfectly valid for the name it belongs to: the consumer can now authorize on a real identity");
  assert.deepEqual(dlqReasons(bus), ["PSO_DISPATCH_UNTRUSTED:invalid"]);
  assert.deepEqual([orders.rt.metrics().untrusted, orders.rt.metrics().poison, orders.rt.metrics().retried], [1, 1, 0], "refused once, never retried");
  const warned = orders.logs.find((l) => /publisher is not authenticated/.test(l.msg))!;
  assert.deepEqual([warned.fields!["claimedSource"], warned.fields!["reason"]], ["billing-service", "invalid"]);
  assert.ok(!JSON.stringify(orders.logs).includes("1000000") && !JSON.stringify(orders.logs).includes("forged"), "the payload is never logged");
  await orders.rt.stop(); await forger.rt.stop(); await honest.rt.stop();
});

test("missing and invalid identity under required mode: unsigned, unknown source, tampered payload, replay on another channel", async () => {
  const bus = new MemoryAdapter();
  const orders = service(bus, "orders-service", trust("required", { "billing-service": [K.billing] }));
  orders.consume("orders");
  await orders.rt.start();
  const unsigned = service(bus, "billing-service");                                  // a publisher that has no key at all
  const stranger = service(bus, "payments-service", trust("off", {}, K.users));      // signed, but nobody gave us its key
  const billing = service(bus, "billing-service", trust("off", {}, K.billing));
  for (const s of [unsigned, stranger, billing]) await s.rt.start();
  await unsigned.rt.publish("billing.invoice-paid", { invoice: "unsigned" });
  await stranger.rt.publish("billing.invoice-paid", { invoice: "stranger" });
  await billing.rt.publish("billing.invoice-paid", { invoice: "good", amount: 5 });
  await until(() => orders.seen.length === 1 && dlqReasons(bus).length === 2);
  // tampering: the genuine message's signature attached to modified content
  const genuine = bus.log.get(CHANNEL)!.at(-1)!;
  await bus.publishRaw(CHANNEL, Buffer.from(genuine.body.toString().replace('"amount":5', '"amount":5000000').replace(/"id":"[^"]+"/, `"id":"${randomBytes(8).toString("hex")}"`)), { headers: { ...genuine.headers } });
  await bus.publishRaw(CHANNEL, genuine.body, { headers: { [SIGNATURE_HEADER]: "v1=not-a-signature" } });
  await until(() => dlqReasons(bus).length === 4);
  assert.deepEqual(orders.seen.map((s) => s.invoice), ["good"], "only the authentic message was handled");
  assert.deepEqual(dlqReasons(bus), ["PSO_DISPATCH_UNTRUSTED:unsigned", "PSO_DISPATCH_UNTRUSTED:unknown-source", "PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:invalid"]);
  assert.equal(orders.rt.metrics().untrusted, 4);
  // a replay on another channel: same bytes, same signature, different channel
  const other = "audit.events";
  const auditor = service(bus, "audit-service", trust("required", { "billing-service": [K.billing] }), other);
  auditor.consume("audit");
  await auditor.rt.start();
  await bus.publishRaw(other, genuine.body, { headers: { ...genuine.headers } });
  await until(() => dlqReasons(bus, other).length === 1);
  assert.deepEqual([auditor.seen.length, dlqReasons(bus, other)], [0, ["PSO_DISPATCH_UNTRUSTED:invalid"]]);
  for (const s of [orders, unsigned, stranger, billing, auditor]) await s.rt.stop();
});

test("compatibility: existing deployments are untouched (off), and permissive mode migrates without dropping legitimate traffic", async () => {
  // off (the default): nothing is signed, nothing is checked, no header appears, the context is what it always was
  const legacyBus = new MemoryAdapter();
  const pub = service(legacyBus, "billing-service"), sub = service(legacyBus, "orders-service");
  sub.consume("orders");
  await pub.rt.start(); await sub.rt.start();
  await pub.rt.publish("billing.invoice-paid", { invoice: "legacy" });
  await until(() => sub.seen.length === 1);
  assert.deepEqual(sub.seen, [{ invoice: "legacy", claimed: "billing-service", verified: undefined }]);
  assert.deepEqual(legacyBus.log.get(CHANNEL)![0]!.headers, {}, "no header is added when no key is configured");
  // a signing publisher with a consumer that does not verify (an old consumer, or mode off): the header is simply ignored
  const signing = service(legacyBus, "billing-service", trust("off", {}, K.billing));
  await signing.rt.start();
  await signing.rt.publish("billing.invoice-paid", { invoice: "signed-for-nobody" });
  await until(() => sub.seen.length === 2);
  for (const s of [pub, sub, signing]) await s.rt.stop();

  // permissive: signed-and-valid is verified, unsigned is still handled (and counted), a WRONG signature is refused
  const bus = new MemoryAdapter();
  const orders = service(bus, "orders-service", trust("permissive", { "billing-service": [K.billing] }));
  orders.consume("orders");
  const oldPublisher = service(bus, "billing-service"), newPublisher = service(bus, "billing-service", trust("off", {}, K.billing)), forger = service(bus, "billing-service", trust("off", {}, K.rogue));
  for (const s of [orders, oldPublisher, newPublisher, forger]) await s.rt.start();
  await oldPublisher.rt.publish("billing.invoice-paid", { invoice: "not-yet-upgraded" });
  await newPublisher.rt.publish("billing.invoice-paid", { invoice: "upgraded" });
  await forger.rt.publish("billing.invoice-paid", { invoice: "forged" });
  await until(() => orders.seen.length === 2 && dlqReasons(bus).length === 1);
  assert.deepEqual(orders.seen, [{ invoice: "not-yet-upgraded", claimed: "billing-service", verified: undefined }, { invoice: "upgraded", claimed: "billing-service", verified: "billing-service" }]);
  assert.deepEqual([orders.rt.metrics().unverified, orders.rt.metrics().untrusted], [1, 1], "unverified is the migration counter: required mode is safe once it stays at zero");
  for (const s of [orders, oldPublisher, newPublisher, forger]) await s.rt.stop();
});

test("a service consumes its own events and rotates keys without losing messages", async () => {
  const bus = new MemoryAdapter();
  const keys = loadTrustKeys({ PSO_DISPATCH_SIGNING_KEY: K.billing, PSO_DISPATCH_TRUST_KEY_BILLING_SERVICE: K.billingOld }, "billing-service", []);
  assert.deepEqual(keys.keys.get("billing-service"), [K.billing, K.billingOld], "its own signing key always verifies its own messages; the previous key is still accepted");
  const self = service(bus, "billing-service", { mode: "required", ...keys });
  self.consume("billing");
  const stillOld = service(bus, "billing-service", trust("off", {}, K.billingOld)); // an instance not yet restarted with the new key
  await self.rt.start(); await stillOld.rt.start();
  await self.rt.publish("billing.invoice-paid", { invoice: "new-key" });
  await stillOld.rt.publish("billing.invoice-paid", { invoice: "old-key" });
  await until(() => self.seen.length === 2);
  assert.deepEqual(self.seen.map((s) => [s.invoice, s.verified]), [["new-key", "billing-service"], ["old-key", "billing-service"]]);
  await self.rt.stop(); await stillOld.rt.stop();
});

test("configuration: mode from the configuration system, keys from the environment only; weak keys are refused; nothing prints a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-trust-"));
  try {
    writeFileSync(join(dir, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, provider: "redis", redis: { url: "redis://cache:6379" }, trust: { mode: "required" } } }));
    const cfg = loadDispatchConfig({ projectDir: dir, source: "orders-service", env: { PSO_DISPATCH_SIGNING_KEY: K.users, PSO_DISPATCH_TRUST_KEY_BILLING_SERVICE: `${K.billing},${K.billingOld}`, PSO_DISPATCH_TRUST_KEY_USERS: K.users } });
    assert.equal(cfg.settings.trust?.mode, "required");
    assert.equal(cfg.settings.trust?.signingKey, K.users);
    assert.deepEqual([...cfg.settings.trust!.keys.keys()].sort(), ["billing-service", "orders-service", "users"]);
    assert.deepEqual(cfg.settings.trust!.keys.get("billing-service"), [K.billing, K.billingOld]);
    const printed = JSON.stringify(describeDispatchConfig(cfg));
    assert.deepEqual((describeDispatchConfig(cfg) as { trust: unknown }).trust, { mode: "required", signing: true, verifiedSources: ["billing-service", "orders-service", "users"] });
    for (const k of Object.values(K)) assert.ok(!printed.includes(k), "no key in the printable description");

    // the variable overrides the file; an unknown mode is refused
    assert.equal(loadDispatchConfig({ projectDir: dir, source: "orders-service", env: { PSO_DISPATCH_TRUST_MODE: "permissive" } }).settings.trust?.mode, "permissive");
    const issues = (env: Record<string, string>): string => { try { loadDispatchConfig({ projectDir: dir, source: "orders-service", env }); return ""; } catch (e) { assert.ok(e instanceof DispatchConfigError); return e.message; } };
    assert.match(issues({ PSO_DISPATCH_TRUST_MODE: "strictest" }), /"dispatch\.trust\.mode" must be one of off, permissive, required/); // refused by the typed schema before anything else
    const weak = issues({ PSO_DISPATCH_SIGNING_KEY: "too-short-key", PSO_DISPATCH_TRUST_KEY_BILLING_SERVICE: "also-short" });
    assert.match(weak, /PSO_DISPATCH_SIGNING_KEY must be at least 32 characters/);
    assert.match(weak, /PSO_DISPATCH_TRUST_KEY_BILLING_SERVICE must be at least 32 characters/);
    assert.ok(!weak.includes("too-short-key") && !weak.includes("also-short"), "a rejected key is not echoed");

    // nothing configured: no trust object at all, exactly the previous settings
    writeFileSync(join(dir, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, provider: "redis", redis: { url: "redis://cache:6379" } } }));
    assert.equal(loadDispatchConfig({ projectDir: dir, source: "orders-service", env: {} }).settings.trust, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------------ real brokers
let env: Record<string, string> | undefined;
let skip: string | false = false;
before(async () => {
  if (process.env["PSO_TEST_REDIS_URL"]) { env = process.env as Record<string, string>; return; }
  if (!dockerAvailable()) { skip = "no Docker engine: real broker tests not run"; return; }
  try { env = await up(); } catch (e) { skip = `brokers unavailable: ${(e as Error).message}`; }
});
const opened: DispatchAdapter[] = [];
after(async () => { for (const a of opened.splice(0)) await a.close().catch(() => undefined); });
const rnd = () => randomBytes(4).toString("hex");
function adapterFor(p: "redis" | "rabbitmq" | "kafka"): DispatchAdapter {
  const e = env!;
  const a = p === "redis" ? new RedisStreamsAdapter({ url: e["PSO_TEST_REDIS_URL"]!, maxLength: 10000, minIdleMs: 60_000, blockMs: 300, streamCreation: "auto" })
    : p === "rabbitmq" ? new RabbitMqAdapter({ url: e["PSO_TEST_RABBITMQ_URL"]!, exchangePrefix: "pso.test." })
      : new KafkaAdapter({ brokers: [e["PSO_TEST_KAFKA_BROKERS"]!], clientId: `pso-trust-${rnd()}`, topicCreation: "auto", partitions: 1, replicationFactor: 1, ssl: false });
  opened.push(a);
  return a;
}

for (const p of ["redis", "rabbitmq", "kafka"] as const) {
  test(`[${p}] the signature survives the real transport: signed is verified, unsigned and forged are dead-lettered with the reason`, { timeout: 180_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const channel = `trust-${p}-${rnd()}`;
    const consumer = service(adapterFor(p), "orders-service", trust("required", { "billing-service": [K.billing] }), channel);
    consumer.consume(`g-${rnd()}`);
    // a second, non-verifying group reads the dead letters back from the broker
    const dead: Array<Record<string, string>> = [];
    const dlqAdapter = adapterFor(p);
    await dlqAdapter.connect();
    await consumer.rt.start(); // declares the topology (and the dead-letter destination) before anything is published
    const handle = await dlqAdapter.subscribe({ channel: `${channel}.dlq`, group: `dlq-${rnd()}`, concurrency: 1, batchSize: 10, onMessage: async (d) => { dead.push(d.headers); await d.ack(); } });
    const billing = service(adapterFor(p), "billing-service", trust("off", {}, K.billing), channel);
    const unsigned = service(adapterFor(p), "billing-service", undefined, channel);
    const forger = service(adapterFor(p), "billing-service", trust("off", {}, K.rogue), channel);
    for (const s of [billing, unsigned, forger]) await s.rt.start();
    await unsigned.rt.publish("billing.invoice-paid", { invoice: "unsigned" });
    await forger.rt.publish("billing.invoice-paid", { invoice: "forged" });
    await billing.rt.publish("billing.invoice-paid", { invoice: "authentic", amount: 7 });
    await until(() => consumer.seen.length === 1 && dead.length === 2, 60_000);
    await sleep(300);
    assert.deepEqual(consumer.seen, [{ invoice: "authentic", claimed: "billing-service", verified: "billing-service" }]);
    assert.deepEqual(dead.map((h) => h["x-pso-reason"]).sort(), ["PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:unsigned"]);
    assert.deepEqual([consumer.rt.metrics().consumed, consumer.rt.metrics().untrusted], [1, 2]);
    await handle.stop(3000);
    for (const s of [consumer, billing, unsigned, forger]) await s.rt.stop();
  });
}
