#!/usr/bin/env node
// Real Chrome against PSO Studio (started with --ops) on the running reference stack: infrastructure, containers, hosts, certificates,
// deployment, two shells in the frontend view, the API Client sending real requests with real tokens, the execution boundary (no
// arbitrary destination), masked history, typed-confirmation operations, and no key material or secret value in any page.
// Usage: node scripts/reference/validate-studio.mjs [workspace] [evidence-dir]
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const root = resolve(process.argv[2] ?? join(repo, "fixtures", "pso-reference"));
const outDir = resolve(process.argv[3] ?? join(repo, "docs", "implementation", "evidence", "v020", "studio"));
mkdirSync(join(outDir, "shots"), { recursive: true });
process.env.PSO_NO_BROWSER = "1";
const { startStudio } = await import(new URL("../../packages/cli/dist/studio.js", import.meta.url).href);
const { chromium } = await import(new URL("../../node_modules/playwright-core/index.mjs", import.meta.url).href);
const secrets = readdirSync(join(root, ".infra", "secrets", "local")).map((n) => readFileSync(join(root, ".infra", "secrets", "local", n), "utf8").trim());
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond, ...(detail ? { detail } : {}) }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const studio = await startStudio({ root, ops: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const leaks = async (label) => { const html = await page.content(); const bad = /PRIVATE KEY/.test(html) || secrets.some((s) => s.length >= 12 && html.includes(s)) || /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(html); check(`${label}: no key material, secret value or token in the page`, !bad); };
const go = async (hash, waitText) => { await page.goto(`http://127.0.0.1:${studio.port}/#/${hash}`); await page.getByText(waitText, { exact: false }).first().waitFor({ timeout: 60_000 }); await page.waitForTimeout(500); };
try {
  await page.goto(studio.url);
  await go("infrastructure", "Pending changes");
  const pending = await page.locator(".metric").filter({ hasText: "Pending changes" }).locator(".metric-value").textContent();
  check("Infrastructure: the local environment is fully provisioned (0 pending changes)", pending?.trim() === "0", pending ?? "");
  check("Infrastructure: resources are listed by module with owner and status", await page.locator("code", { hasText: "cert:edge" }).count() > 0 && await page.locator("code", { hasText: "identity:realm" }).count() > 0);
  await page.getByRole("button", { name: "Validate + probe running environment" }).click();
  await page.getByText("edge: unknown host is refused").waitFor({ timeout: 60_000 });
  const probeRows = await page.locator("table", { has: page.locator("caption", { hasText: "Live probes" }) }).locator("tbody tr").count();
  check("Infrastructure: validation probes the running environment for real", probeRows >= 6 && (await page.getByText("valid", { exact: true }).count()) > 0, `${probeRows} probes`);
  await page.screenshot({ path: join(outDir, "shots", "01-infrastructure.png"), fullPage: true }); await leaks("Infrastructure");

  await go("containers", "Topology (dependency order)");
  const running = await page.locator("tbody tr").filter({ hasText: "running" }).count();
  check("Containers: every container of the stack is running, in dependency order", running >= 8, `${running} running`);
  await page.getByRole("button", { name: "gateway", exact: true }).click();
  await page.locator(".log-view").filter({ hasText: "orchestrator" }).waitFor({ timeout: 30_000 });
  check("Containers: a container's log is shown", (await page.locator(".log-view").textContent())?.includes("upstream configured"));
  await page.screenshot({ path: join(outDir, "shots", "02-containers.png"), fullPage: true }); await leaks("Containers");
  // operation with a typed confirmation: a wrong text is refused, the right one restarts only that container
  await page.locator("select[aria-label='Container']").selectOption("fei-admin");
  await page.getByRole("button", { name: "Prepare" }).click();
  const restartInput = page.locator("input[placeholder='restart fei-admin']");
  await restartInput.fill("restart something-else");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await page.getByText('Type "restart fei-admin" to confirm').first().waitFor({ timeout: 10_000 });
  check("Containers: an operation without the exact typed confirmation is not sent", true);
  await restartInput.fill("restart fei-admin");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await page.getByText("restart: done").first().waitFor({ timeout: 120_000 });
  check("Containers: restart of one container with the typed confirmation", true);

  await go("hosts", "Public hosts");
  check("Hosts: frontends, API and identity provider hosts with container and process addresses", await page.getByText("shop.pso.localhost").count() > 0 && await page.getByText("admin.pso.localhost").count() > 0 && await page.getByText("https://accounts:8082").count() > 0 && await page.getByText("http://127.0.0.1:8082").count() > 0);
  await page.screenshot({ path: join(outDir, "shots", "03-hosts.png"), fullPage: true });

  await go("certificates", "Authorities and certificates");
  check("Certificates: authorities and certificates with names, expiry and fingerprint", await page.locator("code", { hasText: "cert:accounts" }).count() > 0 && await page.getByText("SHA-256").count() > 0);
  check("Certificates: secrets shown by source and length only", await page.getByText(".infra/secrets/local/user-ana").count() > 0);
  await page.screenshot({ path: join(outDir, "shots", "04-certificates.png"), fullPage: true }); await leaks("Certificates");

  await go("deployment", "Frontend publication");
  check("Deployment: the plan of the environment is shown", await page.getByText("start the containers in dependency order").count() > 0);
  await page.screenshot({ path: join(outDir, "shots", "05-deployment.png"), fullPage: true });

  await go("frontend", "Relationships");
  check("Frontend: both shells with their own microfrontends", await page.locator("strong", { hasText: "fei-shop" }).count() > 0 && await page.locator("strong", { hasText: "fei-admin" }).count() > 0 && await page.getByText("public", { exact: true }).count() > 0);
  await page.screenshot({ path: join(outDir, "shots", "06-frontend-two-shells.png"), fullPage: true });

  // API Client: discovered endpoints, real requests through the edge with tokens issued by the environment's Keycloak
  await go("api-client", "Endpoints");
  check("API Client: endpoints are discovered from the declarations", await page.locator(".endpoint", { hasText: "/accounts/users" }).count() > 0 && await page.locator(".endpoint", { hasText: "/catalog/products" }).count() > 0);
  await page.locator(".endpoint", { hasText: "/catalog/products" }).first().click();
  await page.locator("select[aria-label='Target']").selectOption("edge:api");
  await page.locator("select[aria-label='Authentication']").selectOption("none");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".response-body").waitFor({ timeout: 30_000 });
  check("API Client: public endpoint without credentials returns 200 with data", (await page.locator(".badge").filter({ hasText: /^200/ }).count()) > 0 && (await page.locator(".response-body").textContent())?.includes("Espresso beans"));
  await page.locator(".endpoint", { hasText: "/accounts/users" }).first().click();
  await page.locator("select[aria-label='Target']").selectOption("edge:api");
  await page.locator("select[aria-label='Authentication']").selectOption("dev-user");
  await page.locator("select[aria-label='Development user']").selectOption("ana");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".response-body", { hasText: "bob" }).waitFor({ timeout: 30_000 });
  check("API Client: ana's real token reaches accounts through the edge and mutual TLS (200)", (await page.locator(".badge").filter({ hasText: /^200/ }).count()) > 0, await page.locator(".badge").filter({ hasText: /TLS/ }).first().textContent());
  await page.locator("select[aria-label='Development user']").selectOption("bob");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".badge").filter({ hasText: /^403/ }).first().waitFor({ timeout: 30_000 });
  check("API Client: bob (without users:admin) gets 403 from the real backend", true);
  await page.screenshot({ path: join(outDir, "shots", "07-api-client.png"), fullPage: true }); await leaks("API Client");
  // the execution boundary, called the way the page calls it (same origin, CSRF header): no arbitrary destination
  const boundary = await page.evaluate(async () => {
    const send = async (b) => { const r = await fetch("/api/client/send", { method: "POST", headers: { "content-type": "application/json", "x-pso-studio": "1" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
    return {
      foreignTarget: await send({ target: "https://example.com", method: "GET", path: "/" }),
      schemePath: await send({ target: "edge:api", method: "GET", path: "/http://169.254.169.254/latest" }),
      protocolRelative: await send({ target: "edge:api", method: "GET", path: "//evil.example/x" }),
      dotSegments: await send({ target: "edge:api", method: "GET", path: "/catalog/../../etc/passwd" }),
      hostHeader: await send({ target: "edge:api", method: "GET", path: "/health/ready", headers: [["host", "evil.example"]] }),
    };
  });
  check("API Client boundary: an undeclared destination is refused", boundary.foreignTarget.status === 400, boundary.foreignTarget.body.error);
  check("API Client boundary: a path carrying a scheme/host is refused", boundary.schemePath.status === 400 && boundary.protocolRelative.status === 400, `${boundary.schemePath.body.error}`);
  check("API Client boundary: dot segments and a forged Host header are refused", boundary.dotSegments.status === 400 && boundary.hostHeader.status === 400, `${boundary.hostHeader.body.error}`);
  const hist = readFileSync(join(root, ".pso", "studio", "api-history.json"), "utf8");
  check("API Client history: requests recorded with credentials masked and no token", /Bearer \[REDACTED\]/.test(hist) && !/eyJ[A-Za-z0-9_-]{20,}/.test(hist), "authorization: Bearer [REDACTED]");
  // CSRF: a request without the Studio header (what a cross-site form can send) is refused
  const csrf = await page.evaluate(async () => (await fetch("/api/ops/containers", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status);
  check("Studio refuses a mutating request without its CSRF header", csrf === 403, `HTTP ${csrf}`);
  check("no uncaught errors in Studio", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  check("scenario completed without an exception", false, e.message.split("\n")[0]);
  await page.screenshot({ path: join(outDir, "shots", "failure.png"), fullPage: true }).catch(() => {});
} finally { await browser.close(); await studio.close(); }
writeFileSync(join(outDir, "studio-result.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
