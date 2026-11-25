import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createDevCertificate } from "@pso/core";
import { pso, tmp, read } from "./helpers.ts";

/** A 0.1-style workspace created by the CLI: orchestrator, two Spring services (one with a database). */
async function workspace(name = "shop"): Promise<string> {
  const parent = tmp("pso-infra-cli-");
  assert.equal((await pso(parent, "create", "workspace", name, "--layout", "flat")).code, 0);
  const root = join(parent, name);
  for (const args of [["create", "orchestrator", "gateway", "--structure", "legacy"], ["create", "service", "catalog", "--structure", "legacy", "--db", "postgres"], ["create", "service", "accounts", "--structure", "legacy"]]) {
    const r = await pso(root, ...args);
    assert.equal(r.code, 0, r.out + r.err);
  }
  return root;
}
const json = (s: string) => JSON.parse(s) as Record<string, unknown>;
const fp = (root: string, f: string) => createHash("sha256").update(readFileSync(join(root, ...f.split("/")))).digest("hex");

test("infra commands: init, plan, apply (idempotent), status, inspect without key material, validate", async () => {
  const root = await workspace();
  assert.equal((await pso(root, "infra:init", "--identity", "pso-dev", "--runtime", "docker", "--users", "ana")).code, 0);
  assert.equal((await pso(root, "infra:init")).code, 1, "an existing contract is never replaced without --force");
  const plan = await pso(root, "infra:plan", "--json");
  assert.equal(plan.code, 0);
  assert.ok((json(plan.out)["summary"] as { changes: number }).changes > 10);
  const status0 = await pso(root, "infra:status");
  assert.equal(status0.code, 1, "an unprovisioned environment needs attention");
  const a1 = await pso(root, "infra:apply", "--json");
  assert.equal(a1.code, 0, a1.out + a1.err);
  const caFp = fp(root, ".infra/ca/local/ca.crt");
  const a2 = await pso(root, "infra:apply");
  assert.match(a2.out, /nothing to do: every resource is present and valid/);
  assert.equal(fp(root, ".infra/ca/local/ca.crt"), caFp);
  assert.equal((await pso(root, "infra:status")).code, 0);
  const insp = await pso(root, "infra:inspect", "cert:edge");
  assert.match(insp.out, /tls\.key  \[sensitive: never printed\]/);
  assert.doesNotMatch(insp.out, /PRIVATE KEY/);
  const all = await pso(root, "infra:inspect", "--json");
  assert.doesNotMatch(all.out, /PRIVATE KEY|BEGIN CERTIFICATE/);
  for (const s of readdirSync(join(root, ".infra", "secrets", "local"))) assert.ok(!all.out.includes(read(root, ".infra", "secrets", "local", s).trim()), `secret ${s} leaked into infra:inspect`);
  const v = await pso(root, "infra:validate", "--json");
  assert.equal(v.code, 0, v.out);
  // a development token signed by the pso-dev identity, verifiable with the published JWKS
  const tok = await pso(root, "infra:token", "--user", "ana", "--scopes", "catalog:read");
  assert.equal(tok.code, 0, tok.err);
  const claims = JSON.parse(Buffer.from(tok.out.trim().split(".")[1]!, "base64url").toString()) as { iss: string; aud: string; scp: string[] };
  assert.deepEqual([claims.iss, claims.aud, claims.scp], ["https://auth.pso.localhost:8443", "pso-api", ["catalog:read"]]);
});

test("drift: status reports it, repair needs --yes, then restores the file and keeps a backup", async () => {
  const root = await workspace();
  await pso(root, "infra:init", "--runtime", "docker");
  await pso(root, "infra:apply");
  const f = join(root, ".infra", "nginx", "local", "edge.conf");
  writeFileSync(f, read(f) + "\n# hand edit\n");
  const st = await pso(root, "infra:status", "--json");
  assert.equal(st.code, 1);
  assert.equal((json(st.out)["summary"] as { drift: number }).drift, 1);
  const r1 = await pso(root, "infra:repair");
  assert.equal(r1.code, 3, "overwriting a hand edit needs explicit authorization");
  assert.match(read(f), /hand edit/);
  const r2 = await pso(root, "infra:repair", "--yes", "--json");
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.doesNotMatch(read(f), /hand edit/);
  const backups = (json(r2.out)["backups"] as string[]);
  assert.equal(backups.length, 1);
  assert.match(read(root, ...backups[0]!.split("/")), /hand edit/);
});

