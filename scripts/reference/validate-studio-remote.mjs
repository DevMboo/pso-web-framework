#!/usr/bin/env node
// Real Chrome against PSO Studio (--ops) for remote hosts: registered connection (references only), host capabilities, prerequisites of
// the staging environment, containers' health on the host, history, logs, and a deployment started from the page (typed confirmation)
// with its progress. Needs the isolated host of validate-remote.mjs and PSO_CLOUD_HOME pointing at the cloud home that registered it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const root = join(repo, "fixtures", "pso-reference");
const outDir = join(repo, "docs", "implementation", "evidence", "v020", "studio-remote");
mkdirSync(join(outDir, "shots"), { recursive: true });
if (!process.env.PSO_CLOUD_HOME) { console.error("PSO_CLOUD_HOME must name the cloud home where staging-host is registered"); process.exit(2); }
process.env.PSO_NO_BROWSER = "1";
const { startStudio } = await import(new URL("../../packages/cli/dist/studio.js", import.meta.url).href);
const { chromium } = await import(new URL("../../node_modules/playwright-core/index.mjs", import.meta.url).href);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 200)})` : ""}`); };
const studio = await startStudio({ root, ops: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(studio.url);
  await page.goto(`http://127.0.0.1:${studio.port}/#/remote`);
  await page.getByText("Registered hosts").waitFor({ timeout: 30_000 });
  check("registered hosts: the connection with its pinned host key", await page.locator("code", { hasText: "staging-host" }).count() > 0 && await page.getByText(/SHA256:/).count() > 0);
  await page.getByText("Prerequisites of this environment").waitFor({ timeout: 90_000 });
  check("host capabilities read over SSH (system, Docker, root, ports)", await page.getByText(/Alpine Linux/).count() > 0 && await page.getByText(/compose 2\./).count() > 0);
  check("prerequisites: operator certificates verified on the host, secret files present", await page.getByText(/verified on the host/).count() > 0 && await page.getByText(/secret file\(s\) present/).count() > 0);
  const running = await page.locator("table", { has: page.locator("caption", { hasText: "Containers on the host" }) }).locator("tbody tr").filter({ hasText: "running" }).count();
  check("containers of the release on the host, with health", running >= 8, `${running} running`);
  check("deployment history from the host", await page.locator("table", { has: page.locator("caption", { hasText: "Deployments and rollbacks" }) }).locator("tbody tr").count() >= 3);
  await page.locator("select[aria-label='Container']").selectOption("gateway");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await page.locator(".log-view").filter({ hasText: /upstream|orchestrator/ }).first().waitFor({ timeout: 60_000 });
  check("remote logs of a container", true);
  const html = await page.content();
  // the deploy key of the host registration (validate-remote.mjs writes deploy_ed25519 next to the cloud home)
  const keyFile = ["deploy_ed25519", "k"].map((n) => join(process.env.PSO_CLOUD_HOME, "..", n)).find((f) => existsSync(f));
  check("no key material or credential in the page", !/PRIVATE KEY|BEGIN OPENSSH/.test(html) && !!keyFile && !html.includes(readFileSync(keyFile, "utf8").slice(40, 90)));
  await page.screenshot({ path: join(outDir, "shots", "01-remote-host.png"), fullPage: true });
  // a deployment from the page: refused without the exact confirmation, then run with it and followed to the end
  const input = page.locator("input[placeholder='deploy staging']");
  await input.fill("deploy prod");
  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  await page.getByText('Type "deploy staging" to confirm').first().waitFor({ timeout: 10_000 });
  check("a deployment without the exact typed confirmation is not sent", true);
  await input.fill("deploy staging");
  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  await page.getByText(/integrity verified on the host/).first().waitFor({ timeout: 600_000 });
  check("deployment progress streams from the job (transfer, integrity)", true);
  await page.getByText(/deploy: done|deploy failed/).first().waitFor({ timeout: 900_000 });
  const okDeploy = await page.getByText("deploy: done").count() > 0;
  check("the deployment started from Studio completed and was verified", okDeploy, (await page.locator(".log-view").last().textContent())?.split("\n").slice(-2).join(" | "));
  await page.screenshot({ path: join(outDir, "shots", "02-remote-deploy.png"), fullPage: true });
  check("no uncaught errors in Studio", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) { check("scenario completed without an exception", false, e.message.split("\n")[0]); await page.screenshot({ path: join(outDir, "shots", "failure.png"), fullPage: true }).catch(() => {}); }
finally { await browser.close(); await studio.close(); }
writeFileSync(join(outDir, "studio-remote-result.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? "FAILED" : "OK"} ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
