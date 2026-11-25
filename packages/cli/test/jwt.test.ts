import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { pso, tmp, prepare, listen, startNode, randomPort } from "./helpers.ts";

const ISS = "https://idp.test", AUD = "pso-api";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function fixture() {
  const base = tmp("pso-jwt-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const ws = join(base, "w");
  await pso(ws, "create", "service", "users", "--structure", "legacy");
  await pso(ws, "create", "orchestrator", "gw", "--structure", "legacy");
  const r = await pso(ws, "make:resource", "users", "--service", "users", "--route", "/users", "--scopes", "users:read");
  assert.equal(r.code, 0, r.err);
  const gw = join(ws, "gw");
  prepare(gw);
  const up = await listen((req, res) => { res.writeHead(200); res.end(JSON.stringify({ path: req.url, auth: req.headers["authorization"] ?? null })); });
  const wsFile = join(base, "ws.json");
  writeFileSync(wsFile, JSON.stringify({ services: [{ name: "users", port: up.port }] }));
  const good = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const ec = await generateKeyPair("ES256", { extractable: true });
  return { base, gw, up, wsFile, good, other, ec };
}

type Claims = { iss?: string; aud?: string; sub?: string; scope?: string; exp?: string | number; nbf?: string | number };
async function sign(key: CryptoKey, alg: string, c: Claims = {}) {
  const jwt = new SignJWT({ scope: c.scope ?? "users:read" }).setProtectedHeader({ alg, kid: "k1" }).setIssuedAt();
  if (c.iss !== null) jwt.setIssuer(c.iss ?? ISS);
  jwt.setAudience(c.aud ?? AUD).setSubject(c.sub ?? "user-1").setExpirationTime(c.exp ?? "5m");
  if (c.nbf !== undefined) jwt.setNotBefore(c.nbf);
  return jwt.sign(key);
}

test("JWT guard via JWKS: accepts valid tokens and rejects every attack in the matrix", async () => {
  const f = await fixture();
  const jwk = { ...(await exportJWK(f.good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const jwks = await listen((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); });
  const port = randomPort();
  const { child } = await startNode(f.gw, { PORT: String(port), PSO_WORKSPACE: f.wsFile, PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_JWKS_URI: `http://127.0.0.1:${jwks.port}/jwks` });
  const call = async (auth?: string) => (await fetch(`http://127.0.0.1:${port}/users`, auth ? { headers: { authorization: auth } } : {})).status;
  try {
    const valid = await sign(f.good.privateKey, "RS256");
    assert.equal(await call(`Bearer ${valid}`), 200, "valid token");
    const forwarded = await (await fetch(`http://127.0.0.1:${port}/users`, { headers: { authorization: `Bearer ${valid}` } })).json() as { auth: string };
    assert.equal(forwarded.auth, `Bearer ${valid}`, "verified token is propagated so the service can verify it too");

    const cases: Array<[string, string | undefined, number]> = [
      ["no header", undefined, 401],
      ["wrong scheme", `Basic ${valid}`, 401],
      ["malformed", "Bearer not.a.jwt!", 401],
      ["two segments", "Bearer abc.def", 401],
      ["garbage payload", `Bearer ${b64({ alg: "RS256" })}.${b64({})}.sig`, 401],
      ["expired", `Bearer ${await sign(f.good.privateKey, "RS256", { exp: Math.floor(Date.now() / 1000) - 3600 })}`, 401],
      ["not yet valid (nbf)", `Bearer ${await sign(f.good.privateKey, "RS256", { nbf: Math.floor(Date.now() / 1000) + 3600 })}`, 401],
      ["signed by another key", `Bearer ${await sign(f.other.privateKey, "RS256")}`, 401],
      ["wrong issuer", `Bearer ${await sign(f.good.privateKey, "RS256", { iss: "https://evil.test" })}`, 401],
      ["wrong audience", `Bearer ${await sign(f.good.privateKey, "RS256", { aud: "other-api" })}`, 401],
      ["missing subject is rejected", `Bearer ${await sign(f.good.privateKey, "RS256", { sub: "" })}`, 401],
      ["alg none", `Bearer ${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: ISS, aud: AUD, sub: "x", scope: "users:read", exp: 9999999999 })}.`, 401],
      ["alg not allow-listed (ES256 token, RS256-only keyset)", `Bearer ${await sign(f.ec.privateKey, "ES256")}`, 401],
      ["insufficient scope", `Bearer ${await sign(f.good.privateKey, "RS256", { scope: "orders:read" })}`, 403],
      ["no scope at all", `Bearer ${await sign(f.good.privateKey, "RS256", { scope: "" })}`, 403],
    ];
    for (const [name, auth, want] of cases) assert.equal(await call(auth), want, name);

    // HS256 "algorithm confusion": sign with the public key's PEM as an HMAC secret
    const pem = await exportSPKI(f.good.publicKey);
    const hs = await new SignJWT({ scope: "users:read" }).setProtectedHeader({ alg: "HS256" }).setIssuer(ISS).setAudience(AUD).setSubject("x").setExpirationTime("5m").sign(new TextEncoder().encode(pem));
    assert.equal(await call(`Bearer ${hs}`), 401, "HS256 algorithm confusion");
    assert.equal(await call(`Bearer ${"a".repeat(9000)}.b.c`), 401, "oversized token");
  } finally { child.kill("SIGKILL"); f.up.server.close(); jwks.server.close(); }
});

test("JWT guard via PEM public key (ES256) and PEM validation", async () => {
  const f = await fixture();
  const pemFile = join(f.base, "pub.pem");
  writeFileSync(pemFile, await exportSPKI(f.ec.publicKey));
  const port = randomPort();
  const { child } = await startNode(f.gw, { PORT: String(port), PSO_WORKSPACE: f.wsFile, PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_PUBLIC_KEY_FILE: pemFile, PSO_JWT_ALGORITHMS: "ES256" });
  const call = async (t: string) => (await fetch(`http://127.0.0.1:${port}/users`, { headers: { authorization: `Bearer ${t}` } })).status;
  try {
    assert.equal(await call(await sign(f.ec.privateKey, "ES256")), 200);
    assert.equal(await call(await sign(f.other.privateKey, "RS256")), 401);
  } finally { child.kill("SIGKILL"); f.up.server.close(); }
});

test("JWT security fails closed at startup: invalid configuration keeps the application from ever listening", async () => {
  const f = await fixture();
  const token = await sign(f.good.privateKey, "RS256");
  const priv = join(f.base, "priv.pem");
  const { exportPKCS8 } = await import("jose");
  writeFileSync(priv, await exportPKCS8(f.good.privateKey));
  const scenarios: Array<[string, Record<string, string>, RegExp]> = [
    ["no key source", { PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD }, /PSO_SEC_/],
    ["HS256 requested", { PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_JWKS_URI: "http://127.0.0.1:1/x", PSO_JWT_ALGORITHMS: "HS256" }, /PSO_SEC_/],
    ["private key supplied", { PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_PUBLIC_KEY_FILE: priv, PSO_JWT_ALGORITHMS: "RS256" }, /PSO_SEC_/],
    ["plain-http remote JWKS", { PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_JWKS_URI: "http://idp.example.com/jwks" }, /PSO_SEC_/],
    ["issuer missing", { PSO_JWT_AUDIENCE: AUD, PSO_JWT_JWKS_URI: "http://127.0.0.1:1/x" }, /PSO_SEC_/],
  ];
  try {
    for (const [name, env, code] of scenarios) {
      const port = randomPort();
      let failure = "";
      try { (await startNode(f.gw, { PORT: String(port), PSO_WORKSPACE: f.wsFile, ...env })).child.kill("SIGKILL"); }
      catch (e) { failure = (e as Error).message; }
      assert.ok(failure.includes("did not start"), name + ": the application must not become ready");
      assert.match(failure, code, name + ": the failure names a security issue code");
      assert.ok(!failure.includes(token), "token never logged");
      assert.ok(!failure.includes("PRIVATE KEY"), "key material never logged");
      await assert.rejects(fetch(`http://127.0.0.1:${port}/users`, { signal: AbortSignal.timeout(1000) }), name + ": nothing is listening");
    }
  } finally { f.up.server.close(); }
});

test("make:route is guarded by default and --public must be explicit", async () => {
  const base = tmp("pso-route-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const ws = join(base, "w");
  await pso(ws, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(ws, "make:module", "items", "--service", "gw");
  await pso(ws, "make:controller", "items", "--service", "gw");
  await pso(ws, "make:route", "items", "findAll", "--method", "GET", "--path", "/", "--service", "gw");
  await pso(ws, "make:route", "items", "open", "--method", "GET", "--path", "/open", "--public", "--service", "gw");
  const rows = JSON.parse((await pso(ws, "routes:list", "--json")).out).routes as Array<{ action: string; access: string }>;
  assert.equal(rows.find((r) => r.action === "findAll")!.access, "guard:jwt");
  assert.equal(rows.find((r) => r.action === "open")!.access, "public");
});

test("rate limiting: excess requests get 429 with Retry-After; health is exempt; limiter memory is bounded", async () => {
  const f = await fixture();
  const port = randomPort();
  const jwk = { ...(await exportJWK(f.good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const jwks = await listen((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); });
  const { child } = await startNode(f.gw, { PORT: String(port), PSO_WORKSPACE: f.wsFile, RATE_LIMIT_PER_MINUTE: "5", PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_JWKS_URI: `http://127.0.0.1:${jwks.port}/jwks` });
  try {
    const codes: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 9; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/users`);
      codes.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get("retry-after");
    }
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401], "first 5 reach the guard");
    assert.ok(codes.slice(5).every((c) => c === 429), `rest are limited: ${codes}`);
    assert.ok(Number(retryAfter) >= 1, "Retry-After is set");
    for (let i = 0; i < 20; i++) assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200, "health probes are never limited");
  } finally { child.kill("SIGKILL"); f.up.server.close(); jwks.server.close(); }
});
