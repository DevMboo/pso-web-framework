#!/usr/bin/env node
// Real browser WebSocket security of PSO Channels behind the PSO edge, on a non-standard port (8443) and on 443: a workspace with two
// shells and an orchestrator with Channels (Dispatch on Redis), the pso-dev identity, real containers, real Chrome. For each port:
//   - the shell's own page opens wss://<its host>/channels under its real Content-Security-Policy, authenticates and is acknowledged;
//   - the other shell (a declared origin of the same application) is accepted;
//   - a page of an undeclared origin is refused by the orchestrator (403), and so is a forged Origin from a non-browser client;
//   - no wildcard or client-supplied authority is involved (the edge's configuration and the orchestrator's allowlist are checked).
//   node scripts/reference/validate-channels-origin.mjs [--cli <pso.js>] [--evidence <dir>] [--keep]
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const cli = flag("cli") ?? join(repo, "packages", "cli", "bin", "pso.js");
const evidence = flag("evidence");
const { plan } = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const { INFRA_HOOKS } = await import(new URL("../../packages/cli/dist/commands-infra.js", import.meta.url).href);
const { chromium } = await import(new URL("../../node_modules/playwright-core/index.mjs", import.meta.url).href);
const WebSocket = (await import(new URL("../../node_modules/ws/wrapper.mjs", import.meta.url).href)).default;

const results = [];
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s]`;
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, ...(detail ? { detail: String(detail).slice(0, 400) } : {}) }); console.log(`${stamp()} ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 400)}`}`); return !!ok; };
const run = (cwd, cmd, args, o = {}) => {
  const s = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: o.shell ?? false, timeout: 1_800_000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1", FORCE_COLOR: "0", PSO_NO_BROWSER: "1" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`${stamp()}   ${o.label ?? `${cmd} ${args.join(" ")}`.slice(0, 140)} -> exit ${r.status} (${((Date.now() - s) / 1000).toFixed(1)} s)`);
  if (r.status !== 0) console.log(out.split(/\r?\n/).slice(-12).map((l) => `      | ${l}`).join("\n"));
  return { code: r.status, out };
};
const pso = (cwd, args) => run(cwd, process.execPath, [cli, ...args], { label: `pso ${args.join(" ")}` });

