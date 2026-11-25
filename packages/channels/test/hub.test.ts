import { test } from "node:test";
import assert from "node:assert/strict";
import { Dto, Required, StringField, IntegerField, Scopes, Public } from "@pso/http";
import { Principal } from "@pso/security";
import {
  Channel, OnConnect, OnSubscribe, OnUnsubscribe, OnEvent, OnDisconnect, Payload, Client, Context, ChannelParam,
  ChannelHub, ChannelRegistry, LocalBus, ChannelError, CHANNELS_DEFAULTS, loadChannelsConfig, ChannelsConfigError, parsePattern, matchPattern, overlaps,
  type Connection, type ChannelsConfig, type ChannelContext, type ChannelClient, type ChannelEnvelope,
} from "../src/index.ts";

// decorators are applied by call (the test runner strips types but does not transform decorator syntax); generated projects use the @ syntax
type Dec = (...a: never[]) => void;
const apply = (cls: Function, members: Record<string, { method?: Dec[]; params?: Array<[number, Dec]> }>): void => {
  for (const [name, m] of Object.entries(members)) {
    for (const d of [...(m.method ?? [])].reverse()) (d as unknown as (t: object, k: string) => void)(cls.prototype as object, name);
    for (const [i, d] of m.params ?? []) (d as unknown as (t: object, k: string, i: number) => void)(cls.prototype as object, name, i);
  }
};
const dto = (cls: new () => unknown, fields: Record<string, Array<(t: object, k: string) => void>>): void => { Dto()(cls as never); for (const [n, ds] of Object.entries(fields)) for (const d of [...ds].reverse()) d(cls.prototype as object, n); };

class CandidateSubscription { candidateId!: string }
dto(CandidateSubscription, { candidateId: [Required(), StringField()] });
class Rate { stars!: number }
dto(Rate, { stars: [Required(), IntegerField()] });
class CandidateUpdated { candidateId!: string; status!: string }
dto(CandidateUpdated, { candidateId: [Required(), StringField()], status: [Required(), StringField()] });

const calls: string[] = [];
const owners = new Map([["c1", "alice"], ["c2", "bob"]]); // who may see which candidate (the application's business rule)

class RecruitmentChannel {
  async authorize(ctx: ChannelContext): Promise<boolean> { calls.push(`auth:${ctx.user?.subject}`); return ctx.user !== null; }
  async subscribeCandidate(p: CandidateSubscription, client: ChannelClient): Promise<string> { await client.join(`candidate.${p.candidateId}`); return "joined"; }
  rate(p: Rate): number { return p.stars; }
  async bye(client: ChannelClient): Promise<void> { calls.push(`disconnect:${client.id}`); }
  gate(): boolean { return true; }
}
Channel("recruitment", { visibility: "private" })(RecruitmentChannel);
apply(RecruitmentChannel, {
  gate: { method: [OnConnect() as Dec] },
  authorize: { method: [OnSubscribe() as Dec], params: [[0, Context() as Dec]] },
  subscribeCandidate: { method: [OnEvent("candidate.subscribe") as Dec, Scopes("candidate:read") as Dec], params: [[0, Payload(CandidateSubscription) as Dec], [1, Client() as Dec]] },
  rate: { method: [OnEvent("candidate.rate") as Dec], params: [[0, Payload(Rate) as Dec]] },
  bye: { method: [OnDisconnect() as Dec], params: [[0, Client() as Dec]] },
});

class CandidateChannel {
  async authorize(candidateId: string, ctx: ChannelContext): Promise<boolean> { return owners.get(candidateId) === ctx.user?.subject; }
  left(): void { calls.push("unsubscribe"); }
}
Channel("candidate.{candidateId}", { visibility: "private", publishers: ["recruitment-service"], events: { "candidate.updated": CandidateUpdated } })(CandidateChannel);
apply(CandidateChannel, { authorize: { method: [OnSubscribe() as Dec], params: [[0, ChannelParam("candidateId") as Dec], [1, Context() as Dec]] }, left: { method: [OnUnsubscribe() as Dec] } });

class NewsChannel { open(): boolean { return true; } }
Channel("news", { visibility: "public" })(NewsChannel);
apply(NewsChannel, { open: { method: [OnSubscribe() as Dec, Public() as Dec] } });

