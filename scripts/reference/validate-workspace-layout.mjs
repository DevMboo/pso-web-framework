#!/usr/bin/env node
// Acceptance of the mandatory workspace organization (0.2.0-rc.5) with a REAL CLI: every workspace action is a `pso` command.
//   node scripts/reference/validate-workspace-layout.mjs [--cli <pso.cmd | pso.js>] [--evidence <file.json>] [--keep]
// Default CLI: this checkout (packages/cli/bin/pso.js). For the installed distribution pass its bin/pso.cmd.
// Steps: create workspace shop -> .infra/ before infra:init -> service, orchestrator, 2 FEIs, 3 MEIs -> filesystem and registration ->
// pso validate -> infra:init --identity keycloak --runtime docker -> docker:up --vendor -> docker:ps -> tokens and HTTP through the edge
// (orchestrator -> catalog) -> frontend build and local composition -> docker:down.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const cli = flag("cli") ?? join(repo, "packages", "cli", "bin", "pso.js");
const { plan, netRequest, developmentUserToken, environmentCa, localResolution } = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
// the CLI hooks add the frontends (FEIs and their MEIs) to the topology, as every pso command does
const { INFRA_HOOKS } = await import(new URL("../../packages/cli/dist/commands-infra.js", import.meta.url).href);

