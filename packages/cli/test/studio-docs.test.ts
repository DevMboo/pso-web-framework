import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { type WorkspaceConfig } from "@pso/core";
import { startDev } from "../src/dev.ts";
import { startStudio, scrub } from "../src/studio.ts";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

async function freePort(): Promise<number> {
  const s = netServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port; await new Promise((r) => s.close(r)); return p;
}
/** GET with full control over Host and Cookie. */
function get(port: number, path: string, o: { host?: string; cookie?: string; method?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: o.host ?? `127.0.0.1:${port}`, ...(o.cookie ? { cookie: o.cookie } : {}) } }, (res) => {
      let body = ""; res.on("data", (d: Buffer) => { body += d; }); res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}

const STUB = `import { createServer } from "node:http";
createServer((q, r) => { r.writeHead(q.url === "/health" ? 200 : 404); r.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

test("Studio: authenticated, loopback-only, read-only, and shows live runtime data", { timeout: 120_000 }, async () => {
  const base = tmp("pso-studio-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "service", "users", "--structure", "legacy");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read");
  writeFileSync(join(root, "stub.mjs"), STUB);
  const cfg = JSON.parse(readFileSync(join(root, "pso.workspace.json"), "utf8")) as WorkspaceConfig;
  for (const s of cfg.services) { s.port = await freePort(); s.health = "/health"; s.dev = { command: [process.execPath, join(root, "stub.mjs")] }; }
  cfg.services.find((s) => s.name === "gw")!.dependsOn = ["users"];
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify(cfg, null, 2));
  process.env["PSO_CFG_security__rateLimit__token"] = "topsecretvalue123";

  const studio = await startStudio({ root });
  try {
    const u = new URL(studio.url);
    assert.equal(u.hostname, "127.0.0.1", "bound to loopback");
    const port = studio.port;

    assert.equal((await get(port, "/")).status, 403, "no cookie");
    assert.equal((await get(port, "/api/overview")).status, 403);
    assert.equal((await get(port, "/?t=wrong")).status, 403, "bad token");
    assert.equal((await get(port, "/", { host: "evil.example" })).status, 403, "DNS-rebinding host rejected");
    const login = await get(port, `/?t=${studio.token}`);
    assert.equal(login.status, 302);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.match(String(login.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
    assert.equal((await get(port, "/api/overview", { host: "evil.example", cookie })).status, 403, "valid cookie but wrong host");
    assert.equal((await get(port, "/api/overview", { cookie, method: "POST" })).status, 405, "read-only");

    const page = await get(port, "/", { cookie });
    assert.equal(page.status, 200);
    assert.match(page.body, /PSO Studio/);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
    assert.ok(!/<script>[^<]/.test(page.body) && !/ style=/.test(page.body), "no inline script or style");
    assert.equal((await get(port, "/icons/activity.svg", { cookie })).headers["content-type"], "image/svg+xml");
    assert.equal((await get(port, "/icons/..%2F..%2Fpackage.json", { cookie })).status, 404, "icon path is allow-listed");
    assert.equal((await get(port, "/js/main.js", { cookie })).status, 200);
    assert.equal((await get(port, "/js/views/overview.js", { cookie })).status, 200);
    assert.equal((await get(port, "/css/studio.css", { cookie })).status, 200);
    assert.equal((await get(port, "/js/..%2f..%2fpackage.json", { cookie })).status, 404, "static folders are allow-listed");
    assert.equal((await get(port, "/favicon.svg", { cookie })).headers["content-type"], "image/svg+xml", "official favicon is reused");
    assert.match(String(page.headers["content-security-policy"]), /base-uri 'none'/);

    // nothing running yet: live probes say DOWN
    let ov = JSON.parse((await get(port, "/api/overview", { cookie })).body);
    assert.deepEqual(ov.services.map((s: { live: { status: string } }) => s.live.status), ["DOWN", "DOWN"]);
    assert.deepEqual(ov.services.map((s: { health: { state: string } }) => s.health.state), ["stopped", "stopped"], "nothing listening and no dev session: stopped, not unknown or healthy");

    const session = await startDev({ root, config: cfg, readyTimeoutMs: 20_000, healthIntervalMs: 200 });
    try {
      ov = JSON.parse((await get(port, "/api/overview", { cookie })).body);
      assert.deepEqual(ov.services.map((s: { name: string; live: { status: string }; registry: { state: string } }) => [s.name, s.live.status, s.registry.state]).sort(), [["gw", "UP", "READY"], ["users", "UP", "READY"]]);
      assert.equal(ov.devSession.pid, process.pid);
      assert.deepEqual(ov.services.map((s: { health: { state: string } }) => s.health.state), ["healthy", "healthy"]);
      const sum = JSON.parse((await get(port, "/api/summary", { cookie })).body);
      assert.deepEqual([sum.services.total, sum.services.healthy, sum.routes.declared, sum.modules.total], [2, 2, 1, 1]);
      const det = JSON.parse((await get(port, "/api/services/users", { cookie })).body);
      assert.equal(det.health.state, "healthy"); assert.equal(det.routes[0].path, "/customers"); assert.deepEqual(det.dependents, ["gw"]);
      assert.deepEqual([det.spring.service.prefix, det.spring.database.provider, det.spring.dispatch.enabled, det.spring.lombok], ["/users", "none", false, true]);
      assert.ok(det.spring.starters.includes("pso-security-spring-boot-starter"));
      assert.ok(!JSON.stringify(det.spring).includes("topsecretvalue123"), "no secret values in the Spring configuration view");
      assert.equal(JSON.parse((await get(port, "/api/overview", { cookie })).body).services.find((s: { name: string }) => s.name === "users").prefix, "/users");
      assert.equal((await get(port, "/api/services/nope", { cookie })).status, 404);
      const mods = JSON.parse((await get(port, "/api/modules", { cookie })).body);
      assert.equal(mods.modules[0].dir, "customer"); assert.equal(mods.modules[0].routeCount, 1);

      const g = JSON.parse((await get(port, "/api/graph", { cookie })).body);
      assert.deepEqual(g.startupOrder, ["users", "gw"]);
      assert.deepEqual(g.dependencies, [{ from: "gw", to: "users" }]);
      assert.ok(g.routes.some((r: { label: string }) => r.label === "GET /customers"));

      const routes = JSON.parse((await get(port, "/api/routes", { cookie })).body);
      assert.deepEqual(routes.find((r: { path: string }) => r.path === "/customers").scopes, ["customers:read"]);

      // logs come from real files and are scrubbed
      writeFileSync(join(root, ".pso", "logs", "gw.log"), 'got Authorization: Bearer abc.def.ghi\ntoken eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl end\npassword=hunter2\n');
      const logs = (await get(port, "/api/logs?service=gw", { cookie })).body;
      for (const leak of ["abc.def.ghi", "eyJhbGciOiJFUzI1NiJ9", "hunter2"]) assert.ok(!logs.includes(leak), `${leak} scrubbed`);
      assert.match(logs, /Bearer \*\*\*/);
    } finally { await session.stop(); }

    await new Promise((r) => setTimeout(r, 300));
    ov = JSON.parse((await get(port, "/api/overview", { cookie })).body);
    assert.deepEqual(ov.services.map((s: { live: { status: string } }) => s.live.status), ["DOWN", "DOWN"], "stopping is reflected live");

    const conf = (await get(port, "/api/config", { cookie })).body;
    assert.ok(!conf.includes("topsecretvalue123"), "secret never leaves the process");
    assert.ok(conf.includes("***REDACTED***"));
    const sec = JSON.parse((await get(port, "/api/security", { cookie })).body);
    assert.ok(Array.isArray(sec.findings));
    const dsp = JSON.parse((await get(port, "/api/dispatch", { cookie })).body);
    assert.deepEqual([dsp.anyInstalled, dsp.anyEnabled, dsp.channels.length], [false, false, 0]);
    assert.equal(dsp.telemetry.available, false, "runtime telemetry is never invented");
    assert.equal((await get(port, "/api/nope", { cookie })).status, 404);
  } finally { delete process.env["PSO_CFG_security__rateLimit__token"]; await studio.close(); }
});

test("scrub removes bearer tokens, JWTs, private keys and secret assignments", () => {
  assert.equal(scrub("Authorization: Bearer abc123.def"), "Authorization: Bearer ***");
  assert.ok(!scrub("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----").includes("AAAA"));
  assert.ok(!scrub('{"apiKey":"zzz999"}').includes("zzz999"));
});

test("pso init builds a valid workspace from existing projects", async () => {
  const base = tmp("pso-init-"); dirs.push(base);
  mkdirSync(join(base, "Users Service"), { recursive: true }); writeFileSync(join(base, "Users Service", "pom.xml"), "<project/>");
  mkdirSync(join(base, "edge/src"), { recursive: true }); writeFileSync(join(base, "edge", "package.json"), "{}"); writeFileSync(join(base, "edge/src/main.ts"), "");
  mkdirSync(join(base, "notes"));
  const dry = await pso(base, "init", "--dry-run", "--json");
  assert.equal(dry.code, 0, dry.err);
  assert.ok(!existsSync(join(base, "pso.workspace.json")));
  assert.equal((await pso(base, "init")).code, 0);
  const w = JSON.parse(readFileSync(join(base, "pso.workspace.json"), "utf8")) as WorkspaceConfig;
  assert.deepEqual(w.services.map((s) => [s.name, s.runtime, s.role, s.port]).sort(), [["edge", "node", "orchestrator", 3000], ["users-service", "spring-boot", "service", 8081]]);
  assert.equal((await pso(base, "validate")).code, 1, "no src dir for the Spring project yet: validation tells the truth");
  assert.equal((await pso(base, "init")).code, 1, "refuses to overwrite");
});

test("graph and routes:inspect describe the real workspace", async () => {
  const base = tmp("pso-graph-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "service", "users", "--structure", "legacy"); await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read");
  const g = JSON.parse((await pso(root, "graph", "--json")).out);
  assert.deepEqual(g.routes.map((r: { label: string }) => r.label), ["GET /customers"]);
  assert.match((await pso(root, "graph", "--mermaid")).out, /gw -\.->\|GET \/customers\| users/);
  const r = JSON.parse((await pso(root, "routes:inspect", "customer", "--json")).out);
  assert.deepEqual([r.guard, r.scopes, r.servicePort, r.contract.name], ["jwt", ["customers:read"], 8081, "customer"]);
  assert.ok(r.handlers[0].endsWith("CustomerController.java"));
  assert.equal((await pso(root, "routes:inspect", "nope")).code, 1);
});
