import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createDevCertificate } from "@pso/core";
import { fetchJwks, JwksKeyProvider, loadSecurityConfig, SecurityConfigError, SecurityInitError, isBlockedAddress, isPrivateNetworkAddress } from "../src/index.ts";
import type { JwksSource } from "../src/config.ts";
import { keypair, jwkOf } from "./helpers.ts";

/**
 * JWKS-01 and IDP-01. Everything here runs against a synthetic identity provider started by the test (an HTTPS server with a
 * certificate from a certificate authority created for this run): no public identity provider is contacted.
 *
 * JWKS-01: the start-up key load used to give up after three attempts in under a second, so a network that needed a moment made the
 * orchestrator exit. It is now bounded by an overall deadline, with exponential backoff and jitter, per-attempt connection and
 * response timeouts and cancellation; permanent failures (TLS, blocked address, redirect, invalid content) are still not retried.
 * IDP-01: an identity provider on a private network is accepted only when the JWKS URI's own host:port is approved explicitly.
 */
const dir = mkdtempSync(join(tmpdir(), "pso-jwks-"));
const servers: https.Server[] = [];
after(() => { for (const s of servers) s.close(); rmSync(dir, { recursive: true, force: true }); });

const ca = createDevCertificate({ commonName: "PSO test CA (not for production)", ca: true });
const caFile = join(dir, "ca.crt"); writeFileSync(caFile, ca.certPem);
const HOST = "idp.pso.test";

