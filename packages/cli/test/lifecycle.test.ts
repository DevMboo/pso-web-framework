import { test, after } from "node:test";
import { sessionEnv } from "../../../scripts/dispatch-brokers.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, StartupError, setLogSink, resetLogging, type App } from "@pso/http";
import { tmp, unusedPort } from "./helpers.ts";

/**
 * Start-up rollback (D1), readiness (D2) and strict configuration (D3), exercised through the real bootstrap() in this process
 * against a real Redis. "No leak" is measured, not assumed: the framework's connections use a Redis database nothing else uses and
 * are counted with CLIENT LIST before and after every failed start.
 */
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const dist = (pkg: string): string => JSON.stringify(join(REPO, "packages", pkg, "dist", "index.js"));
const REDIS = (sessionEnv(undefined, ["redis"]) as Record<string, string | undefined>)["PSO_TEST_REDIS_URL"] ?? "redis://127.0.0.1:1";
const redisPort = Number(new URL(REDIS).port || 6379), redisHost = new URL(REDIS).hostname;
const LEAK_DB = 11;
const LEAK_URL = `${REDIS.replace(/\/\d*$/, "")}/${LEAK_DB}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reachable = await new Promise<boolean>((r) => { const s = connect(redisPort, redisHost); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const needsRedis = { timeout: 120_000, skip: reachable ? false : "no local Redis (node scripts/dispatch-brokers.mjs up)" } as const;

const dirs: string[] = [];
const apps: App[] = [];
after(async () => { for (const a of apps) await a.close().catch(() => undefined); resetLogging(); for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

interface Fx { project: string; appDir: string; config(c: unknown, env?: string): void; withDispatch(channel: string): void; withChannels(): void }
function fixture(): Fx {
  const project = tmp("pso-lifecycle-"); dirs.push(project);
  const appDir = join(project, "dist");
  mkdirSync(appDir, { recursive: true });
  return {
    project, appDir,
    config(c, env) { writeFileSync(join(project, env ? `pso.config.${env}.json` : "pso.config.json"), JSON.stringify(c)); },
    withDispatch(channel) {
      mkdirSync(join(appDir, "dispatch", "demo"), { recursive: true });
      writeFileSync(join(appDir, "dispatch", "demo", "EVENTS.pso.js"), `const d = require(${dist("dispatch")});
class Seen { async handle() {} }
d.DispatchConsumer("demo.thing.happened")(Seen);
exports.default = d.defineEvents({ events: [{ name: "demo.thing.happened", version: 1, channel: ${JSON.stringify(channel)} }], consumers: [Seen] });
`);
    },
    withChannels() {
      mkdirSync(join(appDir, "routes", "demo"), { recursive: true });
      writeFileSync(join(appDir, "routes", "demo", "ROUTES.pso.js"), `const http = require(${dist("http")});
class PingController { ping() { return { ok: true }; } }
http.Controller()(PingController); http.RestController("/ping")(PingController); http.Get("/")(PingController.prototype, "ping"); http.Public()(PingController.prototype, "ping");
exports.PingController = PingController;
exports.default = http.defineRoutes({ routes: [{ method: "GET", path: "/ping", controller: PingController, action: "ping", security: { public: true } }] });
`);
      writeFileSync(join(appDir, "routes", "demo", "MODULE.pso.js"), `const core = require(${dist("core")}); const http = require(${dist("http")}); const ch = require(${dist("channels")});
