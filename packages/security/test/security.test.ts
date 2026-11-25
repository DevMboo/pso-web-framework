import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import {
  loadSecurityConfig, SecurityConfigError, SecurityRuntime, SecurityInitError, JwtVerifier, JwksKeyProvider, PemKeyProvider, fetchJwks, isBlockedAddress, loadPublicKeyFile,
  evaluate, composePolicies, JwtGuard, Principal, runInSecurityContext, setPrincipal, currentPrincipal, describeConfig, activeSecurity, RequireScopes, RequireRoles, CurrentPrincipal,
  type SecurityConfig, type KeyProvider,
} from "../src/index.ts";
import { ISS, AUD, tmp, keypair, jwkOf, pemOf, sign, b64, idp, certificate, writeFile, pemEnv, jwksEnv } from "./helpers.ts";

const dirs: string[] = [];
const dir = () => { const d = tmp(); dirs.push(d); return d; };
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp is reaped by the OS */ } } });

async function pemVerifier(extra: Record<string, string> = {}, alg = "ES256") {
  const d = dir();
  const k = await keypair(alg);
  const file = writeFile(d, "pub.pem", await pemOf(k));
  const cfg = loadSecurityConfig({ projectDir: d, env: pemEnv(file, { PSO_JWT_ALGORITHMS: alg, ...extra }) });
  const keys = new PemKeyProvider(cfg.authentication.key as Extract<SecurityConfig["authentication"]["key"], { kind: "pem" }>, cfg.authentication.algorithms);
  await keys.init();
  return { k, d, file, cfg, keys, v: new JwtVerifier(cfg.authentication, keys) };
}
const reason = async (v: JwtVerifier, header: string | undefined) => { const r = await v.verifyAuthorization(header); return r.ok ? "OK" : r.reason; };

// ------------------------------------------------------------------ configuration

test("config: every problem is reported together and no secret value appears in the message", () => {
  const e = assert.throws(() => loadSecurityConfig({ projectDir: dir(), env: {} }), (x: unknown) => x instanceof SecurityConfigError) as unknown;
  void e;
  try { loadSecurityConfig({ projectDir: dir(), env: {} }); } catch (x) {
    const codes = (x as SecurityConfigError).issues.map((i) => i.code);
    assert.deepEqual(codes.sort(), ["PSO_SEC_MISSING", "PSO_SEC_MISSING", "PSO_SEC_MISSING"], "issuer, audience and key source");
  }
  const secret = "TOP-SECRET-VALUE-123";
  try { loadSecurityConfig({ projectDir: dir(), env: { PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_JWKS_URI: `https://user:${secret}@idp.test/jwks` } }); assert.fail("must throw"); }
  catch (x) { assert.ok(x instanceof SecurityConfigError); assert.ok(!x.message.includes(secret), "credentials in a URL are never echoed"); assert.match(x.message, /credentials in the URL/); }
});

test("config: unsupported algorithms, conflicting key sources, insecure and unbound JWKS endpoints are rejected", () => {
  const base = { PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD };
  const codes = (env: NodeJS.ProcessEnv, environment?: string) => { try { loadSecurityConfig({ projectDir: dir(), env, ...(environment ? { environment } : {}) }); return []; } catch (e) { return (e as SecurityConfigError).issues.map((i) => i.code); } };
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "https://idp.test/jwks", PSO_JWT_ALGORITHMS: "HS256" }).includes("PSO_SEC_ALGORITHM"));
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "https://idp.test/jwks", PSO_JWT_ALGORITHMS: "none" }).includes("PSO_SEC_ALGORITHM"));
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "https://idp.test/jwks", PSO_JWT_PUBLIC_KEY_FILE: "x.pem" }).includes("PSO_SEC_KEY_CONFLICT"));
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "http://idp.test/jwks" }).includes("PSO_SEC_JWKS_INSECURE"), "plain http to a public host");
  assert.deepEqual(codes({ ...base, PSO_JWT_JWKS_URI: "http://127.0.0.1:9/jwks" }), [], "loopback http is a development exception");
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "http://127.0.0.1:9/jwks" }, "production").includes("PSO_SEC_JWKS_INSECURE"), "...and is disabled in production");
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "https://169.254.169.254/latest/meta-data" }).includes("PSO_SEC_JWKS_HOST"), "cloud metadata endpoint");
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "https://10.0.0.5/jwks" }).includes("PSO_SEC_JWKS_HOST"));
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "https://evil.example/jwks" }).includes("PSO_SEC_JWKS_HOST"), "JWKS host must be bound to the issuer");
  assert.deepEqual(codes({ ...base, PSO_JWT_JWKS_URI: "https://idp.test/.well-known/jwks.json" }), [], "same host as the issuer");
  assert.deepEqual(codes({ ...base, PSO_JWT_JWKS_URI: "https://keys.other.example/jwks", PSO_CFG_security__authentication__jwks__trustedHosts: "keys.other.example" }), [], "explicitly trusted host");
  assert.ok(codes({ ...base, PSO_JWT_JWKS_URI: "https://idp.test/jwks", PSO_CFG_security__authentication__clockToleranceSeconds: "600" }).includes("PSO_CONFIG_INVALID_VALUE"), "clock tolerance is bounded");
  assert.ok(codes({ ...base, PSO_JWT_PUBLIC_KEY_FILE: "does-not-exist.pem" }).includes("PSO_SEC_PEM_PATH"));
});

