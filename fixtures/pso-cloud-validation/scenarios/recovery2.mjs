import { WORKSPACE, FRAMEWORK, HOST, SSH_KEY, SSH_USER } from "./config.mjs";
// B: active service process killed.  C: deployment worker killed mid-flight (stale lock, INTERRUPTED, recover).  D: nginx validation failure.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { call } from "./ecv.mjs";
const PSO = `${FRAMEWORK}/packages/cli/bin/pso.js`; const CWD = `${WORKSPACE}`;
const pso = (...a) => spawnSync(process.execPath, [PSO, ...a], { cwd: CWD, encoding: "utf8" });
const ssh = (cmd) => spawnSync("ssh", ["-i", `${SSH_KEY}`, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${join(homedir(), ".pso-cloud", "known_hosts")}`, `${SSH_USER}@${HOST}`, cmd], { encoding: "utf8" });
const status = (app = "shop-gateway") => { try { return JSON.parse(pso("release:status", app, "--json").stdout); } catch { return {}; } };
const health = async () => { try { return (await call("GET", "/health/ready")).status; } catch { return 0; } };
const out = {}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidOf = () => ssh("systemctl --user show -p MainPID --value $(systemctl --user list-units --plain --no-legend \"pso-shop-gateway-*\" | awk \"/active running/ {print \\$1}\" | head -1)").stdout.trim();

// ---- B
{ const pid = pidOf(); const t0 = Date.now(); ssh(`kill -9 ${pid}`); let down = 0, recovered; for (let i = 0; i < 60; i++) { const h = await health(); if (h !== 200) down++; if (h === 200 && i > 0 && Date.now() - t0 > 500) { recovered = Date.now() - t0; break; } await sleep(300); }
  out.activeProcessKilled = { killedPid: Number(pid), newPid: Number(pidOf()), healthyAgainAfterMs: recovered ?? null, failedProbesInBetween: down }; console.log("B", JSON.stringify(out.activeProcessKilled)); }

// ---- C
{ writeFileSync(`${WORKSPACE}/artifacts/gateway-stage/RELEASE`, "gateway release 5\n"); const before = status().active?.release;
  const c = spawn(process.execPath, [PSO, "release:deploy", "shop-gateway", "--approve", "--yes", "--no-follow"], { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] }); let seen = ""; c.stdout.on("data", (d) => (seen += d)); c.stderr.on("data", (d) => (seen += d)); await new Promise((r) => c.on("close", r));
  const m = /deployment (d\w+) started/.exec(seen); const s1 = status(); const wp = s1.deployment?.workerPid; await sleep(4000);
  const k = ssh(`kill -9 ${wp}`); await sleep(2500); const s2 = status(); const stale = { state: s2.deployment?.state, effective: s2.deployment?.effectiveState, lock: s2.lock };
  const rec = pso("release:recover", "shop-gateway", "--yes"); await sleep(1500); const s3 = status();
  out.workerKilled = { deployment: m?.[1], workerPid: wp, killExit: k.status, afterKill: stale, recover: rec.stdout.split("\n").slice(0, 3).join(" | ").slice(0, 300), afterRecover: { active: s3.active?.release, activeBefore: before, activeChanged: s3.active?.release !== before, lock: s3.lock, state: s3.deployment?.effectiveState ?? s3.deployment?.state }, healthAfter: await health() }; console.log("C", JSON.stringify(out.workerKilled)); }

// ---- D (a TLS certificate path that does not exist: nginx -t must refuse, the previous configuration must stay in force)
{ const f = `${WORKSPACE}/deploy/shop-gateway.deployment.pso.ts`; const orig = readFileSync(f, "utf8"); const activeBefore = status().active?.release;
  writeFileSync(f, orig.replace('"/etc/ssl/pso/server.pem"', '"/etc/ssl/pso/missing.pem"'));
  const r = pso("release:deploy", "shop-gateway", "--approve", "--yes"); writeFileSync(f, orig);
  const s = status(); const err = (r.stdout + r.stderr).split("\n").find((l) => /error:/.test(l)) ?? "";
  out.nginxRejected = { exit: r.status, error: err.slice(0, 260), activeBefore, activeAfter: s.active?.release, healthyAfter: await health(), nginxConfStillValid: ssh("sudo nginx -t 2>&1 | tail -1").stdout.trim(), proxyFileUnchanged: ssh("grep -c missing.pem /etc/nginx/pso.d/pso-shop-gateway.conf").stdout.trim() === "0" }; console.log("D", JSON.stringify(out.nginxRejected)); }
mkdirSync(`${FRAMEWORK}/docs/implementation/evidence/ecv`, { recursive: true }); writeFileSync(`${FRAMEWORK}/docs/implementation/evidence/ecv/recovery-scenarios.json`, JSON.stringify(out, null, 2));
