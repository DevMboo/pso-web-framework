import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pso, tmp, prepare, unusedPort } from "./helpers.ts";
import { ownedBroker, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";

/**
 * Shutdown of the GENERATED application process (SHUT-01), not of app.close(). The defect: the generated main.ts ended the process
 * 10 s after a signal, whatever http.shutdown.graceMs said, so a 12 s request under a 15 s grace period was cut and the exit code was
 * 1. Now main.ts hands the application to shutdownOnSignals(), whose emergency deadline is the configured grace period plus the
 * cleanup time (app.shutdown.deadlineMs).
 *
 * Every test starts `node dist/main.js` of a project created by `pso create orchestrator` and asks it to stop the way the platform
 * does: SIGTERM on POSIX; on Windows, which has no SIGTERM, the IPC message "shutdown" that the same handler accepts.
 */
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dirs: string[] = [];
const children: ChildProcess[] = [];
const brokers: Array<{ remove(): void }> = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const b of brokers) b.remove();
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } }
});

let gw = "";
let pub = "";
before(async () => {
  const base = tmp("pso-proc-shutdown-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gw", "--structure", "legacy")).code, 0);
  gw = join(ws, "gw");
  // the generated entry point is what runs: it must not carry a deadline of its own
  const main = readFileSync(join(gw, "src", "main.ts"), "utf8");
  assert.match(main, /\.then\(\(app\) => \{ shutdownOnSignals\(app\); \}\)/);
  assert.doesNotMatch(main, /setTimeout|10_000/, "no fixed exit timer in the generated main.ts");
  prepare(gw);
  // one more module, written as compiled output: GET /work/wait/<ms> answers after that long, GET /work/stuck never answers
  mkdirSync(join(gw, "dist", "routes", "work"), { recursive: true });
  writeFileSync(join(gw, "dist", "routes", "work", "ROUTES.pso.js"), `const http = require("@pso/http");
class WorkController {
  async w400() { await new Promise((r) => setTimeout(r, 400)); return { waited: 400 }; }
  async w1500() { await new Promise((r) => setTimeout(r, 1500)); return { waited: 1500 }; }
  async w12000() { await new Promise((r) => setTimeout(r, 12000)); return { waited: 12000 }; }
  stuck() { return new Promise(() => {}); }
}
http.Controller()(WorkController); http.RestController("/work")(WorkController);
const actions = ["w400", "w1500", "w12000", "stuck"];
for (const a of actions) { http.Get("/" + a)(WorkController.prototype, a); http.Public()(WorkController.prototype, a); }
exports.WorkController = WorkController;
exports.default = http.defineRoutes({ routes: actions.map((a) => ({ method: "GET", path: "/work/" + a, controller: WorkController, action: a, security: { public: true } })) });
`);
  writeFileSync(join(gw, "dist", "routes", "work", "MODULE.pso.js"), `const core = require("@pso/core");
const r = require("./ROUTES.pso.js");
exports.default = core.defineModule({ name: "work", controllers: [r.WorkController], providers: [], routes: r.default });
`);
  pub = join(base, "pub.pem");
  writeFileSync(pub, generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }));
}, { timeout: 420_000 });