class RoomChannel { ok(): boolean { return true; } }
Channel("room.{roomId}", { visibility: "presence" })(RoomChannel);
apply(RoomChannel, { ok: { method: [OnSubscribe() as Dec] } });

class AuditChannel {}
Channel("audit", { visibility: "internal", publishers: ["audit-service"] })(AuditChannel);

// ---------------------------------------------------------------- harness
const principal = (subject: string, scopes: string[] = [], expiresInMs = 3_600_000): Principal => new Principal({ subject, issuer: "https://idp.test", audiences: ["pso-api"], scopes, roles: [], permissions: [], expiresAt: new Date(Date.now() + expiresInMs) });

class FakeConn implements Connection {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly correlationId = `corr-${this.id}-xxxxxxxx`;
  sent: Array<Record<string, unknown>> = [];
  closed: number | undefined;
  accept = true;
  principal: Principal | null;
  constructor(principal: Principal | null) { this.principal = principal; }
  send(frame: string): boolean { this.sent.push(JSON.parse(frame) as Record<string, unknown>); return this.accept; }
  close(code: number): void { this.closed = code; }
  events(): Array<Record<string, unknown>> { return this.sent.filter((m) => m["t"] === "event"); }
}

function build(over: Partial<ChannelsConfig> = {}, now?: () => number) {
  const registry = new ChannelRegistry();
  const problems = registry.add("recruitment", [RecruitmentChannel, CandidateChannel, NewsChannel, RoomChannel, AuditChannel]);
  assert.deepEqual(problems, []);
  const config: ChannelsConfig = { ...CHANNELS_DEFAULTS, ...over };
  const bus = new LocalBus();
  const instances = new Map<unknown, unknown>();
  const hub = new ChannelHub({
    registry, config, bus, service: "orchestrator", ...(now ? { now } : {}),
    resolve: (c) => { if (!instances.has(c)) instances.set(c, new (c as new () => object)()); return instances.get(c) as Record<string, (...a: unknown[]) => unknown>; },
    authorize: (p, need) => need.scopes.every((s) => p.hasScope(s)),
  });
  return { hub, registry };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { if (e instanceof ChannelError) return e.code; throw e; } return "none"; };
const env = (channel: string, type: string, payload: unknown, source = "recruitment-service"): ChannelEnvelope => ({ v: 1, id: `evt-${Math.random().toString(36).slice(2)}${Date.now()}`, type, channel, ts: new Date().toISOString(), source, payload });

// ---------------------------------------------------------------- patterns and registration
test("patterns: deterministic matching, validated parameters, ambiguity detected", () => {
  const p = parsePattern("employee.{employeeId}");
  assert.deepEqual({ ...matchPattern(p, "employee.e-42") }, { employeeId: "e-42" });
  for (const bad of ["employee", "employee.a.b", "employee.", "employee.a b", "employee.a/b", "employee.<script>", "employee." + "x".repeat(65), "other.e-1", "employee.e1" + String.fromCharCode(10), "Employee.e1", "employee.e1;drop"]) assert.equal(matchPattern(p, bad), undefined, JSON.stringify(bad));
  assert.deepEqual({ ...matchPattern(parsePattern("/recruitment"), "recruitment") }, {}, "a leading slash is accepted and ignored");
  assert.ok(overlaps(parsePattern("a.{x}"), parsePattern("a.b")), "a parameter overlaps a literal");
  assert.ok(!overlaps(parsePattern("a.{x}"), parsePattern("b.{x}")));
  assert.ok(!overlaps(parsePattern("a.{x}"), parsePattern("a.{x}.c")));
  for (const bad of ["", "A.b", "a..b", "a.{}", "a.{1x}", "a.{x}.{x}", "a.{x", "a.b c", "a.{x}y", "a." + "b.".repeat(9) + "c"]) assert.throws(() => parsePattern(bad), undefined, JSON.stringify(bad));
});

