import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope, compatibilityProblems, defineEvents, DispatchConsumer, DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, envelopeProblems, loadDispatchConfig, MemoryIdempotencyStore, parseEnvelope, schemaProblems, serializeEnvelope, startDispatch, validate, DispatchConfigError, DispatchError } from "../src/index.ts";
import { MemoryAdapter } from "../src/testing.ts";

const fixtures = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures/contracts/dispatch", n), "utf8"));

test("envelope fixtures shared with Java: valid ones serialize to exactly the canonical bytes, invalid ones are rejected", () => {
  const fx = fixtures("envelopes.json");
  for (const v of fx.valid) {
    assert.deepEqual(envelopeProblems(v.envelope), [], v.name);
    assert.equal(serializeEnvelope(v.envelope), v.canonical, v.name);
    assert.deepEqual(parseEnvelope(v.canonical), v.envelope, `${v.name}: parse round trip`);
  }
  for (const i of fx.invalid) assert.ok(envelopeProblems(i.envelope).length > 0, i.name);
});

test("envelope limits: size, nesting, prototype pollution and unknown fields", () => {
  const e = createEnvelope({ type: "users.created", version: 1, source: "users-service", payload: { a: 1 } });
  assert.throws(() => parseEnvelope(serializeEnvelope(e), 10), (x: DispatchError) => x.code === "PSO_DISPATCH_ENVELOPE_TOO_LARGE");
  assert.throws(() => serializeEnvelope({ ...e, payload: "x".repeat(1_100_000) }), (x: DispatchError) => x.code === "PSO_DISPATCH_ENVELOPE_TOO_LARGE");
  let deep: unknown = 1; for (let i = 0; i < 40; i++) deep = { d: deep };
  assert.ok(envelopeProblems({ ...e, payload: deep }).some((p) => /deeply/.test(p)));
  assert.throws(() => parseEnvelope("{not json"), (x: DispatchError) => x.code === "PSO_DISPATCH_ENVELOPE_INVALID");
  const polluted = parseEnvelope(JSON.stringify({ ...e, payload: JSON.parse('{"__proto__":{"admin":true},"ok":1}') }).replace('"payload":{', '"payload":{"__proto__":{"admin":true},'));
  assert.equal(({} as Record<string, unknown>)["admin"], undefined);
  assert.equal((polluted.payload as Record<string, unknown>)["admin"], undefined);
  assert.equal(e.occurredAt.endsWith("Z"), true);
});

test("schema language: shared cases, unsupported keywords are rejected, compatibility semantics", () => {
  const fx = fixtures("schema-cases.json");
  assert.deepEqual(schemaProblems(fx.schema), []);
  for (const c of fx.cases) assert.equal(validate(fx.schema, c.value).length === 0, c.valid, JSON.stringify(c.value));
  assert.ok(schemaProblems({ type: "object", oneOf: [] }).some((p) => /unsupported keyword "oneOf"/.test(p)));
  assert.ok(schemaProblems({ type: "thing" }).length > 0);
  const v1 = { type: "object", required: ["id"], properties: { id: { type: "string" } } } as const;
  const addOptional = { type: "object", required: ["id"], properties: { id: { type: "string" }, name: { type: "string" } } } as const;
  const addRequired = { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } } as const;
  assert.deepEqual(compatibilityProblems(v1, addOptional, "full"), [], "adding an optional property is fully compatible");
  assert.ok(compatibilityProblems(v1, addRequired, "backward").some((p) => /name is required by the reader/.test(p)), "new required property breaks backward compatibility");
  assert.deepEqual(compatibilityProblems(v1, addRequired, "forward"), [], "but old consumers still read new data (forward)");
  assert.ok(compatibilityProblems(addOptional, v1, "backward").length === 0 && compatibilityProblems(v1, { ...v1, additionalProperties: false } as never, "forward").some((p) => /forbids unknown/.test(p)) === false);
  assert.ok(compatibilityProblems({ type: "object", properties: { n: { type: "string" } } }, { type: "object", properties: { n: { type: "integer" } } }, "backward").some((p) => /type/.test(p)));
  assert.deepEqual(compatibilityProblems(v1, addRequired, "none"), []);
});

