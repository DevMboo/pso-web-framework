import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFeiManifest, buildRemoteManifest } from "@pso/frontend/node";
import type { FeiDefinition, MeiDefinition } from "@pso/frontend";

/**
 * The deployment ENGINE against a real nginx, inside the disposable Linux image: plan, approval, lock, worker, nginx -t and graceful reload for
 * the shell, activation of microfrontends WITHOUT touching nginx, verification through nginx, independent rollback, and a candidate that must
 * not disturb what users have. Skipped when Docker or the image is absent (`PSO_E2E_DOCKER=0` also skips it).
 */
const IMAGE = "pso-e2e-target:1";
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 300_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const available = process.env["PSO_E2E_DOCKER"] !== "0" && docker("image", "inspect", IMAGE).status === 0;
if (process.platform === "win32") process.env["PATH"] = `C:/Windows/System32;${process.env["PATH"] ?? ""}`;

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const fixture = resolve(import.meta.dirname, "fixtures", "static-site");
const norm = (p: string): string => p.replaceAll("\\", "/");
const feiDef: FeiDefinition = { name: "fei-shop", orchestrator: { service: "gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }, { name: "mei-catalog", path: "/catalog" }] };
const meiDef = (name: string): MeiDefinition => ({ name, host: "fei-shop", orchestrator: { service: "gateway" } });
const SHARED = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" };
function project(shared: Record<string, string> = SHARED): string {
  const dir = mkdtempSync(join(tmpdir(), "pso-se-proj-"));
  for (const [n, v] of Object.entries(shared)) { mkdirSync(join(dir, "node_modules", n), { recursive: true }); writeFileSync(join(dir, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v })); }
  return dir;
}
const big = (t: string): string => `/* ${t} */\n` + `console.log("${t}");\n`.repeat(200);
function feiArtifact(version: string): string {
  const dir = project(); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), `<!doctype html><html><body><div id="root"></div>shell ${version}</body></html>`); writeFileSync(join(dir, "dist", "assets", `main-${version}.js`), big(`shell ${version}`));
  buildFeiManifest({ dir, definition: feiDef, version, basePath: "/shop/" }); return join(dir, "dist");
}
function meiArtifact(name: string, version: string, shared?: Record<string, string>): string {
  const dir = project(shared); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "remoteEntry.js"), big(`${name} ${version}`)); writeFileSync(join(dir, "dist", "assets", "module.js"), `export default "${name}@${version}"`);
  buildRemoteManifest({ dir, definition: meiDef(name), routes: [], version }); return join(dir, "dist");
}
function tgz(dist: string, runDir: string, file: string): void {
  const r = spawnSync("tar", ["-czf", file, "-C", dist, "."], { cwd: runDir, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr);
}
function get(port: number, path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((res, rej) => { const r = request({ host: "127.0.0.1", port, path, agent: false, headers: { host: "shop.test", connection: "close" }, timeout: 10_000 }, (x) => { const c: Buffer[] = []; x.on("data", (b: Buffer) => c.push(b)); x.on("end", () => res({ status: x.statusCode ?? 0, headers: Object.fromEntries(Object.entries(x.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(c).toString() })); }); r.on("error", rej); r.end(); });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const name = `pso-static-eng-${process.pid}`;
after(() => { docker("rm", "-f", name); });

test("the engine with a real nginx: shell deploy, MEI deploys without any nginx change, update, independent rollback, failed candidates, and verification through nginx", { skip: available ? false : "Docker or the pso-e2e-target:1 image is not available", timeout: 280_000 }, async () => {
  const run = mkdtempSync(join(tmpdir(), "pso-se-run-"));
  tgz(feiArtifact("1.0.0"), run, "fei-1.0.0.tgz"); tgz(feiArtifact("1.1.0"), run, "fei-1.1.0.tgz");
  tgz(meiArtifact("mei-customers", "1.0.0"), run, "cus-1.0.0.tgz"); tgz(meiArtifact("mei-customers", "1.1.0"), run, "cus-1.1.0.tgz");
  tgz(meiArtifact("mei-catalog", "1.0.0"), run, "cat-1.0.0.tgz");
  tgz(meiArtifact("mei-customers", "2.0.0", { ...SHARED, react: "19.0.0", "react-dom": "19.0.0" }), run, "cus-bad.tgz");
  const feiStatic = { site: "shop", kind: "fei", basePath: "/shop/", api: { upstreamPort: 3999 }, probe: { port: 8080 } };
  const meiStatic = { site: "shop", kind: "mei", probe: { port: 8080 } };
  const phase = (steps: unknown[]) => writeFileSync(join(run, "steps.json"), JSON.stringify(steps));

  const c = docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080", "-v", `${norm(run)}:/fixture-run`, "-v", `${norm(join(pkgRoot, "frontend"))}:/app/node_modules/@pso/frontend:ro`, "-v", `${norm(join(pkgRoot, "deploy"))}:/app/deploy:ro`, "-v", `${norm(fixture)}:/fixture:ro`, "--entrypoint", "sh", IMAGE, "/fixture/boot.sh");
  assert.equal(c.status, 0, c.stderr);
  for (let i = 0; i < 60 && !docker("logs", name).stdout.includes("boot done"); i++) await sleep(500);
  const port = Number(/:(\d+)\s*$/m.exec(docker("port", name, "8080").stdout)![1]);
  const exec = (): Array<{ step: string; state: string; error: string | null; release?: string }> => {
    const r = docker("exec", name, "node", "/fixture/engine-e2e.mjs"); const line = r.stdout.split("\n").find((l) => l.startsWith("RESULTS "));
    assert.ok(line, `no RESULTS line:\n${r.stdout}\n${r.stderr}`); return JSON.parse(line.slice(8));
  };
  const workers = () => docker("exec", name, "sh", "-c", "ps -o pid,args | grep 'nginx: worker' | grep -v grep | awk '{print $1}' | sort | tr '\\n' ' '").stdout.trim();
  const byStep = (rs: ReturnType<typeof exec>) => Object.fromEntries(rs.map((r) => [r.step, r]));

  // phase 1: the shell. The engine writes the nginx file, runs nginx -t, reloads gracefully, activates, and verifies THROUGH nginx
  phase([{ type: "deploy", id: "fei1", app: "shop-fei", kind: "fei", artifact: "fei-1.0.0.tgz", static: feiStatic }]);
  const p1 = byStep(exec());
  assert.equal(p1["fei1"]!.state, "COMPLETED", JSON.stringify(p1));
  const idx = await get(port, "/shop/customers/1");
  assert.equal(idx.status, 200); assert.match(idx.body, /shell 1\.0\.0/); assert.equal(idx.headers["x-pso-release"], p1["fei1"]!.release);
  assert.equal((await get(port, "/shop/assets/missing.js")).status, 404);

  // phase 2: microfrontends. No nginx change at all: the worker processes are the same before and after
  const before = workers();
  phase([
    { type: "deploy", id: "cus1", app: "shop-customers", kind: "mei", artifact: "cus-1.0.0.tgz", static: meiStatic },
    { type: "deploy", id: "cat1", app: "shop-catalog", kind: "mei", artifact: "cat-1.0.0.tgz", static: meiStatic },
    { type: "deploy", id: "cus2", app: "shop-customers", kind: "mei", artifact: "cus-1.1.0.tgz", static: meiStatic },
  ]);
  const p2 = byStep(exec());
  for (const k of ["cus1", "cat1", "cus2"]) assert.equal(p2[k]!.state, "COMPLETED", `${k}: ${JSON.stringify(p2[k])}`);
  assert.equal(workers(), before, "deploying and updating microfrontends did not reload nginx");
  assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, "1.1.0");
  assert.equal(JSON.parse((await get(port, "/_mei/mei-catalog/active.json")).body).version, "1.0.0");
  assert.equal((await get(port, "/_mei/mei-customers/v/1.0.0/remoteEntry.js")).status, 200, "the previous version's files are kept");

  // phase 3: independent rollback, then candidates that must not disturb anything
  phase([
    { type: "rollback", id: "rb", app: "shop-customers" },
    { type: "deploy", id: "bad", app: "shop-customers", kind: "mei", artifact: "cus-bad.tgz", static: meiStatic },
  ]);
  const p3 = byStep(exec());
  assert.equal(p3["rb"]!.state, "COMPLETED", JSON.stringify(p3["rb"]));
  assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, "1.0.0", "customers is back on 1.0.0");
  assert.equal(JSON.parse((await get(port, "/_mei/mei-catalog/active.json")).body).version, "1.0.0", "catalog untouched");
  assert.equal(p3["bad"]!.state, "FAILED"); assert.match(p3["bad"]!.error ?? "", /not activated|react/);
  assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, "1.0.0", "a failed candidate does not change what users get");
  assert.equal((await get(port, "/shop/")).headers["x-pso-release"], p1["fei1"]!.release, "the shell was never touched");
  assert.equal(workers(), before, "still no nginx reload");

  // phase 4: a shell update (new nginx file validated and reloaded) while the old shell's chunks still resolve
  phase([{ type: "deploy", id: "fei2", app: "shop-fei", kind: "fei", artifact: "fei-1.1.0.tgz", static: feiStatic }]);
  const p4 = byStep(exec());
  assert.equal(p4["fei2"]!.state, "COMPLETED", JSON.stringify(p4));
  assert.match((await get(port, "/shop/")).body, /shell 1\.1\.0/);
  assert.equal((await get(port, "/shop/assets/main-1.0.0.js")).status, 200, "open tabs on the previous shell keep their chunks");
  assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, "1.0.0", "the shell update did not touch microfrontends");
  phase([{ type: "rollback", id: "rbfei", app: "shop-fei" }]);
  const p5 = byStep(exec());
  assert.equal(p5["rbfei"]!.state, "COMPLETED", JSON.stringify(p5));
  let back = await get(port, "/shop/"); for (let i = 0; i < 40 && !/shell 1\.0\.0/.test(back.body); i++) { await sleep(150); back = await get(port, "/shop/"); }
  assert.match(back.body, /shell 1\.0\.0/, "the shell rolled back independently");
  assert.equal(docker("exec", name, "nginx", "-t").status, 0);
  void cpSync;
});
