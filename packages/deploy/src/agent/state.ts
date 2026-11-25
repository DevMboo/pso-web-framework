import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { PolicyHistoryEntry } from "../policy-compat.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonical, randomToken, sha256 } from "../crypto.ts";
import { redactValue } from "../redact.ts";
import type { Role } from "../protocol.ts";
import type { TrustedSigner } from "../signing.ts";

/**
 * Durable state of the runtime agent. Everything that decides what happens next lives in files below the agent home, so that a
 * deployment survives the end of the SSH session that started it, and so that a recovering operator can see the real situation.
 */
export const agentHome = (): string => process.env["PSO_AGENT_HOME"] ?? join(homedir(), ".pso-agent");

export const P = {
  identity: (h = agentHome()) => join(h, "identity"),
  serverKey: (h = agentHome()) => join(h, "identity", "server.key"),
  serverPub: (h = agentHome()) => join(h, "identity", "server.pub"),
  state: (h = agentHome()) => join(h, "state"),
  secrets: (h = agentHome()) => join(h, "secrets"),
  incoming: (h = agentHome()) => join(h, "incoming"),
  audit: (h = agentHome()) => join(h, "audit", "audit.log"),
  apps: (h = agentHome()) => join(h, "apps"),
  /** the site root a frontend resource publishes into (shared by a shell and its microfrontends) */
  site: (name: string, h = agentHome()) => join(h, "sites", name),
  app: (app: string, h = agentHome()) => join(h, "apps", app),
  nginx: (h = agentHome()) => join(h, "nginx"),
};

export function ensureDir(dir: string, mode = 0o700): void { mkdirSync(dir, { recursive: true, mode }); }

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
/** Atomic write: a reader never sees half a file, and a crash leaves either the old or the new content. */
export function writeJson(file: string, value: unknown, mode = 0o600): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomToken(4)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, file);
  try { chmodSync(file, mode); } catch { /* not supported on this file system */ }
}

export const nowIso = (): string => new Date().toISOString();

// ------------------------------------------------------------------ records
export interface ClientRecord { id: string; name: string; publicKey: string; role: Role; createdAt: string; createdBy: string; revoked?: boolean; revokedAt?: string; lastSeen?: string }
export interface EnrollToken { id: string; secretHash: string; role: Role; expiresAt: string; createdBy: string; createdAt: string; used?: boolean; usedAt?: string; usedBy?: string }
export interface SessionRecord { id: string; clientId: string; createdAt: string; expiresAt: string; idleExpiresAt: string; lastSeq: number; revoked?: boolean }
export interface Policy {
  version: 1;
  /** disabled: the agent refuses every operation; development: relaxed defaults; protected: production defaults */
  mode: "disabled" | "development" | "protected";
  /** distinct approvals (besides the plan being proposed) needed before a deployment may start */
  approvalsRequired: number;
  /** may the person who proposed a plan also approve it? (a solo developer: yes; a team: no) */
  selfApproval: boolean;
  allowCustomStages: boolean;
  allowedStrategies: Array<"blue-green" | "rolling" | "recreate" | "static">;
  /** deployments must name a commit (resolved from the branch or tag) or a checksummed artifact: always true, kept explicit for audit */
  requireImmutableSource: true;
  /** artifacts must carry a checksum in the plan (an unauthenticated checksum proves integrity of transfer, not authenticity) */
  requireArtifactChecksum: boolean;
  /** scanners that cannot run block deployment instead of being reported as skipped */
  requireSecurityScan: boolean;
  /** least number of releases kept (the active and the last known-good are always kept) */
  retentionMin: number;
  sessionHours: number;
  sessionIdleMinutes: number;
  maxPlanAgeMinutes: number;
  approvalTtlMinutes: number;
  allowDestructiveMigrations: boolean;
  /** how nginx is reloaded: directly (agent may do it) or through a narrowly scoped `sudo -n` rule */
  nginxPrivilege: "direct" | "sudo";
  /** directory for PSO-managed nginx files, and whether sites-available/sites-enabled are used instead */
  nginxManagedDir: string;
  /** absolute directory under which static frontends keep their site roots (nginx must be able to read it); default: <agent home>/sites. Chosen by the server's administrator */
  staticRoot?: string;
  nginxLayout: "pso.d" | "sites" | "conf.d";
  /** which runtime supervisors a deployment may ask for. Controlled by the server: a project declaration cannot widen it */
  supervisors: Array<"process" | "systemd">;
  /** the server refuses any release that is not signed by a trusted signer (see signing.ts); no declaration, pipeline or CLI option overrides it */
  requireSignedReleases: boolean;
  /** vulnerability scan severity that blocks a deployment when a scanner ran ("none" = report only) */
  scanBlockSeverity: "none" | "critical" | "high" | "medium" | "low";
  /** ports that are MEANT to listen on all interfaces (everything else on all interfaces is reported as potentially unsafe) */
  intentionallyPublicPorts: number[];
  /** single-server: internal infrastructure is expected on loopback; distributed: private-network addresses are accepted for it */
  infrastructureNetwork: "single-server" | "distributed";
}

