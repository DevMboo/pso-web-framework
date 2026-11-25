import { test, after } from "node:test";
import { sessionEnv } from "../../../scripts/dispatch-brokers.mjs";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import net from "node:net";
import { Dto, Required, StringField, setLogSink, resetLogging } from "@pso/http";
import { Principal } from "@pso/security";
import { DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, DispatchConsumer, createEnvelope, serializeEnvelope, type DispatchTrust } from "@pso/dispatch";
import { MemoryAdapter } from "../../dispatch/src/testing.ts";
import {
  Channel, OnSubscribe, Context, ChannelParam, ChannelHub, ChannelRegistry, RedisBus, LocalBus, CHANNELS_DEFAULTS, loadChannelsConfig, ChannelsConfigError,
  ChannelDispatchConsumer, ChannelPublisher, unverifiedBridgePolicy,
  type Connection, type ChannelContext, type ChannelEnvelope, type RedisBusOptions,
} from "../src/index.ts";

/**
 * The production security policy of the two distributed trust boundaries of Channels (SEC-01, SEC-02):
 *   - the Redis bus between orchestrator instances must be authenticated in production, or explicitly declared a legacy bus;
 *   - the Dispatch bridge authorizes a publication only on a VERIFIED publisher in production, never on the envelope's claim.
 * Compatibility switches exist, are explicit, are reported, and are never what an incomplete configuration falls back to.
 */
const REDIS = (sessionEnv(undefined, ["redis"]) as Record<string, string | undefined>)["PSO_TEST_REDIS_URL"] ?? "redis://127.0.0.1:1";
const reachable = await new Promise<boolean>((r) => { const u = new URL(REDIS); const s = net.connect(Number(u.port || 6379), u.hostname); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const needsRedis = { timeout: 90_000, skip: reachable ? false : "no local Redis (node scripts/dispatch-brokers.mjs up)" } as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 8000): Promise<void> => { for (let t = 0; t < ms && !ok(); t += 20) await sleep(20); assert.ok(ok(), `timed out waiting for: ${what}`); };

type Dec = (...a: never[]) => void;
class CandidateUpdated { candidateId!: string; status!: string }
Dto()(CandidateUpdated as never);
for (const f of ["candidateId", "status"]) { StringField()(CandidateUpdated.prototype as object, f); Required()(CandidateUpdated.prototype as object, f); }
class CandidateChannel { async authorize(_id: string, ctx: ChannelContext): Promise<boolean> { return ctx.user?.subject === "alice"; } }
Channel("candidate.{candidateId}", { visibility: "private", publishers: ["recruitment-service"], events: { "candidate.updated": CandidateUpdated } })(CandidateChannel);
(OnSubscribe() as unknown as (t: object, k: string) => void)(CandidateChannel.prototype, "authorize");
(ChannelParam("candidateId") as unknown as (t: object, k: string, i: number) => void)(CandidateChannel.prototype, "authorize", 0);
(Context() as unknown as (t: object, k: string, i: number) => void)(CandidateChannel.prototype, "authorize", 1);
void (undefined as unknown as Dec);

const principal = (subject: string): Principal => new Principal({ subject, issuer: "https://idp.test", audiences: ["pso-api"], scopes: [], roles: [], permissions: [], expiresAt: new Date(Date.now() + 3_600_000) });
class FakeConn implements Connection {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly correlationId = `corr-${this.id}-xxxxxxxx`;
  sent: Array<Record<string, unknown>> = [];
  principal: Principal | null = principal("alice");
  send(frame: string): boolean { this.sent.push(JSON.parse(frame) as Record<string, unknown>); return true; }
  close(): void { /* not used */ }
  statuses(): string[] { return this.sent.filter((m) => m["t"] === "event").map((m) => (m["payload"] as { status: string }).status); }
}
const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); resetLogging(); });

