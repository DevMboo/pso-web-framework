import { test, after } from "node:test";
import { sessionEnv } from "../../../scripts/dispatch-brokers.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { bootstrap, setLogSink, resetLogging, type App } from "@pso/http";
import { tmp, unusedPort } from "./helpers.ts";

/**
 * Graceful shutdown (REL-02). The defect: close() cut every connection at once, so a request that was being served was interrupted.
 * Now close() stops accepting connections, lets running requests finish within a configurable grace period (PSO_SHUTDOWN_GRACE_MS,
 * http.shutdown.graceMs; default 5 s), releases the dependents and only then cuts what is left. Every wait is bounded.
 */
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const dist = (pkg: string): string => JSON.stringify(join(REPO, "packages", pkg, "dist", "index.js"));
const REDIS = (sessionEnv(undefined, ["redis"]) as Record<string, string | undefined>)["PSO_TEST_REDIS_URL"] ?? "redis://127.0.0.1:1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reachable = await new Promise<boolean>((r) => { const u = new URL(REDIS); const s = connect(Number(u.port || 6379), u.hostname); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const needsRedis = { timeout: 120_000, skip: reachable ? false : "no local Redis (node scripts/dispatch-brokers.mjs up)" } as const;

const dirs: string[] = [];
const apps: App[] = [];
after(async () => { for (const a of apps) await a.close().catch(() => undefined); resetLogging(); for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

/** One module: GET /work/slow answers after 400 ms, GET /work/stuck never answers, GET /work/fast answers at once; a public channel. */
function fixture(o: { channels?: boolean; dispatch?: string } = {}): { project: string; appDir: string } {
  const project = tmp("pso-shutdown-"); dirs.push(project);
  const appDir = join(project, "dist");
  mkdirSync(join(appDir, "routes", "work"), { recursive: true });
  writeFileSync(join(appDir, "routes", "work", "ROUTES.pso.js"), `const http = require(${dist("http")});
class WorkController {
  async slow() { await new Promise((r) => setTimeout(r, 400)); return { done: true }; }
  stuck() { return new Promise(() => {}); }
  fast() { return { ok: true }; }
}
http.Controller()(WorkController); http.RestController("/work")(WorkController);
for (const a of ["slow", "stuck", "fast"]) { http.Get("/" + a)(WorkController.prototype, a); http.Public()(WorkController.prototype, a); }
exports.WorkController = WorkController;
exports.default = http.defineRoutes({ routes: ["slow", "stuck", "fast"].map((a) => ({ method: "GET", path: "/work/" + a, controller: WorkController, action: a, security: { public: true } })) });
`);
  writeFileSync(join(appDir, "routes", "work", "MODULE.pso.js"), `const core = require(${dist("core")}); const http = require(${dist("http")});
const r = require("./ROUTES.pso.js");
${o.channels ? `const ch = require(${dist("channels")});
class News { open() { return true; } }
ch.Channel("news", { visibility: "public" })(News); ch.OnSubscribe()(News.prototype, "open"); http.Public()(News.prototype, "open");` : ""}
exports.default = core.defineModule({ name: "work", controllers: [r.WorkController], providers: [], routes: r.default${o.channels ? ", channels: [News]" : ""} });
`);
  if (o.dispatch) {
    mkdirSync(join(appDir, "dispatch", "demo"), { recursive: true });
    writeFileSync(join(appDir, "dispatch", "demo", "EVENTS.pso.js"), `const d = require(${dist("dispatch")});
class Seen { async handle() {} }
d.DispatchConsumer("demo.thing.happened")(Seen);
exports.default = d.defineEvents({ events: [{ name: "demo.thing.happened", version: 1, channel: ${JSON.stringify(o.dispatch)} }], consumers: [Seen] });
`);
    writeFileSync(join(project, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, provider: "redis", redis: { url: REDIS, block: "200ms" } } }));
  }
  return { project, appDir };
}

