import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import WebSocket from "ws";
import { createPsoChannels, type ChannelEvent, type ChannelsError, type ConnectionState } from "@pso/channels/client";
import { expectProblem } from "./gw-fixture.ts";
import { launch, sleep, until, connections, update, SCOPES, type Launched } from "./channels-fixture.ts";

/** a raw protocol client (the `ws` package) for hostile and low-level cases */
function raw(url: string, opts: { headers?: Record<string, string> } = {}) {
  const ws = new WebSocket(url, "pso.channels.v1", { headers: opts.headers });
  const frames: Array<Record<string, unknown>> = [];
  let closed: { code: number } | undefined;
  ws.on("message", (d) => frames.push(JSON.parse(d.toString()) as Record<string, unknown>));
  ws.on("close", (code) => { closed = { code }; });
  ws.on("error", () => undefined);
  return { ws, frames, get closed() { return closed; }, open: () => new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_q, r) => rej(Object.assign(new Error("refused"), { status: r.statusCode }))); }), send: (m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m)) };
}

test("the full flow: authenticated subscription, resource-level authorization, typed delivery, denial and cleanup", { timeout: 400_000 }, async () => {
  const a = await launch();
  const clients: Array<{ close(): void }> = [];
  try {
    const aliceToken = await a.token("alice", SCOPES), bobToken = await a.token("bob", SCOPES), writer = await a.token("writer", "candidate:write");
    const aliceEvents: ChannelEvent[] = [], bobEvents: ChannelEvent[] = [];
    const aliceErrors: ChannelsError[] = [], bobErrors: ChannelsError[] = [];
    const alice = createPsoChannels({ url: a.ws, getToken: () => aliceToken });
    const bob = createPsoChannels({ url: a.ws, getToken: () => bobToken });
    clients.push(alice, bob);
    let aliceIn = false, bobIn = false, aliceC1 = false;
    alice.subscribe("recruitment", { onEvent: () => undefined, onSubscribed: (x) => { aliceIn = x; }, onError: (e) => aliceErrors.push(e) });
    bob.subscribe("recruitment", { onEvent: () => undefined, onSubscribed: (x) => { bobIn = x; }, onError: (e) => bobErrors.push(e) });
    await until(() => aliceIn && bobIn);
    // resource-level authorization: same valid scopes, different resources (alice owns c1, bob owns c2)
    alice.subscribe("candidate.c1", { onEvent: (e) => aliceEvents.push(e), onSubscribed: (x) => { aliceC1 = x; }, onError: (e) => aliceErrors.push(e) });
    bob.subscribe("candidate.c1", { onEvent: (e) => bobEvents.push(e), onError: (e) => bobErrors.push(e) });
    await until(() => aliceC1 && bobErrors.length > 0);
    assert.deepEqual({ code: bobErrors[0]!.code, message: bobErrors[0]!.message }, { code: "PSO_CHANNEL_FORBIDDEN", message: "Not allowed." });
    alice.subscribe("candidate.nobody", { onEvent: () => undefined, onError: (e) => aliceErrors.push(e) });
    await until(() => aliceErrors.length > 0);
    assert.deepEqual({ code: aliceErrors[0]!.code, message: aliceErrors[0]!.message }, { code: "PSO_CHANNEL_FORBIDDEN", message: "Not allowed." }, "a candidate that does not exist is indistinguishable from one the caller may not see");
    // a client COMMAND, DTO-validated, that joins another resource through the same pipeline
    assert.deepEqual(await alice.send("recruitment", "candidate.subscribe", { candidateId: "c1" }), { joined: "c1" });
    await assert.rejects(alice.send("recruitment", "candidate.subscribe", { candidateId: "c2" }), (e: ChannelsError) => e.code === "PSO_CHANNEL_FORBIDDEN");
    await assert.rejects(alice.send("recruitment", "candidate.subscribe", { candidateId: 7 }), (e: ChannelsError) => e.code === "PSO_CHANNEL_INVALID_PAYLOAD" && e.errors?.[0]?.field === "candidateId");
    await assert.rejects(alice.send("recruitment", "candidate.subscribe", { candidateId: "c1", admin: true }), (e: ChannelsError) => e.code === "PSO_CHANNEL_INVALID_PAYLOAD");
    await assert.rejects(alice.send("recruitment", "delete.everything", {}), (e: ChannelsError) => e.code === "PSO_CHANNEL_UNKNOWN_EVENT");
    // an application service updates the candidate: the typed event reaches ONLY the authorized subscriber
    const r = await update(a, writer, "c1", "HIRED");
    assert.equal(r.status, 201, await r.clone().text());
    await until(() => aliceEvents.length === 1);
    const ev = aliceEvents[0]!;
    assert.deepEqual({ type: ev.type, channel: ev.channel, payload: ev.payload }, { type: "candidate.updated", channel: "candidate.c1", payload: { candidateId: "c1", status: "HIRED" } });
    assert.equal(ev.eventId, ((await r.json()) as { eventId: string }).eventId);
    await sleep(200);
    assert.equal(bobEvents.length, 0, "bob never receives alice's candidate");
    // the contract rejects an invalid event before anything is delivered; the HTTP side is unchanged and authenticated as before
    await expectProblem(await update(a, writer, "c1", "FIRED-BY-MISTAKE"), 400, "PSO_VALIDATION_FAILED");
    await expectProblem(await update(a, aliceToken, "c1", "HIRED"), 403, "PSO_AUTH_FORBIDDEN");
    assert.equal((await fetch(a.http("/health/live"))).status, 200);
    // disconnect cleanup
    assert.equal(await connections(a), 2);
    alice.close(); bob.close();
    for (let i = 0; i < 80 && (await connections(a)) !== 0; i++) await sleep(50);
    assert.equal(await connections(a), 0, "closed connections are removed from the hub");
  } finally { for (const c of clients) c.close(); a.child.kill(); }
});

