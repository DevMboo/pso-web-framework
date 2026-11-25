import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp, prepare, startNode } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const page = readFileSync(resolve(import.meta.dirname, "..", "docs", "reference", "startup-failures.md"), "utf8").replaceAll("\r\n", "\n");

/** "Why the orchestrator refuses to start": each refusal is produced by starting the compiled orchestrator with one setting changed. */
test("every start-up refusal on the page is what the orchestrator logs", { timeout: 240_000 }, async () => {
  const base = tmp("pso-startup-doc-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab", "--layout", "flat")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--template", "empty")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--template", "empty", "--port", "8081")).code, 0);
  assert.equal((await pso(ws, "security:keys", "--generate")).code, 0);
  for (const a of [["make:module", "orders"], ["make:controller", "orders"]]) assert.equal((await pso(ws, ...a, "--service", "gateway")).code, 0);
  assert.equal((await pso(ws, "make:route", "orders", "list", "--method", "GET", "--path", "/", "--guard", "jwt", "--scopes", "orders:read", "--upstream", "catalog", "--service", "gateway")).code, 0);
  prepare(join(ws, "gateway"));
  const pub = join(ws, "keys", readdirSync(join(ws, "keys")).find((f) => f.endsWith(".public.pem"))!);
  const good = { PSO_JWT_ISSUER: "https://lab.local", PSO_JWT_AUDIENCE: "lab-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256" };
  let port = 3200 + Math.floor(Math.random() * 500) * 2;
  const env = (extra: Record<string, string>) => ({ PORT: String(port++), PSO_WORKSPACE: join(ws, "pso.workspace.json"), PSO_LOG_FORMAT: "json", PSO_LOG_COLOR: "never", ...extra });
  const refused = async (what: string, extra: Record<string, string>, ...fragments: string[]) => {
    let logs = "";
    try { const p = await startNode(join(ws, "gateway"), env(extra)); p.child.kill(); assert.fail(`${what}: the orchestrator started but must refuse`); }
    catch (e) { logs = String((e as Error).message); if (logs.startsWith("AssertionError")) throw e; }
    for (const f of fragments) { assert.ok(logs.includes(f), `${what}: the log has ${f}\n${logs.slice(0, 600)}`); assert.ok(page.includes(f.replaceAll("\\", "\\\\").replace(/"/g, '\\"')) || page.includes(f), `${what}: the page shows ${f}`); }
  };
  const ok = await startNode(join(ws, "gateway"), env(good));
  ok.child.kill();
  assert.ok(ok.logs().includes('"msg":"orchestrator listening"'));

  await refused("symmetric algorithm", { ...good, PSO_JWT_ALGORITHMS: "HS256" }, "PSO_SEC_ALGORITHM", "only asymmetric signature algorithms are accepted");
  await refused("missing key file", { ...good, PSO_JWT_PUBLIC_KEY_FILE: join(ws, "keys", "nope.pem") }, "PSO_SEC_PEM_PATH", "public key file not found or not a regular file");
  await refused("plain http JWKS", { PSO_JWT_ISSUER: "https://lab.local", PSO_JWT_AUDIENCE: "lab-api", PSO_JWT_JWKS_URI: "http://idp.example.com/jwks.json", PSO_JWT_ALGORITHMS: "ES256" }, "PSO_SEC_JWKS_INSECURE", "the JWKS endpoint must use https");
  await refused("production plaintext upstream", { ...good, PSO_ENV: "production", PSO_UPSTREAM_CATALOG: "catalog.internal:8081" }, "production requires TLS to non-loopback upstreams");
  await refused("negative rate limit", { ...good, PSO_CFG_http__rateLimit__perMinute: "-5" }, "PSO_CONFIG_INVALID_VALUE", "must be >= 0");
  await refused("unknown log level", { ...good, PSO_LOG_LEVEL: "loud" }, "PSO_LOG_LEVEL must be one of: trace, debug, info, warn, error, fatal, silent");
  await refused("missing JWT settings", {}, "PSO_SEC_MISSING");

  // a misspelled key only warns, and only in config:validate
  writeFileSync(join(ws, "gateway", "pso.config.json"), JSON.stringify({ http: { rateLimit: { perMinuet: 5 } } }));
  const cfg = await pso(ws, "config:validate");
  assert.equal(cfg.code, 0, "a warning does not fail config:validate");
  assert.ok(cfg.out.includes('PSO_CONFIG_UNKNOWN_KEY') && cfg.out.includes('Unknown configuration key "http.rateLimit.perMinuet"') && page.includes('Unknown configuration key "http.rateLimit.perMinuet"'));
});
