import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, buildServicePath, describeError, problemKindOf, StartupError, setLogSink, resetLogging, UpstreamCallError, type App } from "@pso/http";
import { startupProblems } from "../../http/src/diagnostics.ts";
import { tmp, unusedPort } from "./helpers.ts";

/**
 * Runtime pieces of DEAM exercised through the real bootstrap() in this process:
 *   F-17  lifecycle hooks are providers a module declares; they run in a defined order, a failing one stops start-up and releases
 *         everything, and a class nobody declares is never constructed;
 *   F-07  an invalid Dispatch configuration names every property at fault, as structured fields, without credentials;
 *   F-06  what the log records about an unexpected error; F-14/F-22 the path and problem rules of the service client.
 */
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const dist = (pkg: string): string => JSON.stringify(join(REPO, "packages", pkg, "dist", "index.js"));
const dirs: string[] = [];
const apps: App[] = [];
after(async () => { for (const a of apps) await a.close().catch(() => undefined); resetLogging(); for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

const FRAMEWORK_VARS = /^(PSO_|RATE_LIMIT_|OTEL_|MAX_|PORT$|HOST$|NODE_ENV$|REDIS_URL$)/;
const logs: Array<Record<string, unknown>> = [];
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (FRAMEWORK_VARS.test(k)) delete process.env[k];
  Object.assign(process.env, { PSO_LOG_LEVEL: "info", PSO_LOG_FORMAT: "json", RATE_LIMIT_PER_MINUTE: "0" }, vars);
  logs.length = 0;
  setLogSink((l) => { try { logs.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not JSON */ } });
  try { return await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}
const refused = (port: number): Promise<boolean> => new Promise((r) => { const s = connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(false); }); s.once("error", () => r(true)); });

/** One module whose providers record every lifecycle call in globalThis.__psoHooks[tag]. */
function hooksFixture(tag: string, o: { failReady?: boolean } = {}): { project: string; appDir: string } {
  const project = tmp("pso-hooks-"); dirs.push(project);
  const appDir = join(project, "dist");
  mkdirSync(join(appDir, "routes", "demo"), { recursive: true });
  writeFileSync(join(appDir, "routes", "demo", "ROUTES.pso.js"), `const http = require(${dist("http")});
const calls = ((globalThis.__psoHooks ??= {})[${JSON.stringify(tag)}] = []);
class Clock { constructor() { calls.push("construct:Clock"); } now() { return 1; } }
http.Injectable()(Clock);
class First { constructor(clock) { this.clock = clock; calls.push("construct:First"); } async onReady() { calls.push("ready:First:" + this.clock.now()); } async onShutdown() { calls.push("shutdown:First"); } }
http.Injectable()(First); Reflect.defineMetadata("design:paramtypes", [Clock], First);
class Second { async onReady() { calls.push("ready:Second"); ${o.failReady ? 'throw new Error("database password=hunter2 unreachable");' : ""} } async onShutdown() { calls.push("shutdown:Second"); } }
http.Injectable()(Second);
class OnlyShutdown { onShutdown() { calls.push("shutdown:OnlyShutdown"); } }
http.Injectable()(OnlyShutdown);
class Undeclared { constructor() { calls.push("construct:Undeclared"); } onReady() { calls.push("ready:Undeclared"); } }
http.Injectable()(Undeclared);
class PingController { ping() { return { ok: true }; } }
http.Controller()(PingController); http.RestController("/ping")(PingController); http.Get("/")(PingController.prototype, "ping"); http.Public()(PingController.prototype, "ping");
Object.assign(exports, { Clock, First, Second, OnlyShutdown, Undeclared, PingController });
exports.default = http.defineRoutes({ routes: [{ method: "GET", path: "/ping", controller: PingController, action: "ping", security: { public: true } }] });
`);
  writeFileSync(join(appDir, "routes", "demo", "MODULE.pso.js"), `const core = require(${dist("core")});
const r = require("./ROUTES.pso.js");
// Undeclared is NOT listed: it must never be constructed or called
exports.default = core.defineModule({ name: "demo", controllers: [r.PingController], providers: [r.Clock, r.First, r.Second, r.OnlyShutdown], routes: r.default });
`);
  return { project, appDir };
}
const calls = (tag: string): string[] => (globalThis as unknown as { __psoHooks: Record<string, string[]> }).__psoHooks[tag]!;