const r = require("./ROUTES.pso.js");
class News { open() { return true; } }
ch.Channel("news", { visibility: "public" })(News); ch.OnSubscribe()(News.prototype, "open"); http.Public()(News.prototype, "open");
exports.default = core.defineModule({ name: "demo", controllers: [r.PingController], providers: [], routes: r.default, channels: [News] });
`);
    },
  };
}

/** bootstrap() reads process.env: every test states its whole environment and gets the previous one back. */
const FRAMEWORK_VARS = /^(PSO_|RATE_LIMIT_|OTEL_|MAX_|PORT$|HOST$|NODE_ENV$|REDIS_URL$)/;
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (FRAMEWORK_VARS.test(k)) delete process.env[k];
  Object.assign(process.env, { PSO_LOG_LEVEL: "info", PSO_LOG_FORMAT: "json" }, vars);
  try { return await fn(); }
  finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}
const start = async (fx: Fx, port: number): Promise<App> => { const app = await bootstrap({ appDir: fx.appDir, projectDir: fx.project, port, host: "127.0.0.1" }); apps.push(app); return app; };
const logs: string[] = [];
const capture = (): void => { logs.length = 0; setLogSink((l) => { logs.push(l); }); };
const get = async (port: number, path: string): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) }); return { status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers }; };
const refused = (port: number): Promise<void> => assert.rejects(fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1500) }), "nothing is listening");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let control: any;
async function frameworkClients(): Promise<number> {
  if (!control) { const { default: IORedis } = await import("ioredis"); control = new IORedis(REDIS, { maxRetriesPerRequest: 2 }); }
  return String(await control.client("LIST")).split("\n").filter((l) => new RegExp(`\\bdb=${LEAK_DB}\\b`).test(l)).length;
}
/** Waits (bounded) for every connection the framework opened to be gone again. */
async function assertNoRedisClients(what: string): Promise<void> {
  let n = -1;
  for (let i = 0; i < 40; i++) { n = await frameworkClients(); if (n === 0) return; await sleep(100); }
  assert.equal(n, 0, `${what}: ${n} Redis connection(s) of the failed start are still open`);
}
after(() => { control?.disconnect(); });
const RL = { RATE_LIMIT_PROVIDER: "redis", RATE_LIMIT_REDIS_URL: LEAK_URL, RATE_LIMIT_PER_MINUTE: "600", RATE_LIMIT_FAILURE: "open" };
const jwtEnv = (project: string): Record<string, string> => {
  const pem = join(project, "public.pem");
  writeFileSync(pem, generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }) as string);
  return { PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pem, PSO_JWT_ALGORITHMS: "ES256" };
};

// ------------------------------------------------------------------------------------------------ D1: lifecycle
test("start -> ready -> shutdown: the existing health contracts are unchanged and close() is idempotent", async () => {
  const fx = fixture();
  const port = await unusedPort();
  await withEnv({}, async () => {
    const app = await start(fx, port);
    assert.deepEqual(await get(port, "/health/live").then((r) => [r.status, r.body]), [200, { status: "UP" }]);
    const ready = await get(port, "/health/ready");
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body, { status: "UP", upstreams: 0 }, "an instance without dependencies answers exactly what it always answered");
    await Promise.all([app.close(), app.close()]);
    await app.close();
    await refused(port);
  });
});

test("port already in use: start-up is rejected with a diagnostic, nothing is left behind, and a later start on a free port works", needsRedis, async () => {
  const fx = fixture();
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as { port: number }).port;
  await withEnv({ ...RL }, async () => {
    capture();
    assert.equal(await frameworkClients(), 0);
    await assert.rejects(start(fx, port), (e: unknown) => {
      assert.ok(e instanceof StartupError);
      assert.match(e.message, /cannot listen on 127\.0\.0\.1:\d+: the address is already in use\nnothing was started/);
      assert.deepEqual(e.diagnostics.map((d) => d.code), ["PSO_HTTP_LISTEN"]);
      return true;
    }, "before the fix this promise never settled and the bind error was an uncaught exception");
    await assertNoRedisClients("port in use");
    assert.ok(logs.some((l) => /start-up failed: acquired resources were released/.test(l) && /rate-limit/.test(l)), "the rollback is observable in the log");
    assert.ok(!logs.some((l) => /orchestrator listening/.test(l)), "readiness was never announced");
    await new Promise<void>((r) => blocker.close(() => r()));
    const app = await start(fx, port);
    assert.equal((await get(port, "/health/ready")).status, 200, "the same process starts cleanly once the port is free");
    await app.close();
    await assertNoRedisClients("normal shutdown");
  });
});

test("dispatch failures (invalid declarations, unreachable broker) roll back what was already acquired", needsRedis, async () => {
  const port = await unusedPort();
  // 1. initialization: dispatch is enabled but declares nothing
  const empty = fixture();
  await withEnv({ ...RL, PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: LEAK_URL }, async () => {
    await assert.rejects(start(empty, port), (e: unknown) => e instanceof StartupError && /dispatch initialization failed/.test(e.message));
    await assertNoRedisClients("dispatch initialization failure");
    await refused(port);
  });
  // 2. start: declarations are valid, the broker is not there (the shared rate-limit store was already connected)
  const fx = fixture();
  fx.withDispatch("pso-lifecycle-unreachable");
  const closed = await unusedPort();
  await withEnv({ ...RL, PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: `redis://127.0.0.1:${closed}` }, async () => {
    capture();
    await assert.rejects(start(fx, port), (e: unknown) => e instanceof StartupError && /dispatch could not start/.test(e.message));
    await assertNoRedisClients("dispatch start failure");
    await refused(port);
    assert.ok(!logs.join("\n").includes(String(closed)) || !/redis:\/\//.test(logs.join("\n")), "no broker URL in the logs");
  });
});

