import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PsoChannelsProvider, usePsoChannel, usePsoConnection, type UsePsoChannelResult } from "@pso/react-channels";
import { createPsoChannels } from "@pso/channels-client";
import type { ChannelEvent, ChannelsError, ConnectionState, PsoChannels, SubscriptionHandlers } from "@pso/channels-client";
import { ChannelDispatchConsumer, ChannelHub, ChannelPublisher, ChannelRegistry, LocalBus, CHANNELS_DEFAULTS, Channel, ChannelError, type Connection } from "../src/index.ts";
import { Principal } from "@pso/security";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** a client double that records every subscription so leaks and duplicates are visible */
function fakeChannels() {
  const live = new Map<number, { channel: string; h: SubscriptionHandlers }>();
  let n = 0, total = 0;
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const errorListeners = new Set<(e: ChannelsError) => void>();
  let state: ConnectionState = "connected";
  let reauth = 0;
  const c: PsoChannels = {
    get state() { return state; },
    onStateChange: (cb) => { stateListeners.add(cb); return () => { stateListeners.delete(cb); }; },
    onError: (cb) => { errorListeners.add(cb); return () => { errorListeners.delete(cb); }; },
    reauthenticate: async () => { reauth++; },
    subscribe(channel, h) { const id = ++n; total++; live.set(id, { channel, h: h as SubscriptionHandlers }); return { channel, unsubscribe: () => { live.delete(id); } }; },
    send: async () => undefined, connect() {}, close() {},
  };
  return { c, live, total: () => total, listeners: () => stateListeners.size + errorListeners.size, reauths: () => reauth,
    setState: (s: ConnectionState) => { state = s; for (const l of [...stateListeners]) l(s); }, fail: (e: ChannelsError) => { for (const l of [...errorListeners]) l(e); }, emit: (channel: string, e: Partial<ChannelEvent>) => { for (const s of live.values()) if (s.channel === channel) s.h.onEvent({ eventId: "e" + Math.random(), type: "x.y", channel, ts: "", payload: null, ...e }); } };
}

function mount(f: ReturnType<typeof fakeChannels>, channel: () => string | null, opts: { maxEvents?: number; strict?: boolean } = {}) {
  let last: UsePsoChannelResult<unknown> | undefined;
  function Probe(_p: { tick?: number }): null { last = usePsoChannel(channel(), opts.maxEvents ? { maxEvents: opts.maxEvents } : {}); return null; }
  let tick = 0;
  const mk = (): ReturnType<typeof createElement> => createElement(PsoChannelsProvider, { channels: f.c, children: createElement(Probe, { tick: ++tick }) });
  const tree = mk();
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(opts.strict ? createElement(StrictMode, null, tree) : tree); });
  return { r, get state() { return last!; }, rerender: () => act(() => { r.update(opts.strict ? createElement(StrictMode, null, mk()) : mk()); }) };
}

test("react hook: one subscription per mounted hook, removed on unmount; StrictMode double mounting leaves exactly one", () => {
  const f = fakeChannels();
  const m = mount(f, () => "candidate.c1", { strict: true });
  assert.equal(f.live.size, 1, "StrictMode mounts, unmounts and mounts again: still one live subscription");
  act(() => m.r.unmount());
  assert.equal(f.live.size, 0, "no leak after unmount");
});