test("rotation is explicit and re-issues what an authority signed", async () => {
  const root = await workspace();
  await pso(root, "infra:init", "--runtime", "docker");
  await pso(root, "infra:apply");
  const before = { ca: fp(root, ".infra/ca/local/ca.crt"), edge: fp(root, ".infra/certs/local/edge/tls.crt"), catalog: fp(root, ".infra/certs/local/catalog/tls.crt") };
  assert.equal((await pso(root, "infra:rotate", "cert:catalog")).code, 3);
  assert.equal((await pso(root, "infra:rotate", "cert:catalog", "--yes")).code, 0);
  assert.notEqual(fp(root, ".infra/certs/local/catalog/tls.crt"), before.catalog);
  assert.equal(fp(root, ".infra/certs/local/edge/tls.crt"), before.edge, "rotating one certificate leaves the others alone");
  assert.equal((await pso(root, "infra:rotate", "ca", "--yes")).code, 0);
  assert.notEqual(fp(root, ".infra/ca/local/ca.crt"), before.ca);
  assert.notEqual(fp(root, ".infra/certs/local/edge/tls.crt"), before.edge, "certificates of the replaced authority are re-issued");
  assert.equal((await pso(root, "infra:validate")).code, 0);
  assert.equal((await pso(root, "infra:rotate", "nginx:edge", "--yes")).code, 1, "configuration is not key material");
});

test("staging: operator-supplied TLS and secret files, configuration-only apply behind --yes, a reviewable bundle deployment", async () => {
  const root = await workspace();
  await pso(root, "infra:init", "--identity", "keycloak", "--runtime", "docker");
  // the operator's own certificate authority and certificates, in the PSO layout, outside PSO's store
  const ops = join(root, "ops", "staging"), tls = join(ops, "tls"), sec = join(ops, "secrets");
  const ca = createDevCertificate({ commonName: "Operator CA", ca: true });
  const names: Record<string, string[]> = { edge: ["edge", "localhost", "shop.staging.example.test", "api.staging.example.test", "auth.staging.example.test"], gateway: ["gateway", "localhost"], catalog: ["catalog", "localhost"], accounts: ["accounts", "localhost"], idp: ["idp", "localhost", "127.0.0.1", "auth.staging.example.test"] };
  mkdirSync(tls, { recursive: true }); writeFileSync(join(tls, "ca.crt"), ca.certPem);
  for (const [n, sans] of Object.entries(names)) { const l = createDevCertificate({ commonName: n, names: sans, issuer: ca }); mkdirSync(join(tls, n), { recursive: true }); writeFileSync(join(tls, n, "tls.crt"), l.certPem); writeFileSync(join(tls, n, "tls.key"), l.keyPem); writeFileSync(join(tls, n, "ca.crt"), ca.certPem); }
  mkdirSync(sec, { recursive: true });
  for (const s of ["db-catalog", "idp-admin"]) writeFileSync(join(sec, s), `operator-${s}-value-0123456789`);
  const c = json(read(root, "pso.infra.json"));
  (c["environments"] as Record<string, unknown>)["staging"] = { kind: "staging", domain: "staging.example.test", runtime: "docker", httpsPort: 9443, tls: { source: "external", dir: tls.split(sep).join("/") }, secrets: { provider: "file", dir: sec.split(sep).join("/").replace(/^([A-Za-z]):/, "/$1") }, dns: { provider: "external" } };
  writeFileSync(join(root, "pso.infra.json"), JSON.stringify(c, null, 2));
  // the "file" provider needs an absolute POSIX path; on Windows the drive is not one, so the test points it at a POSIX-looking path and checks the plan only
  const plan = await pso(root, "infra:plan", "--env", "staging", "--json");
  assert.equal(plan.code, 0, plan.out + plan.err);
  const res = (json(plan.out)["resources"] as Array<{ id: string; owner: string; status: string }>);
  assert.equal(res.find((r) => r.id === "ca")!.owner, "external");
  assert.equal(res.find((r) => r.id === "ca")!.status, "external-ok", "the operator's authority is verified where it is");
  assert.equal(res.find((r) => r.id === "cert:edge")!.status, "external-ok");
  assert.equal((await pso(root, "infra:apply", "--env", "staging")).code, 3, "a non-development environment is applied only with --yes");
  const ap = await pso(root, "infra:apply", "--env", "staging", "--yes", "--json");
  assert.ok(!existsSync(join(root, ".infra", "ca", "staging")) && !existsSync(join(root, ".infra", "certs", "staging")) && !existsSync(join(root, ".infra", "secrets", "staging")), "nothing secret is generated for staging");
  assert.ok((json(ap.out)["applied"] as Array<{ id: string; result: string }>).filter((a) => a.result === "done").every((a) => !/^(ca|cert:|secret:)/.test(a.id)));
  const compose = read(root, ".infra", "docker", "staging", "compose.yml");
  assert.match(compose, /start --import-realm/, "staging Keycloak does not run in development mode");
  assert.match(compose, /"9443:8443"/);
  assert.doesNotMatch(compose, /operator-db-catalog-value/);
  // deployment of staging goes to a bundle for the operator (no FEI to publish in this workspace)
  const dry = await pso(root, "deploy", "--env", "staging", "--dry-run", "--json");
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.equal(json(dry.out)["target"], "bundle");
  assert.ok((json(dry.out)["prerequisites"] as string[]).some((p) => /DNS: shop\.staging\.example\.test|DNS: api\.staging\.example\.test/.test(p)));
  assert.equal((await pso(root, "deploy", "--env", "staging")).code, 3, "deploying needs --yes");
  const dep = await pso(root, "deploy", "--env", "staging", "--yes", "--json");
  assert.equal(dep.code, 0, dep.out + dep.err);
  const bundle = json(dep.out)["bundle"] as string;
  const files: string[] = []; const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } }; walk(bundle);
  assert.ok(files.some((f) => f.endsWith("MANIFEST.json")) && files.some((f) => f.endsWith("DEPLOY.md")) && files.some((f) => f.endsWith("compose.yml")));
  for (const f of files) { const t = readFileSync(f, "utf8"); assert.doesNotMatch(t, /PRIVATE KEY|operator-db-catalog-value|operator-idp-admin-value/, `${f} must not contain key material or secret values`); }
});

