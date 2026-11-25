import { test, after } from "node:test";
import { sessionEnv } from "../../../scripts/dispatch-brokers.mjs";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dto, Required, StringField, Public } from "@pso/http";
import { Principal } from "@pso/security";
import {
  Channel, OnSubscribe, Context, ChannelParam, ChannelHub, ChannelRegistry, RedisBus, LocalBus, CHANNELS_DEFAULTS, loadChannelsConfig, ChannelsConfigError,
  type Connection, type ChannelContext, type ChannelEnvelope, type RedisBusOptions, type ChannelBus, type BusListener,
} from "../src/index.ts";

/**
 * The distributed trust boundary of Channels: everything that arrives from Redis Pub/Sub. Two (or three) real hubs share a real Redis,
 * exactly like orchestrator instances do; hostile messages are written to the topic with a plain Redis client, the way an attacker
 * (or a buggy service) with access to that Redis would.
 */
const REDIS = (sessionEnv(undefined, ["redis"]) as Record<string, string | undefined>)["PSO_TEST_REDIS_URL"] ?? "redis://127.0.0.1:1";
const reachable = await new Promise<boolean>((r) => { const u = new URL(REDIS); const s = connect(Number(u.port || 6379), u.hostname); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const needsRedis = { timeout: 60_000, skip: reachable ? false : "no local Redis (node scripts/dispatch-brokers.mjs up)" } as const;

type Dec = (...a: never[]) => void;
const method = (cls: Function, name: string, ds: Dec[], params: Array<[number, Dec]> = []): void => {
  for (const d of [...ds].reverse()) (d as unknown as (t: object, k: string) => void)(cls.prototype as object, name);
  for (const [i, d] of params) (d as unknown as (t: object, k: string, i: number) => void)(cls.prototype as object, name, i);
};
class CandidateUpdated { candidateId!: string; status!: string }
Dto()(CandidateUpdated as never);
for (const f of ["candidateId", "status"]) { StringField()(CandidateUpdated.prototype as object, f); Required()(CandidateUpdated.prototype as object, f); }

const owners = new Map([["c1", "alice"], ["c2", "bob"]]);
class CandidateChannel { async authorize(candidateId: string, ctx: ChannelContext): Promise<boolean> { return owners.get(candidateId) === ctx.user?.subject; } }
Channel("candidate.{candidateId}", { visibility: "private", publishers: ["recruitment-service"], events: { "candidate.updated": CandidateUpdated } })(CandidateChannel);
method(CandidateChannel, "authorize", [OnSubscribe() as Dec], [[0, ChannelParam("candidateId") as Dec], [1, Context() as Dec]]);
class NewsChannel { open(): boolean { return true; } }
Channel("news", { visibility: "public" })(NewsChannel);
method(NewsChannel, "open", [OnSubscribe() as Dec, Public() as Dec]);

const principal = (subject: string): Principal => new Principal({ subject, issuer: "https://idp.test", audiences: ["pso-api"], scopes: [], roles: [], permissions: [], expiresAt: new Date(Date.now() + 3_600_000) });
class FakeConn implements Connection {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly correlationId = `corr-${this.id}-xxxxxxxx`;
  sent: Array<Record<string, unknown>> = [];
  principal: Principal | null;
  constructor(p: Principal | null) { this.principal = p; }
  send(frame: string): boolean { this.sent.push(JSON.parse(frame) as Record<string, unknown>); return true; }
  close(): void { /* not used */ }
  events(): Array<Record<string, unknown>> { return this.sent.filter((m) => m["t"] === "event"); }
}

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 5000): Promise<void> => { for (let t = 0; t < ms && !ok(); t += 20) await sleep(20); assert.ok(ok(), `timed out waiting for: ${what}`); };

async function instance(prefix: string, options: RedisBusOptions = {}, over: { service?: string; trustedSources?: string[]; maxMessageBytes?: number } = {}) {
  const registry = new ChannelRegistry();
  assert.deepEqual(registry.add("recruitment", [CandidateChannel, NewsChannel]), []);
  const dropped: string[] = [];
  const config = { ...CHANNELS_DEFAULTS, bus: "redis" as const, trustedSources: over.trustedSources ?? [], maxMessageBytes: over.maxMessageBytes ?? CHANNELS_DEFAULTS.maxMessageBytes };
  const bus = new RedisBus(REDIS, prefix, { maxBytes: config.maxMessageBytes + 4096, ...options, onReject: (r) => dropped.push(r) });
  await bus.start();
  const instances = new Map<unknown, unknown>();
  const hub = new ChannelHub({ registry, config, bus, service: over.service ?? "orchestrator", authorize: () => true, resolve: (c) => { if (!instances.has(c)) instances.set(c, new (c as new () => object)()); return instances.get(c) as Record<string, (...a: unknown[]) => unknown>; } });
  closers.push(() => hub.close());
  const join = async (subject: string | null, channel: string): Promise<FakeConn> => { const c = new FakeConn(subject ? principal(subject) : null); assert.ok(await hub.connect(c)); await hub.subscribe(c, channel); return c; };
  return { hub, bus, dropped, join };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let raw: any;
/** Writes to the bus topic like any Redis client with access to it could. Returns when Redis accepted the message. */
async function inject(prefix: string, message: unknown): Promise<void> {
  if (!raw) { const { default: IORedis } = await import("ioredis"); raw = new IORedis(REDIS); closers.push(async () => { raw.disconnect(); }); }
  await raw.publish(`${prefix}:events`, typeof message === "string" ? message : JSON.stringify(message));
}
const prefix = (): string => `pso:test:bus:${randomUUID()}`;
const envelope = (over: Partial<ChannelEnvelope> = {}): ChannelEnvelope => ({ v: 1, id: `evt-${randomUUID()}`, type: "candidate.updated", channel: "candidate.c1", ts: new Date().toISOString(), source: "recruitment-service", payload: { candidateId: "c1", status: "HIRED" }, ...over });
const wire = (e: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ i: `foreign-${randomUUID()}`, e, ...extra });

test("multi-instance fan-out: a local publication reaches the subscribers of every instance exactly once, and nothing is re-published", needsRedis, async () => {
  const p = prefix();
  const a = await instance(p), b = await instance(p);
  const onA = await a.join("alice", "candidate.c1"), onB = await b.join("alice", "candidate.c1");
  // what actually crosses Redis: counted by an independent subscriber
  const { default: IORedis } = await import("ioredis");
  const tap = new IORedis(REDIS); closers.push(async () => { tap.disconnect(); });
  let onTheWire = 0;
  await tap.subscribe(`${p}:events`);
  tap.on("message", () => { onTheWire++; });

  const env = await a.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "INTERVIEW" });
  await until("delivery on both instances", () => onA.events().length === 1 && onB.events().length === 1);
  await sleep(300); // time for an echo to show up, if there were one
  for (const c of [onA, onB]) {
    assert.equal(c.events().length, 1, "exactly once per subscriber");
    assert.deepEqual([c.events()[0]!["eventId"], c.events()[0]!["type"], c.events()[0]!["payload"]], [env.id, "candidate.updated", { candidateId: "c1", status: "INTERVIEW" }], "the same event, the same payload, on every instance");
  }
  assert.equal(onTheWire, 1, "one publication is one bus message: the receiving instance never publishes it again (no rebroadcast loop)");
  assert.deepEqual([a.hub.metrics().published, b.hub.metrics().published, b.hub.metrics().busReceived, a.hub.metrics().busReceived], [1, 0, 1, 0]);
  assert.deepEqual([a.dropped, b.dropped], [[], []]);
});

