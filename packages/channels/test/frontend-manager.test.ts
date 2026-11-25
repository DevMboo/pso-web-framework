import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Principal } from "@pso/security";
import { createChannelsManager } from "@pso/frontend-client";
import { Channel, OnSubscribe, attachChannels, ChannelRegistry, CHANNELS_DEFAULTS, type AttachedChannels } from "../src/index.ts";

/**
 * The FEI's centralized Channels manager against the REAL PSO Channels server on real sockets: shared connection, subscription
 * deduplication, ownership of subscriptions between microfrontends, repeated mount/unmount, gateway restart with re-authentication and
 * re-subscription, session expiry, bounded retries and logout. (Browser WebSocket behavior is covered by the Chrome runs; this uses the same
 * client code with the `ws` implementation injected.)
 */
class Feed { ok(): boolean { return true; } }
Channel("feed", { visibility: "private" })(Feed);
OnSubscribe()(Feed.prototype, "ok");
class Room { ok(): boolean { return true; } }
Channel("order.{id}", { visibility: "private" })(Room);
OnSubscribe()(Room.prototype, "ok");

const principalOf = (sub: string): Principal => new Principal({ subject: sub, issuer: "i", audiences: [], scopes: [], roles: [], permissions: [], expiresAt: new Date(Date.now() + 3_600_000) });
async function start(port = 0): Promise<{ server: Server; port: number; ch: AttachedChannels }> {
  const server = createServer((_q, r) => r.writeHead(404).end());
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const registry = new ChannelRegistry(); assert.deepEqual(registry.add("m", [Feed, Room]), []);
  const ch = await attachChannels({
    server, registry, config: { ...CHANNELS_DEFAULTS, allowAnonymous: false }, service: "orchestrator",
    authenticate: async (h) => (h.startsWith("Bearer user:") ? principalOf(h.slice("Bearer user:".length)) : undefined),
    authorize: () => true, resolve: (c) => new (c as new () => Record<string, (...a: unknown[]) => unknown>)(),
  });
  return { server, port: (server.address() as AddressInfo).port, ch };
}
async function stop(s: { server: Server; ch: AttachedChannels }): Promise<void> { await s.ch.close(); s.server.closeAllConnections(); await new Promise((r) => s.server.close(r)); }
const until = async (f: () => boolean, ms = 8000, what = "condition"): Promise<void> => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f(), `${what} not reached in time`); };
const mgr = (port: number, getToken: () => string | Promise<string>, extra: Record<string, unknown> = {}) => createChannelsManager({ url: `ws://127.0.0.1:${port}/channels`, getToken, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, heartbeatMs: 0, reconnect: { minDelayMs: 50, maxDelayMs: 200, maxAttempts: 20 }, allowInsecure: true, ...extra } as never);

test("one shared connection; one server-side subscription per channel however many microfrontends listen; ownership of subscriptions", async () => {
  const s = await start();
  const m = mgr(s.port, () => "user:ana");
  try {
    const gotA: string[] = [], gotB: string[] = [];
    const offA = m.subscribe("feed", (e) => gotA.push(e.type)), offB = m.subscribe("feed", (e) => gotB.push(e.type));
    const offOther = m.subscribe("order.o1", () => undefined);
    await until(() => s.ch.hub.subscribers("feed") === 1 && s.ch.hub.subscribers("order.o1") === 1, 8000, "subscriptions");
    assert.equal(s.ch.hub.connectionCount, 1, "one WebSocket for the whole shell");
    assert.equal(m.activeChannels, 2); assert.equal(m.listenerCount, 3);
    await s.ch.publisher.publish("feed", "tick", { n: 1 });
    await until(() => gotA.length === 1 && gotB.length === 1, 5000, "delivery to both listeners");
    offA(); offA(); // a second call changes nothing
    assert.equal(s.ch.hub.subscribers("feed"), 1, "the other microfrontend's subscription was NOT removed");
    await s.ch.publisher.publish("feed", "tick", { n: 2 });
    await until(() => gotB.length === 2, 5000, "B still receives"); assert.equal(gotA.length, 1, "A no longer receives");
    offB(); await until(() => s.ch.hub.subscribers("feed") === 0, 5000, "server-side unsubscribe after the last listener");
    assert.equal(s.ch.hub.subscribers("order.o1"), 1, "an unrelated channel is untouched"); offOther();
    await until(() => s.ch.hub.subscribers("order.o1") === 0);
    assert.equal(m.activeChannels, 0); assert.equal(m.listenerCount, 0);
  } finally { m.close(); await stop(s); }
});

