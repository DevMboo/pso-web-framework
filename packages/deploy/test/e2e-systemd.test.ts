import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud, LocalStore, MemoryCredentialProvider, type DeploymentDecl } from "../src/index.ts";
import { LinuxTarget, SYSTEMD_IMAGE, dockerAvailable, makeAppRepo } from "./target.ts";

/**
 * systemd runtime driver validated against a REAL systemd (PID 1 of a Debian container, systemd 252) reached over SSH, with the deploy user's
 * own user manager and lingering. The container is a disposable host on this machine: it is NOT an external cloud environment.
 * Image: docker build -t pso-e2e-systemd:1 packages/deploy/test/fixtures/target-systemd
 */
const skip = !dockerAvailable(SYSTEMD_IMAGE) && `Docker image ${SYSTEMD_IMAGE} is not available`;
const T = new LinuxTarget(SYSTEMD_IMAGE);
const work = mkdtempSync(join(tmpdir(), "pso-sd-work-"));
const cloud = new Cloud({ store: new LocalStore(mkdtempSync(join(tmpdir(), "pso-sd-home-"))), creds: new MemoryCredentialProvider() });
const CONN = "sd";
const evidence: Record<string, unknown> = { generatedAt: new Date().toISOString(), environment: "Docker container (Debian 12, systemd 252 as PID 1, user manager + lingering), reached over SSH", notExternalCloud: true };

const get = (port: number, host: string, path = "/"): Promise<{ status: number; body: string; headers: Record<string, any> }> => new Promise((res, rej) => { const r = request({ host: "127.0.0.1", port, path, headers: { host }, agent: false, timeout: 5000 }, (resp) => { let b = ""; resp.on("data", (d) => (b += d)); resp.on("end", () => res({ status: resp.statusCode ?? 0, body: b, headers: resp.headers })); }); r.on("error", rej); r.end(); });
class Load {
  ok = 0; bad = 0; errors: string[] = []; private running = false; private ws: Promise<void>[] = [];
  start(port: number, host: string, n = 2): void { this.running = true; for (let i = 0; i < n; i++) this.ws.push((async () => { while (this.running) { try { const r = await get(port, host); if (r.status === 200) this.ok++; else { this.bad++; this.errors.push(String(r.status)); } } catch (e) { this.bad++; this.errors.push((e as NodeJS.ErrnoException).code ?? "error"); } await new Promise((r) => setTimeout(r, 20)); } })()); }
  async stop(): Promise<void> { this.running = false; await Promise.all(this.ws); }
}
const sysd = (cmd: string): string => T.sh(`export XDG_RUNTIME_DIR=/run/user/$(id -u); ${cmd}`, "pso").out.trim();
const units = (): string[] => sysd("systemctl --user list-units --all --plain --no-legend 'pso-*.service' | awk '{print $1\" \"$3\" \"$4}'").split("\n").filter(Boolean);

