import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { importPKCS8, SignJWT } from "jose";
import { startDev, readRegistry } from "../src/dev.ts";
import { loadWorkspace } from "@pso/core";
import { pso, tmp, linkModules } from "./helpers.ts";

const javaOk = spawnSync("java", ["-version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const skip = javaOk ? false : "JDK not found: Spring Boot integration tests cannot run on this machine";

const dirs: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } }
});

async function freePort(): Promise<number> {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
}

/** Runs the project-local Maven wrapper (no global Maven needed). */
function mvnw(cwd: string, ...args: string[]) {
  const [cmd, base] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd"]] : ["./mvnw", []];
  return spawnSync(cmd!, [...(base as string[]), "-B", "-ntp", ...args], { cwd, encoding: "utf8", timeout: 600_000 });
}

let shared: { root: string } | undefined;
async function fixture(): Promise<{ root: string }> {
  if (shared) return shared;
  const base = tmp("pso-e2e-"); dirs.push(base);
  const root = join(base, "w");
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  await pso(root, "create", "service", "users", "--structure", "legacy");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  assert.equal((await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read")).code, 0);
  assert.equal((await pso(root, "make:resource", "customer-order", "--service", "users", "--method", "POST", "--route", "/customer-orders", "--scopes", "orders:write")).code, 0);
  assert.equal((await pso(root, "security:keys", "--generate", "--alg", "ES256")).code, 0);
  const cfg = JSON.parse(readFileSync(join(root, "pso.workspace.json"), "utf8"));
  for (const s of cfg.services) s.port = await freePort();
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify(cfg, null, 2));
  linkModules(join(root, "gw"));
  shared = { root };
  return shared;
}

test("generated Spring service (incl. make:resource output) compiles and passes its own tests via the Maven wrapper", { skip, timeout: 900_000 }, async () => {
  const { root } = await fixture();
  const r = mvnw(join(root, "users"), "test");
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 20).join("\n"));
  assert.match(out, /BUILD SUCCESS/);
  const ran = [...out.matchAll(/Tests run: (\d+), Failures: 0, Errors: 0/g)].map((m) => Number(m[1])).pop()!;
  assert.ok(ran >= 9, `expected >= 9 Spring tests, ran ${ran}`);
});