test("config: precedence (defaults < pso.config.json < environment file < PSO_CFG_* < PSO_JWT_*), ${env:} references and legacy keys", () => {
  const d = dir();
  writeFileSync(join(d, "pso.config.json"), JSON.stringify({ security: { authentication: { issuer: "https://file.test", audience: "from-file", jwks: { uri: "https://file.test/jwks" }, clockToleranceSeconds: 10 } } }));
  writeFileSync(join(d, "pso.config.production.json"), JSON.stringify({ security: { authentication: { issuer: "https://prod.test", jwks: { uri: "https://prod.test/jwks" } } } }));
  const get = (env: NodeJS.ProcessEnv, environment: string) => { const c = loadSecurityConfig({ projectDir: d, env, environment }); return c.authentication; };
  assert.equal(get({}, "development").issuer, "https://file.test");
  assert.equal(get({}, "development").clockToleranceSeconds, 10);
  assert.equal(get({}, "production").issuer, "https://prod.test", "environment file overrides the base file");
  assert.equal(get({ PSO_CFG_security__authentication__issuer: "https://cfg.test", PSO_CFG_security__authentication__jwks__uri: "https://cfg.test/jwks" }, "production").issuer, "https://cfg.test");
  assert.equal(get({ PSO_JWT_ISSUER: "https://env.test", PSO_JWT_JWKS_URI: "https://env.test/jwks", PSO_CFG_security__authentication__issuer: "https://cfg.test" }, "production").issuer, "https://env.test", "PSO_JWT_* wins");

  writeFileSync(join(d, "pso.config.json"), JSON.stringify({ security: { authentication: { issuer: "${env:MY_ISS}", audience: ["a", "b"], jwks: { uri: "https://ref.test/jwks" } } } }));
  rmSync(join(d, "pso.config.production.json"));
  assert.equal(get({ MY_ISS: "https://ref.test" }, "development").issuer, "https://ref.test");
  assert.deepEqual(get({ MY_ISS: "https://ref.test" }, "development").audiences, ["a", "b"]);
  try { get({}, "development"); assert.fail(); } catch (e) { assert.match((e as Error).message, /PSO_SEC_ENV_MISSING/); assert.match((e as Error).message, /MY_ISS/); }

  writeFileSync(join(d, "pso.config.json"), JSON.stringify({ security: { jwt: { issuer: "https://legacy.test", audience: "legacy", jwksUri: "https://legacy.test/jwks" } } }));
  assert.equal(get({}, "development").issuer, "https://legacy.test", "security.jwt.* is still honoured");
  assert.ok(!JSON.stringify(describeConfig(loadSecurityConfig({ projectDir: d, env: {} }))).includes("privateKey"));
});

// ------------------------------------------------------------------ verification

