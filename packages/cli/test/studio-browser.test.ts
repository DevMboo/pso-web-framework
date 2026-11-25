import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { type WorkspaceConfig } from "@pso/core";
import { startDev, type DevSession } from "../src/dev.ts";
import { startStudio, type Studio } from "../src/studio.ts";
import { pso, tmp } from "./helpers.ts";

let browser: Browser | undefined, skip: string | false = false;
const SHOTS = process.env["PSO_SCREENSHOTS"];
const AXE = readFileSync(join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8");
const dirs: string[] = [];
const SECRET = "topsecretvalue123";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlc2lnbmF0dXJl";
const CORR = "11111111-2222-4333-8444-555555555555";

let root = "", studio: Studio, session: DevSession, emptyRoot = "", emptyStudio: Studio;

async function freePort(): Promise<number> {
  const s = netServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port; await new Promise((r) => s.close(r)); return p;
}
const STUB = `import { createServer } from "node:http";
createServer((q, r) => { r.writeHead(q.url === "/health" ? 200 : 404); r.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

before(async () => {
  for (const channel of ["chrome", "msedge"]) {
    try { browser = await chromium.launch({ channel }); break; } catch { /* try the next installed browser */ }
  }
  if (!browser) { skip = "no Chrome or Edge installation found for Playwright"; return; }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  const base = tmp("pso-studio-ui-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  root = join(base, "w");
  await pso(root, "create", "service", "users", "--structure", "legacy");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read");
  await pso(root, "make:module", "billing", "--service", "gw");
  writeFileSync(join(root, "stub.mjs"), STUB);
  const cfg = JSON.parse(readFileSync(join(root, "pso.workspace.json"), "utf8")) as WorkspaceConfig;
  for (const s of cfg.services) { s.port = await freePort(); s.health = "/health"; s.dev = { command: [process.execPath, join(root, "stub.mjs")] }; }
  cfg.services.find((s) => s.name === "gw")!.dependsOn = ["users"];
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify(cfg, null, 2));
  process.env["PSO_CFG_security__rateLimit__token"] = SECRET;
  session = await startDev({ root, config: cfg, readyTimeoutMs: 20_000, healthIntervalMs: 200 });
  const logs = [
    JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), level: "info", msg: "orchestrator listening", port: 3000 }),
    JSON.stringify({ ts: new Date(Date.now() - 30_000).toISOString(), level: "warn", msg: "slow upstream", correlationId: CORR, authorization: `Bearer ${TOKEN}` }),
    JSON.stringify({ ts: new Date(Date.now() - 10_000).toISOString(), level: "error", msg: `upstream failed password=hunter2 token ${TOKEN}`, correlationId: CORR, apiKey: "zzz999" }),
    "plain text line without structure",
  ].join("\n");
  mkdirSync(join(root, ".pso", "logs"), { recursive: true });
  writeFileSync(join(root, ".pso", "logs", "gw.log"), logs + "\n");
  studio = await startStudio({ root });

  // a second, empty workspace for empty states
  const b2 = tmp("pso-studio-empty-"); dirs.push(b2);
  await pso(b2, "create", "workspace", "e", "--layout", "flat");
  emptyRoot = join(b2, "e");
  emptyStudio = await startStudio({ root: emptyRoot });
});
after(async () => {
  await session?.stop().catch(() => undefined);
  await studio?.close().catch(() => undefined); await emptyStudio?.close().catch(() => undefined);
  await browser?.close();
  delete process.env["PSO_CFG_security__rateLimit__token"];
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } }
});

async function open(hash = "#/overview", o: { width?: number; height?: number; theme?: "dark" | "light"; s?: Studio; permissions?: string[]; bypassCSP?: boolean } = {}): Promise<{ page: Page; ctx: BrowserContext; errors: string[] }> {
  const ctx = await browser!.newContext({ viewport: { width: o.width ?? 1440, height: o.height ?? 900 }, colorScheme: o.theme ?? "dark", permissions: o.permissions ?? [], bypassCSP: o.bypassCSP ?? false });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) errors.push(`failed ${r.url()} ${r.failure()?.errorText}`); }); // requests superseded by navigation are aborted on purpose
  const s = o.s ?? studio;
  await page.goto(s.url);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector("#main h1", { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  return { page, ctx, errors };
}
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const PAGES = ["overview", "workspaces", "services", "routes", "modules", "dispatch", "security", "observability", "diagnostics", "settings"];

test("dashboard shows real runtime data: metrics, verified health, topology and activity", { skip, timeout: 120_000 }, async () => {
  const { page, ctx, errors } = await open("#/overview");
  try {
    assert.equal(await page.textContent("#main h1"), "Overview");
    const metrics = (await page.locator(".metric").allTextContents()).join(" | ");
    assert.match(metrics, /Services\s*2\/2/, "both services are healthy by live probe");
    assert.match(metrics, /Routes\s*1/);
    assert.match(metrics, /Modules\s*2/);
    assert.match(metrics, /Dev session/);
    assert.equal(await page.locator(".node").count(), 2, "topology has one node per service");
    assert.match((await page.locator(".health-list").textContent()) ?? "", /Healthy/);
    assert.match((await page.locator(".activity").textContent()) ?? "", /upstream failed/, "recent activity comes from the real log file");
    assert.equal(await page.getAttribute(".nav-item[data-id=overview]", "aria-current"), "page");
    assert.equal(await page.getAttribute("link[rel=icon]", "href"), "/favicon.svg");
    await shot(page, "overview-dark-desktop");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("navigation reaches every section and each one renders without errors", { skip, timeout: 180_000 }, async () => {
  const { page, ctx, errors } = await open("#/overview");
  try {
    for (const id of PAGES) {
      await page.click(`.nav-item[data-id=${id}]`);
      await page.waitForFunction((i) => document.querySelector(`.nav-item[data-id=${i}]`)?.getAttribute("aria-current") === "page" && !!document.querySelector("#main h1"), id);
      await page.waitForLoadState("networkidle");
      assert.ok((await page.textContent("#main h1"))!.length > 0, id);
      assert.equal(await page.locator("#main .state.error").count(), 0, `${id} has no error state`);
      await shot(page, `${id}-dark-desktop`);
    }
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("service topology: selecting a node opens a detail drawer; Esc closes it and restores focus", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/overview");
  try {
    const node = page.locator(".node", { hasText: "users" });
    await node.focus();
    await page.keyboard.press("Enter");
    const drawer = page.locator(".drawer");
    await drawer.waitFor();
    const text = (await drawer.textContent()) ?? "";
    assert.match(text, /Spring Boot configuration/); assert.match(text, /\/users/); assert.match(text, /pso-security-spring-boot-starter/); assert.match(text, /Lombok/);
    assert.match(text, /Healthy/); assert.match(text, /GET/); assert.match(text, /\/customers/); assert.match(text, /Used by:\s*gw/);
    await page.waitForTimeout(300); await shot(page, "service-drawer");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".drawer").count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("node")), true, "focus returns to the node");
  } finally { await ctx.close(); }
});

test("routes explorer filters by method, security and text, and explains validation", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/routes");
  try {
    assert.equal(await page.locator("tbody tr").count(), 1, "only the declared customer route");
    await page.selectOption('select[aria-label="Method"]', "GET");
    await page.fill('input[aria-label="Search routes"]', "customers");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
    const row = (await page.locator("tbody tr").textContent()) ?? "";
    assert.match(row, /\/customers/); assert.match(row, /customers:read/); assert.match(row, /users/); assert.match(row, /active/);
    await page.selectOption('select[aria-label="Security"]', "public");
    await page.waitForFunction(() => /Nothing matches/.test(document.querySelector("#main")!.textContent ?? ""));
    await page.selectOption('select[aria-label="Security"]', "");
    await page.locator("tbody .row-btn").first().click();
    await page.locator(".drawer").waitFor();
    assert.match((await page.locator(".drawer").textContent()) ?? "", /Declared in ROUTES\.pso\.ts|ROUTES\.pso\.ts/);
    await page.waitForTimeout(300); await shot(page, "routes-drawer");
  } finally { await ctx.close(); }
});

test("module explorer shows the import graph separately from service communication and module diagnostics", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/modules");
  try {
    assert.match((await page.textContent("#main")) ?? "", /Runtime calls between services are shown in the service topology/);
    const names = (await page.locator("tbody tr td:first-child").allTextContents()).join(" ");
    assert.match(names, /customer/); assert.match(names, /billing/);
    await page.locator("tbody .row-btn", { hasText: "billing" }).click();
    const text = (await page.locator(".drawer").textContent()) ?? "";
    assert.match(text, /MODULE\.pso/); assert.match(text, /Validation/);
    await page.waitForTimeout(300); await shot(page, "modules-drawer");
  } finally { await ctx.close(); }
});

test("security view: configuration status, coverage, no secrets and the not-a-guarantee note", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/security");
  try {
    const text = (await page.textContent("#main")) ?? "";
    assert.match(text, /not a guarantee|does not prove/i);
    assert.match(text, /Authentication/); assert.match(text, /Route security coverage/);
    assert.match(text, /invalid|valid/);
    assert.ok(!text.includes(SECRET) && !text.includes(TOKEN) && !text.includes("PRIVATE KEY"));
    await shot(page, "security-dark-desktop");
  } finally { await ctx.close(); }
});

test("observability: severity, text and correlation filters; tokens and secrets never reach the DOM", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/observability");
  try {
    // the page also holds the telemetry table: every count below is about the LOG table only
    await page.evaluate(() => { (window as unknown as { __logRows: () => number }).__logRows = () => { const t = [...document.querySelectorAll("table")].find((x) => x.querySelector("caption")?.textContent?.includes("Log entries")); return t ? t.querySelectorAll("tbody tr").length : -1; }; });
    const all = (await page.textContent("#main")) ?? "";
    assert.ok(!all.includes(TOKEN) && !all.includes("hunter2") && !all.includes("zzz999"), "scrubbed on the server");
    assert.equal(await page.locator('table:has(caption:has-text("Log entries")) tbody tr').count(), 4);
    await page.click('button.chip-toggle:has-text("error")');
    await page.waitForFunction(() => (window as unknown as { __logRows: () => number }).__logRows() === 1);
    await page.click('button.chip-toggle:has-text("error")');
    await page.waitForFunction(() => (window as unknown as { __logRows: () => number }).__logRows() === 4);
    await page.fill('input[aria-label="Search logs"]', "slow upstream");
    await page.waitForFunction(() => (window as unknown as { __logRows: () => number }).__logRows() === 1);
    await page.fill('input[aria-label="Search logs"]', "");
    await page.fill('input[aria-label="Correlation id"]', CORR);
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => (window as unknown as { __logRows: () => number }).__logRows() === 2);
    await page.locator('table:has(caption:has-text("Log entries")) tbody .row-btn').first().click();
    const drawer = (await page.locator(".drawer").textContent()) ?? "";
    assert.match(drawer, new RegExp(CORR)); assert.ok(!drawer.includes(TOKEN));
    await page.waitForTimeout(300); await shot(page, "observability-drawer");
  } finally { await ctx.close(); }
});

test("observability: the runtime telemetry panel shows states and reasons, and never a zero for what was not measured", { skip, timeout: 60_000 }, async () => {
  const { page, ctx, errors } = await open("#/observability");
  try {
    const panel = page.locator('section:has(h2:has-text("Runtime telemetry")), .panel:has(h2:has-text("Runtime telemetry"))').first();
    await panel.waitFor();
    const text = (await panel.textContent()) ?? "";
    // this Studio has no PSO_DIAGNOSTICS_TOKEN and the declared Spring service is not instrumented
    assert.match(text, /Unknown/); assert.match(text, /Not instrumented/);
    assert.match(text, /PSO_DIAGNOSTICS_TOKEN/, "the reason tells how to fix it");
    assert.ok((await panel.locator("td", { hasText: "no data" }).count()) >= 4, "unmeasured cells say 'no data'");
    assert.ok(!(await panel.locator("tbody td").allTextContents()).some((t) => t.trim() === "0"), "no zero stands in for a missing measurement");
    assert.ok(!text.includes(TOKEN) && !text.includes(SECRET));
    await shot(page, "observability-telemetry");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("dispatch: declared topology, channel drawer, findings, and a REAL broker connection check", { skip, timeout: 120_000 }, async () => {
  const base = tmp("pso-studio-dsp-"); dirs.push(base);
  await pso(base, "create", "workspace", "d", "--layout", "flat");
  const droot = join(base, "d");
  await pso(droot, "create", "service", "users-service", "--structure", "legacy");
  await pso(droot, "dispatch:install", "redis", "--service", "users-service");
  writeFileSync(join(droot, "users-service/src/main/resources/dispatch/users-service.events.json"), JSON.stringify({ events: [{ name: "users.created", version: 1, channel: "users.events", schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } } }] }));
  mkdirSync(join(droot, "users-service/src/main/java/com/pso/usersservice/application"), { recursive: true });
  writeFileSync(join(droot, "users-service/src/main/java/com/pso/usersservice/application/Handlers.java"), ['package com.pso.usersservice.application;', 'class Handlers {', '  @PsoEventHandler("users.created")', '  public void on(String payload) { }', '}', ''].join("\n"));
  const dstudio = await startStudio({ root: droot });
  const { page, ctx, errors } = await open("#/dispatch", { s: dstudio });
  try {
    assert.equal(await page.locator(".node").count(), 2, "one node for the service and one for the channel");
    assert.match((await page.textContent("#main")) ?? "", /not the same as zero events|cannot be shown/);
    assert.match((await page.textContent("#main")) ?? "", /not checked/, "no connection status is shown before a real check");
    await page.locator(".node", { hasText: "users.events" }).focus();
    await page.keyboard.press("Enter");
    const drawer = (await page.locator(".drawer").textContent()) ?? "";
    assert.match(drawer, /users.events.dlq/); assert.match(drawer, /Handlers|on/); assert.match(drawer, /declared topology/);
    await page.keyboard.press("Escape");
    process.env["REDIS_URL"] = "redis://127.0.0.1:1";
    await page.click('button:has-text("Check broker connections")');
    await page.waitForSelector('text=/cannot connect|failed|timed out|ECONNREFUSED|Connection is closed/i', { timeout: 30_000 });
    assert.match((await page.textContent("#main")) ?? "", /Unhealthy/);
    await shot(page, "dispatch-checked");
    assert.deepEqual(errors, []);
  } finally { delete process.env["REDIS_URL"]; await ctx.close(); await dstudio.close(); }
});

test("settings: environment switching, precedence and masked values", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/settings");
  try {
    await page.selectOption('select[aria-label="Environment"]', "production");
    await page.waitForFunction(() => document.querySelector(".pill.env")?.textContent === "production");
    const text = (await page.textContent("#main")) ?? "";
    assert.match(text, /Precedence/); assert.match(text, /environment-variables/); assert.match(text, /read-only/);
    assert.ok(!text.includes(SECRET), "secret value never shown");
    assert.match(text, /REDACTED/);
    await shot(page, "settings-production");
  } finally { await ctx.close(); }
});

test("diagnostics: items link to documentation, and the AI context is copy-safe", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/diagnostics", { permissions: ["clipboard-read", "clipboard-write"] });
  try {
    assert.match((await page.textContent("#main")) ?? "", /Copy AI context/);
    await page.click('button:has-text("Copy AI context")');
    await page.waitForSelector(".toast");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /PSO Studio diagnostic context/); assert.match(copied, /GET \/customers/);
    for (const leak of [SECRET, TOKEN, "hunter2"]) assert.ok(!copied.includes(leak));
    await shot(page, "diagnostics-dark-desktop");
  } finally { await ctx.close(); }
});

test("contextual documentation links resolve on the same origin", { skip, timeout: 120_000 }, async () => {
  const { page, ctx } = await open("#/routes");
  try {
    const href = await page.getAttribute(".page-actions a.doc-link", "href");
    assert.equal(href, "/docs/orchestrator/routes.html");
    const r = await page.request.get(new URL(href!, studio.url).toString());
    assert.equal(r.status(), 200);
    assert.match(await r.text(), /ROUTES\.pso\.ts/);
  } finally { await ctx.close(); }
});

test("theme: switching changes real colors and persists", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/overview", { theme: "dark" });
  try {
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const dark = await bg();
    await page.click('button[aria-label="Switch theme"]');
    assert.equal(await page.getAttribute("html", "data-theme"), "light");
    const light = await bg();
    assert.notEqual(dark, light);
    await shot(page, "overview-light-desktop");
    await page.reload(); await page.waitForSelector("#main h1");
    assert.equal(await page.getAttribute("html", "data-theme"), "light", "persisted");
  } finally { await ctx.close(); }
});

test("global search finds services, routes and pages with the keyboard", { skip, timeout: 60_000 }, async () => {
  const { page, ctx } = await open("#/overview");
  try {
    await page.keyboard.press("/");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Global search");
    await page.keyboard.type("custom");
    await page.waitForSelector("#search-results li[role=option]");
    assert.match((await page.textContent("#search-results")) ?? "", /GET \/customers/);
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash === "#/routes");
  } finally { await ctx.close(); }
});

test("responsive: no horizontal page overflow on any section at desktop, laptop and mobile sizes", { skip, timeout: 300_000 }, async () => {
  for (const [name, width, height] of [["desktop", 1920, 1080], ["laptop", 1280, 720], ["mobile", 390, 844]] as const) {
    const { page, ctx } = await open("#/overview", { width, height });
    try {
      for (const id of PAGES) {
        await page.evaluate((h) => { location.hash = h; }, `#/${id}`);
        await page.waitForFunction((i) => document.querySelector(`.nav-item[data-id=${i}]`)?.getAttribute("aria-current") === "page", id);
        await page.waitForLoadState("networkidle");
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 1, `${id} @${name}: page overflows horizontally by ${over}px`);
        if (id === "overview" || id === "routes" || id === "services") await shot(page, `${id}-${name}`);
      }
      if (name === "mobile") {
        await page.click('button[aria-label="Open navigation"]');
        await page.waitForTimeout(300);
        assert.ok(await page.locator(".sidebar").isVisible());
        const x = await page.locator(".sidebar").evaluate((e) => e.getBoundingClientRect().left);
        assert.ok(x >= 0, "navigation drawer slides into view");
        await shot(page, "mobile-nav");
      }
    } finally { await ctx.close(); }
  }
});