test("channels failure after dispatch consumers started: consumers, connections and the half-built listener are all released", needsRedis, async () => {
  const fx = fixture();
  fx.withChannels();
  fx.withDispatch(`pso-lifecycle-${Date.now()}`);
  const port = await unusedPort(), closed = await unusedPort();
  await withEnv({ ...RL, ...jwtEnv(fx.project), PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: LEAK_URL, PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_REDIS_URL: `redis://127.0.0.1:${closed}` }, async () => {
    capture();
    const started = Date.now();
    await assert.rejects(start(fx, port), (e: unknown) => e instanceof StartupError && /channels could not start: cannot connect to Redis for the channels bus/.test(e.message));
    assert.ok(Date.now() - started < 30_000, "an unreachable bus fails start-up in bounded time (it used to wait forever)");
    await assertNoRedisClients("channels failure");
    await refused(port);
    const released = logs.find((l) => /start-up failed: acquired resources were released/.test(l)) ?? "";
    for (const name of ["security", "dispatch", "rate-limit", "http"]) assert.match(released, new RegExp(name), `${name} was released`);
  });
  // the same application starts once its bus is reachable: the declarations were never the problem
  await withEnv({ ...RL, ...jwtEnv(fx.project), PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: LEAK_URL, PSO_CHANNELS_BUS: "redis", PSO_CHANNELS_REDIS_URL: LEAK_URL }, async () => {
    const app = await start(fx, port);
    try {
      assert.deepEqual((await get(port, "/ping")).body, { ok: true }, "request -> route -> controller -> response");
      const ready = await get(port, "/health/ready");
      assert.equal(ready.status, 200);
      // the shared rate-limit store is optional here because its failure policy is "open" (requests are still served without it)
      assert.deepEqual(ready.body["checks"], { dispatch: { status: "UP", required: true, detail: "PING answered" }, channels: { status: "UP", required: true, detail: "PING answered" }, rateLimit: { status: "UP", required: false, detail: "PING answered" } });
      assert.ok((await frameworkClients()) >= 4, "dispatch, its reader, the bus and the limiter are connected");
    } finally { await app.close(); }
    await assertNoRedisClients("shutdown of a fully started application");
    await refused(port);
  });
});

test("telemetry exporter failure: an invalid exporter configuration stops start-up and releases the rest", needsRedis, async () => {
  const fx = fixture();
  const port = await unusedPort();
  await withEnv({ ...RL, OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector.invalid" }, async () => {
    await assert.rejects(start(fx, port), (e: unknown) => e instanceof StartupError && /http:\/\/ or https:\/\//.test(e.message));
    await assertNoRedisClients("telemetry failure");
    await refused(port);
  });
});

// ------------------------------------------------------------------------------------------------ D2: readiness
/** A TCP relay in front of Redis: the test takes the "broker" away and gives it back without touching the real server. */
async function relay(): Promise<{ port: number; down(): Promise<void>; up(): Promise<void>; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  let server: Server;
  const listen = (port: number): Promise<number> => new Promise((res, rej) => {
    server = createServer((c) => { const u = connect(redisPort, redisHost); sockets.add(c); sockets.add(u); c.pipe(u); u.pipe(c); const end = (): void => { c.destroy(); u.destroy(); sockets.delete(c); sockets.delete(u); }; c.on("error", end); u.on("error", end); c.on("close", end); u.on("close", end); });
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res((server.address() as { port: number }).port));
  });
  const port = await listen(0);
  const down = async (): Promise<void> => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); };
  return { port, down, up: async () => { await listen(port); }, close: down };
}
const until = async (what: string, ok: () => Promise<boolean>, ms = 20_000): Promise<void> => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return; await sleep(100); } assert.fail(`timed out waiting for: ${what}`); };