test("react hook: states, bounded events, error and changing channel parameters", () => {
  const f = fakeChannels();
  let ch: string | null = "candidate.c1";
  const m = mount(f, () => ch, { maxEvents: 3 });
  assert.equal(m.state.status, "loading"); assert.equal(m.state.connected, false);
  act(() => { [...f.live.values()][0]!.h.onSubscribed?.(true); });
  assert.equal(m.state.status, "connected"); assert.equal(m.state.connected, true);
  for (let i = 0; i < 5; i++) act(() => f.emit("candidate.c1", { payload: i }));
  assert.deepEqual(m.state.events.map((e) => e.payload), [2, 3, 4], "the list is bounded (maxEvents), oldest dropped");
  assert.equal(m.state.last?.payload, 4);
  const err: ChannelsError = { code: "PSO_CHANNEL_FORBIDDEN", message: "Not allowed." };
  act(() => { [...f.live.values()][0]!.h.onError?.(err); });
  assert.equal(m.state.status, "error"); assert.deepEqual(m.state.error, err);
  // another channel (another resource): the old subscription is removed first, state is reset, nothing leaks
  ch = "candidate.c2"; m.rerender();
  assert.equal(f.live.size, 1); assert.equal([...f.live.values()][0]!.channel, "candidate.c2");
  assert.equal(m.state.events.length, 0); assert.equal(m.state.error, null);
  assert.equal(f.total(), 2);
  ch = null; m.rerender();
  assert.equal(f.live.size, 0, "a null channel unsubscribes (for example while the id is not known yet)");
  act(() => m.r.unmount());
});

test("react hook: used outside the provider is a clear error", () => {
  function Bad(): null { usePsoChannel("x"); return null; }
  const spy = console.error; console.error = () => undefined;
  try { assert.throws(() => act(() => { TestRenderer.create(createElement(Bad)); }), /inside <PsoChannelsProvider>/); } finally { console.error = spy; }
});

// ---------------------------------------------------------------- the Dispatch bridge
class Alerts {}
Channel("alerts", { visibility: "private", publishers: ["recruitment-service"] })(Alerts);

function bridgeHub() {
  const registry = new ChannelRegistry();
  assert.deepEqual(registry.add("m", [Alerts]), []);
  const hub = new ChannelHub({ registry, config: CHANNELS_DEFAULTS, bus: new LocalBus(), service: "orchestrator", resolve: (c) => new (c as new () => Record<string, (...a: unknown[]) => unknown>)(), authorize: () => true });
  ChannelPublisher.hub = hub;
  return hub;
}
class Consumer extends ChannelDispatchConsumer {}
const evt = (source: string, over: Record<string, unknown> = {}) => ({ v: 1, id: "evt-bridge-" + Math.random().toString(36).slice(2), type: "alert.raised", channel: "alerts", ts: new Date().toISOString(), source, payload: { n: 1 }, ...over });