const repos = { orch: join(work, "orch-src"), cat: join(work, "cat-src") };
const publish = (which: "orch" | "cat", version: string, flags: Record<string, unknown> = {}): { commit: string; url: string } => {
  const commit = makeAppRepo(repos[which], which === "orch" ? "orchestrator" : "catalog", version, flags);
  return { commit, url: T.putRepo(repos[which], which === "orch" ? "sd-orchestrator" : "sd-catalog") };
};
const base = { environment: "testing", connection: { provider: "ssh" as const, credentials: CONN }, runtime: { supervisor: "systemd" as const, restart: "on-failure" as const }, strategy: { type: "blue-green" as const, proxy: "nginx" as const, rollback: true, drainSeconds: 2, retention: { keep: 4 } } };
const catalogDecl = (url: string): DeploymentDecl => ({ ...base, name: "sd-catalog", source: { provider: "git", url, branch: "main" }, service: { name: "catalog", runtime: "java", build: [["javac", "-d", "out", "Main.java"]], start: ["java", "-cp", "out", "Main"], health: { readyPath: "/health/ready", timeoutSeconds: 60 }, shutdownGraceSeconds: 10, internalPort: 21001, resources: { memoryMb: 64 }, requires: { java: ">=17" } }, proxy: { nginx: { listen: { http: 8080 } } } });
const orchDecl = (url: string): DeploymentDecl => ({ ...base, name: "sd-orchestrator", source: { provider: "git", url, branch: "main" }, service: { name: "web", runtime: "node", start: ["node", "server.js"], health: { readyPath: "/health/ready", timeoutSeconds: 30 }, shutdownGraceSeconds: 10, route: { path: "/" }, env: { CATALOG_URL: "http://127.0.0.1:21001" }, secrets: { DB_PASSWORD: "sd-db-password" }, resources: { memoryMb: 64 }, requires: { node: ">=22" } }, proxy: { nginx: { domains: ["sd.test"], listen: { http: 8080 } } } });
const clean = (d: any): DeploymentDecl => JSON.parse(JSON.stringify(d));
async function deploy(decl: DeploymentDecl, expect: "COMPLETED" | "FAILED" = "COMPLETED") {
  const plan = await cloud.plan(CONN, clean(decl), undefined, work);
  if (expect === "COMPLETED") assert.deepEqual(plan.blockers, [], `plan blockers: ${plan.blockers.join(" | ")}`);
  const d = await cloud.start(CONN, plan.app, plan.hash); const end = await cloud.follow(CONN, plan.app, d.id);
  assert.equal(end.effectiveState, expect, `deployment ${end.id} ended ${end.effectiveState}: ${end.error ?? ""}`);
  return { plan, end };
}
const call = <T = any>(op: string, args: unknown = {}): Promise<T> => cloud.with(CONN, (c) => c.call<T>(op, args));

before(async () => {
  if (skip) return;
  T.start(); await T.waitSsh(40000);
  const ed = cloud.hostKeys("127.0.0.1", T.sshPort).find((k) => k.type === "ed25519")!;
  cloud.add({ name: CONN, host: "127.0.0.1", port: T.sshPort, user: "pso", auth: "key", keyPath: T.keyFile }, ed.fingerprint);
  evidence["install"] = await cloud.installAgent(CONN, { mode: "development", environment: "testing", yes: true });
});
after(() => { if (!skip) T.stop(); });

test("systemd is a real PID 1; the plan says what an administrator must do for lingering, and the deployment is blocked until it is usable", { skip }, async () => {
  assert.match(T.sh("ps -p 1 -o comm=").out, /systemd/);
  const plan = await call<any>("provision.plan");
  const step = plan.steps.find((s: any) => s.id === "systemd-linger"); assert.ok(step, "the provisioning plan mentions the systemd step");
  assert.match(plan.adminScript, /loginctl enable-linger pso/);
  assert.doesNotMatch(plan.adminScript, /ALL=\(ALL\)|NOPASSWD: ALL/, "no blanket sudo");
  const r = T.shStdin(plan.adminScript); assert.equal(r.code, 0, r.out);
  const i = await call<any>("inspect");
  assert.equal(i.systemd.available, true, JSON.stringify(i.systemd)); assert.equal(i.systemd.linger, true);
  assert.deepEqual(i.blockers, [], i.blockers.join("; "));
  evidence["inspection"] = { systemd: i.systemd, user: i.user };
});

test("the SERVER's policy decides: a declaration cannot request a supervisor the policy forbids", { skip }, async () => {
  const cat = publish("cat", "v1");
  await call("policy.set", { changes: { supervisors: ["process"] } });
  const plan = await cloud.plan(CONN, clean(catalogDecl(cat.url)), undefined, work);
  assert.ok(plan.blockers.some((b) => /does not allow the "systemd" runtime supervisor \(allowed: process\)/.test(b)), plan.blockers.join(" | "));
  await assert.rejects(() => cloud.start(CONN, plan.app, plan.hash), (e: any) => e.code === "POLICY" && /blockers/.test(e.message));
  await call("policy.set", { changes: { supervisors: ["process", "systemd"] } });
});

