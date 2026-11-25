import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { Cloud, LocalStore, MemoryCredentialProvider } from "@pso/deploy";
import { startStudio, type Studio } from "../src/studio.ts";
import { pso, tmp } from "./helpers.ts";

/**
 * The Studio Cloud section in a real browser. The agent's answers are STUBBED here (shaped like the real ones, which the Linux end-to-end
 * suite in packages/deploy exercises against a real server): this test is about what the page does with them: tabs, honest empty and
 * disabled states, no inert buttons, confirmation of production actions, no secret in the DOM, accessibility, strict CSP.
 */
const AXE = readFileSync(join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8");
let browser: Browser | undefined, skip: string | false = false;
const dirs: string[] = [];
let on: Studio, off: Studio;
const SECRET = "Typed-Into-Studio-Pw-5551";

const DEP = { id: "dm1abc", app: "shop", kind: "deploy", planHash: "a".repeat(64), releaseId: "r20261114223601-ce58a814", previousRelease: "r20261114223537-9874ff64", strategy: "blue-green", state: "COMPLETED", effectiveState: "COMPLETED", workerAlive: false, trafficSwitched: true, requestedBy: { name: "ana@pso-studio" }, startedAt: "2026-11-14T22:36:01Z", finishedAt: "2026-11-14T22:36:27Z", candidateSlots: ["web-0"], checkpoints: [], availability: { requests: 6, failures: 0 },
  stages: [{ id: "integrity", type: "integrity", status: "passed", detail: "manifest verified" }, { id: "security", type: "security", status: "passed", detail: "secret scan passed; NOT RUN: java-dependency-scan" }, { id: "tests", type: "tests", status: "skipped", detail: "no test steps declared" }, { id: "build", type: "build", status: "passed" }, { id: "deploy", type: "deploy", status: "passed" }] };
const CANNED: Record<string, unknown> = {
  // the agent's policy compatibility view (shaped like the real one): one capability the server policy permits, one it does not yet, and the migration that would grant it
  "policy.compat": { agentVersion: "0.2.0", policyVersion: 3, capabilities: [{ id: "strategy.blue-green", introducedIn: "0.1.0", summary: "deploy services with blue-green switching behind nginx", status: "permitted" }, { id: "strategy.static", introducedIn: "0.2.0", summary: "deploy static frontends", status: "not-permitted" }], migrations: [{ id: "allow-static-frontends", introducedIn: "0.2.0", summary: "Permit the \"static\" deployment strategy", grants: ["strategy.static"], pending: true, changes: { allowedStrategies: { from: ["blue-green"], to: ["blue-green", "static"] } }, digest: "d".repeat(16) }] },
  "release.status": { app: "shop", active: { release: DEP.releaseId }, previous: DEP.previousRelease, lastKnownGood: DEP.releaseId, releases: [DEP.releaseId, DEP.previousRelease], lock: { status: "free", owner: null }, deployment: DEP, services: [{ service: "web", instance: 0, release: DEP.releaseId, port: 20001, pid: 4321, running: true, identity: "identity verified" }] },
  "inspect": { agent: { version: "0.1.0", mode: "protected", environmentId: "env_x", home: "/h" }, os: { platform: "linux", release: "6", arch: "x64", distro: "Alpine Linux" }, user: { name: "pso", uid: 1000, root: false }, cpu: { count: 4 }, memory: { totalMb: 4096, availableMb: 3000 }, disk: { path: "/h", totalMb: 20000, freeMb: 15000 },
    tools: { node: { available: true, version: "24.0.0" }, java: { available: true, version: "21.0.1" }, git: { available: true, version: "2.49" }, nginx: { available: true, version: "1.30" }, docker: { available: false }, systemd: { available: false }, npm: { available: true }, sudo: { available: true } }, listeningPorts: [{ port: 22, address: "0.0.0.0" }],
    nginx: { vhosts: [{ file: "/etc/nginx/http.d/unrelated.conf", managed: false, serverNames: ["unrelated.example.test"], listens: ["8081"] }, { file: "/etc/nginx/pso.d/pso-shop.conf", managed: true, app: "shop", serverNames: ["shop.test"], listens: ["8080"] }], configValid: true, managedDir: "/etc/nginx/pso.d", managedDirWritable: true }, pso: { apps: [], agentHome: "/h" }, capabilities: [], blockers: [] },
  "release.history": [DEP], "release.list": [{ id: DEP.releaseId, active: true, previous: false }, { id: DEP.previousRelease, active: false, previous: true }], "release.get": DEP,
  "logs.read": { source: "deployment dm1abc", text: "2026-11-14T22:36:01Z INFO  state PLANNING\n2026-11-14T22:36:26Z INFO  state COMPLETED: release is active\n" },
  "provision.plan": { steps: [{ id: "nginx-dir", title: "PSO-owned nginx directory", status: "ok", detail: "writable" }, { id: "nginx-sudo", title: "Narrow sudo rule", status: "admin", detail: "script below" }], adminScript: "#!/bin/sh\nset -eu\nmkdir -p /etc/nginx/pso.d\n", note: "PSO only performs the steps marked agent" },
  "client.list": [{ id: "SHA256:" + "A".repeat(43), name: "ana@pso-studio", role: "superadmin", revoked: false }], "secret.list": ["shop-db-password"], "audit.read": [{ seq: 1, ts: "2026-11-14T22:36:01Z", event: "deploy.requested", outcome: "ok", actor: { name: "ana" }, ids: { deployment: "dm1abc" } }], "audit.verify": { ok: true, entries: 1, head: "abc" }, "policy.get": {},
};
class StubCloud extends Cloud {
  override async with<T>(_name: string, fn: (c: never) => Promise<T>): Promise<T> { return fn({ call: async (op: string) => { if (!(op in CANNED)) throw new Error(`unexpected operation ${op}`); return CANNED[op]; } } as never); }
}

before(async () => {
  for (const channel of ["chrome", "msedge"]) { try { browser = await chromium.launch({ channel }); break; } catch { /* try the next installed browser */ } }
  if (!browser) { skip = "no Chrome or Edge installation found for Playwright"; return; }
  const base = tmp("pso-cloud-ui-"); dirs.push(base);
  await pso(base, "create", "workspace", "w"); const root = join(base, "w");
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy", "production.deployment.pso.ts"), `import { defineDeployment } from "@pso/deploy";\nexport default defineDeployment({ name: "shop", environment: "production", connection: { provider: "ssh", credentials: "prod" }, source: { provider: "git", url: "https://git.example.com/shop.git", branch: "main" }, service: { name: "web", runtime: "node", start: ["node", "server.js"], shutdownGraceSeconds: 20, route: { path: "/" } }, strategy: { type: "blue-green", proxy: "nginx" }, proxy: { nginx: { domains: ["shop.example.com"] } }, pipeline: "production" });\n`);
  writeFileSync(join(root, "deploy", "production.pipeline.pso.ts"), `import { definePipeline } from "@pso/deploy";\nexport default definePipeline({ name: "production", stages: [{ type: "integrity" }, { type: "security" }, { type: "tests", enabled: false }, { type: "build" }, { type: "deploy" }] });\n`);
  const cloud = new StubCloud({ store: new LocalStore(mkdtempSync(join(tmpdir(), "pso-cc-ui-"))), creds: new MemoryCredentialProvider() });
  cloud.store.saveConnection({ name: "prod", host: "203.0.113.5", port: 22, user: "deploy", auth: { kind: "agent" }, timeoutSeconds: 15, agentDir: ".pso-agent", createdAt: "", credentialVersion: 1, hostKeyFingerprint: "SHA256:" + "H".repeat(43), agentFingerprint: "SHA256:" + "G".repeat(43), clientId: "SHA256:" + "A".repeat(43), clientKeyRef: "cred_x", role: "superadmin" });
  on = await startStudio({ root, remote: true, cloud }); off = await startStudio({ root, remote: false, cloud });
});
after(async () => { await on?.close().catch(() => undefined); await off?.close().catch(() => undefined); await browser?.close(); for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

async function open(s: Studio, hash: string, o: { theme?: "dark" | "light"; bypassCSP?: boolean; width?: number } = {}): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser!.newContext({ viewport: { width: o.width ?? 1440, height: 900 }, colorScheme: o.theme ?? "dark", bypassCSP: o.bypassCSP ?? false });
  const page = await ctx.newPage(); const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(s.url); await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector("#main h1", { timeout: 15_000 }); await page.waitForLoadState("networkidle");
  return { page, errors };
}

test("with remote management off: local facts only, an honest explanation, and no action buttons", { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await open(off, "#/cloud");
  assert.equal(await page.locator(".tab").count(), 14);
  assert.match(await page.locator("#main").innerText(), /Remote management is off/);
  assert.match(await page.locator("#main").innerText(), /production/i); assert.match(await page.locator("#main").innerText(), /prod \(enrolled\)|connection prod/);
  for (const label of ["Plan deployment", "Read live status", "Add connection", "Roll back"]) assert.equal(await page.getByRole("button", { name: label }).count(), 0, `no "${label}" button while remote management is off`);
  assert.match(await page.locator("#main").innerText(), /pso studio --remote/);
  assert.deepEqual(errors, []);
});

test("with remote management on: environments, live status, deployments with a pipeline view, infrastructure, credentials, audit", { skip, timeout: 120_000 }, async () => {
  const { page, errors } = await open(on, "#/cloud");
  const env = page.locator(".env-pill.prod"); assert.ok(await env.count() >= 1, "production is distinguished by name, bordered, with a warning icon (not by color alone)"); assert.match(await env.first().innerText(), /production/i);
  assert.match(await page.locator("#main").innerText(), /not shown from memory|when you ask/, "live status is not displayed until it was read");
  await page.getByRole("button", { name: "Read live status" }).first().click();
  await page.waitForSelector("text=running"); assert.match(await page.locator("#main").innerText(), /active r20261114223601-ce58a814/);
  assert.match(await page.locator("#main").innerText(), /3000 MB/);
  assert.match(await page.locator("#main").innerText(), /Policy compatibility[\s\S]*1 capability\(ies\) of this agent are not permitted/, "the live status shows the policy compatibility view, which an older agent may not provide (its absence never hides the status)");
  // deployments: the history row opens a live drawer with the pipeline and the blue-green view
  await page.getByRole("tab", { name: /Deployments/ }).click(); await page.waitForSelector("table");
  await page.getByRole("button", { name: /dm1abc/ }).first().click(); await page.waitForSelector(".drawer .pipeline");
  const drawer = await page.locator(".drawer").innerText();
  for (const s of ["integrity", "security", "tests", "build", "deploy"]) assert.match(drawer, new RegExp(s));
  assert.match(drawer, /NOT RUN: java-dependency-scan/, "a scanner that did not run is shown as not run"); assert.match(drawer, /skipped/i);
  assert.match(drawer, /Previous release/); assert.match(drawer, /receiving traffic/); assert.match(drawer, /6 of 6 probes|5 of 6|6 probes|probes reached/i);
  assert.equal(await page.locator(".drawer .stage[data-status='skipped']").count(), 1);
  await page.keyboard.press("Escape");
  // a production action needs the environment name typed
  await page.getByRole("button", { name: "Roll back to previous" }).click(); await page.waitForSelector(".drawer");
  assert.ok(await page.locator(".drawer input[aria-label^='Type production']").count() === 1);
  assert.equal(await page.locator(".drawer input[aria-label^='Type production']").inputValue(), "", "production does not pre-fill the confirmation");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: /Infrastructure/ }).click(); await page.waitForSelector("text=nginx virtual hosts");
  const infra = await page.locator("#main").innerText(); assert.match(infra, /external/); assert.match(infra, /PSO · shop/); assert.match(infra, /never runs it|PSO never runs it/);
  await page.getByRole("tab", { name: /Credentials/ }).click(); await page.waitForSelector("text=Server secrets");
  const cred = await page.locator("#main").innerText(); assert.match(cred, /shop-db-password/); assert.doesNotMatch(cred, /PRIVATE KEY/);
  await page.getByRole("tab", { name: /Audit/ }).click(); await page.waitForSelector("text=deploy.requested");
  assert.deepEqual(errors, []);
});