test("existing delivery rules still hold across instances: only the authorized subscriber of the resource receives the event", needsRedis, async () => {
  const p = prefix();
  const a = await instance(p), b = await instance(p);
  const alice = await b.join("alice", "candidate.c1");
  const bob = new FakeConn(principal("bob"));
  assert.ok(await b.hub.connect(bob));
  await assert.rejects(b.hub.subscribe(bob, "candidate.c1"), /PSO_CHANNEL_FORBIDDEN/, "bob does not own c1");
  const bobOwn = await b.join("bob", "candidate.c2");
  const anonymous = await b.join(null, "news");
  await a.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "HIRED" });
  await until("alice's event", () => alice.events().length === 1);
  await sleep(150);
  assert.deepEqual([bob.events().length, bobOwn.events().length, anonymous.events().length], [0, 0, 0], "nobody else sees another resource's event");
});

test("malformed bus messages never reach fan-out: not JSON, wrong shape, invalid envelope, unknown fields", needsRedis, async () => {
  const p = prefix();
  const b = await instance(p);
  const alice = await b.join("alice", "candidate.c1");
  const bad: unknown[] = [
    "not json at all", "[]", "null", JSON.stringify({ e: envelope() }), JSON.stringify({ i: "x", e: "text" }),
    wire({ ...envelope(), v: 2 }), wire({ ...envelope(), id: "x" }), wire({ ...envelope(), type: "Not A Type" }), wire({ ...envelope(), ts: "yesterday" }),
    wire({ ...envelope(), source: "Bad Source!" }), wire({ ...envelope(), extra: "smuggled" }), wire({ ...envelope(), channel: 42 }), wire({ ...envelope(), correlationId: "x" }),
  ];
  for (const m of bad) await inject(p, m);
  await inject(p, wire(envelope({ payload: { candidateId: "c1", status: "OK" } }))); // a marker: everything before it has been processed when it arrives
  await until("the marker", () => alice.events().length === 1);
  assert.equal(alice.events().length, 1, "only the valid marker was delivered");
  assert.deepEqual(b.dropped, ["malformed", "malformed", "malformed", "malformed", "malformed"], "non-JSON and wrong shapes are dropped by the transport");
  assert.equal(b.hub.metrics().busRejected, 8, "structurally invalid envelopes are refused by the hub");
  assert.equal(b.hub.metrics().busReceived, 1);
});