const FRAMEWORK_VARS = /^(PSO_|RATE_LIMIT_|OTEL_|MAX_|PORT$|HOST$|NODE_ENV$|REDIS_URL$)/;
const logs: Array<Record<string, unknown>> = [];
/** Starts the application with exactly `vars` as framework environment (bootstrap reads it at start), capturing its log lines. */
async function start(fx: { project: string; appDir: string }, vars: Record<string, string> = {}): Promise<{ app: App; port: number }> {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (FRAMEWORK_VARS.test(k)) delete process.env[k];
  Object.assign(process.env, { PSO_LOG_LEVEL: "info", PSO_LOG_FORMAT: "json", RATE_LIMIT_PER_MINUTE: "100000" }, vars);
  logs.length = 0;
  setLogSink((l) => { try { logs.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not a JSON line */ } });
  try {
    const port = await unusedPort();
    const app = await bootstrap({ appDir: fx.appDir, projectDir: fx.project, port, host: "127.0.0.1" });
    apps.push(app);
    return { app, port };
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}

interface Answer { status: number; body: string; connection: string | undefined; ms: number }
/** One request on its own connection; resolves with the answer or rejects when the connection is cut. */
function request(port: number, path: string, agent?: http.Agent): Promise<Answer> {
  const started = Date.now();
  return new Promise((res, rej) => {
    const req = http.get({ host: "127.0.0.1", port, path, ...(agent ? { agent } : {}) }, (r) => {
      let body = "";
      r.setEncoding("utf8"); r.on("data", (c: string) => { body += c; });
      r.on("end", () => res({ status: r.statusCode ?? 0, body, connection: r.headers["connection"], ms: Date.now() - started }));
      r.on("error", rej);
    });
    req.on("error", rej);
  });
}
const refused = (port: number): Promise<void> => assert.rejects(request(port, "/health/live"), "nothing accepts connections any more");
const message = (m: string): Record<string, unknown> | undefined => logs.find((l) => l["msg"] === m || l["message"] === m);

test("no active requests: shutdown is immediate; repeated and concurrent close() calls are one shutdown", async () => {
  const { app, port } = await start(fixture());
  assert.equal((await request(port, "/work/fast")).status, 200);
  const started = Date.now();
  await Promise.all([app.close(), app.close()]);
  await app.close();
  assert.ok(Date.now() - started < 1500, `an idle application stopped in ${Date.now() - started} ms`);
  assert.equal(logs.filter((l) => (l["msg"] ?? l["message"]) === "shutdown started").length, 1, "one shutdown, however often close() is called");
  await refused(port);
});

test("a request that is being served when close() is called finishes normally; new connections are refused meanwhile", async () => {
  const { app, port } = await start(fixture());
  const running = request(port, "/work/slow");
  await sleep(100); // the request is inside the handler
  const started = Date.now();
  const closing = app.close();
  await sleep(50);
  await refused(port); // the listener is already closed while the request is still running
  const again = app.close(); // close() during the drain joins the same shutdown
  const answer = await running;
  assert.equal(answer.status, 200, "the in-flight request was NOT interrupted");
  assert.deepEqual(JSON.parse(answer.body), { done: true });
  await closing; await again;
  const took = Date.now() - started;
  assert.ok(took >= 200 && took < 3000, `close() waited for the request and no longer (${took} ms; the default grace is 5 s)`);
  assert.ok(message("in-flight requests finished"), "the drain is logged");
});

test("several requests in flight all finish; kept-alive idle connections do not delay shutdown and are told to close", async () => {
  const { app, port } = await start(fixture());
  const agent = new http.Agent({ keepAlive: true, maxSockets: 10 });
  try {
    assert.equal((await request(port, "/work/fast", agent)).status, 200); // leaves an idle kept-alive connection behind
    const running = Array.from({ length: 6 }, () => request(port, "/work/slow", agent));
    await sleep(100);
    const started = Date.now();
    const closing = app.close();
    const answers = await Promise.all(running);
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200, 200]);
    await closing;
    assert.ok(Date.now() - started < 3000, `bounded by the slowest request, not by idle connections (${Date.now() - started} ms)`);
  } finally { agent.destroy(); }
});

test("a response written during the drain carries connection: close", async () => {
  const { app, port } = await start(fixture());
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const slow = request(port, "/work/slow", agent);
    await sleep(100);
    const closing = app.close();
    // a second request on a connection that was accepted BEFORE the drain started is still answered, and the client is told to reconnect elsewhere
    const answer = await slow;
    assert.equal(answer.status, 200);
    await closing;
  } finally { agent.destroy(); }
  const second = await start(fixture());
  const a2 = new http.Agent({ keepAlive: true, maxSockets: 2 });
  try {
    const hold = request(second.port, "/work/slow", a2);
    await sleep(100);
    const closing = second.app.close();
    assert.equal((await hold).status, 200);
    await closing;
    assert.equal((await request(second.port, "/work/fast").catch(() => ({ status: 0 }))).status, 0, "stopped");
  } finally { a2.destroy(); }
});