test("JWT: valid tokens verify into an immutable principal (scopes, roles via configurable claim path, permissions)", async () => {
  const { k, v } = await pemVerifier({ PSO_CFG_security__authentication__rolesClaim: "realm_access.roles" });
  const t = await sign(k, { scope: "users:read users:write", extra: { realm_access: { roles: ["admin", "editor"] }, permissions: ["audit:export"], scp: ["extra:scope"] } });
  const r = await v.verifyAuthorization(`Bearer ${t}`);
  assert.ok(r.ok);
  const p = r.principal;
  assert.equal(p.subject, "user-1");
  assert.deepEqual([...p.scopes].sort(), ["extra:scope", "users:read", "users:write"]);
  assert.deepEqual(p.roles, ["admin", "editor"]);
  assert.ok(p.hasScope("users:read") && p.hasRole("admin") && p.hasPermission("audit:export") && !p.hasScope("nope"));
  assert.throws(() => { (p as unknown as { subject: string }).subject = "evil"; }, TypeError);
  assert.throws(() => { (p.scopes as string[]).push("admin"); }, TypeError);
  assert.ok(!JSON.stringify(p).includes(t.slice(10, 40)), "the raw token is not part of the principal");
  assert.ok(!("token" in p));
});

test("JWT: the attack matrix is rejected with internal reasons that clients never see", async () => {
  const { k, v, d } = await pemVerifier();
  const other = await keypair("ES256");
  const rs = await keypair("RS256");
  const hmac = await new SignJWT({ scope: "x" }).setProtectedHeader({ alg: "HS256" }).setIssuer(ISS).setAudience(AUD).setSubject("x").setExpirationTime("5m").sign(new TextEncoder().encode(readFileSync(join(d, "pub.pem"), "utf8")));
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<[string, string | undefined, string]> = [
    ["no header", undefined, "missing_header"],
    ["basic scheme", `Basic ${await sign(k)}`, "malformed_header"],
    ["lowercase bearer", `bearer ${await sign(k)}`, "malformed_header"],
    ["double space", `Bearer  ${await sign(k)}`, "malformed_header"],
    ["two tokens", `Bearer ${await sign(k)} ${await sign(k)}`, "malformed_header"],
    ["not a jwt", "Bearer not.a.jwt!", "malformed_header"],
    ["two segments", "Bearer abc.def", "malformed_header"],
    ["five segments (JWE shape)", "Bearer a.b.c.d.e", "malformed_header"],
    ["garbage header segment", `Bearer ${b64({ foo: 1 })}.${b64({})}.sig`, "bad_algorithm"],
    ["oversized", `Bearer ${"a".repeat(9000)}.b.c`, "token_too_large"],
    ["expired", `Bearer ${await sign(k, { exp: now - 3600 })}`, "expired"],
    ["not yet valid", `Bearer ${await sign(k, { nbf: now + 3600 })}`, "not_yet_valid"],
    ["wrong signature", `Bearer ${await sign({ ...other, kid: k.kid })}`, "bad_signature"],
    ["wrong issuer", `Bearer ${await sign(k, { iss: "https://evil.test" })}`, "bad_issuer"],
    ["wrong audience", `Bearer ${await sign(k, { aud: "other-api" })}`, "bad_audience"],
    ["missing subject", `Bearer ${await sign(k, { sub: null })}`, "missing_claim"],
    ["empty subject", `Bearer ${await sign(k, { sub: "" })}`, "invalid_subject"],
    ["missing exp", `Bearer ${await sign(k, { exp: null as unknown as undefined })}`, "missing_claim"],
    ["alg none", `Bearer ${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: ISS, aud: AUD, sub: "x", exp: now + 999 })}.`, "bad_algorithm"],
    ["HS256 key confusion", `Bearer ${hmac}`, "bad_algorithm"],
    ["alg not allow-listed", `Bearer ${await sign(rs)}`, "bad_algorithm"],
    ["token naming its own key source (jku)", `Bearer ${await sign(k, { header: { jku: "https://evil.test/jwks" } })}`, "forbidden_header"],
    ["embedded jwk header", `Bearer ${await sign(k, { header: { jwk: { kty: "EC" } } })}`, "forbidden_header"],
  ];
  for (const [name, h, want] of cases) assert.equal(await reason(v, h), want, name);
  assert.equal(await reason(v, ["Bearer a.b.c", "Bearer d.e.f"] as unknown as string), "malformed_header", "repeated header");
});