test("a faulty listener never stops the others; repeated navigation (mount and unmount) leaves no connection, subscription or listener behind", async () => {
  const s = await start();
  const m = mgr(s.port, () => "user:ana");
  try {
    const seen: number[] = [];
    const bad = m.subscribe("feed", () => { throw new Error("boom"); }); const good = m.subscribe("feed", () => seen.push(1));
    await until(() => s.ch.hub.subscribers("feed") === 1);
    await s.ch.publisher.publish("feed", "t", {}); await until(() => seen.length === 1, 5000, "the good listener still receives"); bad(); good();
    await until(() => s.ch.hub.subscribers("feed") === 0);
    for (let i = 0; i < 60; i++) { const off = m.subscribe(`order.o${i % 5}`, () => undefined); if (i % 7 === 0) await new Promise((r) => setTimeout(r, 5)); off(); }
    await until(() => s.ch.hub.subscribers("order.o0") === 0 && s.ch.hub.subscribers("order.o4") === 0, 8000, "server-side cleanup");
    assert.ok(s.ch.hub.connectionCount <= 1, `connections: ${s.ch.hub.connectionCount}`); assert.equal(m.activeChannels, 0); assert.equal(m.listenerCount, 0);
  } finally { m.close(); await stop(s); }
});

test("gateway restart: the manager reconnects with backoff, authenticates again with a fresh token and re-subscribes; events flow again; still one connection", async () => {
  let s = await start(); const port = s.port;
  let tokens = 0; const m = mgr(port, () => `user:ana${++tokens > 0 ? "" : ""}`);
  const states: string[] = []; m.onStateChange((x) => states.push(x));
  try {
    const got: string[] = []; m.subscribe("feed", (e) => got.push(e.type));
    await until(() => s.ch.hub.subscribers("feed") === 1, 8000, "first subscription"); const tokensBefore = tokens;
    await stop(s); await until(() => states.includes("reconnecting") || states.includes("closed"), 8000, "the manager notices the outage");
    s = await start(port);
    await until(() => s.ch.hub.subscribers("feed") === 1, 15000, "re-subscription after the restart");
    assert.equal(s.ch.hub.connectionCount, 1); assert.ok(tokens > tokensBefore, "a fresh token was requested for the new connection");
    await s.ch.publisher.publish("feed", "after-restart", {}); await until(() => got.includes("after-restart"), 5000, "events flow after the restart");
    assert.equal(m.state, "connected");
  } finally { m.close(); await stop(s); }
});

test("session expiry and logout: an unauthenticated connection is refused and does not loop forever; close() releases everything and nothing reconnects", async () => {
  const s = await start();
  const errors: string[] = [];
  const bad = mgr(s.port, () => "expired-or-invalid", { reconnect: { minDelayMs: 20, maxDelayMs: 40, maxAttempts: 3 } });
  bad.onError((e) => errors.push(e.code ?? e.message));
  const good = mgr(s.port, () => "user:ana");
  try {
    bad.subscribe("feed", () => undefined);
    await until(() => bad.state === "closed", 10000, "bounded retries end in closed");
    assert.ok(errors.length >= 1, "an error was reported"); assert.ok(errors.every((e) => !/expired-or-invalid/.test(e)), "no error contains the token");
    const connectionsAfterGiveUp = s.ch.hub.connectionCount; await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.ch.hub.connectionCount, connectionsAfterGiveUp, "it stopped trying");

    good.subscribe("feed", () => undefined); await until(() => s.ch.hub.subscribers("feed") === 1);
    good.close(); await until(() => s.ch.hub.connectionCount === 0 && s.ch.hub.subscribers("feed") === 0, 8000, "logout releases the connection and subscriptions");
    await new Promise((r) => setTimeout(r, 400)); assert.equal(s.ch.hub.connectionCount, 0, "nothing reconnects after close()");
    assert.equal(good.activeChannels, 0);
  } finally { bad.close(); good.close(); await stop(s); }
});

test("bounded retries against a server that is gone: the number of attempts is limited", async () => {
  let attempts = 0; const tcp: TcpServer = createTcp((sock) => { attempts++; sock.destroy(); });
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r)); const port = (tcp.address() as AddressInfo).port;
  const m = mgr(port, () => "user:ana", { reconnect: { minDelayMs: 20, maxDelayMs: 40, maxAttempts: 4 } });
  try {
    m.subscribe("feed", () => undefined);
    await until(() => m.state === "closed", 10000, "gives up");
    const at = attempts; await new Promise((r) => setTimeout(r, 500));
    assert.equal(attempts, at, "no attempts after giving up"); assert.ok(at >= 1 && at <= 6, `attempts: ${at}`);
  } finally { m.close(); await new Promise((r) => tcp.close(r)); }
});