test("a request that outlives the grace period is cut when it ends, and no sooner; shutdown stays bounded", async () => {
  const { app, port } = await start(fixture(), { PSO_SHUTDOWN_GRACE_MS: "500" });
  const stuck = request(port, "/work/stuck").then(() => "answered", () => "cut");
  const slow = request(port, "/work/slow"); // 400 ms: inside the grace period
  await sleep(100);
  const started = Date.now();
  await app.close();
  const took = Date.now() - started;
  assert.equal((await slow).status, 200, "the request that fit in the grace period finished");
  assert.equal(await stuck, "cut", "the one that did not was closed");
  assert.ok(took >= 450 && took < 4000, `close() took the grace period, not forever (${took} ms)`);
  const warned = message("the shutdown grace period ended with requests still running; their connections are closed now");
  assert.equal(warned?.["interrupted"], 1, "and says how many requests were interrupted");
});

test("grace 0 keeps the previous behaviour (cut at once); an out-of-range value is refused at start-up", async () => {
  const { app, port } = await start(fixture(), { PSO_SHUTDOWN_GRACE_MS: "0" });
  const running = request(port, "/work/slow").then(() => "answered", () => "cut");
  await sleep(100);
  const started = Date.now();
  await app.close();
  assert.equal(await running, "cut");
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(start(fixture(), { PSO_SHUTDOWN_GRACE_MS: "forever" }), /PSO_SHUTDOWN_GRACE_MS must be a whole number/);
  // the same setting from pso.config.json
  const fx = fixture();
  writeFileSync(join(fx.project, "pso.config.json"), JSON.stringify({ http: { shutdown: { graceMs: 300 } } }));
  const second = await start(fx);
  const stuck = request(second.port, "/work/stuck").then(() => "answered", () => "cut");
  await sleep(100);
  const t0 = Date.now();
  await second.app.close();
  assert.equal(await stuck, "cut");
  assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 3000, `http.shutdown.graceMs was applied (${Date.now() - t0} ms)`);
});

test("a connection that never sends a request (a stuck socket) does not hold shutdown", async () => {
  const { app, port } = await start(fixture());
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((r) => socket.once("connect", () => r()));
  socket.write("GET /work/fast HTTP/1.1\r\nHost: x\r\n"); // headers never finished
  socket.on("error", () => undefined);
  const ended = new Promise<void>((r) => socket.once("close", () => r()));
  await sleep(100);
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 1500, `not a request in flight: no waiting (${Date.now() - started} ms)`);
  await ended; // and the socket was closed by the server
});

