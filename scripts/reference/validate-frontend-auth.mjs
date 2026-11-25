#!/usr/bin/env node
// Integration of `pso frontend:config --env`: two shells in one workspace, shop made public (auth none) and admin signing in through
// Keycloak (OIDC). Real CLI, real Docker stack, real Chrome with the edge certificate pinned (nothing bypassed).
//   node scripts/reference/validate-frontend-auth.mjs [--cli <pso.cmd | pso.js>] [--evidence <dir>] [--keep]
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const cli = flag("cli") ?? join(repo, "packages", "cli", "bin", "pso.js");
const evidence = flag("evidence");
const { netRequest, environmentCa, localResolution, plan } = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const { INFRA_HOOKS } = await import(new URL("../../packages/cli/dist/commands-infra.js", import.meta.url).href);
const { chromium } = await import(new URL("../../node_modules/playwright-core/index.mjs", import.meta.url).href);

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 300)}`}`); };
const pso = (cwd, ...args) => {
  const cmd = cli.endsWith(".js") ? process.execPath : cli; const argv = cli.endsWith(".js") ? [cli, ...args] : args;
  const t0 = Date.now(); const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", shell: cmd.endsWith(".cmd"), timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1", FORCE_COLOR: "0" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`; console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] pso ${args.join(" ")}${r.status ? `  -> exit ${r.status}` : ""}`);
  if (r.status !== 0) console.log(out.slice(-1200));
  return { code: r.status, out };
};
const base = mkdtempSync(join(tmpdir(), "pso-feauth-")); const ws = join(base, "shop");
const cfgOf = (fei) => JSON.parse(readFileSync(join(ws, ".infra", "sites", "local", fei, "pso-runtime-config.json"), "utf8"));
let up = false, browser;
try {
  pso(base, "create", "workspace", "shop");
  for (const c of [["service", "catalog"], ["orchestrator", "gateway"], ["fei", "shop"], ["fei", "admin"], ["mei", "catalog", "--host", "shop", "--register", "--public"], ["mei", "orders", "--host", "shop", "--register"], ["mei", "users", "--host", "admin", "--register"]]) check(`pso create ${c.join(" ")}`, pso(ws, "create", ...c).code === 0);
  check("pso infra:init --identity keycloak --runtime docker --users ana", pso(ws, "infra:init", "--identity", "keycloak", "--runtime", "docker", "--users", "ana").code === 0);
  check("pso infra:apply --yes", pso(ws, "infra:apply", "--yes").code === 0);
  check("before: both shells sign in with OIDC", cfgOf("fei-shop").auth.kind === "oidc" && cfgOf("fei-admin").auth.kind === "oidc");

  // the reported command, from the workspace root
  const r = pso(ws, "frontend:config", "--fei", "shop", "--env", "local", "--auth", "none");
  check("pso frontend:config --fei shop --env local --auth none (workspace root)", r.code === 0, r.out);
  const contract = JSON.parse(readFileSync(join(ws, "pso.infra.json"), "utf8"));
  check("recorded as environments.local.frontends.fei-shop.auth = none", contract.environments.local.frontends?.["fei-shop"]?.auth === "none" && !contract.environments.local.frontends?.["fei-admin"], JSON.stringify(contract.environments.local.frontends));
  check("runtime configuration: shop none, admin oidc", cfgOf("fei-shop").auth.kind === "none" && cfgOf("fei-admin").auth.kind === "oidc");

  // publication afterwards must not bring the previous sign-in back
  for (const d of ["frontends/fei-shop", "frontends/fei-admin", "frontends/modules/mei-catalog", "frontends/modules/mei-orders", "frontends/modules/mei-users"]) check(`npm install in ${d}`, spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: join(ws, ...d.split("/")), shell: true, encoding: "utf8", timeout: 900_000 }).status === 0);
  check("pso frontend:build --env local", pso(ws, "frontend:build", "--env", "local").code === 0);
  check("pso frontend:publish --all --env local", pso(ws, "frontend:publish", "--all", "--env", "local").code === 0);
  check("after publication: shop still none, admin still oidc", cfgOf("fei-shop").auth.kind === "none" && cfgOf("fei-admin").auth.kind === "oidc");
  const dup = pso(ws, "docker:up", "--vendor", "--timeout", "1200"); up = true;
  check("pso docker:up --vendor", dup.code === 0, dup.out.split("\n").slice(-4).join(" | "));
  check("after docker:up: shop still none, admin still oidc", cfgOf("fei-shop").auth.kind === "none" && cfgOf("fei-admin").auth.kind === "oidc");
  const again = pso(ws, "frontend:publish", "fei-shop", "--env", "local");
  check("republishing fei-shop keeps auth none", again.code === 0 && cfgOf("fei-shop").auth.kind === "none");

  // what the edge serves, and what the backend still protects
  const p = plan(ws, "local", INFRA_HOOKS); const t = p.topology, ca = environmentCa(ws, t), map = localResolution(t);
  const get = async (url, token) => { const x = await netRequest({ url, method: "GET", ca, resolve: map, timeoutMs: 30_000, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: x.status, text: x.body.toString("utf8") }; };
  const shopFe = t.frontends.find((f) => f.name === "fei-shop"), adminFe = t.frontends.find((f) => f.name === "fei-admin");
  const sc = await get(`${shopFe.origin}${shopFe.basePath}pso-runtime-config.json`), ac = await get(`${adminFe.origin}${adminFe.basePath}pso-runtime-config.json`);
  check("the edge serves shop's configuration with auth none", sc.status === 200 && JSON.parse(sc.text).auth.kind === "none", sc.text.slice(0, 120));
  check("the edge serves admin's configuration with OIDC (Keycloak issuer)", ac.status === 200 && JSON.parse(ac.text).auth.kind === "oidc" && /realms/.test(JSON.parse(ac.text).auth.issuer), ac.text.slice(0, 160));
  const api = t.api.origin;
  check("protected GET /products without a token: 401", (await get(`${api}/products`)).status === 401);
  check("public GET /products/options: 200", (await get(`${api}/products/options`)).status === 200);

  // real Chrome: the public shell opens without sign-in; the admin shell still asks for it
  const leaf = new X509Certificate(readFileSync(join(ws, ".infra", "certs", "local", "edge", "tls.crt")));
  const spki = createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  browser = await chromium.launch({ channel: "chrome", args: ["--host-resolver-rules=MAP *.pso.localhost 127.0.0.1", `--ignore-certificate-errors-spki-list=${spki}`] });
  const shots = evidence ? join(evidence, "shots") : undefined; if (shots) mkdirSync(shots, { recursive: true });
  const open = async (url) => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const page = await ctx.newPage(); const s = { page, errors: [], api: [] }; page.on("pageerror", (e) => s.errors.push(e.message)); page.on("response", (x) => { const u = new URL(x.url()); if (u.host === new URL(api).host) s.api.push({ status: x.status(), path: u.pathname }); }); await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }); return s; };
  const shop = await open(shopFe.url); await shop.page.waitForTimeout(1500);
  const shopText = await shop.page.locator("body").innerText();
  if (shots) await shop.page.screenshot({ path: join(shots, "shop-public.png"), fullPage: true });
  check("browser: the shop shell opens on its own origin without a redirect to Keycloak", new URL(shop.page.url()).origin === shopFe.origin && !/realms\/|kc-login/.test(shop.page.url()), shop.page.url());
  check("browser: shop renders its full shell for an anonymous visitor (no sign-in card, no user, no sign-out)", /welcome/i.test(shopText) && !/sign in to shop|not configured|sign out/i.test(shopText) && !(await shop.page.locator("#kc-login").count()), shopText.slice(0, 200));
  await shop.page.goto(new URL("catalog", shopFe.url).href, { waitUntil: "networkidle", timeout: 60_000 }); await shop.page.waitForTimeout(2000);
  const cat = await shop.page.locator("body").innerText().catch(() => "");
  if (shots) await shop.page.screenshot({ path: join(shots, "shop-catalog-public.png"), fullPage: true });
  check("browser: the public Catalog microfrontend opens in the public shell", /catalog/i.test(cat) && !/access denied|sign in to|not configured|module unavailable/i.test(cat) && !(await shop.page.locator("#kc-login").count()), cat.slice(0, 200));
  await shop.page.goto(new URL("orders", shopFe.url).href, { waitUntil: "networkidle", timeout: 60_000 }); await shop.page.waitForTimeout(1500);
  const ord = await shop.page.locator("body").innerText().catch(() => "");
  if (shots) await shop.page.screenshot({ path: join(shots, "shop-orders-denied.png"), fullPage: true });
  check("browser: the protected Orders microfrontend (scopes) is denied in the public shell", /denied|403|requires|without sign-in/i.test(ord), ord.slice(0, 200));
  check("browser: no page error in the shop shell", shop.errors.length === 0, shop.errors.join(" | "));
  const admin = await open(adminFe.url); await admin.page.waitForTimeout(1500);
  if (shots) await admin.page.screenshot({ path: join(shots, "admin-before-sign-in.png"), fullPage: true });
  const adminText = await admin.page.locator("body").innerText();
  const atIdp = /realms\//.test(admin.page.url()) || (await admin.page.locator("#kc-login").count()) > 0;
  const offersSignIn = await admin.page.locator("button, a").filter({ hasText: /sign in|log in|continue/i }).count();
  check("browser: the admin shell still requires sign-in (Keycloak or its sign-in action)", atIdp || offersSignIn > 0, `${admin.page.url()} | ${adminText.slice(0, 120)}`);
  if (!atIdp && offersSignIn) { await admin.page.locator("button, a").filter({ hasText: /sign in|log in|continue/i }).first().click(); await admin.page.waitForSelector("#username", { timeout: 30_000 }).catch(() => undefined); }
  const pwd = readFileSync(join(ws, ".infra", "secrets", "local", "user-ana"), "utf8").trim();
  if (await admin.page.locator("#username").count()) { await admin.page.fill("#username", "ana"); await admin.page.fill("#password", pwd); await admin.page.click("#kc-login"); await admin.page.waitForURL((u) => u.origin === adminFe.origin, { timeout: 60_000 }).catch(() => undefined); await admin.page.waitForTimeout(2000); }
  if (shots) await admin.page.screenshot({ path: join(shots, "admin-signed-in.png"), fullPage: true });
  check("browser: ana signs in at Keycloak and returns to the admin shell", new URL(admin.page.url()).origin === adminFe.origin && !(await admin.page.locator("#kc-login").count()), admin.page.url());
  if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "frontend-auth.json"), JSON.stringify({ cli, results, shopApi: shop.api.slice(0, 20), at: new Date().toISOString() }, null, 2)); }
} finally {
  await browser?.close().catch(() => undefined);
  if (up && !a.includes("--keep")) pso(ws, "docker:down", "--volumes", "--yes");
  if (!a.includes("--keep")) { try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ } }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
