import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { activeFei, activePointer, buildFeiManifest, buildRemoteManifest, publishMei, stageFei, writeRuntimeConfig } from "@pso/frontend/node";
import type { FeiDefinition, MeiDefinition } from "@pso/frontend";

/**
 * The managed nginx adapter and the generated static configuration against a REAL nginx (the Alpine nginx of the disposable Linux image used by
 * the cloud end-to-end tests). `applyProxy` runs inside the container: backup, `nginx -t`, graceful reload. Skipped when Docker or the image is
 * absent (`PSO_E2E_DOCKER=0` also skips it), like the other container tests.
 */
const IMAGE = "pso-e2e-target:1";
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 120_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const available = process.env["PSO_E2E_DOCKER"] !== "0" && docker("image", "inspect", IMAGE).status === 0;

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const fixture = resolve(import.meta.dirname, "fixtures", "static-site");
const norm = (p: string): string => p.replaceAll("\\", "/");

const feiDef: FeiDefinition = { name: "fei-shop", orchestrator: { service: "gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }, { name: "mei-catalog", path: "/catalog" }] };
const meiDef = (name: string): MeiDefinition => ({ name, host: "fei-shop", orchestrator: { service: "gateway" } });
const SHARED = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" };
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "pso-sn-proj-"));
  for (const [n, v] of Object.entries(SHARED)) { mkdirSync(join(dir, "node_modules", n), { recursive: true }); writeFileSync(join(dir, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v })); }
  return dir;
}
const bigJs = (tag: string): string => `/* ${tag} */\n` + `console.log("${tag}");\n`.repeat(200);
function feiDist(version: string): string {
  const dir = project(); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), `<!doctype html><html><body><div id="root"></div><script src="/shop/assets/main-${version}.js"></script>shell ${version}</body></html>`);
  writeFileSync(join(dir, "dist", "assets", `main-${version}.js`), bigJs(`shell ${version}`)); writeFileSync(join(dir, "dist", "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  buildFeiManifest({ dir, definition: feiDef, version, basePath: "/shop/" });
  return join(dir, "dist");
}
function meiDist(name: string, version: string): string {
  const dir = project(); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "remoteEntry.js"), bigJs(`${name} ${version}`)); writeFileSync(join(dir, "dist", "assets", "module.js"), `export default "${name}@${version}"`);
  buildRemoteManifest({ dir, definition: meiDef(name), routes: [], version });
  return join(dir, "dist");
}

interface Res { status: number; headers: Record<string, string>; body: string }
const hdrs = (h: Record<string, string | string[] | undefined>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Res> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, method, agent: false, headers: { host: "shop.test", connection: "close", ...headers }, timeout: 10_000 }, (x) => { const chunks: Buffer[] = []; x.on("data", (c: Buffer) => chunks.push(c)); x.on("end", () => res({ status: x.statusCode ?? 0, headers: hdrs(x.headers), body: Buffer.concat(chunks).toString("utf8") })); });
    r.on("error", rej); r.on("timeout", () => r.destroy(new Error("timeout"))); r.end();
  });
}
function upgrade(port: number, path: string): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: "shop.test", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }, timeout: 10_000 });
    r.on("upgrade", (x, socket) => { socket.destroy(); res({ status: x.statusCode ?? 0, headers: hdrs(x.headers) }); });
    r.on("response", (x) => res({ status: x.statusCode ?? 0, headers: hdrs(x.headers) }));
    r.on("error", rej); r.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const name = `pso-static-${process.pid}`;
after(() => { docker("rm", "-f", name); });