interface Idp { port: number; hits: () => number; state: { status: number; body?: string; contentType: string; fail: number; redirect?: string; delayMs: number; keys: unknown[] } }
async function idp(cert = createDevCertificate({ commonName: HOST, names: [HOST], issuer: ca }), keys?: unknown[]): Promise<Idp> {
  const state: Idp["state"] = { status: 200, contentType: "application/json", fail: 0, delayMs: 0, keys: keys ?? [await jwkOf(await keypair("ES256"))] };
  let hits = 0;
  const server = https.createServer({ cert: cert.certPem, key: cert.keyPem }, (_req, res) => {
    hits++;
    const answer = (): void => {
      if (state.redirect) { res.writeHead(302, { location: state.redirect }); res.end(); return; }
      if (state.fail > 0) { state.fail--; res.writeHead(503, { "content-type": "text/plain" }); res.end("unavailable"); return; }
      res.writeHead(state.status, { "content-type": state.contentType });
      res.end(state.body ?? JSON.stringify({ keys: state.keys }));
    };
    if (state.delayMs) setTimeout(answer, state.delayMs); else answer();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, hits: () => hits, state };
}
const source = (port: number, o: Partial<JwksSource> = {}): JwksSource => ({ kind: "jwks", uri: new URL(`https://${HOST}:${port}/jwks`), timeoutMs: 2000, connectTimeoutMs: 1000, initDeadlineMs: 5000, cacheTtlMs: 600_000, cooldownMs: 30_000, maxStaleMs: 3_600_000, maxBytes: 262_144, trustedHosts: [], loopbackAllowed: true, caFile, ...o });
const local = async (): Promise<Array<{ address: string; family: number }>> => [{ address: "127.0.0.1", family: 4 }];
const failure = async (p: Promise<unknown>): Promise<{ code?: string; transient?: boolean; message: string }> => { try { await p; return { message: "resolved" }; } catch (e) { return e as { code?: string; transient?: boolean; message: string }; } };

test("JWKS-01: an available identity provider is loaded in one attempt, over TLS verified with the configured certificate authority", async () => {
  const s = await idp();
  const sleeps: number[] = [];
  const p = new JwksKeyProvider(source(s.port), { resolver: local, sleep: async (ms) => { sleeps.push(ms); } });
  await p.init();
  assert.deepEqual([s.hits(), sleeps.length, (p.describe()["keys"] as unknown[]).length], [1, 0, 1]);
});

test("JWKS-01: transient failures at start-up are retried with exponential backoff and jitter, then the keys are loaded", async () => {
  // the identity provider answers 503 three times
  const s = await idp(); s.state.fail = 3;
  const sleeps: number[] = [];
  await new JwksKeyProvider(source(s.port), { resolver: local, sleep: async (ms) => { sleeps.push(ms); }, random: () => 1 }).init();
  assert.equal(s.hits(), 4);
  assert.deepEqual(sleeps, [250, 500, 1000], "the step doubles");
  const jittered: number[] = [];
  const t = await idp(); t.state.fail = 3;
  await new JwksKeyProvider(source(t.port), { resolver: local, sleep: async (ms) => { jittered.push(ms); }, random: () => 0 }).init();
  assert.deepEqual(jittered, [125, 250, 500], "jitter: between half the step and the step");

  // DNS that fails twice, then answers slowly
  const d = await idp(); let lookups = 0;
  await new JwksKeyProvider(source(d.port), { sleep: async () => undefined, resolver: async () => { if (++lookups <= 2) throw new Error("EAI_AGAIN"); await new Promise((r) => setTimeout(r, 300)); return local(); } }).init();
  assert.deepEqual([lookups, d.hits()], [3, 1]);

  // an address that refuses the connection on the first attempts (the endpoint is not up yet)
  const c = await idp(); let n = 0;
  await new JwksKeyProvider(source(c.port), { sleep: async () => undefined, resolver: async () => (++n <= 2 ? [{ address: "127.0.0.2", family: 4 }] : local()) }).init();
  assert.deepEqual([n, c.hits()], [3, 1]);

  // a response slower than the per-attempt timeout is a transient failure too
  const slow = await idp(); slow.state.delayMs = 600;
  const one = await failure(fetchJwks(source(slow.port, { timeoutMs: 200 }), { resolver: local }));
  assert.deepEqual([one.code, one.transient], ["jwks_timeout", true]);
});

test("JWKS-01: the start-up load is bounded: by its deadline, by a maximum number of attempts, and it never leaves a retry running", async () => {
  const s = await idp(); s.state.fail = 1_000_000;
  // real waiting: the deadline ends it
  const started = Date.now();
  const e = await failure(new JwksKeyProvider(source(s.port, { initDeadlineMs: 900 }), { resolver: local }).init());
  const took = Date.now() - started;
  assert.ok(e instanceof SecurityInitError && e.transient, e.message);
  assert.match(e.message, /jwks_status: the JWKS endpoint answered HTTP 503 \(\d+ attempts in \d+ ms\)/);
  assert.ok(took >= 850 && took < 3000, `ended by the deadline (${took} ms)`);
  const afterFailure = s.hits();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(s.hits(), afterFailure, "no request after the load gave up");
  // no waiting at all: the attempt limit ends it (no amplification however generous the deadline)
  const before = s.hits();
  const sleeps: number[] = [];
  await failure(new JwksKeyProvider(source(s.port, { initDeadlineMs: 300_000 }), { resolver: local, sleep: async (ms) => { sleeps.push(ms); }, random: () => 1 }).init());
  assert.equal(s.hits() - before, JwksKeyProvider.MAX_INIT_ATTEMPTS);
  assert.equal(Math.max(...sleeps), 5000, "the backoff step is capped");
  // deadline 0: exactly one attempt
  const z = s.hits();
  await failure(new JwksKeyProvider(source(s.port, { initDeadlineMs: 0 }), { resolver: local }).init());
  assert.equal(s.hits() - z, 1);
});

test("JWKS-01: permanent failures are not retried: untrusted certificate, wrong host name, expired certificate, missing trust, invalid content, redirect", async () => {
  const run = async (src: JwksSource): Promise<{ code: string | undefined; message: string; sleeps: number }> => {
    let sleeps = 0;
    const e = await failure(new JwksKeyProvider(src, { resolver: local, sleep: async () => { sleeps++; } }).init());
    assert.ok(e instanceof SecurityInitError && !e.transient, e.message);
    return { code: /: (jwks_[a-z_]+):/.exec(e.message)?.[1], message: e.message, sleeps };
  };
  const good = await idp();
  const otherCa = join(dir, "other-ca.crt"); writeFileSync(otherCa, createDevCertificate({ commonName: "another CA", ca: true }).certPem);
  assert.deepEqual([(await run(source(good.port, { caFile: otherCa }))).code, (await run(source(good.port, { caFile: otherCa }))).sleeps], ["jwks_tls", 0], "signed by an authority that is not trusted");
  const { caFile: _none, ...noCa } = source(good.port);
  assert.equal((await run(noCa as JwksSource)).code, "jwks_tls", "no trust configured for a private authority: refused, never accepted unverified");
  const wrongName = await idp(createDevCertificate({ commonName: "someone-else.pso.test", names: ["someone-else.pso.test"], issuer: ca }));
  const w = await run(source(wrongName.port));
  assert.equal(w.code, "jwks_tls"); assert.match(w.message, /ERR_TLS_CERT_ALTNAME_INVALID/, "the certificate must name the host");
  const expired = await idp(createDevCertificate({ commonName: HOST, names: [HOST], issuer: ca, notBefore: new Date(Date.now() - 2 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) }));
  const x = await run(source(expired.port));
  assert.equal(x.code, "jwks_tls"); assert.match(x.message, /CERT_HAS_EXPIRED/);
  assert.equal(good.hits() + wrongName.hits() + expired.hits(), 0, "no request is sent on a connection that was not verified");

  const invalid = await idp(); invalid.state.body = "<html>not a key set</html>";
  assert.deepEqual([(await run(source(invalid.port))).code, invalid.hits()], ["jwks_invalid", 1]);
  const priv = await idp(undefined, [{ kty: "oct", k: "c2VjcmV0", kid: "symmetric" }]);
  assert.equal((await run(source(priv.port))).code, "jwks_private_material");
  const html = await idp(); html.state.contentType = "text/html";
  assert.equal((await run(source(html.port))).code, "jwks_content_type");
  const redirect = await idp(); redirect.state.redirect = `https://${HOST}:${good.port}/jwks`;
  assert.deepEqual([(await run(source(redirect.port))).code, good.hits()], ["jwks_redirect", 0], "a redirect is never followed, even to the same host");
});

test("JWKS-01: a start-up that is abandoned cancels the request in flight and the retries", async () => {
  const s = await idp(); s.state.fail = 1_000_000;
  const abort = new AbortController();
  const started = Date.now();
  const pending = failure(new JwksKeyProvider(source(s.port, { initDeadlineMs: 60_000 }), { resolver: local, signal: abort.signal }).init());
  setTimeout(() => abort.abort(), 400);
  const e = await pending;
  assert.ok(e instanceof SecurityInitError, e.message);
  assert.ok(Date.now() - started < 2500, "ended when cancelled, not at the deadline");
  const hits = s.hits();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(s.hits(), hits, "nothing is requested after the cancellation");
  // a request that is in flight is cancelled too
  const slow = await idp(); slow.state.delayMs = 5000;
  const a2 = new AbortController();
  const f = failure(fetchJwks(source(slow.port, { timeoutMs: 10_000 }), { resolver: local, signal: a2.signal }));
  setTimeout(() => a2.abort(), 200);
  assert.equal((await f).code, "jwks_cancelled");
});

test("JWKS-01: concurrent requests share one fetch; keys keep serving through an outage and are refreshed when the provider is back; a new key is picked up", async () => {
  const k1 = await jwkOf(await keypair("ES256")), k2 = await jwkOf(await keypair("ES256"));
  const s = await idp(undefined, [{ ...k1, kid: "k1" }]);
  let now = 1_000_000;
  const p = new JwksKeyProvider(source(s.port, { cacheTtlMs: 60_000, cooldownMs: 5000, maxStaleMs: 600_000 }), { resolver: local, now: () => now });
  await p.init();
  const header = (kid: string) => ({ alg: "ES256", kid });
  const token = { payload: "", signature: "" } as never;
  // the cache expired: 25 simultaneous verifications cause one request
  now += 61_000;
  const before = s.hits();
  await Promise.all(Array.from({ length: 25 }, () => p.getKey(header("k1"), token)));
  assert.equal(s.hits() - before, 1);
  // outage after the cache expired again: the previous keys keep serving (bounded by maxStale), nothing is accepted unverified
  now += 61_000; s.state.fail = 1_000_000;
  assert.ok(await p.getKey(header("k1"), token));
  await assert.rejects(Promise.resolve().then(() => p.getKey(header("unknown"), token)), "an unknown key is never accepted");
  // recovery: the provider answers again and the rotated key set is loaded on the next expiry
  s.state.fail = 0; s.state.keys = [{ ...k1, kid: "k1" }, { ...k2, kid: "k2" }];
  now += 61_000;
  assert.ok(await p.getKey(header("k2"), token), "the new key is known after the refresh");
  assert.deepEqual(p.describe()["keys"], ["k1", "k2"]);
  // beyond maxStale with the provider down: verification is unavailable, not permissive
  now += 700_000; s.state.fail = 1_000_000;
  await assert.rejects(Promise.resolve().then(() => p.getKey(header("k1"), token)), /signing keys are unavailable/);
});

test("IDP-01: a private identity provider must be approved by its exact host:port; the approval opens nothing else", async () => {
  // which addresses an approval can ever cover
  for (const a of ["10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.10", "fd12:3456::1"]) assert.equal(isPrivateNetworkAddress(a), true, a);
  for (const a of ["127.0.0.1", "::1", "169.254.169.254", "100.64.0.1", "172.32.0.1", "0.0.0.0", "224.0.0.1", "fe80::1", "::ffff:10.0.0.1", "8.8.8.8"]) assert.equal(isPrivateNetworkAddress(a), false, a);
  for (const a of ["127.0.0.1", "169.254.169.254", "100.64.0.1", "fe80::1", "0.0.0.0"]) assert.equal(isBlockedAddress(a, false, true), true, `${a} stays blocked for an approved private provider`);
  assert.equal(isBlockedAddress("10.0.0.5", false, true), false);
  assert.equal(isBlockedAddress("10.0.0.5", false, false), true);

  const load = (env: Record<string, string>) => { try { const c = loadSecurityConfig({ projectDir: dir, env: { PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_ALGORITHMS: "ES256", ...env }, environment: "production" }); return c.authentication.key; } catch (e) { return (e as SecurityConfigError).issues.map((i) => i.code).join(","); } };
  const base = { PSO_JWT_ISSUER: "https://idp:8443", PSO_JWT_JWKS_URI: "https://idp:8443/.well-known/jwks.json", PSO_JWT_JWKS_CA_FILE: caFile };
  const plain = load(base) as JwksSource;
  assert.equal(plain.privateAllowed, false, "nothing is approved by default");
  const approved = load({ ...base, PSO_JWT_JWKS_PRIVATE_HOSTS: "idp:8443" }) as JwksSource;
  assert.deepEqual([approved.privateAllowed, approved.caFile], [true, caFile]);
  assert.equal((load({ ...base, PSO_JWT_JWKS_PRIVATE_HOSTS: "idp:9443" }) as JwksSource).privateAllowed, false, "another port is not approved");
  assert.equal((load({ ...base, PSO_JWT_JWKS_PRIVATE_HOSTS: "other-idp:8443" }) as JwksSource).privateAllowed, false, "another host is not approved");
  for (const bad of ["*", "*:8443", "idp", "https://idp:8443", "idp:8443/jwks", "10.0.0.0/8"]) assert.match(String(load({ ...base, PSO_JWT_JWKS_PRIVATE_HOSTS: bad })), /PSO_SEC_JWKS_PRIVATE_HOST/, bad);
  // an address literal follows the same rule
  assert.match(String(load({ PSO_JWT_ISSUER: "https://10.1.2.3:8443", PSO_JWT_JWKS_URI: "https://10.1.2.3:8443/jwks" })), /PSO_SEC_JWKS_HOST/);
  assert.equal((load({ PSO_JWT_ISSUER: "https://10.1.2.3:8443", PSO_JWT_JWKS_URI: "https://10.1.2.3:8443/jwks", PSO_JWT_JWKS_PRIVATE_HOSTS: "10.1.2.3:8443" }) as JwksSource).privateAllowed, true);
  assert.match(String(load({ PSO_JWT_ISSUER: "https://169.254.169.254", PSO_JWT_JWKS_URI: "https://169.254.169.254/jwks", PSO_JWT_JWKS_PRIVATE_HOSTS: "169.254.169.254:443" })), /PSO_SEC_JWKS_HOST/, "the metadata address cannot be approved");
  // the approval does not replace the other rules: https only, the JWKS host is still bound to the issuer
  assert.match(String(load({ ...base, PSO_JWT_JWKS_URI: "http://idp:8443/jwks", PSO_JWT_JWKS_PRIVATE_HOSTS: "idp:8443" })), /PSO_SEC_JWKS_INSECURE/);
  assert.match(String(load({ ...base, PSO_JWT_ISSUER: "https://login.example.com", PSO_JWT_JWKS_PRIVATE_HOSTS: "idp:8443" })), /PSO_SEC_JWKS_HOST/);
  // the certificate authority file must be a certificate, never a key
  const keyFile = join(dir, "ca.key"); writeFileSync(keyFile, ca.certPem + ca.keyPem);
  assert.match(String(load({ ...base, PSO_JWT_JWKS_CA_FILE: keyFile })), /PSO_SEC_JWKS_CA/);
  assert.match(String(load({ ...base, PSO_JWT_JWKS_CA_FILE: join(dir, "missing.crt") })), /PSO_SEC_JWKS_CA/);
  assert.match(String(load({ ...base, PSO_JWT_JWKS_INIT_DEADLINE_MS: "soon" })), /PSO_SEC_NUMBER/);
  assert.equal((load({ ...base, PSO_JWT_JWKS_INIT_DEADLINE_MS: "45000", PSO_JWT_JWKS_CONNECT_TIMEOUT_MS: "1500" }) as JwksSource).initDeadlineMs, 45_000);
});

test("IDP-01: DNS answers are validated on every fetch: a private address is reached only for the approved provider, and never a loopback, link-local or metadata address", async () => {
  const s = await idp();
  const code = async (o: Partial<JwksSource>, addrs: Array<{ address: string; family: number }>) => (await failure(fetchJwks(source(s.port, { loopbackAllowed: false, connectTimeoutMs: 300, timeoutMs: 600, ...o }), { resolver: async () => addrs }))).code;
  // not approved: a private answer is refused before any connection
  assert.equal(await code({}, [{ address: "10.255.255.1", family: 4 }]), "jwks_blocked_address");
  // approved: the private address passes the address check (the connection then fails here because nothing listens there)
  assert.match(String(await code({ privateAllowed: true }, [{ address: "10.255.255.1", family: 4 }])), /^jwks_(connect_timeout|network|timeout)$/);
  // approved, but the name now answers with an address outside the private ranges it was approved for (rebinding): refused
  for (const evil of ["127.0.0.1", "169.254.169.254", "100.64.0.9", "::1", "fe80::1"]) assert.equal(await code({ privateAllowed: true }, [{ address: evil, family: evil.includes(":") ? 6 : 4 }]), "jwks_blocked_address", evil);
  assert.equal(await code({ privateAllowed: true }, [{ address: "10.255.255.1", family: 4 }, { address: "169.254.169.254", family: 4 }]), "jwks_blocked_address", "one blocked answer rejects the whole answer");
  assert.equal(s.hits(), 0, "the identity provider on loopback was never contacted through these answers");
});
