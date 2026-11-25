import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer as tcp } from "node:net";
import type { IncomingMessage } from "node:http";
import { LocalRateLimiter, RedisRateLimiter, loadRateLimitConfig, clientAddress, RateLimitConfigError } from "@pso/http";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";
// @ts-expect-error plain ESM script shared with the other dispatch tests
import { up, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";

let redisUrl: string | undefined;
let blocked: string | false = false;
before(async () => {
  if (process.env["PSO_TEST_REDIS_URL"]) { redisUrl = process.env["PSO_TEST_REDIS_URL"]; return; }
  if (!dockerAvailable()) { blocked = "BLOCKED: no Docker engine, real Redis not available"; return; }
  try { redisUrl = ((await up()) as Record<string, string>)["PSO_TEST_REDIS_URL"]; } catch (e) { blocked = `BLOCKED: Redis unavailable: ${(e as Error).message}`; }
});
const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); });

const POLICY = { limit: 10, windowSeconds: 3600, burst: 10 };

// ------------------------------------------------------------------ local provider
test("local limiter: burst, refill, Retry-After and bounded key cardinality", async () => {
  const l = new LocalRateLimiter(100);
  const t0 = 1_000_000;
  const p = { limit: 60, windowSeconds: 60, burst: 3 }; // 1 token per second, bucket of 3
  const r = [await l.check("a", p, t0), await l.check("a", p, t0), await l.check("a", p, t0), await l.check("a", p, t0)];
  assert.deepEqual(r.map((x) => x.allowed), [true, true, true, false]);
  assert.equal(r[3]!.retryAfterSeconds, 1);
  assert.equal((await l.check("a", p, t0 + 1100)).allowed, true, "one token refilled after ~1 s");
  assert.equal((await l.check("a", p, t0 + 1150)).allowed, false);
  assert.equal((await l.check("b", p, t0)).allowed, true, "keys are independent");
  for (let i = 0; i < 500; i++) await l.check(`k${i}`, p, t0);
  assert.ok(l.stats().keys <= 100, `bounded keys (${l.stats().keys})`);
});

// ------------------------------------------------------------------ configuration
test("rate limit configuration: secure defaults, every problem reported, Redis stays off unless asked", () => {
  const d = loadRateLimitConfig({});
  assert.deepEqual([d.enabled, d.provider, d.onFailure, d.policy.limit, d.policy.burst, d.perPrincipal, d.trustedProxies], [true, "local", "closed", 600, 600, true, []]);
  assert.throws(() => loadRateLimitConfig({ RATE_LIMIT_PROVIDER: "redis" }), /RATE_LIMIT_REDIS_URL is required/);
  assert.throws(() => loadRateLimitConfig({ RATE_LIMIT_PROVIDER: "memcached", RATE_LIMIT_FAILURE: "maybe", RATE_LIMIT_PER_MINUTE: "x", RATE_LIMIT_TRUSTED_PROXIES: "not-an-ip" }), (e: unknown) => e instanceof RateLimitConfigError && e.problems.length === 4);
  assert.throws(() => loadRateLimitConfig({ NODE_ENV: "production", RATE_LIMIT_PROVIDER: "redis", RATE_LIMIT_REDIS_URL: "redis://:pw@cache.example.com:6379" }), /rediss:\/\//);
  assert.doesNotThrow(() => loadRateLimitConfig({ NODE_ENV: "production", RATE_LIMIT_PROVIDER: "redis", RATE_LIMIT_REDIS_URL: "rediss://cache.example.com:6379" }));
  try { loadRateLimitConfig({ RATE_LIMIT_PROVIDER: "redis", RATE_LIMIT_REDIS_URL: "http://secret-user:secret-pass@x" }); assert.fail("must reject"); }
  catch (e) { assert.ok(!(e as Error).message.includes("secret-pass"), "credentials are never echoed"); }
});

// ------------------------------------------------------------------ client identity
const fakeReq = (peer: string, xff?: string | string[]): IncomingMessage => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } }) as unknown as IncomingMessage;
test("client address: X-Forwarded-For is trusted only from configured proxies and cannot be spoofed by prepending", async () => {
  const { trustedList } = await import("../../http/src/ratelimit.ts");
  const trusted = trustedList(["10.0.0.0/8", "::1"]);
  assert.equal(clientAddress(fakeReq("203.0.113.9", "1.2.3.4"), undefined), "203.0.113.9", "no proxies configured: the header is ignored");
  assert.equal(clientAddress(fakeReq("203.0.113.9", "1.2.3.4"), trusted), "203.0.113.9", "the peer is not a trusted proxy: the header is ignored");
  assert.equal(clientAddress(fakeReq("10.1.1.1", "198.51.100.7"), trusted), "198.51.100.7", "trusted proxy: the forwarded client is used");
  assert.equal(clientAddress(fakeReq("10.1.1.1", "6.6.6.6, 198.51.100.7"), trusted), "198.51.100.7", "a client-prepended value is ignored (rightmost untrusted wins)");
  assert.equal(clientAddress(fakeReq("10.1.1.1", "198.51.100.7, 10.2.2.2"), trusted), "198.51.100.7", "trusted hops are skipped");
  assert.equal(clientAddress(fakeReq("10.1.1.1", "garbage"), trusted), "10.1.1.1", "garbage never selects an identity");
  assert.equal(clientAddress(fakeReq("::ffff:10.1.1.1", "198.51.100.7"), trusted), "198.51.100.7", "IPv4-mapped peers are normalised");
});

