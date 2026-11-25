import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { canonical, sha256 } from "../crypto.ts";
import { looksSecret, redactText, redactValue } from "../redact.ts";
import { servicesOf, validateDeployment, type DeploymentDecl, type PipelineDecl, type ServiceDecl } from "../declare.ts";
import { ProtocolError } from "../protocol.ts";
import { fetchCommit, resolveSource, type GitContext } from "./git.ts";
import { inspect } from "./inspect.ts";
import { applyProxy, attachDirFor, webServerCannotRead, renderStaticFragment, defaultDiscoveryDirs, discoverVhosts, findConflicts, listBackups, planProxyChange, renderConfig, renderStaticConfig, restoreProxy, targetFor, type NginxTarget, type RouteInstance, type StaticVhostInput } from "./nginx.ts";
import { buildPlan, newReleaseId, type Plan, type StageStatus } from "./plan.ts";
import { treeDigest, verifySigned, type Provenance, type SignedManifest } from "../signing.ts";
import { SEVERITY_RANK, scanJava, type ScanReport, type Severity } from "./javascan.ts";
import { discoverNginx, parseNginx, type NginxServer } from "./visibility.ts";
import { owned as ownedUnit, unitDetails, removeUnit, setBootPersistence, unitNameFor, unitState, journalTail } from "./systemd.ts";
import { probe, PortAllocator, portFree, httpGet, identityMatches, newToken, startSlot, stopSlot, tailLog, waitReady, type SlotState } from "./runtime.ts";
import { AgentState, AuditLog, DirLock, P, ensureDir, isDir, nowIso, pidAlive, readJson, writeJson, type AuditActor, type Policy } from "./state.ts";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { activateFei, activePointer, checkMei, feiHistory, history as meiHistory, publishMei, pruneFei, pruneMei, readFeiDist, recoverSite, writeRuntimeConfig, repairFeiHistory, repairMeiHistory, rollbackMei, stageFei, versions as meiVersions } from "@pso/frontend/release";
import { parseManifest } from "@pso/frontend";

/**
 * The deployment engine: plans, executes and recovers deployments on the target, and is the ONLY implementation of deployment logic.
 * The CLI and Studio reach it through the agent protocol; neither contains deployment rules of its own.
 *
 * Execution happens in a detached worker process whose state lives in files (deployments/<id>.json), so closing the SSH session,
 * the Studio or the laptop never leaves a deployment half-known: reconnecting shows the real state, and `recover` reconciles an
 * interrupted one by inspecting what actually exists instead of replaying steps.
 */
export type DeployState = "REQUESTED" | "PLANNING" | "VALIDATING" | "PREPARING" | "BUILDING" | "STARTING_CANDIDATE" | "VERIFYING_CANDIDATE" | "SWITCHING_TRAFFIC" | "VERIFYING_ACTIVE_RELEASE" | "DRAINING_PREVIOUS_RELEASE"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "RECOVERING" | "ROLLED_BACK";
const TERMINAL: DeployState[] = ["COMPLETED", "FAILED", "CANCELLED", "ROLLED_BACK"];
export const isTerminal = (s: DeployState): boolean => TERMINAL.includes(s);

export interface StageRun { id: string; type: string; status: StageStatus; startedAt?: string; finishedAt?: string; detail?: string; data?: unknown }
export interface Deployment {
  id: string; app: string; kind: "deploy" | "rollback"; planHash: string; releaseId: string; previousRelease: string | null; strategy: string;
  state: DeployState; requestedBy: AuditActor; startedAt: string; updatedAt: string; finishedAt?: string; workerPid?: number;
  checkpoints: Array<{ state: DeployState; at: string; detail?: string }>; stages: StageRun[]; error?: string; cancelRequested?: boolean;
  proxyBackupId?: string; trafficSwitched?: boolean; candidateSlots: string[]; availability?: { requests: number; failures: number }; outcome?: string; recovered?: boolean;
}
export interface AppState { name: string; lastSignedSequence?: number; active?: { release: string; since: string; slots: string[] }; previous?: string; lastKnownGood?: string; releases: string[]; stablePorts: Record<string, number>; nginxFile?: string }
interface PlanFile { plan: Plan; decl: DeploymentDecl; pipeline: PipelineDecl | undefined; proposer: AuditActor; approvals: Array<{ clientId: string; name: string; at: string }>; artifact?: { uploadId: string; sha256: string; size: number }; signed?: SignedManifest }
interface Manifest { endpoints?: unknown; releaseId: string; app: string; createdAt: string; kind: "git" | "artifact"; source: Plan["source"]; treeHash: string; declarationHash: string; planHash: string; decl: DeploymentDecl; pipeline: PipelineDecl | undefined; signed?: SignedManifest; provenance?: Provenance }

class Cancelled extends Error {}
class Failed extends Error { readonly code: string; constructor(msg: string, code = "FAILED") { super(msg); this.code = code; } }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ENV_SAFE = ["PATH", "HOME", "LANG", "TZ", "JAVA_HOME", "USER"];

function satisfies(version: string, range: string): boolean {
  const v = version.split(".").map((x) => parseInt(x, 10)); const m = /^(>=|\^|~)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range.trim());
  if (!m) return false;
  const [, op, a, b, c] = m; const want = [Number(a), b === undefined ? 0 : Number(b), c === undefined ? 0 : Number(c)];
  const cmp = (): number => { for (let i = 0; i < 3; i++) { const d = (v[i] ?? 0) - want[i]!; if (d !== 0) return d; } return 0; };
  if (op === ">=") return cmp() >= 0;
  if (op === "^" || op === undefined) return v[0] === want[0] && (op === "^" ? cmp() >= 0 : true);
  return v[0] === want[0] && v[1] === want[1] && cmp() >= 0;
}

export class Engine {
  readonly policy: Policy; readonly state: AgentState; readonly audit: AuditLog;
  constructor(state: AgentState, audit: AuditLog) { this.state = state; this.audit = audit; this.policy = state.policy(); }