test("lifecycle hooks: declared providers run onReady in order before the application is ready and onShutdown in reverse order, once", async () => {
  const fx = hooksFixture("ok");
  const port = await unusedPort();
  await withEnv({}, async () => {
    const app = await bootstrap({ appDir: fx.appDir, projectDir: fx.project, port, host: "127.0.0.1" });
    apps.push(app);
    assert.deepEqual(calls("ok").filter((c) => c.startsWith("ready")), ["ready:First:1", "ready:Second"], "module order; dependencies were injected");
    assert.ok(!calls("ok").some((c) => c.includes("Undeclared")), "a class no module declares is never constructed or called");
    const ran = logs.findIndex((l) => l["msg"] === "lifecycle hooks ran"), listening = logs.findIndex((l) => l["msg"] === "orchestrator listening");
    assert.deepEqual(logs[ran]!["hooks"], ["First", "Second", "OnlyShutdown"]);
    assert.ok(ran >= 0 && ran < listening, "hooks finish before the application reports that it is listening");
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ping`)).status, 200);
    await app.close();
    await app.close(); // idempotent
    assert.deepEqual(calls("ok").filter((c) => c.startsWith("shutdown")), ["shutdown:OnlyShutdown", "shutdown:Second", "shutdown:First"], "reverse order, each exactly once");
  });
});

test("lifecycle hooks: a failing onReady stops start-up, releases what was acquired and never reports ready; dryRun runs no hook", async () => {
  const fx = hooksFixture("fail", { failReady: true });
  const port = await unusedPort();
  await withEnv({}, async () => {
    await assert.rejects(bootstrap({ appDir: fx.appDir, projectDir: fx.project, port, host: "127.0.0.1" }), (e: unknown) =>
      e instanceof StartupError && /the start-up hook Second\.onReady failed/.test(e.message) && e.diagnostics.some((d) => d.code === "PSO_HOOK_FAILED") && !/hunter2/.test(e.message));
    assert.ok(await refused(port), "nothing is listening after a failed start");
    assert.deepEqual(calls("fail").filter((c) => c.startsWith("shutdown")), ["shutdown:First"], "the hook that had started is stopped; the one that failed and the ones after it are not");
    const failed = logs.find((l) => l["msg"] === "a start-up hook failed")!;
    assert.equal(failed["hook"], "Second");
    assert.equal(failed["error"], "Error");
    assert.equal(failed["message"], undefined, "the message of the error is not recorded by default");
    assert.ok(!logs.some((l) => l["msg"] === "orchestrator listening"));
  });
  const dry = hooksFixture("dry");
  await withEnv({}, async () => {
    const app = await bootstrap({ appDir: dry.appDir, projectDir: dry.project, dryRun: true });
    assert.ok(!calls("dry").some((c) => c.startsWith("ready") || c.startsWith("shutdown")), "a dry run validates and starts nothing");
    await app.close();
  });
});

test("an invalid Dispatch configuration names every property at fault, in the error and as structured log fields, without credentials", async () => {
  const project = tmp("pso-dispatch-cfg-"); dirs.push(project);
  const appDir = join(project, "dist");
  mkdirSync(appDir, { recursive: true });
  const start = (): Promise<App> => bootstrap({ appDir, projectDir: project, port: 0, host: "127.0.0.1", dryRun: true });
  // several things are wrong at once: an unknown provider value, a retry setting out of range, a duration that is not one
  writeFileSync(join(project, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, provider: "redis", retry: { maxAttempts: 99, initialDelay: "soon" }, redis: { url: "redis://app:hunter2@127.0.0.1:6379/0" } } }));
  await withEnv({}, async () => {
    let error: StartupError | undefined;
    await assert.rejects(start(), (e: unknown) => { error = e as StartupError; return e instanceof StartupError; });
    const message = error!.message;
    assert.match(message, /^dispatch initialization failed: invalid dispatch configuration:\n - /, "the summary is followed by the problems, not cut after the first line");
    assert.match(message, /dispatch\.retry\.maxAttempts/);
    assert.match(message, /dispatch\.retry\.initialDelay/);
    assert.match(message, /"soon" is not a duration/, "with the reason");
    assert.ok(!/hunter2/.test(message), "a credential of the configuration is never part of the message");
    assert.ok(error!.diagnostics.length >= 2, "one diagnostic per property");
    assert.ok(error!.diagnostics.every((d) => /^PSO_/.test(d.code)));
    const logged = logs.find((l) => l["msg"] === "dispatch initialization failed")!;
    assert.equal(logged["component"], "dispatch");
    assert.equal(logged["code"], "PSO_DISPATCH_CONFIG");
    assert.ok(Array.isArray(logged["problems"]) && (logged["problems"] as string[]).length >= 2, "every problem is a field of the log entry");
    assert.ok((logged["problems"] as string[]).some((p) => p.includes("dispatch.retry.maxAttempts")) && (logged["problems"] as string[]).some((p) => p.includes("dispatch.retry.initialDelay")));
    assert.ok((logged["properties"] as string[]).includes("dispatch.retry.initialDelay"), "the properties that carry a key are listed on their own");
    assert.ok(!/hunter2/.test(JSON.stringify(logs)), "no log entry carries the credential");
  });
  // a missing value: the property that must be set is named
  writeFileSync(join(project, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, provider: "kafka" } }));
  await withEnv({}, async () => {
    await assert.rejects(start(), (e: unknown) => e instanceof StartupError && /dispatch\.kafka\.brokers/.test(e.message));
  });
  // an incompatible provider value
  writeFileSync(join(project, "pso.config.json"), JSON.stringify({ dispatch: { enabled: true, provider: "nats" } }));
  await withEnv({}, async () => {
    await assert.rejects(start(), (e: unknown) => e instanceof StartupError && /dispatch\.provider/.test(e.message));
  });
});

test("what the log records about an unexpected error: where always, what only on request, credentials never", () => {
  const inner = new Error("connection to postgres://app:hunter2@db/prod failed");
  const err = Object.assign(new Error("lookup failed: Bearer abcdefghijklmnop token=s3cr3t-value", { cause: inner }), { code: "E_LOOKUP" });
  const safe = describeError(err, false);
  assert.deepEqual(Object.keys(safe).sort(), ["code", "error", "origin"]);
  assert.equal(safe["error"], "Error"); assert.equal(safe["code"], "E_LOOKUP");
  assert.match(String(safe["origin"]), /deam-runtime\.test\.ts:\d+:\d+/, "the first frame of application code: where, not what");
  const full = describeError(err, true);
  assert.equal(full["message"], "lookup failed: Bearer [REDACTED] token=[REDACTED]");
  assert.ok(Array.isArray(full["stack"]) && (full["stack"] as string[]).length > 0);
  assert.deepEqual(full["causes"], ["Error: connection to postgres://[REDACTED]@db/prod failed"]);
  assert.ok(!/hunter2|s3cr3t|abcdefghijklmnop/.test(JSON.stringify(full)));
  assert.deepEqual(describeError("a string was thrown", false), { error: "non-error value thrown" });
  assert.equal(describeError(Object.assign(new Error("x"), { code: "not a stable code!" }), false)["code"], undefined);
  // start-up problems of an optional subsystem
  const cfg = Object.assign(new Error("invalid dispatch configuration:\n - A (dispatch.x): bad\n - B: worse"), { code: "PSO_DISPATCH_CONFIG", issues: [{ code: "A", key: "dispatch.x", message: "bad" }, { code: "B", message: "worse url redis://u:pw@h" }] });
  const p = startupProblems(cfg);
  assert.equal(p.summary, "invalid dispatch configuration");
  assert.deepEqual(p.problems, ["A (dispatch.x): bad", "B: worse url redis://[REDACTED]@h"]);
  assert.deepEqual(startupProblems(new Error("one line only")).problems, ["one line only"]);
});

test("service client rules: a path is a literal path of the service with encoded parameters; each failure has one stable problem", () => {
  assert.equal(buildServicePath("customers", "/customers/:id/orders/:order", { id: "c 1", order: 7 }), "/customers/c%201/orders/7");
  assert.equal(buildServicePath("customers", "/customers/:id", { id: "../../admin" }), "/customers/..%2F..%2Fadmin", "a parameter is always one segment");
  assert.equal(buildServicePath("customers", "/health"), "/health");
  for (const [path, params] of [["customers", {}], ["http://evil.example/x", {}], ["//evil.example/x", {}], ["/a/../b", {}], ["/a/./b", {}], ["/a?x=1", {}], ["/a#b", {}], ["/a b", {}], ["/a\\b", {}], ["/%2e%2e/x", {}], ["/a/%2Fb", {}], ["/:id", {}], ["/:id", { id: "" }], ["/:id", { id: ".." }], ["/x", { unused: "1" }], ["/a/%zz", {}]] as Array<[string, Record<string, string>]>) {
    assert.throws(() => buildServicePath("customers", path, params), (e: unknown) => e instanceof UpstreamCallError && e.kind === "policy", `${path} ${JSON.stringify(params)}`);
  }
  const kind = (k: ConstructorParameters<typeof UpstreamCallError>[1], status?: number): string => problemKindOf(new UpstreamCallError("svc", k, "m", status === undefined ? {} : { status }));
  assert.equal(kind("status", 404), "upstream_not_found");
  assert.equal(kind("status", 409), "upstream_conflict");
  for (const s of [400, 401, 403, 422, 302]) assert.equal(kind("status", s), "upstream_rejected", String(s));
  for (const s of [500, 502, 503]) assert.equal(kind("status", s), "bad_gateway", String(s));
  assert.equal(kind("timeout"), "upstream_timeout"); assert.equal(kind("unavailable"), "upstream_unavailable"); assert.equal(kind("tls"), "upstream_tls");
  assert.equal(kind("response_too_large"), "upstream_response_too_large"); assert.equal(kind("policy"), "upstream_policy"); assert.equal(kind("unknown_service"), "unknown_service");
  assert.equal(kind("invalid_response"), "bad_gateway");
  assert.equal(new UpstreamCallError("svc", "status", "m", { status: 404 }).is(404), true);
  assert.equal(new UpstreamCallError("svc", "timeout", "m").is(404), false);
});
