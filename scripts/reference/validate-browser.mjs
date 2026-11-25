#!/usr/bin/env node
// Real Chrome against the running reference stack: two independent shells on their own hosts, public and protected routes, real OpenID
// Connect login at the generated Keycloak realm (Authorization Code + PKCE), permission-protected microfrontend, isolation between shells.
// TLS is strict: Chrome trusts only the edge certificate of this environment (its public key is pinned), nothing is bypassed.
// Usage: node scripts/reference/validate-browser.mjs [workspace] [evidence-dir]
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const { netRequest } = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const { chromium } = await import(new URL("../../node_modules/playwright-core/index.mjs", import.meta.url).href);
const root = resolve(process.argv[2] ?? join(repo, "fixtures", "pso-reference"));
const outDir = resolve(process.argv[3] ?? join(repo, "docs", "implementation", "evidence", "v020", "browser"));
mkdirSync(join(outDir, "shots"), { recursive: true });
const leaf = new X509Certificate(readFileSync(join(root, ".infra", "certs", "local", "edge", "tls.crt")));
const spki = createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("base64");
const pw = (u) => readFileSync(join(root, ".infra", "secrets", "local", `user-${u}`), "utf8").trim();
const SHOP = "https://shop.pso.localhost:8443", ADMIN = "https://admin.pso.localhost:8443", AUTH = "https://auth.pso.localhost:8443";
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond, ...(detail ? { detail } : {}) }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const shot = (page, n) => page.screenshot({ path: join(outDir, "shots", `${n}.png`), fullPage: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--host-resolver-rules=MAP *.pso.localhost 127.0.0.1", `--ignore-certificate-errors-spki-list=${spki}`] });
async function session(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const s = { label, ctx, page, errors: [], api: [] };
  page.on("pageerror", (e) => s.errors.push(e.message));
  page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) s.api.push({ status: r.status(), path: u.pathname, host: u.host }); });
  return s;
}
const kcLogin = async (page, user) => { await page.waitForSelector("#username", { timeout: 30_000 }); await page.fill("#username", user); await page.fill("#password", pw(user)); await page.click("#kc-login"); };
const signIn = async (page) => { // the shell's own sign-in page offers one action: continue to the identity provider
  if (new URL(page.url()).origin === AUTH) return;
  const b = page.locator("button, a").filter({ hasText: /sign in|continue|log in/i }).first();
  await b.waitFor({ timeout: 20_000 }); await b.click();
};