test("adding a connection: the secret is a password field, the host key must be approved first, and no control is inert", { skip, timeout: 60_000 }, async () => {
  const { page } = await open(on, "#/cloud/connections");
  await page.getByRole("button", { name: "Add connection" }).click(); await page.waitForSelector(".drawer");
  await page.locator(".drawer select[aria-label='Authentication']").selectOption("password");
  await page.locator(".drawer input[aria-label='Secret']").fill(SECRET);
  assert.equal(await page.locator(".drawer input[aria-label='Secret']").getAttribute("type"), "password");
  // every button in the drawer does something: none is disabled placeholder text
  const labels = await page.locator(".drawer button").allInnerTexts(); assert.ok(labels.some((l) => /Fetch host keys/.test(l)) && labels.some((l) => /Approve host key and add/.test(l)));
  // without an approved host key the form refuses instead of silently adding
  await page.getByRole("button", { name: "Approve host key and add" }).click(); await page.waitForSelector("text=Approve one host key first");
  // the secret field is a password input, so the browser never renders the value as text anywhere in the page
  assert.equal(await page.locator(".drawer input[type='text']").evaluateAll((els, v) => els.some((e) => (e as HTMLInputElement).value === v), SECRET), false);
});

test("accessibility: no serious or critical axe violations on the Cloud section in both themes; the page runs under the strict CSP", { skip, timeout: 240_000 }, async () => {
  for (const theme of ["dark", "light"] as const) {
    for (const tab of ["overview", "environments", "connections", "pipelines"]) {
      const { page, errors } = await open(on, `#/cloud/${tab}`, { theme, bypassCSP: true });
      await page.addScriptTag({ content: AXE });
      const bad = await page.evaluate(async () => {
        // @ts-expect-error axe is injected above
        const r = await window.axe.run(document, { resultTypes: ["violations"] });
        return r.violations.filter((v: { impact: string }) => v.impact === "serious" || v.impact === "critical").map((v: { id: string; nodes: unknown[] }) => `${v.id} x${v.nodes.length}`);
      });
      assert.deepEqual(bad, [], `${theme}/${tab}`); assert.deepEqual(errors, [], `${theme}/${tab}`);
    }
  }
  const { page, errors } = await open(on, "#/cloud/overview", { width: 390 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "no horizontal page scroll on a phone width");
  assert.deepEqual(errors, []);
});
