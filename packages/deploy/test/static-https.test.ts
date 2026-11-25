import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFeiManifest, stageFei, writeRuntimeConfig } from "@pso/frontend/node";
import type { FeiDefinition } from "@pso/frontend";

/**
 * HTTPS with a REAL nginx and a certificate chain that a client verifies strictly: a private CA and a leaf for `shop.test` are created with
 * openssl on the host, the container's nginx serves the shell through the managed adapter, and the client trusts ONLY that CA (no
 * rejectUnauthorized=false anywhere). Skipped when Docker, the image or openssl is missing.
 */
const IMAGE = "pso-e2e-target:1";
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 120_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const dir0 = mkdtempSync(join(tmpdir(), "pso-https-"));
const emptyCnf = join(dir0, "empty.cnf"); writeFileSync(emptyCnf, "");
const openssl = (cwd: string, ...a: string[]) => spawnSync("openssl", a, { cwd, encoding: "utf8", env: { ...process.env, OPENSSL_CONF: emptyCnf } });
const have = process.env["PSO_E2E_DOCKER"] !== "0" && docker("image", "inspect", IMAGE).status === 0 && openssl(dir0, "version").status === 0;

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const fixture = resolve(import.meta.dirname, "fixtures", "static-site");
const norm = (p: string): string => p.replaceAll("\\", "/");
const feiDef: FeiDefinition = { name: "fei-shop", orchestrator: { service: "gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const name = `pso-https-${process.pid}`;
after(() => { docker("rm", "-f", name); });

function certificates(): string {
  const d = mkdtempSync(join(tmpdir(), "pso-https-certs-"));
  const run = (...a: string[]) => { const r = openssl(d, ...a); assert.equal(r.status, 0, `openssl ${a[0]}: ${r.stderr}`); };
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=PSO test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=shop.test");
  writeFileSync(join(d, "ext.cnf"), "subjectAltName=DNS:shop.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "ext.cnf");
  return d;
}

interface Res { status: number; headers: Record<string, string>; body: string }
const flat = (h: Record<string, string | string[] | undefined>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
function https(port: number, path: string, o: { ca?: Buffer; minVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2"; maxVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3" } = {}): Promise<Res> {
  return new Promise((res, rej) => {
    const r = httpsRequest({ host: "127.0.0.1", port, path, servername: "shop.test", agent: false, headers: { host: "shop.test", connection: "close" }, timeout: 10_000, ...(o.ca ? { ca: o.ca } : {}), ...(o.minVersion ? { minVersion: o.minVersion } : {}), ...(o.maxVersion ? { maxVersion: o.maxVersion } : {}) }, (x) => { const c: Buffer[] = []; x.on("data", (b: Buffer) => c.push(b)); x.on("end", () => res({ status: x.statusCode ?? 0, headers: flat(x.headers), body: Buffer.concat(c).toString("utf8") })); });
    r.on("error", rej); r.on("timeout", () => r.destroy(new Error("timeout"))); r.end();
  });
}
function http(port: number, path: string, host = "shop.test"): Promise<Res> {
  return new Promise((res, rej) => { const r = httpRequest({ host: "127.0.0.1", port, path, agent: false, headers: { host, connection: "close" }, timeout: 10_000 }, (x) => { const c: Buffer[] = []; x.on("data", (b: Buffer) => c.push(b)); x.on("end", () => res({ status: x.statusCode ?? 0, headers: flat(x.headers), body: Buffer.concat(c).toString("utf8") })); }); r.on("error", rej); r.end(); });
}
const port = (p: string): number => Number(/:(\d+)\s*$/m.exec(docker("port", name, p).stdout)![1]);

test("real nginx over TLS: a strictly verified certificate chain, HTTP redirects to HTTPS, HSTS and the security headers, routes and missing files behave, old protocols and untrusted clients are refused", { skip: have ? false : "Docker, the pso-e2e-target:1 image or openssl is not available", timeout: 240_000 }, async () => {
  const certs = certificates(); const ca = readFileSync(join(certs, "ca.pem"));
  const site = mkdtempSync(join(tmpdir(), "pso-https-site-"));
  const proj = mkdtempSync(join(tmpdir(), "pso-https-proj-"));
  for (const [n, v] of Object.entries({ react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" })) { mkdirSync(join(proj, "node_modules", n), { recursive: true }); writeFileSync(join(proj, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v })); }
  mkdirSync(join(proj, "dist", "assets"), { recursive: true });
  writeFileSync(join(proj, "dist", "index.html"), `<!doctype html><html><body><script src="/shop/assets/main-1.0.0.js"></script>shell 1.0.0</body></html>`);
  writeFileSync(join(proj, "dist", "assets", "main-1.0.0.js"), "console.log('shell');\n".repeat(100));
  buildFeiManifest({ dir: proj, definition: feiDef, version: "1.0.0", basePath: "/shop/" });
  stageFei(site, join(proj, "dist"));
  writeRuntimeConfig({ site, fei: "fei-shop", auth: { kind: "none" }, orchestratorBasePath: "/api", channelsPath: "/channels", meis: ["mei-customers"] });

  const run = docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080", "-p", "127.0.0.1::8443", "-p", "127.0.0.1::8081", "-v", `${norm(site)}:/site`, "-v", `${norm(certs)}:/certs:ro`, "-v", `${norm(join(pkgRoot, "frontend"))}:/app/node_modules/@pso/frontend:ro`, "-v", `${norm(join(pkgRoot, "deploy"))}:/app/deploy:ro`, "-v", `${norm(fixture)}:/fixture:ro`, "--entrypoint", "sh", IMAGE, "/fixture/boot.sh");
  assert.equal(run.status, 0, run.stderr);
  for (let i = 0; i < 60 && !docker("logs", name).stdout.includes("boot done"); i++) await sleep(500);
  const a = docker("exec", name, "node", "/fixture/apply-tls.mjs", "r1", "1.0.0");
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.deepEqual(JSON.parse(a.stdout.trim().split("\n").pop()!), { changed: true, reloaded: true, error: null, restored: false });
  const tls = port("8443"), plain = port("8080"), probe = port("8081");
  await sleep(1500); // the graceful reload starts its workers asynchronously

  // the shell over verified TLS
  const index = await https(tls, "/shop/", { ca });
  assert.equal(index.status, 200); assert.match(index.body, /shell 1\.0\.0/);
  assert.match(index.headers["strict-transport-security"]!, /max-age=\d+/); assert.match(index.headers["content-security-policy"]!, /script-src 'self'/); assert.equal(index.headers["x-content-type-options"], "nosniff");
  assert.equal((await https(tls, "/shop/customers/42", { ca })).status, 200);
  assert.equal((await https(tls, "/shop/catalog/sku/acme.json", { ca })).status, 200, "a declared dotted route is the application");
  assert.equal((await https(tls, "/shop/customers/acme.corp", { ca })).status, 200, "a dotted identifier is the application");
  for (const p of ["/shop/nope.js", "/shop/assets/nope.js", "/shop/customers/acme.json"]) assert.equal((await https(tls, p, { ca })).status, 404, p);
  const asset = await https(tls, "/shop/assets/main-1.0.0.js", { ca }); assert.equal(asset.status, 200); assert.match(asset.headers["cache-control"]!, /immutable/);

  // plain HTTP only redirects, keeping the path; the plain loopback probe listener serves without HSTS (it exists for PSO's own verification)
  const redirect = await http(plain, "/shop/customers/42?x=1");
  assert.equal(redirect.status, 301); assert.equal(redirect.headers["location"], "https://shop.test/shop/customers/42?x=1");
  const viaProbe = await http(probe, "/shop/"); assert.equal(viaProbe.status, 200); assert.ok(!("strict-transport-security" in viaProbe.headers));

  // strictness: a client that does not trust the CA is refused, and so are TLS 1.0 and 1.1
  await assert.rejects(https(tls, "/shop/"), /unable to verify|self.signed|UNABLE_TO_VERIFY|certificate/i, "an untrusted chain must fail");
  await assert.rejects(https(tls, "/shop/", { ca, minVersion: "TLSv1", maxVersion: "TLSv1.1" }), /protocol|alert|version|EPROTO|ECONNRESET/i, "TLS 1.1 must be refused");
});