test("connection security: origin, authentication timeout, bad tokens, expired credentials, unregistered channels", { timeout: 400_000 }, async () => {
  const a = await launch();
  try {
    // cross-site WebSocket hijacking: a browser Origin that is not allowed is refused BEFORE the upgrade, with an HTTP problem
    const evil = raw(a.ws, { headers: { origin: "https://evil.example" } });
    await assert.rejects(evil.open(), (e: Error & { status?: number }) => e.status === 403);
    const same = raw(a.ws, { headers: { origin: `http://127.0.0.1:${a.port}` } }); // development: same origin
    await same.open(); same.ws.close();
    await assert.rejects(raw(`ws://127.0.0.1:${a.port}/nope`).open(), (e: Error & { status?: number }) => e.status === 404);
    await assert.rejects(raw(a.ws, { headers: { authorization: "Bearer not-a-jwt" } }).open(), (e: Error & { status?: number }) => e.status === 401);
    // never authenticates: closed after the timeout (anonymous connections are off by default)
    const idle = raw(a.ws); await idle.open();
    await until(() => idle.closed !== undefined, 6000);
    assert.equal(idle.closed!.code, 4401);
    // anonymous reaches nothing private even before the timeout
    const anon = raw(a.ws); await anon.open();
    anon.send({ v: 1, t: "subscribe", id: "1", channel: "recruitment" });
    await until(() => anon.frames.some((f) => f["t"] === "error"));
    assert.equal(anon.frames.find((f) => f["t"] === "error")!["code"], "PSO_CHANNEL_UNAUTHENTICATED");
    anon.send({ v: 1, t: "auth", token: "x.y.z" });
    await until(() => anon.closed !== undefined);
    assert.equal(anon.closed!.code, 4401);
    // a token signed by another key is not a valid token
    const other = await generateKeyPair("ES256");
    const forged = await new SignJWT({ scope: SCOPES }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject("alice").setExpirationTime("10m").sign(other.privateKey);
    const f = raw(a.ws); await f.open(); f.send({ v: 1, t: "auth", token: forged });
    await until(() => f.closed !== undefined); assert.equal(f.closed!.code, 4401);
    // authenticated: unregistered (ghost) and malformed channels do not exist; the decorated class that was NOT registered stays inactive
    const c = raw(a.ws, { headers: { authorization: `Bearer ${await a.token("alice", SCOPES)}` } }); await c.open();
    await until(() => c.frames.some((x) => x["t"] === "ready"));
    for (const [i, ch] of ["ghost", "nope", "candidate.c1.x", "../../etc/passwd", "candidate.<b>"].entries()) c.send({ v: 1, t: "subscribe", id: `g${i}`, channel: ch });
    await until(() => c.frames.filter((x) => x["t"] === "error").length === 5);
    assert.deepEqual([...new Set(c.frames.filter((x) => x["t"] === "error").map((x) => x["code"]))], ["PSO_CHANNEL_INVALID_CHANNEL"]);
    // credentials that expire: authorized subscriptions end, the client is told
    const short = raw(a.ws, { headers: { authorization: `Bearer ${await a.token("alice", SCOPES, [], 3)}` } }); await short.open();
    short.send({ v: 1, t: "subscribe", id: "s1", channel: "recruitment" });
    await until(() => short.frames.some((x) => x["t"] === "ack" && x["id"] === "s1"));
    await until(() => short.frames.some((x) => x["code"] === "PSO_CHANNEL_TOKEN_EXPIRED"), 9000);
    short.send({ v: 1, t: "subscribe", id: "s2", channel: "recruitment" });
    await until(() => short.frames.some((x) => x["id"] === "s2" && x["t"] === "error"));
    assert.equal(short.frames.find((x) => x["id"] === "s2")!["code"], "PSO_CHANNEL_UNAUTHENTICATED", "the client was told the credentials expired; until it renews it is anonymous again");
    short.send({ v: 1, t: "auth", token: await a.token("alice", SCOPES) });
    short.send({ v: 1, t: "subscribe", id: "s3", channel: "recruitment" });
    await until(() => short.frames.some((x) => x["id"] === "s3" && x["t"] === "ack"));
    short.send({ v: 1, t: "auth", token: await a.token("mallory", SCOPES) }); // another identity on the same connection
    await until(() => short.closed !== undefined); assert.equal(short.closed!.code, 4403);
  } finally { a.child.kill(); }
});

test("hostile frames: malformed JSON, binary, wrong version, oversize and floods are bounded and answered with stable codes", { timeout: 400_000 }, async () => {
  const a = await launch("RecruitmentChannel, CandidateChannel", { PSO_CHANNELS_RATE_PER_SECOND: "5", PSO_CHANNELS_BURST: "10", PSO_CHANNELS_MAX_SUBSCRIPTIONS: "2" });
  try {
    const hdr = { authorization: `Bearer ${await a.token("alice", SCOPES)}` };
    const c = raw(a.ws, { headers: hdr }); await c.open();
    const errs = (): string[] => c.frames.filter((x) => x["t"] === "error").map((x) => String(x["code"]));
    c.send("{not json"); c.send("[]"); c.send("\"str\""); c.ws.send(Buffer.from([1, 2, 3]));
    c.send({ v: 1, t: "frobnicate" }); c.send({ v: 1, t: "event", channel: 5, event: {} });
    await until(() => errs().length === 6);
    assert.deepEqual([...new Set(errs())], ["PSO_CHANNEL_BAD_FRAME"]);
    for (const m of c.frames.filter((x) => x["t"] === "error")) assert.deepEqual(Object.keys(m).sort(), ["code", "message", "t", "v"], "an error frame carries a stable code and fixed text only: no stack, no echo of the input");
    for (let i = 0; i < 40; i++) c.send({ v: 1, t: "ping" }); // a flood is rate limited, not served and not fatal
    await until(() => errs().includes("PSO_CHANNEL_RATE_LIMITED"));
    await sleep(2200);
    const d = raw(a.ws, { headers: hdr }); await d.open();
    for (const [i, ch] of ["recruitment", "candidate.c1", "candidate.c1"].entries()) { d.send({ v: 1, t: "subscribe", id: `l${i}`, channel: ch }); await sleep(200); }
    d.send({ v: 1, t: "subscribe", id: "over", channel: "recruitment" }); // already subscribed: free
    await sleep(300);
    assert.equal(d.frames.filter((x) => x["t"] === "ack").length, 4);
    const e = raw(a.ws, { headers: hdr }); await e.open(); // oversize: the server closes with 1009 before parsing anything
    e.ws.send(JSON.stringify({ v: 1, t: "event", channel: "recruitment", event: "x.y", payload: "x".repeat(5000) }));
    await until(() => e.closed !== undefined); assert.equal(e.closed!.code, 1009);
    const g = raw(a.ws, { headers: hdr }); await g.open(); // an unsupported protocol version: told and closed (a protocol error, not an HTTP error after the upgrade)
    g.send({ v: 2, t: "ping" });
    await until(() => g.closed !== undefined);
    assert.equal(g.frames.find((x) => x["t"] === "error")!["code"], "PSO_CHANNEL_UNSUPPORTED_VERSION"); assert.equal(g.closed!.code, 4426);
    assert.equal((await fetch(a.http("/health/live"))).status, 200, "the server survived all of it");
    assert.ok(!/stack|at .*\(.*:\d+:\d+\)/.test(JSON.stringify(c.frames)));
  } finally { a.child.kill(); }
});

test("the client SDK reconnects with backoff, re-authenticates and re-subscribes (the server re-authorizes); no replay is claimed", { timeout: 400_000 }, async () => {
  const first = await launch();
  const states: ConnectionState[] = [];
  const events: ChannelEvent[] = [];
  const tokenCalls: number[] = [];
  let second: Launched | undefined;
  try {
    const aliceToken = await first.token("alice", SCOPES), writer = await first.token("writer", "candidate:write");
    const alice = createPsoChannels({ url: first.ws, getToken: () => { tokenCalls.push(Date.now()); return aliceToken; }, reconnect: { minDelayMs: 100, maxDelayMs: 400 }, heartbeatMs: 500, onStateChange: (s) => states.push(s) });
    let active = false;
    alice.subscribe("candidate.c1", { onEvent: (e) => events.push(e), onSubscribed: (x) => { active = x; } });
    await until(() => active);
    assert.equal((await update(first, writer, "c1", "INTERVIEW")).status, 201);
    await until(() => events.length === 1);
    first.child.kill(); // the orchestrator goes away and comes back on the same port: the SDK reconnects by itself
    await until(() => !active && states.includes("reconnecting"), 10_000);
    second = await launch("RecruitmentChannel, CandidateChannel", {}, { g: first.g, port: first.port, pub: first.pub, keys: first.keys });
    await until(() => active, 15_000);
    assert.ok(tokenCalls.length >= 2, "authentication is repeated after a reconnect");
    assert.equal((await update(second, await second.token("writer", "candidate:write"), "c1", "HIRED")).status, 201);
    await until(() => events.length === 2);
    assert.deepEqual(events.map((e) => (e.payload as { status: string }).status), ["INTERVIEW", "HIRED"], "exactly the events published while connected; nothing replayed, nothing duplicated");
    alice.subscribe("candidate.c1", { onEvent: () => undefined }).unsubscribe(); // explicit unsubscribe
    alice.close();
    assert.equal(alice.state, "closed");
    await assert.rejects(alice.send("recruitment", "candidate.subscribe", {}), (e: ChannelsError) => e.code === "PSO_CHANNEL_UNAVAILABLE", "no offline queue: a command is rejected, never held for later");
  } finally { first.child.kill(); second?.child.kill(); }
});

test("registration is explicit and validated: duplicate channels stop start-up with a precise message", { timeout: 400_000 }, async () => {
  await assert.rejects(launch("RecruitmentChannel, RecruitmentChannel"), (e: Error) => /registered twice|duplicate channel/.test(e.message));
});