export const defaultPolicy = (mode: Policy["mode"]): Policy => ({
  version: 1, mode,
  approvalsRequired: mode === "protected" ? 1 : 0,
  selfApproval: true,
  allowCustomStages: false,
  allowedStrategies: ["blue-green", "rolling", "recreate", "static"],
  requireImmutableSource: true,
  requireArtifactChecksum: true,
  requireSecurityScan: false,
  retentionMin: 3,
  sessionHours: mode === "protected" ? 8 : 24,
  sessionIdleMinutes: mode === "protected" ? 30 : 120,
  maxPlanAgeMinutes: mode === "protected" ? 60 : 24 * 60,
  approvalTtlMinutes: 60,
  allowDestructiveMigrations: false,
  nginxPrivilege: "sudo",
  nginxManagedDir: "/etc/nginx/pso.d",
  nginxLayout: "pso.d",
  supervisors: ["process", "systemd"],
  requireSignedReleases: false,
  scanBlockSeverity: "none",
  intentionallyPublicPorts: [22, 80, 443],
  infrastructureNetwork: "single-server",
});

export const policyHash = (p: Policy): string => sha256(canonical(p));

export class AgentState {
  readonly home: string;
  constructor(home = agentHome()) { this.home = home; }
  file(name: string): string { return join(P.state(this.home), name); }
  provisioned(): boolean { return existsSync(P.serverKey(this.home)) && existsSync(this.file("env.json")); }
  env(): { id: string; createdAt: string; label?: string } { return readJson(this.file("env.json"), { id: "", createdAt: "" } as { id: string; createdAt: string; label?: string }); }
  /** A policy file written by an older agent lacks the newer fields: they take their defaults (never a more permissive value than the default). */
  /** Public keys this ENVIRONMENT trusts to sign releases. Held by the server; changed only by a superadministrator, and audited. */
  trust(): TrustedSigner[] { return readJson<TrustedSigner[]>(this.file("trust.json"), []); }
  saveTrust(t: TrustedSigner[]): void { writeJson(this.file("trust.json"), t); }
  policy(): Policy { const p = readJson<Policy>(this.file("policy.json"), defaultPolicy("disabled")); return { ...defaultPolicy(p.mode), ...p }; }
  setPolicy(p: Policy): void { writeJson(this.file("policy.json"), p); }
  /** every policy change with the keys it touched and the whole policy before it: reversible and auditable (newest last, bounded) */
  policyHistory(): PolicyHistoryEntry[] { return readJson<PolicyHistoryEntry[]>(this.file("policy-history.json"), []); }
  appendPolicyHistory(e: PolicyHistoryEntry): void { writeJson(this.file("policy-history.json"), [...this.policyHistory(), e].slice(-100)); }
  savePolicyHistory(h: PolicyHistoryEntry[]): void { writeJson(this.file("policy-history.json"), h.slice(-100)); }
  clients(): ClientRecord[] { return readJson<ClientRecord[]>(this.file("clients.json"), []); }
  saveClients(c: ClientRecord[]): void { writeJson(this.file("clients.json"), c); }
  tokens(): EnrollToken[] { return readJson<EnrollToken[]>(this.file("enroll.json"), []); }
  saveTokens(t: EnrollToken[]): void { writeJson(this.file("enroll.json"), t); }
  sessions(): SessionRecord[] { return readJson<SessionRecord[]>(this.file("sessions.json"), []); }
  saveSessions(s: SessionRecord[]): void { writeJson(this.file("sessions.json"), s); }
}

// ------------------------------------------------------------------ locks
export interface LockOwner { id: string; purpose: string; pid: number; startedAt: string; heartbeatAt: string; actor?: string }

/** True when the process exists and is not a zombie (a killed process nobody has reaped yet is dead for every purpose here). */
export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); if (s.slice(s.lastIndexOf(")") + 2, s.lastIndexOf(")") + 3) === "Z") return false; } catch { /* no /proc: kill(0) is all we have */ }
  return true;
};

/**
 * A lock is a directory (mkdir is atomic). It records who holds it and a heartbeat. A lock whose owner process is gone is reported as
 * STALE; it is never stolen silently: recovery inspects the real state first (see engine `recover`).
 */