test("accessibility: no serious or critical axe violations in either theme", { skip, timeout: 400_000 }, async () => {
  for (const theme of ["dark", "light"] as const) {
    const { page, ctx } = await open("#/overview", { theme, bypassCSP: true }); // only to inject the axe script; the app itself is CSP-clean (see other tests)
    try {
      for (const id of PAGES) {
        await page.evaluate((h) => { location.hash = h; }, `#/${id}`);
        await page.waitForFunction((i) => document.querySelector(`.nav-item[data-id=${i}]`)?.getAttribute("aria-current") === "page", id);
        await page.waitForLoadState("networkidle");
        await page.addScriptTag({ content: AXE });
        const bad = await page.evaluate(async () => {
          // @ts-expect-error axe is injected above
          const r = await window.axe.run(document, { resultTypes: ["violations"] });
          return r.violations.filter((v: { impact: string }) => v.impact === "serious" || v.impact === "critical").map((v: { id: string; nodes: Array<{ target: string[] }> }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" ; ")}`);
        });
        assert.deepEqual(bad, [], `${id} (${theme})`);
      }
    } finally { await ctx.close(); }
  }
});

test("empty workspace: useful empty states instead of blank screens", { skip, timeout: 120_000 }, async () => {
  const { page, ctx } = await open("#/overview", { s: emptyStudio });
  try {
    assert.match((await page.textContent("#main")) ?? "", /No services declared/);
    await page.evaluate(() => { location.hash = "#/routes"; }); await page.waitForSelector(".state.empty");
    assert.match((await page.textContent("#main")) ?? "", /No routes declared/);
    await page.evaluate(() => { location.hash = "#/observability"; }); await page.waitForSelector(".state.empty");
    assert.match((await page.textContent("#main")) ?? "", /No log files yet/);
    await page.evaluate(() => { location.hash = "#/dispatch"; }); await page.waitForSelector(".state.empty");
    assert.match((await page.textContent("#main")) ?? "", /not installed/);
    await shot(page, "empty-overview");
  } finally { await ctx.close(); }
});

test("connection failure: the UI says so and offers a retry, never stale 'connected' state", { skip, timeout: 120_000 }, async () => {
  const b3 = tmp("pso-studio-down-"); dirs.push(b3);
  await pso(b3, "create", "workspace", "d", "--layout", "flat");
  const s = await startStudio({ root: join(b3, "d") });
  const { page, ctx } = await open("#/overview", { s });
  try {
    assert.match((await page.textContent(".pill.conn")) ?? "", /Connected/);
    await s.close();
    await page.click('button[aria-label="Refresh data"]');
    await page.waitForSelector("#main .state.error");
    assert.match((await page.textContent(".pill.conn")) ?? "", /Disconnected/);
    assert.match((await page.textContent("#main")) ?? "", /Cannot reach the Studio server/);
    assert.equal(await page.locator('#main .state.error button:has-text("Retry")').count(), 1);
    await shot(page, "connection-lost");
  } finally { await ctx.close(); }
});

test("the page itself never injects markup from data: log text with HTML is shown as text", { skip, timeout: 60_000 }, async () => {
  writeFileSync(join(root, ".pso", "logs", "users.log"), JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: '<img src=x onerror="window.__pwned=1"><b>bold</b>' }) + "\n");
  const { page, ctx } = await open("#/observability");
  try {
    assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined);
    assert.equal(await page.locator("#main img[src='x']").count(), 0);
    assert.match((await page.textContent("#main")) ?? "", /<b>bold<\/b>/);
  } finally { await ctx.close(); }
});
