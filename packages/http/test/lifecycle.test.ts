import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OwnedResources, Readiness, safeDetail } from "../src/index.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("owned resources: released newest first, each exactly once, and repeated cleanup is harmless", async () => {
  const o = new OwnedResources();
  const order: string[] = [];
  o.add("security", () => { order.push("security"); });
  o.add("dispatch", async () => { await sleep(5); order.push("dispatch"); });
  o.add("http", () => { order.push("http"); });
  assert.deepEqual(o.pending, ["security", "dispatch", "http"]);
  assert.deepEqual(await o.releaseAll(), []);
  assert.deepEqual(order, ["http", "dispatch", "security"], "reverse acquisition order");
  assert.deepEqual(o.pending, []);
  assert.deepEqual(await o.releaseAll(), [], "a second cleanup does nothing");
  await o.release("dispatch"); await o.release("never-acquired");
  assert.deepEqual(order, ["http", "dispatch", "security"], "nothing is released twice (no double close)");
});

test("owned resources: a failing or hanging release is bounded, reported, and never stops the others", async () => {
  const o = new OwnedResources(60);
  const order: string[] = [];
  o.add("first", () => { order.push("first"); });
  o.add("throws", () => { throw new Error("redis://user:secret@host is gone"); });
  o.add("hangs", () => new Promise(() => undefined));
  o.add("last", () => { order.push("last"); });
  const started = Date.now();
  const failed = await o.releaseAll();
  assert.ok(Date.now() - started < 2000, "cleanup is bounded in time");
  assert.deepEqual(failed.sort(), ["hangs", "throws"]);
  assert.deepEqual(order, ["last", "first"], "the resources around the failures were still released");
});

test("owned resources: named release (shutdown order) then releaseAll covers the rest, concurrently requested releases share one run", async () => {
  const o = new OwnedResources();
  let closes = 0;
  const order: string[] = [];
  o.add("a", async () => { closes++; await sleep(10); order.push("a"); });
  o.add("b", () => { order.push("b"); });
  await Promise.all([o.release("a"), o.release("a"), o.releaseAll()]);
  assert.equal(closes, 1);
  assert.deepEqual(order.sort(), ["a", "b"]);
});

test("owned resources: a failure after the listener is bound releases the listener (the port is free again)", async () => {
  const o = new OwnedResources();
  const server = createServer((_q, s) => s.end("x"));
  o.add("http", () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  await o.releaseAll(); // what bootstrap() does when a later start-up step fails
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }), "nothing listens any more");
  // releasing a server that never listened is equally safe
  const o2 = new OwnedResources();
  const never = createServer();
  o2.add("http", () => new Promise<void>((r) => { never.closeAllConnections(); never.close(() => r()); }));
  assert.deepEqual(await o2.releaseAll(), []);
});

test("readiness: not ready while starting, ready once started, not ready while shutting down", async () => {
  let state = "starting";
  const r = new Readiness({ state: () => state });
  assert.equal(r.report().status, "DOWN", "start-up in progress");
  assert.equal(r.report().state, "starting");
  state = "ready";
  assert.deepEqual(r.report(), { status: "UP", state: "ready", checks: {} });
  state = "draining";
  assert.equal(r.report().status, "DOWN", "shutdown in progress");
  state = "stopped";
  assert.equal(r.report().status, "DOWN");
});

test("readiness: a required dependency that is down blocks readiness, recovery restores it, an optional one never blocks", async () => {
  let brokerUp = true, cacheUp = false;
  const changes: string[] = [];
  const r = new Readiness({ state: () => "ready", failureThreshold: 2, onChange: (n, c) => changes.push(`${n}:${c.status}`) });
  r.add({ name: "dispatch", required: true, probe: async () => ({ up: brokerUp, detail: brokerUp ? "PING answered" : "PING failed (Error)" }) });
  r.add({ name: "rateLimit", required: false, probe: () => ({ up: cacheUp, detail: "PING failed (Error)" }) });
  assert.equal(r.report().status, "DOWN", "a required dependency that was never probed is not assumed healthy");
  await r.probeNow();
  let rep = r.report();
  assert.equal(rep.status, "UP", "the optional dependency is down and the instance is still ready");
  assert.deepEqual(rep.checks, { dispatch: { status: "UP", required: true, detail: "PING answered" }, rateLimit: { status: "DOWN", required: false, detail: "PING failed (Error)" } });

  brokerUp = false;
  await r.probeNow();
  assert.equal(r.report().status, "UP", "one failed probe is a blip: below the threshold nothing flaps");
  await r.probeNow();
  rep = r.report();
  assert.equal(rep.status, "DOWN");
  assert.deepEqual(rep.checks["dispatch"], { status: "DOWN", required: true, detail: "PING failed (Error)" });

  brokerUp = true;
  await r.probeNow();
  assert.equal(r.report().status, "UP", "the first successful probe restores readiness");
  assert.deepEqual([...changes.slice(0, 2).sort(), ...changes.slice(2)], ["dispatch:UP", "rateLimit:DOWN", "dispatch:DOWN", "dispatch:UP"], "every transition is observable, exactly once");
});

test("readiness: probes are bounded (timeout), never stacked, never thrown out, and reading the report never probes", async () => {
  let calls = 0;
  const r = new Readiness({ state: () => "ready", timeoutMs: 40, failureThreshold: 1 });
  r.add({ name: "slow", required: true, probe: () => { calls++; return new Promise(() => undefined); } });
  r.add({ name: "throws", required: false, probe: () => { throw new Error("boom redis://u:p@10.0.0.5:6379"); } });
  const started = Date.now();
  await r.probeNow();
  assert.ok(Date.now() - started < 1500, "a hanging probe does not hang readiness");
  const rep = r.report();
  assert.equal(rep.status, "DOWN");
  assert.match(rep.checks["slow"]!.detail!, /timed out after 40 ms/);
  assert.equal(rep.checks["throws"]!.detail, "probe failed (Error)", "only the error type: a message can carry an address or credentials");
  for (let i = 0; i < 1000; i++) r.report();
  assert.equal(calls, 1, "the endpoint reads a cached result; requests never trigger probes");
});

test("readiness: background probing runs on the interval and stops when asked", async () => {
  let calls = 0;
  const r = new Readiness({ state: () => "ready", intervalMs: 20 });
  r.add({ name: "dep", required: true, probe: () => { calls++; return { up: true }; } });
  r.start(); r.start();
  await sleep(120);
  r.stop();
  const seen = calls;
  assert.ok(seen >= 2, `probed repeatedly (${seen})`);
  await sleep(80);
  assert.equal(calls, seen, "no probe after stop(): no timer is left behind");
});

test("readiness details never expose addresses, credentials or long text", () => {
  assert.equal(safeDetail("cannot reach redis://user:hunter2@10.1.2.3:6379/0 now"), "cannot reach (address hidden) now");
  assert.equal(safeDetail("amqps://guest:guest@broker.internal:5671"), "(address hidden)");
  assert.equal(safeDetail("x".repeat(500))!.length, 160);
  assert.equal(safeDetail(undefined), undefined);
  assert.equal(safeDetail("line1\nline2"), "line1 line2");
});
