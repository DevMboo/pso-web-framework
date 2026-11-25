// Refresh the documentation images from the current portal and a disposable PSO workspace.
// Run from the repository root after `npm run build`.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { ALL_COMMANDS } from "../packages/cli/dist/registry.js";
import { run } from "../packages/cli/dist/main.js";
import { buildSite, serveSite } from "../packages/cli/dist/portal/build.js";
import { startStudio } from "../packages/cli/dist/studio.js";

const output = resolve("packages/cli/portal/assets/screenshots");
const scratch = mkdtempSync(join(tmpdir(), "pso-doc-images-"));
let browser;
let portal;
let studio;

async function command(cwd, ...args) {
  const errors = [];
  const code = await run(args, cwd, () => {}, (line) => errors.push(line));
  if (code !== 0) throw new Error(`pso ${args.join(" ")} failed (${code}): ${errors.join(" ")}`);
}

async function capture(url, file, selector) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    if (selector === "viewport") await page.screenshot({ path: join(output, file), animations: "disabled" });
    else await page.locator(selector).first().screenshot({ path: join(output, file), animations: "disabled" });
  } finally {
    await context.close();
  }
}

try {
  mkdirSync(output, { recursive: true });
  const site = join(scratch, "site");
  buildSite(site, ALL_COMMANDS);
  portal = await serveSite(site);
  for (const channel of ["chrome", "msedge"]) {
    try { browser = await chromium.launch({ channel }); break; } catch { /* try the next installed browser */ }
  }
  if (!browser) throw new Error("Chrome or Edge is required to capture documentation screenshots");

  await capture(portal.url, "portal-home.png", "viewport");
  await capture(new URL("getting-started/quick-start.html", portal.url.endsWith("/") ? portal.url : `${portal.url}/`).href, "quick-start-commands.png", "figure.k-command");
  await capture(new URL("tutorials/crud-api.html", portal.url.endsWith("/") ? portal.url : `${portal.url}/`).href, "crud-created-response.png", "figure.k-http-response:has-text('201 Created')");
  await capture(new URL("cli/workflow.html", portal.url.endsWith("/") ? portal.url : `${portal.url}/`).href, "cli-workflow-output.png", "figure.k-output:has-text('pso routes:inspect')");
  await capture(new URL("devops/logging.html", portal.url.endsWith("/") ? portal.url : `${portal.url}/`).href, "log-severity.png", "figure.k-output:has-text('separate startup attempt')");

  await command(scratch, "create", "workspace", "demo");
  const workspace = join(scratch, "demo");
  await command(workspace, "create", "service", "catalog");
  await command(workspace, "create", "orchestrator", "gateway");
  await command(workspace, "make:resource", "product", "--service", "catalog", "--route", "/products", "--scopes", "products:read");
  studio = await startStudio({ root: workspace });
  await capture(studio.url, "studio-overview.png", "#main");
} finally {
  await studio?.close();
  await portal?.close();
  await browser?.close();
  const tempRoot = resolve(tmpdir());
  if (!resolve(scratch).startsWith(tempRoot + sep) || !scratch.includes("pso-doc-images-")) {
    throw new Error(`Refusing to remove unexpected scratch directory: ${scratch}`);
  }
  rmSync(scratch, { recursive: true, force: true });
}