test("registration: nothing is active unless registered; duplicates, ambiguity and invalid metadata fail with precise messages", () => {
  class NotDecorated {}
  class Dup1 {} class Dup2 {} class Amb1 {} class Amb2 {} class TwoSubs { a(): boolean { return true; } b(): boolean { return true; } }
  Channel("dup")(Dup1); Channel("dup")(Dup2); Channel("zone.{id}", { visibility: "private" })(Amb1); Channel("zone.north", { visibility: "private" })(Amb2);
  Channel("two")(TwoSubs); apply(TwoSubs, { a: { method: [OnSubscribe() as Dec] }, b: { method: [OnSubscribe() as Dec] } });
  const r = new ChannelRegistry();
  assert.match(r.add("m", [NotDecorated]).join(), /not decorated with @Channel/);
  assert.deepEqual(r.channels, []);
  assert.match(r.add("m", [Dup1, Dup2]).join(), /duplicate channel "dup"/);
  assert.match(r.add("m", [Amb1, Amb2]).join(), /ambiguous channels/);
  assert.match(r.add("m", [TwoSubs]).join(), /duplicate handler/);
  assert.equal(r.channels.length, 0, "a module with problems registers nothing");
  assert.deepEqual(new ChannelRegistry().add("a", [Dup1]), []);
  const reg = new ChannelRegistry();
  reg.add("a", [Dup1]);
  assert.match(reg.add("b", [Dup2]).join(), /duplicate channel "dup" \(module b and a\)/, "duplicates across modules are caught");
  assert.match(reg.add("b", [Dup1]).join(), /registered twice/);
  class NoAuthz { x(): void {} }
  Channel("secret.{id}")(NoAuthz);
  assert.match(new ChannelRegistry().add("m", [NoAuthz]).join(), /needs an @OnSubscribe method that authorizes the requested resource/, "authentication alone never grants access to a parameterized channel");
  class BadParam { a(): boolean { return true; } }
  Channel("p.{id}")(BadParam); apply(BadParam, { a: { method: [OnSubscribe() as Dec], params: [[0, ChannelParam("other") as Dec]] } });
  assert.match(new ChannelRegistry().add("m", [BadParam]).join(), /asks for @ChannelParam\("other"\)/);
  class InternalWithClient { a(): boolean { return true; } }
  Channel("int", { visibility: "internal" })(InternalWithClient); apply(InternalWithClient, { a: { method: [OnSubscribe() as Dec] } });
  assert.match(new ChannelRegistry().add("m", [InternalWithClient]).join(), /internal channel cannot have client handlers/);
  class PublicNoPublic { a(): boolean { return true; } }
  Channel("pub", { visibility: "public" })(PublicNoPublic); apply(PublicNoPublic, { a: { method: [OnSubscribe() as Dec] } });
  assert.match(new ChannelRegistry().add("m", [PublicNoPublic]).join(), /must be marked @Public/);
  class PayloadPlain { a(_p: unknown): void {} }
  class NotADto {}
  Channel("pl")(PayloadPlain); apply(PayloadPlain, { a: { method: [OnEvent("x.y") as Dec], params: [[0, Payload(NotADto) as Dec]] } });
  assert.match(new ChannelRegistry().add("m", [PayloadPlain]).join(), /must be decorated with @Dto/);
  assert.throws(() => Channel("Bad Name"), /invalid/);
  assert.throws(() => OnEvent("Bad Event"), /dotted lower-case/);
});

// ---------------------------------------------------------------- subscription and authorization
test("authentication and channel-level authorization: anonymous callers reach only public channels", async () => {
  const { hub } = build();
  const anon = new FakeConn(null);
  await hub.connect(anon);
  assert.equal(await code(hub.subscribe(anon, "recruitment")), "PSO_CHANNEL_UNAUTHENTICATED");
  await hub.subscribe(anon, "news");
  assert.equal(hub.subscribers("news"), 1);
  const alice = new FakeConn(principal("alice"));
  await hub.connect(alice);
  await hub.subscribe(alice, "/recruitment");
  assert.deepEqual(hub.metrics().subscriptions, 2);
});