interface Line { level?: string; msg?: string; [k: string]: unknown }
interface Proc { child: ChildProcess; port: number; lines(): Line[]; stop(): void; exit: Promise<{ code: number | null; signal: string | null; at: number }> }
async function launch(vars: Record<string, string> = {}, expectStart = true): Promise<Proc> {
  const port = await unusedPort();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PSO_|RATE_LIMIT_|OTEL_|NODE_ENV$|PORT$|HOST$|REDIS_URL$|RABBITMQ_URL$|NODE_TEST_CONTEXT$)/.test(k)) env[k] = v;
  Object.assign(env, { PORT: String(port), PSO_LOG_FORMAT: "json", PSO_LOG_LEVEL: "info", RATE_LIMIT_PER_MINUTE: "100000", PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256" }, vars);
  const child = spawn(process.execPath, ["dist/main.js"], { cwd: gw, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", (d: Buffer) => { out += d; });
  child.stderr!.on("data", (d: Buffer) => { out += d; });
  const exit = new Promise<{ code: number | null; signal: string | null; at: number }>((r) => child.once("exit", (code, signal) => r({ code, signal, at: Date.now() })));
  const lines = (): Line[] => out.split(/\r?\n/).flatMap((l) => { try { return l.startsWith("{") ? [JSON.parse(l) as Line] : []; } catch { return []; } });
  if (expectStart) {
    for (let i = 0; i < 300 && !/orchestrator listening/.test(out) && child.exitCode === null; i++) await sleep(100);
    assert.match(out, /orchestrator listening/, `the generated application started:\n${out}`);
  }
  // the request to stop, as the platform delivers it
  const stop = (): void => { if (process.platform === "win32") child.send("shutdown"); else child.kill("SIGTERM"); };
  return { child, port, lines, stop, exit };
}
/** One request on its own connection: the status, or "cut" when the connection ended without a response. */
function get(port: number, path: string): Promise<{ status: number | "cut"; ms: number }> {
  const t = Date.now();
  return new Promise((res) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (r) => { r.resume(); r.on("end", () => res({ status: r.statusCode ?? 0, ms: Date.now() - t })); r.on("error", () => res({ status: "cut", ms: Date.now() - t })); });
    req.on("error", () => res({ status: "cut", ms: Date.now() - t }));
  });
}
const has = (p: Proc, msg: string): Line | undefined => p.lines().find((l) => l.msg === msg);

test("a stop request with no request running: the process exits 0 at once, with the deadline it derived from the configuration", { timeout: 60_000 }, async () => {
  const p = await launch();
  const t = Date.now(); p.stop();
  const e = await p.exit;
  assert.equal(e.code, 0);
  assert.ok(e.at - t < 3000, `exit after ${e.at - t} ms`);
  assert.equal(has(p, "shutting down")?.["deadlineMs"], 5000 + 10_000 + 1000, "default grace 5 s + cleanup 10 s + 1 s");
  assert.equal(has(p, "shutdown complete")?.["exitCode"], 0);
});

test("requests that are running when the stop request arrives finish with 200, then the process exits 0", { timeout: 60_000 }, async () => {
  const p = await launch();
  const one = get(p.port, "/work/w400");
  await sleep(120); p.stop();
  assert.equal((await one).status, 200);
  assert.equal((await p.exit).code, 0);

  const q = await launch();
  const many = Array.from({ length: 8 }, () => get(q.port, "/work/w400"));
  await sleep(150); q.stop();
  assert.deepEqual((await Promise.all(many)).map((r) => r.status), Array(8).fill(200), "every running request was answered");
  assert.equal((await q.exit).code, 0);
  assert.equal(has(q, "in-flight requests finished") !== undefined, true);
});

test("a request that outlives the grace period is cut when the period ends, and the process still exits in bounded time", { timeout: 60_000 }, async () => {
  const p = await launch({ PSO_SHUTDOWN_GRACE_MS: "1000", PSO_SHUTDOWN_CLEANUP_MS: "2000" });
  const stuck = get(p.port, "/work/stuck");
  await sleep(150);
  const t = Date.now(); p.stop();
  const [r, e] = await Promise.all([stuck, p.exit]);
  assert.equal(r.status, "cut");
  assert.ok(e.at - t >= 950, `the grace period was honoured (${e.at - t} ms)`);
  assert.ok(e.at - t < 1000 + 2000 + 1000, `bounded by the deadline (${e.at - t} ms)`);
  assert.equal(e.code, 0, "the shutdown itself completed: cutting what exceeded the configured period is the configured behaviour");
  assert.equal(has(p, "the shutdown grace period ended with requests still running; their connections are closed now")?.["interrupted"], 1);
});

test("grace period 15 s, request 12 s: the request completes and the process exits 0 (the generated main.ts used to exit 1 after 10 s)", { timeout: 90_000 }, async () => {
  const p = await launch({ PSO_SHUTDOWN_GRACE_MS: "15000" });
  const long = get(p.port, "/work/w12000");
  await sleep(200);
  const t = Date.now(); p.stop();
  const [r, e] = await Promise.all([long, p.exit]);
  assert.equal(r.status, 200, "the 12 s request was answered");
  assert.ok(r.ms >= 11_900, `it really ran 12 s (${r.ms} ms)`);
  assert.equal(e.code, 0);
  const took = e.at - t;
  assert.ok(took > 10_500 && took < 15_000, `the process waited for the request, past the old 10 s limit, and not for the whole period (${took} ms)`);
  assert.equal(has(p, "shutting down")?.["deadlineMs"], 15_000 + 10_000 + 1000);
});

test("repeated stop requests run one shutdown: the running request still finishes and the exit code is 0", { timeout: 60_000 }, async () => {
  const p = await launch();
  const r = get(p.port, "/work/w1500");
  await sleep(150);
  p.stop(); await sleep(100); p.stop(); await sleep(100); p.stop();
  assert.equal((await r).status, 200);
  assert.equal((await p.exit).code, 0);
  assert.equal(p.lines().filter((l) => l.msg === "shutting down").length, 1);
  assert.equal(p.lines().filter((l) => l.msg === "shutdown started").length, 1);
  assert.equal(p.lines().filter((l) => l.msg === "shutdown already in progress; the repeated request is ignored").length, 1);
});

test("a grace period at the supported maximum does not delay an idle process, and one above it is a start-up failure", { timeout: 60_000 }, async () => {
  const p = await launch({ PSO_SHUTDOWN_GRACE_MS: "300000", PSO_SHUTDOWN_CLEANUP_MS: "120000" });
  const r = get(p.port, "/work/w400");
  await sleep(120);
  const t = Date.now(); p.stop();
  assert.equal((await r).status, 200);
  const e = await p.exit;
  assert.equal(e.code, 0);
  assert.ok(e.at - t < 5000, `exit after ${e.at - t} ms`);
  assert.equal(has(p, "shutting down")?.["deadlineMs"], 300_000 + 120_000 + 1000);
  // start-up failure handling is unchanged: one log line, exit code 1, nothing listening
  const bad = await launch({ PSO_SHUTDOWN_GRACE_MS: "300001" }, false);
  assert.equal((await bad.exit).code, 1);
  assert.match(String(has(bad, "startup failed")?.["error"]), /PSO_SHUTDOWN_GRACE_MS must be a whole number between 0 and 300000/);
});

const noDocker = dockerAvailable() ? false : "no Docker engine: real broker tests not run";
for (const [kind, config] of [
  ["redis", (url: string) => ({ dispatch: { enabled: true, provider: "redis", redis: { url, block: "200ms" } } })],
  ["rabbitmq", (url: string) => ({ dispatch: { enabled: true, provider: "rabbitmq", rabbitmq: { url } } })],
] as const) {
  test(`${kind} becomes unavailable before the stop request: the shutdown is still bounded and the process exits`, { skip: noDocker, timeout: 300_000 }, async () => {
    const own = await (ownedBroker as (k: string) => Promise<{ url: string; stop(): void; remove(): void }>)(kind);
    brokers.push(own);
    mkdirSync(join(gw, "dist", "dispatch", "demo"), { recursive: true });
    writeFileSync(join(gw, "dist", "dispatch", "demo", "EVENTS.pso.js"), `const d = require("@pso/dispatch");
class Seen { async handle() {} }
d.DispatchConsumer("demo.thing.happened")(Seen);
exports.default = d.defineEvents({ events: [{ name: "demo.thing.happened", version: 1, channel: "proc-shutdown-${kind}" }], consumers: [Seen] });
`);
    writeFileSync(join(gw, "pso.config.json"), JSON.stringify(config(own.url))); // a freshly generated orchestrator has no configuration file
    try {
      const p = await launch({ PSO_SHUTDOWN_GRACE_MS: "1000", PSO_SHUTDOWN_CLEANUP_MS: "20000" });
      const running = get(p.port, "/work/w400");
      own.stop(); // the dependency is gone while the application runs
      await sleep(300);
      const t = Date.now(); p.stop();
      assert.equal((await running).status, 200, "a request that does not need the broker still finishes");
      const e = await p.exit;
      const took = e.at - t;
      assert.ok(took < 1000 + 20_000 + 1000 + 500, `ended within the deadline (${took} ms)`);
      // 0: every resource was released (or gave up within its own bound); 1: the emergency deadline ended the process. Never a hang.
      assert.equal(e.code, 0, `exit code ${e.code} after ${took} ms\n${p.lines().map((l) => `${l.level} ${l.msg}`).join("\n")}`);
      assert.equal(has(p, "shutdown complete")?.["exitCode"], 0);
    } finally { rmSync(join(gw, "pso.config.json"), { force: true }); rmSync(join(gw, "dist", "dispatch"), { recursive: true, force: true }); }
  });
}

/** The process-level contract of shutdownOnSignals with an application whose close() misbehaves: a real process, a real exit code. */
function harness(close: string, shutdown: string): Promise<{ code: number | null; ms: number; out: string }> {
  const code = `const { shutdownOnSignals, configureLogging } = require(${JSON.stringify(join(REPO, "packages", "http", "dist", "index.js"))});
configureLogging({ PSO_LOG_FORMAT: "json", PSO_LOG_LEVEL: "info" });
const h = shutdownOnSignals({ close: ${close}, shutdown: ${shutdown} });
setInterval(() => {}, 1000);
process.send("ready");`;
  return new Promise((res) => {
    const c = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(c);
    let out = ""; c.stdout!.on("data", (d: Buffer) => { out += d; }); c.stderr!.on("data", (d: Buffer) => { out += d; });
    let t = 0;
    c.once("message", () => { t = Date.now(); if (process.platform === "win32") c.send("shutdown"); else c.kill("SIGTERM"); });
    c.once("exit", (codeOut) => res({ code: codeOut, ms: Date.now() - t, out }));
  });
}

test("cleanup that never finishes: the process is ended with exit code 1 at the emergency deadline, not before and not never", { timeout: 60_000 }, async () => {
  const r = await harness("() => new Promise(() => {})", "{ graceMs: 300, cleanupMs: 1000, deadlineMs: 1500 }");
  assert.equal(r.code, 1);
  assert.ok(r.ms >= 1450 && r.ms < 4000, `ended at the deadline (${r.ms} ms)`);
  assert.match(r.out, /shutdown did not finish before its deadline; the process is ended now/);
  assert.doesNotMatch(r.out, /shutdown complete/);
});

test("a shutdown that fails exits 1; one that succeeds exits 0 without waiting for the deadline", { timeout: 60_000 }, async () => {
  const failed = await harness("() => Promise.reject(new Error('boom secret=hunter2'))", "{ graceMs: 300, cleanupMs: 1000, deadlineMs: 20000 }");
  assert.equal(failed.code, 1);
  assert.match(failed.out, /"msg":"shutdown failed"/);
  assert.doesNotMatch(failed.out, /hunter2/, "the error message (which can carry a URL or a credential) is not logged");
  const fine = await harness("() => new Promise((r) => setTimeout(r, 200))", "{ graceMs: 300, cleanupMs: 1000, deadlineMs: 20000 }");
  assert.equal(fine.code, 0);
  assert.ok(fine.ms < 3000, `no wait for the deadline (${fine.ms} ms)`);
});
