import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttps, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { loadUpstreamPolicy, mayForwardBearer, isLoopbackHost, TlsMaterial } from "@pso/http";
import { newCa, issue, type Ca, type Leaf } from "./pki.ts";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";

const dirs: string[] = [];
const gateways: Gw[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); for (const g of gateways) g.dispose(); });

let dir = "";
let caA: Ca, caB: Ca;
let serverOk: Leaf, serverWrongName: Leaf, serverExpired: Leaf, serverFromOtherCa: Leaf, serverNamed: Leaf;
let clientOk: Leaf, clientFromOtherCa: Leaf;
const file = (name: string, content: string): string => { const p = join(dir, name); writeFileSync(p, content); return p; };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pso-mtls-")); dirs.push(dir); mkdirSync(dir, { recursive: true });
  caA = await newCa("PSO test CA A");
  caB = await newCa("Some other CA B");
  serverOk = await issue(caA, { cn: "users", dns: ["users.internal"], ips: ["127.0.0.1"], usage: "server" });
  serverNamed = await issue(caA, { cn: "users", dns: ["users.internal"], usage: "server" }); // no IP SAN: valid only for the name users.internal
  serverWrongName = await issue(caA, { cn: "other", dns: ["other.internal"], usage: "server" });
  serverExpired = await issue(caA, { cn: "users", dns: ["users.internal"], ips: ["127.0.0.1"], usage: "server", notBefore: new Date(Date.now() - 7200_000), notAfter: new Date(Date.now() - 3600_000) });
  serverFromOtherCa = await issue(caB, { cn: "users", dns: ["users.internal"], ips: ["127.0.0.1"], usage: "server" });
  clientOk = await issue(caA, { cn: "pso-gateway", usage: "client" });
  clientFromOtherCa = await issue(caB, { cn: "intruder", usage: "client" });
});

interface Seen { path: string; authorization: string | undefined; peerCn: string | undefined }
interface TlsUpstream { port: number; seen: Seen[]; close(): Promise<void> }