test("readiness follows a REQUIRED dependency: outage -> 503 with diagnostics, recovery -> 200; liveness never changes", needsRedis, async () => {
  const fx = fixture();
  fx.withDispatch(`pso-readiness-${Date.now()}`);
  const proxy = await relay();
  const port = await unusedPort();
  await withEnv({ PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: `redis://127.0.0.1:${proxy.port}/${LEAK_DB}`, PSO_READINESS_INTERVAL_MS: "250", PSO_READINESS_TIMEOUT_MS: "300" }, async () => {
    capture();
    const app = await start(fx, port);
    try {
      const healthy = await get(port, "/health/ready");
      assert.equal(healthy.status, 200);
      assert.deepEqual(healthy.body, { status: "UP", upstreams: 0, checks: { dispatch: { status: "UP", required: true, detail: "PING answered" } } }, "status and upstreams keep their meaning; checks is additive");

      await proxy.down(); // the broker goes away
      await until("readiness to fail", async () => (await get(port, "/health/ready")).status === 503);
      const down = await get(port, "/health/ready");
      assert.equal(down.body["status"], "DOWN");
      assert.equal(down.body["state"], "ready", "the instance itself is fine: a dependency is not");
      const check = (down.body["checks"] as Record<string, { status: string; required: boolean; detail?: string }>)["dispatch"]!;
      assert.deepEqual([check.status, check.required], ["DOWN", true]);
      assert.match(check.detail ?? "", /timed out|failed/, "an actionable reason");
      assert.equal(down.headers.get("retry-after"), "5");
      assert.ok(!JSON.stringify(down.body).includes(String(proxy.port)) && !/redis:\/\//.test(JSON.stringify(down.body)), "no address, port or URL of the dependency is exposed");
      assert.deepEqual(await get(port, "/health/live").then((r) => [r.status, r.body]), [200, { status: "UP" }], "liveness is not a dependency check: the process must not be restarted for a broker outage");
      assert.ok(logs.some((l) => /dependency unavailable/.test(l) && /"dependency":"dispatch"/.test(l)), "the transition is logged once");

      const before = Date.now();
      for (let i = 0; i < 200; i++) await fetch(`http://127.0.0.1:${port}/health/ready`).then((r) => r.arrayBuffer());
      assert.ok(Date.now() - before < 5000, `200 readiness requests during an outage took ${Date.now() - before} ms: the endpoint reads a cached result`);

      await proxy.up(); // the broker is back
      await until("readiness to recover", async () => (await get(port, "/health/ready")).status === 200, 30_000);
      assert.ok(logs.some((l) => /dependency available/.test(l)), "recovery is logged");
    } finally { await app.close(); await proxy.close().catch(() => undefined); }
  });
});

test("an OPTIONAL dependency that is down is reported and the instance stays ready", needsRedis, async () => {
  const fx = fixture();
  fx.withDispatch(`pso-readiness-optional-${Date.now()}`);
  fx.config({ http: { readiness: { optional: ["dispatch"], intervalMs: 250, timeoutMs: 300 } } });
  const proxy = await relay();
  const port = await unusedPort();
  await withEnv({ PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: `redis://127.0.0.1:${proxy.port}/${LEAK_DB}` }, async () => {
    const app = await start(fx, port);
    try {
      await proxy.down();
      await until("the outage to be reported", async () => ((await get(port, "/health/ready")).body["checks"] as Record<string, { status: string }>)["dispatch"]!.status === "DOWN");
      const r = await get(port, "/health/ready");
      assert.equal(r.status, 200, "an optional dependency never takes the instance out of rotation");
      assert.equal(r.body["status"], "UP");
      assert.deepEqual([(r.body["checks"] as Record<string, { required: boolean }>)["dispatch"]!.required], [false]);
    } finally { await proxy.up().catch(() => undefined); await app.close(); await proxy.close().catch(() => undefined); }
  });
});

test("shutdown during a broker outage finishes promptly (it used to wait forever on the reconnecting consumer) and leaves nothing running", needsRedis, async () => {
  const fx = fixture();
  fx.withDispatch(`pso-shutdown-outage-${Date.now()}`);
  const proxy = await relay();
  const port = await unusedPort();
  await withEnv({ PSO_DISPATCH_ENABLED: "true", PSO_DISPATCH_PROVIDER: "redis", PSO_DISPATCH_REDIS_URL: `redis://127.0.0.1:${proxy.port}/${LEAK_DB}`, PSO_READINESS_INTERVAL_MS: "250", PSO_READINESS_TIMEOUT_MS: "300" }, async () => {
    capture();
    const app = await start(fx, port);
    await proxy.down();
    await until("the outage to be noticed", async () => (await get(port, "/health/ready")).status === 503);
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 5000, `close() took ${Date.now() - started} ms with the broker down`);
    assert.ok(!logs.some((l) => /resource release (timed out|failed)/.test(l)), "every resource was released cleanly, none had to be abandoned");
    await refused(port);
    await assertNoRedisClients("shutdown during an outage");
  });
});

