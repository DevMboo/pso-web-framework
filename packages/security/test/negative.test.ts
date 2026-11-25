import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttps } from "node:https";
import { rmSync } from "node:fs";
import { exportPKCS8, SignJWT } from "jose";
import { loadSecurityConfig, JwtVerifier, PemKeyProvider, fetchJwks, JwksKeyProvider, SecurityInitError, type SecurityConfig } from "../src/index.ts";
import { ISS, AUD, tmp, keypair, jwkOf, pemOf, certificate, writeFile, pemEnv, jwksEnv } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* reaped by the OS */ } } });
const dir = (): string => { const d = tmp(); dirs.push(d); return d; };

async function verifier(extra: Record<string, string> = {}) {
  const d = dir();
  const k = await keypair("ES256");
  const file = writeFile(d, "pub.pem", await pemOf(k));
  const cfg = loadSecurityConfig({ projectDir: d, env: pemEnv(file, { PSO_JWT_ALGORITHMS: "ES256", ...extra }) });
  const keys = new PemKeyProvider(cfg.authentication.key as Extract<SecurityConfig["authentication"]["key"], { kind: "pem" }>, cfg.authentication.algorithms);
  await keys.init();
  return { k, v: new JwtVerifier(cfg.authentication, keys) };
}
const reason = async (v: JwtVerifier, token: string): Promise<string> => { const r = await v.verifyAuthorization(`Bearer ${token}`); return r.ok ? "OK" : r.reason; };

/** a token with full control over iss/aud/exp/nbf (the shared helper always sets issuer and audience) */
async function raw(k: Awaited<ReturnType<typeof keypair>>, o: { iss?: string | null; aud?: string | string[] | null; exp?: number; nbf?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ scope: "x" }).setProtectedHeader({ alg: k.alg, kid: k.kid }).setSubject("u1").setIssuedAt(now - 60).setExpirationTime(o.exp ?? now + 300);
  if (o.iss !== null) jwt.setIssuer(o.iss ?? ISS);
  if (o.aud !== null) jwt.setAudience(o.aud ?? AUD);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(k.privateKey);
}

test("claims: a missing issuer or audience is rejected; audience arrays are matched exactly", async () => {
  const { k, v } = await verifier();
  assert.equal(await reason(v, await raw(k, {})), "OK", "control: a well-formed token passes");
  assert.notEqual(await reason(v, await raw(k, { iss: null })), "OK", "no iss claim");
  assert.notEqual(await reason(v, await raw(k, { aud: null })), "OK", "no aud claim");
  assert.equal(await reason(v, await raw(k, { aud: ["other-api", AUD] })), "OK", "an audience list that contains ours");
  assert.equal(await reason(v, await raw(k, { aud: ["other-api", "third-api"] })), "bad_audience", "an audience list without ours");
  assert.equal(await reason(v, await raw(k, { iss: ISS + "/" })), "bad_issuer", "issuer must match exactly (trailing slash)");
  assert.equal(await reason(v, await raw(k, { aud: AUD.toUpperCase() })), "bad_audience", "audience comparison is case-sensitive");
});

test("clock skew: tolerance is honoured at the boundary and no further", async () => {
  const { k, v } = await verifier({ PSO_CFG_security__authentication__clockToleranceSeconds: "5" });
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await reason(v, await raw(k, { exp: now - 2 })), "OK", "expired 2 s ago, within 5 s tolerance");
  assert.equal(await reason(v, await raw(k, { exp: now - 30 })), "expired", "expired 30 s ago, beyond tolerance");
  assert.equal(await reason(v, await raw(k, { nbf: now + 2 })), "OK", "valid in 2 s, within tolerance");
  assert.equal(await reason(v, await raw(k, { nbf: now + 30 })), "not_yet_valid", "valid in 30 s, beyond tolerance");
});

test("unknown key id with a PEM key is rejected without trying other keys", async () => {
  const { k, v } = await verifier();
  const other = await keypair("ES256");
  assert.equal(await reason(v, await raw({ ...other, kid: "never-published" }, {})), "bad_signature");
  assert.equal(await reason(v, await raw(k, {})), "OK");
});

/** an HTTPS endpoint with a self-signed certificate that no trust store contains */
async function selfSignedJwks(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  const k = await keypair("ES256");
  const cert = await certificate(k, new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000));
  const key = await exportPKCS8(k.privateKey);
  const jwks = JSON.stringify({ keys: [await jwkOf(await keypair("ES256"))] });
  let hits = 0;
  const server = createHttps({ key, cert }, (req, res) => { hits++; res.writeHead(200, { "content-type": "application/json" }); res.end(jwks); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, hits: () => hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("TLS: a JWKS endpoint with an untrusted certificate is refused permanently and its keys are never used", async () => {
  const s = await selfSignedJwks();
  try {
    const src = { kind: "jwks" as const, uri: new URL(`https://localhost:${s.port}/jwks`), timeoutMs: 2000, cacheTtlMs: 600000, cooldownMs: 30000, maxStaleMs: 3600000, maxBytes: 262144, trustedHosts: [], loopbackAllowed: true };
    await assert.rejects(fetchJwks(src, { resolver: async () => [{ address: "127.0.0.1", family: 4 }] }), (e: unknown) => (e as { code?: string }).code === "jwks_tls" && (e as { transient?: boolean }).transient === false);
    assert.equal(s.hits(), 0, "the TLS handshake failed: no HTTP request reached the application");
    // the key provider must not retry a permanent failure and must fail closed
    let sleeps = 0;
    const provider = new JwksKeyProvider(src, { resolver: async () => [{ address: "127.0.0.1", family: 4 }], sleep: async () => { sleeps++; } });
    await assert.rejects(provider.init(), (e: unknown) => e instanceof SecurityInitError && /jwks_tls/.test(e.message) && e.transient === false);
    assert.equal(sleeps, 0, "no retries for an untrusted certificate");
  } finally { await s.close(); }
});

test("configuration: the JWKS URL can never come from a token and credentials in the URL are rejected without echoing them", () => {
  const d = dir();
  try {
    loadSecurityConfig({ projectDir: d, env: jwksEnv("https://user:s3cr3t-pass@idp.test/jwks") });
    assert.fail("credentials in the JWKS URL must be rejected");
  } catch (e) {
    assert.ok(!String((e as Error).message).includes("s3cr3t-pass"), "the secret is never echoed");
  }
});