test("resource-level authorization: a valid user is not authorized for every resource, and denial looks the same as absence", async () => {
  const { hub } = build();
  const alice = new FakeConn(principal("alice", ["candidate:read"]));
  await hub.connect(alice);
  await hub.subscribe(alice, "candidate.c1");
  assert.equal(await code(hub.subscribe(alice, "candidate.c2")), "PSO_CHANNEL_FORBIDDEN", "bob's candidate");
  assert.equal(await code(hub.subscribe(alice, "candidate.c999")), "PSO_CHANNEL_FORBIDDEN", "a candidate that does not exist gives the identical answer");
  assert.equal(await code(hub.subscribe(alice, "candidate.c1.extra")), "PSO_CHANNEL_INVALID_CHANNEL");
  assert.equal(await code(hub.subscribe(alice, "candidate.bad id")), "PSO_CHANNEL_INVALID_CHANNEL");
  assert.equal(await code(hub.subscribe(alice, "candidate.../x")), "PSO_CHANNEL_INVALID_CHANNEL");
  assert.equal(await code(hub.subscribe(alice, "nope")), "PSO_CHANNEL_INVALID_CHANNEL");
  assert.equal(await code(hub.subscribe(alice, "audit")), "PSO_CHANNEL_INVALID_CHANNEL", "an internal channel is not subscribable: it looks like a channel that does not exist");
  assert.equal(await code(hub.subscribe(alice, 42 as never)), "PSO_CHANNEL_INVALID_CHANNEL");
  const bob = new FakeConn(principal("bob"));
  await hub.connect(bob);
  await hub.subscribe(bob, "candidate.c2");
  assert.equal(hub.subscribers("candidate.c1"), 1); assert.equal(hub.subscribers("candidate.c2"), 1);
  assert.equal(hub.metrics().deniedSubscriptions, 2, "the two resource denials (the malformed names never reached authorization)");
});

test("an authorizer that throws, or answers anything but true, denies", async () => {
  class Sloppy { a(): unknown { return "yes"; } }
  class Boom { a(): boolean { throw new Error("db down"); } }
  Channel("sloppy")(Sloppy); Channel("boom")(Boom);
  apply(Sloppy, { a: { method: [OnSubscribe() as Dec] } }); apply(Boom, { a: { method: [OnSubscribe() as Dec] } });
  const registry = new ChannelRegistry(); assert.deepEqual(registry.add("m", [Sloppy, Boom]), []);
  const hub = new ChannelHub({ registry, config: CHANNELS_DEFAULTS, bus: new LocalBus(), service: "o", resolve: (c) => new (c as new () => Record<string, (...a: unknown[]) => unknown>)(), authorize: () => true });
  const c = new FakeConn(principal("u")); await hub.connect(c);
  assert.equal(await code(hub.subscribe(c, "sloppy")), "PSO_CHANNEL_FORBIDDEN");
  assert.equal(await code(hub.subscribe(c, "boom")), "PSO_CHANNEL_FORBIDDEN");
});

// ---------------------------------------------------------------- client commands
test("client events: subscription required, scopes enforced, DTO validated strictly, unknown events refused, no arbitrary invocation", async () => {
  const { hub } = build();
  const c = new FakeConn(principal("alice", []));
  await hub.connect(c);
  assert.equal(await code(hub.handleEvent(c, "recruitment", "candidate.rate", { stars: 5 })), "PSO_CHANNEL_FORBIDDEN", "not subscribed to the channel");
  await hub.subscribe(c, "recruitment");
  assert.equal(await hub.handleEvent(c, "recruitment", "candidate.rate", { stars: 5 }), 5);
  assert.equal(await code(hub.handleEvent(c, "recruitment", "candidate.subscribe", { candidateId: "c1" })), "PSO_CHANNEL_FORBIDDEN", "the handler needs candidate:read");
  assert.equal(await code(hub.handleEvent(c, "recruitment", "candidate.delete", {})), "PSO_CHANNEL_UNKNOWN_EVENT");
  assert.equal(await code(hub.handleEvent(c, "recruitment", "authorize", {})), "PSO_CHANNEL_UNKNOWN_EVENT", "method names are not events");
  assert.equal(await code(hub.handleEvent(c, "recruitment", "constructor", {})), "PSO_CHANNEL_UNKNOWN_EVENT");
  for (const bad of [{ stars: "5" }, { stars: 5, admin: true }, {}, null, [], "x", { stars: 5.5 }, JSON.parse('{"stars":5,"__proto__":{"x":1}}')]) {
    let err: ChannelError | undefined;
    try { await hub.handleEvent(c, "recruitment", "candidate.rate", bad); } catch (e) { err = e as ChannelError; }
    assert.equal(err?.code, "PSO_CHANNEL_INVALID_PAYLOAD", JSON.stringify(bad));
    assert.ok(!JSON.stringify(err?.errors).includes("admin\":true"), "values are never echoed");
  }
  const scoped = new FakeConn(principal("alice", ["candidate:read"]));
  await hub.connect(scoped); await hub.subscribe(scoped, "recruitment");
  assert.equal(await hub.handleEvent(scoped, "recruitment", "candidate.subscribe", { candidateId: "c1" }), "joined");
  assert.deepEqual(scoped.sent.filter((m) => m["t"] === "error"), []);
  assert.equal(hub.subscribers("candidate.c1"), 1, "client.join() ran the normal authorization pipeline");
  assert.equal(await code(hub.handleEvent(scoped, "recruitment", "candidate.subscribe", { candidateId: "c2" })), "PSO_CHANNEL_FORBIDDEN", "join cannot bypass resource authorization");
  assert.equal(await code(hub.handleEvent(scoped, "audit", "anything", {})), "PSO_CHANNEL_INVALID_CHANNEL");
});