test("end to end: pso dev runs Spring + orchestrator; JWT auth, scopes, header hygiene and service-side validation", { skip, timeout: 900_000 }, async () => {
  const { root } = await fixture();
  const keyIdx = JSON.parse(readFileSync(join(root, "keys/index.json"), "utf8")) as Array<{ kid: string }>;
  const kid = keyIdx[0]!.kid;
  const priv = await importPKCS8(readFileSync(join(root, `keys/${kid}.private.pem`), "utf8"), "ES256");

  // the IdP's JWKS endpoint, serving the public keys PSO generated
  const idp = createServer((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(readFileSync(join(root, "keys/jwks.json"))); });
  servers.push(idp);
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const jwksUri = `http://127.0.0.1:${(idp.address() as { port: number }).port}/jwks`;
  Object.assign(process.env, { PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_JWKS_URI: jwksUri, PSO_JWT_ALGORITHMS: "ES256" });

  const token = (o: { scope?: string; exp?: string; iss?: string; aud?: string } = {}) =>
    new SignJWT({ scope: o.scope ?? "customers:read orders:write" }).setProtectedHeader({ alg: "ES256", kid }).setIssuer(o.iss ?? "https://idp.test").setAudience(o.aud ?? "pso-api").setSubject("user-1").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(priv);

  const { config } = loadWorkspace(root);
  const gwPort = config!.services.find((s) => s.name === "gw")!.port;
  const usersPort = config!.services.find((s) => s.name === "users")!.port;
  const logs: string[] = [];
  const session = await startDev({ root, config: config!, readyTimeoutMs: 300_000, healthIntervalMs: 500, log: (l) => logs.push(l) });
  try {
    const gw = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${gwPort}${path}`, init);
    const auth = async (o?: Parameters<typeof token>[0]) => ({ authorization: `Bearer ${await token(o)}` });

    // registry reflects reality
    assert.deepEqual(readRegistry(root)!.services.map((s) => [s.name, s.state, s.status]).sort(), [["gw", "READY", "UP"], ["users", "READY", "UP"]]);

    // happy path: orchestrator -> Spring, persisted JSON from the real controller
    const ok = await gw("/customers", { headers: await auth() });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), []);
    assert.ok(ok.headers.get("x-correlation-id"));

    const created = await gw("/customer-orders", { method: "POST", headers: { ...(await auth()), "content-type": "application/json" }, body: JSON.stringify({ id: "1", name: "x" }) });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { id: "1", name: "x" });
    const invalid = await gw("/customer-orders", { method: "POST", headers: { ...(await auth()), "content-type": "application/json" }, body: JSON.stringify({ id: "", name: "" }) });
    assert.equal(invalid.status, 400, "bean validation runs in the service");

    // attacks at the orchestrator
    assert.equal((await gw("/customers")).status, 401, "no token");
    assert.equal((await gw("/customers", { headers: await auth({ exp: "-1h" }) })).status, 401, "expired");
    assert.equal((await gw("/customers", { headers: await auth({ iss: "https://evil" }) })).status, 401, "wrong issuer");
    assert.equal((await gw("/customers", { headers: await auth({ aud: "other" }) })).status, 401, "wrong audience");
    assert.equal((await gw("/customers", { headers: await auth({ scope: "orders:write" }) })).status, 403, "missing scope at the orchestrator");

    // the service defends itself: bypassing the orchestrator gets no free pass
    const direct = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${usersPort}/users/customers`, { headers });
    assert.equal((await direct()).status, 401, "service rejects anonymous");
    assert.equal((await direct({ authorization: "Bearer aaa.bbb.ccc" })).status, 401, "service rejects garbage token");
    assert.equal((await direct({ "x-pso-user": "admin" })).status, 401, "service ignores spoofed identity headers");
    assert.equal((await direct(await auth({ aud: "other" }))).status, 401, "service validates audience itself");
    assert.equal((await direct(await auth({ scope: "orders:write" }))).status, 403, "service enforces scopes itself");
    assert.equal((await direct(await auth())).status, 200, "valid token accepted directly");

    // correlation id is propagated into structured gateway logs
    const cid = ok.headers.get("x-correlation-id")!;
    for (let i = 0; i < 30 && !logs.some((l) => l.includes(cid)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(logs.some((l) => l.includes(cid) && l.includes('"path":"/customers"')), "request logged with its correlation id");
  } finally {
    await session.stop();
    for (const k of ["PSO_JWT_ISSUER", "PSO_JWT_AUDIENCE", "PSO_JWT_JWKS_URI", "PSO_JWT_ALGORITHMS"]) delete process.env[k];
  }
  for (const p of [gwPort, usersPort]) assert.rejects(fetch(`http://127.0.0.1:${p}/actuator/health`, { signal: AbortSignal.timeout(1500) }), "stopped");
});

test("make:migration numbers migrations and refuses services without a database", async () => {
  const base = tmp("pso-mig-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "service", "plain", "--structure", "legacy");
  await pso(root, "create", "service", "orders", "--structure", "legacy", "--db", "postgres");
  assert.equal((await pso(root, "make:migration", "x", "--service", "plain")).code, 1, "no database");
  assert.equal((await pso(root, "make:migration", "add-orders", "--service", "orders")).code, 0);
  assert.equal((await pso(root, "make:migration", "add-index", "--service", "orders")).code, 0);
  assert.equal((await pso(root, "make:migration", "add-index", "--service", "orders")).code, 1, "duplicate name");
  assert.equal((await pso(root, "make:migration", "../x", "--service", "orders")).code, 1);
  const files = (await import("node:fs")).readdirSync(join(root, "orders/src/main/resources/db/migration")).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(files, ["V1__add_orders.sql", "V2__add_index.sql"]);
  assert.equal((await pso(root, "create", "service", "x", "--structure", "legacy", "--db", "mysql")).code, 1);
  assert.equal(JSON.parse(readFileSync(join(root, "pso.workspace.json"), "utf8")).services.find((s: { name: string }) => s.name === "orders").db, "postgres");
  assert.equal((await pso(root, "security:check")).code, 0, "template has no hard-coded credentials");
  assert.equal((await pso(root, "validate")).code, 0);
});

test("PostgreSQL service: Flyway migrations run against a real (embedded) PostgreSQL in the generated tests", { skip, timeout: 900_000 }, async () => {
  const base = tmp("pso-pg-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "service", "orders", "--structure", "legacy", "--db", "postgres");
  await pso(root, "make:migration", "add-orders", "--service", "orders");
  writeFileSync(join(root, "orders/src/main/resources/db/migration/V1__add_orders.sql"), "CREATE TABLE orders (id UUID PRIMARY KEY, total NUMERIC(12,2) NOT NULL CHECK (total >= 0));\n");
  const r = mvnw(join(root, "orders"), "test");
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 20).join("\n"));
  assert.match(out, /BUILD SUCCESS/);
  assert.match(out, /Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: [\d.]+ s -- in com\.pso\.orders\.DatabaseMigrationTests/);
});
