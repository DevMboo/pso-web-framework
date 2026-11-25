import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { WorkspaceConfig } from "@pso/core";
import { startStudio } from "../src/studio.ts";
import { classifyTelemetry, type TelemetryRow } from "../src/studio-data.ts";
import { randomPort } from "./helpers.ts";
import { buildGateway, type Gw } from "./gw-fixture.ts";

const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); });
const TOKEN = "s".repeat(48);

function getJson<T>(port: number, cookie: string, path: string): Promise<{ status: number; body: T; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, cookie } }, (res) => {
      let raw = ""; res.on("data", (d: Buffer) => { raw += d; });
      res.on("end", () => resolve({ status: res.statusCode!, body: (raw ? JSON.parse(raw) : {}) as T, raw }));
    });
    req.on("error", reject); req.end();
  });
}

test("classification rules are deterministic and explain themselves", () => {
  const healthy = { state: "ready", readiness: { status: "UP" }, http: { requests: 100, byClass: { "5xx": 1 } }, upstream: {}, rateLimit: { backendFailures: 0 }, dispatch: null };
  assert.equal(classifyTelemetry(healthy).state, "healthy");
  assert.match(classifyTelemetry({ ...healthy, state: "draining" }).reason, /draining/);
  assert.match(classifyTelemetry({ ...healthy, readiness: { status: "DOWN" } }).reason, /readiness/);
  assert.equal(classifyTelemetry({ ...healthy, http: { requests: 19, byClass: { "5xx": 19 } } }).state, "healthy", "too few requests to judge: not degraded");
  assert.match(classifyTelemetry({ ...healthy, http: { requests: 20, byClass: { "5xx": 1 } } }).reason, /5%/);
  assert.match(classifyTelemetry({ ...healthy, rateLimit: { backendFailures: 2 } }).reason, /rate limit backend/);
  assert.match(classifyTelemetry({ ...healthy, dispatch: { health: { status: "down" } } }).reason, /broker is down/);
  assert.equal(classifyTelemetry({ ...healthy, dispatch: { health: { status: "unknown" } } }).state, "healthy", "an unknown broker state is not a degradation claim");
  assert.match(classifyTelemetry({ ...healthy, upstream: { users: { latency: { count: 10 }, outcomes: { unavailable: 6, ok: 4 } } } }).reason, /upstream "users"/);
  assert.equal(classifyTelemetry({ ...healthy, upstream: { users: { latency: { count: 10 }, outcomes: { aborted: 9, ok: 1 } } } }).state, "healthy", "client aborts are not upstream failures");
});