// ------------------------------------------------------------------ redis provider (real Redis)
test("redis limiter: instances share one budget under heavy concurrency (atomic, no race)", { skip: blocked }, async () => {
  const prefix = `t:${Date.now()}:`;
  const a = new RedisRateLimiter(redisUrl!, prefix, "closed"), b = new RedisRateLimiter(redisUrl!, prefix, "closed");
  await a.init(); await b.init();
  try {
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => (i % 2 ? a : b).check("shared-key", POLICY)));
    const allowed = results.filter((r) => r.allowed).length;
    assert.equal(allowed, 10, `exactly the burst is allowed across both instances (got ${allowed})`);
    assert.ok(results.filter((r) => !r.allowed).every((r) => r.retryAfterSeconds >= 1));
    assert.equal(a.stats().allowed + b.stats().allowed, 10);
    assert.equal((await a.check("another-key", POLICY)).allowed, true, "other keys are unaffected");
    // keys expire: no unbounded growth
    const { default: Redis } = await import("ioredis");
    const r = new Redis(redisUrl!);
    try { const ttl = await r.pttl(`${prefix}shared-key`); assert.ok(ttl > 0 && ttl <= 7_200_000 + 5000, `key has a TTL (${ttl} ms)`); } finally { r.disconnect(); }
  } finally { await a.close(); await b.close(); }
});

test("redis limiter: the backend failure policy is explicit (closed denies with 503 semantics, open allows) and nothing is thrown", { skip: blocked }, async () => {
  for (const [policy, expectAllowed] of [["closed", false], ["open", true]] as const) {
    const l = new RedisRateLimiter(redisUrl!, `t:${policy}:`, policy);
    await l.init();
    await l.close(); // the backend is gone from this limiter's point of view
    const d = await l.check("k", POLICY);
    assert.equal(d.allowed, expectAllowed, policy);
    assert.equal(d.backendFailed, true);
    assert.equal(l.stats().backendFailures, 1);
  }
});

test("redis limiter: an unreachable Redis stops initialization with a message that carries no credentials", async () => {
  const dead = tcp().listen(0, "127.0.0.1"); // a port that accepts nothing useful
  await new Promise((r) => dead.once("listening", r));
  const port = (dead.address() as { port: number }).port;
  dead.close();
  const l = new RedisRateLimiter(`redis://:topsecret@127.0.0.1:${port}`, "t:", "closed");
  await assert.rejects(l.init(), (e: Error) => /cannot connect to Redis/.test(e.message) && !e.message.includes("topsecret"));
});

// ------------------------------------------------------------------ orchestrator integration
test("two orchestrator instances sharing Redis enforce ONE limit; without Redis each instance has its own", { skip: blocked, timeout: 300_000 }, async () => {
  const gw = await buildGateway("pso-rl-"); gateways.push(gw);
  const base = { RATE_LIMIT_PER_MINUTE: "10" };
  const shared = { ...base, RATE_LIMIT_PROVIDER: "redis", RATE_LIMIT_REDIS_URL: redisUrl!, RATE_LIMIT_PREFIX: `it:${Date.now()}:` };
  const a = await gw.start(shared), b = await gw.start(shared);
  try {
    const burst = async (n: number) => (await Promise.all(Array.from({ length: n }, (_, i) => fetch((i % 2 ? a : b).url("/customers")).then((r) => r.status)))).reduce<Record<number, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
    const r = await burst(60);
    const passed = r[401] ?? 0; // guarded route, no token: reaching the guard means the limiter let it through
    assert.ok(passed >= 10 && passed <= 12, `shared budget: ${passed} reached the guard (expected ~10, not ~20): ${JSON.stringify(r)}`);
    assert.ok((r[429] ?? 0) >= 48, `the rest are limited: ${JSON.stringify(r)}`);
    const limited = await fetch(a.url("/customers"));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    await expectProblem(limited, 429, "PSO_RATE_LIMITED");
    assert.equal((await fetch(a.url("/health/live"))).status, 200, "health stays exempt");
  } finally { a.child.kill("SIGKILL"); b.child.kill("SIGKILL"); }

  const c = await gw.start(base), d = await gw.start(base);
  try {
    const counts = await Promise.all([c, d].map(async (x) => (await Promise.all(Array.from({ length: 30 }, () => fetch(x.url("/customers")).then((r) => r.status)))).filter((s) => s === 401).length));
    assert.ok(counts[0]! >= 10 && counts[1]! >= 10, `local providers do not share state: ${counts}`);
  } finally { c.child.kill("SIGKILL"); d.child.kill("SIGKILL"); }
});

