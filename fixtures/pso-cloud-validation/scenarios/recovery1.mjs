import { WORKSPACE, FRAMEWORK } from "./config.mjs";
// A: the local PSO process (and so its SSH connection) is killed mid-deployment; the server-side worker must finish alone.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { call, tokenFor } from "./ecv.mjs";
const PSO = `${FRAMEWORK}/packages/cli/bin/pso.js`; const CWD = `${WORKSPACE}`;
const pso = (...a) => spawnSync(process.execPath, [PSO, ...a], { cwd: CWD, encoding: "utf8" });
const status = () => { const r = pso("release:status", "shop-gateway", "--json"); try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || r.stdout }; } };
const token = tokenFor("customers:read orders:read catalog:read"); const out = { scenario: "client killed during deployment" };
const s0 = status(); out.activeBefore = s0.active?.release;
spawnSync("node", ["-e", `require('fs').writeFileSync('${WORKSPACE}/artifacts/gateway-stage/RELEASE','gateway release 4\\n')`]);
const t0 = Date.now(); const child = spawn(process.execPath, [PSO, "release:deploy", "shop-gateway", "--approve", "--yes"], { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] });
let seen = ""; const started = new Promise((res) => { const on = (d) => { seen += d; if (/started on the server/.test(seen)) res(); }; child.stdout.on("data", on); child.stderr.on("data", on); setTimeout(res, 120000); });
await started; await new Promise((r) => setTimeout(r, 3000)); const killedAt = Date.now() - t0; child.kill("SIGKILL"); spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
out.serverReportedStartedBeforeKill = /started on the server/.test(seen); out.localProcessKilledAfterMs = killedAt;
// the application must keep answering while the worker finishes
let ok = 0, bad = 0; let final;
for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 2000)); try { const r = await call("GET", "/health/ready"); r.status === 200 ? ok++ : bad++; } catch { bad++; } const s = status(); const d = s.latest ?? s.deployment ?? s.history?.[0]; if (s.lock?.status === "free" && s.active?.release && s.active.release !== out.activeBefore) { final = s; break; } }
out.requestsWhileWorkerFinished = { ok, bad }; out.activeAfter = final?.active?.release; out.lock = final?.lock?.status; out.activeChanged = !!final && final.active.release !== out.activeBefore; out.elapsedMs = Date.now() - t0;
console.log(JSON.stringify(out, null, 1));
mkdirSync(`${FRAMEWORK}/docs/implementation/evidence/ecv`, { recursive: true }); writeFileSync(`${FRAMEWORK}/docs/implementation/evidence/ecv/recovery-client-killed.json`, JSON.stringify(out, null, 2));
