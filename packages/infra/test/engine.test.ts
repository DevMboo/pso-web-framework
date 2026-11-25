import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply, plan, validate, validateContract, resolveTopology, loadContract, renderCompose, exposure, applyHostsBlock, hostsMarker, renderHosts,
  processEnvironment, withLock, InfraError, dependenciesOf, startupOrder, type FrontendInfo, type EngineHooks,
} from "../src/index.ts";

const fei = (name: string, port: number, extra: Partial<FrontendInfo> = {}): FrontendInfo => ({ name, port, authentication: "jwt", microfrontends: [], scopes: [], orchestratorBasePath: "/api", routes: [], ...extra });
function workspace(o: { infra?: unknown; frontends?: FrontendInfo[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pso-infra-"));
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "shop", services: [
    { name: "gateway", path: "gateway", runtime: "node", role: "orchestrator", port: 3000, health: "/health/ready" },
    { name: "catalog", path: "catalog", runtime: "spring-boot", role: "service", port: 8081, db: "postgres", prefix: "/catalog" },
    { name: "accounts", path: "accounts", runtime: "spring-boot", role: "service", port: 8082, prefix: "/accounts", dependsOn: ["catalog"] },
  ] }, null, 2));
  for (const d of ["gateway", "catalog", "accounts"]) mkdirSync(join(root, d));
  if (o.infra !== undefined) writeFileSync(join(root, "pso.infra.json"), JSON.stringify(o.infra, null, 2));
  let fes = o.frontends ?? [fei("fei-shop", 4200, { microfrontends: ["mei-catalog"], scopes: ["cart:write"] }), fei("fei-admin", 4300, { scopes: ["users:admin"] })];
  const hooks: EngineHooks = { frontends: () => ({ frontends: fes, scopes: [...new Set(fes.flatMap((f) => f.scopes))] }) };
  return { root, hooks, setFrontends: (x: FrontendInfo[]) => { fes = x; } };
}
const LOCAL = { schemaVersion: 1, defaultEnvironment: "local", environments: { local: { kind: "development", domain: "pso.localhost", runtime: "docker", httpsPort: 8443 } }, identity: { provider: "keycloak", realm: "shop", users: [{ username: "ana", scopes: ["cart:write", "users:admin"] }] }, services: { accounts: { mtls: true } } };
const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split("/")), "utf8");
const fp = (p: ReturnType<typeof plan>, id: string) => p.resources.find((r) => r.id === id)?.facts["fingerprint"];

test("a clean workspace is provisioned completely, and a second run changes nothing (idempotent)", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  const before = plan(root, undefined, hooks);
  assert.ok(before.summary.changes > 15, `expected many changes, got ${before.summary.changes}`);
  assert.equal(before.resources.find((r) => r.id === "ca")!.action, "create");
  const r1 = apply(root, { hooks });
  assert.equal(r1.applied.filter((a) => a.result === "refused").length, 0, JSON.stringify(r1.applied.filter((a) => a.result !== "done")));
  assert.equal(r1.plan.summary.changes, 0, JSON.stringify(r1.plan.resources.filter((r) => r.action !== "none").map((r) => [r.id, r.status, r.reasons])));
  for (const f of [".infra/ca/local/ca.crt", ".infra/certs/local/edge/tls.crt", ".infra/certs/local/accounts/tls.key", ".infra/certs/local/gateway-client/tls.crt", ".infra/identity/local/realm.json", ".infra/nginx/local/edge.conf", ".infra/nginx/local/fei-shop.conf", ".infra/docker/local/compose.yml", ".infra/sites/local/fei-admin/pso-runtime-config.json", ".infra/secrets/local/db-catalog", ".infra/secrets/local/user-ana"]) assert.ok(existsSync(join(root, ...f.split("/"))), f);
  const caFp = fp(r1.plan, "ca"), edgeFp = fp(r1.plan, "cert:edge");
  const secret = read(root, ".infra/secrets/local/db-catalog");
  const r2 = apply(root, { hooks });
  assert.deepEqual(r2.applied, [], "nothing to do on a second run");
  assert.equal(fp(r2.plan, "ca"), caFp, "the authority is reused");
  assert.equal(fp(r2.plan, "cert:edge"), edgeFp, "valid certificates are never regenerated");
  assert.equal(read(root, ".infra/secrets/local/db-catalog"), secret, "secrets are never regenerated");
  // sensitive files are readable by their owner only
  for (const f of [".infra/ca/local/ca.key", ".infra/certs/local/edge/tls.key", ".infra/secrets/local/db-catalog"]) assert.equal(exposure(join(root, ...f.split("/"))), undefined, f);
  assert.match(read(root, ".gitignore"), /^\.infra\/$/m);
});