test("per-route policies, per-principal budgets and trusted-proxy identity", { timeout: 300_000 }, async () => {
  const gw = await buildGateway("pso-rl2-"); gateways.push(gw);
  gw.config({ http: { rateLimit: { routes: [{ route: "GET /customers/ping", limit: 3, windowSeconds: 3600, burst: 3 }] } } });
  const x = await gw.start({ RATE_LIMIT_PER_MINUTE: "1000" });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await fetch(x.url("/customers/ping"))).status);
    assert.deepEqual(codes.map((c) => c === 429), [false, false, false, true, true, true], `the route policy applies on top of the global one: ${codes}`);
    assert.equal((await fetch(x.url("/customers"))).status, 401, "other routes only see the global policy");
  } finally { x.child.kill("SIGKILL"); }

  gw.config({});
  // identity: behind a trusted proxy each forwarded client has its own budget; a spoofing client behind NO trusted proxy does not
  const t = await gw.start({ RATE_LIMIT_PER_MINUTE: "3", RATE_LIMIT_TRUSTED_PROXIES: "127.0.0.1" });
  try {
    const as = async (client: string) => (await fetch(t.url("/customers"), { headers: { "x-forwarded-for": client } })).status;
    for (let i = 0; i < 3; i++) assert.equal(await as("198.51.100.1"), 401);
    assert.equal(await as("198.51.100.1"), 429, "client 1 exhausted its own budget");
    assert.equal(await as("198.51.100.2"), 401, "client 2 has its own budget (identity from the trusted proxy)");
  } finally { t.child.kill("SIGKILL"); }
  const u = await gw.start({ RATE_LIMIT_PER_MINUTE: "3" });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(u.url("/customers"), { headers: { "x-forwarded-for": `203.0.113.${i}` } })).status);
    assert.ok(statuses.filter((s) => s === 429).length >= 3, `spoofing X-Forwarded-For does not evade the limit: ${statuses}`);
  } finally { u.child.kill("SIGKILL"); }
  // per principal: an authenticated caller has a budget of its own, independent of the anonymous bucket of the same address
  const p = await gw.start({ RATE_LIMIT_PER_MINUTE: "100", RATE_LIMIT_PER_PRINCIPAL: "true" });
  gw.config({});
  try { assert.equal((await fetch(p.url("/customers/upload"), { method: "POST", headers: { "content-type": "application/json", ...p.auth }, body: "{}" })).status, 503, "authenticated request passes the limiter (upstream is down)"); }
  finally { p.child.kill("SIGKILL"); }
});

test("an invalid rate limit configuration stops start-up before anything listens", { timeout: 200_000 }, async () => {
  const gw = await buildGateway("pso-rl3-"); gateways.push(gw);
  await assert.rejects(gw.start({ RATE_LIMIT_PROVIDER: "redis" }), /RATE_LIMIT_REDIS_URL is required/);
  await assert.rejects(gw.start({ RATE_LIMIT_PER_MINUTE: "lots" }), /RATE_LIMIT_PER_MINUTE must be a whole number/);
});

// ------------------------------------------------------------------ cross-runtime conformance
test("conformance: the shared contract (fixtures/contracts/ratelimit/contract.json) holds for the TypeScript implementation", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { trustedList } = await import("../../http/src/ratelimit.ts");
  const c = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/contracts/ratelimit/contract.json"), "utf8")) as {
    bucket: Array<{ name: string; policy: { limit: number; windowSeconds: number; burst: number }; steps: Array<{ t: number; key: string; allowed: boolean; remaining?: number; retryAfter?: number }> }>;
    clientAddress: { trustedProxies: string[]; cases: Array<{ name: string; trusted?: boolean; peer: string; xff: string[]; expect: string }> };
  };
  for (const b of c.bucket) {
    const l = new LocalRateLimiter(100);
    let i = 0;
    for (const s of b.steps) {
      const d = await l.check(s.key, b.policy, s.t);
      const where = `${b.name} step ${i++}`;
      assert.equal(d.allowed, s.allowed, where);
      if (s.remaining !== undefined) assert.equal(d.remaining, s.remaining, `${where} remaining`);
      if (s.retryAfter !== undefined) assert.equal(d.retryAfterSeconds, s.retryAfter, `${where} retryAfter`);
    }
  }
  const trusted = trustedList(c.clientAddress.trustedProxies);
  for (const k of c.clientAddress.cases) {
    const req = { socket: { remoteAddress: k.peer }, headers: { "x-forwarded-for": k.xff.length === 1 ? k.xff[0] : k.xff } } as unknown as IncomingMessage;
    assert.equal(clientAddress(req, k.trusted === false ? undefined : trusted), k.expect, k.name);
  }
});