// ------------------------------------------------------------------------------------------------ D3: configuration
test("a misspelled key stops a production start (strict), is reported in development, and its value is never printed", async () => {
  const fx = fixture();
  fx.config({ http: { rateLimit: { perMinuet: 5 } }, security: { authentication: { jwks: { urii: "https://secret-tenant.example/keys" } } }, app: { anything: { goes: true } } });
  const port = await unusedPort();
  await withEnv({ PSO_ENV: "production" }, async () => {
    capture();
    await assert.rejects(start(fx, port), (e: unknown) => {
      assert.ok(e instanceof StartupError);
      assert.match(e.message, /Unknown configuration key "http\.rateLimit\.perMinuet" in pso\.config\.json \(Did you mean "http\.rateLimit\.perMinute"\?\)/);
      assert.match(e.message, /Unknown configuration key "security\.authentication\.jwks\.urii" in pso\.config\.json \(Did you mean "security\.authentication\.jwks\.uri"\?\)/);
      assert.ok(!e.message.includes("app.anything"), "the app.* namespace belongs to the application");
      assert.ok(!e.message.includes("secret-tenant"), "values are never echoed");
      assert.match(e.message, /nothing was started/);
      return true;
    });
    await refused(port);
  });
  await withEnv({ PSO_ENV: "production", PSO_CONFIG_STRICT: "false" }, async () => { // the documented, explicit way to keep the old behaviour
    capture();
    const app = await start(fx, port);
    assert.equal(logs.filter((l) => /unknown configuration key ignored/.test(l)).length, 2);
    await app.close();
  });
  await withEnv({}, async () => { // development: starts, and the typo is visible on every start instead of silently ignored
    capture();
    const app = await start(fx, port);
    const warned = logs.filter((l) => /unknown configuration key ignored/.test(l));
    assert.equal(warned.length, 2);
    assert.ok(warned.every((l) => !l.includes("secret-tenant")), "no value in the log");
    assert.match(warned.join("\n"), /Did you mean \\"http\.rateLimit\.perMinute\\"\?/);
    await app.close();
  });
  await withEnv({ PSO_CONFIG_STRICT: "true", PSO_CFG_http__limits__maxBodyBytez: "10" }, async () => { // CI: strict on demand, PSO_CFG_* variables included
    await assert.rejects(start(fixture(), port), (e: unknown) => e instanceof StartupError && /Unknown configuration key "http\.limits\.maxBodyBytez" in PSO_CFG_\* variables/.test(e.message));
  });
});

test("valid configuration (files, environment file, variables) passes strict validation and precedence is unchanged", async () => {
  const fx = fixture();
  fx.config({ http: { limits: { maxBodyBytes: 2048, maxUploadBytes: 4096 }, rateLimit: { perMinute: 100, routes: [{ route: "GET /ping", limit: 5 }] }, upstreams: { users: { forward: "none" } }, readiness: { optional: ["dispatch"] } }, logging: { level: "warn", format: "json" }, channels: { path: "/rt" } });
  fx.config({ http: { limits: { maxBodyBytes: 4096 } } }, "production");
  const port = await unusedPort();
  await withEnv({ PSO_ENV: "production", PSO_CFG_logging__level: "info" }, async () => {
    capture();
    const app = await start(fx, port);
    assert.equal((await get(port, "/health/ready")).status, 200);
    assert.ok(!logs.some((l) => /unknown configuration key/.test(l)));
    assert.ok(logs.some((l) => /orchestrator listening/.test(l)), "PSO_CFG_logging__level=info overrides the file's warn: variables still win over files");
    await app.close();
  });
});