// ---------------------------------------------------------------- server events
test("server events reach only authorized subscribers; a client cannot produce one", async () => {
  const { hub } = build();
  const alice = new FakeConn(principal("alice")), bob = new FakeConn(principal("bob")), anon = new FakeConn(null);
  for (const c of [alice, bob, anon]) await hub.connect(c);
  await hub.subscribe(alice, "candidate.c1"); await hub.subscribe(bob, "candidate.c2"); await hub.subscribe(anon, "news");
  await hub.ingest(env("candidate.c1", "candidate.updated", { candidateId: "c1", status: "HIRED" }));
  await tick();
  assert.equal(alice.events().length, 1);
  assert.equal(bob.events().length, 0, "bob is not subscribed to alice's candidate");
  assert.equal(anon.events().length, 0);
  const e = alice.events()[0]!;
  assert.equal(e["v"], 1); assert.equal(e["type"], "candidate.updated"); assert.equal(e["channel"], "candidate.c1");
  assert.deepEqual(e["payload"], { candidateId: "c1", status: "HIRED" });
  assert.ok(typeof e["eventId"] === "string" && typeof e["ts"] === "string");
  assert.ok(!("source" in e), "the envelope delivered to browsers carries no internal source and no credentials");
  // a command frame can only invoke @OnEvent handlers; it can never fan out to other connections
  await hub.subscribe(alice, "recruitment");
  await hub.subscribe(bob, "recruitment");
  await hub.handleEvent(alice, "recruitment", "candidate.rate", { stars: 1 });
  await tick();
  assert.equal(bob.events().length, 0);
});

test("publishing is a separate permission: unknown sources, unknown channels, bad contracts and malformed envelopes are refused", async () => {
  const { hub } = build();
  const alice = new FakeConn(principal("alice")); await hub.connect(alice); await hub.subscribe(alice, "candidate.c1");
  const refused = async (e: unknown, src?: string): Promise<string> => { try { await hub.ingest(e, src); return "accepted"; } catch (x) { return (x as Error).message; } };
  assert.match(await refused(env("candidate.c1", "candidate.updated", { candidateId: "c1", status: "X" }, "rogue-service")), /not allowed to publish/);
  assert.match(await refused(env("candidate.c1", "candidate.updated", { candidateId: "c1", status: "X" }, "recruitment-service"), "rogue-service"), /not allowed to publish/, "the transport-authenticated source wins over the claimed one");
  assert.equal(await refused(env("candidate.c1", "candidate.updated", { candidateId: "c1", status: "X" }, "rogue"), "recruitment-service"), "accepted", "...and a trusted source is accepted whatever the payload claims");
  assert.match(await refused(env("candidate.c1", "candidate.deleted", {})), /not part of the channel contract/);
  assert.match(await refused(env("candidate.c1", "candidate.updated", { candidateId: 7, status: "X", extra: 1 })), /does not match its contract/);
  assert.match(await refused(env("nope", "a.b", {})), /not registered/);
  assert.match(await refused(env("recruitment", "a.b", {})), /not allowed to publish/, "no publishers declared: services cannot publish");
  assert.match(await refused({ ...env("candidate.c1", "candidate.updated", {}), v: 2 }), /unsupported protocol version/);
  assert.match(await refused({ ...env("candidate.c1", "candidate.updated", {}), extra: true }), /unknown envelope field/);
  assert.match(await refused({ ...env("candidate.c1", "Bad Type", {}) }), /invalid type/);
  assert.match(await refused("string"), /must be an object/);
  assert.match(await refused(env("audit", "a.b", {}, "intruder")), /not allowed to publish/);
  assert.equal(await refused(env("audit", "a.b", { ok: true }, "audit-service")), "accepted", "internal channels take events from their declared publishers...");
  await tick();
  assert.equal(alice.events().length, 1, "...but only the one accepted candidate event was delivered");
  const huge = env("candidate.c1", "candidate.updated", { candidateId: "c1", status: "x".repeat(70_000) });
  assert.match(await refused(huge), /payload too large/);
  assert.equal(hub.metrics().invalidEvents >= 9, true);
});