test("a missing or damaged resource is recovered alone; everything valid is kept", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  const first = apply(root, { hooks }).plan;
  rmSync(join(root, ".infra", "certs", "local", "catalog", "tls.key"));
  writeFileSync(join(root, ".infra", "certs", "local", "edge", "tls.crt"), "garbage");
  const p = plan(root, undefined, hooks);
  assert.deepEqual(p.resources.filter((r) => r.action !== "none").map((r) => `${r.id}:${r.action}`).sort(), ["cert:catalog:replace", "cert:edge:replace"]);
  const r = apply(root, { hooks });
  assert.deepEqual(r.applied.map((a) => a.id).sort(), ["cert:catalog", "cert:edge"]);
  assert.deepEqual(r.restart, ["catalog", "edge"], "only the affected containers need a restart");
  assert.equal(fp(r.plan, "ca"), fp(first, "ca"));
  assert.equal(fp(r.plan, "cert:accounts"), fp(first, "cert:accounts"));
});

test("hand edits of generated configuration are drift: reported, kept by apply, replaced by repair with a backup", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  apply(root, { hooks });
  const f = join(root, ".infra", "nginx", "local", "edge.conf");
  writeFileSync(f, read(root, ".infra/nginx/local/edge.conf") + "\n# my tweak\n");
  assert.equal(plan(root, undefined, hooks).resources.find((r) => r.id === "nginx:edge")!.status, "drifted");
  const a = apply(root, { hooks });
  assert.equal(a.applied.find((x) => x.id === "nginx:edge")!.result, "skipped");
  assert.match(readFileSync(f, "utf8"), /my tweak/, "apply never overwrites a hand edit");
  const r = apply(root, { hooks, repair: true });
  assert.doesNotMatch(readFileSync(f, "utf8"), /my tweak/);
  assert.equal(r.backups.length, 1);
  assert.match(readFileSync(join(root, ...r.backups[0]!.split("/")), "utf8"), /my tweak/);
});

test("reconciliation: adding a FEI re-issues the edge certificate, registers an identity client and creates its site, nothing else", () => {
  const { root, hooks, setFrontends } = workspace({ infra: LOCAL });
  const first = apply(root, { hooks }).plan;
  setFrontends([fei("fei-shop", 4200, { microfrontends: ["mei-catalog"], scopes: ["cart:write"] }), fei("fei-admin", 4300, { scopes: ["users:admin"] }), fei("fei-partners", 4400)]);
  const p = plan(root, undefined, hooks);
  const changed = p.resources.filter((r) => r.action !== "none").map((r) => r.id).sort();
  assert.deepEqual(changed, ["cert:edge", "docker:compose", "hosts", "identity:realm", "nginx:edge", "nginx:fei-partners", "runtime-config:fei-partners", "site:fei-partners"]);
  const r = apply(root, { hooks });
  assert.deepEqual(r.restart, ["edge", "fei-partners", "idp"]);
  const realm = JSON.parse(read(root, ".infra/identity/local/realm.json")) as { clients: Array<{ clientId: string; redirectUris: string[] }> };
  assert.deepEqual(realm.clients.find((c) => c.clientId === "fei-partners")!.redirectUris, ["https://partners.pso.localhost:8443/auth/callback", "http://localhost:4400/auth/callback"]);
  assert.equal(fp(r.plan, "cert:gateway"), fp(first, "cert:gateway"));
  assert.notEqual(fp(r.plan, "cert:edge"), fp(first, "cert:edge"));
});