async function tlsUpstream(leaf: Leaf, o: { requireClientCert?: boolean; redirect?: boolean } = {}): Promise<TlsUpstream> {
  const seen: Seen[] = [];
  const server: Server = createHttps({ key: leaf.keyPem, cert: leaf.certPem, ...(o.requireClientCert ? { requestCert: true, rejectUnauthorized: true, ca: caA.pem } : {}), minVersion: "TLSv1.2" }, (req, res) => {
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    seen.push({ path: req.url ?? "", authorization: req.headers["authorization"] as string | undefined, peerCn: peer && "subject" in peer ? (peer.subject as { CN?: string } | undefined)?.CN : undefined });
    if (o.redirect) { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
  });
  server.on("tlsClientError", () => undefined); // handshake refusals are expected in these tests
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const gw = async (): Promise<Gw> => { const g = await buildGateway("pso-mtls-gw-"); gateways.push(g); return g; };
const ping = (x: { url(p: string): string }) => fetch(x.url("/customers/ping"));

test("server identity: a certificate is accepted only when it chains to the trusted CA, is current and names the expected service", { timeout: 300_000 }, async () => {
  const g = await gw();
  const ca = file("caA.pem", caA.pem);
  const run = async (leaf: Leaf, env: Record<string, string>, expect: number | "tls") => {
    const up = await tlsUpstream(leaf);
    const x = await g.start({ RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}`, ...env });
    try {
      const r = await ping(x);
      if (expect === "tls") { await expectProblem(r, 502, "PSO_UPSTREAM_TLS"); assert.equal(up.seen.length, 0, "no application data reached an unverified server"); }
      else { assert.equal(r.status, expect); assert.equal(up.seen.length, 1); }
    } finally { x.child.kill("SIGKILL"); await up.close(); }
  };
  await run(serverOk, { PSO_UPSTREAM_USERS_TLS_CA_FILE: ca }, 200);                                    // valid chain, valid identity (IP SAN)
  await run(serverFromOtherCa, { PSO_UPSTREAM_USERS_TLS_CA_FILE: ca }, "tls");                          // untrusted CA
  await run(serverExpired, { PSO_UPSTREAM_USERS_TLS_CA_FILE: ca }, "tls");                              // expired
  await run(serverWrongName, { PSO_UPSTREAM_USERS_TLS_CA_FILE: ca }, "tls");                            // names another service
  await run(serverOk, { PSO_UPSTREAM_USERS_TLS: "true" }, "tls");                                       // TLS on, but the private CA is not in the default trust store
  await run(serverNamed, { PSO_UPSTREAM_USERS_TLS_CA_FILE: ca }, "tls");                                // no IP SAN: connecting by IP does not match
  await run(serverNamed, { PSO_UPSTREAM_USERS_TLS_CA_FILE: ca, PSO_UPSTREAM_USERS_TLS_SERVER_NAME: "users.internal" }, 200); // the expected service identity is configured explicitly
  await run(serverNamed, { PSO_UPSTREAM_USERS_TLS_CA_FILE: ca, PSO_UPSTREAM_USERS_TLS_SERVER_NAME: "other.internal" }, "tls"); // ... and a different identity is refused
});

test("mutual TLS: the upstream authenticates the gateway by its client certificate; wrong or missing certificates never reach the application", { timeout: 300_000 }, async () => {
  const g = await gw();
  const ca = file("caA2.pem", caA.pem);
  const up = await tlsUpstream(serverOk, { requireClientCert: true });
  try {
    const base = { RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}`, PSO_UPSTREAM_USERS_TLS_CA_FILE: ca };
    const noCert = await g.start(base);
    try { const r = await ping(noCert); assert.equal(r.status, 502, "no client certificate"); } finally { noCert.child.kill("SIGKILL"); }
    const wrong = await g.start({ ...base, PSO_UPSTREAM_USERS_TLS_CERT_FILE: file("bad.crt", clientFromOtherCa.certPem), PSO_UPSTREAM_USERS_TLS_KEY_FILE: file("bad.key", clientFromOtherCa.keyPem) });
    try { const r = await ping(wrong); assert.equal(r.status, 502, "client certificate from an untrusted CA"); } finally { wrong.child.kill("SIGKILL"); }
    assert.equal(up.seen.length, 0, "neither attempt reached the application");
    const good = await g.start({ ...base, PSO_UPSTREAM_USERS_TLS_CERT_FILE: file("ok.crt", clientOk.certPem), PSO_UPSTREAM_USERS_TLS_KEY_FILE: file("ok.key", clientOk.keyPem) });
    try {
      assert.equal((await ping(good)).status, 200);
      assert.equal(up.seen.length, 1);
      assert.equal(up.seen[0]!.peerCn, "pso-gateway", "the upstream saw the gateway's SERVICE identity");
      assert.ok(!good.logs().includes("PRIVATE KEY"), "key material is never logged");
    } finally { good.child.kill("SIGKILL"); }
  } finally { await up.close(); }
});

test("certificate rotation: replaced files are used without a restart, and a broken replacement keeps the last good material", { timeout: 300_000 }, async () => {
  const g = await gw();
  const up = await tlsUpstream(serverOk, { requireClientCert: true });
  const crt = file("rot.crt", clientFromOtherCa.certPem), key = file("rot.key", clientFromOtherCa.keyPem);
  const x = await g.start({ RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}`, PSO_UPSTREAM_USERS_TLS_CA_FILE: file("caA3.pem", caA.pem), PSO_UPSTREAM_USERS_TLS_CERT_FILE: crt, PSO_UPSTREAM_USERS_TLS_KEY_FILE: key });
  try {
    assert.equal((await ping(x)).status, 502, "the initial certificate is not accepted by the upstream");
    writeFileSync(crt, clientOk.certPem); writeFileSync(key, clientOk.keyPem); // the platform rotates the files
    let status = 0;
    for (let i = 0; i < 40 && status !== 200; i++) { await new Promise((r) => setTimeout(r, 250)); status = (await ping(x)).status; }
    assert.equal(status, 200, "the rotated certificate is used without restarting the orchestrator");
    writeFileSync(crt, "-----BEGIN CERTIFICATE-----\ngarbage\n-----END CERTIFICATE-----\n"); // a half-written / corrupt replacement
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal((await ping(x)).status, 200, "a bad replacement does not take communication down");
  } finally { x.child.kill("SIGKILL"); await up.close(); }
});

test("credential forwarding: the user's token goes only where policy, transport and audience allow", { timeout: 300_000 }, async () => {
  const g = await gw();
  const up = await tlsUpstream(serverOk);
  const base = { RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}`, PSO_UPSTREAM_USERS_TLS_CA_FILE: file("caA4.pem", caA.pem) };
  const forwarded = async (env: Record<string, string>): Promise<string | undefined> => {
    const x = await g.start({ ...base, ...env });
    try { up.seen.length = 0; const r = await fetch(x.url("/customers"), { headers: x.auth }); assert.equal(r.status, 200); return up.seen[0]?.authorization; }
    finally { x.child.kill("SIGKILL"); }
  };
  try {
    assert.match((await forwarded({})) ?? "", /^Bearer /, "default: the guarded route forwards the user's token over TLS");
    assert.equal(await forwarded({ PSO_UPSTREAM_USERS_FORWARD: "none" }), undefined, "an upstream that opts out never receives it");
    assert.equal(await forwarded({ PSO_UPSTREAM_USERS_AUDIENCE: "billing-api" }), undefined, "audience-aware: the caller's token does not name this upstream's audience");
    assert.match((await forwarded({ PSO_UPSTREAM_USERS_AUDIENCE: "pso-api" })) ?? "", /^Bearer /, "audience-aware: forwarded when the token names it");
    const x = await g.start(base);
    try { up.seen.length = 0; await fetch(x.url("/customers/ping"), { headers: x.auth }); assert.equal(up.seen[0]?.authorization, undefined, "a public route never carries credentials upstream"); } finally { x.child.kill("SIGKILL"); }
  } finally { await up.close(); }
});

test("redirects from an upstream are never followed by the gateway", { timeout: 200_000 }, async () => {
  const g = await gw();
  const up = await tlsUpstream(serverOk, { redirect: true });
  const x = await g.start({ RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}`, PSO_UPSTREAM_USERS_TLS_CA_FILE: file("caA5.pem", caA.pem) });
  try {
    const r = await fetch(x.url("/customers/ping"), { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(up.seen.length, 1, "exactly one request: the redirect was not followed");
  } finally { x.child.kill("SIGKILL"); await up.close(); }
});

test("start-up refuses unsafe or broken upstream security configuration without leaking secrets", { timeout: 300_000 }, async () => {
  const g = await gw();
  const base = { RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: "127.0.0.1:9" };
  await assert.rejects(g.start({ ...base, PSO_UPSTREAM_USERS_TLS_CA_FILE: join(dir, "missing.pem") }), /TLS file not found/);
  await assert.rejects(g.start({ ...base, PSO_UPSTREAM_USERS_TLS_CERT_FILE: file("only.crt", clientOk.certPem) }), /must be set together/);
  const mismatch = file("mismatch.key", clientFromOtherCa.keyPem);
  await assert.rejects(g.start({ ...base, PSO_UPSTREAM_USERS_TLS_CERT_FILE: file("m.crt", clientOk.certPem), PSO_UPSTREAM_USERS_TLS_KEY_FILE: mismatch }), /TLS material is invalid/);
  await assert.rejects(g.start({ ...base, PSO_UPSTREAM_USERS_FORWARD: "everyone" }), /forward must be/);
  await assert.rejects(g.start({ RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_REMOTE: "10.0.0.5:8080", PSO_ENV: "production" }), /production requires TLS/);
  const ok = await g.start({ RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_REMOTE: "10.0.0.5:8080", PSO_ENV: "production", PSO_UPSTREAM_REMOTE_ALLOW_PLAINTEXT: "true" }).catch((e: Error) => e);
  if (!(ok instanceof Error)) ok.child.kill("SIGKILL"); // explicitly accepted plaintext starts (the risk is the operator's, and the token is still never sent in clear text between hosts)
  assert.ok(!(ok instanceof Error) || !/production requires TLS/.test(ok.message), "an explicit allowPlaintext is honoured");
  g.config({ http: { upstreams: { users: { tls: { keyPassphrase: "hunter2" } } } } });
  await assert.rejects(g.start(base), (e: Error) => /must not be written in pso.config.json/.test(e.message) && !e.message.includes("hunter2"));
});

test("policy units: loopback detection, plaintext never carries a token between hosts, explicit policy wins over the global default", () => {
  for (const h of ["127.0.0.1", "127.9.9.9", "::1", "[::1]", "localhost"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["10.0.0.5", "users.internal", "128.0.0.1", "0.0.0.0"]) assert.equal(isLoopbackHost(h), false, h);
  const policy = { forward: "inherit" as const, allowPlaintext: false };
  const call = (o: Partial<Parameters<typeof mayForwardBearer>[0]>) => mayForwardBearer({ routePublic: false, global: "bearer", policy, tls: false, host: "127.0.0.1", principalAudiences: ["pso-api"], ...o });
  assert.equal(call({}).forward, true);
  assert.equal(call({ host: "10.0.0.5" }).forward, false, "plaintext to another host");
  assert.equal(call({ host: "10.0.0.5", tls: true }).forward, true);
  assert.equal(call({ routePublic: true }).forward, false);
  assert.equal(call({ global: "none" }).forward, false);
  assert.equal(call({ global: "none", policy: { ...policy, forward: "bearer" } }).forward, true, "an explicit per-upstream policy overrides the global one");
  assert.equal(call({ policy: { ...policy, audience: "x" } }).forward, false);
  const problems: string[] = [];
  const p = loadUpstreamPolicy("users-service", { PSO_UPSTREAM_USERS_SERVICE_TLS_SERVER_NAME: "users.internal", PSO_UPSTREAM_USERS_SERVICE_FORWARD: "none" }, undefined, problems);
  assert.deepEqual([p.tls?.serverName, p.forward, problems.length], ["users.internal", "none", 0]);
  void TlsMaterial;
});