test("internal channels: in-process listeners only, never a browser", async () => {
  const { hub } = build();
  const seen: string[] = [];
  const off = hub.onInternal("audit", (e) => seen.push(e.type));
  await hub.ingest(env("audit", "audit.logged", {}, "audit-service"));
  await tick();
  off();
  await hub.ingest(env("audit", "audit.logged", {}, "audit-service"));
  await tick();
  assert.deepEqual(seen, ["audit.logged"]);
});

test("local publication validates the contract and returns the event id; duplicate event ids are delivered once", async () => {
  const { hub } = build();
  const alice = new FakeConn(principal("alice")); await hub.connect(alice); await hub.subscribe(alice, "candidate.c1");
  const e = await hub.publish("candidate.c1", "candidate.updated", { candidateId: "c1", status: "OK" }, { correlationId: "corr-publish-0001" });
  await tick();
  assert.equal(alice.events()[0]!["eventId"], e.id);
  assert.equal(alice.events()[0]!["correlationId"], "corr-publish-0001");
  await assert.rejects(hub.publish("candidate.c1", "candidate.updated", { candidateId: 1 }), /contract/);
  await assert.rejects(hub.publish("ghost", "a.b", {}), (x: ChannelError) => x.code === "PSO_CHANNEL_INVALID_CHANNEL");
  const dup = env("candidate.c1", "candidate.updated", { candidateId: "c1", status: "2" });
  await hub.ingest(dup); await hub.ingest(dup); await tick();
  assert.equal(alice.events().length, 2, "the duplicate was suppressed");
  assert.equal(hub.metrics().duplicates, 1);
});

// ---------------------------------------------------------------- lifecycle, limits, identity changes
test("disconnect cleans up everything: subscriptions, presence, handlers called; unsubscribe runs the hook", async () => {
  calls.length = 0;
  const { hub } = build();
  const a = new FakeConn(principal("alice")); await hub.connect(a);
  await hub.subscribe(a, "recruitment"); await hub.subscribe(a, "candidate.c1"); await hub.subscribe(a, "room.r1");
  assert.equal(hub.presenceOf("room.r1").length, 1);
  await hub.unsubscribe(a, "candidate.c1");
  assert.ok(calls.includes("unsubscribe"));
  await hub.disconnect(a);
  await hub.disconnect(a);
  assert.deepEqual(hub.metrics(), { ...hub.metrics(), connections: 0, subscriptions: 0 });
  assert.equal(hub.presenceOf("room.r1").length, 0);
  assert.ok(calls.includes(`disconnect:${a.id}`));
  assert.equal(await code(hub.subscribe(a, "recruitment")), "PSO_CHANNEL_UNAVAILABLE", "a closed connection cannot be used");
});