const newHub = (bus: ConstructorParameters<typeof ChannelHub>[0]["bus"]): ChannelHub => {
  const registry = new ChannelRegistry();
  assert.deepEqual(registry.add("recruitment", [CandidateChannel]), []);
  const instances = new Map<unknown, unknown>();
  const hub = new ChannelHub({ registry, config: { ...CHANNELS_DEFAULTS, bus: bus.kind }, bus, service: "orchestrator", authorize: () => true, resolve: (c) => { if (!instances.has(c)) instances.set(c, new (c as new () => object)()); return instances.get(c) as Record<string, (...a: unknown[]) => unknown>; } });
  closers.push(() => hub.close());
  return hub;
};
async function instance(prefix: string, options: RedisBusOptions = {}, url = REDIS) {
  const dropped: string[] = [];
  let unsigned = 0;
  const bus = new RedisBus(url, prefix, { ...options, onReject: (r) => dropped.push(r), onUnsigned: () => { unsigned++; } });
  await bus.start();
  const hub = newHub(bus);
  const alice = new FakeConn();
  assert.ok(await hub.connect(alice)); await hub.subscribe(alice, "candidate.c1");
  return { hub, bus, dropped, alice, unsigned: () => unsigned };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let raw: any;
async function inject(prefix: string, message: unknown): Promise<void> {
  if (!raw) { const { default: IORedis } = await import("ioredis"); raw = new IORedis(REDIS); closers.push(async () => { raw.disconnect(); }); }
  await raw.publish(`${prefix}:events`, JSON.stringify(message));
}
const prefix = (): string => `pso:test:policy:${randomUUID()}`;
const envelope = (status: string, source = "recruitment-service"): ChannelEnvelope => ({ v: 1, id: `evt-${randomUUID()}`, type: "candidate.updated", channel: "candidate.c1", ts: new Date().toISOString(), source, payload: { candidateId: "c1", status } });
const SECRET = "s".repeat(40), OLD = "o".repeat(40), OTHER = "x".repeat(40);
const signed = (p: string, key: string, e: unknown, i = `foreign-${randomUUID()}`): Record<string, unknown> => ({ i, e, s: createHmac("sha256", key).update(`${p}:events\n${i}\n${JSON.stringify(e)}`).digest("base64url") });

// ------------------------------------------------------------------------------------------------ SEC-01: configuration policy
test("SEC-01 policy: production with a Redis bus requires the bus secret; a legacy bus must be declared; development is unchanged", () => {
  const base = { PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_REDIS_URL: "redis://cache:6379" };
  const prod = { ...base, NODE_ENV: "production", PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.com" };
  const problems = (env: Record<string, string>): string => { try { loadChannelsConfig(undefined, env); return ""; } catch (e) { assert.ok(e instanceof ChannelsConfigError); return e.problems.join("\n"); } };

  // missing production secret: start-up is refused with an actionable message, not downgraded to an unauthenticated bus
  const missing = problems(prod);
  assert.match(missing, /production with channels\.bus="redis" requires PSO_CHANNELS_BUS_SECRET/);
  assert.match(missing, /PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED=true \(insecure/, "the migration switch is named in the error");
  assert.match(problems({ ...base, PSO_ENV: "production", PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.com" }), /requires PSO_CHANNELS_BUS_SECRET/, "PSO_ENV decides as well");

  // secure production
  const secure = loadChannelsConfig(undefined, { ...prod, PSO_CHANNELS_BUS_SECRET: SECRET });
  assert.deepEqual([secure.busSecret, secure.busAcceptUnsigned, secure.busUnauthenticatedAccepted], [SECRET, false, undefined]);

  // explicit legacy: deliberate, exact, visible in the configuration object (and reported at start by attachChannels)
  const legacy = loadChannelsConfig(undefined, { ...prod, PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED: "true" });
  assert.deepEqual([legacy.busSecret, legacy.busUnauthenticatedAccepted], [undefined, true]);
  for (const sloppy of ["1", "yes", "TRUE", "false"]) assert.match(problems({ ...prod, PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED: sloppy }), /must be exactly "true"/, `"${sloppy}" is not an acknowledgement`);
  assert.equal(loadChannelsConfig(undefined, { ...prod, PSO_CHANNELS_BUS_SECRET: SECRET, PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED: "true" }).busUnauthenticatedAccepted, undefined, "with a secret the bus is authenticated: the legacy flag changes nothing");

  // a weak or incomplete secret never falls back to "no secret"
  assert.match(problems({ ...prod, PSO_CHANNELS_BUS_SECRET: "short" }), /at least 32 characters/);

  // migration switch: only meaningful on a signed bus
  assert.equal(loadChannelsConfig(undefined, { ...prod, PSO_CHANNELS_BUS_SECRET: SECRET, PSO_CHANNELS_BUS_ACCEPT_UNSIGNED: "true" }).busAcceptUnsigned, true);
  assert.match(problems({ ...base, PSO_CHANNELS_BUS_ACCEPT_UNSIGNED: "true" }), /needs PSO_CHANNELS_BUS_SECRET/);
  assert.match(problems({ ...base, PSO_CHANNELS_BUS_SECRET: SECRET, PSO_CHANNELS_BUS_ACCEPT_UNSIGNED: "maybe" }), /channels\.busAcceptUnsigned must be true or false/);

  // development, tests and single-instance production are exactly as before
  assert.equal(loadChannelsConfig(undefined, base).busSecret, undefined, "development: a local Redis bus needs no secret");
  assert.equal(loadChannelsConfig(undefined, { ...base, NODE_ENV: "test" }).busSecret, undefined);
  assert.equal(loadChannelsConfig(undefined, { NODE_ENV: "production", PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.com", PSO_CHANNELS_ACK_SINGLE_INSTANCE: "true" }).bus, "local", "the local bus has no distributed boundary");
  assert.equal(problems({ ...prod, PSO_CHANNELS_ENABLED: "false" }), "", "channels switched off: nothing to authenticate");
  // no secret is ever echoed
  assert.ok(!problems({ ...prod, PSO_CHANNELS_BUS_SECRET: "short-secret-value" }).includes("short-secret-value"));
});

// ------------------------------------------------------------------------------------------------ SEC-01: behaviour on a real Redis
test("SEC-01 signed bus: valid, missing, incorrect and tampered signatures; a forged publisher; an unknown publisher; rotation; cross-instance", needsRedis, async () => {
  const p = prefix();
  const a = await instance(p, { secret: SECRET }), b = await instance(p, { secret: SECRET, previousSecrets: [OLD] });
  // cross-instance, valid signature
  await a.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "PEER" });
  // missing signature: a perfectly valid event naming an allowed publisher, written straight to Redis
  await inject(p, { i: `foreign-${randomUUID()}`, e: envelope("UNSIGNED") });
  // incorrect signature (another deployment's key) and a forged publisher identity signed with a key that is not ours
  await inject(p, signed(p, OTHER, envelope("WRONG-KEY")));
  await inject(p, signed(p, OTHER, envelope("FORGED-ORCHESTRATOR", "orchestrator")));
  // modified payload under a signature that was valid for the original
  const original = envelope("ORIGINAL");
  await inject(p, { ...signed(p, SECRET, original), e: { ...original, payload: { candidateId: "c1", status: "TAMPERED" } } });
  // a holder of the secret (authentic bus message) naming a publisher that is not allowed on this channel: refused by the channel's allow-list
  await inject(p, signed(p, SECRET, envelope("UNKNOWN-PUBLISHER", "billing-service")));
  // rotation: a peer that still signs with the previous secret
  await inject(p, signed(p, OLD, envelope("ROTATING", "orchestrator")));
  await until("the two authentic, authorized events", () => b.alice.statuses().length === 2);
  await sleep(200);
  assert.deepEqual(b.alice.statuses(), ["PEER", "ROTATING"]);
  assert.deepEqual(b.dropped, ["unsigned", "bad-signature", "bad-signature", "bad-signature"], "unauthenticated messages are dropped before validation");
  assert.equal(b.hub.metrics().busRejected, 1, "the authentic message of an unknown publisher was refused by the channel rules");
  assert.equal(b.unsigned(), 0);
  // an instance that does not know the previous secret refuses what was signed with it
  assert.ok(!a.alice.statuses().includes("ROTATING"));
});

test("SEC-01 explicit legacy migration: a signing instance can still accept unsigned peers while the secret is rolled out, observably; then the switch is removed", needsRedis, async () => {
  const p = prefix();
  const legacy = await instance(p);                                           // not upgraded yet: no secret
  const migrating = await instance(p, { secret: SECRET, acceptUnsigned: true }); // step 1: has the secret, still accepts unsigned
  const strict = await instance(p, { secret: SECRET });                      // step 2: the switch removed

  await legacy.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "FROM-LEGACY" });
  await migrating.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "FROM-MIGRATING" });
  await inject(p, signed(p, OTHER, envelope("BAD-SIGNATURE")));               // a signature that is present must verify, in every mode
  await until("deliveries", () => migrating.alice.statuses().length === 2 && legacy.alice.statuses().length === 3 && strict.alice.statuses().length === 1);
  await sleep(200);
  assert.deepEqual(migrating.alice.statuses(), ["FROM-LEGACY", "FROM-MIGRATING"], "the migrating instance loses nothing from peers that are not upgraded");
  assert.equal(migrating.unsigned(), 1, "and every unsigned message it accepted is counted (and logged by the server)");
  assert.deepEqual(migrating.dropped, ["bad-signature"], "a wrong signature is never waved through by the migration switch");
  assert.deepEqual(strict.alice.statuses(), ["FROM-MIGRATING"], "without the switch unsigned messages are refused");
  assert.deepEqual(strict.dropped, ["unsigned", "bad-signature"]);
  assert.deepEqual(legacy.alice.statuses().sort(), ["BAD-SIGNATURE", "FROM-LEGACY", "FROM-MIGRATING"], "an instance without the secret accepts everything: that is the legacy exposure the policy removes from production");
  assert.equal(migrating.bus.authenticated, true);
});

test("SEC-01 recovery: after the Redis connection is lost and restored the signed bus delivers again and still refuses forgeries", needsRedis, async () => {
  // a TCP relay in front of the real Redis: cutting it is an outage for this instance only
  const target = new URL(REDIS);
  const sockets = new Set<net.Socket>();
  let open = true;
  const relay = net.createServer((c) => {
    if (!open) return c.destroy();
    const u = net.connect(Number(target.port || 6379), target.hostname);
    sockets.add(c); sockets.add(u);
    c.pipe(u); u.pipe(c);
    const end = (): void => { c.destroy(); u.destroy(); sockets.delete(c); sockets.delete(u); };
    for (const s of [c, u]) { s.on("error", end); s.on("close", end); }
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { open = false; for (const s of sockets) s.destroy(); relay.close(() => r()); }));
  const p = prefix();
  const a = await instance(p, { secret: SECRET });
  const b = await instance(p, { secret: SECRET }, `redis://127.0.0.1:${(relay.address() as net.AddressInfo).port}`);
  await a.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "BEFORE" });
  await until("delivery before the outage", () => b.alice.statuses().length === 1);

  open = false; for (const s of sockets) s.destroy();
  await until("the bus reports the outage", () => false, 600).catch(() => undefined);
  assert.equal((await b.bus.health()).status, "down");
  await a.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "DURING" }); // fire-and-forget bus: not delivered to b, by design
  open = true;
  for (let i = 0; i < 100 && (await b.bus.health()).status !== "up"; i++) await sleep(100);
  assert.equal((await b.bus.health()).status, "up", "the subscriber reconnected and re-subscribed on its own");
  await inject(p, { i: `foreign-${randomUUID()}`, e: envelope("FORGED-AFTER") });
  await a.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "AFTER" });
  await until("delivery after recovery", () => b.alice.statuses().includes("AFTER"));
  await sleep(150);
  assert.deepEqual(b.alice.statuses(), ["BEFORE", "AFTER"]);
  assert.ok(b.dropped.includes("unsigned"), "authentication is as strict after the reconnection as before");
});

