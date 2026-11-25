import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { detectPackageManager, installCommand, loadProject } from "../src/integrations/core.ts";
import { launch, SCOPES } from "./channels-fixture.ts";
import { pso } from "./helpers.ts";

/**
 * `pso install:react channels`: detection and safety (fast, no network) and the real thing: a React + TypeScript application is created, the
 * installer runs in it with the real npm, the generated files compile under strict TypeScript, and the application - bundled and opened in a
 * real browser - connects to a real PSO orchestrator: authorized subscription, refused subscription, typed events, unmount cleanup,
 * reconnection and a session change.
 */
const repo = resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
const cleanup: Array<() => void> = [];
after(() => { for (const c of cleanup.reverse()) { try { c(); } catch { /* best effort */ } } for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const tmpApp = (): string => { const d = mkdtempSync(join(tmpdir(), "pso-react-app-")); dirs.push(d); return d; };
const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");
const write = (root: string, rel: string, text: string): void => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };

const TSCONFIG = JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true, isolatedModules: true, types: [] }, include: ["src"] }, null, 2);
function app(over: Record<string, unknown> = {}, opts: { ts?: boolean; src?: boolean } = {}): string {
  const root = tmpApp();
  write(root, "package.json", JSON.stringify({ name: "demo-app", private: true, version: "0.0.0", type: "module", dependencies: { react: "18.3.1", "react-dom": "18.3.1" }, devDependencies: { typescript: "5.9.3", "@types/react": "18.3.12", "@types/react-dom": "18.3.1" }, ...over }, null, 2) + "\n");
  if (opts.ts !== false) write(root, "tsconfig.json", TSCONFIG);
  if (opts.src !== false) { write(root, "src/App.tsx", "export function App() { return <h1>My app</h1>; }\n"); write(root, "src/main.tsx", 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n'); }
  return root;
}
const run = (root: string, ...args: string[]) => pso(root, ...args);

// ---------------------------------------------------------------- detection and safety (no network)
test("package manager detection: the packageManager field, then the lockfile; conflicts are refused; commands are exact", () => {
  const mk = (pkg: object, files: string[] = []): string => { const r = tmpApp(); write(r, "package.json", JSON.stringify(pkg)); for (const f of files) write(r, f, ""); return r; };
  const det = (r: string) => detectPackageManager(r, JSON.parse(readFileSync(join(r, "package.json"), "utf8")));
  assert.equal(det(mk({}, ["package-lock.json"])).name, "npm");
  assert.equal(det(mk({}, ["pnpm-lock.yaml"])).name, "pnpm");
  assert.equal(det(mk({}, ["yarn.lock"])).name, "yarn");
  assert.equal(det(mk({ packageManager: "pnpm@9.1.0" })).name, "pnpm");
  assert.equal(det(mk({ packageManager: "yarn@4.1.0+sha1.abc" }, ["yarn.lock"])).version, "4.1.0");
  assert.equal(det(mk({})).name, "npm", "no evidence: npm, said explicitly");
  assert.match(det(mk({})).source, /no lockfile/);
  assert.throws(() => det(mk({}, ["yarn.lock", "pnpm-lock.yaml"])), /Several lockfiles/);
  assert.throws(() => det(mk({ packageManager: "pnpm@9.1.0" }, ["yarn.lock"])), /says pnpm@9.1.0 but yarn.lock exists/);
  const pk = [{ name: "@pso/channels-client", spec: "^0.1.0" }, { name: "@pso/react-channels", spec: "file:/x/react-channels" }];
  assert.deepEqual(installCommand("npm", pk), { command: "npm", args: ["install", "--no-audit", "--no-fund", "--save", "@pso/channels-client@^0.1.0", "file:/x/react-channels"] });
  assert.deepEqual(installCommand("pnpm", pk), { command: "pnpm", args: ["add", "@pso/channels-client@^0.1.0", "file:/x/react-channels"] });
  assert.deepEqual(installCommand("yarn", pk), { command: "yarn", args: ["add", "@pso/channels-client@^0.1.0", "file:/x/react-channels"] });
  assert.equal(loadProject(join(app(), "src")).root.length > 0, true, "the project root is found from a sub-folder");
  assert.throws(() => loadProject(tmpdir().replace(/[\\/][^\\/]*$/, "")), /package.json/);
});

test("the installer refuses what it cannot support, and touches nothing when it does", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["no react", app({ dependencies: {} }), /React is not a dependency/],
    ["react 17", app({ dependencies: { react: "17.0.2", "react-dom": "17.0.2" } }), /React 17.0.2 is not supported/],
    ["no typescript", app({ devDependencies: {} }, { ts: false }), /No tsconfig.json[\s\S]*TypeScript is not installed/],
    ["no src", app({}, { src: false }), /No src\/ folder found/],
  ];
  for (const [name, root, re] of cases) {
    const before = sha(join(root, "package.json"));
    const r = await run(root, "install:react", "channels");
    assert.equal(r.code, 1, name); assert.match(r.out + r.err, re, name);
    assert.equal(sha(join(root, "package.json")), before, `${name}: package.json untouched`);
    assert.ok(!existsSync(join(root, "node_modules")) && !existsSync(join(root, "src/integrations")), `${name}: nothing installed or written`);
  }
  const root = app();
  assert.equal((await run(root, "install:react", "nope")).code, 1);
  assert.equal((await run(root, "install:react", "channels", "--dir", "../outside")).code, 1);
  assert.equal((await run(root, "install:react", "channels", "--dir", "/abs")).code, 1);
  assert.equal((await run(join(tmpdir(), "definitely-not-a-project-dir-xyz"), "install:react", "channels").catch(() => ({ code: 1 }))).code, 1);
});