test("JWT: token type and clock tolerance are enforced from configuration", async () => {
  const { k, v } = await pemVerifier({ PSO_CFG_security__authentication__tokenType: "at+jwt", PSO_CFG_security__authentication__clockToleranceSeconds: "0" });
  assert.equal(await reason(v, `Bearer ${await sign(k)}`), "invalid", "typ JWT is not at+jwt");
  assert.equal(await reason(v, `Bearer ${await sign(k, { header: { typ: "at+jwt" } })}`), "OK");
  assert.equal(await reason(v, `Bearer ${await sign(k, { header: { typ: "at+jwt" }, exp: Math.floor(Date.now() / 1000) - 1 })}`), "expired", "zero tolerance");
});

// ------------------------------------------------------------------ PEM and certificates

test("PEM: private keys, malformed files, multiple blocks and algorithm/key mismatches are rejected", async () => {
  const d = dir();
  const k = await keypair("ES256");
  const priv = generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const err = (f: string, algs: Parameters<typeof loadPublicKeyFile>[1] = ["ES256"]) => { try { loadPublicKeyFile(f, algs); return "OK"; } catch (e) { return (e as { code: string }).code; } };
  assert.equal(err(writeFile(d, "private.pem", priv.privateKey)), "pem_private_key");
  assert.equal(err(writeFile(d, "garbage.pem", "not a pem")), "pem_malformed");
  assert.equal(err(writeFile(d, "broken.pem", "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")), "pem_malformed");
  assert.equal(err(writeFile(d, "two.pem", (await pemOf(k)) + (await pemOf(k)))), "pem_malformed");
  assert.equal(err(writeFile(d, "rsa-pub.pem", "-----BEGIN RSA PUBLIC KEY-----\nAAAA\n-----END RSA PUBLIC KEY-----\n")), "pem_unsupported");
  assert.equal(err(join(d, "missing.pem")), "pem_missing");
  assert.equal(err(d), "pem_not_file");
  const ok = writeFile(d, "ec.pem", await pemOf(k));
  assert.equal(err(ok), "OK");
  assert.equal(err(ok, ["RS256"]), "alg_key_mismatch", "EC key with an RSA algorithm");
  assert.equal(err(ok, ["ES384"]), "alg_key_mismatch", "P-256 key with ES384");
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  assert.equal(err(writeFile(d, "weak.pem", weak.publicKey), ["RS256"]), "alg_key_mismatch", "RSA below 2048 bits");
  const ed = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  assert.equal(err(writeFile(d, "ed.pem", ed.publicKey), ["EdDSA"]), "OK");
  // through the runtime: a private key as a verification key keeps the application from starting
  await assert.rejects(SecurityRuntime.initialize({ projectDir: d, env: pemEnv(join(d, "private.pem")), register: false }), (e: unknown) => e instanceof SecurityInitError && /pem_private_key/.test((e as Error).message) && !(e as Error).message.includes("BEGIN"));
  assert.equal(activeSecurity(), undefined);
});

test("X.509: validity period is enforced; the certificate is a pinned container (no chain or revocation semantics)", async () => {
  const d = dir();
  const k = await keypair("ES256");
  const day = 86_400_000;
  const good = writeFile(d, "good.pem", await certificate(k, new Date(Date.now() - day), new Date(Date.now() + 30 * day)));
  const expired = writeFile(d, "expired.pem", await certificate(k, new Date(Date.now() - 60 * day), new Date(Date.now() - day)));
  const future = writeFile(d, "future.pem", await certificate(k, new Date(Date.now() + day), new Date(Date.now() + 30 * day)));
  const load = (f: string) => { try { return loadPublicKeyFile(f, ["ES256"]); } catch (e) { return (e as { code: string }).code; } };
  const g = load(good);
  assert.ok(typeof g === "object" && g.source === "x509" && g.notAfter!.getTime() > Date.now());
  assert.equal(load(expired), "cert_expired");
  assert.equal(load(future), "cert_not_yet_valid");
  const rt = await SecurityRuntime.initialize({ projectDir: d, env: pemEnv(good), register: false });
  try {
    const r = await rt.authenticate({ headers: { authorization: `Bearer ${await sign(k)}` } } as never);
    assert.ok(r.ok, "a token signed by the certificate's key verifies");
  } finally { rt.close(); }
  await assert.rejects(SecurityRuntime.initialize({ projectDir: d, env: pemEnv(expired), register: false }), /cert_expired/);
});