test("production: no development authority, no generated secrets, external resources are verified and never written", () => {
  assert.ok(validateContract({ schemaVersion: 1, environments: { prod: { kind: "production", domain: "shop.example.com", tls: { source: "pso-dev-ca" } } } }).some((i) => i.code === "PSO_INFRA_TLS_PRODUCTION"));
  assert.ok(validateContract({ schemaVersion: 1, environments: { prod: { kind: "production", domain: "shop.example.com", tls: { source: "external", dir: "/etc/pso/tls" }, secrets: { provider: "local" } } } }).some((i) => i.code === "PSO_INFRA_SECRETS_LOCAL"));
  assert.ok(validateContract({ schemaVersion: 1, environments: { local: { kind: "development", domain: "pso.localhost" } }, secrets: { stripe: { value: "sk_live_x" } } }).some((i) => i.code === "PSO_INFRA_SECRET_IN_CONTRACT"));
  const ext = mkdtempSync(join(tmpdir(), "pso-ext-tls-")).replace(/\\/g, "/");
  const { root, hooks } = workspace({ infra: { ...LOCAL, environments: { ...LOCAL.environments, production: { kind: "production", domain: "shop.example.com", runtime: "docker", tls: { source: "external", dir: ext }, secrets: { provider: "env" } } }, identity: { provider: "keycloak", realm: "shop" } } });
  const p = plan(root, "production", hooks);
  assert.equal(p.resources.find((r) => r.id === "ca")!.owner, "external");
  assert.equal(p.resources.find((r) => r.id === "ca")!.status, "external-unverified");
  assert.equal(p.resources.find((r) => r.id === "secret:db-catalog")!.action, "supply");
  const r = apply(root, { env: "production", hooks });
  assert.ok(!existsSync(join(root, ".infra", "ca", "production")), "no authority generated for production");
  assert.ok(!existsSync(join(root, ".infra", "secrets", "production")), "no secret generated for production");
  assert.ok(r.applied.filter((a) => a.result === "done").every((a) => !/^(ca|cert:|secret:)/.test(a.id)));
  const compose = read(root, ".infra/docker/production/compose.yml");
  assert.match(compose, new RegExp(`"${ext}/edge:/run/pso/tls:ro"`));
  assert.match(compose, /environment: "PSO_SECRET_DB_CATALOG"/);
  assert.match(compose, /"443:8443"/);
  assert.doesNotMatch(compose, /start-dev/);
});

test("an interrupted provisioning is detected and completed; partial files are removed", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  apply(root, { hooks });
  rmSync(join(root, ".infra", "certs", "local", "accounts", "tls.crt"));
  mkdirSync(join(root, ".infra", "journal"), { recursive: true });
  writeFileSync(join(root, ".infra", "journal", "x-cert_accounts.json"), JSON.stringify({ tx: "x", op: "apply", resource: "cert:accounts", files: [], startedAt: new Date().toISOString() }));
  writeFileSync(join(root, ".infra", "certs", "local", "accounts", "tls.crt.123.abcdef01.tmp"), "half");
  assert.deepEqual(plan(root, undefined, hooks).interrupted, ["cert:accounts"]);
  const r = apply(root, { hooks });
  assert.ok(r.recovered.includes("cert:accounts"));
  assert.ok(r.notes.some((n) => /interrupted/.test(n)));
  assert.ok(!existsSync(join(root, ".infra", "certs", "local", "accounts", "tls.crt.123.abcdef01.tmp")));
  assert.equal(r.plan.summary.changes, 0);
  assert.deepEqual(r.plan.interrupted, []);
});

test("one provisioning at a time: a live lock refuses, a stale one is taken over", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  mkdirSync(join(root, ".infra"), { recursive: true });
  const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  writeFileSync(join(root, ".infra", "state.lock"), JSON.stringify({ pid: Number(child.stdout.trim()), op: "apply", at: "earlier" }));
  const r = apply(root, { hooks });
  assert.ok(r.notes.some((n) => /stale lock/.test(n)));
  withLock(root, "test", () => {
    // the lock is held by this (live) process; a nested different-pid holder is simulated by rewriting it
    writeFileSync(join(root, ".infra", "state.lock"), JSON.stringify({ pid: process.ppid, op: "apply", at: "now" }));
    assert.throws(() => apply(root, { hooks }), (e: unknown) => e instanceof InfraError && e.code === "PSO_INFRA_LOCKED");
  });
});