test("publisher permissions and channel registration apply to bus events exactly as to local ones", needsRedis, async () => {
  const p = prefix();
  const b = await instance(p);
  const alice = await b.join("alice", "candidate.c1");
  const news = await b.join(null, "news");
  await inject(p, wire(envelope({ source: "rogue-service" })));                          // not in the channel's publishers
  await inject(p, wire(envelope({ channel: "candidate.c1/../c2" })));                    // not a registered channel name
  await inject(p, wire(envelope({ channel: "payroll.secret", source: "orchestrator" }))); // channel does not exist
  await inject(p, wire(envelope({ channel: "/candidate.c1" })));                         // not the canonical name
  await inject(p, wire(envelope({ channel: "news", type: "news.posted", source: "recruitment-service", payload: {} }))); // allowed for candidate.*, not for news
  await inject(p, wire(envelope({ id: `evt-${randomUUID()}`, source: "recruitment-service" })));   // the declared publisher
  await inject(p, wire(envelope({ id: `evt-${randomUUID()}`, source: "orchestrator" })));          // a peer instance of this orchestrator
  await until("the two legitimate events", () => alice.events().length === 2);
  await sleep(100);
  assert.equal(alice.events().length, 2);
  assert.equal(news.events().length, 0);
  assert.equal(b.hub.metrics().busRejected, 5);
  // an explicitly trusted extra source (instances that run under another service name)
  const p2 = prefix();
  const c = await instance(p2, {}, { trustedSources: ["gateway-eu"] });
  const sub = await c.join("alice", "candidate.c1");
  await inject(p2, wire(envelope({ source: "gateway-west" })));
  await inject(p2, wire(envelope({ source: "gateway-eu" })));
  await until("the event of the trusted source", () => sub.events().length === 1);
  assert.equal(c.hub.metrics().busRejected, 1);
});

test("payload contracts are enforced on bus events: unknown types and invalid payloads are refused, valid ones delivered unchanged", needsRedis, async () => {
  const p = prefix();
  const b = await instance(p);
  const alice = await b.join("alice", "candidate.c1");
  await inject(p, wire(envelope({ type: "candidate.deleted" })));                                   // not part of the contract
  await inject(p, wire(envelope({ payload: { candidateId: "c1" } })));                              // required field missing
  await inject(p, wire(envelope({ payload: { candidateId: "c1", status: 7 } })));                   // wrong type
  await inject(p, wire(envelope({ payload: { candidateId: "c1", status: "X", isAdmin: true } })));  // undeclared field
  await inject(p, wire(envelope({ payload: "<script>alert(1)</script>" })));
  await inject(p, wire(envelope({ payload: { candidateId: "c1", status: "HIRED" } })));
  await until("the valid event", () => alice.events().length === 1);
  await sleep(100);
  assert.equal(alice.events().length, 1);
  assert.deepEqual(alice.events()[0]!["payload"], { candidateId: "c1", status: "HIRED" });
  assert.equal(b.hub.metrics().busRejected, 5);
});