test("first release (Java catalog and Node orchestrator) as systemd units: ownership marker, no secret in the unit, private environment file, running as the deploy user", { skip }, async () => {
  const cat = publish("cat", "v1"); const orch = publish("orch", "v1");
  await call("secret.set", { name: "sd-db-password", value: "S3cr3t-Db-Pa55-value-xyz" });
  const a = await deploy(catalogDecl(cat.url)); const b = await deploy(orchDecl(orch.url));
  const r = await get(T.httpPort, "sd.test"); assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).catalog.version, "v1", "the Node orchestrator reaches the Java catalog");
  const list = units(); assert.equal(list.filter((u) => /active running/.test(u)).length, 2, list.join("\n"));
  const orchUnit = list.map((u) => u.split(" ")[0]!).find((u) => u.startsWith("pso-sd-orchestrator-web-"))!;
  const file = sysd(`cat ~/.config/systemd/user/${orchUnit}`);
  assert.match(file, /^# Managed by PSO Web \(app=sd-orchestrator/); assert.match(file, /X-PSO-Token=/);
  assert.doesNotMatch(file, /S3cr3t-Db-Pa55/, "the secret is not in the unit file");
  assert.match(file, /NoNewPrivileges=yes/); assert.match(file, /KillMode=control-group/); assert.match(file, /TimeoutStopSec=15/);
  assert.match(file, /ExecStart="\/usr\/local\/bin\/node" "server.js"/, "argv words, absolute program, no shell");
  const envPath = sysd(`ls ~/.pso-agent/apps/sd-orchestrator/run/*.env`).split("\n")[0]!;
  assert.match(sysd(`stat -c '%a %U' ${envPath}`), /^600 pso$/); assert.match(sysd(`cat ${envPath}`), /DB_PASSWORD=/, "the secret lives in the 0600 environment file");
  const pid = sysd(`systemctl --user show ${orchUnit} -p MainPID --value`); assert.equal(T.sh(`ps -o user= -p ${pid}`).out.trim(), "pso");
  assert.equal(sysd(`systemctl --user is-enabled ${orchUnit}`), "enabled", "the active release starts at boot");
  assert.equal(T.sh("ls /etc/systemd/system | grep -c '^pso-' || true").out.trim(), "0", "nothing under /etc/systemd/system");
  assert.equal(T.sh("ls /etc/sudoers.d").out.includes("systemd"), false, "no sudo rule for systemd");
  evidence["firstRelease"] = { catalog: a.plan.candidateRelease, orchestrator: b.plan.candidateRelease, units: list };
});