  // ---------------------------------------------------------------- paths and persistence
  appDir(app: string): string { return P.app(app, this.state.home); }
  private assertApp(app: unknown): string { if (typeof app !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(app)) throw new ProtocolError("BAD_REQUEST", "invalid application name"); return app; }
  appState(app: string): AppState { return readJson<AppState>(join(this.appDir(app), "app.json"), { name: app, releases: [], stablePorts: {} }); }
  private saveApp(a: AppState): void { writeJson(join(this.appDir(a.name), "app.json"), a); }
  private depFile(app: string, id: string): string { return join(this.appDir(app), "deployments", `${id}.json`); }
  deployment(app: string, id: string): Deployment | undefined { return /^d[0-9a-z]{6,20}$/.test(id) ? readJson<Deployment | undefined>(this.depFile(app, id), undefined) : undefined; }
  private saveDep(d: Deployment): void { d.updatedAt = nowIso(); writeJson(this.depFile(d.app, d.id), d); }
  private logFile(app: string, id: string): string { return join(this.appDir(app), "logs", `${id}.log`); }
  private releaseDir(app: string, rid: string): string { return join(this.appDir(app), "releases", rid); }
  private slotDir(app: string, rid: string): string { return join(this.appDir(app), "slots", rid); }
  private lock(app: string): DirLock { return new DirLock(join(this.appDir(app), "lock")); }
  private sharedLock(name: string): DirLock { return new DirLock(join(P.state(this.state.home), "locks", name)); }
  private ports(range?: { from: number; to: number }): PortAllocator { return new PortAllocator(this.state.file("ports.json"), range ?? { from: 20000, to: 20999 }); }
  private secret(name: string): string | undefined { if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name)) return undefined; try { return readFileSync(join(P.secrets(this.state.home), name), "utf8"); } catch { return undefined; } }
  private gitCtx(): GitContext { return { home: this.state.home, secret: (n) => this.secret(n) }; }

  private log(d: Deployment, level: "info" | "warn" | "error", msg: string): void {
    const f = this.logFile(d.app, d.id); ensureDir(dirname(f));
    try { if (existsSync(f) && statSync(f).size > 5 * 1024 * 1024) return; appendFileSync(f, `${nowIso()} ${level.toUpperCase().padEnd(5)} ${redactText(msg)}\n`, { mode: 0o600 }); } catch { /* logging never fails a deployment */ }
  }
  private setState(d: Deployment, s: DeployState, detail?: string): void {
    d.state = s; d.checkpoints.push({ state: s, at: nowIso(), ...(detail ? { detail } : {}) }); this.saveDep(d);
    this.log(d, "info", `state ${s}${detail ? `: ${detail}` : ""}`);
    this.audit.append(`deploy.state.${s.toLowerCase()}`, "info", d.requestedBy, { environment: this.state.env().id, deployment: d.id, release: d.releaseId, app: d.app }, detail ? { detail } : {});
  }
  private stage(d: Deployment, id: string, type: string, status: StageStatus, detail?: string, data?: unknown): void {
    let s = d.stages.find((x) => x.id === id);
    if (!s) { s = { id, type, status }; d.stages.push(s); }
    s.status = status; if (status === "running") s.startedAt = nowIso(); if (["passed", "failed", "skipped", "disabled", "unavailable", "blocked", "cancelled"].includes(status)) s.finishedAt = nowIso();
    if (detail !== undefined) s.detail = redactText(detail); if (data !== undefined) s.data = data; this.saveDep(d);
  }
  private checkCancel(d: Deployment, beforeSwitch = true): void {
    const cur = this.deployment(d.app, d.id);
    if (cur?.cancelRequested && beforeSwitch && !d.trafficSwitched) throw new Cancelled();
  }

  // ---------------------------------------------------------------- planning
  /** Inspects the server, resolves the requested source to an immutable commit (or accepts an uploaded artifact) and produces the plan. */
  propose(declRaw: unknown, pipeline: PipelineDecl | undefined, actor: AuditActor, artifact?: { uploadId: string; sha256: string; size: number }, signed?: SignedManifest): Plan {
    const diag = validateDeployment(declRaw);
    const errs = diag.filter((x) => x.level === "error");
    if (errs.length) throw new ProtocolError("BAD_REQUEST", `invalid deployment declaration:\n${errs.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
    const decl = declRaw as DeploymentDecl;
    const app = this.assertApp(decl.name);
    const insp = inspect(this.state);
    let source: Plan["source"];
    if (decl.source.provider === "git") {
      const r = resolveSource(decl.source, this.gitCtx());
      source = { provider: "git", url: decl.source.url, ref: r.ref, refType: r.refType, commit: r.commit };
    } else {
      if (!artifact) throw new ProtocolError("PRECONDITION", "an artifact source must be uploaded first (artifact.begin/chunk/commit)");
      if (decl.source.sha256 && decl.source.sha256 !== artifact.sha256) throw new ProtocolError("PRECONDITION", "the uploaded artifact's checksum differs from source.sha256 in the declaration");
      source = { provider: "artifact", sha256: artifact.sha256, size: artifact.size };
    }
    const as = this.appState(app);
    const provenance = verifySigned(signed, this.state.trust(), { app, source: source.provider === "git" ? { kind: "git", commit: source.commit } : { kind: "artifact", sha256: source.sha256 } });
    const lock = this.lock(app);
    const nginx = decl.proxy?.nginx; const wantsNginx = decl.strategy.proxy === "nginx";
    let target: NginxTarget | undefined; let action: string | undefined; let conflicts: string[] = [];
    if (wantsNginx) {
      try { target = targetFor(this.policy, app, nginx?.attachTo ? attachDirFor(this.policy, nginx.attachTo) : nginx?.layout); } catch (e) { throw new ProtocolError("BAD_REQUEST", (e as Error).message); }
      const sample = decl.strategy.type === "static" ? (nginx?.attachTo ? renderStaticFragment : renderStaticConfig)(staticVhost(app, "plan", decl, this.siteRoot("plan"))) : renderConfig({ app, release: "plan", services: servicesOf(decl).map((s) => ({ service: s.name, ports: [1], stablePort: 1, ...(s.route ? { route: { path: s.route.path ?? "/" } } : {}) })), nginx });
      action = planProxyChange(target, app, sample).action;
      if (decl.strategy.type === "static") { const sd0 = servicesOf(decl)[0]?.static; const bad = sd0 && decl.strategy.proxy === "nginx" ? webServerCannotRead(this.siteRoot(sd0.site)) : undefined; if (bad) conflicts.push(`${bad}. The administrator can create a directory the web server reads and set it with: pso environment:policy <application> --set staticRoot=/srv/pso-sites`); }
      const http = nginx?.listen?.http ?? 80;
      conflicts = findConflicts({ serverNames: nginx?.domains ?? [], listenPorts: nginx?.attachTo ? [] : [String(http), ...(nginx?.listen?.https ? [String(nginx.listen.https)] : [])] }, discoverVhosts(defaultDiscoveryDirs(this.policy)), app).filter((c) => !c.includes("(managed by PSO for app"));
      if (action === "conflict") conflicts.push(`${target.file} exists and is not managed by PSO`);
    }
    const plan = buildPlan({
      provenance, lastSignedSequence: as.lastSignedSequence ?? 0, decl, pipeline, policy: this.policy, inspection: insp, environmentId: this.state.env().id, currentRelease: as.active?.release ?? null, source,
      declaredEnvironmentOfServer: this.state.env().label, hasPreviousRelease: !!as.previous || !!as.active, releaseId: newReleaseId(source),
      nginxConflicts: conflicts, nginxTarget: target?.file, nginxAction: action === "conflict" ? undefined : action, lockHeld: lock.status() !== "free",
    });
    const pf: PlanFile = { plan, decl, pipeline, proposer: actor, approvals: [], ...(artifact ? { artifact } : {}), ...(signed ? { signed } : {}) };
    writeJson(join(this.appDir(app), "plans", `${plan.hash}.json`), pf);
    this.audit.append("deploy.proposed", plan.blockers.length ? "denied" : "ok", actor, { environment: plan.environmentId, app, release: plan.candidateRelease }, { planHash: plan.hash, strategy: plan.strategy.type, blockers: plan.blockers.length, commit: plan.source.provider === "git" ? plan.source.commit : undefined });
    return plan;
  }

  /** where a static site lives: the policy's staticRoot, or the agent's own sites directory */
  private siteRoot(name: string): string { return this.policy.staticRoot ? posix.join(this.policy.staticRoot, name) : P.site(name, this.state.home); }

  private planFile(app: string, hash: unknown): PlanFile {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new ProtocolError("BAD_REQUEST", "invalid plan hash");
    const pf = readJson<PlanFile | undefined>(join(this.appDir(app), "plans", `${hash}.json`), undefined);
    if (!pf) throw new ProtocolError("NOT_FOUND", "unknown plan: propose it again");
    return pf;
  }

  approve(app: string, hash: unknown, actor: AuditActor & { clientId: string }): { approvals: number; required: number } {
    this.assertApp(app);
    const pf = this.planFile(app, hash);
    if (pf.plan.blockers.length) throw new ProtocolError("POLICY", "this plan has blockers and cannot be approved");
    if (!this.policy.selfApproval && pf.proposer.clientId === actor.clientId) throw new ProtocolError("POLICY", "the server policy requires an approver other than the person who proposed the plan");
    if (!pf.approvals.some((a) => a.clientId === actor.clientId)) pf.approvals.push({ clientId: actor.clientId, name: actor.name ?? "", at: nowIso() });
    writeJson(join(this.appDir(app), "plans", `${pf.plan.hash}.json`), pf);
    this.audit.append("deploy.approved", "ok", actor, { environment: pf.plan.environmentId, app, release: pf.plan.candidateRelease }, { planHash: pf.plan.hash });
    return { approvals: pf.approvals.length, required: this.policy.approvalsRequired };
  }

  plans(app: string): Array<{ hash: string; release: string; createdAt: string; approvals: number; blockers: number; strategy: string }> {
    const dir = join(this.appDir(this.assertApp(app)), "plans");
    return (existsSync(dir) ? readdirSync(dir) : []).map((f) => readJson<PlanFile | undefined>(join(dir, f), undefined)).filter((x): x is PlanFile => !!x).sort((a, b) => b.plan.createdAt.localeCompare(a.plan.createdAt)).slice(0, 20)
      .map((p) => ({ hash: p.plan.hash, release: p.plan.candidateRelease, createdAt: p.plan.createdAt, approvals: p.approvals.length, blockers: p.plan.blockers.length, strategy: p.plan.strategy.type }));
  }

  // ---------------------------------------------------------------- start (revalidates the approved plan, then hands over to a detached worker)
  start(app: string, hash: unknown, actor: AuditActor, spawnWorker: (app: string, id: string) => { pid: number | undefined }): Deployment {
    this.assertApp(app);
    const pf = this.planFile(app, hash); const plan = pf.plan;
    const fail = (code: ConstructorParameters<typeof ProtocolError>[0], m: string): never => { this.audit.append("deploy.refused", "denied", actor, { environment: plan.environmentId, app, release: plan.candidateRelease }, { reason: m, planHash: plan.hash }); throw new ProtocolError(code, m); };
    if (plan.blockers.length) return fail("POLICY", `the plan has blockers: ${plan.blockers.join("; ")}`);
    if (plan.environmentId !== this.state.env().id) return fail("PLAN_STALE", "the plan was made for another environment");
    if (plan.policyHash !== sha256(canonical(this.state.policy()))) return fail("PLAN_STALE", "the server policy changed after the plan was made: propose it again");
    if (Date.now() - Date.parse(plan.createdAt) > this.policy.maxPlanAgeMinutes * 60_000) return fail("PLAN_STALE", `the plan is older than ${this.policy.maxPlanAgeMinutes} minutes: propose it again`);
    // the trust store and the policy may have changed since the plan was made: authenticity is decided again, now, by the server
    {
      const again = verifySigned(pf.signed, this.state.trust(), { app, source: plan.source.provider === "git" ? { kind: "git", commit: plan.source.commit } : { kind: "artifact", sha256: plan.source.sha256 } });
      if (this.policy.requireSignedReleases && again.authenticity !== "verified") return fail("POLICY", `this environment requires a release signed by a trusted signer; at start time: ${again.authenticity}${again.reasons[0] ? ` (${again.reasons[0]})` : ""}`);
      if (pf.signed && again.authenticity !== plan.provenance.authenticity) return fail("PLAN_STALE", `the trust status of the signature changed since the plan was made (${plan.provenance.authenticity} -> ${again.authenticity}): propose it again`);
    }
    const cur = this.appState(app).active?.release ?? null;
    if (cur !== plan.currentRelease) return fail("PLAN_STALE", `the active release changed (plan assumed ${plan.currentRelease ?? "none"}, now ${cur ?? "none"}): propose it again`);
    const needs = Math.max(this.policy.approvalsRequired, plan.stages.some((s) => s.enabled && s.requiresApproval) ? 1 : 0);
    const valid = pf.approvals.filter((a) => Date.now() - Date.parse(a.at) < this.policy.approvalTtlMinutes * 60_000 && (this.policy.selfApproval || a.clientId !== pf.proposer.clientId));
    if (valid.length < needs) return fail("POLICY", `the plan needs ${needs} approval(s), has ${valid.length}${pf.approvals.length > valid.length ? " valid (older approvals expired)" : ""}`);
    if (plan.source.provider === "git" && pf.decl.source.provider === "git") {
      const now = resolveSource(pf.decl.source, this.gitCtx());
      if (now.commit !== plan.source.commit) return fail("PLAN_STALE", `${now.refType} "${now.ref}" now points to ${now.commit.slice(0, 12)}, but the approved plan is for ${plan.source.commit.slice(0, 12)}: the latest commit is never deployed implicitly; propose it again`);
    }
    const id = `d${Date.now().toString(36)}${newToken().slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const d: Deployment = { id, app, kind: "deploy", planHash: plan.hash, releaseId: plan.candidateRelease, previousRelease: cur, strategy: plan.strategy.type, state: "REQUESTED", requestedBy: actor, startedAt: nowIso(), updatedAt: nowIso(), checkpoints: [{ state: "REQUESTED", at: nowIso() }], stages: [], candidateSlots: [] };
    this.saveDep(d);
    return this.launch(d, spawnWorker);
  }

  private launch(d: Deployment, spawnWorker: (app: string, id: string) => { pid: number | undefined }): Deployment {
    const w = spawnWorker(d.app, d.id);
    const ok = w.pid !== undefined && this.lock(d.app).tryAcquire({ id: d.id, purpose: `${d.kind} ${d.releaseId}`, pid: w.pid, ...(d.requestedBy.name ? { actor: d.requestedBy.name } : {}) });
    if (!ok) {
      if (w.pid) { try { process.kill(w.pid, "SIGKILL"); } catch { /* gone */ } }
      d.state = "FAILED"; d.error = "another deployment holds the lock"; d.finishedAt = nowIso(); d.outcome = "refused"; this.saveDep(d);
      throw new ProtocolError("LOCKED", `another deployment of "${d.app}" is running or interrupted (lock held by ${this.lock(d.app).read()?.id ?? "unknown"}); check release:status, or recover it`);
    }
    d.workerPid = w.pid; this.saveDep(d);
    this.audit.append(`${d.kind}.requested`, "ok", d.requestedBy, { environment: this.state.env().id, app: d.app, release: d.releaseId, deployment: d.id }, { strategy: d.strategy, previous: d.previousRelease });
    return d;
  }

  rollback(app: string, actor: AuditActor, to: unknown, spawnWorker: (app: string, id: string) => { pid: number | undefined }): Deployment {
    this.assertApp(app);
    const as = this.appState(app);
    const target = typeof to === "string" ? to : as.previous;
    if (!target || !as.releases.includes(target)) throw new ProtocolError("PRECONDITION", "no earlier release is kept to roll back to");
    if (target === as.active?.release) throw new ProtocolError("PRECONDITION", "that release is already active");
    const m = readJson<Manifest | undefined>(join(this.releaseDir(app, target), "manifest.json"), undefined);
    if (!m) throw new ProtocolError("PRECONDITION", "the release manifest is missing or unreadable");
    if (m.decl.strategy.rollback === false) throw new ProtocolError("POLICY", "rollback is disabled for this deployment (strategy.rollback: false)");
    if (this.policy.requireSignedReleases) {
      const v = verifySigned(m.signed, this.state.trust(), { app, source: m.source.provider === "git" ? { kind: "git", commit: m.source.commit } : { kind: "artifact", sha256: m.source.sha256 } });
      if (v.authenticity !== "verified") throw new ProtocolError("POLICY", `this environment requires signed releases and ${target} no longer qualifies (${v.authenticity}${v.reasons[0] ? `: ${v.reasons[0]}` : ""}); roll back to a release signed by a currently trusted signer, or deploy a new signed release`);
    }
    const id = `d${Date.now().toString(36)}${newToken().slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const d: Deployment = { id, app, kind: "rollback", planHash: m.planHash, releaseId: target, previousRelease: as.active?.release ?? null, strategy: m.decl.strategy.type === "recreate" ? "recreate" : m.decl.strategy.type, state: "REQUESTED", requestedBy: actor, startedAt: nowIso(), updatedAt: nowIso(), checkpoints: [{ state: "REQUESTED", at: nowIso() }], stages: [], candidateSlots: [] };
    this.saveDep(d);
    return this.launch(d, spawnWorker);
  }

  cancel(app: string, id: unknown, actor: AuditActor): { cancelRequested: boolean; note: string } {
    this.assertApp(app);
    const d = typeof id === "string" ? this.deployment(app, id) : undefined; if (!d) throw new ProtocolError("NOT_FOUND", "unknown deployment");
    if (isTerminal(d.state)) throw new ProtocolError("CONFLICT", `the deployment already ended (${d.state})`);
    if (d.trafficSwitched) throw new ProtocolError("CONFLICT", "traffic has already moved to the candidate: cancelling now would leave a mixed state. Use rollback after it completes");
    d.cancelRequested = true; this.saveDep(d);
    this.audit.append("deploy.cancel-requested", "ok", actor, { environment: this.state.env().id, app, deployment: d.id, release: d.releaseId });
    return { cancelRequested: true, note: "the worker stops at the next safe point and cleans up the candidate; the active release is untouched" };
  }

  // ---------------------------------------------------------------- queries
  effective(d: Deployment): Deployment & { effectiveState: string; workerAlive: boolean } {
    const alive = !!d.workerPid && pidAlive(d.workerPid);
    const interrupted = !isTerminal(d.state) && d.state !== "INTERRUPTED" && !alive && !!d.workerPid;
    return { ...d, effectiveState: interrupted ? "INTERRUPTED" : d.state, workerAlive: alive };
  }
  status(app: string, id?: unknown): unknown {
    this.assertApp(app);
    const as = this.appState(app);
    const list = this.history(app, 1);
    const d = typeof id === "string" ? this.deployment(app, id) : list[0];
    const lock = this.lock(app);
    return { app, active: as.active ?? null, previous: as.previous ?? null, lastKnownGood: as.lastKnownGood ?? null, releases: as.releases, lock: { status: lock.status(), owner: lock.read() ?? null }, deployment: d ? this.effective(d) : null, services: this.serviceStatus(app) };
  }
  history(app: string, limit = 30): Deployment[] {
    const dir = join(this.appDir(this.assertApp(app)), "deployments");
    return (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json")).map((f) => readJson<Deployment | undefined>(join(dir, f), undefined)).filter((x): x is Deployment => !!x).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }
  releases(app: string): unknown[] {
    const as = this.appState(this.assertApp(app));
    return as.releases.map((r) => { const m = readJson<Manifest | undefined>(join(this.releaseDir(app, r), "manifest.json"), undefined); return { id: r, active: as.active?.release === r, previous: as.previous === r, lastKnownGood: as.lastKnownGood === r, createdAt: m?.createdAt, source: m?.source, planHash: m?.planHash }; });
  }
  logs(app: string, opts: { deployment?: unknown; service?: unknown; bytes?: unknown }): { source: string; text: string } {
    this.assertApp(app);
    const bytes = Math.min(Math.max(Number(opts.bytes ?? 16000), 1000), 200_000);
    if (typeof opts.deployment === "string") { if (!/^d[0-9a-z]{6,20}$/.test(opts.deployment)) throw new ProtocolError("BAD_REQUEST", "invalid deployment id"); return { source: `deployment ${opts.deployment}`, text: tailLog(this.logFile(app, opts.deployment), bytes) }; }
    if (typeof opts.service === "string") {
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(opts.service)) throw new ProtocolError("BAD_REQUEST", "invalid service name");
      const as = this.appState(app); const rid = as.active?.release; if (!rid) return { source: `service ${opts.service}`, text: "" };
      const f = readdirSync(this.slotDir(app, rid)).filter((x) => x.startsWith(`${opts.service}-`) && x.endsWith(".json")).sort()[0];
      const slot = f ? readJson<SlotState | undefined>(join(this.slotDir(app, rid), f), undefined) : undefined;
      if (slot?.supervisor === "systemd") { const j = journalTail(unitNameFor(slot), Math.round(bytes / 80)); if (j.ok) return { source: `systemd journal of ${unitNameFor(slot)}; sanitized by pattern only`, text: j.text }; return { source: `application log file of ${opts.service} (${rid}); the journal was not readable: ${j.reason}`, text: tailLog(slot.logFile, bytes) }; }
      return { source: `application log of ${opts.service} (${rid}); written by the application, sanitized by pattern only`, text: slot ? tailLog(slot.logFile, bytes) : "" };
    }
    const last = this.history(app, 1)[0]; return last ? { source: `deployment ${last.id}`, text: tailLog(this.logFile(app, last.id), bytes) } : { source: "none", text: "" };
  }

  // ---------------------------------------------------------------- slots / services
  private slots(app: string, rid: string): SlotState[] {
    const dir = this.slotDir(app, rid);
    return (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json")).map((f) => readJson<SlotState | undefined>(join(dir, f), undefined)).filter((x): x is SlotState => !!x);
  }
  private saveSlot(s: SlotState): void { writeJson(join(this.slotDir(s.app, s.release), `${s.service}-${s.instance}.json`), s); }
  serviceStatus(app: string): unknown[] {
    const as = this.appState(app); if (!as.active) return [];
    const man = readJson<Manifest | undefined>(join(this.releaseDir(app, as.active.release), "manifest.json"), undefined);
    if (man?.decl.strategy.type === "static") {
      // a static resource has no process: report what is published and whether the site agrees with the engine's record
      const sv = servicesOf(man.decl)[0]!; const sd = sv.static!; const site = this.siteRoot(sd.site);
      const dist = join(this.serviceDir(app, as.active.release, sv), sd.publish && sd.publish !== "." ? sd.publish : "");
      let version: string | undefined; let consistent = false;
      try {
        if (sd.kind === "mei") { const m = parseManifest(readJson<unknown>(join(dist, "pso-manifest.json"), undefined)).manifest; if (m) { version = m.version; consistent = activePointer(site, m.name)?.version === m.version && checkMei(site, m.name).length === 0; } }
        else { const f = readFeiDist(dist); version = f.version; consistent = readJson<{ version: string } | undefined>(join(site, "fei", "current.json"), undefined)?.version === f.version; }
      } catch { /* the release files are gone: reported as inconsistent */ }
      return [{ service: sv.name, instance: 0, release: as.active.release, static: true, kind: sd.kind, site: sd.site, version: version ?? null, running: consistent, port: null, pid: null }];
    }
    return this.slots(app, as.active.release).map((s) => ({ service: s.service, instance: s.instance, release: s.release, slot: s.slot, port: s.port, pid: s.pid ?? null, running: identityMatches(s).match, identity: identityMatches(s).reason, startedAt: s.startedAt, stablePort: as.stablePorts[s.service] ?? null }));
  }

  /** Restarts, stops or starts the active slots of ONE service (the others are untouched). Not allowed while a deployment holds the lock. */
  async serviceAction(app: string, service: unknown, action: "restart" | "start" | "stop", actor: AuditActor): Promise<unknown> {
    this.assertApp(app);
    if (typeof service !== "string") throw new ProtocolError("BAD_REQUEST", "service name required");
    const lock = this.lock(app); if (lock.status() !== "free") throw new ProtocolError("LOCKED", "a deployment is in progress or interrupted for this application: service operations wait for it");
    const owner = `svc-${newToken().slice(0, 6)}`;
    if (!lock.tryAcquire({ id: owner, purpose: `service ${action} ${service}`, pid: process.pid })) throw new ProtocolError("LOCKED", "application is locked");
    try {
      const as = this.appState(app); if (!as.active) throw new ProtocolError("PRECONDITION", "no active release");
      const slots = this.slots(app, as.active.release).filter((s) => s.service === service);
      if (!slots.length) throw new ProtocolError("NOT_FOUND", `service "${service}" has no slots in the active release`);
      const m = readJson<Manifest | undefined>(join(this.releaseDir(app, as.active.release), "manifest.json"), undefined);
      const out: unknown[] = [];
      for (const s of slots) {
        if (action !== "start") { const r = await stopSlot(s); out.push({ instance: s.instance, stop: r }); if (!r.stopped) throw new ProtocolError("FAILED", `could not stop ${service}: ${r.detail}`); s.status = "stopped"; s.stoppedAt = nowIso(); this.saveSlot(s); }
        if (action !== "stop") {
          if (identityMatches(s).match) { out.push({ instance: s.instance, start: "already running" }); continue; }
          const sv = servicesOf(m!.decl).find((x) => x.name === service)!;
          const fresh = startSlot({ ...s, token: newToken() }, this.serviceEnv(m!.decl, as, sv, s.port));
          this.saveSlot(fresh);
          const h = sv.health ?? {};
          const ready = await waitReady({ port: s.port, path: h.readyPath ?? h.path ?? "/health/ready", expectStatus: h.expectStatus ?? 200, timeoutSeconds: h.timeoutSeconds ?? 60, intervalSeconds: h.intervalSeconds ?? 1, consecutive: h.consecutive ?? 2, alive: () => identityMatches(fresh).match });
          out.push({ instance: s.instance, start: ready.ok ? "ready" : "NOT READY", ready });
          if (!ready.ok) throw new ProtocolError("FAILED", `${service} did not become ready after ${action}`);
        }
      }
      if (action !== "stop") this.syncBootPersistence(app); // stopping disabled boot persistence; starting again must restore it (an explicit stop stays stopped after a reboot)
      this.audit.append(`service.${action}`, "ok", actor, { environment: this.state.env().id, app }, { service });
      return { service, action, results: out };
    } finally { lock.release(owner); }
  }

  // ---------------------------------------------------------------- the worker
  private runArgv(d: Deployment, argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutSeconds: number }): Promise<{ code: number | null; timedOut: boolean }> {
    return new Promise((res) => {
      const env: Record<string, string> = {};
      for (const k of ENV_SAFE) if (process.env[k] !== undefined) env[k] = process.env[k]!;
      Object.assign(env, opts.env, { CI: "true" });
      let timedOut = false;
      const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
      const onData = (b: Buffer): void => { for (const line of b.toString("utf8").split("\n")) if (line.trim()) this.log(d, "info", `  | ${line.slice(0, 500)}`); };
      child.stdout.on("data", onData); child.stderr.on("data", onData);
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, opts.timeoutSeconds * 1000);
      child.on("error", (e) => { clearTimeout(timer); this.log(d, "error", `cannot run ${argv[0]}: ${(e as Error).message}`); res({ code: 127, timedOut: false }); });
      child.on("close", (code) => { clearTimeout(timer); res({ code, timedOut }); });
    });
  }

  private order(services: ServiceDecl[]): ServiceDecl[] {
    const out: ServiceDecl[] = []; const seen = new Set<string>();
    const visit = (s: ServiceDecl): void => { if (seen.has(s.name)) return; seen.add(s.name); for (const dep of s.dependsOn ?? []) { const x = services.find((y) => y.name === dep); if (x) visit(x); } out.push(s); };
    services.forEach(visit); return out;
  }
  private serviceDir(app: string, rid: string, sv: ServiceDecl): string {
    const root = resolve(this.releaseDir(app, rid), "src"); const dir = resolve(root, sv.dir ?? ".");
    if (dir !== root && !dir.startsWith(root + sep)) throw new Failed(`service ${sv.name}: dir escapes the release`);
    return dir;
  }
  private serviceEnv(decl: DeploymentDecl, as: AppState, sv: ServiceDecl, port: number, urls?: Record<string, string>): { env: Record<string, string>; secretEnv: Record<string, string> } {
    const proxy = decl.strategy.proxy === "nginx";
    const url = (name: string): string => urls?.[name] ?? (proxy && as.stablePorts[name] ? `http://127.0.0.1:${as.stablePorts[name]}` : `http://127.0.0.1:${servicesOf(decl).find((s) => s.name === name)?.port ?? 0}`);
    const env: Record<string, string> = {};
    for (const s of servicesOf(decl)) env[`PSO_SERVICE_${s.name.toUpperCase().replace(/-/g, "_")}_URL`] = url(s.name);
    for (const [k, v] of Object.entries(sv.env ?? {})) env[k] = v.replace(/\{service:([a-z][a-z0-9-]*)\.url\}/g, (_, n: string) => url(n)).replace(/\{port\}/g, String(port));
    env[sv.portEnv ?? "PORT"] = String(port); env["PSO_ENVIRONMENT"] = decl.environment; env["PSO_APP"] = decl.name;
    const secretEnv: Record<string, string> = {};
    for (const [k, name] of Object.entries(sv.secrets ?? {})) { const v = this.secret(name); if (v === undefined) throw new Failed(`secret "${name}" (for ${k}) is not set on this server`); secretEnv[k] = v.replace(/\r?\n$/, ""); }
    return { env, secretEnv };
  }

  /** Entry point of the detached worker process. */
  async work(app: string, id: string): Promise<void> {
    const d = this.deployment(app, id); if (!d) return;
    const lock = this.lock(app);
    const deadline = Date.now() + 10_000; while (lock.read()?.id !== id && Date.now() < deadline) await sleep(50);
    if (lock.read()?.id !== id) { d.state = "FAILED"; d.error = "lock was not granted to this deployment"; d.finishedAt = nowIso(); this.saveDep(d); return; }
    d.workerPid = process.pid; this.saveDep(d);
    const hb = setInterval(() => { lock.heartbeat(); const c = this.deployment(app, id); if (c) { c.updatedAt = nowIso(); writeJson(this.depFile(app, id), { ...c, workerPid: process.pid, ...(d.state !== c.state ? {} : {}) }); } }, 5000);
    try {
      if (d.kind === "rollback") await this.execute(d, undefined); else { const pf = this.planFile(app, d.planHash); await this.execute(d, pf); }
    } finally { clearInterval(hb); lock.release(id); }
  }

  private async execute(d: Deployment, pf: PlanFile | undefined): Promise<void> {
    const app = d.app; const rb = d.kind === "rollback";
    const manifest = rb ? readJson<Manifest>(join(this.releaseDir(app, d.releaseId), "manifest.json"), undefined as unknown as Manifest) : undefined;
    const decl = rb ? manifest!.decl : pf!.decl; const plan = pf?.plan;
    const pipelineDecl = rb ? manifest!.pipeline : pf!.pipeline;
    const services = this.order(servicesOf(decl));
    const rid = d.releaseId;
    const as = this.appState(app);
    const t = decl.strategy.type; const proxy = decl.strategy.proxy === "nginx";
    const range = decl.ports ?? { from: 20000, to: 20999 };
    const alloc = this.ports(range);
    const candidate: SlotState[] = []; let previousSlots: SlotState[] = [];
    const stageList = plan?.stages ?? [];
    const ignoreStages = rb;
    try {
      this.setState(d, "PLANNING", rb ? `rollback to ${rid}` : `plan ${plan!.hash.slice(0, 12)}, release ${rid}`);
      // ---- VALIDATING: mandatory checks first (they exist outside the pipeline)
      this.setState(d, "VALIDATING");
      const insp = inspect(this.state);
      if (decl.environment !== (this.state.env().label ?? decl.environment)) throw new Failed("environment mismatch");
      if (proxy && insp.nginx.configValid === false) throw new Failed("nginx -t fails on the current configuration; refusing to touch the proxy");
      for (const sv of services) for (const [, name] of Object.entries(sv.secrets ?? {})) if (this.secret(name) === undefined) throw new Failed(`secret "${name}" is not set on this server (service ${sv.name})`);
      const needMem = services.reduce((n, s) => n + (s.runtime === "static" ? 0 : (s.resources?.memoryMb ?? 512) * (s.instances ?? 1)), 0);
      if (insp.memory.availableMb < Math.min(needMem, 64)) throw new Failed(`not enough free memory (${insp.memory.availableMb} MB)`);
      this.stage(d, "mandatory", "mandatory", "passed", "authorization, environment binding, lock, nginx baseline, secrets, resources");
      previousSlots = as.active ? this.slots(app, as.active.release) : [];
      if (rb && !existsSync(this.releaseDir(app, rid))) throw new Failed("the release directory no longer exists");

      // ---- PREPARING + pipeline stages (validation and build)
      let extendedHealth = false;
      if (!rb) {
        this.setState(d, "PREPARING", "isolated release workspace");
        await this.prepareRelease(d, pf!);
      }
      const results = new Map<string, StageStatus>();
      for (const st of ignoreStages ? [] : stageList) {
        if (st.type === "deploy") break;
        this.checkCancel(d);
        if (!st.enabled) { this.stage(d, st.id, st.type, "disabled", st.reason); results.set(st.id, "disabled"); continue; }
        const bad = st.dependsOn.find((x) => ["failed", "blocked", "cancelled"].includes(results.get(x) ?? "pending"));
        if (bad) { this.stage(d, st.id, st.type, "blocked", `depends on "${bad}" which did not pass`); results.set(st.id, "blocked"); throw new Failed(`stage ${st.id} is blocked by ${bad}`); }
        this.setState(d, st.type === "build" ? "BUILDING" : st.type === "tests" ? "BUILDING" : "VALIDATING", `stage ${st.id}`);
        this.stage(d, st.id, st.type, "running");
        let r: { status: StageStatus; detail: string; data?: unknown };
        try { r = await this.runStage(d, st, decl, services, as); } catch (e) { r = { status: "failed", detail: (e as Error).message }; }
        this.stage(d, st.id, st.type, r.status, r.detail, r.data); results.set(st.id, r.status);
        if (st.type === "health" && r.status === "passed") extendedHealth = true;
        if (r.status === "failed" && st.onFailure === "fail") throw new Failed(`stage ${st.id} failed: ${r.detail}`);
        if (r.status === "failed") this.log(d, "warn", `stage ${st.id} failed but onFailure is "continue": ${r.detail}`);
      }
      if (!rb) {
        // mandatory build verification even if the build stage is disabled: the entry point must exist
        for (const sv of services) this.verifyEntry(sv, this.serviceDir(app, rid, sv), d);
      }

      // ---- migrations (once, owned by one service, never destructive without approval)
      if (!rb && decl.migrations && decl.migrations.mode !== "none") await this.runMigration(d, decl, services, as);
      this.checkCancel(d);

      // ---- strategy
      const drain = (decl.strategy.drainSeconds ?? 10);
      const targetFile = proxy ? targetFor(this.policy, app, decl.proxy?.nginx?.attachTo ? attachDirFor(this.policy, decl.proxy.nginx.attachTo) : decl.proxy?.nginx?.layout) : undefined;
      for (const sv of services) if (proxy && sv.runtime !== "static" && (!as.stablePorts[sv.name] || (sv.internalPort && as.stablePorts[sv.name] !== sv.internalPort))) {
        if (sv.internalPort) { if (!(await portFree(sv.internalPort)) && as.stablePorts[sv.name] !== sv.internalPort) throw new Failed(`internalPort ${sv.internalPort} of ${sv.name} is already in use by something else`); alloc.reserve(sv.internalPort, `${app}:stable:${sv.name}`); as.stablePorts[sv.name] = sv.internalPort; }
        else as.stablePorts[sv.name] = await this.withShared("ports", () => alloc.allocate(`${app}:stable:${sv.name}`));
      }
      this.saveApp(as);

      const startAll = async (only?: { service: string; instance: number }): Promise<SlotState[]> => {
        const started: SlotState[] = [];
        for (const sv of services) {
          const n = sv.instances ?? 1;
          for (let i = 0; i < n; i++) {
            if (only && (only.service !== sv.name || only.instance !== i)) continue;
            const port = typeof sv.port === "number" && t === "recreate" ? sv.port : await this.withShared("ports", () => alloc.allocate(`${app}:${rid}:${sv.name}:${i}`));
            const dir = this.serviceDir(app, rid, sv);
            const sub = (a: string): string => a.replace(/\{port\}/g, String(port)).replace(/\{release\}/g, rid);
            const slot: SlotState = { app, service: sv.name, release: rid, slot: t === "blue-green" ? (as.active ? (this.slots(app, as.active.release)[0]?.slot === "blue" ? "green" : "blue") : "blue") : `i${i}`, instance: i, token: newToken(), port, cmd: (sv.start ?? []).map(sub), cwd: dir, logFile: join(this.appDir(app), "logs", "services", `${rid}-${sv.name}-${i}.log`), status: "created", graceSeconds: sv.shutdownGraceSeconds ?? 30, ...(decl.runtime?.supervisor === "systemd" ? { supervisor: "systemd" as const, runDir: join(this.appDir(app), "run"), restart: decl.runtime.restart ?? "no" } : {}) };
            const se = this.serviceEnv(decl, as, sv, port);
            const run = startSlot(slot, se); this.saveSlot(run);
            candidate.push(run); started.push(run); d.candidateSlots = candidate.map((c) => `${c.service}-${c.instance}`); this.saveDep(d);
            this.log(d, "info", `started candidate ${sv.name}#${i} pid=${run.pid} port=${port}`);
          }
        }
        return started;
      };
      const verify = async (slots: SlotState[], ext: boolean): Promise<void> => {
        for (const s of slots) {
          const sv = services.find((x) => x.name === s.service)!; const h = sv.health ?? {};
          const probeCfg = { port: s.port, expectStatus: h.expectStatus ?? 200, timeoutSeconds: h.timeoutSeconds ?? 60, intervalSeconds: h.intervalSeconds ?? 1, consecutive: Math.max(h.consecutive ?? 2, ext ? 3 : 1), alive: () => identityMatches(s).match };
          const paths = [h.readyPath ?? h.path ?? "/health/ready", ...(ext && h.path && h.path !== (h.readyPath ?? h.path) ? [h.path] : [])];
          for (const p of paths) {
            const r = await waitReady({ ...probeCfg, path: p });
            this.log(d, r.ok ? "info" : "error", `readiness ${s.service}#${s.instance} ${p}: ${r.ok ? "ready" : r.exited ? "process exited" : `not ready (status ${r.lastStatus ?? "none"} ${r.lastError ?? ""})`} after ${r.attempts} probes, ${r.ms} ms`);
            if (!r.ok) throw new Failed(`candidate ${s.service}#${s.instance} did not become ready on ${p}: ${r.exited ? `the process exited; last output: ${tailLog(s.logFile, 600).trim().split("\n").slice(-3).join(" | ")}` : `status ${r.lastStatus ?? "none"} ${r.lastError ?? ""}`}`, "CANDIDATE_NOT_READY");
          }
        }
      };
      const routes = (portsBy: Record<string, number[]>): RouteInstance[] => services.map((s) => ({ service: s.name, ports: portsBy[s.name] ?? [], stablePort: as.stablePorts[s.name]!, ...(s.route ? { route: { path: s.route.path ?? "/" } } : {}) }));
      const portsOf = (slots: SlotState[]): Record<string, number[]> => { const o: Record<string, number[]> = {}; for (const s of slots) (o[s.service] ??= []).push(s.port); return o; };
      const applyRouting = (portsBy: Record<string, number[]>, label: string): void => {
        const content = renderConfig({ app, release: rid, services: routes(portsBy), nginx: decl.proxy?.nginx, ...(decl.proxy?.nginx?.attachPoint ? { attachDir: attachDirFor(this.policy, app) } : {}) });
        const l = this.sharedLock("nginx"); const owner = `${d.id}-nginx`;
        const until = Date.now() + 30_000; while (!l.tryAcquire({ id: owner, purpose: "nginx apply", pid: process.pid })) { if (l.status() === "stale") rmSync(l.dir, { recursive: true, force: true }); if (Date.now() > until) throw new Failed("another deployment is changing nginx; try again"); const x = Date.now() + 100; while (Date.now() < x) { /* wait */ } }
        try {
          const r = applyProxy(this.state.home, this.policy, targetFile!, app, content, d.id);
          if (r.backupId && !d.proxyBackupId) d.proxyBackupId = r.backupId;
          this.saveDep(d);
          this.log(d, r.error ? "error" : "info", `nginx ${label}: ${r.error ?? (r.changed ? "applied and reloaded gracefully" : "unchanged")}${r.testOutput ? ` | ${r.testOutput.split("\n").slice(0, 3).join(" | ")}` : ""}`);
          if (r.error) throw new Failed(r.error, "PROXY_REJECTED");
          if (r.changed) d.trafficSwitched = true;
          this.saveDep(d);
        } finally { l.release(owner); }
      };
      const verifyActive = async (): Promise<{ requests: number; failures: number }> => {
        const routed = services.find((s) => s.route) ?? services[0]!; const h = routed.health ?? {};
        const ng = decl.proxy?.nginx; const httpPort = ng?.listen?.http ?? 80; const host = ng?.domains?.[0] ?? "localhost";
        const path = routed.route ? (h.readyPath ?? h.path ?? "/health/ready") : "/";
        // With TLS the public port only REDIRECTS (301 to https) and the agent holds no CA to speak TLS to itself: the release is verified through the
        // loopback listener of the same nginx file (still the proxy, same release header), and the public port is checked to redirect.
        const redirects = !!(ng?.tls && ng.listen?.https);
        if (redirects) { const p = await httpGet(httpPort, "/", { host }); if (!(p.ok && p.status === 301)) throw new Failed(`the public port ${httpPort} was expected to redirect to https and answered ${p.status ?? p.error}`, "ACTIVE_NOT_VERIFIED"); this.log(d, "info", `public port ${httpPort} redirects to https (301); verifying the active release through nginx's loopback listener`); }
        let ok = 0; let bad = 0; let last = "";
        for (let i = 0; i < 6; i++) {
          const r = routed.route && !redirects ? await httpGet(httpPort, path, { host }) : await httpGet(as.stablePorts[routed.name]!, h.readyPath ?? h.path ?? "/health/ready");
          const rel = String(r.headers?.["x-pso-release"] ?? "");
          if (r.ok && r.status === (h.expectStatus ?? 200) && rel === rid) ok++; else { bad++; last = `status ${r.status ?? r.error}, release header "${rel}"`; }
          await sleep(300);
        }
        this.log(d, bad ? "error" : "info", `active-release verification through nginx: ${ok}/${ok + bad} probes reached release ${rid}${last ? ` (last failure: ${last})` : ""}`);
        if (ok < 5) throw new Failed(`the active release was not verified through the proxy (${ok}/6 probes reached ${rid}; ${last})`, "ACTIVE_NOT_VERIFIED");
        return { requests: ok + bad, failures: bad };
      };

      const finish = async (): Promise<void> => {
        // ---- DRAINING_PREVIOUS_RELEASE: only now do the previous processes stop, honouring their real grace
        this.setState(d, "DRAINING_PREVIOUS_RELEASE", previousSlots.length ? `waiting ${drain}s for in-flight requests, then stopping ${previousSlots.length} previous instance(s)` : "no previous instances");
        if (previousSlots.length && proxy) await sleep(drain * 1000);
        for (const s of previousSlots) {
          const r = await stopSlot(s); this.log(d, r.stopped ? "info" : "warn", `previous ${s.service}#${s.instance} (pid ${s.pid}): ${r.detail}`);
          if (r.stopped) { s.status = "stopped"; s.stoppedAt = nowIso(); this.saveSlot(s); this.ports(range).release(s.port); }
        }
        const fresh = this.appState(app);
        const prevRelease = fresh.active?.release;
        fresh.previous = prevRelease && prevRelease !== rid ? prevRelease : fresh.previous;
        fresh.active = { release: rid, since: nowIso(), slots: candidate.map((c) => `${c.service}-${c.instance}`) };
        fresh.lastKnownGood = rid; if (!fresh.releases.includes(rid)) fresh.releases.push(rid);
        if (plan?.provenance.authenticity === "verified" && typeof plan.provenance.sequence === "number" && d.kind === "deploy") fresh.lastSignedSequence = Math.max(fresh.lastSignedSequence ?? 0, plan.provenance.sequence);
        if (targetFile) fresh.nginxFile = targetFile.file;
        fresh.stablePorts = { ...fresh.stablePorts, ...as.stablePorts };
        this.saveApp(fresh);
        this.syncBootPersistence(app);
        this.gc(app, plan?.strategy.keep ?? this.policy.retentionMin);
      };

      this.checkCancel(d);
      if (t === "static") {
        await this.runStatic(d, { decl, services, as, rid, rb, plan, targetFile, proxy });
      } else if (t === "blue-green") {
        this.setState(d, "STARTING_CANDIDATE", `release ${rid} in slot ${as.active ? "alternate" : "first"}; ${previousSlots.length ? "previous release keeps serving" : "no previous release"}`);
        const started = await startAll();
        this.setState(d, "VERIFYING_CANDIDATE");
        await verify(started, extendedHealth);
        this.checkCancel(d);
        this.setState(d, "SWITCHING_TRAFFIC", "validating nginx configuration, then one graceful reload");
        applyRouting(portsOf(candidate), "switch");
        this.setState(d, "VERIFYING_ACTIVE_RELEASE");
        try { d.availability = await verifyActive(); this.saveDep(d); if (extendedHealth) await verify(candidate, true); } catch (e) {
          if (decl.strategy.autoRollback === false) throw e;
          await this.undoSwitch(d, previousSlots.length > 0); throw e;
        }
        await finish();
      } else if (t === "rolling") {
        const prevBy = (name: string): SlotState[] => previousSlots.filter((p) => p.service === name).sort((a, b) => a.instance - b.instance);
        this.setState(d, "STARTING_CANDIDATE", "replacing one instance at a time");
        const current: Record<string, number[]> = {}; for (const s of previousSlots) (current[s.service] ??= []).push(s.port);
        for (const sv of services) {
          const n = sv.instances ?? 1;
          for (let i = 0; i < n; i++) {
            const [one] = await startAll({ service: sv.name, instance: i }); if (!one) throw new Failed("could not start an instance");
            this.setState(d, "VERIFYING_CANDIDATE", `${sv.name}#${i}`); await verify([one], extendedHealth);
            const old = prevBy(sv.name)[i];
            current[sv.name] = [...(current[sv.name] ?? []).filter((p) => p !== old?.port), one.port];
            this.setState(d, "SWITCHING_TRAFFIC", `${sv.name}#${i}: new instance in, old instance out`);
            applyRouting({ ...current }, `rolling ${sv.name}#${i}`);
            if (old) { await sleep(Math.min(drain, 5) * 1000); const r = await stopSlot(old); this.log(d, "info", `old ${sv.name}#${i}: ${r.detail}`); if (r.stopped) { old.status = "stopped"; this.saveSlot(old); this.ports(range).release(old.port); } }
          }
        }
        previousSlots = [];
        this.setState(d, "VERIFYING_ACTIVE_RELEASE");
        try { d.availability = await verifyActive(); this.saveDep(d); } catch (e) { await this.undoSwitch(d, false); throw e; }
        await finish();
      } else {
        // recreate: downtime by design, stated in the plan
        this.setState(d, "DRAINING_PREVIOUS_RELEASE", "recreate: the running release stops BEFORE the new one starts (declared downtime)");
        for (const s of previousSlots) { const r = await stopSlot(s); this.log(d, r.stopped ? "info" : "error", `stop ${s.service}#${s.instance}: ${r.detail}`); if (!r.stopped) throw new Failed(`could not stop ${s.service}: ${r.detail}`); s.status = "stopped"; this.saveSlot(s); this.ports(range).release(s.port); }
        this.setState(d, "STARTING_CANDIDATE");
        const started = await startAll();
        this.setState(d, "VERIFYING_CANDIDATE");
        try { await verify(started, extendedHealth); } catch (e) {
          if (decl.strategy.autoRollback !== false && previousSlots.length && d.kind === "deploy") { this.log(d, "warn", "candidate failed after the previous release was stopped: restarting the previous release"); d.error = (e as Error).message; await this.restartPrevious(d, previousSlots, decl, as); d.outcome = "rolled-back"; throw Object.assign(new Failed((e as Error).message), { rolledBack: true }); }
          throw e;
        }
        if (proxy) { this.setState(d, "SWITCHING_TRAFFIC"); applyRouting(portsOf(candidate), "recreate"); this.setState(d, "VERIFYING_ACTIVE_RELEASE"); d.availability = await verifyActive(); this.saveDep(d); }
        previousSlots = [];
        await finish();
      }
      d.finishedAt = nowIso(); d.outcome = "completed"; this.setState(d, "COMPLETED", `release ${rid} is active`);
      this.stage(d, "deploy", "deploy", "passed", t);
      this.audit.append(`${d.kind}.completed`, "ok", d.requestedBy, { environment: this.state.env().id, app, deployment: d.id, release: rid }, { strategy: t, previous: d.previousRelease, availability: d.availability });
    } catch (e) {
      await this.fail(d, e as Error, candidate, alloc, range, rb);
    }
  }

  // ---------------------------------------------------------------- static frontend resources (a shell or a microfrontend)
  private verifyStaticEntry(sv: ServiceDecl, dir: string): void {
    const sd = sv.static!; const dist = sd.publish && sd.publish !== "." ? join(dir, sd.publish) : dir;
    if (!isDir(dist)) throw new Failed(`static resource ${sv.name}: "${sd.publish ?? "."}" does not exist in the release`);
    try {
      if (sd.kind === "fei") readFileSyncGuard(() => readFeiDist(dist));
      else { const m = parseManifest(readJson<unknown>(join(dist, "pso-manifest.json"), undefined)); if (!m.manifest) throw new Error(`pso-manifest.json: ${m.problems.join("; ")}`); }
    } catch (e) { throw new Failed(`static resource ${sv.name}: ${(e as Error).message}`, "STATIC_RELEASE_INVALID"); }
  }

  /**
   * Deploys a static resource with the engine's own plan, lock, signature and history, using the SAME release primitives as `pso frontend:publish`.
   * A shell: stage the files, validate and reload nginx only if its file changed, then activate. A microfrontend: stage, check compatibility
   * with the active shell, activate with one atomic pointer write; nginx is not touched. The previous release stays active until the new one
   * is verified through nginx; a failure puts the previous one back.
   */
  private async runStatic(d: Deployment, c: { decl: DeploymentDecl; services: ServiceDecl[]; as: AppState; rid: string; rb: boolean; plan: Plan | undefined; targetFile: NginxTarget | undefined; proxy: boolean }): Promise<void> {
    const { decl, rid, rb, plan } = c; const app = d.app; const sv = c.services[0]!; const sd = sv.static!;
    const site = this.siteRoot(sd.site);
    const dir = this.serviceDir(app, rid, sv); const dist = sd.publish && sd.publish !== "." ? join(dir, sd.publish) : dir;
    const by = d.requestedBy.name ?? d.requestedBy.clientId ?? "agent";
    this.setState(d, "STARTING_CANDIDATE", "verifying the static release against its manifest; no process is started");
    const sweep = recoverSite(site);
    if (sweep.removed.length) this.log(d, "info", `swept ${sweep.removed.length} leftover file(s) of an interrupted publish on the site`);
    for (const p of sweep.problems) this.log(d, "warn", `site consistency: ${p}`);
    let name: string; let version: string;
    if (sd.kind === "mei") { const m = parseManifest(readJson<unknown>(join(dist, "pso-manifest.json"), undefined)).manifest; if (!m) throw new Failed("the microfrontend manifest is invalid", "STATIC_RELEASE_INVALID"); name = m.name; version = m.version; }
    else { const f = readFeiDist(dist); name = f.name; version = f.version; }
    const previousVersion = sd.kind === "mei" ? activePointer(site, name)?.version : readJson<{ version: string } | undefined>(join(site, "fei", "current.json"), undefined)?.version;
    this.checkCancel(d);
    let pointerMoved = false; let proxyApplied = false;
    try {
      this.setState(d, "SWITCHING_TRAFFIC", sd.kind === "mei" ? "compatibility check, then one atomic pointer write (nginx is not touched)" : "staging the shell, validating nginx, then activating");
      if (sd.kind === "mei") {
        if (rb && meiVersions(site, name).includes(version)) rollbackMei(site, name, version, by); else publishMei({ site, dist, by });
        pointerMoved = previousVersion !== version;
        this.log(d, "info", `${name} ${version} is active on the site (previous: ${previousVersion ?? "none"}); no web-server change`);
      } else {
        stageFei(site, dist);
        const rcfg = sd.runtimeConfig;
        if (rcfg) { const fr = readFeiDist(dist); writeRuntimeConfig({ site, fei: fr.name, auth: rcfg.auth, orchestratorBasePath: rcfg.orchestratorBasePath, ...(rcfg.channelsPath ? { channelsPath: rcfg.channelsPath } : {}), meis: fr.mounts.map((m) => m.name), ...(rcfg.requireSignature ? { requireSignature: true } : {}), ...(rcfg.trustedKeys?.length ? { trustedKeys: rcfg.trustedKeys } : {}) }); this.log(d, "info", "runtime configuration written on the site (orchestrator path, sign-in, trusted release signers)"); }
        if (c.targetFile) {
          const content = (decl.proxy?.nginx?.attachTo ? renderStaticFragment : renderStaticConfig)(staticVhost(app, rid, decl, site));
          const l = this.sharedLock("nginx"); const owner = `${d.id}-nginx`;
          const until = Date.now() + 30_000; while (!l.tryAcquire({ id: owner, purpose: "nginx apply", pid: process.pid })) { if (l.status() === "stale") rmSync(l.dir, { recursive: true, force: true }); if (Date.now() > until) throw new Failed("another deployment is changing nginx"); await sleep(100); }
          try {
            const r = applyProxy(this.state.home, this.policy, c.targetFile, app, content, d.id);
            if (r.backupId && !d.proxyBackupId) d.proxyBackupId = r.backupId;
            this.log(d, r.error ? "error" : "info", `nginx: ${r.error ?? (r.changed ? "validated with nginx -t and reloaded gracefully" : "unchanged: no reload")}`);
            if (r.error) throw new Failed(r.error, "PROXY_REJECTED");
            if (r.changed) { proxyApplied = true; d.trafficSwitched = true; }
            this.saveDep(d);
          } finally { l.release(owner); }
        }
        activateFei(site, version, rb ? "rollback" : "publish", by);
        pointerMoved = previousVersion !== version;
      }
      this.setState(d, "VERIFYING_ACTIVE_RELEASE");
      d.availability = await this.verifyStaticActive(d, { decl, sd, name, version, rid });
      this.saveDep(d);
    } catch (e) {
      // whatever happened, the release users had before this attempt is the one they keep
      if (pointerMoved && previousVersion) {
        try { if (sd.kind === "mei") rollbackMei(site, name, previousVersion, by); else activateFei(site, previousVersion, "rollback", by); this.log(d, "warn", `${name} ${previousVersion} was put back as the active version`); }
        catch (x) { this.log(d, "error", `could not put ${previousVersion} back: ${(x as Error).message}`); }
      }
      if (proxyApplied && d.proxyBackupId) { const r = restoreProxy(this.state.home, this.policy, d.proxyBackupId); this.log(d, r.ok ? "warn" : "error", `previous nginx configuration ${r.ok ? "restored and reloaded" : `NOT restored: ${r.error}`}`); }
      d.trafficSwitched = false;
      throw e;
    }
    const fresh = this.appState(app); const prevRelease = fresh.active?.release;
    fresh.previous = prevRelease && prevRelease !== rid ? prevRelease : fresh.previous;
    fresh.active = { release: rid, since: nowIso(), slots: [] }; fresh.lastKnownGood = rid; if (!fresh.releases.includes(rid)) fresh.releases.push(rid);
    if (plan?.provenance.authenticity === "verified" && typeof plan.provenance.sequence === "number" && d.kind === "deploy") fresh.lastSignedSequence = Math.max(fresh.lastSignedSequence ?? 0, plan.provenance.sequence);
    if (c.targetFile) fresh.nginxFile = c.targetFile.file;
    this.saveApp(fresh);
    const pruned = sd.kind === "mei" ? pruneMei(site, name, sd.retain ?? 5) : pruneFei(site, sd.retain ?? 5);
    if (pruned.length) this.log(d, "info", `retention: removed ${pruned.join(", ")} from the site (the active and the previous version always stay)`);
    this.gc(app, plan?.strategy.keep ?? this.policy.retentionMin);
  }

  /** Verifies the active static release THROUGH nginx: the shell answers with this release and a missing asset is a 404; a microfrontend's pointer, manifest and entry file are the ones just published. */
  private async verifyStaticActive(d: Deployment, o: { decl: DeploymentDecl; sd: NonNullable<ServiceDecl["static"]>; name: string; version: string; rid: string }): Promise<{ requests: number; failures: number }> {
    const ng = o.decl.proxy?.nginx; const sd = o.sd;
    const tls = !!(ng?.tls && ng.listen?.https);
    const port = sd.probe?.port ?? (sd.kind === "fei" && o.decl.strategy.proxy === "nginx" && !tls ? (ng?.listen?.http ?? 80) : undefined);
    const host = sd.probe?.host ?? ng?.domains?.[0] ?? "localhost";
    if (port === undefined) { this.log(d, "warn", "no probe port is declared (static.probe.port): the active release was verified on the site root only, not through nginx"); return { requests: 0, failures: 0 }; }
    let n = 0; let bad = 0; const notes: string[] = [];
    const get = async (path: string): Promise<{ status?: number; headers: Record<string, string>; body: Buffer }> => { n++; return httpFetch(port, path, host); };
    if (sd.kind === "fei") {
      const base = sd.basePath ?? "/";
      // a graceful reload starts new workers asynchronously: wait (bounded) until THIS release answers, then require consecutive confirmations
      let last = await get(base); const until = Date.now() + 15_000;
      while (!(last.status === 200 && last.headers["x-pso-release"] === o.rid) && Date.now() < until) { await sleep(250); last = await get(base); }
      for (let i = 0; i < 3; i++) { const r = i === 0 ? last : await get(base); if (!(r.status === 200 && r.headers["x-pso-release"] === o.rid)) { bad++; notes.push(`${base} answered ${r.status ?? "nothing"} for release "${r.headers["x-pso-release"] ?? ""}"`); } await sleep(200); }
      const missing = await get(`${base}assets/__pso_missing__.js`);
      if (missing.status !== 404) { bad++; notes.push(`a missing asset answered ${missing.status ?? "nothing"} instead of 404 (the entry page must not stand in for files)`); }
    } else {
      const p = await get(`/_mei/${o.name}/active.json`);
      let ptr: { version?: string; manifest?: string; manifestSha256?: string } = {}; try { ptr = JSON.parse(p.body.toString("utf8")); } catch { /* reported below */ }
      if (p.status !== 200 || ptr.version !== o.version || typeof ptr.manifest !== "string") { bad++; notes.push(`the pointer answered ${p.status ?? "nothing"} with version ${ptr.version ?? "?"}, expected ${o.version}`); }
      else {
        const m = await get(`/_mei/${o.name}/${ptr.manifest}`);
        if (m.status !== 200 || createHash("sha256").update(m.body).digest("hex") !== ptr.manifestSha256) { bad++; notes.push("the manifest served does not match the hash its pointer records"); }
        else {
          const man = parseManifest(JSON.parse(m.body.toString("utf8"))).manifest;
          const entry = man?.files.find((f) => f.path === man.entry);
          const e = man && entry ? await get(`/_mei/${o.name}/v/${o.version}/${man.entry}`) : undefined;
          if (!e || e.status !== 200 || createHash("sha256").update(e.body).digest("hex") !== entry!.sha256) { bad++; notes.push("the entry file served does not match the manifest"); }
        }
      }
    }
    this.log(d, bad ? "error" : "info", `active static release verified through nginx on port ${port}: ${n - bad}/${n} checks passed${notes.length ? ` (${notes.join("; ")})` : ""}`);
    if (bad) throw new Failed(`the active release was not verified through nginx: ${notes.join("; ")}`, "ACTIVE_NOT_VERIFIED");
    return { requests: n, failures: bad };
  }

  private withShared<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const l = this.sharedLock(name); const owner = `${process.pid}-${newToken().slice(0, 4)}`;
    const until = Date.now() + 15_000;
    const attempt = async (): Promise<T> => {
      while (!l.tryAcquire({ id: owner, purpose: name, pid: process.pid })) { if (l.status() === "stale") rmSync(l.dir, { recursive: true, force: true }); if (Date.now() > until) throw new Failed(`lock "${name}" is busy`); await sleep(50); }
      try { return await fn(); } finally { l.release(owner); }
    };
    return attempt();
  }

  /** The traffic switch was applied but the new release failed verification: put the previous proxy configuration back. */
  private async undoSwitch(d: Deployment, previousStillRunning: boolean): Promise<void> {
    if (!d.proxyBackupId) return;
    this.log(d, "warn", `restoring the previous proxy configuration (${d.proxyBackupId})${previousStillRunning ? "; the previous release is still running" : ""}`);
    const r = restoreProxy(this.state.home, this.policy, d.proxyBackupId);
    this.log(d, r.ok ? "info" : "error", `proxy restore: ${r.ok ? "restored and reloaded" : r.error}`);
    if (r.ok) d.trafficSwitched = false;
    this.saveDep(d);
  }

  private async restartPrevious(d: Deployment, previousSlots: SlotState[], decl: DeploymentDecl, as: AppState): Promise<void> {
    for (const old of previousSlots) {
      const sv = servicesOf(decl).find((x) => x.name === old.service); if (!sv) continue;
      const m = readJson<Manifest | undefined>(join(this.releaseDir(d.app, old.release), "manifest.json"), undefined);
      const s = startSlot({ ...old, token: newToken(), status: "created" }, this.serviceEnv(m?.decl ?? decl, as, sv, old.port)); this.saveSlot(s);
      const h = sv.health ?? {};
      const r = await waitReady({ port: s.port, path: h.readyPath ?? h.path ?? "/health/ready", expectStatus: h.expectStatus ?? 200, timeoutSeconds: h.timeoutSeconds ?? 60, intervalSeconds: 1, consecutive: 2, alive: () => identityMatches(s).match });
      this.log(d, r.ok ? "info" : "error", `previous ${old.service}#${old.instance} restarted: ${r.ok ? "ready" : "NOT READY — operator action required"}`);
      if (!r.ok) throw new Failed(`automatic rollback could not restart ${old.service}: operator action required`);
    }
  }

  private async fail(d: Deployment, e: Error, candidate: SlotState[], alloc: PortAllocator, range: { from: number; to: number }, rb: boolean): Promise<void> {
    const cancelled = e instanceof Cancelled;
    const rolledBack = (e as { rolledBack?: boolean }).rolledBack === true;
    d.error = cancelled ? undefined : redactText(e.message);
    this.log(d, cancelled ? "warn" : "error", cancelled ? "cancelled by request" : `failed: ${e.message}`);
    // the candidate never keeps running after a failure; the previous release was not stopped before activation
    for (const s of candidate) { const r = await stopSlot(s).catch(() => undefined); if (r) this.log(d, "info", `candidate ${s.service}#${s.instance} stopped: ${r.detail}`); s.status = "stopped"; this.saveSlot(s); alloc.release(s.port); }
    if (d.trafficSwitched) await this.undoSwitch(d, true);
    d.finishedAt = nowIso();
    const state: DeployState = cancelled ? "CANCELLED" : rolledBack ? "ROLLED_BACK" : "FAILED";
    d.outcome = cancelled ? "cancelled" : rolledBack ? "rolled-back" : "failed";
    for (const s of d.stages) if (s.status === "running") { s.status = cancelled ? "cancelled" : "failed"; s.finishedAt = nowIso(); }
    this.setState(d, state, d.error);
    this.audit.append(`${d.kind}.${d.outcome}`, cancelled ? "info" : "failed", d.requestedBy, { environment: this.state.env().id, app: d.app, deployment: d.id, release: d.releaseId }, { error: d.error, activeUntouched: !d.trafficSwitched });
    void range; void rb;
  }

  // ---------------------------------------------------------------- release preparation
  private async prepareRelease(d: Deployment, pf: PlanFile): Promise<void> {
    const { plan, decl } = pf; const rdir = this.releaseDir(d.app, d.releaseId); const src = join(rdir, "src");
    ensureDir(rdir);
    if (plan.source.provider === "git" && decl.source.provider === "git") {
      const r = fetchCommit(decl.source, plan.source.commit, src, this.gitCtx());
      if (!r.ok) throw new Failed(`could not fetch commit ${plan.source.commit.slice(0, 12)}: ${r.error}`);
      this.log(d, "info", `fetched ${plan.source.commit} (${plan.source.refType} ${plan.source.ref}) into an isolated workspace; HEAD verified`);
    } else if (plan.source.provider === "artifact" && pf.artifact) {
      const file = join(P.incoming(this.state.home), pf.artifact.uploadId, "artifact.tgz");
      if (!existsSync(file)) throw new Failed("the uploaded artifact is gone from the server");
      const actual = await sha256File(file);
      if (actual !== plan.source.sha256) throw new Failed(`artifact checksum mismatch: planned ${plan.source.sha256.slice(0, 16)}…, found ${actual.slice(0, 16)}…`);
      const listing = execFileSync("tar", ["-tzf", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
      const unsafe = listing.find((e) => e.startsWith("/") || e.split("/").includes(".."));
      if (unsafe) throw new Failed(`unsafe path in the artifact: ${unsafe}`);
      ensureDir(src); execFileSync("tar", ["-xzf", file, "-C", src, "--no-same-owner"], { maxBuffer: 64 * 1024 * 1024 });
      this.log(d, "info", `artifact ${actual.slice(0, 16)}… verified and extracted`);
    }
    const treeHash = treeDigest(src);
    // route metadata published WITH the release by the build (`pso routes:list --json --out pso-release.json`): the explorer shows the DEPLOYED release, not the developer's tree
    let endpoints: unknown; try { const f = join(src, "pso-release.json"); if (existsSync(f) && statSync(f).size < 1_000_000) endpoints = JSON.parse(readFileSync(f, "utf8")); } catch { endpoints = undefined; }
    if (pf.signed) {
      const signedTree = (JSON.parse(pf.signed.manifest) as { treeHash?: string }).treeHash;
      if (signedTree && signedTree !== treeHash) throw new Failed(`the release content does not match what the signer signed (tree ${treeHash.slice(0, 16)}… vs signed ${signedTree.slice(0, 16)}…): refusing a modified artifact`, "RELEASE_TAMPERED");
    }
    const manifest: Manifest = { releaseId: d.releaseId, app: d.app, createdAt: nowIso(), kind: plan.source.provider, source: plan.source, treeHash, declarationHash: plan.declarationHash, planHash: plan.hash, decl, pipeline: pf.pipeline, ...(endpoints ? { endpoints } : {}), ...(pf.signed ? { signed: pf.signed, provenance: plan.provenance } : {}) };
    const mf = join(rdir, "manifest.json"); writeJson(mf, manifest, 0o444); try { chmodSync(mf, 0o444); } catch { /* not supported */ }
    const as = this.appState(d.app); if (!as.releases.includes(d.releaseId)) { as.releases.push(d.releaseId); this.saveApp(as); }
    this.stage(d, "release", "release", "passed", `${d.releaseId} tree ${treeHash.slice(0, 16)}`);
  }

  private verifyEntry(sv: ServiceDecl, dir: string, d: Deployment): void {
    if (!isDir(dir)) throw new Failed(`service ${sv.name}: directory "${sv.dir ?? "."}" does not exist in the release`);
    if (sv.runtime === "static") { this.verifyStaticEntry(sv, dir); return; }
    const startArgv = sv.start ?? []; const first = startArgv[0]!; const arg = startArgv.find((a) => /\.(jar|js|mjs|cjs)$/.test(a) && !a.startsWith("-"));
    if (arg && !arg.includes("{") && !existsSync(resolve(dir, arg))) throw new Failed(`service ${sv.name}: ${arg} does not exist after the build (start: ${startArgv.join(" ")})`);
    void first; void d;
  }

  private async runMigration(d: Deployment, decl: DeploymentDecl, services: ServiceDecl[], as: AppState): Promise<void> {
    const m = decl.migrations!;
    if (!m.command) { this.log(d, "info", "migrations are applied by the application itself when it starts (workload.selfMigrates): PSO runs no migration command; the expand-contract declaration is what allowed the overlap"); return; }
    const owner = services.find((s) => s.name === (m.owner ?? services[0]!.name))!;
    const ledgerFile = join(this.appDir(d.app), "migrations.json"); const ledger = readJson<{ ran: string[] }>(ledgerFile, { ran: [] });
    if (ledger.ran.includes(d.releaseId)) { this.log(d, "info", "migration already ran for this release"); return; }
    if (m.destructive && !(m.approvedDestructive && this.policy.allowDestructiveMigrations)) throw new Failed("destructive migration is not approved");
    const ml = new DirLock(join(this.appDir(d.app), "migration-lock"));
    if (!ml.tryAcquire({ id: d.id, purpose: "migration", pid: process.pid })) throw new Failed("another migration is running or was interrupted (migration lock held)");
    try {
      this.setState(d, "BUILDING", `migration (owner ${owner.name}, ${m.destructive ? "destructive, approved" : "expand-contract"})`);
      const se = this.serviceEnv(decl, as, owner, 0);
      const r = await this.runArgv(d, m.command!, { cwd: this.serviceDir(d.app, d.releaseId, owner), env: { ...se.env, ...se.secretEnv }, timeoutSeconds: 1800 });
      if (r.code !== 0) throw new Failed(`migration failed (${r.timedOut ? "timeout" : `exit ${r.code}`}); the active release is unchanged`);
      ledger.ran.push(d.releaseId); writeJson(ledgerFile, ledger);
      this.audit.append("migration.ran", "ok", d.requestedBy, { environment: this.state.env().id, app: d.app, release: d.releaseId, deployment: d.id }, { owner: owner.name, destructive: !!m.destructive });
    } finally { ml.release(d.id); }
  }

  // ---------------------------------------------------------------- pipeline stages
  private async runStage(d: Deployment, st: Plan["stages"][number], decl: DeploymentDecl, services: ServiceDecl[], as: AppState): Promise<{ status: StageStatus; detail: string; data?: unknown }> {
    const rdir = this.releaseDir(d.app, d.releaseId); const src = join(rdir, "src");
    switch (st.type) {
      case "integrity": {
        const m = readJson<Manifest | undefined>(join(rdir, "manifest.json"), undefined);
        if (!m) return { status: "failed", detail: "release manifest is missing" };
        const tree = treeDigest(src); if (tree !== m.treeHash) return { status: "failed", detail: "the release workspace changed after it was prepared (tree hash differs)" };
        const problems: string[] = [];
        for (const sv of services) {
          const dir = this.serviceDir(d.app, d.releaseId, sv); if (!isDir(dir)) { problems.push(`service ${sv.name}: directory missing`); continue; }
          if (sv.runtime === "node") {
            const pj = join(dir, "package.json"); const pl = join(dir, "package-lock.json");
            if (!existsSync(pj)) problems.push(`service ${sv.name}: no package.json`);
            else if (existsSync(pl)) { const p = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(pj, {}); const l = readJson<{ packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> }>(pl, {}); const root = l.packages?.[""] ?? {}; for (const k of ["dependencies", "devDependencies"] as const) for (const [n, v] of Object.entries(p[k] ?? {})) if (root[k]?.[n] !== v) problems.push(`service ${sv.name}: package.json ${n}@${v} is not what package-lock.json records (${root[k]?.[n] ?? "absent"}): lockfile inconsistent`); }
          }
        }
        return problems.length ? { status: "failed", detail: problems.join("; ") } : { status: "passed", detail: `manifest and tree hash verified (${m.treeHash.slice(0, 16)}…), lockfiles consistent` };
      }
      case "compatibility": {
        const problems: string[] = []; const notes: string[] = [];
        const insp = inspect(this.state);
        for (const sv of services) {
          if (sv.requires?.node && !satisfies(insp.tools.node.version ?? "0", sv.requires.node)) problems.push(`service ${sv.name} needs node ${sv.requires.node}, the server has ${insp.tools.node.version}`);
          if (sv.requires?.java) { if (!insp.tools.java.available) problems.push(`service ${sv.name} needs java ${sv.requires.java}, java is not installed`); else if (insp.tools.java.version && !satisfies(insp.tools.java.version, sv.requires.java)) problems.push(`service ${sv.name} needs java ${sv.requires.java}, the server has ${insp.tools.java.version}`); }
        }
        const wf = join(src, "pso.workspace.json");
        if (existsSync(wf)) {
          const w = readJson<{ schemaVersion?: number; services?: Array<{ name: string }> }>(wf, {});
          if (w.schemaVersion !== 1) problems.push(`pso.workspace.json schemaVersion ${w.schemaVersion} is not supported by this agent (1)`);
          const reg = new Set((w.services ?? []).map((s) => s.name));
          for (const sv of services) if (reg.size && !reg.has(sv.name)) notes.push(`service ${sv.name} is not registered in pso.workspace.json`);
          notes.push(`pso.workspace.json: ${reg.size} registered service(s)`);
        }
        const dup = new Map<string, string>(); for (const sv of services) if (typeof sv.port === "number") { if (dup.has(String(sv.port))) problems.push(`port ${sv.port} is declared by both ${dup.get(String(sv.port))} and ${sv.name}`); dup.set(String(sv.port), sv.name); }
        return problems.length ? { status: "failed", detail: problems.join("; ") } : { status: "passed", detail: ["runtime versions, workspace registration and ports are compatible", ...notes].join("; ") };
      }
      case "security": return this.securityStage(d, services, src);
      case "tests": {
        const steps = services.flatMap((s) => (s.test ?? []).map((a) => ({ s, a })));
        if (!steps.length) return { status: "skipped", detail: "no test steps declared (service.test): nothing was run, this is not a pass" };
        for (const { s, a } of steps) { const r = await this.runArgv(d, a, { cwd: this.serviceDir(d.app, d.releaseId, s), env: {}, timeoutSeconds: st.timeoutSeconds }); if (r.code !== 0) return { status: "failed", detail: `${s.name}: ${a.join(" ")} ${r.timedOut ? "timed out" : `exited ${r.code}`}` }; }
        return { status: "passed", detail: `${steps.length} test step(s) passed` };
      }
      case "resources": { const i = inspect(this.state); return i.memory.availableMb < 64 ? { status: "failed", detail: `${i.memory.availableMb} MB free` } : { status: "passed", detail: `${i.memory.availableMb} MB memory, ${i.disk.freeMb} MB disk free` }; }
      case "build": {
        let n = 0;
        for (const sv of services) for (const step of sv.build ?? []) {
          this.log(d, "info", `build ${sv.name}: ${step.join(" ")}`);
          const se = this.serviceEnv(decl, as, sv, 0);
          const r = await this.runArgv(d, step.map((a) => a.replace(/\{release\}/g, d.releaseId)), { cwd: this.serviceDir(d.app, d.releaseId, sv), env: se.env, timeoutSeconds: st.timeoutSeconds });
          if (r.code !== 0) return { status: "failed", detail: `${sv.name}: \`${step.join(" ")}\` ${r.timedOut ? `timed out after ${st.timeoutSeconds}s` : `exited with ${r.code}`}` };
          n++; this.checkCancel(d);
        }
        return { status: "passed", detail: `${n} build step(s) ran while the active release kept serving` };
      }
      case "health": return { status: "passed", detail: "extended readiness (more consecutive probes and the liveness path) will run on the candidate and the active release" };
      case "custom": {
        if (!st.command) return { status: "failed", detail: "no command" };
        const r = await this.runArgv(d, st.command, { cwd: src, env: {}, timeoutSeconds: st.timeoutSeconds });
        return r.code === 0 ? { status: "passed", detail: `${st.command[0]} exited 0` } : { status: "failed", detail: `${st.command[0]} ${r.timedOut ? "timed out" : `exited ${r.code}`}` };
      }
      default: return { status: "skipped", detail: "nothing to do" };
    }
  }

  private async securityStage(d: Deployment, services: ServiceDecl[], src: string): Promise<{ status: StageStatus; detail: string; data?: unknown }> {
    const report: { scanner: string; available: boolean; ran: boolean; findings: number; note: string }[] = [];
    // 1) secret scan of the source tree (built in: always available)
    let hits = 0; const files: string[] = [];
    const walk = (dir: string, depth: number): void => { if (depth > 8 || files.length > 4000) return; for (const e of readdirSync(dir, { withFileTypes: true })) { if ([".git", "node_modules", "target", "dist"].includes(e.name)) continue; const p = join(dir, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.isFile() && statSync(p).size < 512 * 1024) files.push(p); } };
    walk(src, 0);
    for (const f of files) { if (/\.(png|jpg|jpeg|gif|ico|jar|class|zip|gz|woff2?|lock)$/i.test(f)) continue; try { const t = readFileSync(f, "utf8"); if (looksSecret(t) && /PRIVATE KEY-----|ghp_|AKIA|xox[baprs]-|Authorization:\s*Bearer/.test(t)) { hits++; this.log(d, "warn", `possible committed secret in ${relative(src, f)}`); } } catch { /* binary */ } }
    report.push({ scanner: "pso-secret-pattern-scan", available: true, ran: true, findings: hits, note: "pattern-based; finds well-known credential shapes only. It is not a malware scan or a penetration test" });
    // 2) dependency audit (needs npm and the advisory registry)
    let audited = false; let high = 0;
    for (const sv of services.filter((s) => s.runtime === "node")) {
      const dir = this.serviceDir(d.app, d.releaseId, sv);
      if (!existsSync(join(dir, "package-lock.json"))) { report.push({ scanner: `npm-audit:${sv.name}`, available: true, ran: false, findings: 0, note: "no package-lock.json: nothing to audit" }); continue; }
      let out = ""; let ok = false;
      try { out = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: dir, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] }); ok = true; } catch (e) { out = (e as { stdout?: string }).stdout ?? ""; ok = /"vulnerabilities"/.test(out) && /"metadata"/.test(out); }
      if (!ok) { report.push({ scanner: `npm-audit:${sv.name}`, available: true, ran: false, findings: 0, note: "the advisory database could not be reached or npm failed: this scan did NOT run" }); continue; }
      const m = (JSON.parse(out) as { metadata?: { vulnerabilities?: Record<string, number> } }).metadata?.vulnerabilities ?? {}; const h = (m["high"] ?? 0) + (m["critical"] ?? 0);
      audited = true; high += h; report.push({ scanner: `npm-audit:${sv.name}`, available: true, ran: true, findings: h, note: `advisory data fetched from the npm registry at scan time; ${JSON.stringify(m)}` });
    }
    // 3) Java dependencies (optional: OSV-Scanner when installed; a scan that could not run is `unavailable`, never a pass)
    const javaReports: ScanReport[] = []; let javaBlocking = 0;
    for (const sv of services.filter((s) => s.runtime === "java")) {
      const rep = scanJava(this.serviceDir(d.app, d.releaseId, sv), { blockSeverity: this.policy.scanBlockSeverity });
      javaReports.push(rep); const ran = rep.status !== "unavailable"; if (rep.status === "failed") javaBlocking += rep.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[this.policy.scanBlockSeverity as Severity]).length;
      report.push({ scanner: `java-dependency-scan:${sv.name}`, available: ran, ran, findings: rep.findings.length, note: rep.note });
      this.log(d, rep.status === "unavailable" ? "warn" : "info", `java dependency scan ${sv.name}: ${rep.status}: ${rep.note}`);
    }
    high += javaBlocking;
    const data = { report, java: javaReports };
    if (hits || high) return { status: "failed", detail: `${hits} possible committed secret(s), ${high} high/critical dependency advisories`, data };
    const skipped = report.filter((r) => !r.ran && r.scanner !== "pso-secret-pattern-scan");
    if (skipped.length && this.policy.requireSecurityScan) return { status: "failed", detail: `the server policy requires scans, but ${skipped.map((s) => s.scanner).join(", ")} could not run`, data };
    // a scanner that did not run makes the stage `unavailable`: the checks that DID run are named, the ones that did not are named too
    if (skipped.length) return { status: "unavailable", detail: `ran: ${report.filter((r) => r.ran).map((r) => r.scanner).join(", ")}; NOT RUN (unavailable): ${skipped.map((s) => s.scanner).join(", ")}`, data };
    return { status: "passed", detail: `secret pattern scan passed${audited ? ", dependency audit passed" : ""}${javaReports.length ? ", java dependency scan passed" : ""}`, data };
  }

  // ---------------------------------------------------------------- retention
  // ---------------------------------------------------------------- operational visibility (read-only)
  private manifestOf(app: string, rid: string | undefined): Manifest | undefined { return rid ? readJson<Manifest | undefined>(join(this.releaseDir(app, rid), "manifest.json"), undefined) : undefined; }
  /** Ports PSO itself owns right now (running slots and their stable loopback listeners). */
  psoPorts(): Map<number, { app: string; service: string }> {
    const m = new Map<number, { app: string; service: string }>(); const home = this.state.home;
    for (const app of existsSync(P.apps(home)) ? readdirSync(P.apps(home)) : []) { const as = this.appState(app); for (const [svc, p] of Object.entries(as.stablePorts)) m.set(p, { app, service: svc }); const rid = as.active?.release; if (rid) for (const s of this.slots(app, rid)) m.set(s.port, { app, service: s.service }); }
    return m;
  }
  /** Exclusive section shared with every deployment that changes nginx. */
  exclusiveNginx<T>(fn: () => Promise<T>): Promise<T> { return this.withShared("nginx", fn); }

  /** Where the application runs and how to reach it, from the deployment metadata and the REAL nginx file; health is measured now. */
  async overview(app: string): Promise<unknown> {
    this.assertApp(app); const as = this.appState(app); const rid = as.active?.release; const m = this.manifestOf(app, rid);
    const hist = this.history(app, 10); const candidate = hist.find((x) => !TERMINAL.includes(x.state) && x.state !== "INTERRUPTED");
    const last = hist.find((x) => x.state === "COMPLETED" && x.releaseId === rid) ?? hist[0];
    const slots = rid ? this.slots(app, rid) : [];
    const servers: NginxServer[] = []; let proxy: Record<string, unknown> | undefined;
    if (as.nginxFile && existsSync(as.nginxFile)) { const text = readFileSync(as.nginxFile, "utf8"); servers.push(...parseNginx(text).servers); const pr = /# pso-release: (\S+)/.exec(text)?.[1]; proxy = { kind: "nginx", file: as.nginxFile, release: pr ?? null, matchesActiveRelease: pr === rid }; }
    const urls: Array<Record<string, unknown>> = [];
    for (const s of servers) for (const l of s.listens) {
      const loopback = l.address === undefined ? false : /^127\./.test(l.address) || l.address === "::1";
      const host = s.names.find((n) => n !== "_") ?? null; const scheme = l.ssl ? "https" : "http";
      const redirect = (s.returns ?? []).some((r) => /^30[1278]\s/.test(r));
      const locs = s.locations.length ? s.locations : [{ path: "/", proxyPass: undefined }];
      for (const loc of locs) urls.push({ scheme, host: loopback ? "127.0.0.1" : host, hostSource: loopback ? "loopback" : host ? "server_name" : "server-address", port: l.port, path: loc.path, visibility: loopback ? "private" : "public-binding", redirectsTo: redirect ? "https" : null, tls: l.ssl ? { certificate: s.certificate ?? null } : null, service: /pso_[a-z0-9_]+_([a-z0-9_]+)/.exec(loc.proxyPass ?? "")?.[1]?.replace(/_/g, "-") ?? null, source: as.nginxFile });
    }
    const services: unknown[] = [];
    for (const sv of m ? servicesOf(m.decl) : []) {
      const mine = slots.filter((s) => s.service === sv.name); const h = sv.health ?? {};
      const rows = await Promise.all(mine.map(async (s) => { const id = identityMatches(s); const probe = id.match ? await httpGet(s.port, h.readyPath ?? h.path ?? "/health/ready") : undefined; return { instance: s.instance, slot: s.slot, port: s.port, pid: s.pid ?? null, running: id.match, supervisor: s.supervisor ?? "process", unit: s.supervisor === "systemd" ? unitNameFor(s) : null, localHealth: probe ? { ok: probe.ok && probe.status === (h.expectStatus ?? 200), status: probe.status ?? null, error: probe.error ?? null, ms: probe.ms } : null }; }));
      const stable = as.stablePorts[sv.name]; const viaProxy = stable && rows.some((r) => r.running) ? await httpGet(stable, h.readyPath ?? h.path ?? "/health/ready") : undefined;
      services.push({ name: sv.name, runtime: sv.runtime, viaProxy: viaProxy ? { ok: viaProxy.ok && viaProxy.status === (h.expectStatus ?? 200), status: viaProxy.status ?? null, error: viaProxy.error ?? null, servesActiveRelease: String(viaProxy.headers?.["x-pso-release"] ?? "") === rid } : null, internalPort: sv.internalPort ?? null, stablePort: as.stablePorts[sv.name] ?? null, route: sv.route?.path ?? null, instances: rows });
    }
    return {
      app, environment: m?.decl.environment ?? null, environmentId: this.state.env().id, provider: null,
      release: { active: rid ?? null, activeSince: as.active?.since ?? null, previous: as.previous ?? null, lastKnownGood: as.lastKnownGood ?? null, candidate: candidate ? { release: candidate.releaseId, state: candidate.state, deployment: candidate.id } : null },
      strategy: m?.decl.strategy.type ?? null, deployment: last ? { id: last.id, kind: last.kind, state: last.state, startedAt: last.startedAt, finishedAt: last.finishedAt ?? null, durationMs: last.finishedAt ? Date.parse(last.finishedAt) - Date.parse(last.startedAt) : null } : null,
      runtime: { supervisor: m?.decl.runtime?.supervisor ?? "process" }, proxy: proxy ?? null, urls, services,
      tls: { enabled: urls.some((u) => u.tls), certificatePaths: [...new Set(servers.map((s) => s.certificate).filter(Boolean))] },
      rollback: { available: !!as.previous && m?.decl.strategy.rollback !== false, to: as.previous ?? null }, endpointsPublished: !!m?.endpoints,
    };
  }

  /** Runtime view: the PSO units with MEASURED values, and the infrastructure services of the host separately. */
  async runtimeView(): Promise<unknown> {
    const home = this.state.home; const apps = existsSync(P.apps(home)) ? readdirSync(P.apps(home)) : [];
    const rows: unknown[] = [];
    for (const app of apps) {
      const as = this.appState(app); const rid = as.active?.release; if (!rid) continue; const m = this.manifestOf(app, rid);
      for (const s of this.slots(app, rid)) {
        const id = identityMatches(s); const det = s.supervisor === "systemd" ? unitDetails(unitNameFor(s)) : { pid: s.pid ?? 0, restarts: 0, rssKb: undefined as number | undefined };
        const sv = m ? servicesOf(m.decl).find((x) => x.name === s.service) : undefined; const h = sv?.health ?? {};
        const probe = id.match ? await httpGet(s.port, h.readyPath ?? h.path ?? "/health/ready") : undefined;
        rows.push({ app, service: s.service, runtime: sv?.runtime ?? null, release: rid, instance: s.instance, slot: s.slot, supervisor: s.supervisor ?? "process", unit: s.supervisor === "systemd" ? unitNameFor(s) : null, pid: det.pid || null, running: id.match, identity: id.reason, address: `127.0.0.1:${s.port}`, startedAt: ("activeSince" in det ? det.activeSince : undefined) ?? s.startedAt ?? null, restarts: det.restarts, rssMb: det.rssKb ? Math.round(det.rssKb / 1024) : null, cpuSeconds: "cpuSeconds" in det ? det.cpuSeconds ?? null : null, health: probe ? (probe.ok && probe.status === (h.expectStatus ?? 200) ? "UP" : `DOWN (${probe.status ?? probe.error})`) : "not running" });
      }
    }
    const infra: unknown[] = [];
    for (const unit of ["postgresql", "redis-server", "rabbitmq-server", "nginx", "ssh", "kafka"]) {
      const a = probe("systemctl", ["is-active", unit]); if (a.out === "unknown" || (/inactive|failed/.test(a.out) && !probe("systemctl", ["cat", unit]).ok)) continue;
      const sh = probe("systemctl", ["show", unit, "-p", "MainPID,ActiveEnterTimestamp,MemoryCurrent,NRestarts"]); const kv: Record<string, string> = {}; for (const l of sh.out.split("\n")) { const i = l.indexOf("="); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
      const mem = Number(kv["MemoryCurrent"]); infra.push({ unit, state: a.out, managedBy: "system (not PSO)", pid: Number(kv["MainPID"]) || null, since: kv["ActiveEnterTimestamp"] || null, restarts: Number(kv["NRestarts"] ?? 0), memoryMb: Number.isFinite(mem) && mem > 0 && mem < 2 ** 60 ? Math.round(mem / 1048576) : null });
    }
    let mi = { total: 0, avail: 0 }; try { const t = readFileSync("/proc/meminfo", "utf8"); mi = { total: Number(/MemTotal:\s+(\d+)/.exec(t)?.[1]) / 1024, avail: Number(/MemAvailable:\s+(\d+)/.exec(t)?.[1]) / 1024 }; } catch { /* not linux */ }
    let load: string | undefined; try { load = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" "); } catch { /* not linux */ }
    return { applications: rows, infrastructure: infra, host: { memTotalMb: Math.round(mi.total), memAvailableMb: Math.round(mi.avail), loadAverage: load ?? null, measuredAt: nowIso() } };
  }

  /** Endpoints published WITH the active release. Nothing is invented: a release without metadata says so. */
  endpoints(app: string): unknown {
    this.assertApp(app); const rid = this.appState(app).active?.release; const m = this.manifestOf(app, rid);
    if (!m) return { app, release: rid ?? null, published: false, reason: "no active release", routes: [] };
    const meta = m.endpoints as { routes?: unknown[]; generatedAt?: string } | undefined;
    if (!meta?.routes) return { app, release: rid, published: false, reason: "this release carries no route metadata (publish it at build time with: pso routes:list --json --out pso-release.json inside the packaged service)", routes: [] };
    return { app, release: rid, published: true, generatedAt: meta.generatedAt ?? null, routes: meta.routes };
  }

  /** The effective environment of the application with secrets reduced to references. */
  appConfig(app: string): unknown {
    this.assertApp(app); const as = this.appState(app); const rid = as.active?.release; const m = this.manifestOf(app, rid); if (!m) return { app, release: null, services: [] };
    const services = servicesOf(m.decl).map((s) => {
      const env = Object.entries(s.env ?? {}).map(([k, v]) => { const masked = (redactValue({ [k]: v }) as Record<string, unknown>)[k] === "[REDACTED]" || looksSecret(String(v)); return { name: k, value: masked ? "[REDACTED]" : String(v), sensitive: masked }; });
      return { name: s.name, runtime: s.runtime, requires: s.requires ?? null, port: s.port ?? "auto", internalPort: s.internalPort ?? null, stablePort: as.stablePorts[s.name] ?? null, route: s.route?.path ?? null, health: s.health ?? null, shutdownGraceSeconds: s.shutdownGraceSeconds ?? 30, instances: s.instances ?? 1, env, secretReferences: Object.entries(s.secrets ?? {}).map(([envName, secret]) => ({ env: envName, secret })), workload: s.workload ?? null };
    });
    return { app, release: rid, environment: m.decl.environment, strategy: m.decl.strategy, runtime: m.decl.runtime ?? { supervisor: "process" }, infrastructure: m.decl.infrastructure?.requires ?? [], migrations: m.decl.migrations ? { mode: m.decl.migrations.mode, owner: m.decl.migrations.owner ?? null } : null, managedDirectories: { release: this.releaseDir(app, rid!), logs: join(this.appDir(app), "logs"), run: join(this.appDir(app), "run") }, services };
  }

  /** systemd: only the units of the ACTIVE release start at boot (lingering user manager); every other PSO unit of this app is disabled. */
  syncBootPersistence(app: string): void {
    const as = this.appState(app); const activeRelease = as.active?.release;
    for (const r of new Set([...as.releases, ...(activeRelease ? [activeRelease] : [])])) for (const s of this.slots(app, r)) {
      if (s.supervisor !== "systemd") continue;
      const unit = unitNameFor(s);
      // the unit must be PSO's and RUNNING (not necessarily with the slot's original token: a service action or a recovery may have started it again)
      const running = identityMatches(s).match || (ownedUnit(unit) && unitState(unit).active);
      setBootPersistence(unit, r === activeRelease && running);
    }
  }

  gc(app: string, keep: number): string[] {
    const as = this.appState(app); const protectedIds = new Set([as.active?.release, as.previous, as.lastKnownGood].filter(Boolean) as string[]);
    const sorted = [...as.releases].sort(); const removable = sorted.filter((r) => !protectedIds.has(r));
    const toKeep = Math.max(keep - protectedIds.size, 0); const drop = removable.slice(0, Math.max(removable.length - toKeep, 0));
    for (const r of drop) {
      for (const s of this.slots(app, r)) if (s.supervisor === "systemd") removeUnit({ ...s, runDir: s.runDir ?? join(this.appDir(app), "run") }); // its unit file and environment file go with the release
      rmSync(this.releaseDir(app, r), { recursive: true, force: true }); rmSync(this.slotDir(app, r), { recursive: true, force: true });
    }
    as.releases = as.releases.filter((r) => !drop.includes(r)); this.saveApp(as);
    return drop;
  }

  // ---------------------------------------------------------------- recovery of interrupted deployments
  /** Reconciles a deployment whose worker died: inspects what actually exists and either completes it, undoes it, or stops and asks for an operator. */
  async recover(app: string, actor: AuditActor): Promise<unknown> {
    this.assertApp(app);
    const lock = this.lock(app); const st = lock.status();
    const last = this.history(app, 5).find((x) => !isTerminal(x.state));
    if (st === "free" && !last) return { action: "none", note: "nothing to recover" };
    if (st === "held") return { action: "none", note: "a worker is alive and running this deployment; nothing to recover" };
    if (!last) { lock.release(lock.read()?.id ?? ""); return { action: "released-orphan-lock", note: "the lock had no unfinished deployment" }; }
    const d = last; const owner = lock.read();
    if (owner && !lock.adopt({ id: `recover-${d.id}`, purpose: "recovery", pid: process.pid }, owner.id)) throw new ProtocolError("CONFLICT", "could not take over the stale lock");
    const prevState = d.state; this.setState(d, "RECOVERING", `worker ${d.workerPid} is gone while the deployment was in ${prevState}`);
    const as = this.appState(app); const manifest = readJson<Manifest | undefined>(join(this.releaseDir(app, d.releaseId), "manifest.json"), undefined);
    const decl = manifest?.decl ?? (d.kind === "deploy" ? this.planFile(app, d.planHash).decl : undefined);
    const live = as.nginxFile && existsSync(as.nginxFile) ? /^# pso-release: (\S+)/m.exec(readFileSync(as.nginxFile, "utf8"))?.[1] : undefined;
    const proxy = decl?.strategy.proxy === "nginx";
    // the worker may be killed after nginx was rewritten but before the backup id reached the deployment record: the backup is named after the deployment
    const backupId = d.proxyBackupId ?? listBackups(this.state.home, app).find((x) => x.id.startsWith(`${d.id}-`))?.id;
    const slots = this.slots(app, d.releaseId); const prev = as.active?.release;
    const candidateAlive = slots.filter((s) => identityMatches(s).match);
    const stopCandidates = async (): Promise<void> => { for (const s of candidateAlive) { await stopSlot(s); s.status = "stopped"; this.saveSlot(s); this.ports(decl?.ports ?? undefined).release(s.port); } };
    const done = (state: DeployState, outcome: string, note: string): unknown => { this.syncBootPersistence(app); d.state = state; d.outcome = outcome; d.recovered = true; d.finishedAt = nowIso(); d.error = note; this.setState(d, state, note); this.audit.append("deploy.recovered", "ok", actor, { environment: this.state.env().id, app, deployment: d.id, release: d.releaseId }, { outcome, note }); lock.release(`recover-${d.id}`); return { action: outcome, deployment: d.id, state, note }; };
    try {
      if (decl?.strategy.type === "static") {
        // a static resource has no process to inspect: the site root and the nginx file say what really happened
        const sv = servicesOf(decl)[0]!; const sd = sv.static!; const site = this.siteRoot(sd.site);
        const rep = recoverSite(site);
        const dir = this.serviceDir(app, d.releaseId, sv); const dist = sd.publish && sd.publish !== "." ? join(dir, sd.publish) : dir;
        let name = ""; let version = "";
        try {
          if (sd.kind === "mei") { const m = parseManifest(readJson<unknown>(join(dist, "pso-manifest.json"), undefined)).manifest; if (!m) throw new Error("manifest"); name = m.name; version = m.version; }
          else { const fr = readFeiDist(dist); name = fr.name; version = fr.version; }
        } catch { return done("FAILED", "needs-operator", `the release files are no longer readable (${rep.removed.length} leftover file(s) swept): OPERATOR ACTION REQUIRED`); }
        const current = sd.kind === "mei" ? activePointer(site, name)?.version : readJson<{ version: string } | undefined>(join(site, "fei", "current.json"), undefined)?.version;
        // the pointer is the truth: an activation killed between its two writes only lacks its history entry, which is brought in line (only if the active version itself verifies)
        let repaired = false;
        if (current === version) { try { repaired = sd.kind === "mei" ? repairMeiHistory(site, name, "recovery") : repairFeiHistory(site, "recovery"); } catch { /* reported by the consistency check below */ } }
        const consistent = sd.kind === "mei" ? checkMei(site, name).length === 0 : true;
        if (current === version && consistent && (sd.kind === "mei" || !proxy || live === d.releaseId)) {
          as.previous = prev; as.active = { release: d.releaseId, since: nowIso(), slots: [] }; as.lastKnownGood = d.releaseId; if (!as.releases.includes(d.releaseId)) as.releases.push(d.releaseId); this.saveApp(as);
          return done("COMPLETED", "completed-by-recovery", repaired ? "the new version was already active; the interrupted activation lacked its history entry, which was written: the deployment was completed forward" : "the new version was already active on the site and consistent: the deployment was completed forward");
        }
        if (sd.kind === "fei" && proxy && live === d.releaseId && current !== version) {
          if (backupId) { const r = restoreProxy(this.state.home, this.policy, backupId); if (r.ok) return done("ROLLED_BACK", "rolled-back-by-recovery", "nginx already served the new shell configuration but the shell was not activated: the previous configuration was restored"); }
          return done("FAILED", "needs-operator", "nginx serves a configuration for a shell release that was never activated and it could not be restored automatically: OPERATOR ACTION REQUIRED");
        }
        return done("FAILED", "interrupted-before-switch", `interrupted before activation: the active version (${current ?? "none"}) was never touched; ${rep.removed.length} leftover file(s) were removed`);
      }
      if (proxy && live === d.releaseId && prev !== d.releaseId) {
        // traffic already moved to the candidate: decide on the real health of what is serving, not on the recorded step
        const ok = slots.length > 0 && candidateAlive.length === slots.length && (await Promise.all(slots.map((s) => httpGet(s.port, "/health/ready")))).every((r) => r.ok && r.status === 200);
        if (ok) { // complete forward: drain the previous release and record the candidate as active
          const prevSlots = prev ? this.slots(app, prev) : []; for (const s of prevSlots) { const r = await stopSlot(s); if (r.stopped) { s.status = "stopped"; this.saveSlot(s); } }
          as.previous = prev; as.active = { release: d.releaseId, since: nowIso(), slots: slots.map((s) => `${s.service}-${s.instance}`) }; as.lastKnownGood = d.releaseId; if (!as.releases.includes(d.releaseId)) as.releases.push(d.releaseId); this.saveApp(as); this.syncBootPersistence(app);
          return done("COMPLETED", "completed-by-recovery", "traffic had already moved and the candidate is healthy: the deployment was completed forward and the previous release drained");
        }
        if (backupId) { const r = restoreProxy(this.state.home, this.policy, backupId); if (r.ok) { await stopCandidates(); return done("ROLLED_BACK", "rolled-back-by-recovery", "traffic had moved but the candidate is not healthy: the previous proxy configuration was restored"); } }
        return done("FAILED", "needs-operator", "traffic moved to a candidate that is not healthy and the proxy could not be restored automatically: OPERATOR ACTION REQUIRED");
      }
      if (proxy && (live === prev || live === undefined) ) { await stopCandidates(); return done("FAILED", "interrupted-before-switch", "interrupted before traffic moved: the active release was never touched; the candidate was stopped"); }
      if (!proxy) {
        const prevAlive = prev ? this.slots(app, prev).some((s) => identityMatches(s).match) : false;
        if (candidateAlive.length && candidateAlive.length === slots.length) { const ok = (await Promise.all(slots.map((s) => httpGet(s.port, "/health/ready")))).every((r) => r.ok && r.status === 200); if (ok) { as.previous = prev; as.active = { release: d.releaseId, since: nowIso(), slots: slots.map((s) => `${s.service}-${s.instance}`) }; as.lastKnownGood = d.releaseId; if (!as.releases.includes(d.releaseId)) as.releases.push(d.releaseId); this.saveApp(as); this.syncBootPersistence(app); return done("COMPLETED", "completed-by-recovery", "the new release is running and healthy"); } }
        if (prevAlive || !prev) { await stopCandidates(); return done("FAILED", "interrupted-before-switch", "interrupted: the previous release is still running; the candidate was stopped"); }
      }
      return done("FAILED", "needs-operator", `ambiguous state (nginx serves ${live ?? "unknown"}, recorded active ${prev ?? "none"}, candidate ${d.releaseId}): nothing was changed. An authorized operator must inspect and decide (release:status, then release:rollback or a new deployment)`);
    } catch (e) { return done("FAILED", "needs-operator", `recovery could not finish: ${(e as Error).message}`); }
  }
}

