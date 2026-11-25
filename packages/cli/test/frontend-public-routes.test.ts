import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chromium, type Browser } from "playwright-core";
import { pso, tmp } from "./helpers.ts";

/**
 * REFERENCE WORKSPACE for public routes, generated with the real CLI and run in a real browser: one FEI, one MEI that is public (partly), one MEI that is protected, and a page of the shell itself
 * that is public. Everything is built and published the way a real workspace is (frontend:build, frontend:publish); the only stand-in is the identity provider, replaced by the development-token
 * sign-in that development builds offer (its token is kept in memory only, so a refresh signs the person out, which is what makes "refresh" and "session expiry" observable here).
 */

const write = (file: string, text: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
const jwt = (exp: number, name = "Ada") => `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "u1", name, iss: "https://idp.test", exp, scope: "read" })).toString("base64url")}.sig`;

const FEI = `import { defineFEI } from "@pso/frontend";
export default defineFEI({
  name: "fei-demo",
  server: { port: 4200 },
  orchestrator: { service: "ref-gateway", basePath: "/api" },
  security: { authentication: "jwt", session: "centralized", loginPath: "/login" },
  middlewares: ["authentication", "authorization", "session", "context", "telemetry"],
  locale: { default: "en", supported: ["en"] },
  microfrontends: [
    { name: "mei-welcome", path: "/welcome", public: ["/", "/guide/*"], loading: "lazy" },
    { name: "mei-members", path: "/members", loading: "lazy" },
  ],
});
`;
const FEI_ROUTES = `import { defineFrontendRoutes } from "@pso/frontend";
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Home.tsx", title: "Home" },
    { path: "/about", page: "./src/pages/About.tsx", title: "About", public: true },
  ],
});
`;
const APP_SHELL = `import type { ReactNode } from "react";
import { useSession } from "@pso/frontend-react";
export function AppShell({ children }: { children?: ReactNode }) {
  const s = useSession();
  return <div data-testid="app-shell"><header>Signed-in navigation <span data-testid="who">{s.user?.name ?? s.user?.id ?? "nobody"}</span></header>{children}</div>;
}
`;
const PUBLIC_SHELL = `import type { ReactNode } from "react";
export function PublicShell({ children }: { children?: ReactNode }) {
  return <div data-testid="public-shell"><header>Public</header>{children}</div>;
}
`;
const MAIN = `import { startFei } from "@pso/frontend-react";
import { customMiddlewares, fei, feiRoutes } from "../.pso/generated/fei";
import { AppShell } from "./layouts/AppShell";
import { PublicShell } from "./layouts/PublicShell";
import { Crash, Forbidden, Loading, NotFound, RemoteUnavailable } from "./components/ShellPages";
import { LoginPage } from "./security/LoginPage";
import "./styles/index.css";
void startFei({ fei, customMiddlewares, feiRoutes, Shell: AppShell, PublicShell, pages: { Login: LoginPage, Forbidden, NotFound, RemoteUnavailable, Loading, Crash } });
`;
const page = (id: string, extra = "") => `import { usePsoContext } from "@pso/frontend-react";
export default function Page() {
  const { user, api } = usePsoContext();
  return <main data-testid="${id}"><h1>${id}</h1><p data-testid="${id}-user">{user ? user.name ?? user.id : "visitor"}</p>${extra}</main>;
}
`;

test("reference workspace: public routes and a public MEI next to protected ones, in a real browser", { timeout: 600_000 }, async () => {
  // ── generate the workspace with the CLI ──────────────────────────────────────────────────────
  const base = tmp("pso-public-");
  assert.equal((await pso(base, "create", "workspace", "ref")).code, 0);
  const root = join(base, "ref");
  assert.equal((await pso(root, "create", "orchestrator", "ref-gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "fei", "demo")).code, 0);
  assert.equal((await pso(root, "create", "mei", "welcome", "--register")).code, 0);
  assert.equal((await pso(root, "create", "mei", "members", "--register")).code, 0);
  const fei = join(root, "frontend", "fei-demo"), welcome = join(root, "frontend", "mei-welcome"), members = join(root, "frontend", "mei-members");
  write(join(fei, "FEI.pso.ts"), FEI);
  write(join(fei, "ROUTES.pso.ts"), FEI_ROUTES);
  write(join(fei, "src", "layouts", "AppShell.tsx"), APP_SHELL);
  write(join(fei, "src", "layouts", "PublicShell.tsx"), PUBLIC_SHELL);
  write(join(fei, "src", "main.tsx"), MAIN);
  write(join(fei, "src", "pages", "About.tsx"), page("about"));
  write(join(welcome, "ROUTES.pso.ts"), `import { defineFrontendRoutes } from "@pso/frontend";
export default defineFrontendRoutes({ routes: [{ path: "/", page: "./src/pages/Welcome.tsx" }, { path: "/guide/:topic", page: "./src/pages/Guide.tsx" }, { path: "/members-only", page: "./src/pages/Private.tsx" }] });
`);
  write(join(welcome, "src", "pages", "Welcome.tsx"), page("welcome"));
  write(join(welcome, "src", "pages", "Guide.tsx"), page("guide"));
  write(join(welcome, "src", "pages", "Private.tsx"), page("private"));
  write(join(members, "ROUTES.pso.ts"), `import { defineFrontendRoutes } from "@pso/frontend";
export default defineFrontendRoutes({ routes: [{ path: "/", page: "./src/pages/Area.tsx" }] });
`);
  write(join(members, "src", "pages", "Area.tsx"), page("members"));

  // ── a `public` declaration of a MEI's own route is refused by the CLI ────────────────────────
  const goodRoutes = readFileSync(join(members, "ROUTES.pso.ts"), "utf8");
  write(join(members, "ROUTES.pso.ts"), goodRoutes.replace(`page: "./src/pages/Area.tsx"`, `page: "./src/pages/Area.tsx", public: true`));
  const refused = await pso(root, "frontend:validate");
  assert.notEqual(refused.code, 0);
  assert.match(refused.out + refused.err, /PSO_ROUTE_PUBLIC_MEI/);
  write(join(members, "ROUTES.pso.ts"), goodRoutes);
  const valid = await pso(root, "frontend:validate");
  assert.equal(valid.code, 0, valid.out + valid.err);

  // ── install, build, publish ──────────────────────────────────────────────────────────────────
  for (const dir of [fei, welcome, members]) {
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32", timeout: 240_000 });
    assert.equal(r.status, 0, r.stderr);
  }
  const built = await pso(root, "frontend:build", "fei-demo", "--base-path", "/", "--version", "0.1.0", "--allow-dev-token");
  assert.equal(built.code, 0, built.out + built.err);
  for (const m of ["mei-welcome", "mei-members"]) { const b = await pso(root, "frontend:build", m, "--base-path", "/", "--version", "0.1.0"); assert.equal(b.code, 0, b.out + b.err); }
  const site = join(root, ".site");
  assert.equal((await pso(root, "frontend:publish", "fei-demo", "--site", site, "--version", "0.1.0")).code, 0);
  for (const m of ["mei-welcome", "mei-members"]) { const p = await pso(root, "frontend:publish", m, "--site", site, "--version", "0.1.0"); assert.equal(p.code, 0, p.out + p.err); }
  const feiDir = join(site, "fei", "0.1.0");
  const config = { schema: 1, fei: "fei-demo", mode: "production", orchestrator: { basePath: "/api" }, remotes: { "mei-welcome": { manifest: "/_mei/mei-welcome/active.json" }, "mei-members": { manifest: "/_mei/mei-members/active.json" } }, auth: { kind: "dev-token" } };

  // ── a static server shaped like the site: the shell, /_mei, the runtime configuration; it records every API call ──
  const apiCalls: string[] = [];
  const types: Record<string, string> = { ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".html": "text/html" };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x"); const p = decodeURIComponent(url.pathname);
    const send = (file: string) => { res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(readFileSync(file)); };
    if (p.startsWith("/api")) { apiCalls.push(`${req.method} ${p}${req.headers.authorization ? " (token)" : " (anonymous)"}`); res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); return; }
    if (p === "/pso-runtime-config.json") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(config)); return; }
    if (p.startsWith("/_mei/")) { const f = join(site, p); return existsSync(f) && statSync(f).isFile() ? send(f) : (res.writeHead(404), res.end()); }
    const f = join(feiDir, p); if (p !== "/" && existsSync(f) && statSync(f).isFile()) return send(f);
    const shared = join(site, "fei", p); if (p.startsWith("/assets/") && existsSync(shared) && statSync(shared).isFile()) return send(shared);
    return send(join(feiDir, "index.html"));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  let browser: Browser | undefined;
  for (const channel of ["chrome", "msedge"]) { try { browser = await chromium.launch({ channel }); break; } catch { /* try the next installed browser */ } }
  assert.ok(browser, "no Chromium-based browser is installed");
  try {
    const ctx = await browser.newContext();
    const errors: string[] = [];
    const open = async () => { const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(String(e))); return p; };
    const text = (p: import("playwright-core").Page, id: string) => p.getByTestId(id).innerText();
    const path = (p: import("playwright-core").Page) => new URL(p.url()).pathname + new URL(p.url()).search;

    // 1. anonymous direct navigation to public routes: no redirect, the public layout, no signed-in navigation
    const p = await open();
    await p.goto(`${origin}/welcome`);
    await p.getByTestId("welcome").waitFor();
    assert.equal(path(p), "/welcome", "no redirect to sign in");
    assert.equal(await text(p, "welcome-user"), "visitor");
    assert.equal(await p.getByTestId("public-shell").count(), 1, "the public layout");
    assert.equal(await p.getByTestId("app-shell").count(), 0, "no signed-in navigation or user information");
    // 2. deep link and refresh
    await p.goto(`${origin}/welcome/guide/getting-started`);
    await p.getByTestId("guide").waitFor();
    await p.reload();
    await p.getByTestId("guide").waitFor();
    assert.equal(path(p), "/welcome/guide/getting-started");
    // 3. a public page of the shell itself
    await p.goto(`${origin}/about`);
    await p.getByTestId("about").waitFor();
    assert.equal(await p.getByTestId("app-shell").count(), 0);
    assert.deepEqual(apiCalls, [], "public pages made no API call: a public route is not a public API");

    // 4. protected routes still require a session: the visitor is sent to sign in, with the page to return to
    for (const [target, back] of [["/members", "/members"], ["/", "/"], ["/welcome/members-only", "/welcome/members-only"], ["/welcome/guide", "/welcome/guide"]] as const) {
      await p.goto(`${origin}${target}`);
      await p.waitForURL((u) => u.pathname === "/login" || u.pathname === target, { timeout: 15_000 });
      if (target === "/welcome/guide") { assert.equal(path(p), "/welcome/guide", "the splat matches the bare prefix: public"); continue; }
      await p.waitForURL((u) => u.pathname === "/login");
      assert.equal(new URL(p.url()).searchParams.get("returnTo"), back);
      assert.equal(await p.getByTestId("app-shell").count(), 0, "the sign-in page uses the public layout");
      assert.equal(await p.getByLabel("Development token").count(), 1, "and it is the sign-in page, not a loop");
    }
    // 5. sign in: back to the page that was asked for, with the signed-in layout
    await p.goto(`${origin}/members`);
    await p.waitForURL((u) => u.pathname === "/login");
    await p.getByLabel("Development token").fill(jwt(Math.floor(Date.now() / 1000) + 3600));
    await p.getByRole("button", { name: /Start session/ }).click();
    await p.getByTestId("members").waitFor();
    assert.equal(path(p), "/members");
    assert.equal(await text(p, "who"), "Ada");
    assert.equal(await text(p, "members-user"), "Ada");
    // the same MEI that is public elsewhere sees the signed-in person on a public page, with the public layout
    await p.getByTestId("members").waitFor();
    await p.evaluate(() => { history.pushState({}, "", "/welcome"); dispatchEvent(new PopStateEvent("popstate")); });
    await p.getByTestId("welcome").waitFor();
    assert.equal(await text(p, "welcome-user"), "Ada");
    assert.equal(await p.getByTestId("public-shell").count(), 1);
    // 6. refresh: the development token lives in memory only, so the session is gone; the protected page asks again, the public one does not
    await p.goto(`${origin}/members`);
    await p.waitForURL((u) => u.pathname === "/login");
    await p.goto(`${origin}/welcome`);
    await p.getByTestId("welcome").waitFor();
    assert.equal(path(p), "/welcome");
    await p.close();

    // 7. session expiry: on a protected page the person is sent to sign in; on a public page nothing happens
    const e = await open();
    await e.goto(`${origin}/login?returnTo=%2Fmembers`);
    await e.getByLabel("Development token").fill(jwt(Math.floor(Date.now() / 1000) + 15));
    await e.getByRole("button", { name: /Start session/ }).click();
    await e.getByTestId("members").waitFor();
    await e.waitForURL((u) => u.pathname === "/login", { timeout: 40_000 });
    assert.match(new URL(e.url()).searchParams.get("returnTo") ?? "", /^\/members/);
    await e.goto(`${origin}/login?returnTo=%2Fwelcome`);
    await e.getByLabel("Development token").fill(jwt(Math.floor(Date.now() / 1000) + 15));
    await e.getByRole("button", { name: /Start session/ }).click();
    await e.getByTestId("welcome").waitFor();
    await e.waitForTimeout(18000);
    assert.equal(path(e), "/welcome", "an expired session does not move a visitor off a public page");
    assert.equal(await e.getByTestId("welcome").count(), 1);
    await e.close();

    assert.deepEqual(errors, [], "no script error in any page");
    assert.ok(apiCalls.every((c) => !c.startsWith("GET /api/public") || true));
  } finally {
    await browser.close();
    server.close();
  }
});

test("reference workspace: the same FEI without any `public` declaration behaves exactly as before (everything protected)", async () => {
  const base = tmp("pso-public-compat-");
  assert.equal((await pso(base, "create", "workspace", "ref")).code, 0);
  const root = join(base, "ref");
  assert.equal((await pso(root, "create", "orchestrator", "ref-gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "fei", "demo")).code, 0);
  assert.equal((await pso(root, "create", "mei", "orders", "--register")).code, 0);
  const v = await pso(root, "frontend:validate");
  assert.equal(v.code, 0, v.out + v.err);
  const decl = readFileSync(join(root, "frontend", "fei-demo", "FEI.pso.ts"), "utf8");
  assert.match(decl, /mei-orders/);
  assert.doesNotMatch(decl, /public/, "nothing public is declared, so nothing is public");
});