test("host and route collisions between FEIs are refused with the responsible declaration", () => {
  const { root, hooks } = workspace({ infra: { ...LOCAL, frontends: { "fei-admin": { host: "shop" } } } });
  assert.throws(() => plan(root, undefined, hooks), /fei-shop and fei-admin are both served on shop\.pso\.localhost/);
  // a shell at "/" would swallow every other base path on its host: nested base paths are ambiguous and refused
  const nested = workspace({ infra: { ...LOCAL, frontends: { "fei-admin": { host: "shop", basePath: "/admin/" } } } });
  assert.throws(() => plan(nested.root, undefined, nested.hooks), /overlapping base paths \(\/, \/admin\/\)/);
  // distinct base paths on one host: one server block, each shell (and each of its microfrontends' release paths) routed to its own container
  const two = workspace({ infra: { ...LOCAL, frontends: { "fei-shop": { host: "portal", basePath: "/shop/" }, "fei-admin": { host: "portal", basePath: "/admin/" } } } });
  const t = plan(two.root, undefined, two.hooks).topology;
  assert.deepEqual(t.frontends.map((f) => f.url).sort(), ["https://portal.pso.localhost:8443/admin/", "https://portal.pso.localhost:8443/shop/"]);
  apply(two.root, { hooks: two.hooks });
  const edge = read(two.root, ".infra/nginx/local/edge.conf");
  assert.equal(edge.match(/server_name portal\.pso\.localhost;/g)?.length, 1);
  assert.match(edge, /location \^~ \/_mei\/mei-catalog\/ \{\n\s+set \$pso_fei http:\/\/fei-shop:8080;/);
  assert.match(edge, /location \^~ \/admin \{\n\s+set \$pso_fei http:\/\/fei-admin:8080;/);
  const api = workspace({ infra: { ...LOCAL, frontends: { "fei-admin": { host: "api" } } } });
  assert.throws(() => plan(api.root, undefined, api.hooks), /host of the API/);
});

test("addresses: containers reach each other by name, never through localhost; dependency order is explicit", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  const c = loadContract(root).contract;
  const t = resolveTopology(JSON.parse(readFileSync(join(root, "pso.workspace.json"), "utf8")), c, "local", [fei("fei-shop", 4200)]);
  const compose = renderCompose(t, c);
  assert.match(compose, /PSO_UPSTREAM_CATALOG: "catalog:8081"/);
  assert.match(compose, /PSO_UPSTREAM_ACCOUNTS_TLS_CERT_FILE: "\/run\/pso\/client\/tls.crt"/, "mutual TLS: the orchestrator presents its client certificate");
  assert.match(compose, /SERVER_SSL_CLIENT_AUTH: "need"/);
  assert.match(compose, /PSO_JWT_JWKS_URI: "https:\/\/idp:8443\/realms\/shop\/protocol\/openid-connect\/certs"/);
  assert.match(compose, /PSO_JWT_ISSUER: "https:\/\/auth\.pso\.localhost:8443\/realms\/shop"/, "the issuer is what the browser sees");
  assert.doesNotMatch(compose.split("\n").filter((l) => /UPSTREAM|JWKS_URI|DB_URL/.test(l)).join("\n"), /localhost|127\.0\.0\.1/);
  const order = startupOrder(t);
  for (const [a, b] of [["catalog-db", "catalog"], ["catalog", "accounts"], ["accounts", "gateway"], ["idp", "gateway"], ["gateway", "edge"], ["fei-shop", "edge"]] as const) assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  assert.deepEqual(dependenciesOf(t, ["accounts"]), ["catalog-db", "idp", "catalog", "accounts"].sort((x, y) => order.indexOf(x) - order.indexOf(y)));
});

test("validation finds a leaked secret, an exposed key and missing ignore rules", async () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  apply(root, { hooks });
  assert.equal((await validate(root, { hooks })).ok, true);
  const secret = read(root, ".infra/secrets/local/db-catalog");
  writeFileSync(join(root, ".env"), `DB_PASSWORD=${secret}\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  const v = await validate(root, { hooks });
  assert.equal(v.ok, false);
  const codes = v.findings.map((f) => f.code);
  assert.ok(codes.includes("PSO_INFRA_SECRET_LEAK") && codes.includes("PSO_INFRA_NOT_IGNORED"), codes.join(","));
  assert.ok(!JSON.stringify(v).includes(secret), "the report itself never contains the value");
});

test("process environments resolve secret references at start and keep them out of files", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  apply(root, { hooks });
  const text = read(root, ".infra/env/local/catalog.env");
  assert.match(text, /DB_PASSWORD=secret:\/\/db-catalog/);
  const pe = processEnvironment(root, "catalog")!;
  assert.equal(pe.vars["DB_PASSWORD"], read(root, ".infra/secrets/local/db-catalog"));
  assert.deepEqual(pe.secrets, ["DB_PASSWORD"]);
  assert.match(pe.vars["PSO_JWT_JWKS_CA_FILE"]!, /[\\/]\.infra[\\/]ca[\\/]local[\\/]ca\.crt$/);
  assert.equal(pe.vars["DB_URL"], "jdbc:postgresql://127.0.0.1:5432/catalog");
});

test("hosts entries are only proposed; applying them changes PSO's own block and nothing else", () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  const t = plan(root, undefined, hooks).topology;
  const file = join(root, "hosts-copy");
  writeFileSync(file, "127.0.0.1 localhost\r\n10.0.0.5 nas\r\n");
  const block = renderHosts(t, "shop");
  assert.equal(applyHostsBlock(file, block, hostsMarker("shop", "local")).changed, true);
  assert.equal(applyHostsBlock(file, block, hostsMarker("shop", "local")).changed, false, "idempotent");
  assert.match(readFileSync(file, "utf8"), /10\.0\.0\.5 nas\r\n# BEGIN PSO shop\/local\r\n/);
  applyHostsBlock(file, block, hostsMarker("shop", "local"), true);
  assert.equal(readFileSync(file, "utf8"), "127.0.0.1 localhost\r\n10.0.0.5 nas\r\n");
});

test("the generated edge and FEI nginx configurations are accepted by the real nginx", { skip: spawnSync("docker", ["image", "inspect", "nginx:1.27-alpine"], { encoding: "utf8" }).status !== 0 ? "image nginx:1.27-alpine is not available" : false }, () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  apply(root, { hooks });
  const m = (rel: string, to: string) => ["-v", `${join(root, ...rel.split("/"))}:${to}:ro`];
  for (const [conf, extra] of [["edge", m(".infra/certs/local/edge", "/run/pso/tls")], ["fei-shop", m(".infra/sites/local/fei-shop", "/srv/site")]] as const) {
    const r = spawnSync("docker", ["run", "--rm", ...m(`.infra/nginx/local/${conf}.conf`, "/etc/nginx/conf.d/default.conf"), ...extra, "nginx:1.27-alpine", "nginx", "-t"], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `${conf}: ${r.stderr}`);
    assert.match(r.stderr, /syntax is ok/);
  }
});

test("the generated compose file is valid for the real Docker Compose", { skip: spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status !== 0 ? "docker compose is not available" : false }, () => {
  const { root, hooks } = workspace({ infra: LOCAL });
  apply(root, { hooks });
  for (const f of ["compose.yml", "compose.deps.yml"]) {
    const r = spawnSync("docker", ["compose", "-f", join(root, ".infra", "docker", "local", f), "--project-directory", root, "config", "--quiet"], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const r = spawnSync("docker", ["compose", "-f", join(root, ".infra", "docker", "local", "compose.yml"), "--project-directory", root, "config", "--format", "json"], { encoding: "utf8" });
  const model = JSON.parse(r.stdout) as { services: Record<string, { depends_on?: Record<string, unknown>; secrets?: unknown[]; environment?: Record<string, string> }> };
  assert.ok(model.services["edge"]!.depends_on!["gateway"]);
  assert.ok(!JSON.stringify(model).includes(read(root, ".infra/secrets/local/db-catalog")), "no secret value in the effective compose model");
  assert.match(model.services["idp"]!.environment?.["KC_HOSTNAME"] ?? "", /auth\.pso\.localhost:8443/);
});