test("dry run shows packages, files and contracts and changes nothing; an existing user file is a conflict, never overwritten", async () => {
  const root = app();
  const before = sha(join(root, "package.json"));
  const d = await run(root, "install:react", "channels", "--dry-run", "--json");
  assert.equal(d.code, 0, d.out + d.err);
  const rep = JSON.parse(d.out) as { dryRun: boolean; packages: Array<{ name: string; action: string }>; files: Array<{ path: string; action: string }>; packageManager: string };
  assert.equal(rep.dryRun, true);
  assert.deepEqual(rep.packages.map((p) => [p.name, p.action]), [["@pso/channels-client", "planned"], ["@pso/react-channels", "planned"]]);
  assert.deepEqual(rep.files.map((f) => [f.path, f.action]), [["src/integrations/pso/client.ts", "planned"], ["src/integrations/pso/channels.ts", "planned"], ["src/integrations/pso/types.ts", "planned"]]);
  assert.match(rep.packageManager, /npm/);
  assert.equal(sha(join(root, "package.json")), before); assert.ok(!existsSync(join(root, "src/integrations")));
  write(root, "src/integrations/pso/client.ts", "// my own client, nothing to do with PSO\nexport const mine = 1;\n");
  const mine = sha(join(root, "src/integrations/pso/client.ts"));
  const c = await run(root, "install:react", "channels", "--skip-install");
  assert.equal(c.code, 1); assert.match(c.out + c.err, /client\.ts already exists and was not written by PSO/);
  assert.equal(sha(join(root, "src/integrations/pso/client.ts")), mine, "the user file is untouched");
  assert.ok(!existsSync(join(root, "src/integrations/pso/channels.ts")), "nothing else is written when a conflict is found");
});

test("--skip-install writes the files and tells the developer the exact packages to add; the generated files use the right endpoint source per bundler", async () => {
  for (const [deps, expect] of [[{ vite: "5.0.0" }, /import\.meta[\s\S]*VITE_PSO_CHANNELS_URL/], [{ "react-scripts": "5.0.1" }, /process\.env\.REACT_APP_PSO_CHANNELS_URL/], [{}, /globalThis as \{ PSO_CHANNELS_URL/]] as const) {
    const root = app({ devDependencies: { typescript: "5.9.3", "@types/react": "18.3.12", ...deps } });
    const r = await run(root, "install:react", "channels", "--skip-install");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(readFileSync(join(root, "src/integrations/pso/client.ts"), "utf8"), expect);
    assert.match(r.out, /--skip-install: add these yourself with npm: @pso\/channels-client@.* @pso\/react-channels@/);
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(["client", "channels", "types"].map((f) => readFileSync(join(root, `src/integrations/pso/${f}.ts`), "utf8")).join("")), "the integration never stores credentials");
  }
});

// ---------------------------------------------------------------- the real thing
const browserPath = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);

