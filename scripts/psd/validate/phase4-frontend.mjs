// Phase 4: FEI and MEIs generated, built independently, published and driven in a real browser, using ONLY the installed protected distribution.
//   node scripts/psd/validate/phase4-frontend.mjs --label 0.1.0-alpha.1
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Evidence, makeIso, node, run } from "./iso.mjs";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const label = a[a.indexOf("--label") + 1] ?? "0.1.0-alpha.1";
const K = join(process.env.USERPROFILE, ".pso-psd");
const evDir = join(repo, "docs", "implementation", "evidence", "psd", label);
const ev = new Evidence(join(evDir, "validation-frontend.json"));
const iso = makeIso(join(K, "validation", "iso-dev"), { fresh: false });
const ver = join(iso.root, "pso", "versions", label);
const cli = join(ver, "node_modules", "@pso", "cli", "bin", "pso.js");
const pso = (args, o = {}) => node(iso, [cli, ...args], o);
const ws = join(iso.work, "fe");
const site = join(iso.work, "site");
const walk = (d, acc = []) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f, acc) : acc.push(f); } return acc; };
const digestOf = (dir) => { const h = createHash("sha256"); for (const f of walk(dir).sort()) h.update(f.slice(dir.length) + "\0").update(readFileSync(f)); return h.digest("hex").slice(0, 16); };
rmSync(ws, { recursive: true, force: true }); rmSync(site, { recursive: true, force: true });

let r = pso(["create", "workspace", "fe"], { cwd: iso.work }); ev.check("create workspace", r.status === 0, r.err);
r = pso(["create", "orchestrator", "gateway", "--port", "3102"], { cwd: ws }); ev.check("create orchestrator", r.status === 0, r.err);
r = pso(["create", "fei", "storefront"], { cwd: ws }); ev.check("create fei", r.status === 0, r.err.slice(0, 200));
for (const m of ["catalog-ui", "orders-ui"]) { r = pso(["create", "mei", m, "--host", "fei-storefront", "--register"], { cwd: ws }); ev.check(`create mei ${m} (registered with the FEI)`, r.status === 0, r.err.slice(0, 200) + r.out.slice(0, 120)); }
for (const c of [["frontend:validate"], ["frontend:inspect"], ["frontend:routes"], ["frontend:graph"]]) { r = pso(c, { cwd: ws }); ev.check(`pso ${c[0]}`, r.status === 0 && r.out.length > 20, r.out.split("\n").slice(0, 2).join(" | ") + r.err.slice(0, 160)); }

// ---- vendor + npm install (framework packages come from the installed protected distribution; rspack and React from the registry)
let t0 = Date.now();
r = pso(["frontend:install"], { cwd: ws, timeout: 1_800_000 });
ev.check("frontend:install vendors the protected framework packages and installs each project", r.status === 0, `${Math.round((Date.now() - t0) / 1000)} s ${r.status === 0 ? "" : (r.out + r.err).slice(-400)}`);

// ---- independent builds
const builds = {};
for (const p of ["catalog-ui", "orders-ui", "storefront"]) {
  t0 = Date.now();
  r = pso(["frontend:build", p, "--allow-dev-token", "--base-path", "/", "--version", "1.0.0"], { cwd: ws, timeout: 900_000 });
  builds[p] = Date.now() - t0;
  ev.check(`frontend:build ${p} (Rspack + Module Federation, hashed assets)`, r.status === 0, `${builds[p]} ms ${r.status === 0 ? "" : (r.out + r.err).slice(-400)}`);
}
const distOf = (p) => join(ws, "frontend", p.startsWith("fei") || p === "storefront" ? "fei-storefront" : `mei-${p}`, "dist");
const before = { fei: digestOf(distOf("storefront")), orders: digestOf(distOf("orders-ui")), catalog: digestOf(distOf("catalog-ui")) };
// change only the catalog MEI and rebuild only it: the other two builds must be byte-identical
const homeFile = join(ws, "frontend", "mei-catalog-ui", "src", "pages", "Home.tsx");
appendFileSync(homeFile, "\n// independent change\nexport const __probe = 1;\n");
r = pso(["frontend:build", "catalog-ui", "--allow-dev-token", "--base-path", "/", "--version", "1.0.1"], { cwd: ws, timeout: 900_000 });
const after = { fei: digestOf(distOf("storefront")), orders: digestOf(distOf("orders-ui")), catalog: digestOf(distOf("catalog-ui")) };
ev.check("independent releases: rebuilding one MEI changes only that MEI (FEI and the other MEI are byte-identical)", r.status === 0 && before.fei === after.fei && before.orders === after.orders && before.catalog !== after.catalog, JSON.stringify({ before, after }));