test("defineEvents: explicit declarations, duplicates, versions, undecorated consumers", () => {
  class Ok { handle(_p: unknown) { return undefined; } }
  DispatchConsumer("users.created")(Ok as never); // decorators are applied by call: node runs this file without a TypeScript compiler
  class Plain { handle(_p: unknown) { return undefined; } }
  const def = defineEvents({ events: [{ name: "users.created", version: 2, channel: "users.events", accepts: [1], compatibility: "full" }], consumers: [Ok as never] });
  assert.equal(def.events[0]!.channel, "users.events");
  assert.throws(() => defineEvents({ events: [{ name: "Users.Created", version: 1, channel: "c" }] }), /invalid name/);
  assert.throws(() => defineEvents({ events: [{ name: "a.b", version: 1, channel: "c" }, { name: "a.b", version: 1, channel: "c" }] }), /declared twice/);
  assert.throws(() => defineEvents({ events: [{ name: "a.b", version: 1, channel: "c" }, { name: "a.b", version: 2, channel: "d" }] }), /two channels/);
  assert.throws(() => defineEvents({ events: [{ name: "a.b", version: 1, channel: "c", accepts: [1] }] }), /accepts must list older versions/);
  assert.throws(() => defineEvents({ events: [{ name: "a.b", version: 1, channel: "c" }], consumers: [Plain as never] }), /not decorated/);
  assert.throws(() => defineEvents({ events: [{ name: "a.b", version: 1, channel: "c" }], consumers: [Ok as never] }), /does not declare/);
  assert.throws(() => defineEvents({ events: [{ name: "a.b", version: 1, channel: "c", schema: { type: "object", $ref: "x" } as never }] }), /unsupported keyword/);
});

// ---------------------------------------------------------------- runtime with the in-memory adapter (a contract test, not a broker test)

const settings = (o: Partial<typeof DEFAULT_SETTINGS> = {}) => ({ source: "users-service", ...DEFAULT_SETTINGS, retry: { enabled: true, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4, multiplier: 2 }, ...o });
async function runtime(o: { events?: Array<Parameters<EventRegistry["add"]>[0]>; settings?: ReturnType<typeof settings> } = {}) {
  const registry = new EventRegistry();
  for (const e of o.events ?? [{ name: "users.created", version: 1, channel: "users.events", schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } } }]) registry.add(e);
  const adapter = new MemoryAdapter();
  const rt = new DispatchRuntime({ settings: o.settings ?? settings(), adapter, registry, sleep: async () => undefined });
  return { rt, adapter, registry };
}
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

test("publish validates the contract: undeclared, consume-only and schema-violating events never reach the transport", async () => {
  const { rt, adapter } = await runtime({ events: [{ name: "users.created", version: 1, channel: "users.events", schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } } }, { name: "orders.paid", version: 1, channel: "orders.events", publish: false }] });
  await rt.start();
  await assert.rejects(rt.publish("nope.event", {}), (e: DispatchError) => e.code === "PSO_DISPATCH_UNKNOWN_EVENT");
  await assert.rejects(rt.publish("orders.paid", {}), (e: DispatchError) => e.code === "PSO_DISPATCH_NOT_PUBLISHER");
  await assert.rejects(rt.publish("users.created", { userId: 5 }), (e: DispatchError) => e.code === "PSO_DISPATCH_SCHEMA");
  assert.equal(adapter.log.size, 0);
  const r = await rt.publish("users.created", { userId: "1" }, { correlationId: "corr-1" });
  assert.equal(r.provider, "memory");
  assert.match(r.acknowledgement, /not durable/);
  const sent = parseEnvelope(adapter.log.get("users.events")![0]!.body);
  assert.deepEqual([sent.type, sent.version, sent.source, sent.correlationId], ["users.created", 1, "users-service", "corr-1"]);
  assert.equal(rt.metrics().published, 1);
  await rt.stop();
});