export class DirLock {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }
  read(): LockOwner | undefined { return readJson<LockOwner | undefined>(join(this.dir, "owner.json"), undefined); }
  status(): "free" | "held" | "stale" {
    if (!existsSync(this.dir)) return "free";
    const o = this.read();
    if (!o) return "stale";
    return pidAlive(o.pid) ? "held" : "stale";
  }
  tryAcquire(owner: Omit<LockOwner, "startedAt" | "heartbeatAt">): boolean {
    ensureDir(dirname(this.dir));
    try { mkdirSync(this.dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
    writeJson(join(this.dir, "owner.json"), { ...owner, startedAt: nowIso(), heartbeatAt: nowIso() });
    return true;
  }
  /** Takes over a stale lock for the recovery of the deployment that owned it. */
  adopt(owner: Omit<LockOwner, "startedAt" | "heartbeatAt">, expectedOwnerId: string): boolean {
    const o = this.read();
    if (this.status() !== "stale" || !o || o.id !== expectedOwnerId) return false;
    writeJson(join(this.dir, "owner.json"), { ...owner, startedAt: nowIso(), heartbeatAt: nowIso() });
    return true;
  }
  heartbeat(): void { const o = this.read(); if (o) writeJson(join(this.dir, "owner.json"), { ...o, heartbeatAt: nowIso() }); }
  release(ownerId: string): void { const o = this.read(); if (!o || o.id === ownerId) rmSync(this.dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ audit
export interface AuditActor { clientId?: string; name?: string; role?: string }
export interface AuditEntry { seq: number; ts: string; event: string; outcome: "ok" | "denied" | "failed" | "info"; actor: AuditActor; ids: Record<string, string | undefined>; data: unknown; prev: string; hash: string }

/**
 * The audit log: append-only JSON lines, sanitized, each entry hashing the one before it. This makes accidental or naive edits
 * detectable (`audit.verify`). It is NOT immutable: an administrator of the server can rewrite the whole chain. To protect it against
 * that, ship the log (or its latest hash) to a system the server's administrator does not control.
 */
export class AuditLog {
  private readonly home: string;
  constructor(home = agentHome()) { this.home = home; }
  private get file(): string { return P.audit(this.home); }
  append(event: string, outcome: AuditEntry["outcome"], actor: AuditActor, ids: AuditEntry["ids"], data: unknown = {}): void {
    ensureDir(dirname(this.file));
    const lock = new DirLock(join(P.state(this.home), "locks", "audit"));
    const deadline = Date.now() + 5000;
    while (!lock.tryAcquire({ id: `audit-${process.pid}`, purpose: "audit-append", pid: process.pid })) {
      if (lock.status() === "stale") rmSync(lock.dir, { recursive: true, force: true });
      if (Date.now() > deadline) break; // never block an operation on the log; the entry is still written
      const t = Date.now() + 15; while (Date.now() < t) { /* brief spin */ }
    }
    try {
      const last = this.last();
      const body = { seq: last ? last.seq + 1 : 1, ts: nowIso(), event, outcome, actor, ids, data: redactValue(data), prev: last ? last.hash : "genesis" };
      const fd = openSync(this.file, "a", 0o600);
      try { appendFileSync(fd, JSON.stringify({ ...body, hash: sha256(canonical(body)) }) + "\n"); } finally { closeSync(fd); }
    } finally { lock.release(`audit-${process.pid}`); }
  }
  private all(): AuditEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as AuditEntry; } catch { return undefined as unknown as AuditEntry; } });
  }
  last(): AuditEntry | undefined { const a = this.all(); return a[a.length - 1]; }
  read(limit = 200, filter?: { event?: string; deployment?: string }): AuditEntry[] {
    let a = this.all().filter(Boolean);
    if (filter?.event) a = a.filter((e) => e.event.startsWith(filter.event!));
    if (filter?.deployment) a = a.filter((e) => e.ids["deployment"] === filter.deployment);
    return a.slice(-limit);
  }
  verify(): { ok: boolean; entries: number; head: string; brokenAt?: number } {
    let prev = "genesis"; let n = 0;
    for (const e of this.all()) {
      n++;
      if (!e) return { ok: false, entries: n, head: prev, brokenAt: n };
      const { hash, ...body } = e;
      if (body.prev !== prev || sha256(canonical(body)) !== hash) return { ok: false, entries: n, head: prev, brokenAt: n };
      prev = hash;
    }
    return { ok: true, entries: n, head: prev };
  }
}

export const listDir = (d: string): string[] => (existsSync(d) ? readdirSync(d) : []);
export const isDir = (d: string): boolean => { try { return statSync(d).isDirectory(); } catch { return false; } };
