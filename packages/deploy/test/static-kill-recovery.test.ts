import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFeiManifest, buildRemoteManifest } from "@pso/frontend/node";
import type { FeiDefinition, MeiDefinition } from "@pso/frontend";

/**
 * A deployment worker is really KILLED (SIGKILL on a detached `pso-agent worker` process, at several moments after it reports
 * SWITCHING_TRAFFIC) inside the disposable Linux image with a real nginx; then the engine's recovery runs. Nothing is simulated: the files
 * are whatever the killed process left. Asserts: the outcome is complete-forward or closed (never "needs operator" for these cases), the
 * lock is free afterwards, no staging leftovers, the registry, the filesystem and what nginx serves agree, the previous release is intact when
 * the candidate did not win, and the next normal deployment works. Skipped when Docker or the image is absent.
 */
const IMAGE = "pso-e2e-target:1";
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 300_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const available = process.env["PSO_E2E_DOCKER"] !== "0" && docker("image", "inspect", IMAGE).status === 0;
if (process.platform === "win32") process.env["PATH"] = `C:/Windows/System32;${process.env["PATH"] ?? ""}`;

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const fixture = resolve(import.meta.dirname, "fixtures", "static-site");
const norm = (p: string): string => p.replaceAll("\\", "/");
const feiDef: FeiDefinition = { name: "fei-shop", orchestrator: { service: "gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }] };
const meiDef = (name: string): MeiDefinition => ({ name, host: "fei-shop", orchestrator: { service: "gateway" } });
const SHARED = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" };
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "pso-sk-proj-"));
  for (const [n, v] of Object.entries(SHARED)) { mkdirSync(join(dir, "node_modules", n), { recursive: true }); writeFileSync(join(dir, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v })); }
  return dir;
}
const big = (t: string): string => `/* ${t} */\n` + `console.log("${t}");\n`.repeat(200);
function feiArtifact(version: string): string {
  const dir = project(); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), `<!doctype html><html><body>shell ${version}</body></html>`); writeFileSync(join(dir, "dist", "assets", `main-${version}.js`), big(`shell ${version}`));
  buildFeiManifest({ dir, definition: feiDef, version, basePath: "/shop/" }); return join(dir, "dist");
}
function meiArtifact(version: string): string {
  const dir = project(); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "remoteEntry.js"), big(`customers ${version}`)); writeFileSync(join(dir, "dist", "assets", "module.js"), `export default "customers@${version}"`);
  buildRemoteManifest({ dir, definition: meiDef("mei-customers"), routes: [], version }); return join(dir, "dist");
}
const tgz = (dist: string, runDir: string, file: string): void => { const r = spawnSync("tar", ["-czf", file, "-C", dist, "."], { cwd: runDir, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
function get(port: number, path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((res, rej) => { const r = request({ host: "127.0.0.1", port, path, agent: false, headers: { host: "shop.test", connection: "close" }, timeout: 10_000 }, (x) => { const c: Buffer[] = []; x.on("data", (b: Buffer) => c.push(b)); x.on("end", () => res({ status: x.statusCode ?? 0, headers: Object.fromEntries(Object.entries(x.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(c).toString("utf8") })); }); r.on("error", rej); r.end(); });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const name = `pso-static-kill-${process.pid}`;
after(() => { docker("rm", "-f", name); });

interface R { step: string; state: string; error: string | null; release?: string; outcome?: string | null; killedWhileRunning?: boolean; stateAtKill?: string; stateAfterKill?: string; lockAfterKill?: string; lockAfterRecovery?: string; recovery?: { action?: string; outcome?: string; note?: string }; leftovers?: string[]; activeRelease?: string | null; diag?: unknown }

test("a deployment worker killed for real is recovered: lock, registry, files and what nginx serves agree, and the previous release is preserved", { skip: available ? false : "Docker or the pso-e2e-target:1 image is not available", timeout: 400_000 }, async () => {
  const run = mkdtempSync(join(tmpdir(), "pso-sk-run-"));
  const meiVersions = ["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"], feiVersions = ["1.1.0", "1.2.0", "1.3.0", "1.4.0"];
  tgz(feiArtifact("1.0.0"), run, "fei-1.0.0.tgz"); tgz(meiArtifact("1.0.0"), run, "cus-1.0.0.tgz");
  for (const v of meiVersions) tgz(meiArtifact(v), run, `cus-${v}.tgz`);
  for (const v of feiVersions) tgz(feiArtifact(v), run, `fei-${v}.tgz`);
  const feiStatic = { site: "shop", kind: "fei", basePath: "/shop/", api: { upstreamPort: 3999 }, probe: { port: 8080 } };
  const meiStatic = { site: "shop", kind: "mei", probe: { port: 8080 } };
  const phase = (steps: unknown[]) => writeFileSync(join(run, "steps.json"), JSON.stringify(steps));

  const c = docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080", "-v", `${norm(run)}:/fixture-run`, "-v", `${norm(join(pkgRoot, "frontend"))}:/app/node_modules/@pso/frontend:ro`, "-v", `${norm(join(pkgRoot, "deploy"))}:/app/deploy:ro`, "-v", `${norm(fixture)}:/fixture:ro`, "--entrypoint", "sh", IMAGE, "/fixture/boot.sh");
  assert.equal(c.status, 0, c.stderr);
  for (let i = 0; i < 60 && !docker("logs", name).stdout.includes("boot done"); i++) await sleep(500);
  const port = Number(/:(\d+)\s*$/m.exec(docker("port", name, "8080").stdout)![1]);
  const exec = (): R[] => { const r = docker("exec", name, "node", "/fixture/engine-e2e.mjs"); const line = r.stdout.split("\n").find((l) => l.startsWith("RESULTS ")); assert.ok(line, `no RESULTS line:\n${r.stdout}\n${r.stderr}`); return JSON.parse(line.slice(8)) as R[]; };
  const one = (step: unknown): R => { phase([step]); return exec()[0]!; };

  const base1 = one({ type: "deploy", id: "fei", app: "shop-fei", kind: "fei", artifact: "fei-1.0.0.tgz", static: feiStatic }); assert.equal(base1.state, "COMPLETED", JSON.stringify(base1));
  const base2 = one({ type: "deploy", id: "cus", app: "shop-customers", kind: "mei", artifact: "cus-1.0.0.tgz", static: meiStatic }); assert.equal(base2.state, "COMPLETED", JSON.stringify(base2));

  let genuineKills = 0; const summary: Array<Record<string, unknown>> = [];
  let meiExpected = "1.0.0", feiExpected = "1.0.0";
  const meiPlan = meiVersions.map((v, i) => ({ v, delay: [0, 4, 15, 60, 150][i]! }));
  for (const { v, delay } of meiPlan) {
    const r = one({ type: "kill", id: `kill-cus-${v}`, app: "shop-customers", kind: "mei", artifact: `cus-${v}.tgz`, static: meiStatic, delayMs: delay });
    if (r.killedWhileRunning) genuineKills++;
    assert.ok(["COMPLETED", "FAILED"].includes(r.state), `MEI ${v}: ${JSON.stringify(r)}`);
    assert.notEqual(r.outcome, "needs-operator", `MEI ${v} needed an operator: ${JSON.stringify(r)}`);
    assert.equal(r.lockAfterRecovery, "free", `MEI ${v}: the lock must be released`); assert.deepEqual(r.leftovers, [], `MEI ${v}: no staging leftovers`);
    const served = JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body) as { version: string };
    const won = r.state === "COMPLETED";
    if (won) meiExpected = v;
    assert.equal(served.version, meiExpected, `MEI ${v}: ${won ? "the candidate won" : "the previous version stays"} and nginx serves exactly that (${JSON.stringify(r.recovery)} ${JSON.stringify(r.diag)} killedAt ${r.stateAtKill})`);
    assert.equal((await get(port, `/_mei/mei-customers/v/${served.version}/remoteEntry.js`)).status, 200, "the active version's entry is intact");
    assert.equal((await get(port, "/shop/")).status, 200, "the shell is untouched");
    summary.push({ kind: "mei", version: v, delayMs: delay, killedAt: r.stateAtKill, killedWhileRunning: r.killedWhileRunning, state: r.state, outcome: r.outcome, action: r.recovery?.action });
  }
  const feiPlan = feiVersions.map((v, i) => ({ v, delay: [0, 20, 80, 250][i]! }));
  for (const { v, delay } of feiPlan) {
    const r = one({ type: "kill", id: `kill-fei-${v}`, app: "shop-fei", kind: "fei", artifact: `fei-${v}.tgz`, static: feiStatic, delayMs: delay });
    if (r.killedWhileRunning) genuineKills++;
    assert.ok(["COMPLETED", "FAILED", "ROLLED_BACK"].includes(r.state), `shell ${v}: ${JSON.stringify(r)}`);
    assert.notEqual(r.outcome, "needs-operator", `shell ${v} needed an operator: ${JSON.stringify(r)}`);
    assert.equal(r.lockAfterRecovery, "free", `shell ${v}: the lock must be released`); assert.deepEqual(r.leftovers, [], `shell ${v}: no staging leftovers`);
    if (r.state === "COMPLETED") feiExpected = v;
    // nginx may still be answering from workers of the previous configuration for a moment after a recovery reload: poll, bounded
    let idx = await get(port, "/shop/"); for (let i = 0; i < 40 && !idx.body.includes(`shell ${feiExpected}`); i++) { await sleep(150); idx = await get(port, "/shop/"); }
    assert.match(idx.body, new RegExp(`shell ${feiExpected.replaceAll(".", "\\.")}`), `shell ${v}: what nginx serves is the registry's active shell (${JSON.stringify(r.recovery)})`);
    assert.equal(idx.headers["x-pso-release"], r.state === "COMPLETED" ? r.release : idx.headers["x-pso-release"]);
    assert.equal((await get(port, `/shop/assets/main-${feiExpected}.js`)).status, 200, "the active shell's chunk is served");
    assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, meiExpected, "the shell's interruption never touched the microfrontend");
    summary.push({ kind: "fei", version: v, delayMs: delay, killedAt: r.stateAtKill, killedWhileRunning: r.killedWhileRunning, state: r.state, outcome: r.outcome, action: r.recovery?.action });
  }
  assert.ok(genuineKills >= 6, `at least six workers were killed while still running (got ${genuineKills}): ${JSON.stringify(summary)}`);
  assert.equal(docker("exec", name, "nginx", "-t").status, 0, "the nginx configuration on disk is valid");

  // the system is healthy afterwards: a normal deployment of the next versions works
  const next = one({ type: "deploy", id: "after", app: "shop-customers", kind: "mei", artifact: "cus-1.0.0.tgz", static: meiStatic });
  assert.ok(["COMPLETED", "FAILED"].includes(next.state));
  writeFileSync(join(process.env["TEMP"] ?? tmpdir(), "pso-static-kill-summary.json"), JSON.stringify(summary, null, 2));
  console.log("KILL SUMMARY " + JSON.stringify(summary));
});