test("size limits: an oversized bus message is dropped before it is parsed, an oversized payload is refused", needsRedis, async () => {
  const p = prefix();
  const b = await instance(p, {}, { maxMessageBytes: 2048 });
  const news = await b.join(null, "news");
  await inject(p, wire(envelope({ channel: "news", type: "news.posted", source: "orchestrator", payload: { text: "x".repeat(200_000) } }))); // far beyond the transport limit
  await inject(p, wire(envelope({ channel: "news", type: "news.posted", source: "orchestrator", payload: { text: "x".repeat(3000) } })));    // inside the transport limit, beyond the payload limit
  await inject(p, wire(envelope({ channel: "news", type: "news.posted", source: "orchestrator", payload: { text: "ok" } })));
  await until("the small event", () => news.events().length === 1);
  assert.deepEqual(b.dropped, ["oversized"]);
  assert.equal(b.hub.metrics().busRejected, 1);
  assert.equal(news.events().length, 1);
});

test("duplicates: the same event id arriving again (from the bus or locally) is delivered once", needsRedis, async () => {
  const p = prefix();
  const a = await instance(p), b = await instance(p);
  const alice = await b.join("alice", "candidate.c1");
  const e = envelope();
  for (let i = 0; i < 5; i++) await inject(p, wire(e));
  await inject(p, wire(envelope({ payload: { candidateId: "c1", status: "LAST" } })));
  await until("the marker after the duplicates", () => alice.events().some((x) => (x["payload"] as { status: string }).status === "LAST"));
  assert.equal(alice.events().length, 2, "five copies of one event are one delivery");
  assert.equal(b.hub.metrics().duplicates, 4);
  void a;
});

test("authenticated bus: with a shared secret only holders of it can make an instance deliver; rotation keeps working", needsRedis, async () => {
  const p = prefix();
  const SECRET = "s".repeat(40), OLD = "o".repeat(40), OTHER = "x".repeat(40);
  const a = await instance(p, { secret: SECRET }), b = await instance(p, { secret: SECRET, previousSecrets: [OLD] });
  const alice = await b.join("alice", "candidate.c1");
  assert.equal(a.bus.authenticated, true);

  // a contract-valid event that claims an allowed source, written straight to Redis: structurally perfect, not authenticated
  await inject(p, wire(envelope({ source: "orchestrator", payload: { candidateId: "c1", status: "FORGED" } })));
  await inject(p, wire(envelope({ payload: { candidateId: "c1", status: "FORGED" } }), { s: "AAAA" }));
  const forged = envelope({ payload: { candidateId: "c1", status: "FORGED" } });
  const instanceId = `foreign-${randomUUID()}`;
  const mac = (key: string, e: unknown): string => createHmac("sha256", key).update(`${p}:events\n${instanceId}\n${JSON.stringify(e)}`).digest("base64url");
  await inject(p, { i: instanceId, e: forged, s: mac(OTHER, forged) });                                              // signed with a key this deployment does not use
  const tampered = envelope({ payload: { candidateId: "c1", status: "ORIGINAL" } });
  await inject(p, { i: instanceId, e: { ...tampered, payload: { candidateId: "c1", status: "TAMPERED" } }, s: mac(SECRET, tampered) }); // a valid signature of different content
  // an instance of a deployment with another secret, on the same Redis and topic
  const stranger = await instance(p, { secret: OTHER });
  await stranger.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "STRANGER" });
  // legitimate: a peer with the secret, and a peer still signing with the previous secret during a rotation
  await a.hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "PEER" });
  const rotating = envelope({ source: "orchestrator", payload: { candidateId: "c1", status: "ROTATING" } });
  await inject(p, { i: instanceId, e: rotating, s: mac(OLD, rotating) });
  await until("the two authentic events", () => alice.events().length === 2);
  await sleep(150);
  assert.deepEqual(alice.events().map((x) => (x["payload"] as { status: string }).status), ["PEER", "ROTATING"], "nothing forged, tampered or foreign was delivered");
  assert.deepEqual(b.dropped, ["unsigned", "bad-signature", "bad-signature", "bad-signature", "bad-signature"]);
  assert.equal(b.hub.metrics().busRejected, 0, "unauthenticated messages never even reach validation");
});