test("Studio telemetry API: every state is real, numbers appear only when measured, the token never leaves the server", { timeout: 300_000 }, async () => {
  const g = await buildGateway("pso-stel-"); gateways.push(g);
  const gwPort = randomPort() + 100;
  const ws = JSON.parse(readFileSync(join(g.root, "pso.workspace.json"), "utf8")) as WorkspaceConfig;
  for (const s of ws.services) s.port = s.name === "gw" ? gwPort : randomPort() + 300;
  writeFileSync(join(g.root, "pso.workspace.json"), JSON.stringify(ws, null, 2));
  const saved = process.env["PSO_DIAGNOSTICS_TOKEN"];
  delete process.env["PSO_DIAGNOSTICS_TOKEN"];
  const studio = await startStudio({ root: g.root });
  let child: ChildProcess | undefined;
  const up = async (env: Record<string, string>): Promise<{ url(p: string): string }> => { const x = await g.start({ PORT: String(gwPort), RATE_LIMIT_PER_MINUTE: "0", ...env }); child = x.child; return { url: (p) => `http://127.0.0.1:${gwPort}${p}` }; };
  const down = (): void => { child?.kill("SIGKILL"); child = undefined; };
  try {
    const login = await new Promise<string>((resolve, reject) => { const req = request({ host: "127.0.0.1", port: studio.port, path: `/?t=${studio.token}`, headers: { host: `127.0.0.1:${studio.port}` } }, (res) => { res.resume(); resolve(String(res.headers["set-cookie"]).split(";")[0]!); }); req.on("error", reject); req.end(); });
    const tel = async () => (await getJson<{ studioHasToken: boolean; services: TelemetryRow[]; note: string }>(studio.port, login, "/api/telemetry")).body;
    const gwRow = async () => (await tel()).services.find((s) => s.service === "gw")!;
    const usersRow = async () => (await tel()).services.find((s) => s.service === "users")!;

    // 1. Studio itself has no token: the answer is "unknown", with the way to fix it, and no numbers
    let r = await gwRow();
    assert.equal(r.state, "unknown"); assert.match(r.reason, /PSO_DIAGNOSTICS_TOKEN/); assert.equal(r.metrics, null);
    assert.equal((await tel()).studioHasToken, false);

    process.env["PSO_DIAGNOSTICS_TOKEN"] = TOKEN;
    // 2. the service is not running: unavailable, and NO zero counters
    r = await gwRow();
    assert.equal(r.state, "unavailable"); assert.equal(r.metrics, null, "a service that is down has no numbers, not zeros");

    // 3. running, but diagnostics are off
    let x = await up({ PSO_DIAGNOSTICS_TOKEN: "" });
    r = await gwRow();
    assert.equal(r.state, "not-configured"); assert.match(r.reason, /PSO_DIAGNOSTICS_TOKEN/); assert.equal(r.metrics, null);
    down();

    // 4. running with a different token: the service says no, Studio reports unknown (not healthy)
    x = await up({ PSO_DIAGNOSTICS_TOKEN: "d".repeat(48) });
    r = await gwRow();
    assert.equal(r.state, "unknown"); assert.match(r.reason, /rejected/);
    down();

    // 5. running with the right token and real traffic: healthy, with the numbers the service measured
    x = await up({ PSO_DIAGNOSTICS_TOKEN: TOKEN });
    for (let i = 0; i < 4; i++) await fetch(x.url("/customers"));            // 401
    await fetch(x.url("/missing"));                                          // 404
    await new Promise((res) => setTimeout(res, 300));
    r = await gwRow();
    assert.equal(r.state, "healthy", r.reason);
    assert.equal(r.metrics!.requests, 5); assert.equal(r.metrics!.unauthorized, 4); assert.equal(r.metrics!.clientErrors, 5); assert.equal(r.metrics!.serverErrors, 0);
    assert.equal(typeof r.metrics!.avgLatencyMs, "number");
    assert.equal(r.metrics!.dispatch, null, "dispatch is not installed: null, not zeros");
    assert.equal(r.metrics!.rateLimit, null, "rate limiting is switched off in this run: null (unavailable), never zero counters");
    assert.ok(r.collectedAt && !Number.isNaN(Date.parse(r.collectedAt)));

    // 6. Spring service: not instrumented, honestly
    const u = await usersRow();
    assert.equal(u.state, "not-instrumented"); assert.equal(u.metrics, null);

    // 7. degraded: the upstream is down for enough calls
    for (let i = 0; i < 24; i++) await fetch(x.url("/customers/ping")); // 503, upstream not running
    await new Promise((res) => setTimeout(res, 400));
    r = await gwRow();
    assert.equal(r.state, "degraded"); assert.match(r.reason, /5xx|upstream "users"/);
    assert.ok(r.metrics!.upstream.some((e) => e.service === "users" && e.failures >= 24));

    // 8. the token never reaches the browser-facing API, and the API is read-only
    const raw = (await getJson<unknown>(studio.port, login, "/api/telemetry")).raw;
    assert.ok(!raw.includes(TOKEN), "the diagnostics token is never returned");
    const post = await new Promise<number>((resolve, reject) => { const req = request({ host: "127.0.0.1", port: studio.port, path: "/api/telemetry", method: "POST", headers: { host: `127.0.0.1:${studio.port}`, cookie: login } }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end(); });
    assert.ok(post >= 400, `non-GET is refused (${post})`);
    const anon = await new Promise<number>((resolve, reject) => { const req = request({ host: "127.0.0.1", port: studio.port, path: "/api/telemetry", headers: { host: `127.0.0.1:${studio.port}` } }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end(); });
    assert.equal(anon, 403, "no cookie: no telemetry");
  } finally {
    down();
    if (saved === undefined) delete process.env["PSO_DIAGNOSTICS_TOKEN"]; else process.env["PSO_DIAGNOSTICS_TOKEN"] = saved;
    await studio.close();
  }
});