test("real nginx: the managed adapter applies the shell's static configuration; SPA, assets, remotes, API, WebSocket, caching, compression, headers and isolation behave", { skip: available ? false : "Docker or the pso-e2e-target:1 image is not available", timeout: 240_000 }, async () => {
  const site = mkdtempSync(join(tmpdir(), "pso-sn-site-"));
  // the site root is prepared exactly as the engine does it: release primitives, no hand-made files
  stageFei(site, feiDist("1.0.0"));
  writeRuntimeConfig({ site, fei: "fei-shop", auth: { kind: "none" }, orchestratorBasePath: "/api", channelsPath: "/channels", meis: ["mei-customers", "mei-catalog"] });
  const first = publishMei; void first; // (activation of MEIs needs an active shell: the container activates the shell first, below)

  const run = docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080", "-v", `${norm(site)}:/site`, "-v", `${norm(join(pkgRoot, "frontend"))}:/app/node_modules/@pso/frontend:ro`, "-v", `${norm(join(pkgRoot, "deploy"))}:/app/deploy:ro`, "-v", `${norm(fixture)}:/fixture:ro`, "--entrypoint", "sh", IMAGE, "/fixture/boot.sh");
  assert.equal(run.status, 0, run.stderr);
  for (let i = 0; i < 60 && !docker("logs", name).stdout.includes("boot done"); i++) await sleep(500);
  assert.match(docker("logs", name).stdout, /boot done/, docker("logs", name).stderr);
  const port = Number(/:(\d+)\s*$/m.exec(docker("port", name, "8080").stdout)![1]);

  // 1. the REAL adapter: nginx -t, then a graceful reload; a second identical apply changes nothing
  const a1 = docker("exec", name, "node", "/fixture/apply.mjs", "r1", "1.0.0");
  assert.equal(a1.status, 0, a1.stdout + a1.stderr);
  assert.deepEqual(JSON.parse(a1.stdout.trim().split("\n").pop()!), { changed: true, reloaded: true, error: null, restored: false });
  const a2 = docker("exec", name, "node", "/fixture/apply.mjs", "r1", "1.0.0");
  assert.deepEqual(JSON.parse(a2.stdout.trim().split("\n").pop()!), { changed: false, reloaded: false, error: null, restored: false }, "an identical configuration is not rewritten and nginx is not reloaded");
  assert.equal(activeFei(site)!.version, "1.0.0");

  // microfrontends: published from the host with the same primitives, served through the shell's configuration
  publishMei({ site, dist: meiDist("mei-customers", "1.0.0") }); publishMei({ site, dist: meiDist("mei-catalog", "1.0.0") });

  // 2. the shell: entry page, security headers, nested-route refresh, base path redirect
  const index = await get(port, "/shop/");
  assert.equal(index.status, 200); assert.match(index.body, /shell 1\.0\.0/); assert.equal(index.headers["x-pso-release"], "r1");
  assert.equal(index.headers["cache-control"], "no-cache"); assert.equal(index.headers["x-content-type-options"], "nosniff");
  assert.match(index.headers["content-security-policy"]!, /script-src 'self'/); assert.match(index.headers["content-security-policy"]!, /connect-src 'self'/); assert.equal(index.headers["x-frame-options"], "DENY");
  assert.ok(!("server" in index.headers) || !/\d/.test(index.headers["server"]!), "the nginx version is not disclosed");
  for (const p of ["/shop/customers/42", "/shop/orders/new", "/shop/a/b/c/d"]) { const r = await get(port, p); assert.equal(r.status, 200, p); assert.match(r.body, /shell 1\.0\.0/, p); }
  const redirect = await get(port, "/shop"); assert.equal(redirect.status, 301); assert.equal(redirect.headers["location"]?.replace(/^https?:\/\/[^/]+/, ""), "/shop/");

  // 3. files are files: assets, a root file, and the absence of both is a 404, never the entry page
  const asset = await get(port, "/shop/assets/main-1.0.0.js", { "accept-encoding": "gzip" });
  assert.equal(asset.status, 200); assert.match(asset.headers["content-type"]!, /javascript/); assert.match(asset.headers["cache-control"]!, /immutable/); assert.equal(asset.headers["content-encoding"], "gzip", "compression is on for text assets");
  assert.equal((await get(port, "/shop/favicon.svg")).status, 200);
  for (const p of ["/shop/assets/nope.js", "/shop/nope.js", "/shop/nope.css", "/shop/nope.map", "/shop/robots.txt", "/shop/deep/missing.js"]) { const r = await get(port, p); assert.equal(r.status, 404, `${p} must be 404`); assert.doesNotMatch(r.body, /shell 1\.0\.0/, `${p} must not return the entry page`); }

  // 3b. dotted identifiers are routes, not files: undeclared dotted segments fall to the client router; declared routes win even when the
  // identifier looks like a file name; real file extensions and the API/asset prefixes keep their strict errors
  for (const p of ["/shop/customers/acme.corp", "/shop/orders/ORD-1.2.3", "/shop/catalog/v1.2", "/shop/catalog/sku/acme.json", "/shop/catalog/sku/report.pdf", "/shop/files/a/b.csv"]) {
    const r = await get(port, p); assert.equal(r.status, 200, `${p} is an application route`); assert.match(r.body, /shell 1\.0\.0/, p);
  }
  for (const p of ["/shop/customers/acme.json", "/shop/catalog/other/report.pdf", "/shop/catalog/sku/a/b.json", "/shop/assets/acme.corp", "/_mei/mei-customers/v/9.9.9/x.corp"]) {
    const r = await get(port, p); assert.equal(r.status, 404, `${p} is a missing file or asset`); assert.doesNotMatch(r.body, /shell 1\.0\.0/, p);
  }

  // 4. the runtime configuration is served under the base path and never cached
  const cfg = await get(port, "/shop/pso-runtime-config.json");
  assert.equal(cfg.status, 200); assert.equal(cfg.headers["cache-control"], "no-store"); assert.equal(JSON.parse(cfg.body).fei, "fei-shop");

  // 5. remotes: pointer no-store, versioned files immutable, a missing file is a 404, the site's internals are unreachable
  const ptr = await get(port, "/_mei/mei-customers/active.json");
  assert.equal(ptr.status, 200); assert.equal(ptr.headers["cache-control"], "no-store"); assert.equal(JSON.parse(ptr.body).version, "1.0.0");
  const entry = await get(port, "/_mei/mei-customers/v/1.0.0/remoteEntry.js", { "accept-encoding": "gzip" });
  assert.equal(entry.status, 200); assert.match(entry.headers["cache-control"]!, /immutable/); assert.equal(entry.headers["content-encoding"], "gzip");
  assert.equal((await get(port, "/_mei/mei-customers/v/9.9.9/remoteEntry.js")).status, 404);
  assert.equal((await get(port, "/_mei/mei-customers/history.json")).headers["cache-control"], "no-store");
  for (const p of ["/_mei/%2e%2e/.pso-lock/owner.json", "/_mei/..%2f..%2fetc%2fpasswd", "/.pso-lock/owner.json", "/fei/1.0.0/pso-fei.json", "/shop/../fei/current.json", "/shop/%2e%2e/.pso-lock/owner.json", "/etc/passwd"]) {
    const r = await get(port, p); assert.ok(r.status === 404 || r.status === 400 || r.status === 403, `${p} answered ${r.status}`); assert.doesNotMatch(r.body, /root:|"pid"|pso-fei-release/, p);
  }

  // 6. the orchestrator is reached under /api only, with the prefix stripped; an unknown API path is the orchestrator's answer, not the entry page
  const api = await get(port, "/api/customers?x=1", { "x-forwarded-for": "9.9.9.9" });
  const echo = JSON.parse(api.body); assert.equal(api.headers["x-upstream"], "orchestrator"); assert.equal(echo.url, "/customers?x=1"); assert.equal(echo.host, "shop.test"); assert.equal(echo.proto, "http"); assert.match(echo.xff, /9\.9\.9\.9/);
  assert.equal(JSON.parse((await get(port, "/api/does/not/exist")).body).url, "/does/not/exist");
  const ws = await upgrade(port, "/channels"); assert.equal(ws.status, 101); assert.equal(ws.headers["x-upstream-saw-upgrade"], "websocket", "WebSocket upgrades reach the orchestrator");

  // 7. a compatible MEI update: one atomic pointer write, no nginx change, old versioned files still served, the shell and the other MEI untouched
  const workers = () => docker("exec", name, "sh", "-c", "ps -o pid,args | grep 'nginx: worker' | grep -v grep | awk '{print $1}' | sort | tr '\\n' ' '").stdout.trim();
  const before = workers(); assert.ok(before.length > 0);
  const catalogBefore = (await get(port, "/_mei/mei-catalog/active.json")).body;
  publishMei({ site, dist: meiDist("mei-customers", "1.1.0") });
  assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, "1.1.0");
  assert.equal((await get(port, "/_mei/mei-customers/v/1.0.0/remoteEntry.js")).status, 200, "the previous release's files are still served");
  assert.equal((await get(port, "/_mei/mei-customers/v/1.1.0/remoteEntry.js")).status, 200);
  assert.equal((await get(port, "/_mei/mei-catalog/active.json")).body, catalogBefore, "the other microfrontend is untouched");
  assert.equal(workers(), before, "a MEI update does not reload nginx: the worker processes are the same");

  // 8. a shell update: a new nginx file (new release header) is validated and reloaded; the previous shell's hashed assets still resolve (open tabs)
  stageFei(site, feiDist("1.1.0"));
  const a3 = docker("exec", name, "node", "/fixture/apply.mjs", "r2", "1.1.0");
  assert.deepEqual(JSON.parse(a3.stdout.trim().split("\n").pop()!), { changed: true, reloaded: true, error: null, restored: false }, a3.stdout + a3.stderr);
  let newIndex = await get(port, "/shop/customers/7");
  for (let i = 0; i < 40 && newIndex.headers["x-pso-release"] !== "r2"; i++) { await sleep(150); newIndex = await get(port, "/shop/customers/7"); } // the reload starts new workers asynchronously assert.match(newIndex.body, /shell 1\.1\.0/); assert.equal(newIndex.headers["x-pso-release"], "r2");
  assert.equal((await get(port, "/shop/assets/main-1.1.0.js")).status, 200);
  assert.equal((await get(port, "/shop/assets/main-1.0.0.js")).status, 200, "a tab still running the previous shell keeps resolving its chunks");
  assert.equal((await get(port, "/shop/assets/main-9.9.9.js")).status, 404);
  assert.equal(activePointer(site, "mei-customers")!.version, "1.1.0", "the shell update did not touch the microfrontends");
  assert.deepEqual(readdirSync(join(site, "fei", "assets")).sort(), ["main-1.0.0.js", "main-1.1.0.js"]);

  // 9. nginx is still healthy and the configuration on disk is the validated one
  assert.equal(docker("exec", name, "nginx", "-t").status, 0);
});