test("PEM rotation: a replaced file is picked up without a restart; a bad replacement never disables verification", async () => {
  const d = dir();
  const a = await keypair("ES256"), b = await keypair("ES256");
  const file = writeFile(d, "pub.pem", await pemOf(a));
  const cfg = loadSecurityConfig({ projectDir: d, env: pemEnv(file) });
  let now = Date.now();
  const keys = new PemKeyProvider(cfg.authentication.key as never, cfg.authentication.algorithms, { now: () => now });
  await keys.init();
  const v = new JwtVerifier(cfg.authentication, keys);
  const ta = `Bearer ${await sign(a)}`, tb = `Bearer ${await sign(b)}`;
  assert.equal(await reason(v, ta), "OK");
  assert.equal(await reason(v, tb), "bad_signature");
  writeFileSync(file, await pemOf(b));
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  now += 6000;
  assert.equal(await reason(v, tb), "OK", "new key active");
  assert.equal(await reason(v, ta), "bad_signature", "old key retired");
  writeFileSync(file, "garbage");
  utimesSync(file, new Date(Date.now() + 20000), new Date(Date.now() + 20000));
  now += 6000;
  assert.equal(await reason(v, tb), "OK", "a corrupt replacement keeps the last good key");
  assert.equal(keys.describe()["reloads"], 2);
});

// ------------------------------------------------------------------ JWKS

async function jwksSetup(extraEnv: Record<string, string> = {}, deps: ConstructorParameters<typeof JwksKeyProvider>[1] = {}) {
  const k = await keypair("ES256");
  const server = await idp([await jwkOf(k)]);
  const cfg = loadSecurityConfig({ projectDir: dir(), env: jwksEnv(server.url, extraEnv) });
  const src = cfg.authentication.key as Extract<SecurityConfig["authentication"]["key"], { kind: "jwks" }>;
  const provider = new JwksKeyProvider(src, deps);
  return { k, server, cfg, src, provider, v: new JwtVerifier(cfg.authentication, provider) };
}

test("JWKS: keys are cached (one fetch for many verifications) and concurrent cold requests share one fetch", async () => {
  const s = await jwksSetup();
  try {
    await s.provider.init();
    assert.equal(s.server.hits(), 1);
    const t = `Bearer ${await sign(s.k)}`;
    const results = await Promise.all(Array.from({ length: 50 }, () => reason(s.v, t)));
    assert.ok(results.every((r) => r === "OK"));
    assert.equal(s.server.hits(), 1, "cached");
  } finally { await s.server.close(); }
  const cold = await jwksSetup();
  try {
    const t = `Bearer ${await sign(cold.k)}`;
    const rs = await Promise.all(Array.from({ length: 25 }, () => reason(cold.v, t)));
    assert.ok(rs.every((r) => r === "OK"));
    assert.equal(cold.server.hits(), 1, "single-flight refresh on a cold cache");
  } finally { await cold.server.close(); }
});

test("JWKS: rotation: an unknown key id triggers one controlled refresh per cooldown; retired keys stop validating", async () => {
  let now = 1_000_000;
  const s = await jwksSetup({}, { now: () => now });
  const k2 = await keypair("ES256");
  try {
    await s.provider.init();
    s.server.set({ keys: [await jwkOf(s.k), await jwkOf(k2)] });
    const t2 = `Bearer ${await sign(k2)}`;
    now += 31_000; // cooldown elapsed
    assert.equal(await reason(s.v, t2), "OK", "new kid fetched on demand");
    assert.equal(s.server.hits(), 2);
    // an attacker spraying unknown key ids cannot make the gateway hammer the IdP
    const unknown = await keypair("ES256");
    for (let i = 0; i < 20; i++) await reason(s.v, `Bearer ${await sign(unknown)}`);
    assert.ok(s.server.hits() <= 3, `refreshes are rate limited (hits: ${s.server.hits()})`);
    // rotation retires the first key
    s.server.set({ keys: [await jwkOf(k2)] });
    now += 601_000; // cache expired
    assert.equal(await reason(s.v, `Bearer ${await sign(s.k)}`), "unknown_key", "retired key");
    assert.equal(await reason(s.v, t2), "OK");
  } finally { await s.server.close(); }
});