test("dispatch bridge: the authenticated Dispatch source decides who may publish; invalid events are dropped, a bus outage is retried", async () => {
  const hub = bridgeHub();
  const got: Array<Record<string, unknown>> = [];
  const conn: Connection = { id: "c1", correlationId: "corr-bridge-0001", principal: new Principal({ subject: "u", issuer: "i", audiences: [], scopes: [], roles: [], permissions: [], expiresAt: new Date(Date.now() + 60_000) }), send: (f) => { got.push(JSON.parse(f) as Record<string, unknown>); return true; }, close: () => undefined };
  await hub.connect(conn);
  const c = new Consumer();
  // alerts has no @OnSubscribe handler and no parameters: authentication is enough for THIS channel
  await hub.subscribe(conn, "alerts");
  await c.handle(evt("recruitment-service"), { envelope: { source: "recruitment-service" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(got.filter((m) => m["t"] === "event").length, 1);
  // a payload that CLAIMS a trusted source cannot elevate an untrusted Dispatch publisher
  await c.handle(evt("recruitment-service"), { envelope: { source: "rogue-service" } });
  await c.handle({ nonsense: true }, { envelope: { source: "recruitment-service" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(got.filter((m) => m["t"] === "event").length, 1, "refused and malformed events were dropped without throwing (retrying cannot make them valid)");
  // an unavailable bus is re-thrown so Dispatch retries the message
  const failing = new LocalBus(); failing.publish = async () => { throw new Error("redis down"); };
  const registry = new ChannelRegistry(); registry.add("m", [Alerts]);
  ChannelPublisher.hub = new ChannelHub({ registry, config: CHANNELS_DEFAULTS, bus: failing, service: "o", resolve: (x) => new (x as new () => Record<string, (...a: unknown[]) => unknown>)(), authorize: () => true });
  await assert.rejects(c.handle(evt("recruitment-service"), { envelope: { source: "recruitment-service" } }), (e: ChannelError) => e.code === "PSO_CHANNEL_UNAVAILABLE");
  ChannelPublisher.hub = undefined;
  await assert.rejects(new ChannelPublisher().publish("alerts", "a.b", {}), (e: ChannelError) => e.code === "PSO_CHANNEL_UNAVAILABLE", "publishing without an attached hub fails clearly");
});

test("usePsoConnection: reflects the shared connection, reports errors, re-authenticates on request and leaves no listener behind", () => {
  const f = fakeChannels();
  let last: ReturnType<typeof usePsoConnection> | undefined;
  function Probe(): null { last = usePsoConnection(); return null; }
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(createElement(PsoChannelsProvider, { channels: f.c, children: createElement(Probe) })); });
  assert.equal(last!.connected, true);
  act(() => f.setState("reconnecting"));
  assert.deepEqual([last!.state, last!.connected], ["reconnecting", false]);
  act(() => f.fail({ code: "PSO_CHANNEL_UNAUTHENTICATED", message: "Authentication is required." }));
  assert.equal(last!.error?.code, "PSO_CHANNEL_UNAUTHENTICATED");
  act(() => f.setState("connected"));
  assert.equal(last!.error, null, "the error clears when the connection is back");
  act(() => { void last!.reauthenticate(); });
  assert.equal(f.reauths(), 1);
  act(() => r.unmount());
  assert.equal(f.listeners(), 0, "no state or error listener survives the unmount");
});

test("hooks share ONE connection: any number of components never create a second client", () => {
  const f = fakeChannels();
  let opened = 0;
  const base = f.c.subscribe;
  f.c.subscribe = (ch, h) => { opened++; return base(ch, h); };
  function A(): null { usePsoChannel("candidate.a"); return null; }
  function B(): null { usePsoChannel("candidate.b"); usePsoConnection(); return null; }
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(createElement(PsoChannelsProvider, { channels: f.c, children: [createElement(A, { key: "a" }), createElement(B, { key: "b" })] })); });
  assert.equal(opened, 2); assert.equal(f.live.size, 2);
  act(() => r.unmount());
  assert.equal(f.live.size, 0);
});

test("client transport security: ws:// only to loopback; wss:// anywhere; allowInsecure is an explicit opt-out", () => {
  class FakeWs { static instances: string[] = []; readyState = 0; constructor(url: string) { FakeWs.instances.push(url); } send() {} close() {} }
  const make = (url: string, extra: object = {}) => createPsoChannels({ url, WebSocketImpl: FakeWs as never, ...extra });
  const errors: string[] = [];
  const attempt = (url: string, extra: object = {}): string[] => { FakeWs.instances.length = 0; const c = make(url, { onError: (e: ChannelsError) => errors.push(e.message), ...extra }); c.connect(); c.close(); return [...FakeWs.instances]; };
  assert.deepEqual(attempt("ws://127.0.0.1:3000/channels"), ["ws://127.0.0.1:3000/channels"]);
  assert.deepEqual(attempt("ws://localhost/channels"), ["ws://localhost/channels"]);
  assert.deepEqual(attempt("wss://api.example.com/channels"), ["wss://api.example.com/channels"]);
  errors.length = 0;
  assert.deepEqual(attempt("ws://api.example.com/channels"), [], "no socket is even created");
  assert.match(errors.join(), /unencrypted ws/);
  assert.deepEqual(attempt("ws://10.0.0.5/channels", { allowInsecure: true }), ["ws://10.0.0.5/channels"]);
});