test("the documented limit without a secret: structure and permissions are validated, the sender's identity is not", needsRedis, async () => {
  const p = prefix();
  const b = await instance(p);
  assert.equal(b.bus.authenticated, false);
  const alice = await b.join("alice", "candidate.c1");
  // anyone able to PUBLISH on this Redis can name an allowed source: `source` is a field of the message, not proof of who sent it
  await inject(p, wire(envelope({ source: "recruitment-service", payload: { candidateId: "c1", status: "FORGED" } })));
  await until("the forged-but-valid event", () => alice.events().length === 1);
  assert.equal((alice.events()[0]!["payload"] as { status: string }).status, "FORGED", "this is why PSO_CHANNELS_BUS_SECRET (and Redis ACLs) exist; validation alone cannot stop it");
});

test("start is bounded and leaks nothing when Redis is unreachable; health reports the bus; the legacy constructor still works", { timeout: 60_000 }, async () => {
  const closedPort = await new Promise<number>((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => r(port)); }); });
  const bus = new RedisBus(`redis://:hunter2@127.0.0.1:${closedPort}`, "pso:test:down", () => undefined);
  const started = Date.now();
  await assert.rejects(bus.start(), (e: Error) => /cannot connect to Redis for the channels bus/.test(e.message) && !e.message.includes("hunter2") && !e.message.includes("127.0.0.1"));
  assert.ok(Date.now() - started < 15_000, "bounded");
  assert.deepEqual(await bus.health(), { status: "down", detail: "not started" });
  await assert.rejects(bus.publish(envelope()), /not started/);
  await bus.close();
  if (reachable) {
    const ok = new RedisBus(REDIS, prefix());
    await ok.start();
    assert.deepEqual(await ok.health(), { status: "up", detail: "PING answered" });
    await ok.close();
  }
});

test("a bus that predates origins (or the in-process bus) keeps its behaviour: local events are delivered without a second validation", async () => {
  const registry = new ChannelRegistry();
  assert.deepEqual(registry.add("m", [CandidateChannel, NewsChannel]), []);
  let listener: BusListener | undefined;
  const legacy: ChannelBus = { kind: "local", publish: async (e) => { listener?.(e); }, onMessage: (cb) => { listener = cb; }, close: async () => undefined }; // calls back without an origin
  for (const bus of [legacy, new LocalBus()]) {
    const hub = new ChannelHub({ registry, config: CHANNELS_DEFAULTS, bus, service: "orchestrator", authorize: () => true, resolve: (c) => new (c as new () => Record<string, (...a: unknown[]) => unknown>)() });
    const c = new FakeConn(principal("alice"));
    assert.ok(await hub.connect(c)); await hub.subscribe(c, "candidate.c1");
    await hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "HIRED" });
    await sleep(20);
    assert.equal(c.events().length, 1);
    assert.deepEqual([hub.metrics().busReceived, hub.metrics().busRejected], [0, 0]);
    assert.deepEqual(await hub.busHealth(), { status: "up", detail: "in-process bus" });
  }
});