const results = []; const transcript = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 300)}`}`); };
const pso = (cwd, ...args) => {
  const t0 = Date.now();
  const cmd = cli.endsWith(".js") ? process.execPath : cli; const argv = cli.endsWith(".js") ? [cli, ...args] : args;
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", shell: cmd.endsWith(".cmd"), timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1", FORCE_COLOR: "0" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`; const ms = Date.now() - t0;
  transcript.push({ command: `pso ${args.join(" ")}`, cwd, exit: r.status, ms });
  console.log(`[${(ms / 1000).toFixed(1).padStart(6)} s] pso ${args.join(" ")}${r.status ? `  -> exit ${r.status}` : ""}`);
  if (r.status !== 0) console.log(out.slice(-1500));
  return { code: r.status, out };
};
const tree = (dir, depth = 3, prefix = "") => {
  const skip = new Set(["node_modules", "dist", "target", ".git", "vendor", ".pso", ".mvn", ".test-dist"]);
  const out = []; if (depth < 0) return out;
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !skip.has(e.name)).sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
  entries.forEach((e, i) => { const last = i === entries.length - 1; out.push(`${prefix}${last ? "└── " : "├── "}${e.name}${e.isDirectory() ? "/" : ""}`); if (e.isDirectory() && depth > 0) out.push(...tree(join(dir, e.name), depth - 1, prefix + (last ? "    " : "│   "))); });
  return out;
};

const base = mkdtempSync(join(tmpdir(), "pso-layout-acc-"));
const ws = join(base, "shop");
const version = pso(base, "--version").out.trim();
console.log(`CLI ${cli} (${version}); workspace ${ws}`);
let up = false;
try {
  check("pso create workspace shop", pso(base, "create", "workspace", "shop").code === 0);
  const std = [".infra", "orchestrators", "services", "frontends", "frontends/modules", "shared", "docs", "tests"];
  check("the standard directories exist right after creation", std.every((d) => existsSync(join(ws, d))), std.filter((d) => !existsSync(join(ws, d))).join(", "));
  check(".infra/ exists before infra:init and holds only its ignore rule (no credential or certificate)", existsSync(join(ws, ".infra")) && readdirSync(join(ws, ".infra")).join(",") === ".gitignore", existsSync(join(ws, ".infra")) ? readdirSync(join(ws, ".infra")).join(",") : "missing");
  check("pso create service catalog", pso(ws, "create", "service", "catalog").code === 0);
  check("pso create orchestrator gateway", pso(ws, "create", "orchestrator", "gateway").code === 0);
  check("pso create fei shop", pso(ws, "create", "fei", "shop").code === 0);
  check("pso create fei admin", pso(ws, "create", "fei", "admin").code === 0);
  check("pso create mei catalog --host shop --register", pso(ws, "create", "mei", "catalog", "--host", "shop", "--register").code === 0);
  check("pso create mei orders --host shop --register", pso(ws, "create", "mei", "orders", "--host", "shop", "--register").code === 0);
  check("pso create mei users --host admin --register", pso(ws, "create", "mei", "users", "--host", "admin", "--register").code === 0);
  const cfg = JSON.parse(readFileSync(join(ws, "pso.workspace.json"), "utf8"));
  const paths = Object.fromEntries([...cfg.services, ...(cfg.frontends ?? [])].map((p) => [p.name, p.path]));
  const want = { catalog: "services/catalog", gateway: "orchestrators/gateway", "fei-shop": "frontends/fei-shop", "fei-admin": "frontends/fei-admin", "mei-catalog": "frontends/modules/mei-catalog", "mei-orders": "frontends/modules/mei-orders", "mei-users": "frontends/modules/mei-users" };
  check("registered paths: services/, orchestrators/, frontends/, frontends/modules/", JSON.stringify(paths) === JSON.stringify(want), JSON.stringify(paths));
  check("every registered path exists on disk, nothing at the root or under frontend/", Object.values(paths).every((p) => existsSync(join(ws, ...p.split("/")))) && !existsSync(join(ws, "catalog")) && !existsSync(join(ws, "gateway")) && !existsSync(join(ws, "frontend")));
  check("internal structures unchanged (modular orchestrator, layered Java service)", existsSync(join(ws, "orchestrators/gateway/src/.app")) && existsSync(join(ws, "orchestrators/gateway/src/modules/products/routes/ROUTES.pso.ts")) && existsSync(join(ws, "services/catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java")));
  check("the shells register their microfrontends", /mei-catalog/.test(readFileSync(join(ws, "frontends/fei-shop/FEI.pso.ts"), "utf8")) && /mei-orders/.test(readFileSync(join(ws, "frontends/fei-shop/FEI.pso.ts"), "utf8")) && /mei-users/.test(readFileSync(join(ws, "frontends/fei-admin/FEI.pso.ts"), "utf8")));
  const v = pso(ws, "validate"); check("pso validate", v.code === 0 && /\nOK\s*$/.test(v.out), v.out.slice(-300));
  const insp = pso(ws, "structure:inspect"); check("structure:inspect reports the standard layout", /workspace layout: standard/.test(insp.out), insp.out.split("\n")[0]);
  const treeBefore = ["shop/", ...tree(ws, 2)];

  check("pso infra:init --identity keycloak --runtime docker", pso(ws, "infra:init", "--identity", "keycloak", "--runtime", "docker").code === 0);
  check("infra:init writes the contract only; .infra/ is still unprovisioned", existsSync(join(ws, "pso.infra.json")) && readdirSync(join(ws, ".infra")).join(",") === ".gitignore", readdirSync(join(ws, ".infra")).join(","));

  // frontend composition from frontends/ and frontends/modules/: a FEI container serves a PUBLISHED shell, so build and publish first
  const fronts = ["frontends/fei-shop", "frontends/fei-admin", "frontends/modules/mei-catalog", "frontends/modules/mei-orders", "frontends/modules/mei-users"];
  for (const d of fronts) check(`npm install in ${d}`, spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: join(ws, ...d.split("/")), shell: true, encoding: "utf8", timeout: 900_000 }).status === 0);
  check("pso frontend:build --env local (every FEI and MEI)", pso(ws, "frontend:build", "--env", "local").code === 0);
  const pub = pso(ws, "frontend:publish", "--all", "--env", "local");
  check("pso frontend:publish --all --env local (shells and their microfrontends)", pub.code === 0, pub.out.slice(-300));
  const routes = pso(ws, "frontend:routes"); check("pso frontend:routes lists the microfrontend routes of both FEIs", routes.code === 0 && /catalog/.test(routes.out) && /orders/.test(routes.out) && /users/.test(routes.out), routes.out.slice(-300));

  const dup = pso(ws, "docker:up", "--vendor", "--timeout", "1200"); up = true;
  check("pso docker:up --vendor", dup.code === 0, dup.out.split("\n").slice(-6).join(" | "));
  check("after docker:up, .infra/ holds the provisioned material (certificates, secrets, generated configuration)", readdirSync(join(ws, ".infra")).length > 1, readdirSync(join(ws, ".infra")).join(","));
  const ps = pso(ws, "docker:ps"); check("pso docker:ps: every container healthy", ps.code === 0 && !/unhealthy|exited|created /.test(ps.out), ps.out.slice(-600));
  const compose = readdirSync(join(ws, ".infra"), { recursive: true }).map(String).filter((f) => /compose.*\.ya?ml$/.test(f));
  const composeText = compose.map((f) => readFileSync(join(ws, ".infra", f), "utf8")).join("\n");
  check("generated compose builds from the standard paths", /\.\/services\/catalog/.test(composeText) && /\.\/orchestrators\/gateway/.test(composeText), compose.join(","));

  // service communication through the edge: client -> edge -> orchestrator (orchestrators/gateway) -> catalog (services/catalog) -> PostgreSQL
  const p = plan(ws, "local", INFRA_HOOKS); const t = p.topology, ca = environmentCa(ws, t), map = localResolution(t), api = t.api.origin;
  const call = async (method, path, token) => { const r = await netRequest({ url: `${api}${path}`, method, ca, resolve: map, timeoutMs: 30_000, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.status, text: r.body.toString("utf8") }; };
  const opts = await call("GET", "/products/options");
  check("public GET /products/options through the edge -> orchestrator -> catalog: 200", opts.status === 200 && /sort/.test(opts.text), `${opts.status} ${opts.text.slice(0, 160)}`);
  const unauth = await call("GET", "/products"); check("protected GET /products without a token: 401 problem from the orchestrator", unauth.status === 401 && /PSO_AUTH_UNAUTHORIZED/.test(unauth.text), `${unauth.status} ${unauth.text.slice(0, 120)}`);
  const users = t.identity?.users?.map((u) => u.username) ?? [];
  if (users.length) {
    const tok = (await developmentUserToken(ws, t, users[0])).accessToken; const list = await call("GET", "/products?page=0&size=5", tok);
    check(`GET /products with a Keycloak token of "${users[0]}": 200`, list.status === 200, `${list.status} ${list.text.slice(0, 160)}`);
  } else console.log("note: infra:init without --users declares no development user; token calls are covered by validate-crud.mjs");
  if (!(t.frontends ?? []).length) check("the topology lists the two FEIs", false, "none");
  for (const fe of t.frontends ?? []) { const r = await netRequest({ url: fe.url, method: "GET", ca, resolve: map, timeoutMs: 30_000 }); check(`FEI ${fe.name} is served by the edge (${fe.url})`, r.status === 200 && /<html|<!doctype/i.test(r.body.toString("utf8")), `${r.status}`); }
  const evidence = { cli, version, workspace: ws, treeBefore, results, transcript, at: new Date().toISOString() };
  const ev = flag("evidence"); if (ev) { mkdirSync(join(ev, ".."), { recursive: true }); writeFileSync(ev, JSON.stringify(evidence, null, 2)); }
  console.log("\n" + treeBefore.join("\n"));
} finally {
  // volumes too: a later workspace with the same name would otherwise meet a database initialised with this run's generated password
  if (up && !a.includes("--keep")) pso(ws, "docker:down", "--volumes", "--yes");
  if (!a.includes("--keep")) { try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ } }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