// ------------------------------------------------------------------------------------------------ SEC-02: the Dispatch bridge
const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["PSO_ENV", "NODE_ENV", "PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED"]) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test("SEC-02 policy: production refuses an unverified publisher; legacy is explicit; development is convenient", () => {
  assert.equal(unverifiedBridgePolicy({}), "development");
  assert.equal(unverifiedBridgePolicy({ NODE_ENV: "test" }), "development");
  assert.equal(unverifiedBridgePolicy({ NODE_ENV: "production" }), "refuse");
  assert.equal(unverifiedBridgePolicy({ PSO_ENV: "production", NODE_ENV: "development" }), "refuse", "PSO_ENV wins, as everywhere else");
  assert.equal(unverifiedBridgePolicy({ PSO_ENV: "production", PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED: "true" }), "legacy");
  for (const sloppy of ["1", "yes", "TRUE", ""]) assert.equal(unverifiedBridgePolicy({ PSO_ENV: "production", PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED: sloppy }), "refuse", `"${sloppy}" is not an acknowledgement`);
  assert.equal(unverifiedBridgePolicy({ PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED: "true" }), "development", "outside production the switch is not needed");
});

test("SEC-02 bridge: in production only a VERIFIED publisher is authorized; a claimed source is refused, logged, and never delivered", async () => {
  const hub = newHub(new LocalBus());
  const previous = ChannelPublisher.hub;
  ChannelPublisher.hub = hub;
  const lines: string[] = [];
  setLogSink((l) => { lines.push(l); });
  try {
    const alice = new FakeConn();
    assert.ok(await hub.connect(alice)); await hub.subscribe(alice, "candidate.c1");
    class Bridge extends ChannelDispatchConsumer {}
    const bridge = new Bridge();
    const claimed = { envelope: { source: "recruitment-service" } };

    await withEnv({ PSO_ENV: "production" }, async () => {
      await bridge.handle(envelope("VERIFIED"), { envelope: { source: "recruitment-service" }, verifiedSource: "recruitment-service" });
      await bridge.handle(envelope("FORGED-1"), claimed);          // the attack: an allowed publisher's name, no proof
      await bridge.handle(envelope("FORGED-2"), claimed);
      await bridge.handle(envelope("ROGUE"), { envelope: { source: "recruitment-service" }, verifiedSource: "rogue-service" }); // verified as someone who may not publish here
    });
    await sleep(30);
    assert.deepEqual(alice.statuses(), ["VERIFIED"], "production: nothing was authorized on a claim");
    const refusedLines = lines.filter((l) => /REFUSED: its publisher is not verified/.test(l));
    assert.equal(refusedLines.length, 2, "each refusal is reported (bounded under a flood)");
    assert.ok(refusedLines.every((l) => /"level":"error"/.test(l) || /error/i.test(l)));
    assert.ok(refusedLines[0]!.includes("PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED"), "the message names the migration switch");

    // explicit legacy migration: the claim is accepted again, and the process says it is insecure
    lines.length = 0;
    await withEnv({ PSO_ENV: "production", PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED: "true" }, async () => {
      await bridge.handle(envelope("LEGACY-1"), claimed);
      await bridge.handle(envelope("LEGACY-2"), claimed);
      await bridge.handle(envelope("LEGACY-NOT-A-PUBLISHER"), { envelope: { source: "billing-service" } }); // the channel's allow-list still applies
    });
    await sleep(30);
    assert.deepEqual(alice.statuses(), ["VERIFIED", "LEGACY-1", "LEGACY-2"]);
    assert.equal(lines.filter((l) => /INSECURE legacy mode \(PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED\)/.test(l)).length, 1, "reported once per process");

    // development: unchanged convenience, with its own one-time notice
    lines.length = 0;
    await withEnv({}, async () => { await bridge.handle(envelope("DEV-1"), claimed); await bridge.handle(envelope("DEV-2"), claimed); });
    await sleep(30);
    assert.deepEqual(alice.statuses().slice(-2), ["DEV-1", "DEV-2"]);
    assert.equal(lines.filter((l) => /development only: production refuses them/.test(l)).length, 1);
  } finally { ChannelPublisher.hub = previous; resetLogging(); }
});