test("configuration: the bus secret comes from the environment only, is length-checked, and is never accepted from a file", () => {
  const base = { PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_REDIS_URL: "redis://cache:6379" };
  const cfg = loadChannelsConfig(undefined, { ...base, PSO_CHANNELS_BUS_SECRET: "k".repeat(32), PSO_CHANNELS_BUS_SECRET_PREVIOUS: `${"p".repeat(32)},${"q".repeat(33)}`, PSO_CHANNELS_TRUSTED_SOURCES: "gateway-eu, gateway-us" });
  assert.deepEqual([cfg.busSecret, cfg.busPreviousSecrets.length, cfg.trustedSources], ["k".repeat(32), 2, ["gateway-eu", "gateway-us"]]);
  const defaults = loadChannelsConfig(undefined, {});
  assert.deepEqual([defaults.busSecret, defaults.busPreviousSecrets, defaults.trustedSources], [undefined, [], []], "nothing changes for existing configurations");
  const problems = (env: Record<string, string>): string => { try { loadChannelsConfig(undefined, env); return ""; } catch (e) { assert.ok(e instanceof ChannelsConfigError); return e.problems.join("\n"); } };
  assert.match(problems({ ...base, PSO_CHANNELS_BUS_SECRET: "short" }), /at least 32 characters/);
  assert.ok(!problems({ ...base, PSO_CHANNELS_BUS_SECRET: "short-secret-value" }).includes("short-secret-value"), "the secret is never echoed");
  assert.match(problems({ PSO_CHANNELS_BUS_SECRET: "k".repeat(32) }), /channels\.bus is not "redis"/);
  assert.match(problems({ ...base, PSO_CHANNELS_TRUSTED_SOURCES: "Not Valid" }), /trustedSources must be a list of service names/);
  const dir = mkdtempSync(join(tmpdir(), "pso-ch-cfg-"));
  try {
    writeFileSync(join(dir, "pso.config.json"), JSON.stringify({ channels: { bus: "redis", redisUrl: "redis://cache:6379", busSecret: "file-secret-file-secret-file-secret-1234" } }));
    let message = "";
    try { loadChannelsConfig(dir, {}); } catch (e) { message = (e as Error).message; }
    assert.match(message, /channels.busSecret is a secret and must not be written in a file: set PSO_CHANNELS_BUS_SECRET/);
    assert.ok(!message.includes("file-secret"), "the value is not echoed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the Dispatch bridge authorizes on the VERIFIED publisher when Dispatch trust provides one, and says so once when it does not", async () => {
  const { ChannelDispatchConsumer, ChannelPublisher } = await import("../src/index.ts");
  const { setLogSink, resetLogging } = await import("@pso/http");
  const registry = new ChannelRegistry();
  assert.deepEqual(registry.add("m", [CandidateChannel, NewsChannel]), []);
  const hub = new ChannelHub({ registry, config: CHANNELS_DEFAULTS, bus: new LocalBus(), service: "orchestrator", authorize: () => true, resolve: (c) => new (c as new () => Record<string, (...a: unknown[]) => unknown>)() });
  const previous = ChannelPublisher.hub;
  ChannelPublisher.hub = hub;
  const lines: string[] = [];
  setLogSink((l) => { lines.push(l); });
  try {
    const alice = new FakeConn(principal("alice"));
    assert.ok(await hub.connect(alice)); await hub.subscribe(alice, "candidate.c1");
    class Bridge extends ChannelDispatchConsumer {}
    const bridge = new Bridge();
    const status = (s: string): ChannelEnvelope => envelope({ source: "whatever-the-payload-says", payload: { candidateId: "c1", status: s } });
    // verified by Dispatch (signature of recruitment-service): accepted, whatever the payload claims
    await bridge.handle(status("VERIFIED"), { envelope: { source: "recruitment-service" }, verifiedSource: "recruitment-service" });
    // verified as a service that is NOT a publisher of this channel: refused (logged and dropped, never retried)
    await bridge.handle(status("ROGUE"), { envelope: { source: "rogue-service" }, verifiedSource: "rogue-service" });
    // no Dispatch trust: the envelope's claim is all there is (previous behaviour), and the deployment is told so exactly once
    await bridge.handle(status("CLAIMED-1"), { envelope: { source: "recruitment-service" } });
    await bridge.handle(status("CLAIMED-2"), { envelope: { source: "recruitment-service" } });
    await sleep(30);
    assert.deepEqual(alice.events().map((e) => (e["payload"] as { status: string }).status), ["VERIFIED", "CLAIMED-1", "CLAIMED-2"]);
    assert.equal(lines.filter((l) => /unauthenticated \\"source\\"/.test(l)).length, 1, "one notice per process, not one per event");
    assert.equal(lines.filter((l) => /source may not publish|source is not allowed/.test(l)).length >= 1, true);
  } finally { ChannelPublisher.hub = previous; resetLogging(); }
});