test("JWKS: transient failures are distinguished from invalid tokens; stale keys serve for a bounded time", async () => {
  let now = 5_000_000;
  const s = await jwksSetup({}, { now: () => now });
  try {
    await s.provider.init();
    const t = `Bearer ${await sign(s.k)}`;
    s.server.set({ status: 500 });
    now += 700_000; // beyond the 10 minute TTL; the endpoint is down
    assert.equal(await reason(s.v, t), "OK", "stale keys keep serving while the IdP is down");
    now += 3_700_000; // beyond max stale
    assert.equal(await reason(s.v, t), "key_unavailable", "not a signature problem: the keys are unavailable");
    s.server.set({ status: 200 });
    assert.equal(await reason(s.v, t), "OK", "recovers when the IdP is back");
    assert.equal(await reason(s.v, `Bearer ${await sign({ ...(await keypair("ES256")), kid: s.k.kid })}`), "bad_signature", "an invalid token is still just invalid");
  } finally { await s.server.close(); }
});

test("JWKS initialization: timeouts retry then fail; redirects, oversized, non-JSON and private-key responses are refused immediately", async () => {
  const s = await jwksSetup({ PSO_CFG_security__authentication__jwks__timeoutMs: "300" }, { sleep: async () => undefined });
  try {
    s.server.set({ delayMs: 1500 });
    await assert.rejects(s.provider.init(), (e: unknown) => e instanceof SecurityInitError && e.transient === true && /jwks_timeout/.test(e.message));
    assert.equal(s.server.hits(), JwksKeyProvider.MAX_INIT_ATTEMPTS, "a transient failure is retried up to the attempt limit (the sleeps are skipped here, so the deadline does not end it first); JWKS-01 replaced the fixed three attempts");
  } finally { await s.server.close(); }

  const cases: Array<[string, Parameters<typeof s.server.set>[0], string]> = [
    ["redirect", { redirect: "http://127.0.0.1:1/elsewhere" }, "jwks_redirect"],
    ["wrong content type", { contentType: "text/html" }, "jwks_content_type"],
    ["not JSON", { body: "<html>" }, "jwks_invalid"],
    ["oversized", { body: JSON.stringify({ keys: [], pad: "x".repeat(300_000) }) }, "jwks_too_large"],
    ["private material", { body: JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret" }] }) }, "jwks_private_material"],
    ["empty set", { body: JSON.stringify({ keys: [] }) }, "jwks_invalid"],
    ["server error is transient", { status: 503 }, "jwks_status"],
  ];
  for (const [name, state, code] of cases) {
    const t = await jwksSetup({}, { sleep: async () => undefined });
    try {
      t.server.set(state);
      await assert.rejects(t.provider.init(), (e: unknown) => e instanceof SecurityInitError && e.message.includes(code), name);
      if (name !== "server error is transient") assert.equal(t.server.hits(), 1, `${name}: permanent failures are not retried`);
    } finally { await t.server.close(); }
  }
});

test("JWKS SSRF: private, loopback, link-local and metadata destinations are refused, and the validated address is the one connected to", async () => {
  for (const [ip, blocked] of [["127.0.0.1", true], ["10.1.2.3", true], ["172.16.0.1", true], ["172.31.255.255", true], ["192.168.1.1", true], ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["224.0.0.1", true],
    ["::1", true], ["fe80::1", true], ["fc00::1", true], ["::ffff:169.254.169.254", true], ["::ffff:10.0.0.1", true], ["8.8.8.8", false], ["1.1.1.1", false], ["2606:4700:4700::1111", false], ["172.32.0.1", false]] as const) {
    assert.equal(isBlockedAddress(ip), blocked, ip);
  }
  assert.equal(isBlockedAddress("127.0.0.1", true), false, "explicit development exception");
  assert.equal(isBlockedAddress("169.254.169.254", true), true, "the metadata endpoint is never allowed");

  const k = await keypair("ES256");
  const server = await idp([await jwkOf(k)]);
  const port = server.port;
  try {
    const src = (loopbackAllowed: boolean) => ({ kind: "jwks" as const, uri: new URL(`http://localhost:${port}/jwks`), timeoutMs: 2000, cacheTtlMs: 600000, cooldownMs: 30000, maxStaleMs: 3600000, maxBytes: 262144, trustedHosts: [], loopbackAllowed });
    const code = async (s: ReturnType<typeof src>, resolver: (h: string) => Promise<Array<{ address: string; family: number }>>) => { try { await fetchJwks(s, { resolver }); return "OK"; } catch (e) { return (e as { code: string }).code; } };
    assert.equal(await code(src(true), async () => [{ address: "127.0.0.1", family: 4 }]), "OK");
    assert.equal(server.hits(), 1);
    // DNS answers pointing at internal ranges never produce a connection
    for (const evil of ["169.254.169.254", "10.0.0.5", "192.168.0.10", "::ffff:169.254.169.254"]) assert.equal(await code(src(true), async () => [{ address: evil, family: evil.includes(":") ? 6 : 4 }]), "jwks_blocked_address", evil);
    assert.equal(await code(src(true), async () => [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.1", family: 4 }]), "jwks_blocked_address", "any blocked answer rejects the host");
    assert.equal(await code(src(false), async () => [{ address: "127.0.0.1", family: 4 }]), "jwks_blocked_address", "loopback is blocked unless the development exception is on");
    assert.equal(server.hits(), 1, "no request reached the server for blocked destinations");
    // pinning: the resolver is consulted once and its (validated) answer is what is connected to
    let calls = 0;
    assert.equal(await code(src(true), async () => { calls++; return [{ address: "127.0.0.1", family: 4 }]; }), "OK");
    assert.equal(calls, 1);
    assert.equal(await code(src(true), async () => { throw new Error("nxdomain"); }), "jwks_dns");
  } finally { await server.close(); }
});

// ------------------------------------------------------------------ authorization, guards, context

test("authorization: scopes (all), roles (any, AND across levels), permissions, composed policies", () => {
  const p = new Principal({ subject: "u", issuer: ISS, audiences: [AUD], scopes: ["a", "b"], roles: ["editor"], permissions: ["x"], expiresAt: new Date(Date.now() + 1000) });
  assert.deepEqual(evaluate(p, { scopes: ["a", "b"] }), { allowed: true });
  assert.deepEqual(evaluate(p, { scopes: ["a", "c"] }), { allowed: false, missing: { scopes: ["c"], roleSets: [], permissions: [] } });
  assert.deepEqual(evaluate(p, { roleSets: [["admin", "editor"]] }), { allowed: true });
  assert.equal(evaluate(p, { roleSets: [["admin", "editor"], ["owner"]] }).allowed, false, "every level must be satisfied");
  assert.equal(evaluate(p, { permissions: ["x", "y"] }).allowed, false);
  assert.equal(evaluate(p, {}).allowed, true);
  const pol = composePolicies(() => true, () => ({ allowed: false, reason: "blocked" }));
  assert.deepEqual(pol(p), { allowed: false, reason: "blocked" });
});

test("guards: 401 without a verified identity, 403 when a policy forbids, principal handed to the framework", async () => {
  const d = dir();
  const k = await keypair("ES256");
  const rt = await SecurityRuntime.initialize({ projectDir: d, env: pemEnv(writeFile(d, "p.pem", await pemOf(k))) });
  try {
    const route = { module: "m", method: "GET", path: "/x", scopes: [], roleSets: [] };
    const req = async (extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${await sign(k, extra as never)}` } }) as never;
    const g = JwtGuard.create();
    const ok = await g(await req(), route);
    assert.ok(typeof ok === "object" && ok.allow === true && ok.principal?.subject === "user-1");
    assert.deepEqual(await g({ headers: {} } as never, route), { allow: false, status: 401 });
    const strict = JwtGuard.create({ policy: (p) => p.hasScope("admin") });
    assert.deepEqual(await strict(await req(), route), { allow: false, status: 403 }, "authenticated but not permitted: 403");
    assert.deepEqual(await strict({ headers: {} } as never, route), { allow: false, status: 401 }, "a policy cannot turn anonymous access on");
    assert.throws(() => JwtGuard.create({ policy: "anonymous" as never }), /unknown policy/);
    assert.ok(rt.metrics.snapshot().failures["missing_header"] >= 1);
  } finally { rt.close(); }
  const unready = JwtGuard.create();
  assert.deepEqual(await unready({ headers: {} } as never, { module: "m", method: "GET", path: "/", scopes: [], roleSets: [] }), { allow: false, status: 401 }, "no initialized runtime: fail closed");
});

test("request-scoped principal: concurrent requests never see each other's identity", async () => {
  const mk = (s: string) => new Principal({ subject: s, issuer: ISS, audiences: [], scopes: [], roles: [], permissions: [], expiresAt: new Date(Date.now() + 1000) });
  const seen = await Promise.all(Array.from({ length: 200 }, (_, i) => runInSecurityContext(async () => {
    setPrincipal(mk(`user-${i}`));
    await new Promise((r) => setTimeout(r, Math.random() * 15));
    await Promise.resolve();
    return currentPrincipal()?.subject;
  })));
  assert.deepEqual(seen, Array.from({ length: 200 }, (_, i) => `user-${i}`));
  assert.equal(currentPrincipal(), undefined, "nothing leaks outside a request");
  assert.throws(() => setPrincipal(mk("x")), /outside a request/);
  await runInSecurityContext(async () => { assert.equal(currentPrincipal(), undefined, "a fresh context starts anonymous"); });
});

test("decorators record scopes, roles and the principal parameter, and reject odd names", () => {
  class C {
    me(_p: unknown) { return 1; }
    read() { return 1; }
  }
  RequireScopes("a:read", "a:write")(C);
  RequireScopes("x:y")(C.prototype, "read");
  RequireRoles("admin", "editor")(C.prototype, "read");
  CurrentPrincipal()(C.prototype, "me", 0);
  assert.deepEqual(Reflect.getOwnMetadata("pso:scopes", C), ["a:read", "a:write"]);
  assert.deepEqual(Reflect.getOwnMetadata("pso:scopes", C.prototype, "read"), ["x:y"]);
  assert.deepEqual(Reflect.getOwnMetadata("pso:roles", C.prototype, "read"), ["admin", "editor"]);
  assert.deepEqual(Reflect.getOwnMetadata("pso:params", C.prototype, "me"), [{ index: 0, kind: "principal" }]);
  assert.throws(() => RequireScopes("bad scope; drop")(C), /invalid scope name/);
  assert.throws(() => RequireRoles("")(C), /invalid role name/);
});

// ------------------------------------------------------------------ initialization

test("initialization fails closed: missing configuration, unreachable JWKS and blocked endpoints keep the application from starting", async () => {
  await assert.rejects(SecurityRuntime.initialize({ projectDir: dir(), env: {}, register: false }), (e: unknown) => e instanceof SecurityConfigError);
  // an unreachable IdP: nothing is listening on this port
  const free = await new Promise<number>((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
  await assert.rejects(SecurityRuntime.initialize({ projectDir: dir(), env: jwksEnv(`http://127.0.0.1:${free}/jwks`), deps: { sleep: async () => undefined }, register: false }), (e: unknown) => e instanceof SecurityInitError && e.transient);
  assert.equal(activeSecurity(), undefined, "a failed initialization is never cached");
  // success registers; close() unregisters
  const k = await keypair("ES256");
  const server = await idp([await jwkOf(k)]);
  try {
    const rt = await SecurityRuntime.initialize({ projectDir: dir(), env: jwksEnv(server.url) });
    assert.equal(activeSecurity(), rt);
    const desc = JSON.stringify(rt.describe());
    assert.ok(!desc.includes("PRIVATE"), "describe() is safe to print");
    rt.close();
    assert.equal(activeSecurity(), undefined);
  } finally { await server.close(); }
});

test("sensitive data: logs and descriptions never contain tokens, keys or claims", async () => {
  const lines: string[] = [];
  const d = dir();
  const k = await keypair("ES256");
  const rt = await SecurityRuntime.initialize({ projectDir: d, env: pemEnv(writeFile(d, "p.pem", await pemOf(k))), sink: (l) => lines.push(l), register: false });
  try {
    const token = await sign(k, { exp: 1 });
    await rt.authenticate({ headers: { authorization: `Bearer ${token}` } } as never, { route: "GET /x", correlationId: "c-1" });
    const p = new Principal({ subject: "u", issuer: ISS, audiences: [], scopes: ["s"], roles: [], permissions: [], expiresAt: new Date() });
    rt.authorize(p, { scopes: ["admin"] }, { route: "GET /x" });
    const all = lines.join("\n") + JSON.stringify(rt.describe());
    assert.match(all, /"reason":"expired"/);
    assert.match(all, /authorization denied/);
    for (const needle of [token.slice(0, 30), token.split(".")[2]!.slice(0, 20), "PRIVATE KEY", "user-1"]) assert.ok(!all.includes(needle), `leaked ${needle.slice(0, 10)}`);
  } finally { rt.close(); }
  mkdirSync(d, { recursive: true });
});
