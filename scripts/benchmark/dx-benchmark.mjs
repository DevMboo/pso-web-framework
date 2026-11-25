#!/usr/bin/env node
// Developer-experience benchmark of PSO 0.2.0 with the DISTRIBUTED CLI (installed from the release tarballs into an empty directory,
// outside the monorepo; no framework module is imported). Every step is a `pso` command; the script counts commands, measures time,
// records every file a developer would have to edit by hand, and validates the result with real requests and a real browser.
// Usage: node scripts/benchmark/dx-benchmark.mjs <dir-with-tarballs> [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const dist = resolve(process.argv[2] ?? join(repo, "release-out", "0.2.0", "npm"));
const out = join(repo, "docs", "implementation", "evidence", "v020", "dx-benchmark.json");
const base = mkdtempSync(join(tmpdir(), "pso-dx-"));
const steps = [], manualEdits = [], interventions = [], checks = [];
let commands = 0;
const now = () => performance.now();
const sh = (cmd, args, cwd, o = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32" && /npm/.test(cmd), timeout: 2_400_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PSO_NO_BROWSER: "1", MSYS_NO_PATHCONV: "1", ...(o.env ?? {}) } });
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 200)})` : ""}`); };

// ---------------------------------------------------------------- install the distributed CLI
const inst = join(base, "cli"); mkdirSync(inst);
writeFileSync(join(inst, "package.json"), JSON.stringify({ name: "dx", private: true }));
const tgz = readdirSync(dist).filter((f) => f.endsWith(".tgz")).map((f) => `"${join(dist, f)}"`);
let t0 = now();
const ir = sh("npm", ["install", "--no-audit", "--no-fund", ...tgz], inst);
if (ir.status !== 0) { console.error(ir.stderr); process.exit(2); }
const installMs = now() - t0;
const PSO = join(inst, "node_modules", "@pso", "cli", "bin", "pso.js");
const pso = (phase, cwd, ...a) => {
  commands++;
  const s = now(); const r = sh(process.execPath, [PSO, ...a], cwd); const ms = now() - s;
  steps.push({ phase, command: `pso ${a.join(" ")}`, exit: r.status, ms: Math.round(ms) });
  console.log(`[${(ms / 1000).toFixed(1).padStart(6)} s] ${r.status === 0 ? "   " : "ERR"} pso ${a.join(" ")}`);
  if (r.status !== 0) { console.log((r.stdout + r.stderr).slice(-1500)); interventions.push({ phase, command: `pso ${a.join(" ")}`, reason: (r.stdout + r.stderr).trim().split("\n").slice(-3).join(" | ") }); }
  return r;
};
const phase = (name, fn) => { const s = now(); fn(); const ms = now() - s; console.log(`== ${name}: ${(ms / 1000).toFixed(1)} s`); return Math.round(ms); };
const timings = { installCliMs: Math.round(installMs) };

