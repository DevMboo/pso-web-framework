import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { SCOPES, launch, type Launched } from "./channels-fixture.ts";

/**
 * The two front-end examples of the documentation (docs/examples/channels: plain HTML + JavaScript, and React + TypeScript) running in a REAL
 * browser (Chromium-based Edge or Chrome, headless) against a REAL orchestrator: they authenticate, subscribe to a resource channel, receive a
 * typed event published by the application, and a user without access to the resource is refused. The page is served from its own origin, so
 * the orchestrator's Origin check is exercised as well.
 */
const repo = resolve(import.meta.dirname, "../../..");
const examples = join(repo, "packages/cli/docs/examples/channels");
const browserPath = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const cleanup: Array<() => void> = [];
after(() => { for (const c of cleanup.reverse()) { try { c(); } catch { /* best effort */ } } });

async function scenario(name: string, files: (a: Launched) => Record<string, { type: string; body: string | Buffer }>, ready: RegExp, eventText: string): Promise<void> {
  // the page origin must be allowed by the orchestrator: reserve its port first
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const pagePort = (probe.address() as AddressInfo).port; await new Promise((r) => probe.close(r));
  const a = await launch("RecruitmentChannel, CandidateChannel", { PSO_CHANNELS_ALLOWED_ORIGINS: `http://127.0.0.1:${pagePort}`, PSO_CHANNELS_HEARTBEAT_MS: "30000" });
  cleanup.push(() => a.child.kill());
  const html = files(a);
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/token") return void res.writeHead(200, { "content-type": "text/plain" }).end(await a.token(url.searchParams.get("user") ?? "nobody", SCOPES));
    const f = html[url.pathname === "/" ? "/index.html" : url.pathname];
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": f.type }).end(f.body);
  });
  await new Promise<void>((r) => srv.listen(pagePort, "127.0.0.1", r));
  cleanup.push(() => { srv.close(); srv.closeAllConnections(); });
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  cleanup.push(() => void browser.close());
  const q = (user: string, candidate: string) => `/?orchestrator=${encodeURIComponent(`http://127.0.0.1:${a.port}`)}&user=${user}&candidate=${candidate}`;
  const writer = await a.token("writer", "candidate:write");

  // alice owns candidate c1: she connects, subscribes and receives the typed event
  const alice = await browser.newPage();
  const pageErrors: string[] = []; alice.on("pageerror", (e) => pageErrors.push(e.message));
  await alice.goto(`http://127.0.0.1:${pagePort}${q("alice", "c1")}`);
  await alice.waitForFunction((re) => new RegExp(re).test(document.body.innerText), ready.source, { timeout: 15_000 });
  const r = await fetch(a.http("/recruitment/candidates/c1/status"), { method: "POST", headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" }, body: JSON.stringify({ status: "HIRED" }) });
  assert.equal(r.status, 201);
  await alice.waitForFunction((t) => document.body.innerText.includes(t), eventText, { timeout: 15_000 });
  assert.deepEqual(pageErrors, [], `${name}: no script errors in the page`);

  // bob may not see candidate c1: the server says so, and the event never reaches his page
  const bob = await browser.newPage();
  await bob.goto(`http://127.0.0.1:${pagePort}${q("bob", "c1")}`);
  await bob.waitForFunction(() => document.body.innerText.includes("Not allowed."), undefined, { timeout: 15_000 });
  await fetch(a.http("/recruitment/candidates/c1/status"), { method: "POST", headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" }, body: JSON.stringify({ status: "REJECTED" }) });
  await alice.waitForFunction(() => document.body.innerText.includes("is now REJECTED"), undefined, { timeout: 15_000 });
  assert.ok(!(await bob.innerText("body")).includes("is now"), `${name}: the unauthorized user received nothing`);

  // a page served from an origin the orchestrator does not allow cannot connect
  const other = createServer((_q, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<script>const w=new WebSocket("ws://127.0.0.1:${a.port}/channels","pso.channels.v1");w.onopen=()=>document.title="open";w.onerror=()=>document.title="refused";</script>`));
  await new Promise<void>((res) => other.listen(0, "127.0.0.1", res)); cleanup.push(() => { other.close(); other.closeAllConnections(); });
  const evil = await browser.newPage();
  await evil.goto(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`);
  await evil.waitForFunction(() => document.title === "refused" || document.title === "open", undefined, { timeout: 10_000 });
  assert.equal(await evil.title(), "refused", `${name}: a foreign origin is refused before the upgrade`);
}

test("plain HTML + JavaScript example in a real browser", { skip: browserPath ? false : "no Chromium-based browser found", timeout: 300_000 }, async () => {
  await scenario("html", () => ({
    "/index.html": { type: "text/html", body: readFileSync(join(examples, "index.html")) },
    "/app.js": { type: "text/javascript", body: readFileSync(join(examples, "app.js")) },
    "/client.js": { type: "text/javascript", body: readFileSync(join(repo, "packages/channels-client/dist/index.js")) },
  }), /subscribed/, "candidate.updated: c1 is now HIRED");
});

test("React + TypeScript example in a real browser (bundled from the documented sources)", { skip: browserPath ? false : "no Chromium-based browser found", timeout: 300_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "pso-react-")); cleanup.push(() => rmSync(out, { recursive: true, force: true }));
  const r = await build({ entryPoints: [join(examples, "react/main.tsx")], bundle: true, format: "esm", outfile: join(out, "bundle.js"), jsx: "automatic", platform: "browser", define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent", absWorkingDir: repo });
  assert.deepEqual(r.errors, []);
  await scenario("react", () => ({
    "/index.html": { type: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/bundle.js"></script>' },
    "/bundle.js": { type: "text/javascript", body: readFileSync(join(out, "bundle.js")) },
  }), /connected/, "candidate.updated: c1 is now HIRED");
});

test("the React example type-checks with strict TypeScript against the published declarations", { timeout: 120_000 }, () => {
  const r = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--jsx", "react-jsx", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2023", "--lib", "es2023,dom", "--skipLibCheck", "--types", "react", join(examples, "react/main.tsx")], { encoding: "utf8", cwd: repo });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