test("limits: subscriptions per connection, subscribers per channel, connections, rate with burst and refill, slow consumers", async () => {
  let t = 0;
  const { hub } = build({ maxSubscriptionsPerConnection: 2, maxConnections: 3, ratePerSecond: 2, burst: 3 }, () => t);
  const c = new FakeConn(principal("alice")); await hub.connect(c);
  await hub.subscribe(c, "recruitment"); await hub.subscribe(c, "candidate.c1");
  assert.equal(await code(hub.subscribe(c, "news")), "PSO_CHANNEL_SUBSCRIPTION_LIMIT");
  await hub.subscribe(c, "recruitment"); // already subscribed: no extra slot used
  for (let i = 0; i < 3; i++) hub.admit(c);
  assert.throws(() => hub.admit(c), (e: ChannelError) => e.code === "PSO_CHANNEL_RATE_LIMITED");
  t += 1000; hub.admit(c); hub.admit(c);
  assert.throws(() => hub.admit(c), (e: ChannelError) => e.code === "PSO_CHANNEL_RATE_LIMITED");
  assert.ok(hub.metrics().rateLimited >= 2);
  await hub.connect(new FakeConn(null)); await hub.connect(new FakeConn(null));
  assert.equal(await hub.connect(new FakeConn(null)), false, "maximum connections");
  const slow = new FakeConn(principal("bob")); slow.accept = false;
  const { hub: hub2 } = build();
  await hub2.connect(slow); await hub2.subscribe(slow, "candidate.c2");
  await hub2.publish("candidate.c2", "candidate.updated", { candidateId: "c2", status: "S" });
  await tick();
  assert.equal(slow.closed, 4429, "a connection that cannot keep up is closed, its queue never grows without bound");
  assert.equal(hub2.metrics().slowConsumers, 1);
});

test("identity changes: renewal re-authorizes, another subject is refused, expiry and revocation remove authorized subscriptions only", async () => {
  const { hub } = build();
  const c = new FakeConn(principal("alice")); await hub.connect(c);
  await hub.subscribe(c, "candidate.c1"); await hub.subscribe(c, "recruitment");
  await assert.rejects(hub.authenticated(c, principal("mallory")), (e: ChannelError) => e.code === "PSO_CHANNEL_FORBIDDEN");
  await hub.authenticated(c, principal("alice", ["x"]));
  assert.equal(c.principal?.hasScope("x"), true);
  owners.set("c1", "someone-else"); // permissions change in the application...
  await hub.authenticated(c, principal("alice")); // ...and the next renewal notices
  assert.equal(hub.subscribers("candidate.c1"), 0);
  assert.ok(c.sent.some((m) => m["t"] === "unsubscribed" && m["channel"] === "candidate.c1"), "the client is told");
  assert.equal(hub.subscribers("recruitment"), 1);
  owners.set("c1", "alice");
  await hub.subscribe(c, "candidate.c1");
  assert.equal(await hub.revoke({ subject: "alice", channel: "candidate.c1" }), 1);
  await hub.subscribe(c, "news");
  await hub.expire(c);
  assert.equal(hub.subscribers("recruitment"), 0, "authorized subscriptions end when the credentials expire");
  assert.equal(hub.subscribers("news"), 1, "public subscriptions stay");
  assert.equal(await code(hub.subscribe(c, "recruitment")), "PSO_CHANNEL_UNAUTHENTICATED");
  const old = new FakeConn(principal("alice", [], -1000)); await hub.connect(old);
  assert.equal(await code(hub.subscribe(old, "recruitment")), "PSO_CHANNEL_TOKEN_EXPIRED");
});

test("connection refusal: an @OnConnect handler that returns false closes the connection before anything else", async () => {
  class Gate { g(): boolean { return false; } }
  Channel("gate", { visibility: "public" })(Gate); apply(Gate, { g: { method: [OnConnect() as Dec] } });
  const registry = new ChannelRegistry(); registry.add("m", [Gate]);
  const hub = new ChannelHub({ registry, config: CHANNELS_DEFAULTS, bus: new LocalBus(), service: "o", resolve: (c) => new (c as new () => Record<string, (...a: unknown[]) => unknown>)(), authorize: () => true });
  const c = new FakeConn(principal("a"));
  assert.equal(await hub.connect(c), false);
  assert.equal(hub.connectionCount, 0);
});