test("install:react channels in a real React + TypeScript app, then the app talks to a real PSO orchestrator in a real browser", { skip: browserPath ? false : "no Chromium-based browser found", timeout: 600_000 }, async () => {
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const pagePort = (probe.address() as AddressInfo).port; await new Promise((r) => probe.close(r));
  const a = await launch("RecruitmentChannel, CandidateChannel", { PSO_CHANNELS_ALLOWED_ORIGINS: `http://127.0.0.1:${pagePort}`, PSO_CHANNELS_HEARTBEAT_MS: "30000" });
  cleanup.push(() => a.child.kill());
  const root = app();
  write(root, "src/legacy/keep.ts", "export const keep = 'user code that must survive';\n");
  const mine = ["tsconfig.json", "src/App.tsx", "src/main.tsx", "src/legacy/keep.ts"].map((f) => [f, sha(join(root, f))] as const);
  const depsBefore = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };

  // --- install: the real npm, the contracts of the real orchestrator
  const first = await run(root, "install:react", "channels", "--contracts", a.g.gw);
  assert.equal(first.code, 0, first.out + first.err);
  assert.match(first.out, /state before: none[\s\S]*installed\s+@pso\/channels-client[\s\S]*installed\s+@pso\/react-channels[\s\S]*installed and verified/);
  assert.match(first.out, /contracts: 2 channel\(s\)/);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  assert.ok(pkg.dependencies["@pso/channels-client"] && pkg.dependencies["@pso/react-channels"]);
  for (const [k, v] of Object.entries(depsBefore.dependencies)) assert.equal(pkg.dependencies[k], v, `${k} is untouched`);
  assert.ok(existsSync(join(root, "package-lock.json")), "npm's own lockfile was used");
  assert.ok(existsSync(join(root, "node_modules/@pso/react-channels")));
  const types = readFileSync(join(root, "src/integrations/pso/types.ts"), "utf8");
  assert.match(types, /"candidate\.\{candidateId\}": \{\s+params: \{ candidateId: string \};\s+events: \{ "candidate\.updated": CandidateUpdatedDto \}/);
  assert.match(types, /commands: \{ "candidate\.subscribe": CandidateSubscriptionDto \}/);
  assert.ok(!/recruitment-service|publishers|ghost|Scopes|OnSubscribe|canSubscribe|CandidateAccess|127\.0\.0\.1|secret/i.test(types), "no publishers, policies, scopes, unregistered channels or addresses in the contracts");
  for (const [f, h] of mine) assert.equal(sha(join(root, f)), h, `${f} is unchanged`);

  // --- repeating is safe; a partial installation is completed without touching the rest
  const lock = sha(join(root, "package-lock.json")), gen = ["client", "channels", "types"].map((f) => sha(join(root, `src/integrations/pso/${f}.ts`)));
  const again = await run(root, "install:react", "channels", "--contracts", a.g.gw);
  assert.equal(again.code, 0, again.out + again.err); assert.match(again.out, /state before: complete[\s\S]*already installed/);
  assert.deepEqual(["client", "channels", "types"].map((f) => sha(join(root, `src/integrations/pso/${f}.ts`))), gen); assert.equal(sha(join(root, "package-lock.json")), lock);
  rmSync(join(root, "src/integrations/pso/channels.ts"));
  const partial = await run(root, "install:react", "channels", "--contracts", a.g.gw);
  assert.match(partial.out, /state before: partial[\s\S]*created\s+src\/integrations\/pso\/channels\.ts/); assert.equal(partial.code, 0);
  assert.deepEqual(["client", "types"].map((f) => sha(join(root, `src/integrations/pso/${f}.ts`))), [gen[0], gen[2]]);

  // --- the developer wires the provider (the installer prints the snippet and never edits App.tsx)
  // the documented example (docs/examples/channels/installed/main.tsx) is exactly what the test runs
  write(root, "src/main.tsx", readFileSync(join(repo, "packages/cli/docs/examples/channels/installed/main.tsx"), "utf8"));
  const tsc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", root], { encoding: "utf8" });
  assert.equal(tsc.status, 0, "the whole application (user code + generated files) type-checks under strict TypeScript:\n" + tsc.stdout + tsc.stderr);
  const bundle = await build({ entryPoints: [join(root, "src/main.tsx")], bundle: true, format: "esm", write: false, jsx: "automatic", platform: "browser", preserveSymlinks: true, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent", absWorkingDir: root });
  assert.deepEqual(bundle.errors, []);
  const js = bundle.outputFiles[0]!.text;
  assert.equal((js.match(/function createPsoChannels\(/g) ?? []).length, 1, "one copy of the client in the bundle: no second connection manager");

  // --- the browser
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/token") return void res.writeHead(200, { "content-type": "text/plain" }).end(await a.token(url.searchParams.get("user") ?? "nobody", SCOPES));
    if (url.pathname === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><div id="root"></div><script>globalThis.PSO_CHANNELS_URL = "ws://127.0.0.1:${a.port}/channels";</script><script type="module" src="/bundle.js"></script>`);
  });
  await new Promise<void>((r) => srv.listen(pagePort, "127.0.0.1", r)); cleanup.push(() => { srv.close(); srv.closeAllConnections(); });
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true }); cleanup.push(() => void browser.close());
  const writer = await a.token("writer", "candidate:write");
  const publish = (status: string) => fetch(a.http("/recruitment/candidates/c1/status"), { method: "POST", headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" }, body: JSON.stringify({ status }) });
  const text = (p: import("playwright-core").Page, sel: string) => p.locator(sel).innerText();
  const waitText = (p: import("playwright-core").Page, t: string, ms = 20_000) => p.waitForFunction((x) => document.body.innerText.includes(x), t, { timeout: ms });
  const stats = async (): Promise<{ connections: number; subscriptions: number }> => ((await (await fetch(a.http("/_pso/telemetry"), { headers: { authorization: "Bearer diagnostics-token-0123456789abcdef" } })).json()) as { channels: { connections: number; subscriptions: number } }).channels;

  const alice = await browser.newPage(); const errors: string[] = []; alice.on("pageerror", (e) => errors.push(e.message));
  await alice.goto(`http://127.0.0.1:${pagePort}/?user=alice`);
  await alice.waitForFunction(() => document.querySelector("#channel")?.textContent === "connected", undefined, { timeout: 20_000 });
  assert.equal(await text(alice, "#state"), "connected", "the provider mounted and the shared connection is up");
  const st = await stats();
  assert.deepEqual([st.connections, st.subscriptions], [1, 1], "one WebSocket and one subscription for the whole app");
  const pr = await publish("INTERVIEW");
  assert.equal(pr.status, 201, (await pr.text()) + " | " + a.logs().slice(-1800));
  await waitText(alice, "c1 is now INTERVIEW");

  const bob = await browser.newPage();
  await bob.goto(`http://127.0.0.1:${pagePort}/?user=bob`);
  await waitText(bob, "Not allowed.");
  assert.equal(await text(bob, "#channel"), "error"); await publish("HIRED"); await waitText(alice, "c1 is now HIRED");
  assert.ok(!(await bob.innerText("body")).includes("is now"), "the refused user receives nothing");
  await bob.close();

  // reconnection: the orchestrator restarts on the same port; the app reconnects, re-authenticates and the server re-authorizes the subscription
  a.child.kill();
  await alice.waitForFunction(() => document.querySelector("#state")?.textContent !== "connected", undefined, { timeout: 20_000 });
  const b = await launch("RecruitmentChannel, CandidateChannel", { PSO_CHANNELS_ALLOWED_ORIGINS: `http://127.0.0.1:${pagePort}`, PSO_CHANNELS_HEARTBEAT_MS: "30000" }, { g: a.g, port: a.port, pub: a.pub, keys: a.keys });
  cleanup.push(() => b.child.kill());
  await alice.waitForFunction(() => document.querySelector("#channel")?.textContent === "connected", undefined, { timeout: 30_000 });
  const wr2 = await b.token("writer", "candidate:write");
  assert.equal((await fetch(b.http("/recruitment/candidates/c1/status"), { method: "POST", headers: { authorization: `Bearer ${wr2}`, "content-type": "application/json" }, body: JSON.stringify({ status: "REJECTED" }) })).status, 201);
  await waitText(alice, "c1 is now REJECTED");

  // unmount cleans up the subscription on the server (the shared connection stays)
  assert.equal((await (async () => { const r = await fetch(b.http("/_pso/telemetry"), { headers: { authorization: "Bearer diagnostics-token-0123456789abcdef" } }); return ((await r.json()) as { channels: { subscriptions: number } }).channels.subscriptions; })()), 1);
  await alice.click("#toggle");
  let subs = 1;
  for (let i = 0; i < 60 && subs !== 0; i++) { await new Promise((r) => setTimeout(r, 100)); subs = ((await (await fetch(b.http("/_pso/telemetry"), { headers: { authorization: "Bearer diagnostics-token-0123456789abcdef" } })).json()) as { channels: { subscriptions: number } }).channels.subscriptions; }
  assert.equal(subs, 0, "unmounting the component removed its server-side subscription");
  await alice.click("#toggle");
  await alice.waitForFunction(() => document.querySelector("#channel")?.textContent === "connected", undefined, { timeout: 20_000 });

  // a session change: the user becomes bob; the connection re-authenticates (the server will not accept another identity on the same socket, so it reconnects) and bob is refused
  await alice.click("#bob");
  await waitText(alice, "Not allowed.", 30_000);
  assert.equal(await text(alice, "#who"), "bob");
  assert.deepEqual(errors, [], "no script errors in the page");
});