test("independent update under load: the orchestrator is replaced, the catalog unit is NOT restarted, no failed request", { skip }, async () => {
  const catPidBefore = sysd("systemctl --user show $(systemctl --user list-units --plain --no-legend 'pso-sd-catalog-*' | awk '{print $1}' | head -1) -p MainPID --value");
  const load = new Load(); load.start(T.httpPort, "sd.test", 3); await new Promise((r) => setTimeout(r, 400));
  const v2 = publish("orch", "v2"); await deploy(orchDecl(v2.url));
  await new Promise((r) => setTimeout(r, 400)); await load.stop();
  assert.equal(load.bad, 0, JSON.stringify(load.errors.slice(0, 5)));
  assert.equal(JSON.parse((await get(T.httpPort, "sd.test")).body).version, "v2");
  const catPidAfter = sysd("systemctl --user show $(systemctl --user list-units --plain --no-legend 'pso-sd-catalog-*' | awk '{print $1}' | head -1) -p MainPID --value");
  assert.equal(catPidAfter, catPidBefore, "the unrelated catalog service kept running (same MainPID)");
  const orch = units().filter((u) => u.startsWith("pso-sd-orchestrator-web-"));
  assert.equal(orch.filter((u) => /active running/.test(u)).length, 1, "only the new release's unit runs");
  // an inactive unit is unloaded by systemd; the previous release's unit FILE stays (it is what rollback restarts) but is not enabled
  const files = sysd("ls ~/.config/systemd/user | grep '^pso-sd-orchestrator-web-.*\\.service$'").split("\n").filter(Boolean);
  const newUnit = orch.find((u) => /active running/.test(u))!.split(" ")[0]!; const oldUnit = files.find((f) => f !== newUnit)!;
  assert.ok(oldUnit, `the previous release's unit file is kept for rollback: ${files.join()}`);
  assert.match(sysd(`systemctl --user is-enabled ${oldUnit} 2>&1 || true`), /^disabled$/, "the previous release's unit no longer starts at boot");
  assert.equal(sysd(`systemctl --user is-active ${oldUnit} 2>&1 || true`), "inactive");
  assert.equal(sysd(`systemctl --user is-enabled ${newUnit}`), "enabled");
  evidence["independentUpdate"] = { requests: load.ok, failed: load.bad, catalogMainPidBefore: catPidBefore, catalogMainPidAfter: catPidAfter };
});

test("failing candidate: its unit fails or is stopped, never receives traffic; the active release is unchanged", { skip }, async () => {
  const before = await call<any>("release.status", { app: "sd-orchestrator" });
  const load = new Load(); load.start(T.httpPort, "sd.test", 2);
  const bad = publish("orch", "v3-crash", { crash: true });
  const { end } = await deploy(orchDecl(bad.url), "FAILED");
  assert.match(end.error ?? "", /did not become ready|exited|unit/);
  await new Promise((r) => setTimeout(r, 400)); await load.stop();
  assert.equal(load.bad, 0, JSON.stringify(load.errors.slice(0, 5)));
  const after = await call<any>("release.status", { app: "sd-orchestrator" });
  assert.equal(after.active.release, before.active.release);
  assert.equal(units().filter((u) => u.startsWith("pso-sd-orchestrator-web-") && /active (running|auto-restart)/.test(u)).length, 1, "no candidate unit is left running or restarting");
  const logs = await call<any>("logs.read", { app: "sd-orchestrator", deployment: end.id }); assert.ok(typeof logs.text === "string");
  evidence["failedCandidate"] = { state: end.effectiveState, error: end.error, requests: load.ok, failed: load.bad };
});

test("rollback restores the previous release as systemd units without a failed request", { skip }, async () => {
  const before = await call<any>("release.status", { app: "sd-orchestrator" });
  const load = new Load(); load.start(T.httpPort, "sd.test", 2); await new Promise((r) => setTimeout(r, 300));
  const d = await call<any>("release.rollback", { app: "sd-orchestrator" }); const end = await cloud.follow(CONN, "sd-orchestrator", d.id);
  assert.equal(end.effectiveState, "COMPLETED", end.error);
  await new Promise((r) => setTimeout(r, 300)); await load.stop(); assert.equal(load.bad, 0, JSON.stringify(load.errors.slice(0, 5)));
  assert.equal(JSON.parse((await get(T.httpPort, "sd.test")).body).version, "v1");
  assert.equal((await call<any>("release.status", { app: "sd-orchestrator" })).active.release, before.previous);
  evidence["rollback"] = { requests: load.ok, failed: load.bad, to: before.previous };
});

