import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud, LocalStore, MemoryCredentialProvider, AgentClient, discoverDeclarations, declFor, type DeploymentDecl, type PipelineDecl } from "../src/index.ts";
import { LinuxTarget, dockerAvailable, makeAppRepo } from "./target.ts";

/**
 * End-to-end validation against a REAL Linux server (a Docker container with sshd, nginx, Node and a JDK), reached over real SSH from
 * this machine with strict host-key verification. It exercises the agent, the engine, nginx and the process runtime for real.
 * It is NOT a validation of an external cloud environment, and the "server" is a container on this host.
 * Skipped when the image `pso-e2e-target:1` is not built (docker build packages/deploy/test/fixtures/target -t pso-e2e-target:1).
 */
const skip = !dockerAvailable() && "Docker image pso-e2e-target:1 is not available";
const T = new LinuxTarget();
const work = mkdtempSync(join(tmpdir(), "pso-e2e-work-"));
const cloud = new Cloud({ store: new LocalStore(mkdtempSync(join(tmpdir(), "pso-e2e-home-"))), creds: new MemoryCredentialProvider() });
const evidence: Record<string, unknown> = { generatedAt: new Date().toISOString(), environment: "Docker container (Alpine, sshd, nginx 1.x, Node 24, OpenJDK 21) on the development machine, reached over SSH", notExternalCloud: true };
const CONN = "e2e";

// ---------------------------------------------------------------- helpers
interface Rec { t: number; ms: number; id: string; status: number; version?: string; catalog?: string; release?: string; error?: string; reachedNginx?: boolean }
let loadSeq = 0;
class Load {
  records: Rec[] = []; private running = false; private workers: Promise<void>[] = [];
  private readonly port: number; private readonly host: string; private readonly path: string;
  constructor(port: number, host: string, path = "/") { this.port = port; this.host = host; this.path = path; }
  private one(): Promise<void> {
    return new Promise((res) => {
      const t = Date.now();
      // every request carries a unique id in its query string, so a failure can be traced in the server's own access log
      const id = `L${++loadSeq}`;
      let settled = false;
      const done = (rec: Omit<Rec, "t" | "ms" | "id">) => { if (settled) return; settled = true; this.records.push({ t, ms: Date.now() - t, id, ...rec }); res(); };
      const r = request({ host: "127.0.0.1", port: this.port, path: `${this.path}${this.path.includes("?") ? "&" : "?"}load=${id}`, headers: { host: this.host }, agent: false, timeout: 5000 }, (resp) => {
        let b = ""; resp.on("data", (d) => (b += d)); resp.on("end", () => { let v: any = {}; try { v = JSON.parse(b); } catch { /* not json */ } done({ status: resp.statusCode ?? 0, version: v.version, catalog: v.catalog?.version, release: String(resp.headers["x-pso-release"] ?? "") }); });
      });
      // one request is one record: destroying a timed-out request also emits an error, which must not be counted a second time
      r.on("timeout", () => { done({ status: 0, error: "timeout" }); r.destroy(); });
      r.on("error", (e) => done({ status: 0, error: (e as NodeJS.ErrnoException).code ?? "error" }));
      r.end();
    });
  }
  /** For each failed request: did it reach nginx in the target at all? (no = lost before the server: host or port-forwarding stall) */
  classifyFailures(): Rec[] {
    const failed = this.records.filter((r) => r.status !== 200);
    if (!failed.length) return failed;
    const log = T.sh("cat /var/log/nginx/access.log 2>/dev/null").out;
    for (const f of failed) f.reachedNginx = log.includes(`load=${f.id} `) || log.includes(`load=${f.id}"`);
    return failed;
  }
  start(concurrency = 3): void { this.running = true; for (let i = 0; i < concurrency; i++) this.workers.push((async () => { while (this.running) { await this.one(); await new Promise((r) => setTimeout(r, 15)); } })()); }
  async stop(): Promise<void> { this.running = false; await Promise.all(this.workers); this.workers = []; }
  summary() { const ok = this.records.filter((r) => r.status === 200).length; const versions = [...new Set(this.records.map((r) => r.version))]; const ms = this.records.map((r) => r.ms).sort((x, y) => x - y); return { latencyMs: { p50: ms[Math.floor(ms.length * 0.5)] ?? 0, p99: ms[Math.floor(ms.length * 0.99)] ?? 0, max: ms[ms.length - 1] ?? 0 }, requests: this.records.length, ok, failed: this.records.length - ok, errors: this.classifyFailures().slice(0, 8), versions, releases: [...new Set(this.records.map((r) => r.release))] }; }
}
const get = (port: number, host: string, path = "/"): Promise<{ status: number; body: string; headers: Record<string, any> }> => new Promise((res, rej) => { const r = request({ host: "127.0.0.1", port, path, headers: { host }, agent: false, timeout: 5000 }, (resp) => { let b = ""; resp.on("data", (d) => (b += d)); resp.on("end", () => res({ status: resp.statusCode ?? 0, body: b, headers: resp.headers })); }); r.on("error", rej); r.end(); });

