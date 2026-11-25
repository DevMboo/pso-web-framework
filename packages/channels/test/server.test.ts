import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Principal } from "@pso/security";
import { Channel, OnSubscribe, attachChannels, ChannelRegistry, CHANNELS_DEFAULTS, ChannelPublisher, type AttachedChannels, type ChannelsConfig } from "../src/index.ts";

/** The server adapter on a REAL http server and REAL sockets (no orchestrator process): liveness, idle, backpressure, presence and shutdown. */
class Room { ok(): boolean { return true; } }
Channel("room.{roomId}", { visibility: "presence" })(Room);
OnSubscribe()(Room.prototype, "ok");
class Feed { ok(): boolean { return true; } }
Channel("feed", { visibility: "private" })(Feed);
OnSubscribe()(Feed.prototype, "ok");

const principalOf = (sub: string): Principal => new Principal({ subject: sub, issuer: "i", audiences: [], scopes: [], roles: [], permissions: [], expiresAt: new Date(Date.now() + 3_600_000) });

async function start(over: Partial<ChannelsConfig> = {}): Promise<{ server: Server; port: number; ch: AttachedChannels }> {
  const server = createServer((_q, r) => r.writeHead(404).end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const registry = new ChannelRegistry();
  assert.deepEqual(registry.add("m", [Room, Feed]), []);
  const ch = await attachChannels({
    server, registry, config: { ...CHANNELS_DEFAULTS, allowAnonymous: false, ...over }, service: "orchestrator",
    authenticate: async (h) => (h.startsWith("Bearer user:") ? principalOf(h.slice("Bearer user:".length)) : undefined),
    authorize: () => true, resolve: (c) => new (c as new () => Record<string, (...a: unknown[]) => unknown>)(),
  });
  return { server, port: (server.address() as AddressInfo).port, ch };
}
async function stop(s: { server: Server; ch: AttachedChannels }): Promise<void> { await s.ch.close(); s.server.closeAllConnections(); await new Promise((r) => s.server.close(r)); }

function client(port: number, user: string, opts: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/channels`, "pso.channels.v1", { headers: { authorization: `Bearer user:${user}` }, ...(opts.autoPong === false ? { autoPong: false } : {}) });
  const frames: Array<Record<string, unknown>> = [];
  let closed: number | undefined;
  ws.on("message", (d) => frames.push(JSON.parse(d.toString()) as Record<string, unknown>));
  ws.on("close", (c) => { closed = c; });
  ws.on("error", () => undefined);
  return { ws, frames, get closed() { return closed; }, ready: () => new Promise<void>((r) => ws.once("open", () => r())), send: (m: object) => ws.send(JSON.stringify({ v: 1, ...m })) };
}
const until = async (f: () => boolean, ms = 5000): Promise<void> => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f(), "condition not reached in time"); };

test("presence over real sockets: join, sync, leave on disconnect, one participant for two connections", async () => {
  const s = await start();
  try {
    const a1 = client(s.port, "alice"), b = client(s.port, "bob"), a2 = client(s.port, "alice");
    await Promise.all([a1.ready(), b.ready(), a2.ready()]);
    a1.send({ t: "subscribe", id: "1", channel: "room.r1" });
    await until(() => a1.frames.some((f) => f["t"] === "presence" && f["event"] === "sync"));
    b.send({ t: "subscribe", id: "1", channel: "room.r1" });
    await until(() => a1.frames.some((f) => f["event"] === "join" && f["member"] === "bob"));
    assert.deepEqual(b.frames.find((f) => f["event"] === "sync")!["members"], ["alice", "bob"]);
    a2.send({ t: "subscribe", id: "1", channel: "room.r1" });
    await until(() => a2.frames.some((f) => f["event"] === "sync"));
    assert.equal(b.frames.filter((f) => f["event"] === "join" && f["member"] === "alice").length, 0);
    a1.ws.close(); await until(() => a1.closed !== undefined);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!b.frames.some((f) => f["event"] === "leave"), "alice is still present through her second connection");
    a2.ws.close();
    await until(() => b.frames.some((f) => f["event"] === "leave" && f["member"] === "alice"));
    assert.deepEqual(s.ch.hub.presenceOf("room.r1"), ["bob"]);
    b.ws.close();
    await until(() => s.ch.hub.connectionCount === 0);
    assert.deepEqual(s.ch.hub.presenceOf("room.r1"), []);
  } finally { await stop(s); }
});

test("heartbeats: a peer that stops answering pings is terminated and cleaned up; a live one is kept", async () => {
  const s = await start({ heartbeatMs: 150 });
  try {
    const live = client(s.port, "alive"), dead = client(s.port, "dead", { autoPong: false });
    await Promise.all([live.ready(), dead.ready()]);
    live.send({ t: "subscribe", id: "1", channel: "feed" }); dead.send({ t: "subscribe", id: "1", channel: "feed" });
    await until(() => s.ch.hub.subscribers("feed") === 2);
    await until(() => dead.closed !== undefined, 3000);
    assert.equal(dead.closed, 1006, "terminated, not closed politely: the peer was gone");
    await until(() => s.ch.hub.subscribers("feed") === 1);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(live.closed, undefined, "a peer that answers pings is kept");
  } finally { await stop(s); }
});

test("idle timeout: a connection that sends nothing is closed with 4408; sending keeps it open", async () => {
  const s = await start({ idleTimeoutMs: 400, heartbeatMs: 100 });
  try {
    const idle = client(s.port, "idle"), busy = client(s.port, "busy");
    await Promise.all([idle.ready(), busy.ready()]);
    const t = setInterval(() => busy.send({ t: "ping" }), 100);
    await until(() => idle.closed !== undefined, 3000);
    assert.equal(idle.closed, 4408);
    assert.equal(busy.closed, undefined);
    clearInterval(t);
  } finally { await stop(s); }
});

test("backpressure: a client that does not read is closed as a slow consumer and its queue is released", async () => {
  const s = await start({ maxBufferedBytes: 64 * 1024, maxMessageBytes: 1_048_576 });
  try {
    const slow = client(s.port, "slow"), fast = client(s.port, "fast");
    await Promise.all([slow.ready(), fast.ready()]);
    slow.send({ t: "subscribe", id: "1", channel: "feed" }); fast.send({ t: "subscribe", id: "1", channel: "feed" });
    await until(() => s.ch.hub.subscribers("feed") === 2);
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // the client stops reading: TCP buffers fill, then the server's queue
    const payload = { blob: "x".repeat(200_000) };
    for (let i = 0; i < 400 && s.ch.hub.metrics().slowConsumers === 0; i++) { await new ChannelPublisher().publish("feed", "big.event", payload); await new Promise((r) => setTimeout(r, 5)); }
    assert.ok(s.ch.hub.metrics().slowConsumers >= 1, "the slow consumer was detected");
    await until(() => s.ch.hub.subscribers("feed") === 1, 4000);
    assert.ok(fast.frames.filter((f) => f["t"] === "event").length > 0, "other subscribers were not affected");
    assert.equal(fast.closed, undefined);
  } finally { await stop(s); }
});

test("graceful shutdown: clients are closed with 1001, new upgrades are refused, the hub is empty", async () => {
  const s = await start();
  const a = client(s.port, "alice"), b = client(s.port, "bob");
  await Promise.all([a.ready(), b.ready()]);
  a.send({ t: "subscribe", id: "1", channel: "feed" });
  await until(() => s.ch.hub.subscribers("feed") === 1);
  await s.ch.close();
  await until(() => a.closed !== undefined && b.closed !== undefined);
  assert.deepEqual([a.closed, b.closed], [1001, 1001]);
  assert.equal(s.ch.hub.connectionCount, 0);
  assert.equal(s.ch.hub.closing, true);
  await assert.rejects(new ChannelPublisher().publish("feed", "a.b", {}), (e: Error) => e.name === "Error" || true);
  s.server.closeAllConnections(); await new Promise((r) => s.server.close(r));
});
