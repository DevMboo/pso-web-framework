import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveEnv, loadHttpLimits, loadRateLimitConfig, SettingsError } from "@pso/http";
import { SCHEMA } from "@pso/core";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";

const dirs: string[] = [];
const gateways: Gw[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); for (const g of gateways) g.dispose(); });
const project = (files: Record<string, unknown>): string => {
  const d = mkdtempSync(join(tmpdir(), "pso-set-")); dirs.push(d); mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), JSON.stringify(body));
  return d;
};

test("precedence: defaults < pso.config.json < pso.config.<env>.json < PSO_CFG_* < the documented variable", () => {
  const dir = project({
    "pso.config.json": { http: { limits: { maxBodyBytes: 1000, maxHeaderBytes: 4096 } } },
    "pso.config.staging.json": { http: { limits: { maxBodyBytes: 2000 } } },
  });
  const read = (env: NodeJS.ProcessEnv) => loadHttpLimits(effectiveEnv(env, dir, "staging"));
  assert.equal(read({}).maxBodyBytes, 2000, "environment file beats the service file");
  assert.equal(read({}).maxHeaderBytes, 4096, "the service file supplies what the environment file does not");
  assert.equal(read({ PSO_CFG_http__limits__maxBodyBytes: "3000" }).maxBodyBytes, 3000, "PSO_CFG_* beats files");
  assert.equal(read({ PSO_CFG_http__limits__maxBodyBytes: "3000", MAX_BODY_BYTES: "4000" }).maxBodyBytes, 4000, "the documented variable beats everything");
  assert.equal(read({}).upstreamTimeoutMs, 5000, "unset keys keep the secure default");
  assert.equal(loadHttpLimits(effectiveEnv({}, project({ "pso.config.json": { server: { maxBodyBytes: 555 } } }))).maxBodyBytes, 555, "the legacy server.* name is still honoured");
  assert.equal(loadHttpLimits(effectiveEnv({}, project({ "pso.config.json": { server: { maxBodyBytes: 555 }, http: { limits: { maxBodyBytes: 777 } } } }))).maxBodyBytes, 777, "the canonical key beats the legacy one");
});

test("rate limit settings come from the same precedence and are validated afterwards", () => {
  const dir = project({ "pso.config.json": { http: { rateLimit: { perMinute: 30, perPrincipal: false, trustedProxies: ["10.0.0.0/8", "::1"] } } } });
  const c = loadRateLimitConfig(effectiveEnv({}, dir), dir);
  assert.deepEqual([c.policy.limit, c.perPrincipal, c.trustedProxies], [30, false, ["10.0.0.0/8", "::1"]]);
  assert.equal(loadRateLimitConfig(effectiveEnv({ RATE_LIMIT_PER_MINUTE: "5" }, dir), dir).policy.limit, 5);
  assert.throws(() => loadRateLimitConfig(effectiveEnv({}, project({ "pso.config.json": { http: { rateLimit: { provider: "memcached" } } } })), dir), /RATE_LIMIT_PROVIDER/);
});

test("secrets: references resolve from the environment, credentials in files are refused, unset references are reported", () => {
  const ref = project({ "pso.config.json": { http: { rateLimit: { provider: "redis", redisUrl: "${env:RL_REDIS}" } } } });
  const eff = effectiveEnv({ RL_REDIS: "redis://cache.internal:6379" }, ref);
  assert.equal(eff["RATE_LIMIT_REDIS_URL"], "redis://cache.internal:6379");
  assert.throws(() => effectiveEnv({}, ref), (e: unknown) => e instanceof SettingsError && /RL_REDIS, which is not set/.test(e.message));
  const plain = project({ "pso.config.json": { http: { rateLimit: { provider: "redis", redisUrl: "redis://user:hunter2@cache:6379" } } } });
  assert.throws(() => effectiveEnv({}, plain), (e: unknown) => e instanceof SettingsError && /contains credentials/.test(e.message) && !e.message.includes("hunter2"), "the value is never echoed");
});

test("an unreadable configuration file is a start-up problem, not silently ignored", () => {
  const d = mkdtempSync(join(tmpdir(), "pso-set-")); dirs.push(d);
  writeFileSync(join(d, "pso.config.json"), "{ not json");
  assert.throws(() => effectiveEnv({}, d), /cannot read/);
});

test("every setting that the HTTP runtime consumes is registered in the canonical schema (and the other way around)", () => {
  const consumed = ["maxBodyBytes", "maxUpstreamResponseBytes", "maxHeaderBytes", "upstreamTimeoutMs", "upstreamResponseTimeoutMs", "headersTimeoutMs", "requestTimeoutMs", "keepAliveTimeoutMs", "maxConnections", "maxConcurrentRequests", "maxUploadBytes", "maxMultipartParts", "maxConcurrentUploads"]; // the upload limits are consumed by limits.ts too
  for (const k of consumed) assert.ok(`http.limits.${k}` in SCHEMA, `http.limits.${k} must be in SCHEMA`);
  for (const k of ["perMinute", "burst", "provider", "redisUrl", "onFailure", "perPrincipal", "maxKeys", "prefix", "trustedProxies", "routes"]) assert.ok(`http.rateLimit.${k}` in SCHEMA, `http.rateLimit.${k} must be in SCHEMA`);
  const registered = Object.keys(SCHEMA).filter((k) => k.startsWith("http.limits.")).map((k) => k.slice("http.limits.".length));
  assert.deepEqual(registered.sort(), [...consumed].sort(), "no registered limit is left unconsumed");
});

test("orchestrator: a limit set in pso.config.json is enforced, and the variable overrides it", { timeout: 300_000 }, async () => {
  const gw = await buildGateway("pso-set2-"); gateways.push(gw);
  gw.config({ http: { limits: { maxBodyBytes: 500 } } });
  const post = (x: { url(p: string): string; auth: Record<string, string> }, size: number) => fetch(x.url("/customers/upload"), { method: "POST", headers: { "content-type": "application/json", ...x.auth }, body: JSON.stringify({ pad: "x".repeat(size) }) });
  const a = await gw.start({ RATE_LIMIT_PER_MINUTE: "0" });
  try { await expectProblem(await post(a, 2000), 413, "PSO_HTTP_PAYLOAD_TOO_LARGE"); } finally { a.child.kill("SIGKILL"); }
  const b = await gw.start({ RATE_LIMIT_PER_MINUTE: "0", MAX_BODY_BYTES: "100000" });
  try { assert.equal((await post(b, 2000)).status, 503, "the variable raised the limit: the request reached the (absent) upstream"); } finally { b.child.kill("SIGKILL"); }
  gw.config({ http: { limits: { maxBodyBytes: "lots" } } });
  await assert.rejects(gw.start({}), /MAX_BODY_BYTES must be a whole number/);
  gw.config({ http: { rateLimit: { redisUrl: "redis://u:pw@h:1", provider: "redis" } } });
  await assert.rejects(gw.start({}), /contains credentials/);
});
