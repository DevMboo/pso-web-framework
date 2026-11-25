// Not a test: renders documentation pages in a real browser, saves screenshots and runs an accessibility/contrast scan.
// Usage: node test/_demo-shots.ts <outDir> <page> [<page> ...]   (pages are portal ids such as tutorials/crud-api)
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ALL_COMMANDS } from "../src/registry.ts";
import { buildSite, serveSite } from "../src/portal/build.ts";
import { tmp } from "./helpers.ts";

const [out, ...pages] = process.argv.slice(2);
mkdirSync(out!, { recursive: true });
const dir = tmp("pso-shots-");
buildSite(dir, ALL_COMMANDS);
const server = await serveSite(dir);
const AXE = readFileSync(join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8");
let browser;
for (const channel of ["chrome", "msedge"]) { try { browser = await chromium.launch({ channel }); break; } catch { /* next */ } }
if (!browser) throw new Error("no browser");
for (const id of pages) {
  for (const [name, w, h, theme] of [["desktop-dark", 1440, 900, "dark"], ["desktop-light", 1440, 900, "light"], ["mobile-dark", 390, 844, "dark"], ["mobile-light", 390, 844, "light"]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, bypassCSP: true });
    const page = await ctx.newPage();
    await page.goto(new URL(id + ".html", server.url.endsWith("/") ? server.url : server.url + "/").href);
    await page.waitForLoadState("networkidle");
    const tag = id.replace(/\//g, "_") + "-" + name;
    const sel = ["figure.filetree", "figure.k-command", "figure.k-http-response", "figure.k-output", "figure.code:not(.k-command):not(.k-output):not(.k-http-response):not(.k-http-request)"];
    for (const s of sel) {
      const el = page.locator(s).first();
      if (await el.count()) { await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: join(out!, `${tag}-${s.replace(/[^a-z-]/gi, "").slice(0, 24)}.png`) }); }
    }
    await page.screenshot({ path: join(out!, `${tag}-top.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => { const r = await (globalThis as any).axe.run(document, { runOnly: ["color-contrast", "scrollable-region-focusable", "aria-allowed-role", "aria-required-children", "aria-required-parent"] }); return r.violations.map((v: any) => `${v.id}: ${v.nodes.length} (${v.nodes.slice(0, 2).map((n: any) => n.target.join(" ")).join(" | ")})`); });
    console.log(tag, "page-overflow:", overflow, "axe:", JSON.stringify(res));
    await ctx.close();
  }
}
await browser.close(); await server.close();