const base = mkdtempSync(join(tmpdir(), "pso-chorigin-")); const ws = join(base, "shop");
const project = `psochan-${randomBytes(3).toString("hex")}`;
const record = { cli, project, ports: {} };
let browser;
try {
  check("create workspace", pso(base, ["create", "workspace", "shop"]).code === 0);
  for (const c of [["orchestrator", "gateway"], ["fei", "shop"], ["fei", "admin"]]) check(`create ${c.join(" ")}`, pso(ws, ["create", ...c]).code === 0);
  const refused = pso(ws, ["channels:enable", "--service", "gateway"]);
  check("channels:enable before Dispatch is refused and names the command (nothing written)", refused.code !== 0 && /pso dispatch:install/.test(refused.out));
  for (const c of [["dispatch:install", "redis", "--service", "gateway"], ["channels:enable", "--service", "gateway"], ["make:channel", "products", "products", "--pattern", "products", "--service", "gateway"]]) check(`pso ${c.join(" ")}`, pso(ws, c).code === 0);
  check("infra:init --identity pso-dev --runtime docker --users ana", pso(ws, ["infra:init", "--identity", "pso-dev", "--runtime", "docker", "--users", "ana"]).code === 0);
  const setPort = (port) => {
    const f = join(ws, "pso.infra.json"); const c = JSON.parse(readFileSync(f, "utf8"));
    c.environments.local.httpsPort = port; c.environments.local.redis = { port: 26379 }; c.docker = { project };
    c.redis = { clients: { gateway: ["REDIS_URL"] } };
    c.services = { gateway: { environment: { PSO_DISPATCH_ENABLED: "true" } } };
    writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
  };
  setPort(8443);
  check("infra:apply", pso(ws, ["infra:apply", "--yes"]).code === 0);
  for (const d of ["frontends/fei-shop", "frontends/fei-admin"]) check(`npm install in ${d}`, run(join(ws, ...d.split("/")), "npm", ["install", "--no-audit", "--no-fund"], { shell: true }).code === 0);
  check("frontend:build --env local", pso(ws, ["frontend:build", "--env", "local"]).code === 0);
  check("frontend:publish --all --env local", pso(ws, ["frontend:publish", "--all", "--env", "local"]).code === 0);

  for (const port of [8443, 443]) {
    if (port !== 8443) { setPort(port); check(`port ${port}: infra:apply`, pso(ws, ["infra:apply", "--yes"]).code === 0); }
    const up = pso(ws, ["docker:up", "--env", "local", "--vendor", "--timeout", "900"]);
    check(`port ${port}: docker:up (every container healthy)`, up.code === 0);
    const p = plan(ws, "local", INFRA_HOOKS); const t = p.topology;
    const shop = t.frontends.find((f) => f.name === "fei-shop"), adm = t.frontends.find((f) => f.name === "fei-admin");
    const conf = readFileSync(join(ws, ".infra", "nginx", "local", "edge.conf"), "utf8");
    const compose = readFileSync(join(ws, ".infra", "docker", "local", "compose.yml"), "utf8");
    const allowed = compose.match(/PSO_CHANNELS_ALLOWED_ORIGINS: "([^"]*)"/)?.[1] ?? "";
    check(`port ${port}: the edge forwards Host with the external authority (${port === 443 ? "$host" : `$host:${port}`}), never a client value`, conf.includes(`proxy_set_header Host ${port === 443 ? "$host;" : `$host:${port};`}`) && !/\$http_host/.test(conf));
    check(`port ${port}: the orchestrator allows exactly the two shells' origins (${allowed})`, allowed === [shop.origin, adm.origin].sort().join(",") && !allowed.includes("*"));
    const token = (pso(ws, ["infra:token", "--env", "local", "--user", "ana"]).out.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/) ?? [])[0];
    check(`port ${port}: development token issued`, !!token);
    const leaf = new X509Certificate(readFileSync(join(ws, ".infra", "certs", "local", "edge", "tls.crt")));
    const spki = createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("base64");
    browser = await chromium.launch({ channel: "chrome", args: [`--host-resolver-rules=MAP *.${t.domain} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`] });
    // the WebSocket is opened BY THE PAGE (the browser sets Origin itself); resolves with what the page observed
    const openFrom = async (pageUrl, wsUrl, o = {}) => {
      const ctx = await browser.newContext({ bypassCSP: !!o.bypassCSP });
      const page = await ctx.newPage();
      if (o.fulfill) await page.route(pageUrl, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>other site</title><p>other site</p>" }));
      await page.goto(pageUrl, { waitUntil: "load", timeout: 60_000 });
      const out = await page.evaluate(({ wsUrl, token }) => new Promise((done) => {
        const s = new WebSocket(wsUrl, "pso.channels.v1"); const seen = { opened: false, frames: [] };
        const end = (why) => { seen.end = why; try { s.close(); } catch { /* closed */ } done(seen); };
        s.onopen = () => { seen.opened = true; };
        s.onmessage = (m) => { const f = JSON.parse(m.data); seen.frames.push(f.t); if (f.t === "ready") s.send(JSON.stringify({ v: 1, t: "auth", token })); else if (f.t === "ack" && f.authenticated) end("authenticated"); else if (f.t === "error") end(`error ${f.code}`); };
        s.onerror = () => { seen.error = true; }; s.onclose = (e) => end(`closed ${e.code}`);
        setTimeout(() => end("timeout"), 15_000);
      }), { wsUrl, token });
      out.origin = await page.evaluate(() => location.origin);
      await ctx.close();
      return out;
    };
    const wsShop = `wss://${shop.host}${port === 443 ? "" : `:${port}`}/channels`;
    const own = await openFrom(shop.url, wsShop);
    check(`port ${port}: real browser, the shop's own page (its real CSP): WebSocket opened, authenticated`, own.opened && own.end === "authenticated", JSON.stringify(own));
    const ownAdmin = await openFrom(adm.url, `wss://${adm.host}${port === 443 ? "" : `:${port}`}/channels`);
    check(`port ${port}: real browser, the admin shell's own page: WebSocket opened, authenticated`, ownAdmin.opened && ownAdmin.end === "authenticated", JSON.stringify(ownAdmin));
    const cross = await openFrom(adm.url, wsShop, { bypassCSP: true });
    check(`port ${port}: real browser, the other declared shell (Origin ${adm.origin}) is accepted by the orchestrator`, cross.opened && cross.end === "authenticated", JSON.stringify(cross));
    const evil = await openFrom("https://evil.example.test/", wsShop, { bypassCSP: true, fulfill: true });
    check(`port ${port}: real browser, an undeclared origin (https://evil.example.test) is refused before any frame`, !evil.opened && evil.frames.length === 0 && /closed 1006/.test(evil.end), JSON.stringify(evil));
    const portless = await openFrom(`https://${shop.host}${port === 443 ? ":8443" : ""}/`, wsShop, { bypassCSP: true, fulfill: true });
    check(`port ${port}: real browser, the shop's host on another port (Origin ${portless.origin}) is refused`, !portless.opened && portless.frames.length === 0, JSON.stringify(portless));
    // a non-browser client cannot borrow an allowed origin's authority by forging forwarded headers: Origin is compared with the allowlist
    const forged = await new Promise((res) => {
      const s = new WebSocket(`wss://127.0.0.1:${port}/channels`, "pso.channels.v1", { rejectUnauthorized: false, servername: shop.host, headers: { host: `${shop.host}:${port}`, origin: "https://evil.example.test", "x-forwarded-host": `${shop.host}:${port}`, forwarded: `host=${shop.host}:${port}` } });
      s.on("unexpected-response", (_q, r) => res({ status: r.statusCode })); s.on("open", () => { s.close(); res({ status: 101 }); }); s.on("error", (e) => res({ error: e.message })); setTimeout(() => res({ error: "timeout" }), 15_000);
    });
    check(`port ${port}: forged Origin with forged X-Forwarded-Host/Forwarded headers is refused (403)`, forged.status === 403, JSON.stringify(forged));
    const logs = run(ws, "docker", ["compose", "-p", project, "logs", "--no-color", "--tail", "300", "gateway"], { label: "docker compose logs gateway" }).out;
    check(`port ${port}: the orchestrator logged the refused origins`, /channels upgrade refused: origin/.test(logs));
    record.ports[port] = { own, ownAdmin, cross, evil, portless, forged, allowed };
    await browser.close(); browser = undefined;
  }
} finally {
  await browser?.close().catch(() => undefined);
  if (!a.includes("--keep")) pso(ws, ["docker:down", "--env", "local", "--volumes", "--yes"]);
  const failed = results.filter((r) => !r.ok).length;
  if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "channels-origin.json"), JSON.stringify({ ...record, results, at: new Date().toISOString() }, null, 2)); }
  if (!a.includes("--keep")) { try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ } }
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed ? 1 : 0;
}