test("presence: join, leave, several connections of one user, sync only for authorized subscribers", async () => {
  const { hub } = build();
  const a1 = new FakeConn(principal("alice")), a2 = new FakeConn(principal("alice")), b = new FakeConn(principal("bob")), anon = new FakeConn(null);
  for (const c of [a1, a2, b, anon]) await hub.connect(c);
  await hub.subscribe(a1, "room.r1");
  assert.deepEqual(a1.sent.find((m) => m["t"] === "presence")?.["members"], ["alice"]);
  await hub.subscribe(b, "room.r1");
  assert.deepEqual(b.sent.find((m) => m["event"] === "sync")?.["members"], ["alice", "bob"]);
  assert.ok(a1.sent.some((m) => m["event"] === "join" && m["member"] === "bob"));
  await hub.subscribe(a2, "room.r1");
  assert.equal(b.sent.filter((m) => m["event"] === "join" && m["member"] === "alice").length, 0, "a second connection of the same user is not a new participant");
  assert.equal(await code(hub.subscribe(anon, "room.r1")), "PSO_CHANNEL_UNAUTHENTICATED", "no participant list for the unauthenticated");
  await hub.disconnect(a1);
  assert.ok(!b.sent.some((m) => m["event"] === "leave" && m["member"] === "alice"), "alice is still present through her other connection");
  await hub.disconnect(a2);
  assert.ok(b.sent.some((m) => m["event"] === "leave" && m["member"] === "alice"));
  assert.deepEqual(hub.presenceOf("room.r1"), ["bob"]);
  for (const m of b.sent) assert.ok(!JSON.stringify(m).includes("issuer"), "presence carries opaque subject ids only");
});

// ---------------------------------------------------------------- configuration
test("configuration: validated, layered, and production refuses insecure settings", () => {
  const ok = loadChannelsConfig(undefined, {});
  assert.equal(ok.path, "/channels"); assert.equal(ok.allowAnonymous, false); assert.equal(ok.bus, "local");
  const e = (env: Record<string, string>): string[] => { try { loadChannelsConfig(undefined, env); return []; } catch (x) { assert.ok(x instanceof ChannelsConfigError); return x.problems; } };
  assert.match(e({ PSO_CHANNELS_PATH: "/health/x" }).join(), /channels.path/);
  assert.match(e({ PSO_CHANNELS_ALLOWED_ORIGINS: "*" }).join(), /wildcards are refused/);
  assert.match(e({ PSO_CHANNELS_ALLOWED_ORIGINS: "https://*.example.com" }).join(), /not an exact origin/);
  assert.match(e({ PSO_CHANNELS_MAX_CONNECTIONS: "0" }).join(), /maxConnections/);
  assert.match(e({ PSO_CHANNELS_MAX_MESSAGE_BYTES: "12" }).join(), /maxMessageBytes/);
  assert.match(e({ PSO_CHANNELS_BUS: "kafka" }).join(), /"local" or "redis"/);
  assert.match(e({ PSO_CHANNELS_BUS: "redis" }).join(), /redisUrl/);
  assert.match(e({ PSO_CHANNELS_BURST: "1", PSO_CHANNELS_RATE_PER_SECOND: "5" }).join(), /burst/);
  const prod = { NODE_ENV: "production" };
  assert.match(e(prod).join("\n"), /allowedOrigins/);
  assert.match(e({ ...prod, PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.com" }).join("\n"), /bus="local" delivers only/);
  assert.match(e({ ...prod, PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.com", PSO_CHANNELS_ALLOW_ANONYMOUS: "true", PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_REDIS_URL: "redis://r:6379" }).join("\n"), /allowAnonymous/);
  // a distributed bus in production must be authenticated (SEC-01): the secret is part of a valid production configuration
  assert.match(e({ ...prod, PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.com", PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_REDIS_URL: "redis://r:6379" }).join("\n"), /requires PSO_CHANNELS_BUS_SECRET/);
  assert.deepEqual(e({ ...prod, PSO_CHANNELS_ALLOWED_ORIGINS: "https://app.example.com", PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_REDIS_URL: "redis://r:6379", PSO_CHANNELS_BUS_SECRET: "s".repeat(32) }), []);
  assert.deepEqual(e({ ...prod, PSO_CHANNELS_ENABLED: "false" }), [], "disabled channels need nothing");
});