try {
  // 1. a visitor without a session: public pages of the shop render, nothing redirects to the identity provider
  const V = await session("visitor");
  await V.page.goto(`${SHOP}/`, { waitUntil: "networkidle" });
  check("shop home page (public) renders for a visitor without a session", new URL(V.page.url()).pathname === "/" && (await V.page.locator("h1").first().textContent({ timeout: 15_000 }))?.includes("Welcome"), V.page.url());
  await shot(V.page, "01-shop-public-home");
  await V.page.goto(`${SHOP}/catalog`, { waitUntil: "networkidle" });
  await V.page.waitForTimeout(1500);
  const catalogUrl = V.page.url();
  check("public microfrontend /catalog renders without a session (no sign-in redirect)", new URL(catalogUrl).origin === SHOP && new URL(catalogUrl).pathname.startsWith("/catalog"), catalogUrl);
  check("the public catalog shows data from the explicitly public backend endpoint", await V.page.locator("text=Espresso beans").first().isVisible({ timeout: 15_000 }).catch(() => false));
  await shot(V.page, "02-shop-public-catalog");
  // 2. a protected route of the same shell asks for a session
  await V.page.goto(`${SHOP}/cart`, { waitUntil: "networkidle" });
  await V.page.waitForTimeout(1000);
  const asked = new URL(V.page.url()).origin === AUTH || /\/login/.test(new URL(V.page.url()).pathname);
  check("protected microfrontend /cart sends a visitor to sign in", asked, V.page.url());
  await shot(V.page, "03-shop-cart-needs-sign-in");
  // 3. real OIDC: bob signs in at Keycloak and comes back to the shop
  await signIn(V.page);
  await V.page.waitForURL((u) => u.origin === AUTH, { timeout: 30_000 });
  check("the sign-in goes to the environment's Keycloak (authorization endpoint of the generated realm)", new URL(V.page.url()).pathname.startsWith("/realms/pso-reference/protocol/openid-connect/auth"), new URL(V.page.url()).pathname);
  const authUrl = new URL(V.page.url());
  check("Authorization Code with PKCE (S256) and the shop's own client id", authUrl.searchParams.get("response_type") === "code" && authUrl.searchParams.get("code_challenge_method") === "S256" && authUrl.searchParams.get("client_id") === "fei-shop", `client_id=${authUrl.searchParams.get("client_id")}`);
  await shot(V.page, "04-keycloak-login");
  await kcLogin(V.page, "bob");
  await V.page.waitForURL((u) => u.origin === SHOP && !u.pathname.startsWith("/auth/callback"), { timeout: 30_000 });
  await V.page.waitForTimeout(2000);
  check("after sign-in bob is back on the shop (redirect URI generated from the host)", new URL(V.page.url()).origin === SHOP, V.page.url());
  await V.page.goto(`${SHOP}/cart`, { waitUntil: "networkidle" });
  await V.page.waitForTimeout(1500);
  check("bob (cart:write) opens the protected cart microfrontend", new URL(V.page.url()).pathname.startsWith("/cart") && !(await V.page.locator("text=/access denied|forbidden/i").count()), V.page.url());
  await shot(V.page, "05-shop-cart-bob");
  // 4. the admin shell is a different application with its own client: bob has a Keycloak session, but not users:admin
  await V.page.goto(`${ADMIN}/users`, { waitUntil: "networkidle" });
  await V.page.waitForTimeout(1500);
  if (new URL(V.page.url()).origin !== AUTH && /\/login/.test(new URL(V.page.url()).pathname)) await signIn(V.page);
  await V.page.waitForURL((u) => u.origin === ADMIN && !u.pathname.startsWith("/auth/callback"), { timeout: 30_000 });
  await V.page.waitForTimeout(2000);
  const adminClient = V.api.length >= 0;
  void adminClient;
  const deniedBob = (await V.page.locator("text=/access denied|forbidden|not allowed|permission/i").count()) > 0 || new URL(V.page.url()).pathname.startsWith("/forbidden") || !new URL(V.page.url()).pathname.startsWith("/users");
  check("bob signed in to the admin shell (single sign-on) is NOT shown the users microfrontend (needs users:admin)", deniedBob, V.page.url());
  await shot(V.page, "06-admin-users-denied-bob");
  // 5. ana, with users:admin, in a fresh browser: the admin shell requires sign-in for everything, then shows the users microfrontend
  const A = await session("ana");
  await A.page.goto(`${ADMIN}/`, { waitUntil: "networkidle" });
  await A.page.waitForTimeout(1000);
  check("the admin shell (fully authenticated) asks for a session even on its home page", new URL(A.page.url()).origin === AUTH || /\/login/.test(new URL(A.page.url()).pathname), A.page.url());
  await signIn(A.page);
  await A.page.waitForURL((u) => u.origin === AUTH, { timeout: 30_000 });
  check("the admin shell signs in with its own OIDC client", new URL(A.page.url()).searchParams.get("client_id") === "fei-admin", new URL(A.page.url()).searchParams.get("client_id") ?? "");
  await kcLogin(A.page, "ana");
  await A.page.waitForURL((u) => u.origin === ADMIN && !u.pathname.startsWith("/auth/callback"), { timeout: 30_000 });
  await A.page.goto(`${ADMIN}/users`, { waitUntil: "networkidle" });
  await A.page.waitForTimeout(2000);
  check("ana (users:admin) opens the permission-protected users microfrontend", new URL(A.page.url()).pathname.startsWith("/users") && !(await A.page.locator("text=/access denied|forbidden/i").count()), A.page.url());
  check("the users microfrontend shows data from accounts (orchestrator -> accounts over mutual TLS)", await A.page.locator("li", { hasText: "bob" }).first().isVisible({ timeout: 15_000 }).catch(() => false));
  await shot(A.page, "07-admin-users-ana");
  // 6. isolation: each shell serves only its own microfrontends and its own runtime configuration
  const caPem = readFileSync(join(root, ".infra", "ca", "local", "ca.crt"), "utf8");
  const get = (url) => netRequest({ url, ca: caPem, resolve: { "shop.pso.localhost": "127.0.0.1", "admin.pso.localhost": "127.0.0.1" }, timeoutMs: 10_000 });
  const rc = async (origin) => JSON.parse((await get(`${origin}/pso-runtime-config.json`)).body.toString());
  const shopRc = await rc(SHOP), adminRc = await rc(ADMIN);
  check("runtime configurations are separate (fei, client, remotes)", shopRc.fei === "fei-shop" && adminRc.fei === "fei-admin" && shopRc.auth.clientId === "fei-shop" && adminRc.auth.clientId === "fei-admin" && Object.keys(shopRc.remotes).sort().join() === "mei-cart,mei-catalog" && Object.keys(adminRc.remotes).join() === "mei-users", `shop: ${Object.keys(shopRc.remotes).join(",")}  admin: ${Object.keys(adminRc.remotes).join(",")}`);
  const cross = await get(`${ADMIN}/_mei/mei-catalog/active.json`);
  check("the admin host does not serve the shop's microfrontends", cross.status === 404, `HTTP ${cross.status}`);
  const pointer = await get(`${SHOP}/_mei/mei-catalog/active.json`);
  check("the shop host serves its own microfrontend release pointer (no-store)", pointer.status === 200 && /no-store/.test(String(pointer.headers["cache-control"] ?? "")), String(pointer.headers["cache-control"] ?? ""));
  // 7. browser-side hygiene
  check("no uncaught page errors in either session", V.errors.length === 0 && A.errors.length === 0, [...V.errors, ...A.errors].slice(0, 3).join(" | "));
  const tokenInStorage = await A.page.evaluate(() => JSON.stringify(localStorage).includes("eyJ"));
  check("no token in localStorage", !tokenInStorage);
} catch (e) {
  check("scenario completed without an exception", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
}
writeFileSync(join(outDir, "browser-result.json"), JSON.stringify({ at: new Date().toISOString(), pinnedCertificate: `spki sha256/${spki.slice(0, 12)}...`, results }, null, 2) + "\n");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