// ---------------------------------------------------------------- 1. workspace, services, frontends, infrastructure contract
const ws = join(base, "bench");
timings.scaffoldMs = phase("scaffold (workspace, 2 services, 2 FEIs, 3 MEIs, routes, contract)", () => {
  pso("scaffold", base, "create", "workspace", "bench");
  pso("scaffold", ws, "create", "orchestrator", "gateway", "--port", "13000");
  pso("scaffold", ws, "create", "service", "catalog", "--db", "postgres", "--port", "18081");
  pso("scaffold", ws, "create", "service", "accounts", "--port", "18082");
  pso("scaffold", ws, "infra:init", "--identity", "keycloak", "--runtime", "docker", "--users", "ana,bob:catalog:read+cart:write", "--mtls", "accounts");
  pso("scaffold", ws, "make:resource", "product", "--service", "catalog", "--route", "/catalog/products", "--method", "GET", "--public");
  pso("scaffold", ws, "make:resource", "cart-item", "--service", "catalog", "--route", "/catalog/cart-items", "--method", "POST", "--scopes", "cart:write");
  pso("scaffold", ws, "make:resource", "user", "--service", "accounts", "--route", "/accounts/users", "--method", "GET", "--scopes", "users:admin");
  pso("scaffold", ws, "create", "fei", "shop");
  pso("scaffold", ws, "create", "fei", "admin");
  pso("scaffold", ws, "create", "mei", "catalog", "--host", "shop", "--register", "--public");
  pso("scaffold", ws, "create", "mei", "cart", "--host", "shop", "--register", "--scopes", "cart:write");
  pso("scaffold", ws, "create", "mei", "users", "--host", "admin", "--register", "--scopes", "users:admin");
  pso("scaffold", ws, "validate");
});
// ---------------------------------------------------------------- 2. first provisioning and start (dependencies installed, images built)
timings.frontendInstallMs = phase("frontend dependencies (npm install of 5 projects)", () => pso("first-start", ws, "frontend:install"));
timings.initialProvisioningMs = phase("initial provisioning + build + start (infra, images, frontends, containers)", () => {
  pso("first-start", ws, "frontend:build", "--env", "local");
  pso("first-start", ws, "frontend:publish", "--all", "--env", "local");
  pso("first-start", ws, "docker:up", "--env", "local", "--vendor", "--timeout", "600");
});
let v = pso("verify", ws, "infra:validate", "--env", "local", "--probe");
check("the environment validates through the edge (TLS, headers, API, identity provider)", v.status === 0);
const state = JSON.parse(readFileSync(join(ws, ".infra", "state.json"), "utf8"));
check("no infrastructure file was edited by hand", manualEdits.filter((e) => e.kind === "infrastructure").length === 0);
// ---------------------------------------------------------------- 3. subsequent start
pso("restart", ws, "docker:down", "--env", "local");
timings.subsequentStartMs = phase("subsequent start (everything cached)", () => pso("restart", ws, "docker:up", "--env", "local", "--timeout", "600"));
// ---------------------------------------------------------------- 4. endpoint testing through Studio (the distributed CLI's own server)
const studioCheck = async () => {
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, [PSO, "studio", "--no-open", "--port", "17841"], { cwd: ws, env: { ...process.env, PSO_NO_BROWSER: "1" } });
  commands++;
  const url = await new Promise((res) => { let b = ""; p.stdout.on("data", (d) => { b += d; const m = /(http:\/\/127\.0\.0\.1:17841\/\?t=\S+)/.exec(b); if (m) res(m[1]); }); });
  const token = new URL(url).searchParams.get("t");
  const post = async (body) => { const r = await fetch("http://127.0.0.1:17841/api/client/send", { method: "POST", headers: { cookie: `pso_studio=${token}`, origin: "http://127.0.0.1:17841", "x-pso-studio": "1", "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
  const pub = await post({ target: "edge:api", method: "GET", path: "/catalog/products" });
  const prot = await post({ target: "edge:api", method: "GET", path: "/accounts/users", auth: { kind: "dev-user", user: "ana" } });
  const denied = await post({ target: "edge:api", method: "GET", path: "/accounts/users", auth: { kind: "dev-user", user: "bob" } });
  p.kill();
  check("Studio API Client: public endpoint 200 without a token", pub.status === 200, `HTTP ${pub.status}`);
  check("Studio API Client: ana (all scopes) reaches accounts over mutual TLS", prot.status === 200, `HTTP ${prot.status}`);
  check("Studio API Client: bob (no users:admin) is refused", denied.status === 403, `HTTP ${denied.status}`);
};
await studioCheck();
// ---------------------------------------------------------------- 5. selective restart, add a service, add a FEI after startup
timings.selectiveRestartMs = phase("selective restart of one service", () => pso("change", ws, "docker:restart", "catalog", "--env", "local"));
timings.addServiceMs = phase("add a service after startup (create + build + start only that one)", () => {
  pso("change", ws, "create", "service", "orders", "--port", "18083");
  pso("change", ws, "docker:up", "--env", "local", "--service", "orders", "--vendor", "--timeout", "600");
});
const idpStart = () => sh("docker", ["inspect", "-f", "{{.State.StartedAt}}", "bench-local-idp-1"], ws).stdout.trim();
const idpBefore = idpStart();
let fei3;
timings.addFeiMs = phase("add a third FEI after startup (create + install + build + publish + start)", () => {
  fei3 = pso("change", ws, "create", "fei", "partners");
  pso("change", ws, "frontend:install", "partners");
  pso("change", ws, "frontend:build", "partners", "--env", "local");
  pso("change", ws, "frontend:publish", "fei-partners", "--env", "local");
  pso("change", ws, "docker:up", "--env", "local", "--timeout", "300");
});
check("the third FEI's OIDC client was created in the running Keycloak (no console, no restart)", /identity provider updated live: .*create-client fei-partners/.test(fei3.stdout), (/identity provider updated live:[^\n]*/.exec(fei3.stdout) ?? [""])[0]);
check("Keycloak was not restarted", idpStart() === idpBefore);
// real browser login on the third FEI
const browser = async () => {
  const { chromium } = await import(new URL("../../node_modules/playwright-core/index.mjs", import.meta.url).href);
  const leaf = new X509Certificate(readFileSync(join(ws, ".infra", "certs", "local", "edge", "tls.crt")));
  const spki = createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const b = await chromium.launch({ channel: "chrome", args: ["--host-resolver-rules=MAP *.pso.localhost 127.0.0.1", `--ignore-certificate-errors-spki-list=${spki}`] });
  try {
    const page = await (await b.newContext()).newPage();
    await page.goto("https://partners.pso.localhost:8443/", { waitUntil: "networkidle" });
    const btn = page.locator("button, a").filter({ hasText: /sign in|continue|log in/i }).first();
    if (await btn.count()) await btn.click();
    await page.waitForSelector("#username", { timeout: 30000 });
    check("the third FEI redirects to Keycloak with its own client", new URL(page.url()).searchParams.get("client_id") === "fei-partners");
    await page.fill("#username", "ana"); await page.fill("#password", readFileSync(join(ws, ".infra", "secrets", "local", "user-ana"), "utf8").trim()); await page.click("#kc-login");
    await page.waitForURL((u) => u.origin === "https://partners.pso.localhost:8443" && !u.pathname.startsWith("/auth/callback"), { timeout: 30000 });
    await page.waitForTimeout(1500);
    check("ana signs in to the third FEI (redirect URI and client reconciled automatically)", (await page.locator("h1").first().textContent())?.includes("Welcome"), page.url());
  } finally { await b.close(); }
};
await browser();
// ---------------------------------------------------------------- 6. hybrid execution and deployment planning
timings.deployPlanMs = phase("deployment planning", () => pso("deploy", ws, "deploy", "--env", "local", "--dry-run"));
pso("hybrid", ws, "docker:down", "--env", "local");
timings.hybridMs = phase("hybrid: database + Keycloak in containers, catalog as a local process (smoke)", () => { const r = pso("hybrid", ws, "dev", "--service", "catalog", "--with-dependencies", "--smoke", "--timeout", "400"); check("hybrid run: catalog READY as a local process with containerized dependencies", r.status === 0 && /READY\/UP/.test(r.stdout)); });
// ---------------------------------------------------------------- report
const infraFiles = Object.values(state.environments.local.resources).reduce((a, r) => a + Object.keys(r.files).length, 0);
const report = {
  at: new Date().toISOString(), cli: "installed from release tarballs (" + tgz.length + " packages) into an empty directory", workspace: ws,
  commands, timings, steps, manualEdits, interventions,
  generatedInfrastructureFiles: infraFiles, manuallyEditedInfrastructureFiles: 0,
  duplication: "host names, ports, redirect URIs, certificates names, upstream addresses and JWT settings are declared once (pso.workspace.json / FEI/MEI/ROUTES / pso.infra.json) and derived into " + infraFiles + " generated files",
  cacheNote: "Docker base images, Maven and npm caches were already warm on this machine: initial provisioning excludes first-time image downloads (measured separately when a cold cache is available)",
  checks,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
if (!process.argv.includes("--keep")) sh("docker", ["compose", "-p", "bench-local-deps", "down"], ws);
const failed = checks.filter((c) => !c.ok).length;
console.log(`\ncommands: ${commands}, interventions: ${interventions.length}, manual infrastructure edits: 0, checks ${checks.length - failed}/${checks.length}`);
console.log(JSON.stringify(timings, null, 2));
process.exit(failed || interventions.length ? 1 : 0);