test("real nginx: a configuration nginx rejects is not activated; the previous configuration stays and nginx keeps serving", { skip: available ? false : "Docker or the pso-e2e-target:1 image is not available", timeout: 120_000 }, async () => {
  const n2 = `${name}-bad`;
  try {
    const site = mkdtempSync(join(tmpdir(), "pso-sn-site2-"));
    stageFei(site, feiDist("1.0.0"));
    const run = docker("run", "-d", "--name", n2, "-p", "127.0.0.1::8080", "-v", `${norm(site)}:/site`, "-v", `${norm(join(pkgRoot, "frontend"))}:/app/node_modules/@pso/frontend:ro`, "-v", `${norm(join(pkgRoot, "deploy"))}:/app/deploy:ro`, "-v", `${norm(fixture)}:/fixture:ro`, "--entrypoint", "sh", IMAGE, "/fixture/boot.sh");
    assert.equal(run.status, 0, run.stderr);
    for (let i = 0; i < 60 && !docker("logs", n2).stdout.includes("boot done"); i++) await sleep(500);
    const port = Number(/:(\d+)\s*$/m.exec(docker("port", n2, "8080").stdout)![1]);
    assert.equal(docker("exec", n2, "node", "/fixture/apply.mjs", "r1", "1.0.0").status, 0);
    assert.equal((await get(port, "/shop/")).headers["x-pso-release"], "r1");
    // a configuration that is syntactically valid for the renderer but that this nginx rejects (an upstream port the file cannot bind: duplicate listen)
    const bad = docker("exec", n2, "sh", "-c", "printf '# Managed by PSO Web (app=other)\\nserver { listen 8080; listen 8080; server_name x; bogus_directive on; }\\n' > /etc/nginx/pso.d/pso-other.conf; nginx -t 2>&1; echo exit=$?");
    assert.match(bad.stdout, /exit=1/, "nginx really rejects the bad file (precondition)");
    docker("exec", n2, "rm", "-f", "/etc/nginx/pso.d/pso-other.conf");
    // the adapter's transaction: with a foreign file that breaks `nginx -t` present, applying our file is refused and nginx keeps the last valid configuration
    docker("exec", n2, "sh", "-c", "printf 'bogus_directive on;\\n' > /etc/nginx/pso.d/zz-broken.conf");
    const apply = docker("exec", n2, "node", "/fixture/apply.mjs", "r2", "1.0.0");
    assert.notEqual(apply.status, 0, "applying while nginx -t fails must fail");
    assert.match(apply.stdout, /"restored":true|"error":"/);
    assert.equal((await get(port, "/shop/")).headers["x-pso-release"], "r1", "nginx kept serving the last valid configuration");
    docker("exec", n2, "rm", "-f", "/etc/nginx/pso.d/zz-broken.conf");
  } finally { docker("rm", "-f", n2); }
});