test("consume: handler success acknowledges; the handler gets the typed payload and context", async () => {
  const { rt } = await runtime();
  const seen: unknown[] = [];
  rt.registerFunction("users.created", (p, c) => { seen.push([p, c.attempt, c.group, c.envelope.source]); });
  await rt.start();
  await rt.publish("users.created", { userId: "42" });
  await until(() => seen.length === 1);
  assert.deepEqual(seen[0], [{ userId: "42" }, 1, "users-service", "users-service"]);
  assert.equal(rt.metrics().consumed, 1);
  await rt.stop();
});

test("retry: a failing handler is retried with backoff up to maxAttempts, then succeeds", async () => {
  const { rt } = await runtime();
  let calls = 0;
  rt.registerFunction("users.created", () => { calls++; if (calls < 3) throw new Error("boom"); });
  await rt.start();
  await rt.publish("users.created", { userId: "1" });
  await until(() => rt.metrics().consumed === 1);
  assert.equal(calls, 3);
  assert.equal(rt.metrics().retried, 2);
  assert.equal(rt.metrics().deadLettered, 0);
  await rt.stop();
});

test("dead letter: after maxAttempts the message goes to <channel>.dlq with the reason, and is then acknowledged", async () => {
  const { rt, adapter } = await runtime();
  let calls = 0;
  rt.registerFunction("users.created", () => { calls++; throw new Error("always"); });
  await rt.start();
  await rt.publish("users.created", { userId: "1" });
  await until(() => rt.metrics().deadLettered === 1);
  assert.equal(calls, 3);
  const dlq = adapter.log.get("users.events.dlq")!;
  assert.equal(dlq.length, 1);
  assert.match(dlq[0]!.headers["x-pso-reason"]!, /handler-failed:Error/);
  assert.equal(dlq[0]!.headers["x-pso-attempts"], "3");
  assert.equal(parseEnvelope(dlq[0]!.body).payload && (parseEnvelope(dlq[0]!.body).payload as { userId: string }).userId, "1", "the original message is preserved");
  await rt.stop();
});

test("poison messages: invalid envelopes, unsupported versions and schema violations are dead-lettered without running the handler", async () => {
  const { rt, adapter } = await runtime();
  let calls = 0;
  rt.registerFunction("users.created", () => { calls++; });
  await rt.start();
  await adapter.publishRaw("users.events", Buffer.from("garbage"));
  await adapter.publishRaw("users.events", Buffer.from(serializeEnvelope(createEnvelope({ type: "users.created", version: 9, source: "x-service", payload: { userId: "1" } }))));
  await adapter.publishRaw("users.events", Buffer.from(serializeEnvelope(createEnvelope({ type: "users.created", version: 1, source: "x-service", payload: { userId: 7 } }))));
  await until(() => rt.metrics().deadLettered === 3);
  assert.equal(calls, 0);
  assert.equal(rt.metrics().poison, 3);
  assert.deepEqual(adapter.log.get("users.events.dlq")!.map((m) => m.headers["x-pso-reason"]).sort(), ["PSO_DISPATCH_ENVELOPE_INVALID", "PSO_DISPATCH_SCHEMA", "PSO_DISPATCH_UNSUPPORTED_VERSION"]);
  await rt.stop();
});

test("older accepted versions are consumed; types handled by another consumer of the channel are skipped", async () => {
  const { rt, adapter } = await runtime({ events: [{ name: "users.created", version: 2, accepts: [1], channel: "users.events" }, { name: "users.deleted", version: 1, channel: "users.events" }] });
  const got: unknown[] = [];
  rt.registerFunction("users.created", (p) => { got.push(p); });
  await rt.start();
  await adapter.publishRaw("users.events", Buffer.from(serializeEnvelope(createEnvelope({ type: "users.created", version: 1, source: "x-service", payload: { old: true } }))));
  await adapter.publishRaw("users.events", Buffer.from(serializeEnvelope(createEnvelope({ type: "users.deleted", version: 1, source: "x-service", payload: {} }))));
  await until(() => got.length === 1);
  assert.deepEqual(got, [{ old: true }]);
  assert.equal(rt.metrics().deadLettered, 0);
  await rt.stop();
});