// ------------------------------------------------------------------ helpers

// ------------------------------------------------------------------ static resource helpers
function readFileSyncGuard<T>(f: () => T): T { return f(); }

/** The managed nginx input of a shell deployment, derived from its declaration. */
export function staticVhost(app: string, release: string, decl: DeploymentDecl, site: string): StaticVhostInput {
  const sd = servicesOf(decl)[0]!.static!;
  return { app, release, site, fei: { basePath: sd.basePath ?? "/", ...(sd.api ? { api: sd.api } : {}), ...(sd.routes ? { routes: sd.routes } : {}), ...(sd.connectSrc ? { connectSrc: sd.connectSrc } : {}) }, nginx: decl.proxy?.nginx, ...(sd.probe?.port ? { probePort: sd.probe.port } : {}) };
}

/** One GET with an explicit Host header and the whole body (bounded), for verification through nginx. */
function httpFetch(port: number, path: string, host: string, timeoutMs = 5000): Promise<{ status?: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolveFetch) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host, "accept-encoding": "identity" }, timeout: timeoutMs }, (resp) => {
      const chunks: Buffer[] = []; let size = 0;
      resp.on("data", (c: Buffer) => { size += c.length; if (size <= 8 * 1024 * 1024) chunks.push(c); });
      resp.on("end", () => resolveFetch({ status: resp.statusCode, headers: Object.fromEntries(Object.entries(resp.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])), body: Buffer.concat(chunks) }));
    });
    r.on("timeout", () => { r.destroy(); resolveFetch({ headers: {}, body: Buffer.alloc(0) }); });
    r.on("error", () => resolveFetch({ headers: {}, body: Buffer.alloc(0) }));
    r.end();
  });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => { const h = createHash("sha256"); const s = createReadStream(file); s.on("data", (b) => h.update(b)); s.on("end", () => res(h.digest("hex"))); s.on("error", rej); });
}
/** Digest of a directory tree: relative paths and file contents (the .git directory excluded). Used to detect changes to a prepared release. */
export { treeDigest };