test("WebSocket connections are closed within their own bound while a running HTTP request still finishes", async () => {
  const fx = fixture({ channels: true });
  const pem = join(fx.project, "public.pem");
  writeFileSync(pem, generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }) as string);
  const { app, port } = await start(fx, { PSO_CHANNELS_ALLOW_ANONYMOUS: "true", PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pem, PSO_JWT_ALGORITHMS: "ES256" });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/channels`, "pso.channels.v1");
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  const wsClosed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  const running = request(port, "/work/slow");
  await sleep(100);
  const started = Date.now();
  await app.close();
  assert.equal((await running).status, 200, "the HTTP request finished first");
  assert.ok(Date.now() - started < 6000, `bounded (${Date.now() - started} ms)`);
  assert.ok((await wsClosed) > 0, "the WebSocket was closed by the server");
  await refused(port);
});

test("dependents are released AFTER the drain: a request in flight still has the shared rate limiter and dispatch; nothing stays connected", needsRedis, async () => {
  const DB = 12, url = `${REDIS.replace(/\/\d*$/, "")}/${DB}`;
  const { default: IORedis } = await import("ioredis");
  const control = new IORedis(REDIS, { maxRetriesPerRequest: 2 });
  const clients = async (): Promise<number> => String(await control.client("LIST")).split("\n").filter((l) => new RegExp(`\\bdb=${DB}\\b`).test(l)).length;
  try {
    const { app, port } = await start(fixture({ dispatch: `pso-shutdown-${Date.now()}` }), { RATE_LIMIT_PROVIDER: "redis", RATE_LIMIT_REDIS_URL: url, RATE_LIMIT_PER_MINUTE: "600", RATE_LIMIT_FAILURE: "closed" });
    assert.ok((await clients()) > 0, "the rate limiter is connected");
    const running = request(port, "/work/slow");
    await sleep(100);
    const closing = app.close();
    await sleep(100);
    assert.ok((await clients()) > 0, "during the drain the rate limiter is still connected: in-flight work keeps its dependencies");
    assert.equal((await running).status, 200);
    await closing;
    let n = -1;
    for (let i = 0; i < 40 && n !== 0; i++) { n = await clients(); if (n) await sleep(100); }
    assert.equal(n, 0, "after shutdown no connection of the application is left");
    const order = logs.map((l) => String(l["msg"] ?? l["message"]));
    assert.ok(order.indexOf("shutdown started") < order.indexOf("in-flight requests finished"), "drain first");
  } finally { control.disconnect(); }
});

test("under active traffic (bounded: 40 clients, about 2 s): every request the server accepted is answered; after close() nothing is accepted; shutdown is bounded", { timeout: 60_000 }, async () => {
  const { app, port } = await start(fixture());
  let answered = 0, refusedBeforeAccept = 0, cut = 0, other = 0, running = true;
  let resetAtListenerClose = 0, closeBegan = 0;
  const durations: number[] = [];
  // What the SERVER saw, independent of how the client's operating system reports a connection that never reached the application:
  // a connection that completed the TCP handshake while it was still in the accept queue when the listener closed is reset by the
  // kernel (ECONNRESET on Windows, ECONNREFUSED elsewhere). The application never accepted it, so it is not an interrupted request.
  let acceptedConnections = 0, receivedRequests = 0, clientErrors = 0;
  app.server.on("connection", () => { acceptedConnections++; });
  app.server.on("request", () => { receivedRequests++; });
  app.server.on("clientError", () => { clientErrors++; });
  // each client sends one request after another, each on a NEW connection (no keep-alive: a reused idle connection that the server
  // closes while the client writes to it is the well-known HTTP/1.1 race, not an interrupted request), mixing fast and slow (400 ms) routes
  const fresh = new http.Agent({ keepAlive: false });
  const client = async (i: number): Promise<void> => {
    for (let n = 0; running; n++) {
      const started = Date.now();
      try {
        const a = await request(port, (i + n) % 4 === 0 ? "/work/slow" : "/work/fast", fresh);
        if (a.status === 200) { answered++; durations.push(Date.now() - started); } else other++;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ECONNREFUSED") { refusedBeforeAccept++; await sleep(5); } // the listener is closed: the client was never accepted (a load balancer retries elsewhere)
        else if (code === "ECONNRESET" && closeBegan > 0) { resetAtListenerClose++; await sleep(5); } // only possible once close() began; proven below to have never reached the application
        else cut++;                                                             // any other failure, or a reset BEFORE close(): an interrupted request, must not happen
      }
    }
  };
  const clients = Array.from({ length: 40 }, (_, i) => client(i));
  await sleep(1500);
  const before = answered;
  const t0 = Date.now();
  closeBegan = t0;
  await app.close();
  const closeMs = Date.now() - t0;
  await sleep(300);
  running = false;
  await Promise.all(clients);
  durations.sort((a, b) => a - b);
  const p = (q: number): number => durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] ?? 0;
  console.log(`# traffic: answered=${answered} (before close: ${before}) cut=${cut} refused-after-close=${refusedBeforeAccept} reset-at-listener-close=${resetAtListenerClose} server: accepted=${acceptedConnections} requests=${receivedRequests} clientErrors=${clientErrors} other=${other} close()=${closeMs}ms p50=${p(0.5)}ms p99=${p(0.99)}ms`);
  assert.ok(before > 200, `the server was really under traffic (${before} requests answered before shutdown)`);
  assert.equal(cut, 0, "no request failed before close() began, and none failed with anything but a refusal/reset of a connection after it");
  assert.equal(other, 0, "no request got an error status");
  // the authoritative invariant, measured in the application: everything it accepted was served to completion
  assert.equal(acceptedConnections, receivedRequests, "every connection the application accepted delivered its request (none was destroyed while its request was in transit)");
  assert.equal(answered + other, receivedRequests, "every request the application received was answered in full (none was interrupted)");
  assert.equal(clientErrors, 0, "the HTTP parser saw no broken request");
  assert.ok(refusedBeforeAccept > 0, "after close() new connections are refused");
  assert.ok(closeMs < 3000, `shutdown waited for the slow requests in flight (400 ms) and stayed bounded (${closeMs} ms)`);
});