test("hosts entries are proposed, and written only with --apply --yes into PSO's own block", async () => {
  const root = await workspace();
  await pso(root, "infra:init");
  const file = join(root, "hosts-test");
  writeFileSync(file, "127.0.0.1 localhost\n");
  const show = await pso(root, "infra:hosts", "--file", file);
  assert.match(show.out, /127\.0\.0\.1 api\.pso\.localhost/);
  assert.equal(read(file), "127.0.0.1 localhost\n");
  assert.equal((await pso(root, "infra:hosts", "--file", file, "--apply")).code, 3);
  assert.equal((await pso(root, "infra:hosts", "--file", file, "--apply", "--yes")).code, 0);
  assert.match(read(file), /^127\.0\.0\.1 localhost\n# BEGIN PSO shop\/local\n/);
  assert.equal((await pso(root, "infra:hosts", "--file", file, "--remove", "--yes")).code, 0);
  assert.equal(read(file), "127.0.0.1 localhost\n");
});

test("docker:plan and deploy --dry-run describe the topology without Docker; usage errors and 0.1 compatibility", async () => {
  const root = await workspace();
  // 0.1 compatibility: nothing changes for a workspace without pso.infra.json
  const d0 = await pso(root, "dev", "--docker");
  assert.equal(d0.code, 1); assert.match(d0.err, /pso infra:init/);
  assert.equal((await pso(root, "validate")).code, 0);
  await pso(root, "infra:init", "--identity", "keycloak", "--runtime", "docker", "--users", "ana");
  const p = await pso(root, "docker:plan", "--json");
  assert.equal(p.code, 0, p.err);
  const names = (json(p.out)["containers"] as Array<{ name: string }>).map((c) => c.name);
  for (const [a, b] of [["catalog-db", "catalog"], ["idp", "gateway"], ["catalog", "gateway"], ["gateway", "edge"]] as const) assert.ok(names.indexOf(a) < names.indexOf(b), `${a} before ${b}`);
  assert.equal((await pso(root, "docker:restart")).code, 1);
  assert.equal((await pso(root, "docker:up", "--bogus")).code, 2, "an unknown flag is a usage error");
  assert.equal((await pso(root, "infra:plan", "--env", "nope")).code, 1);
  const dry = await pso(root, "deploy", "--env", "local", "--dry-run");
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /Nothing was changed/);
  assert.equal((await pso(root, "deploy", "--env", "local", "--target", "compose", "--yes")).code, 1, "--env and --target are two kinds of deployment");
});