test("idempotency: the same event id is processed once per group (and again after the retention expires)", async () => {
  const registry = new EventRegistry(); registry.add({ name: "users.created", version: 1, channel: "users.events" });
  let clock = 0;
  const rt = new DispatchRuntime({ settings: settings(), adapter: new MemoryAdapter(), registry, idempotency: new MemoryIdempotencyStore(100, () => clock), sleep: async () => undefined });
  let calls = 0;
  rt.registerFunction("users.created", () => { calls++; });
  await rt.start();
  await rt.publish("users.created", { n: 1 }, { id: "evt-1" });
  await rt.publish("users.created", { n: 1 }, { id: "evt-1" });
  await until(() => rt.metrics().consumed + rt.metrics().duplicates === 2);
  assert.equal(calls, 1);
  assert.equal(rt.metrics().duplicates, 1);
  clock += 25 * 3600_000;
  await rt.publish("users.created", { n: 1 }, { id: "evt-1" });
  await until(() => calls === 2);
  await rt.stop();
});

test("the idempotency store is bounded and expires entries", async () => {
  let t = 0;
  const s = new MemoryIdempotencyStore(3, () => t);
  for (const k of ["a", "b", "c", "d"]) await s.add(k, 100);
  assert.equal(await s.has("a"), false, "oldest evicted at capacity");
  assert.equal(await s.has("d"), true);
  t = 101;
  assert.equal(await s.has("d"), false, "expired");
});

test("graceful shutdown: in-flight messages finish; a message interrupted mid-retry goes back to the transport instead of being lost", async () => {
  const { rt, adapter } = await runtime({ settings: settings({ retry: { enabled: true, maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 1, multiplier: 1 } }) });
  let calls = 0; let release: () => void = () => undefined;
  rt.registerFunction("users.created", async () => { calls++; if (calls === 1) await new Promise<void>((r) => { release = r; }); });
  await rt.start();
  await rt.publish("users.created", { userId: "1" });
  await until(() => calls === 1);
  const stopping = rt.stop();
  await new Promise((r) => setTimeout(r, 30));
  release();
  await stopping;
  assert.equal(rt.metrics().consumed, 1, "the in-flight handler completed before shutdown finished");
  assert.equal(adapter.log.get("users.events.dlq"), undefined);
});

test("dead-letter publish failure leaves the message unacknowledged (redelivered) instead of dropping it", async () => {
  const { rt, adapter } = await runtime({ settings: settings({ retry: { enabled: true, maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, multiplier: 1 } }) });
  let calls = 0;
  rt.registerFunction("users.created", () => { calls++; throw new Error("x"); });
  await rt.start();
  const real = adapter.publishRaw.bind(adapter);
  adapter.publishRaw = async (c, b, o) => { if (c.endsWith(".dlq") && calls < 3) throw new Error("dlq down"); return real(c, b, o); };
  await rt.publish("users.created", { userId: "1" });
  await until(() => rt.metrics().deadLettered === 1, 5000);
  assert.ok(calls >= 3, `the message was redelivered until the dead-letter destination worked (${calls} deliveries)`);
  await rt.stop();
});

test("dead-letter disabled: exhausted messages are dropped and counted, never silently", async () => {
  const { rt } = await runtime({ settings: settings({ deadLetter: { enabled: false }, retry: { enabled: false, maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, multiplier: 1 } }) });
  rt.registerFunction("users.created", () => { throw new Error("x"); });
  await rt.start();
  await rt.publish("users.created", { userId: "1" });
  await until(() => rt.metrics().dropped === 1);
  await rt.stop();
});

