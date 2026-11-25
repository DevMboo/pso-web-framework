import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pso, tmp, prepare, startNode, randomPort, unusedPort } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

const RAW = 'export default (req) => req.headers["x-api-key"] === "k";\n';
const IDENTIFIED = (provider: string) => `import { CustomGuard } from "@pso/security";\nexport default CustomGuard.create({ provider: ${JSON.stringify(provider)}, verify: (req) => req.headers["x-api-key"] === "k" });\n`;
const FRAMEWORK = 'import { JwtGuard } from "@pso/security";\nexport default JwtGuard.create();\n';

test("a custom jwt guard replaces framework authentication only when declared, identified and consistent", { timeout: 300_000 }, async () => {
  const base = tmp("pso-cg-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "create", "service", "users", "--structure", "legacy", "--port", String(await unusedPort()));
  assert.equal((await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read")).code, 0);
  assert.equal((await pso(root, "make:route", "customer", "upload", "--method", "POST", "--path", "/upload", "--upstream", "users", "--service", "gw")).code, 0);
  const gw = join(root, "gw");
  prepare(gw);
  const guardFile = join(gw, "dist/guards/jwt.guard.js");
  const cfgFile = join(gw, "pso.config.json");
  let baseCfg: Record<string, unknown> = {};
  try { baseCfg = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<string, unknown>; } catch { /* a new orchestrator has no pso.config.json yet */ }
  const setGuard = (src: string) => { mkdirSync(join(gw, "dist/guards"), { recursive: true }); writeFileSync(guardFile, src); writeFileSync(join(gw, "src/guards/jwt.guard.ts"), src); /* the static checks read the source */ };
  const setAuth = (auth?: Record<string, unknown>) => writeFileSync(cfgFile, JSON.stringify(auth ? { ...baseCfg, security: { authentication: auth } } : baseCfg, null, 2));
  const attempt = (env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["dist/main.js"], { cwd: gw, encoding: "utf8", timeout: 20_000, env: { ...process.env, PORT: String(randomPort()), PSO_WORKSPACE: join(root, "pso.workspace.json"), ...env } });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const refuses = (r: { status: number | null; out: string }, code: string) => {
    assert.notEqual(r.status, 0, "the application must not start");
    assert.match(r.out, new RegExp(code), r.out.slice(0, 400));
    assert.match(r.out, /no route is active/);
  };

  // 1. a guard file that merely exists (undeclared) must NOT take over authentication
  setAuth(); setGuard(RAW);
  refuses(attempt(), "PSO_SEC_CUSTOM_GUARD_UNDECLARED");
  // the static check reports the same problem before anything runs
  const check = JSON.parse((await pso(root, "security:check", "--json")).out) as { findings: Array<{ id: string; severity: string }> };
  assert.ok(check.findings.some((f) => f.id === "SEC012" && f.severity === "high"), "security:check reports an undeclared custom guard");

  // 2. declared "custom" with the framework guard (nothing to run) is refused: no silent fallback
  setAuth({ provider: "custom", customProvider: "corporate-sso" }); setGuard(FRAMEWORK);
  refuses(attempt(), "PSO_SEC_CUSTOM_GUARD_MISSING");

  // 3. an unknown provider value is a configuration error
  setAuth({ provider: "magic" }); setGuard(RAW);
  refuses(attempt(), "PSO_SEC_PROVIDER");

  // 4. production requires an identifiable provider
  setAuth({ provider: "custom", customProvider: "corporate-sso" }); setGuard(RAW);
  refuses(attempt({ PSO_ENV: "production" }), "PSO_SEC_CUSTOM_GUARD_UNIDENTIFIED");

  // 5. the identity the guard reports must match the declaration
  setAuth({ provider: "custom", customProvider: "corporate-sso" }); setGuard(IDENTIFIED("other-idp"));
  refuses(attempt(), "PSO_SEC_CUSTOM_GUARD_MISMATCH");

  // 6. declared + identified: starts, logs an audit warning with the provider, and enforces the guard
  setAuth({ provider: "custom", customProvider: "corporate-sso" }); setGuard(IDENTIFIED("corporate-sso"));
  const port = randomPort();
  const { child, logs } = await startNode(gw, { PORT: String(port), PSO_WORKSPACE: join(root, "pso.workspace.json"), PSO_ENV: "production", RATE_LIMIT_PER_MINUTE: "0" });
  try {
    assert.match(logs(), /custom authentication is active/);
    assert.match(logs(), /corporate-sso/, "the provider identity is in the audit log");
    const call = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/customers/upload`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    assert.equal((await call({})).status, 401, "no credentials -> 401");
    assert.equal((await call({ "x-api-key": "wrong" })).status, 401, "bad credentials -> 401");
    assert.equal((await call({ "x-api-key": "k" })).status, 503, "valid custom credentials pass authentication (the upstream itself is not running)");
    assert.equal((await fetch(`http://127.0.0.1:${port}/customers`)).status, 401, "other guarded routes use the same custom guard");
  } finally { child.kill("SIGKILL"); }

  // 7. the default (no custom guard, framework jwt without configuration) still fails closed
  setAuth(); setGuard(FRAMEWORK);
  refuses(attempt(), "PSO_SEC_MISSING");
});