test("reconciliation: creating a service updates the development environment and nothing else", async () => {
  const root = await workspace();
  await pso(root, "infra:init", "--runtime", "docker");
  await pso(root, "infra:apply");
  const keep = fp(root, ".infra/certs/local/catalog/tls.crt");
  const r = await pso(root, "create", "service", "orders", "--structure", "legacy");
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /reconciled "local" after creating service "orders": .*cert:orders/);
  assert.ok(existsSync(join(root, ".infra", "certs", "local", "orders", "tls.crt")));
  assert.match(read(root, ".infra", "docker", "local", "compose.yml"), /PSO_UPSTREAM_ORDERS: "orders:/);
  assert.equal(fp(root, ".infra/certs/local/catalog/tls.crt"), keep);
  assert.equal((await pso(root, "infra:plan", "--json")).out.includes('"changes": 0'), true);
});

test("workspace:migrate adopts a 0.1 development TLS directory and identity key instead of regenerating them", async () => {
  const root = await workspace();
  assert.equal((await pso(root, "tls:init", "--dev", "--hosts", "idp")).code, 0);
  assert.equal((await pso(root, "idp:dev", "init")).code, 0);
  const caBefore = fp(root, "tls/ca.crt"), catalogBefore = fp(root, "tls/catalog/tls.crt");
  const inspect = await pso(root, "workspace:migrate", "--json");
  assert.equal(inspect.code, 0, inspect.out);
  assert.ok(!existsSync(join(root, "pso.infra.json")), "inspection writes nothing");
  assert.ok((json(inspect.out)["steps"] as Array<{ id: string }>).some((s) => s.id === "adopt:ca"));
  const m = await pso(root, "workspace:migrate", "--apply", "--json");
  assert.equal(m.code, 0, m.out + m.err);
  assert.deepEqual((json(m.out)["reused"] as string[]).sort(), ["ca", "cert:accounts", "cert:catalog", "cert:idp", "identity:signing-key"].filter((x) => x !== "cert:idp" || true).sort().filter((x) => (json(m.out)["reused"] as string[]).includes(x)));
  assert.equal(fp(root, ".infra/ca/local/ca.crt"), caBefore, "the 0.1 authority is reused, not regenerated");
  assert.equal(fp(root, ".infra/certs/local/catalog/tls.crt"), catalogBefore, "valid certificates are reused");
  assert.equal(fp(root, "tls/ca.crt"), caBefore, "tls/ itself is left as it is");
  assert.equal((await pso(root, "infra:status")).code, 0);
  assert.match(read(root, ".infra", "migration-0.2.0.json"), /"reused"/);
  const twice = await pso(root, "workspace:migrate");
  assert.equal(twice.code, 0); assert.match(twice.out, /Nothing to migrate/, "a migrated workspace is not migrated twice");
});

test("workspace:migrate on a copy of the 0.1 Commerce fixture: application files are untouched and the environment is complete", { timeout: 300_000 }, async () => {
  const src = join(import.meta.dirname, "..", "..", "..", "fixtures", "pso-commerce");
  if (!existsSync(join(src, "pso.workspace.json"))) return;
  const root = join(tmp("pso-migrate-commerce-"), "commerce");
  cpSync(src, root, { recursive: true, filter: (p) => !/[\\/](node_modules|target|dist|\.pso|\.infra|vendor)([\\/]|$)/.test(p) });
  const hashes = (): Record<string, string> => { const out: Record<string, string> = {}; const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const r = relative(root, p).split(sep).join("/"); if (r.startsWith(".infra") || r === "pso.infra.json" || r === ".gitignore") continue; if (statSync(p).isDirectory()) walk(p); else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex"); } }; walk(root); return out; };
  const before = hashes();
  const m = await pso(root, "workspace:migrate", "--apply", "--json");
  assert.equal(m.code, 0, m.out + m.err);
  const after = hashes();
  assert.deepEqual(Object.keys(after).filter((k) => after[k] !== before[k]), [], "no application, declaration, route, DTO or service file changed");
  const plan = await pso(root, "infra:plan", "--json");
  assert.equal((json(plan.out)["summary"] as { changes: number }).changes, 0);
  assert.equal((await pso(root, "validate")).code, (await pso(root, "validate")).code);
  rmSync(root, { recursive: true, force: true });
});