test("a unit that PSO does not own is never touched; sanitized service logs are returned", { skip }, async () => {
  // an unrelated user unit with a PSO-looking name but no ownership marker, started before more deployments
  T.sh(`mkdir -p /home/pso/.config/systemd/user && printf '[Service]\\nExecStart=/bin/sleep 100000\\n' > /home/pso/.config/systemd/user/pso-foreign-svc-r1-0.service && chown -R pso: /home/pso/.config`);
  sysd("systemctl --user daemon-reload && systemctl --user start pso-foreign-svc-r1-0.service");
  const v4 = publish("orch", "v4"); await deploy(orchDecl(v4.url));
  assert.match(sysd("systemctl --user is-active pso-foreign-svc-r1-0.service"), /^active$/, "the foreign unit still runs");
  assert.equal(sysd("systemctl --user is-enabled pso-foreign-svc-r1-0.service 2>&1 || true").includes("enabled"), false);
  const logs = await call<any>("logs.read", { app: "sd-orchestrator", service: "web" });
  assert.match(logs.source, /journal|log file/); assert.doesNotMatch(logs.text, /S3cr3t-Db-Pa55/);
  sysd("systemctl --user stop pso-foreign-svc-r1-0.service; rm -f ~/.config/systemd/user/pso-foreign-svc-r1-0.service");
  evidence["logs"] = { source: logs.source };
});

test("a crashed service is restarted by systemd (Restart=on-failure), and the release stays healthy", { skip }, async () => {
  const unit = units().map((u) => u.split(" ")[0]!).find((u) => u.startsWith("pso-sd-orchestrator-web-") && sysd(`systemctl --user is-active ${u}`) === "active")!;
  const pid = sysd(`systemctl --user show ${unit} -p MainPID --value`);
  assert.equal(T.sh(`kill -9 ${pid}`, "pso").code, 0);
  let healthy = false; for (let i = 0; i < 40 && !healthy; i++) { await new Promise((r) => setTimeout(r, 500)); try { healthy = (await get(T.httpPort, "sd.test")).status === 200; } catch { /* restarting */ } }
  assert.equal(healthy, true, "service came back after SIGKILL");
  const pid2 = sysd(`systemctl --user show ${unit} -p MainPID --value`); assert.notEqual(pid2, pid);
  evidence["crashRestart"] = { unit, killedPid: pid, newPid: pid2 };
});

test("server restart: with lingering the ACTIVE release comes back by itself (no agent, no operator), the old release does not", { skip }, async () => {
  const activeBefore = (await call<any>("release.status", { app: "sd-orchestrator" })).active.release;
  const enabled = units().map((u) => u.split(" ")[0]!).filter((u) => sysd(`systemctl --user is-enabled ${u} 2>&1 || true`) === "enabled");
  assert.ok(enabled.length >= 2, enabled.join());
  const r = T.sh("true"); assert.equal(r.code, 0);
  const restart = (await import("node:child_process")).spawnSync("docker", ["restart", "-t", "10", T.name], { encoding: "utf8", windowsHide: true }); assert.equal(restart.status, 0, restart.stderr);
  let up: { status: number; body: string; headers: Record<string, any> } | undefined;
  for (let i = 0; i < 90 && !up; i++) { await new Promise((r) => setTimeout(r, 1000)); const o = T.sh("curl -s -m 3 -H 'Host: sd.test' -D - http://127.0.0.1:8080/ || true"); if (/200 OK/.test(o.out) && /catalog/.test(o.out)) up = { status: 200, body: o.out, headers: {} }; }
  assert.ok(up, "the application answers after the server restarted");
  assert.match(up!.body, new RegExp(`x-pso-release: ${activeBefore}`, "i"), "the release that was active is the one that came back");
  const running = units().filter((u) => /active running/.test(u)).map((u) => u.split(" ")[0]!);
  assert.equal(running.length, 2, `only the active release's units run after boot: ${running.join()}`);
  evidence["serverRestart"] = { activeBefore, runningAfterBoot: running };
});

test("evidence file", { skip }, async () => {
  const dir = join(import.meta.dirname, "..", "..", "..", "docs", "implementation", "evidence", "clo"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "e2e-systemd-evidence.json"), JSON.stringify(evidence, null, 2));
});