test("SEC-02 end to end: Dispatch (trust required) -> bridge -> browser. Signed authorized publisher delivered; unsigned, forged, tampered, wrong key and unknown producer never reach the hub", async () => {
  const K = { recruitment: "recruitment-key-".padEnd(40, "r"), rogue: "rogue-key-".padEnd(40, "x") };
  const CHANNEL = "channels.events";
  const broker = new MemoryAdapter();
  const registryOf = (): EventRegistry => { const r = new EventRegistry(); r.add({ name: "channels.publish", version: 1, channel: CHANNEL }); return r; };
  const trust = (mode: DispatchTrust["mode"], keys: Record<string, string[]>, signingKey?: string): DispatchTrust => ({ mode, keys: new Map(Object.entries(keys)), ...(signingKey ? { signingKey } : {}) });
  const runtime = (source: string, t: DispatchTrust): DispatchRuntime => new DispatchRuntime({ settings: { source, ...DEFAULT_SETTINGS, retry: { enabled: false, maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, multiplier: 1 }, trust: t }, adapter: broker, registry: registryOf() });

  const hub = newHub(new LocalBus());
  const previous = ChannelPublisher.hub;
  ChannelPublisher.hub = hub;
  const alice = new FakeConn();
  assert.ok(await hub.connect(alice)); await hub.subscribe(alice, "candidate.c1");
  class Bridge extends ChannelDispatchConsumer {}
  DispatchConsumer("channels.publish")(Bridge as never);

  const orchestrator = runtime("orchestrator", trust("required", { "recruitment-service": [K.recruitment] }));
  orchestrator.register(new Bridge() as never);
  const recruitment = runtime("recruitment-service", trust("off", {}, K.recruitment));
  const rogue = runtime("rogue-service", trust("off", {}, K.rogue));
  await orchestrator.start(); await recruitment.start(); await rogue.start();
  try {
    await withEnv({ PSO_ENV: "production" }, async () => {
      await recruitment.publish("channels.publish", envelope("SIGNED"));
      // the attacker can write to the broker but holds no key of recruitment-service
      const forgedBody = (status: string): Buffer => Buffer.from(serializeEnvelope(createEnvelope({ type: "channels.publish", version: 1, source: "recruitment-service", payload: envelope(status) })));
      await broker.publishRaw(CHANNEL, forgedBody("UNSIGNED"));                                                             // no signature
      const { signMessage, SIGNATURE_HEADER } = await import("@pso/dispatch");
      const b1 = forgedBody("WRONG-KEY");
      await broker.publishRaw(CHANNEL, b1, { headers: { [SIGNATURE_HEADER]: signMessage(K.rogue, CHANNEL, b1) } });         // forged source, signed with the attacker's own key
      const good = forgedBody("ORIGINAL");
      await broker.publishRaw(CHANNEL, forgedBody("TAMPERED"), { headers: { [SIGNATURE_HEADER]: signMessage(K.recruitment, CHANNEL, good) } }); // a captured signature on different bytes
      await rogue.publish("channels.publish", envelope("UNKNOWN-PRODUCER"));                                                // honestly signed by a service nobody trusts
      await until("everything was consumed", () => orchestrator.metrics().consumed + orchestrator.metrics().untrusted === 5);
    });
    await sleep(50);
    assert.deepEqual(alice.statuses(), ["SIGNED"], "only the signed, authorized publisher reached a browser");
    assert.equal(orchestrator.metrics().untrusted, 4);
    assert.deepEqual((broker.log.get(`${CHANNEL}.dlq`) ?? []).map((m) => m.headers["x-pso-reason"]).sort(), ["PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:invalid", "PSO_DISPATCH_UNTRUSTED:unknown-source", "PSO_DISPATCH_UNTRUSTED:unsigned"]);
  } finally { await orchestrator.stop(); await recruitment.stop().catch(() => undefined); await rogue.stop().catch(() => undefined); ChannelPublisher.hub = previous; }

  // the same attack against a production orchestrator whose Dispatch trust is OFF (legacy, explicitly allowed): the bridge itself fails closed
  const broker2 = new MemoryAdapter();
  const hub2 = newHub(new LocalBus());
  ChannelPublisher.hub = hub2;
  const bob = new FakeConn();
  assert.ok(await hub2.connect(bob)); await hub2.subscribe(bob, "candidate.c1");
  const open = new DispatchRuntime({ settings: { source: "orchestrator", ...DEFAULT_SETTINGS }, adapter: broker2, registry: registryOf() });
  open.register(new Bridge() as never);
  await open.start();
  try {
    await withEnv({ PSO_ENV: "production" }, async () => {
      await broker2.publishRaw(CHANNEL, Buffer.from(serializeEnvelope(createEnvelope({ type: "channels.publish", version: 1, source: "recruitment-service", payload: envelope("FORGED-TRUST-OFF") }))));
      await until("consumed", () => open.metrics().consumed === 1);
    });
    await sleep(50);
    assert.deepEqual(bob.statuses(), [], "trust mode off never turns a claim into an authorization in production");
  } finally { await open.stop(); ChannelPublisher.hub = previous; }
});