const repos = { orch: join(work, "orch-src"), cat: join(work, "cat-src") };
const publish = (which: "orch" | "cat", version: string, flags: Record<string, unknown> = {}): { commit: string; url: string } => {
  const commit = makeAppRepo(repos[which], which === "orch" ? "orchestrator" : "catalog", version, flags);
  return { commit, url: T.putRepo(repos[which], which === "orch" ? "shop-orchestrator" : "shop-catalog") };
};

const catalogDecl = (url: string, over: Partial<DeploymentDecl> = {}): DeploymentDecl => ({
  name: "shop-catalog", environment: "testing", connection: { provider: "ssh", credentials: CONN },
  source: { provider: "git", url, branch: "main" },
  service: { name: "catalog", runtime: "java", build: [["javac", "-d", "out", "Main.java"]], start: ["java", "-cp", "out", "Main"], health: { readyPath: "/health/ready", timeoutSeconds: 45 }, shutdownGraceSeconds: 10, internalPort: 21001, resources: { memoryMb: 64 }, requires: { java: ">=17" } },
  strategy: { type: "blue-green", proxy: "nginx", rollback: true, drainSeconds: 2, retention: { keep: 4 } },
  proxy: { nginx: { listen: { http: 8080 } } },
  ...over,
});
const orchDecl = (url: string, over: Partial<DeploymentDecl> = {}): DeploymentDecl => ({
  name: "shop-orchestrator", environment: "testing", connection: { provider: "ssh", credentials: CONN },
  source: { provider: "git", url, branch: "main" },
  service: { name: "web", runtime: "node", start: ["node", "server.js"], health: { readyPath: "/health/ready", livePath: undefined, timeoutSeconds: 30 } as any, shutdownGraceSeconds: 10, route: { path: "/" }, env: { CATALOG_URL: "http://127.0.0.1:21001" }, secrets: { DB_PASSWORD: "shop-db-password" }, resources: { memoryMb: 64 }, requires: { node: ">=22" } },
  strategy: { type: "blue-green", proxy: "nginx", rollback: true, drainSeconds: 2, retention: { keep: 4 } },
  proxy: { nginx: { domains: ["shop.test"], listen: { http: 8080 } } },
  ...over,
});
const clean = (d: any): DeploymentDecl => JSON.parse(JSON.stringify(d));
async function deploy(decl: DeploymentDecl, pipeline?: PipelineDecl, opts: { expect?: "COMPLETED" | "FAILED" | "ROLLED_BACK" } = {}) {
  const plan = await cloud.plan(CONN, clean(decl), pipeline, work);
  assert.deepEqual(plan.blockers, [], `plan blockers: ${plan.blockers.join(" | ")}`);
  const d = await cloud.start(CONN, plan.app, plan.hash);
  const end = await cloud.follow(CONN, plan.app, d.id);
  assert.equal(end.effectiveState, opts.expect ?? "COMPLETED", `deployment ${end.id} ended ${end.effectiveState}: ${end.error ?? ""}`);
  return { plan, end };
}
const call = <T = any>(op: string, args: unknown = {}): Promise<T> => cloud.with(CONN, (c) => c.call<T>(op, args));
const status = (app: string) => call<any>("release.status", { app });

before(async () => {
  if (skip) return;
  T.start(); await T.waitSsh();
  const keys = cloud.hostKeys("127.0.0.1", T.sshPort);
  const ed = keys.find((k) => k.type === "ed25519")!;
  cloud.add({ name: CONN, host: "127.0.0.1", port: T.sshPort, user: "pso", auth: "key", keyPath: T.keyFile }, ed.fingerprint);
  evidence["install"] = await cloud.installAgent(CONN, { mode: "development", environment: "testing", yes: true });
});
after(() => { if (!skip) T.stop(); });

