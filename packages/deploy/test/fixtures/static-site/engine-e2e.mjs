// Runs INSIDE the Linux container with a real nginx: the real engine (plan, approval, lock, worker, verification through nginx, rollback)
// deploys static frontend resources described by /fixture-run/steps.json. Prints one RESULTS line.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { checkMei, activePointer, history } from "/app/node_modules/@pso/frontend/dist/release.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { AgentState, AuditLog, P } from "/app/deploy/dist/agent/state.js";
import { Auth } from "/app/deploy/dist/agent/auth.js";
import { Engine } from "/app/deploy/dist/agent/engine.js";

process.env.PSO_AGENT_HOME = "/tmp/agent-home";
const home = "/tmp/agent-home";
const state = new AgentState(home);
Auth.provision(state, "development", { emitToken: false, environment: "testing" });
const engine = new Engine(state, new AuditLog(home));
const actor = { clientId: "c1", name: "alice", role: "superadmin" };
const steps = JSON.parse(readFileSync("/fixture-run/steps.json", "utf8"));

const decl = (s) => ({
  name: s.app, environment: "testing", connection: { provider: "ssh", credentials: "x" }, source: { provider: "artifact", path: "x" },
  services: [{ name: s.app.replace(/^shop-/, ""), runtime: "static", static: s.static }],
  strategy: { type: "static", proxy: s.kind === "fei" ? "nginx" : "none" },
  ...(s.kind === "fei" ? { proxy: { nginx: s.attachTo ? { attachTo: s.attachTo } : { listen: { http: 8080 } } } } : {}),
});
const results = [];
for (const s of steps) {
  try {
    if (s.type === "deploy") {
      const uploadId = `u${Math.random().toString(36).slice(2, 9)}`; mkdirSync(join(P.incoming(home), uploadId), { recursive: true });
      const file = join(P.incoming(home), uploadId, "artifact.tgz"); copyFileSync(`/fixture-run/${s.artifact}`, file);
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      const plan = engine.propose(decl(s), undefined, actor, { uploadId, sha256, size: statSync(file).size });
      if (plan.blockers.length) { results.push({ step: s.id, state: "BLOCKED", error: plan.blockers.join("; ") }); continue; }
      engine.approve(s.app, plan.hash, actor);
      const dep = engine.start(s.app, plan.hash, actor, () => ({ pid: process.pid }));
      await engine.work(s.app, dep.id);
      const d = engine.deployment(s.app, dep.id);
      results.push({ step: s.id, state: d.state, error: d.error ?? null, release: d.releaseId, availability: d.availability ?? null });
    } else if (s.type === "kill") {
      // a REAL detached worker process (the agent's own `worker` command) is SIGKILLed `delayMs` after it reports SWITCHING_TRAFFIC, then
      // the engine's recovery runs. Nothing is simulated: the files are whatever a killed process leaves.
      const uploadId = `u${Math.random().toString(36).slice(2, 9)}`; mkdirSync(join(P.incoming(home), uploadId), { recursive: true });
      const file = join(P.incoming(home), uploadId, "artifact.tgz"); copyFileSync(`/fixture-run/${s.artifact}`, file);
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      const plan = engine.propose(decl(s), undefined, actor, { uploadId, sha256, size: statSync(file).size });
      engine.approve(s.app, plan.hash, actor);
      const dep = engine.start(s.app, plan.hash, actor, (app, id) => {
        const c = spawn(process.execPath, ["/app/deploy/dist/agent/main.js", "worker", app, id], { detached: true, stdio: "ignore", env: { ...process.env, PSO_AGENT_HOME: home } });
        c.unref(); return { pid: c.pid };
      });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const wanted = s.killState ?? "SWITCHING_TRAFFIC";
      let at = null; const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const cur = engine.deployment(s.app, dep.id);
        if (cur.state === wanted || ["COMPLETED", "FAILED", "CANCELLED", "ROLLED_BACK"].includes(cur.state)) { at = cur.state; break; }
        await sleep(2);
      }
      if (s.delayMs) await sleep(s.delayMs);
      const stateBefore = engine.deployment(s.app, dep.id).state;
      const wasRunning = !["COMPLETED", "FAILED", "CANCELLED", "ROLLED_BACK"].includes(stateBefore);
      const pid = engine.deployment(s.app, dep.id).workerPid;
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      await sleep(300);
      const killedIn = engine.deployment(s.app, dep.id).state;
      const lockBefore = engine.lock(s.app).status();
      const rec = await engine.recover(s.app, actor);
      const d = engine.deployment(s.app, dep.id);
      const site = P.site(s.static.site, home);
      const leftovers = []; const walk = (dir, depth) => { if (depth > 5) return; try { for (const e of readdirSync(dir, { withFileTypes: true })) { if (/^\.(staging|tmp)-/.test(e.name)) leftovers.push(join(dir, e.name)); if (e.isDirectory() && !e.isSymbolicLink() && e.name !== "assets" && e.name !== "v") walk(join(dir, e.name), depth + 1); } } catch { /* absent */ } }; walk(site, 0);
      results.push({ step: s.id, state: d.state, error: d.error ?? null, release: d.releaseId, outcome: d.outcome ?? null, killedWhileRunning: wasRunning, stateAtKill: stateBefore, stateAfterKill: killedIn, lockAfterKill: lockBefore, lockAfterRecovery: engine.lock(s.app).status(), recovery: rec, leftovers, activeRelease: engine.appState(s.app).active?.release ?? null, diag: s.kind === "mei" ? { problems: checkMei(site, "mei-customers"), pointer: activePointer(site, "mei-customers")?.version ?? null, hist: history(site, "mei-customers").slice(-3) } : null });
    } else {
      const dep = engine.rollback(s.app, actor, undefined, () => ({ pid: process.pid }));
      await engine.work(s.app, dep.id);
      const d = engine.deployment(s.app, dep.id);
      results.push({ step: s.id, state: d.state, error: d.error ?? null, release: d.releaseId });
    }
  } catch (e) { results.push({ step: s.id, state: "ERROR", error: e.message }); }
}
console.log("RESULTS " + JSON.stringify(results));
