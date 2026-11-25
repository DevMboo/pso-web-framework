#!/usr/bin/env node
// Real requests against the running reference stack (pso docker:up --env local): public vs protected endpoints, permissions, the
// same-origin API path of a shell, mutual TLS enforced by the accounts service, real Keycloak tokens. Writes an evidence file.
// Usage: node scripts/reference/validate-backend.mjs [workspace] [evidence.json]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { plan, netRequest, developmentUserToken, environmentCa, localResolution, readFrontends } = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const root = resolve(process.argv[2] ?? join(here, "..", "..", "fixtures", "pso-reference"));
const out = resolve(process.argv[3] ?? join(here, "..", "..", "docs", "implementation", "evidence", "v020", "backend.json"));
const p = plan(root, "local", { frontends: readFrontends });
const t = p.topology;
const ca = environmentCa(root, t), map = localResolution(t);
const results = [];
const req = async (name, url, o = {}, expect) => {
  let r, error;
  try { r = await netRequest({ url, ca, resolve: map, timeoutMs: 20_000, ...o }); } catch (e) { error = e.message; }
  const ok = expect(r, error);
  results.push({ name, url, method: o.method ?? "GET", status: r?.status ?? null, timeMs: r?.timeMs ?? null, ok, ...(error ? { error } : {}), ...(r && !ok ? { body: r.body.toString("utf8").slice(0, 300) } : {}) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(64)} ${r ? `HTTP ${r.status}` : error}`);
};
const ana = (await developmentUserToken(root, t, "ana")).accessToken, bob = (await developmentUserToken(root, t, "bob")).accessToken;
const claims = (tok) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
console.log(`tokens: ana scp=${claims(ana).scp?.join(",")}  bob scp=${claims(bob).scp?.join(",")}  iss=${claims(ana).iss}  aud=${[].concat(claims(ana).aud).join(",")}`);
const api = t.api.origin, shop = t.frontends.find((f) => f.name === "fei-shop");
const json = (b) => ({ method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(b)) }, body: b });
await req("public endpoint without a token (GET /catalog/products)", `${api}/catalog/products`, {}, (r) => r?.status === 200);
await req("same public endpoint through the shop's same-origin path", `${shop.origin}/api/catalog/products`, {}, (r) => r?.status === 200);
await req("protected endpoint without a token is refused (POST /catalog/cart-items)", `${api}/catalog/cart-items`, json("{}"), (r) => r?.status === 401);
await req("protected endpoint with bob (cart:write)", `${api}/catalog/cart-items`, { ...json(JSON.stringify({ id: "c-1", name: "Coffee" })), headers: { ...json("{}").headers, "content-length": String(Buffer.byteLength(JSON.stringify({ id: "c-1", name: "Coffee" }))), authorization: `Bearer ${bob}` } }, (r) => r?.status === 200 && JSON.parse(r.body.toString()).name === "Coffee");
await req("permission-protected endpoint with bob (no users:admin) is refused", `${api}/accounts/users`, { headers: { authorization: `Bearer ${bob}` } }, (r) => r?.status === 403);
await req("permission-protected endpoint with ana (users:admin) over mutual TLS", `${api}/accounts/users`, { headers: { authorization: `Bearer ${ana}` } }, (r) => r?.status === 200);
await req("a forged token is refused", `${api}/accounts/users`, { headers: { authorization: `Bearer ${ana.slice(0, -4)}AAAA` } }, (r) => r?.status === 401);
await req("frontend public routes do not open backend endpoints (shop origin, no token)", `${shop.origin}/api/accounts/users`, {}, (r) => r?.status === 401);
// mutual TLS: a client on the services' network WITHOUT a client certificate cannot even complete the handshake with accounts
const net = `${t.project}_internal`;
const noCert = spawnSync("docker", ["run", "--rm", "--network", net, "-v", `${join(root, ".infra", "ca", "local")}:/ca:ro`, "curlimages/curl:latest", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", "/ca/ca.crt", "https://accounts:8082/actuator/health"], { encoding: "utf8", timeout: 60_000 });
const mtlsOk = noCert.status !== 0 && /alert|handshake|certificate|SSL/i.test(noCert.stderr);
results.push({ name: "accounts refuses a TLS client without a certificate (mutual TLS)", ok: mtlsOk, detail: noCert.stderr.trim().split("\n").pop() });
console.log(`${mtlsOk ? "ok  " : "FAIL"} ${"accounts refuses a TLS client without a certificate (mutual TLS)".padEnd(64)} ${noCert.stderr.trim().split("\n").pop()}`);
const plainCatalog = spawnSync("docker", ["run", "--rm", "--network", net, "curlimages/curl:latest", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://catalog:8081/actuator/health"], { encoding: "utf8", timeout: 60_000 });
const tlsOnly = plainCatalog.stdout.trim() !== "200";
results.push({ name: "catalog does not answer plain HTTP on its port", ok: tlsOnly, detail: `${plainCatalog.stdout.trim()} ${plainCatalog.stderr.trim().split("\n").pop() ?? ""}` });
console.log(`${tlsOnly ? "ok  " : "FAIL"} ${"catalog does not answer plain HTTP on its port".padEnd(64)} HTTP ${plainCatalog.stdout.trim() || "-"}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), environment: t.env, api, results }, null, 2) + "\n");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed; evidence ${out}`);
process.exit(failed ? 1 : 0);