// ---- publish as a site root (immutable versions, atomic activation) and the runtime configuration
for (const p of ["storefront", "catalog-ui", "orders-ui"]) { r = pso(["frontend:publish", p, "--site", site, ...(p === "catalog-ui" ? ["--version", "1.0.1"] : [])], { cwd: ws }); ev.check(`frontend:publish ${p}`, r.status === 0, (r.out + r.err).split("\n").slice(0, 2).join(" | ")); }
r = pso(["frontend:config", "--site", site, "--auth", "dev-token"], { cwd: ws }); ev.check("frontend:config writes the runtime configuration (no secret)", r.status === 0 && !/PRIVATE|secret/i.test(readFileSync(join(site, "pso-runtime-config.json"), "utf8")), r.err.slice(0, 160));
r = pso(["frontend:releases", "--site", site], { cwd: ws }); ev.check("frontend:releases lists the active releases", r.status === 0 && /catalog-ui/.test(r.out), r.out.split("\n").slice(0, 3).join(" | "));

// ---- bundles delivered to the browser carry no private information
const bundleText = walk(site).filter((f) => /\.(js|css|html)$/.test(f) || /(pso-fei|manifest)\.json$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
const denylist = readFileSync(join(K, "denylist.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
ev.check("the published browser bundles and release manifests contain none of the private deny-list and no key material (the release audit trail history.json legitimately names the activating OS user)", !denylist.some((d) => bundleText.includes(d)) && !/BEGIN (RSA |EC )?PRIVATE KEY/.test(bundleText), `${walk(site).length} files in the site`);

// ---- real browser
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json" };
// the same mapping as the nginx server PSO generates: /pso-runtime-config.json, /_mei/ from the site root, /assets/ from the shared pool, root-level files and the SPA fallback
// from the ACTIVE shell release (fei/current is a symlink on a server; here the pointer file current.json says which version)
const currentFei = () => join(site, "fei", JSON.parse(readFileSync(join(site, "fei", "current.json"), "utf8")).version);
const fileFor = (u) => {
  if (u === "/pso-runtime-config.json") return join(site, "pso-runtime-config.json");
  if (u.startsWith("/_mei/")) return join(site, u);
  if (u.startsWith("/assets/")) return join(site, "fei", u);
  if (/^\/[^/]+\.[a-z0-9]+$/i.test(u)) return join(currentFei(), u.slice(1));
  if (/\.[a-z0-9]{2,5}$/i.test(u)) return null;
  return join(currentFei(), "index.html");
};
const srv = createServer((req, res) => {
  try {
    const u = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const f = fileFor(u);
    if (!f || !normalize(f).startsWith(site + sep) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    res.writeHead(200, { "content-type": mime[extname(f)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(f));
  } catch (e) { res.writeHead(500).end(String(e.message)); }
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const { chromium } = await import("file:///" + join(repo, "node_modules", "playwright-core", "index.mjs").replace(/\\/g, "/"));
const jose = await import("file:///" + join(ver, "node_modules", "jose", "dist", "webapi", "index.js").replace(/\\/g, "/"));
const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
// the scopes the generated FEI registration asks for (FEI.pso.ts: <mei>:read); the FEI hides what a user may not see and answers 403-style for a typed URL
const mkToken = (scope, sub) => new jose.SignJWT({ scope, name: sub }).setProtectedHeader({ alg: "ES256", kid: "dev" }).setSubject(sub).setIssuer("https://shop.local").setAudience("shop-api").setIssuedAt().setExpirationTime("1h").sign(kp.privateKey);
const token = await mkToken("catalog-ui:read orders-ui:read", "ana");
const limitedToken = await mkToken("catalog-ui:read", "bob");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [], failedReq = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  page.on("requestfailed", (q) => failedReq.push(q.url().replace(base, "")));
  await page.goto(`${base}/catalog-ui`, { waitUntil: "networkidle", timeout: 60_000 });
  const gate = await page.locator("textarea#dev-token").count();
  ev.check("a protected route redirects an anonymous visitor to the sign-in page (route guard in the FEI)", gate === 1, page.url().replace(base, ""));
  await page.fill("textarea#dev-token", token); await page.getByRole("button", { name: /Start session/i }).click();
  // the pasted token lives in memory only (a production build never persists it), so the session must NOT be dropped by a page reload: stay in the application
  await page.waitForURL((u) => u.pathname === "/catalog-ui", { timeout: 30_000 }).catch(() => {});
  ev.check("sign-in returns to the originally requested route without a reload (returnTo)", new URL(page.url()).pathname === "/catalog-ui", page.url().replace(base, ""));
  await page.waitForSelector("h1", { timeout: 30_000 }).catch(() => {});
  const h1 = await page.locator("main h1, h1").first().innerText({ timeout: 30_000 }).catch(() => "");
  ev.check("after sign-in the MEI is loaded through Module Federation and rendered inside the shell", /catalog/i.test(h1), `h1="${h1}"`);
  const signedAs = await page.getByText(/Signed in as/i).first().innerText({ timeout: 10_000 }).catch(() => "");
  ev.check("context propagates from the shell to the MEI (the MEI shows the signed-in user)", /ana/.test(signedAs), signedAs);
  // navigate through the shell (a client-side route change: the session survives and the second microfrontend is loaded on demand)
  const link = page.locator('a[href="/orders-ui"]').first();
  ev.check("the shell navigation lists the second microfrontend", (await link.count()) === 1, "");
  await link.click();
  await page.waitForURL((u) => u.pathname === "/orders-ui", { timeout: 30_000 }).catch(() => {});
  await page.waitForFunction(() => /orders/i.test(document.querySelector("h1")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
  const h2 = await page.locator("h1").first().innerText({ timeout: 30_000 }).catch(() => "");
  ev.check("navigation to the second MEI (independent release) works", /orders/i.test(h2), `h1="${h2}"`);
  const meiRequests = (await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name))).filter((n) => n.includes("/_mei/"));
  ev.check("MEI assets are served from their own immutable release paths under /_mei/", meiRequests.length > 0, `${meiRequests.length} requests e.g. ${meiRequests[0]?.replace(base, "")}`);
  ev.check("no uncaught page errors during the session", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: join(evDir, "frontend-orders.png") });

  // a user with only one of the scopes: the other microfrontend is neither listed nor reachable
  const page2 = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page2.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  await page2.goto(`${base}/catalog-ui`, { waitUntil: "networkidle", timeout: 60_000 });
  await page2.fill("textarea#dev-token", limitedToken); await page2.getByRole("button", { name: /Start session/i }).click();
  await page2.waitForURL((u) => u.pathname === "/catalog-ui", { timeout: 30_000 }).catch(() => {});
  await page2.waitForFunction(() => /catalog/i.test(document.querySelector("h1")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
  ev.check("a user with only catalog-ui:read sees the catalog microfrontend", /catalog/i.test(await page2.locator("h1").first().innerText().catch(() => "")));
  ev.check("the other microfrontend is hidden from the navigation of that user", (await page2.locator('a[href="/orders-ui"]').count()) === 0);
  await page2.evaluate(() => { window.history.pushState({}, "", "/orders-ui"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page2.waitForFunction(() => /denied|not allowed|forbidden/i.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
  const denied = await page2.locator("body").innerText().catch(() => "");
  ev.check("typing the other route shows Access denied and never loads the other microfrontend", /denied|not allowed|forbidden/i.test(denied) && !(await page2.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/_mei/mei-orders-ui/")))), denied.slice(0, 80).replace(/\s+/g, " "));
} finally { await browser.close(); srv.close(); }
ev.check("no failed network requests for application assets", failedReq.filter((u) => /\/_mei\/|\/assets\//.test(u)).length === 0, failedReq.slice(0, 3).join(", "));
ev.save({ label, buildMs: builds });
console.log(`\n${ev.checks.length - ev.failed}/${ev.checks.length} checks passed`);
process.exit(ev.failed ? 1 : 0);