test("consumers must be explicit: undecorated, undeclared or late registrations are refused", async () => {
  const { rt } = await runtime();
  class Plain { handle() { return undefined; } }
  class Other { handle() { return undefined; } }
  class Good { handle() { return undefined; } }
  DispatchConsumer("other.event")(Other as never); DispatchConsumer("users.created")(Good as never);
  assert.throws(() => rt.register(new Plain() as never), /not decorated/);
  assert.throws(() => rt.register(new Other() as never), /not declared/);
  rt.register(new Good() as never);
  await rt.start();
  assert.throws(() => rt.register(new Good() as never), /before start/);
  await rt.stop();
});

// ---------------------------------------------------------------- configuration and the disabled default

function project(config: Record<string, unknown> | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "pso-dispatch-"));
  if (config) writeFileSync(join(dir, "pso.config.json"), JSON.stringify(config));
  return dir;
}

test("dispatch is disabled by default: no adapter is created, nothing connects, publishing fails with a clear error", async () => {
  const dir = project(undefined);
  try {
    const s = await startDispatch({ appDir: dir, projectDir: dir, source: "users-service", env: {} });
    assert.equal(s.runtime, undefined);
    await assert.rejects(s.dispatch.publish("users.created", {}), (e: DispatchError) => e.code === "PSO_DISPATCH_DISABLED");
    assert.equal((await s.dispatch.health()).status, "down");
    await s.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configuration: defaults, durations, environment overrides, secret references and every problem reported together", () => {
  const dir = project({ dispatch: { retry: { initialDelay: "500ms", maxDelay: "10s", multiplier: 3 }, consumer: { concurrency: 4 } } });
  try {
    const c = loadDispatchConfig({ projectDir: dir, source: "users-service", env: {} });
    assert.deepEqual([c.enabled, c.provider, c.settings.retry.initialDelayMs, c.settings.retry.maxDelayMs, c.settings.retry.multiplier, c.settings.consumer.concurrency, c.settings.consumer.batchSize, c.settings.deadLetter.enabled], [false, "none", 500, 10_000, 3, 4, 10, true]);
    const e = loadDispatchConfig({ projectDir: dir, source: "users-service", env: { PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: "redis://cache:6379" } });
    assert.deepEqual([e.enabled, e.provider, e.redis.url], [true, "redis", "redis://cache:6379"]);
    const ref = project({ dispatch: { enabled: true, provider: "rabbitmq", rabbitmq: { url: "${env:RABBIT}" } } });
    assert.throws(() => loadDispatchConfig({ projectDir: ref, source: "s-service", env: {} }), (x: DispatchConfigError) => x.issues.some((i) => i.code === "PSO_DISPATCH_ENV_MISSING"));
    assert.equal(loadDispatchConfig({ projectDir: ref, source: "s-service", env: { RABBIT: "amqp://u:p@h:5672" } }).rabbitmq.url, "amqp://u:p@h:5672");
    const bad = project({ dispatch: { enabled: true, provider: "kafka", retry: { initialDelay: "soon", maxAttempts: 99 }, kafka: { brokers: ["nohost"], sasl: { mechanism: "plain", username: "u", password: "${env:KP}" } } } });
    try { loadDispatchConfig({ projectDir: bad, source: "s-service", env: { KP: "x" } }); assert.fail("expected an error"); }
    catch (x) {
      const codes = (x as DispatchConfigError).issues.map((i) => i.code);
      for (const code of ["PSO_DISPATCH_DURATION", "PSO_DISPATCH_BROKER", "PSO_DISPATCH_INSECURE"]) assert.ok(codes.includes(code), `${code} in ${codes}`);
      assert.ok(!(x as Error).message.includes("\"x\""), "secret values are never part of a message");
    }
    assert.throws(() => loadDispatchConfig({ projectDir: project({ dispatch: { enabled: true } }), source: "s-service", env: {} }), (x: DispatchConfigError) => x.issues.some((i) => i.code === "PSO_DISPATCH_PROVIDER"));
    assert.throws(() => loadDispatchConfig({ projectDir: project({ dispatch: { enabled: true, provider: "redis" } }), source: "s-service", env: {} }), (x: DispatchConfigError) => x.issues.some((i) => i.key === "dispatch.redis.url"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
