import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ALL_COMMANDS } from "../src/registry.ts";
import { buildSite, serveSite, collectPages, aiMeta } from "../src/portal/build.ts";
import { buildScopes, composeContext, resolveSelection, wrapFormat } from "../src/portal/ai.ts";
import { tmp } from "./helpers.ts";

let browser: Browser | undefined, skip: string | false = false, base = "", server: Awaited<ReturnType<typeof serveSite>> | undefined, dir = "";
const SHOTS = process.env["PSO_SCREENSHOTS"];
const AXE = readFileSync(join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8");

before(async () => {
  dir = tmp("pso-browser-");
  buildSite(dir, ALL_COMMANDS);
  server = await serveSite(dir);
  base = server.url;
  for (const channel of ["chrome", "msedge"]) {
    try { browser = await chromium.launch({ channel }); break; } catch { /* try the next installed browser */ }
  }
  if (!browser) skip = "no Chrome or Edge installation found for Playwright";
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } });

async function open(path: string, o: { width?: number; height?: number; theme?: "dark" | "light"; permissions?: string[]; bypassCSP?: boolean } = {}): Promise<{ page: Page; ctx: BrowserContext; errors: string[] }> {
  const ctx = await browser!.newContext({ viewport: { width: o.width ?? 1440, height: o.height ?? 900 }, colorScheme: o.theme ?? "dark", permissions: o.permissions ?? [], bypassCSP: o.bypassCSP ?? false, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/__pso/version")) errors.push(`${r.status()} ${r.url()}`); });
  page.on("requestfailed", (r) => errors.push(`failed ${r.url()}`));
  await page.goto(base + path);
  await page.waitForLoadState("networkidle");
  return { page, ctx, errors };
}
const bg = (p: Page) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** Windows turns LF into CRLF in the system clipboard; that is the platform, not the content. */
const clip = async (p: Page) => (await p.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");

test("theme: follows the system preference, switches, persists across reloads and changes real colors", { skip }, async () => {
  const { page, ctx, errors } = await open("getting-started/introduction.html", { theme: "dark" });
  try {
    assert.equal(await page.getAttribute("html", "data-theme"), "dark");
    const dark = await bg(page);
    await page.click("#theme-toggle");
    assert.equal(await page.getAttribute("html", "data-theme"), "light");
    assert.equal(await page.getAttribute("#theme-toggle", "aria-pressed"), "true");
    const light = await bg(page);
    assert.notEqual(dark, light);
    await page.reload();
    assert.equal(await page.getAttribute("html", "data-theme"), "light", "persisted");
    assert.equal(await bg(page), light);
    await page.click("#theme-toggle");
    assert.equal(await page.getAttribute("html", "data-theme"), "dark");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
  const l = await open("index.html", { theme: "light" });
  try { assert.equal(await l.page.getAttribute("html", "data-theme"), "light", "system light preference"); } finally { await l.ctx.close(); }
});

test("search: opens by shortcut, finds commands, decorators, error codes and config, navigates by keyboard", { skip }, async () => {
  const { page, ctx, errors } = await open("getting-started/introduction.html");
  try {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".search-dialog.is-open");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "search-input");
    assert.equal(await page.getAttribute(".search-input", "role"), "combobox");

    await page.fill(".search-input", "make:route");
    await page.waitForSelector(".search-result");
    const first = await page.textContent(".search-result .sr-head");
    assert.match(first!, /pso make:route/);
    assert.equal(await page.getAttribute(".search-result", "aria-selected"), "true");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getAttribute(".search-input", "aria-activedescendant"), "sr-1");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForURL(/cli\/make-route\.html/);

    for (const [q, url] of [["PSO_ROUTE_004", /reference\/diagnostics\.html#pso-route-004/], ["RestController", /reference\/decorators\.html#restcontroller/], ["security.jwt.issuer", /reference\/config\.html#security-jwt-issuer/], ["deny by default", /decisions\/why-deny-by-default\.html|concepts\/security-by-default\.html|security\/secure-routing\.html/]] as Array<[string, RegExp]>) {
      await page.keyboard.press("/");
      await page.waitForSelector(".search-dialog.is-open");
      await page.fill(".search-input", q);
      await page.waitForSelector(".search-result");
      await page.keyboard.press("Enter");
      await page.waitForURL(url);
    }
    await page.keyboard.press("Control+k");
    await page.fill(".search-input", "zzzqqqxxx");
    assert.match((await page.textContent(".search-empty"))!, /No results/);
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible(".search-dialog"), false);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("code blocks: copy buttons copy the exact code, are keyboard reachable and announce the result", { skip }, async () => {
  const { page, ctx } = await open("orchestrator/module.html", { permissions: ["clipboard-read", "clipboard-write"] });
  try {
    const expected = readFileSync(join(process.cwd(), "packages", "cli", "docs", "examples", "users", "MODULE.pso.ts"), "utf8").replace(/\n$/, "");
    const btn = page.locator("button.copy").first();
    assert.match((await btn.getAttribute("aria-label"))!, /Copy code of src\/modules\/users\/MODULE\.pso\.ts/);
    await btn.focus();
    await page.keyboard.press("Enter");
    assert.equal(await clip(page), expected);
    assert.equal((await btn.textContent())?.trim(), "Copied");
    await page.waitForFunction(() => /Copied/.test(document.getElementById("sr-status")?.textContent ?? ""));
    await page.waitForFunction(() => document.querySelector("button.copy .copy-label")?.textContent === "Copy");
    assert.equal(await page.getAttribute("figure.code pre", "tabindex"), "0", "scrollable code is keyboard focusable");
    assert.ok((await page.locator("figure.code .line").count()) > 5);
  } finally { await ctx.close(); }
});

test("responsive: no horizontal overflow on desktop, tablet and mobile; mobile navigation works", { skip, timeout: 240_000 }, async () => {
  const pages = ["index.html", "getting-started/first-endpoint.html", "orchestrator/routes.html", "cli/make-route.html", "ai-context/builder.html", "reference/diagnostics.html", "security/attack-prevention.html", "dispatch/overview.html"];
  for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    for (const p of pages) {
      const { page, ctx, errors } = await open(p, vp);
      try {
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 0, `${p} at ${vp.width}px overflows by ${over}px`);
        assert.deepEqual(errors, [], p);
        if (SHOTS && vp.width !== 320) await page.screenshot({ path: join(SHOTS, `${p.replace(/\W+/g, "_")}-${vp.width}.png`), fullPage: false });
      } finally { await ctx.close(); }
    }
  }
  const { page, ctx } = await open("orchestrator/routes.html", { width: 390, height: 844 });
  try {
    assert.equal(await page.isVisible("#sidebar"), false, "drawer is closed on mobile");
    await page.click(".menu-btn");
    assert.equal(await page.getAttribute(".menu-btn", "aria-expanded"), "true");
    assert.equal(await page.isVisible("#sidebar"), true);
    await page.click('#sidebar a:has-text("Guards")');
    await page.waitForURL(/orchestrator\/guards\.html/);
    await page.click(".menu-btn");
    await page.keyboard.press("Escape");
    assert.equal(await page.getAttribute(".menu-btn", "aria-expanded"), "false");
  } finally { await ctx.close(); }
});

test("diagrams are interactive and keyboard operable; tabs work with arrow keys", { skip }, async () => {
  const { page, ctx } = await open("index.html");
  try {
    const fig = page.locator('figure[data-diagram="lifecycle"]');
    await fig.scrollIntoViewIfNeeded();
    const node = fig.locator('[data-node="3"]');
    await node.focus();
    await page.keyboard.press("Enter");
    assert.equal(await node.getAttribute("aria-pressed"), "true");
    assert.ok(await fig.locator('li[data-step="3"]').evaluate((e) => e.classList.contains("is-active")));
    assert.match(await fig.locator('li[data-step="3"]').innerText(), /Authentication/);
    await fig.locator('[data-node="5"]').click();
    assert.equal(await node.getAttribute("aria-pressed"), "false");
    assert.match(await fig.getAttribute("data-diagram") ?? "", /lifecycle/);
    assert.ok((await page.locator("svg.dg title").count()) >= 3, "diagrams have accessible titles");
  } finally { await ctx.close(); }
  const t = await open("getting-started/first-microservice.html");
  try {
    const tabs = t.page.locator('[role="tab"]');
    assert.equal(await tabs.count(), 2);
    await tabs.first().focus();
    assert.equal(await tabs.first().getAttribute("aria-selected"), "true");
    await t.page.keyboard.press("ArrowRight");
    assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
    assert.equal(await t.page.locator('[role="tabpanel"]').nth(0).isHidden(), true);
    assert.match(await t.page.locator('[role="tabpanel"]:visible').innerText(), /\.\/mvnw test/);
    await t.page.keyboard.press("ArrowLeft");
    assert.match(await t.page.locator('[role="tabpanel"]:visible').innerText(), /mvnw\.cmd test/);
  } finally { await t.ctx.close(); }
});

test("navigation: collapsible sections persist, active heading is tracked in the table of contents", { skip }, async () => {
  const { page, ctx } = await open("orchestrator/routes.html", { height: 700 });
  try {
    const sec = page.locator('details.nav-section[data-section="security"]');
    assert.equal(await sec.evaluate((d: HTMLDetailsElement) => d.open), false);
    await sec.locator("summary").click();
    assert.equal(await sec.evaluate((d: HTMLDetailsElement) => d.open), true);
    await page.reload();
    assert.equal(await page.locator('details.nav-section[data-section="security"]').evaluate((d: HTMLDetailsElement) => d.open), true, "state persisted");
    assert.equal(await page.locator('details.nav-section[data-section="orchestrator"]').evaluate((d: HTMLDetailsElement) => d.open), true, "active section stays open");
    await page.locator("#what-is-validated").scrollIntoViewIfNeeded();
    await page.evaluate(() => document.getElementById("what-is-validated")!.scrollIntoView());
    await page.waitForSelector('.toc a.is-active');
    assert.match((await page.textContent(".toc a.is-active"))!, /What is validated|Generate routes|Why decorators/);
  } finally { await ctx.close(); }
});

test("AI context builder: combination, size estimate, formats, copy and download match the CLI output exactly", { skip }, async () => {
  const meta = aiMeta(ALL_COMMANDS, collectPages(ALL_COMMANDS));
  const scopes = buildScopes(meta);
  const server = (ids: string[]) => composeContext(resolveSelection(scopes, ids), meta);
  const { page, ctx, errors } = await open("ai-context/builder.html", { permissions: ["clipboard-read", "clipboard-write"] });
  try {
    await page.waitForSelector("#ai-builder .ai-card");
    assert.equal(await page.locator("#ai-builder .ai-card").count(), scopes.length - 1, "one card per scope except the always-included core");
    const text = () => page.inputValue("#ai-builder textarea");
    const stats = () => page.textContent('#ai-builder [role="status"]');

    assert.equal((await text()).replace(/\r\n/g, "\n"), composeContext(resolveSelection(scopes, "complete"), meta), "default = complete framework context");
    await page.click('#ai-builder button:has-text("Clear")');
    assert.match((await stats())!, /core \+ none/);
    await page.check("#ai-security");
    await page.check("#ai-add-protected-route");
    assert.equal(await text(), server(["security", "add-protected-route"]), "browser text equals CLI text");
    assert.match((await stats())!, /estimate: characters \/ 4, not a tokenizer count/);
    assert.match((await stats())!, new RegExp(`${(await text()).length.toLocaleString("en-US").replace(/,/g, "[,.]")} characters`));

    await page.selectOption('#ai-builder select', "agents");
    assert.equal(await text(), wrapFormat("agents", server(["security", "add-protected-route"]), "0.2.0", []));
    await page.selectOption('#ai-builder select', "claude");
    assert.match(await text(), /^# CLAUDE\.md/);
    await page.selectOption('#ai-builder select', "copilot");
    assert.match(await text(), /^# Copilot instructions/);
    await page.selectOption('#ai-builder select', "markdown");

    await page.click('#ai-builder button:has-text("Copy context")');
    assert.equal(await clip(page), await text());
    await page.locator("#ai-builder .ai-card", { hasText: "Task: configure JWT" }).locator("button").click();
    assert.equal(await clip(page), server(["configure-jwt"]), "per-card copy = core + required + that scope");

    await page.selectOption('#ai-builder select', "claude");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click('#ai-builder button:has-text("Download")')]);
    assert.equal(download.suggestedFilename(), "CLAUDE.md");
    assert.equal(readFileSync((await download.path())!, "utf8"), await text());

    await page.reload();
    await page.waitForSelector("#ai-builder .ai-card");
    assert.equal(await page.isChecked("#ai-security"), true, "selection persisted");
    assert.equal(await page.isChecked("#ai-architecture"), false);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
  const one = await open("ai-context/scopes/security.html", { permissions: ["clipboard-read", "clipboard-write"] });
  try {
    await one.page.click("[data-copy-scope=security]");
    assert.equal(await clip(one.page), server(["security"]));
  } finally { await one.ctx.close(); }
});

test("favicon: the PSO Games icon loads in the browser from every page depth", { skip }, async () => {
  for (const p of ["index.html", "orchestrator/routes.html"]) {
    const { page, ctx, errors } = await open(p);
    try {
      const hrefs = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (ls) => ls.map((l) => (l as HTMLLinkElement).href));
      assert.equal(hrefs.length, 3);
      for (const h of hrefs) { const r = await page.request.get(h); assert.equal(r.status(), 200, h); assert.ok((await r.body()).length > 100, h); }
      const svg = await page.request.get(hrefs.find((h) => h.endsWith(".svg"))!);
      assert.match(svg.headers()["content-type"]!, /image\/svg\+xml/);
      assert.ok((await svg.text()).includes("linearGradient"));
      const logoOk = await page.$eval(".brand img", (i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0);
      assert.equal(logoOk, true, "header logo renders");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});

test("static hosting: the built site makes no request the host cannot answer and logs no console error (F-29)", { skip }, async () => {
  // the same files behind a plain static file server: no /__pso/version endpoint, as on any ordinary web host
  const { createServer } = await import("node:http");
  const { normalize, sep } = await import("node:path");
  const requested: string[] = [];
  const plain = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    requested.push(path);
    const abs = normalize(join(dir, path.endsWith("/") ? path + "index.html" : path));
    if (!abs.startsWith(dir + sep) || !existsSync(abs)) { res.writeHead(404); res.end("not found"); return; }
    const type = abs.endsWith(".html") ? "text/html; charset=utf-8" : abs.endsWith(".js") ? "text/javascript" : abs.endsWith(".css") ? "text/css" : abs.endsWith(".json") ? "application/json" : abs.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
    res.writeHead(200, { "content-type": type }); res.end(readFileSync(abs));
  });
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(plain.address() as { port: number }).port}/`;
  const ctx = await browser!.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  page.on("requestfailed", (r) => errors.push(`failed ${r.url()}`));
  try {
    for (const p of ["index.html", "getting-started/introduction.html", "cli/make-route.html"]) { await page.goto(origin + p); await page.waitForLoadState("networkidle"); }
    assert.deepEqual(errors, [], "no failed request and no console error on a static host");
    assert.ok(!requested.some((r) => r.includes("__pso")), "the version endpoint of `pso docs` is not requested from a static host");
    assert.equal(await page.locator('meta[name="pso-docs-server"]').count(), 0);
    // served by `pso docs` the page carries the marker and does ask (the next test covers the warning itself)
    const live = await open("getting-started/introduction.html");
    try { assert.equal(await live.page.locator('meta[name="pso-docs-server"]').count(), 1); assert.deepEqual(live.errors, []); } finally { await live.ctx.close(); }
  } finally { await ctx.close(); await new Promise<void>((r) => plain.close(() => r())); }
});

test("version warning appears only when the installed CLI version differs", { skip }, async () => {
  const ok = await open("getting-started/introduction.html");
  try { assert.equal(await ok.page.locator('[role="status"].callout-warning').count(), 0); } finally { await ok.ctx.close(); }
  const ctx = await browser!.newContext();
  const page = await ctx.newPage();
  await page.route("**/__pso/version", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: "9.9.9" }) }));
  try {
    await page.goto(base + "getting-started/introduction.html");
    await page.waitForSelector('[role="status"].callout-warning');
    assert.match((await page.textContent('[role="status"].callout-warning'))!, /0\.2\.0.*9\.9\.9/);
  } finally { await ctx.close(); }
});

test("accessibility: axe finds no serious or critical violations in either theme (contrast, names, roles, landmarks)", { skip, timeout: 420_000 }, async () => {
  const pages = ["index.html", "getting-started/first-endpoint.html", "orchestrator/routes.html", "cli/make-route.html", "ai-context/builder.html", "security/tls-and-mtls.html", "reference/diagnostics.html", "dispatch/overview.html", "decisions/why-routes-pso-mandatory.html"];
  const report: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    for (const p of pages) {
      const { page, ctx } = await open(p, { theme, bypassCSP: true });
      try {
        await page.evaluate((t) => localStorage.setItem("pso-theme", t), theme);
        await page.reload();
        await page.addScriptTag({ content: AXE });
        if (p.startsWith("ai-context/builder")) await page.waitForSelector(".ai-card");
        const res = await page.evaluate(async () => { const r = await (window as unknown as { axe: { run: (c: Document, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[]; failureSummary: string }> }> }> } }).axe.run(document, { resultTypes: ["violations"] }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary.split("\n")[1] ?? ""}`) })); });
        for (const v of res.filter((x) => x.impact === "serious" || x.impact === "critical")) report.push(`${theme} ${p}: ${v.id} (${v.impact}) ${v.nodes.join(" | ")}`);
      } finally { await ctx.close(); }
    }
  }
  assert.deepEqual(report, []);
  // the search dialog is part of the interface too
  const { page, ctx } = await open("index.html", { bypassCSP: true });
  try {
    await page.keyboard.press("Control+k");
    await page.fill(".search-input", "route");
    await page.waitForSelector(".search-result");
    await page.addScriptTag({ content: AXE });
    const v = await page.evaluate(async () => { const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string }> }> } }).axe.run(".search-dialog", { resultTypes: ["violations"] }); return r.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => x.id); });
    assert.deepEqual(v, []);
  } finally { await ctx.close(); }
});

test("static assets load on every sampled page with no console errors, failed requests or 4xx/5xx", { skip }, async () => {
  for (const p of ["index.html", "concepts/structural-discovery.html", "cli/dev.html", "ai-context/llms-files.html", "reference/decorators.html"]) {
    const { page, ctx, errors } = await open(p);
    try {
      assert.ok((await page.locator(".sprite use, svg use").count()) > 0);
      assert.equal(await page.evaluate(() => typeof (window as unknown as { PSO_SEARCH?: unknown }).PSO_SEARCH), "object");
      assert.equal(await page.evaluate(() => typeof (window as unknown as { PSO_AI?: unknown }).PSO_AI), "object");
      assert.deepEqual(errors, [], p);
    } finally { await ctx.close(); }
  }
  assert.ok(existsSync(join(dir, "llms.txt")));
});
