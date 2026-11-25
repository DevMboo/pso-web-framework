#!/usr/bin/env node
// Legacy Spring security migration with REAL requests against the running reference stack:
//   1. reproduce what a service generated before 0.2.0 looks like (no PUBLIC rule), rebuild it, prove the public route answers 401
//   2. pso workspace:migrate (inspection), then --apply: the PUBLIC rule is added for the publicly declared route only, with a backup
//   3. rebuild only that service: the public route answers 200; protected routes still refuse callers without a token or a scope
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const root = resolve(process.argv[2] ?? join(repo, "fixtures", "pso-reference"));
const out = resolve(process.argv[3] ?? join(repo, "docs", "implementation", "evidence", "v020", "spring-migration.json"));
const I = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const PSO = join(repo, "packages", "cli", "bin", "pso.js");
const t = I.plan(root, "local", { frontends: I.readFrontends }).topology;
const ca = I.environmentCa(root, t), map = I.localResolution(t), api = t.api.origin;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const pso = (...a) => { const r = spawnSync(process.execPath, [PSO, ...a], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, timeout: 1_200_000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const get = (path, token, method = "GET", body) => I.netRequest({ url: `${api}${path}`, method, ca, resolve: map, timeoutMs: 20000, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}) }, ...(body ? { body } : {}) });
const yml = join(root, "catalog", "src", "main", "resources", "application.yml");
const original = readFileSync(yml, "utf8");
const rebuild = (label) => { const r = pso("docker:up", "--env", "local", "--service", "catalog", "--no-deps", "--build", "--timeout", "300"); check(`${label}: catalog rebuilt and healthy (only catalog)`, r.code === 0, r.code ? r.out.slice(-400) : ""); };

// 1. the legacy state: an empty rule list, as generators before 0.2.0 left it
writeFileSync(yml, original.replace(/^    rules:[^\n]*\n(      [^\n]*\n)+/m, "    rules: []                  # explicit authorization rules; everything not listed requires a valid token\n"));
rebuild("legacy");
const legacy = await get("/catalog/products");
check("legacy: the route the orchestrator declares public answers 401 (the service is secure by default)", legacy.status === 401, `HTTP ${legacy.status}`);
// 2. migration
const dry = JSON.parse(pso("workspace:migrate", "--json").out);
const adds = dry.springSecurity.findings.filter((f) => f.kind === "add").map((f) => `${f.method} ${f.route}`);
check("inspection proposes exactly the public route", JSON.stringify(adds) === JSON.stringify(["GET /catalog/products"]), adds.join(", "));
check("inspection writes nothing", readFileSync(yml, "utf8").includes("rules: []"));
const ap = JSON.parse(pso("workspace:migrate", "--apply", "--json").out);
check("apply adds the rule with a recoverable backup", ap.springAdded?.includes("catalog: GET /catalog/products") && ap.springBackups?.length === 1, (ap.springBackups ?? []).join(", "));
const again = pso("workspace:migrate", "--apply", "--json");
check("a second run changes nothing", JSON.parse(again.out).springSecurity.findings.every((f) => f.kind !== "add"));
// 3. real behaviour after the migration
rebuild("migrated");
const bob = (await I.developmentUserToken(root, t, "bob")).accessToken;
const pub = await get("/catalog/products");
check("migrated: the public route answers 200 without a token", pub.status === 200 && /Espresso/.test(pub.body.toString()), `HTTP ${pub.status}`);
const p1 = await get("/catalog/cart-items", undefined, "POST", JSON.stringify({ id: "c-1", name: "x" }));
check("migrated: a protected route of the same service still answers 401 without a token", p1.status === 401, `HTTP ${p1.status}`);
const p2 = await get("/catalog/cart-items", bob, "POST", JSON.stringify({ id: "c-1", name: "x" }));
check("migrated: the protected route works with a token that has the scope", p2.status === 200, `HTTP ${p2.status}`);
const p3 = await get("/accounts/users", bob);
check("migrated: other services are unaffected (bob without users:admin gets 403)", p3.status === 403, `HTTP ${p3.status}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