// ================================================================ the tests (sequential: each builds on the server state of the previous)
test("connection: strict host key and pinned agent identity are enforced", { skip }, async () => {
  const ok = await cloud.test(CONN); assert.equal(ok.ok, true, JSON.stringify(ok.steps));
  const c = cloud.get(CONN);
  // 1) a changed agent identity is refused before anything is sent
  const saved = c.agentFingerprint!; c.agentFingerprint = "SHA256:" + "A".repeat(43); cloud.store.saveConnection(c);
  await assert.rejects(() => cloud.connect(CONN), (e: any) => e.code === "IDENTITY_CHANGED" && /AGENT IDENTITY CHANGED/.test(e.message));
  c.agentFingerprint = saved; cloud.store.saveConnection(c);
  // 2) a different SSH host key in known_hosts is a hard failure (no prompt, BatchMode)
  const { readFileSync, writeFileSync: w } = await import("node:fs");
  const kh = cloud.store.knownHostsFile; const original = readFileSync(kh, "utf8");
  const other = readFileSync(`${T.keyFile}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  w(kh, `[127.0.0.1]:${T.sshPort} ${other}\n`);
  const bad = await cloud.test(CONN); assert.equal(bad.ok, false); assert.match(bad.steps.find((s) => s.step === "ssh")!.detail, /failed/i);
  w(kh, original);
  assert.equal((await cloud.test(CONN)).ok, true);
  evidence["hostIdentity"] = { agentIdentityChangeRefused: true, changedSshHostKeyRefused: true, sshDetail: bad.steps.find((s) => s.step === "ssh")!.detail.slice(0, 160) };
});

test("inspection and provisioning plan: blockers before the administrator step, none after", { skip }, async () => {
  const before = await call<any>("inspect");
  assert.ok(before.blockers.length >= 1, "nothing is prepared yet");
  assert.equal(before.os.platform, "linux"); assert.equal(before.user.root, false, "the agent runs unprivileged");
  const plan = await call<any>("provision.plan");
  assert.ok(plan.steps.some((s: any) => s.id === "nginx-dir" && s.status === "admin"));
  assert.match(plan.adminScript, /visudo -cf/); assert.doesNotMatch(plan.adminScript, /ALL=\(ALL\)/, "the sudo rule is not unrestricted");
  const applied = await call<any>("provision.apply"); assert.ok(Array.isArray(applied.remaining));
  const r = T.shStdin(plan.adminScript); assert.equal(r.code, 0, r.out); // the administrator, not PSO, runs it
  assert.equal(T.sh("nginx -t").code, 0);
  const after = await call<any>("inspect"); assert.deepEqual(after.blockers, [], after.blockers.join("; "));
  assert.equal(after.nginx.vhosts.some((v: any) => /unrelated/.test(v.serverNames.join())), true, "an existing unrelated vhost was discovered, not hidden");
  evidence["inspection"] = { os: after.os, tools: after.tools, vhostsDiscovered: after.nginx.vhosts.length, blockersBefore: before.blockers };
});

test("declarations are read statically: computed values are refused, secrets are rejected", { skip }, () => {
  const root = join(work, "ws"); mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy", "testing.deployment.pso.ts"), `import { defineDeployment } from "@pso/deploy";\nexport default defineDeployment(${JSON.stringify(catalogDecl("file:///srv/repos/x.git"), null, 2)});\n`);
  const [d] = discoverDeclarations(root); assert.ok(d); assert.deepEqual(d!.diagnostics.filter((x) => x.level === "error"), []);
  assert.equal(declFor([d!], "testing").deployment.name, "shop-catalog");
  writeFileSync(join(root, "deploy", "prod.deployment.pso.ts"), `import { defineDeployment } from "@pso/deploy";\nexport default defineDeployment({ name: "x", environment: process.env.TARGET, connection: { provider: "ssh", credentials: "c" } });\n`);
  const bad = discoverDeclarations(root).find((x) => /prod/.test(x.file))!;
  assert.ok(bad.diagnostics.some((x) => x.code === "PSO-DEC-STATIC" && /not a literal/.test(x.message)), "process.env is not evaluated");
});

test("first release of both apps (Java catalog and Node orchestrator), independently, through nginx", { skip }, async () => {
  const unrelatedBefore = T.sh("sha256sum /etc/nginx/http.d/unrelated.conf").out;
  const cat = publish("cat", "v1"); const orch = publish("orch", "v1");
  // the secret the orchestrator receives lives on the server, set through the signed protocol; it never appears in a declaration
  await call("secret.set", { name: "shop-db-password", value: "S3cr3t-Db-Pa55-value-xyz" });
  const a = await deploy(catalogDecl(cat.url)); evidence["catalogRelease1"] = { release: a.plan.candidateRelease, commit: cat.commit };
  const b = await deploy(orchDecl(orch.url)); evidence["orchestratorRelease1"] = { release: b.plan.candidateRelease, commit: orch.commit };
  const r = await get(T.httpPort, "shop.test"); assert.equal(r.status, 200);
  const body = JSON.parse(r.body); assert.equal(body.version, "v1"); assert.equal(body.catalog.version, "v1", "the orchestrator reaches the Java catalog through its stable internal address");
  assert.equal(r.headers["x-pso-release"], b.plan.candidateRelease);
  assert.equal(b.plan.source.provider === "git" && b.plan.source.commit, orch.commit, "the plan pins the branch to the commit that was pushed");
  assert.equal(T.sh("sha256sum /etc/nginx/http.d/unrelated.conf").out, unrelatedBefore, "unrelated nginx files are never modified");
  assert.match((await get(T.otherPort, "unrelated.example.test")).body, /unrelated site/);
  assert.match(T.sh("head -1 /etc/nginx/pso.d/pso-shop-orchestrator.conf").out, /^# Managed by PSO Web \(app=shop-orchestrator\)/);
  // the agent runs as an ordinary user and listens on no port
  assert.equal(T.sh("ps -eo user,args | grep -E '[n]ode' | awk '{print $1}' | sort -u").out.trim().split("\n").every((u) => u.trim() === "pso"), true);
  const listening = T.sh("netstat -ltn 2>/dev/null | awk '{print $4}'").out;
  assert.doesNotMatch(listening, /0\.0\.0\.0:(?!22\b|80\b|8080\b|8081\b)\d+/, "no management port: only ssh and nginx (the image's default site on 80, the PSO site on 8080, the unrelated site on 8081) listen on all interfaces");
  assert.doesNotMatch(T.sh("cat /etc/nginx/pso.d/*.conf").out, /pso-agent|\bmanagement\b|\bserve\b|stdio/i, "nginx never publishes the management plane");
});

test("zero-downtime release v2 under continuous load, orchestrator and catalog updated independently", { skip }, async () => {
  const load = new Load(T.httpPort, "shop.test"); load.start(3);
  await new Promise((r) => setTimeout(r, 800));
  const cat = publish("cat", "v2"); const orch = publish("orch", "v2");
  const t0 = Date.now();
  const a = await deploy(catalogDecl(cat.url));  // catalog only: the orchestrator is not rebuilt or restarted
  const mid = load.records.filter((r) => r.t > t0).map((r) => `${r.version}/${r.catalog}`);
  assert.ok(new Set(mid).has("v1/v2") || mid.length > 0, "requests continue during the catalog update");
  const b = await deploy(orchDecl(orch.url)); const t1 = Date.now();
  await new Promise((r) => setTimeout(r, 800)); await load.stop();
  const s = load.summary();
  const flips = load.records.filter((r) => r.version).map((r) => `${r.version}/${r.catalog}`);
  const firstV2 = flips.indexOf("v2/v2"); assert.ok(firstV2 > 0, "v1 traffic before, v2 traffic after");
  assert.equal(flips.slice(firstV2).some((x) => x === "v1/v1" || x === "v1/v2"), false, "after the switch no request is served by the old orchestrator");
  assert.ok(flips.includes("v1/v2"), "the new catalog served through the OLD orchestrator before it was replaced: independent service update");
  assert.equal(s.failed, 0, `requests failed during the deployments: ${JSON.stringify(s.errors)}`);
  assert.ok(s.requests > 100, `enough requests to be meaningful (${s.requests})`);
  evidence["zeroDowntimeV2"] = { ...s, deploymentWindowMs: t1 - t0, catalogRelease: a.plan.candidateRelease, orchestratorRelease: b.plan.candidateRelease, firstResponseFromNewOrchestratorAfterRequests: firstV2, strategy: "blue-green", measuredAgainst: `127.0.0.1:${T.httpPort} -> container nginx -> candidate/active release`, sequenceOfVersions: [...new Set(flips)] };
  // the previous release stopped only after the switch, and the active release is the new one
  const st = await status("shop-orchestrator");
  assert.equal(st.active.release, b.plan.candidateRelease); assert.ok(st.previous); assert.equal(st.lastKnownGood, b.plan.candidateRelease);
});

test("a failing candidate (crashes / never ready) never receives traffic and the active release keeps serving", { skip }, async () => {
  const before = await status("shop-orchestrator");
  const load = new Load(T.httpPort, "shop.test"); load.start(2);
  const crash = publish("orch", "v3-crash", { crash: true });
  const plan = await cloud.plan(CONN, clean(orchDecl(crash.url)), undefined, work);
  const d = await cloud.start(CONN, plan.app, plan.hash); const end = await cloud.follow(CONN, plan.app, d.id);
  assert.equal(end.effectiveState, "FAILED"); assert.match(end.error ?? "", /did not become ready|exited/);
  const notReady = publish("orch", "v3-503", { notReady: true });
  // even with every optional stage disabled, candidate readiness is a mandatory invariant
  const lax: PipelineDecl = { name: "lax", stages: [{ type: "integrity", enabled: false }, { type: "compatibility", enabled: false }, { type: "security", enabled: false }, { type: "tests", enabled: false }, { type: "health", enabled: false }, { type: "build", enabled: false }, { type: "deploy" }] };
  const p2 = await cloud.plan(CONN, clean(orchDecl(notReady.url, { pipeline: "lax" })), lax, work);
  assert.ok(p2.disabledChecks.length >= 5, "every disabled check is recorded in the plan"); assert.ok(p2.disabledChecks.every((x) => x.reason));
  const d2 = await cloud.start(CONN, p2.app, p2.hash); const end2 = await cloud.follow(CONN, p2.app, d2.id);
  assert.equal(end2.effectiveState, "FAILED"); assert.match(end2.error ?? "", /did not become ready/);
  await new Promise((r) => setTimeout(r, 500)); await load.stop();
  const s = load.summary(); assert.equal(s.failed, 0, JSON.stringify(s.errors));
  const after = await status("shop-orchestrator");
  assert.equal(after.active.release, before.active.release, "the active release did not change");
  assert.equal(T.sh("ps -eo args | grep -c '[s]erver.js'").out.trim(), "1", "no candidate process was left running");
  assert.equal((await get(T.httpPort, "shop.test")).headers["x-pso-release"], before.active.release);
  const audit = await call<any[]>("audit.read", { event: "deploy.state.failed" }); assert.ok(audit.length >= 2);
  evidence["failedCandidates"] = { crashOnStart: { state: end.effectiveState, error: end.error }, neverReadyWithAllOptionalStagesDisabled: { state: end2.effectiveState, error: end2.error, disabledChecks: p2.disabledChecks }, requestsDuring: s, activeReleaseUnchanged: after.active.release === before.active.release, candidateProcessesLeft: 0 };
});

test("rollback under load restores the previous release without failed requests", { skip }, async () => {
  const before = await status("shop-orchestrator");
  const load = new Load(T.httpPort, "shop.test"); load.start(3); await new Promise((r) => setTimeout(r, 500));
  const d = await cloud.with(CONN, (c) => c.call<any>("release.rollback", { app: "shop-orchestrator" }));
  const end = await cloud.follow(CONN, "shop-orchestrator", d.id); assert.equal(end.effectiveState, "COMPLETED", end.error);
  await new Promise((r) => setTimeout(r, 500)); await load.stop();
  const s = load.summary(); assert.equal(s.failed, 0, JSON.stringify(s.errors));
  const after = await status("shop-orchestrator");
  assert.equal(after.active.release, before.previous); assert.equal(JSON.parse((await get(T.httpPort, "shop.test")).body).version, "v1");
  assert.ok(s.versions.includes("v1") && s.versions.includes("v2"));
  evidence["rollback"] = { from: before.active.release, to: after.active.release, ...s, kind: end.kind, note: "database changes (none here) would not be reverted by an application rollback" };
});

test("interrupted deployment: worker killed mid-build is detected, recovery is safe, lock is not stolen", { skip }, async () => {
  const before = await status("shop-orchestrator");
  const slowOrch = publish("orch", "v4-slow");
  const decl = orchDecl(slowOrch.url, { service: { ...(orchDecl(slowOrch.url).service as any), build: [["sleep", "40"]] } });
  const plan = await cloud.plan(CONN, clean(decl), undefined, work);
  const d = await cloud.start(CONN, plan.app, plan.hash);
  // a second deployment of the same application is refused while the first holds the lock
  const p2 = await cloud.plan(CONN, clean(orchDecl(slowOrch.url)), undefined, work).catch((e) => e);
  const second = p2 instanceof Error ? p2 : await cloud.start(CONN, "shop-orchestrator", p2.hash).catch((e) => e);
  assert.ok(second instanceof Error && /LOCKED|lock/.test(`${(second as any).code} ${second.message}`), "concurrent deployment is refused");
  // wait for BUILDING, then kill the worker abruptly (as a crash or a reboot would)
  let cur: any; for (let i = 0; i < 40; i++) { cur = await call("release.get", { app: plan.app, deployment: d.id }); if (cur.state === "BUILDING") break; await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(cur.state, "BUILDING"); T.sh(`kill -9 ${cur.workerPid}; pkill -f 'sleep 40' || true`);
  await new Promise((r) => setTimeout(r, 800));
  const mid = await status("shop-orchestrator"); assert.equal(mid.deployment.effectiveState, "INTERRUPTED"); assert.equal(mid.lock.status, "stale");
  await assert.rejects(() => cloud.start(CONN, plan.app, plan.hash), (e: any) => e.code === "LOCKED", "a stale lock is never taken silently");
  const rec = await call<any>("release.recover", { app: plan.app });
  assert.equal(rec.action, "interrupted-before-switch");
  const after = await status("shop-orchestrator");
  assert.equal(after.lock.status, "free"); assert.equal(after.active.release, before.active.release, "the active release was never touched");
  assert.equal(after.deployment.state, "FAILED");
  assert.equal((await get(T.httpPort, "shop.test")).status, 200);
  evidence["interruptedRecovery"] = { stateAfterKill: mid.deployment.effectiveState, lockAfterKill: mid.lock.status, recovery: rec, activeReleaseUnchanged: true };
});

test("a deployment survives the client disconnecting", { skip }, async () => {
  const orch = publish("orch", "v5");
  const decl = orchDecl(orch.url, { service: { ...(orchDecl(orch.url).service as any), build: [["sleep", "4"]] } });
  const plan = await cloud.plan(CONN, clean(decl), undefined, work);
  const d = await cloud.start(CONN, plan.app, plan.hash);
  // no client is connected from here on: the work continues on the server
  await new Promise((r) => setTimeout(r, 1500));
  const mid = await call<any>("release.get", { app: plan.app, deployment: d.id }); assert.equal(mid.workerAlive, true);
  const end = await cloud.follow(CONN, plan.app, d.id); assert.equal(end.effectiveState, "COMPLETED");
  evidence["clientDisconnect"] = { deployment: d.id, completedWithoutClient: true };
});

test("pipeline stages report honestly: security scanners that cannot run are not a pass", { skip }, async () => {
  const st = await call<any>("release.history", { app: "shop-orchestrator", limit: 20 });
  const withSecurity = st.find((d: any) => d.stages.some((s: any) => s.type === "security" && !["skipped", "disabled"].includes(s.status)));
  assert.ok(withSecurity, "a deployment with the security stage exists");
  const sec = withSecurity.stages.find((s: any) => s.type === "security");
  const reports = (sec.data?.report ?? []) as Array<{ scanner: string; ran: boolean }>;
  assert.ok(reports.some((r) => r.scanner === "pso-secret-pattern-scan" && r.ran));
  const cat = (await call<any>("release.history", { app: "shop-catalog", limit: 5 }))[0];
  const jr = (cat.stages.find((s: any) => s.type === "security")?.data?.report ?? []) as Array<{ scanner: string; ran: boolean; available: boolean }>;
  assert.ok(jr.some((r) => /java-dependency-scan/.test(r.scanner) && !r.ran && !r.available), "no Java scanner exists and the report says so instead of passing");
  const skippedTests = st[0].stages.find((s: any) => s.type === "tests");
  assert.equal(skippedTests?.status, "disabled", "a stage switched off by the pipeline is `disabled`, not `skipped` and never `passed`");
  assert.equal(cat.stages.find((s: any) => s.type === "security")?.status, "unavailable", "a Java scan that could not run makes the security stage `unavailable`, never `passed`");
  evidence["securityStageReport"] = { orchestrator: sec.detail, java: cat.stages.find((s: any) => s.type === "security")?.detail };
});

test("secrets: injected into the process, never in declarations, plans, logs, audit or responses", { skip }, async () => {
  const value = "S3cr3t-Db-Pa55-value-xyz";
  const leaker = publish("orch", "v6-leak", { leak: true });
  const { plan, end } = await deploy(orchDecl(leaker.url));
  const env = T.sh(`cat /proc/$(pgrep -f 'node server.js' | head -1)/environ | tr '\\0' '\\n' | grep DB_PASSWORD`, "pso").out;
  assert.match(env, /DB_PASSWORD=S3cr3t/, "the application received the secret");
  const logs = await call<any>("logs.read", { app: "shop-orchestrator", service: "web" });
  assert.match(logs.text, /startup secret value/); assert.ok(!logs.text.includes(value), "the application log, when read through PSO, does not return the secret");
  const dl = await call<any>("logs.read", { app: "shop-orchestrator", deployment: end.id }); assert.ok(!dl.text.includes(value));
  const audit = JSON.stringify(await call("audit.read", { limit: 1000 })); assert.ok(!audit.includes(value));
  assert.ok(!JSON.stringify(plan).includes(value) && !JSON.stringify(end).includes(value));
  assert.equal(T.sh(`find /home/pso/.pso-agent -type f -not -path '*/secrets/*' -not -path '*/logs/services/*' -not -name '*.mjs' | xargs grep -l '${value}' 2>/dev/null | wc -l`).out.trim(), "0", "the value is stored only in the secret store and in the application's own log, never in agent state, manifests or the audit log");
  assert.equal((await call<string[]>("secret.list")).includes("shop-db-password"), true);
  evidence["secrets"] = { injectedIntoProcess: true, absentFromPlanLogsAuditAndResponses: true, limitation: "the application's own log file is written by the application: if it prints a secret it is on disk there; PSO only masks it when returning logs" };
});

test("nginx safety: an invalid proxy configuration is rejected, the previous one stays active and nothing unrelated changes", { skip }, async () => {
  const before = await status("shop-orchestrator");
  const confBefore = createHash("sha256").update(T.sh("cat /etc/nginx/pso.d/pso-shop-orchestrator.conf | grep -v '^# generated'").out).digest("hex");
  const orch = publish("orch", "v7");
  const decl = orchDecl(orch.url, { proxy: { nginx: { domains: ["shop.test"], listen: { http: 8080, https: 8443 }, tls: { certificate: "/nonexistent/cert.pem", key: "/nonexistent/key.pem" } } } });
  const plan = await cloud.plan(CONN, clean(decl), undefined, work); assert.deepEqual(plan.blockers, []);
  const d = await cloud.start(CONN, plan.app, plan.hash); const end = await cloud.follow(CONN, plan.app, d.id);
  assert.equal(end.effectiveState, "FAILED"); assert.match(end.error ?? "", /nginx rejected/);
  const logs = (await call<any>("logs.read", { app: plan.app, deployment: d.id })).text; assert.match(logs, /nginx switch: nginx rejected/);
  const confAfter = createHash("sha256").update(T.sh("cat /etc/nginx/pso.d/pso-shop-orchestrator.conf | grep -v '^# generated'").out).digest("hex");
  assert.equal(confAfter, confBefore, "the previous configuration is byte-for-byte the same"); assert.equal(T.sh("nginx -t").code, 0);
  assert.equal((await status("shop-orchestrator")).active.release, before.active.release);
  assert.equal((await get(T.httpPort, "shop.test")).status, 200);
  // a plan that collides with an existing vhost PSO does not own is blocked
  const clash = await cloud.plan(CONN, clean(orchDecl(orch.url, { name: "clash", proxy: { nginx: { domains: ["unrelated.example.test"], listen: { http: 8081 } } } })), undefined, work);
  assert.ok(clash.blockers.some((b) => /unrelated\.conf|already serves/.test(b)), clash.blockers.join("|"));
  evidence["nginxSafety"] = { invalidConfigRejected: true, previousConfigIdentical: true, collisionWithExternalVhostBlocked: clash.blockers.filter((b) => /already serves/.test(b)) };
});

test("authorization, approvals and plan binding", { skip }, async () => {
  // a viewer can look but not deploy; the role comes from the enrollment token an administrator created
  const tok = await call<any>("enroll.create", { role: "viewer", minutes: 5 });
  const c = cloud.get(CONN); const viewerConn = { ...c, name: "viewer", clientKeyRef: undefined, clientId: undefined } as any; delete viewerConn.clientKeyRef; cloud.store.saveConnection({ ...viewerConn });
  await cloud.enroll("viewer", tok.token);
  await assert.rejects(() => cloud.enroll("viewer", tok.token), (e: any) => e.code === "ENROLLMENT_REFUSED", "an enrollment token is single use");
  const who = await cloud.with("viewer", (x) => x.call<any>("whoami")); assert.equal(who.role, "viewer");
  await cloud.with("viewer", (x) => x.call("release.status", { app: "shop-orchestrator" }));
  await assert.rejects(() => cloud.with("viewer", (x) => x.call("release.rollback", { app: "shop-orchestrator" })), (e: any) => e.code === "FORBIDDEN");
  await assert.rejects(() => cloud.with("viewer", (x) => x.call("audit.read")), (e: any) => e.code === "FORBIDDEN");
  // protected policy: approval by someone else is required, and the plan is bound to the commit
  await call("policy.set", { changes: { approvalsRequired: 1, selfApproval: false } });
  const orch = publish("orch", "v8");
  const plan = await cloud.plan(CONN, clean(orchDecl(orch.url)), undefined, work);
  await assert.rejects(() => cloud.start(CONN, plan.app, plan.hash), (e: any) => e.code === "POLICY" && /needs 1 approval/.test(e.message));
  await assert.rejects(() => cloud.approve(CONN, plan.app, plan.hash), (e: any) => /other than the person who proposed/.test(e.message), "the proposer cannot approve under this policy");
  // a second deployer approves
  const t2 = await call<any>("enroll.create", { role: "deployer", minutes: 5 });
  cloud.store.saveConnection({ ...viewerConn, name: "approver" }); await cloud.enroll("approver", t2.token);
  await cloud.approve("approver", plan.app, plan.hash);
  // the branch moves after approval: the approved plan must NOT deploy the newer commit
  publish("orch", "v8-newer");
  await assert.rejects(() => cloud.start(CONN, plan.app, plan.hash), (e: any) => e.code === "PLAN_STALE" && /never deployed implicitly/.test(e.message));
  // a fresh plan, approved, goes through
  const plan2 = await cloud.plan(CONN, clean(orchDecl(orch.url)), undefined, work);
  await cloud.approve("approver", plan2.app, plan2.hash);
  const d = await cloud.start(CONN, plan2.app, plan2.hash); assert.equal((await cloud.follow(CONN, plan2.app, d.id)).effectiveState, "COMPLETED");
  await call("policy.set", { changes: { approvalsRequired: 0, selfApproval: true } });
  // revocation ends the client at once
  const list = await call<any[]>("client.list"); const target = list.find((x) => x.role === "viewer" && !x.revoked);
  await call("client.revoke", { clientId: target.id });
  await assert.rejects(() => cloud.with("viewer", (x) => x.call("whoami")), (e: any) => e.code === "UNAUTHENTICATED");
  assert.equal((await call<any[]>("audit.read", { event: "authz.denied" })).length >= 2, true);
  const verify = await call<any>("audit.verify"); assert.equal(verify.ok, true);
  evidence["authorization"] = { viewerCannotDeploy: true, enrollmentTokenSingleUse: true, approvalRequiredAndSeparate: true, staleApprovedPlanRefused: true, revocationImmediate: true, auditChain: verify };
});

test("recreate strategy states its downtime; rolling keeps serving with two instances", { skip }, async () => {
  // recreate: no proxy, fixed port, explicit downtime
  const orch = publish("orch", "r1");
  const rec = (v: string) => orchDecl(orch.url, { name: "shop-recreate", strategy: { type: "recreate", proxy: "none", downtimeAcknowledged: true, rollback: true }, proxy: undefined, service: { ...(orchDecl(orch.url).service as any), port: 21500, route: undefined, secrets: undefined, env: { CATALOG_URL: "http://127.0.0.1:21001" } } } as any);
  const p1 = await cloud.plan(CONN, clean(rec("r1")), undefined, work); assert.equal(p1.availability.impact, "downtime"); assert.match(p1.availability.summary, /stopped before the new one starts/);
  await deploy(rec("r1")); publish("orch", "r2");
  const t0 = Date.now(); const { end } = await deploy(rec("r2"));
  evidence["recreate"] = { declaredDowntime: p1.availability.summary, deploymentMs: Date.now() - t0, state: end.effectiveState };
  // an invalid combination is refused instead of being silently downgraded
  const bad = clean(orchDecl(orch.url, { strategy: { type: "blue-green", proxy: "none" } } as any));
  await assert.rejects(() => cloud.plan(CONN, bad, undefined, work), /blue-green needs a reverse proxy/);
  const single = clean(orchDecl(orch.url, { strategy: { type: "rolling", proxy: "nginx" } } as any));
  await assert.rejects(() => cloud.plan(CONN, single, undefined, work), /at least 2 instances/);
  // rolling with two instances under load
  const roll = (v: string) => orchDecl(orch.url, { name: "shop-rolling", strategy: { type: "rolling", proxy: "nginx", drainSeconds: 1, rollback: true }, proxy: { nginx: { domains: ["rolling.test"], listen: { http: 8080 } } }, service: { ...(orchDecl(orch.url).service as any), instances: 2, secrets: undefined } } as any);
  publish("orch", "roll1"); await deploy(roll("roll1"));
  const load = new Load(T.httpPort, "rolling.test"); load.start(3); await new Promise((r) => setTimeout(r, 500));
  publish("orch", "roll2"); await deploy(roll("roll2"));
  await new Promise((r) => setTimeout(r, 500)); await load.stop();
  const s = load.summary(); assert.equal(s.failed, 0, JSON.stringify(s.errors)); assert.ok(s.versions.includes("roll1") && s.versions.includes("roll2"), JSON.stringify(s.versions));
  evidence["rolling"] = { ...s, instances: 2 };
});

test("the agent's own operations: no shell, unknown operations, replay", { skip }, async () => {
  await assert.rejects(() => call("exec", { cmd: "id" }), (e: any) => e.code === "UNKNOWN_OPERATION");
  await assert.rejects(() => call("shell", { cmd: "id" }), (e: any) => e.code === "UNKNOWN_OPERATION");
  await assert.rejects(() => call("service.restart", { app: "shop-orchestrator", service: "web; id" }), (e: any) => /NOT_FOUND|not have/.test(`${e.code} ${e.message}`));
  const r = await call<any>("service.restart", { app: "shop-orchestrator", service: "web" }); assert.equal(r.action, "restart");
  assert.equal((await get(T.httpPort, "shop.test")).status, 200);
});

test("SSH variants over real SSH: password (askpass), passphrase-protected key, bastion with the same strict checks", { skip }, async () => {
  const { spawnSync } = await import("node:child_process"); const { appendFileSync, readFileSync: rd } = await import("node:fs");
  const ed = cloud.hostKeys("127.0.0.1", T.sshPort).find((k) => k.type === "ed25519")!;
  // 1) password authentication, as an explicitly configured alternative: the password reaches ssh through the askpass helper, not argv
  cloud.add({ name: "pw", host: "127.0.0.1", port: T.sshPort, user: "pwuser", auth: "password", password: "Pw-Test-12345" }, ed.fingerprint);
  const pw = await cloud.test("pw"); assert.equal(pw.steps.find((s) => s.step === "ssh")!.ok, true, JSON.stringify(pw.steps)); assert.match(pw.steps.find((s) => s.step === "ssh")!.detail, /connected as pwuser/);
  assert.equal(pw.steps[1]!.step, "agent"); assert.equal(pw.steps[1]!.ok, false, "the agent is not installed for that user, and the test says which layer failed");
  cloud.add({ name: "pwbad", host: "127.0.0.1", port: T.sshPort, user: "pwuser", auth: "password", password: "not-the-password" }, ed.fingerprint);
  const bad = await cloud.test("pwbad"); assert.equal(bad.ok, false); assert.equal(bad.steps.find((s) => s.step === "ssh")!.ok, false); assert.ok(!JSON.stringify(bad).includes("not-the-password"));
  assert.ok(!readFileSync(join(cloud.store.home, "connections.json"), "utf8").includes("Pw-Test-12345"), "the password is not in the connection registry");
  // 2) a passphrase-protected private key: the passphrase is stored in the credential store and supplied through askpass
  const pk = join(T.dir, "id_pass"); spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "key-pass-phrase-77", "-f", pk, "-C", "pass"], { windowsHide: true });
  T.sh(`echo '${rd(`${pk}.pub`, "utf8").trim()}' >> /home/pso/.ssh/authorized_keys`);
  cloud.add({ name: "pp", host: "127.0.0.1", port: T.sshPort, user: "pso", auth: "key", keyPath: pk, passphrase: "key-pass-phrase-77" }, ed.fingerprint);
  const pp = await cloud.test("pp"); assert.equal(pp.steps.find((s) => s.step === "ssh")!.ok, true, JSON.stringify(pp.steps));
  // 3) a bastion: the container is its own jump host. BOTH hops must be verified against PSO's pinned host keys.
  const kh = cloud.store.knownHostsFile; const line = rd(kh, "utf8").split("\n").find((l) => l.startsWith(`[127.0.0.1]:${T.sshPort} ssh-ed25519`))!.split(" ").slice(1).join(" ");
  appendFileSync(kh, `127.0.0.1 ${line}\n`); // the inner hop connects to 127.0.0.1:22 as seen from the bastion
  cloud.store.saveConnection({ ...cloud.get(CONN), name: "jump", host: "127.0.0.1", port: 22, jump: { host: "127.0.0.1", port: T.sshPort, user: "pso" } });
  const j = await cloud.test("jump"); assert.equal(j.steps.find((s) => s.step === "ssh")!.ok, true, JSON.stringify(j.steps));
  const original = rd(kh, "utf8"); const other = rd(`${T.keyFile}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  const { writeFileSync: wf } = await import("node:fs");
  wf(kh, original.split("\n").filter((l) => !l.startsWith(`[127.0.0.1]:${T.sshPort} `)).concat(`[127.0.0.1]:${T.sshPort} ${other}`).join("\n") + "\n");
  const tampered = await cloud.test("jump"); assert.equal(tampered.steps.find((s) => s.step === "ssh")!.ok, false, "a changed bastion host key stops the connection before the target is reached");
  wf(kh, original);
  evidence["sshVariants"] = { passwordViaAskpass: true, wrongPasswordRefused: true, passphraseKey: true, bastionStrictOnBothHops: true, changedBastionKeyRefused: true };
});

test("evidence file", { skip }, async () => {
  const { writeFileSync: w, mkdirSync: mk } = await import("node:fs");
  const dir = join(import.meta.dirname, "..", "..", "..", "docs", "implementation", "evidence", "clo"); mk(dir, { recursive: true });
  w(join(dir, "e2e-linux-evidence.json"), JSON.stringify(evidence, null, 2));
  assert.ok(Object.keys(evidence).length > 10);
});
void AgentClient;
