import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync, writeSync, closeSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline";
import { lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fingerprint, sha256 } from "../crypto.ts";
import { verifySigned, type SignedManifest } from "../signing.ts";
import { assessExposure, discoverNginx, findingsOf, inspectPrivilege, lintNginx, readListeners, readProcessOwners } from "./visibility.ts";
import { AGENT_VERSION, MAX_MESSAGE_BYTES, OPERATIONS, ProtocolError, ROLES, roleRank, type ErrorCode, type OperationName, type Request, type Response, type Role } from "../protocol.ts";
import { redactText, redactValue, registerSecret } from "../redact.ts";
import { Auth, type Principal } from "./auth.ts";
import { Engine, sha256File } from "./engine.ts";
import { inspect, listeningPorts } from "./inspect.ts";
import { MARKER, applyProxy, assertSafeWriteTarget, defaultDiscoveryDirs, discoverVhosts, findNginx, listBackups, nginxReload, nginxTest, restoreProxy } from "./nginx.ts";
import { compatibility, digestOf, MIGRATIONS, previewMigration, type PolicyHistoryEntry } from "../policy-compat.ts";
import { AgentState, AuditLog, P, defaultPolicy, ensureDir, nowIso, writeJson, type Policy } from "./state.ts";

/** The protocol endpoint: one instance per connection (per SSH session). It owns no network socket. */
export type SpawnWorker = (app: string, id: string) => { pid: number | undefined };

export const defaultSpawnWorker: SpawnWorker = (app, id) => {
  const entry = process.env["PSO_AGENT_ENTRY"] ?? process.argv[1]!;
  const c = spawn(process.execPath, [...process.execArgv, entry, "worker", app, id], { detached: true, stdio: "ignore", env: { ...process.env }, windowsHide: true });
  c.unref();
  return { pid: c.pid };
};

const POLICY_KEYS: Record<string, "boolean" | "number" | "string" | "strategies" | "supervisors" | "ports"> = {
  staticRoot: "string",
  approvalsRequired: "number", selfApproval: "boolean", allowCustomStages: "boolean", allowedStrategies: "strategies", requireArtifactChecksum: "boolean", requireSecurityScan: "boolean",
  retentionMin: "number", sessionHours: "number", sessionIdleMinutes: "number", maxPlanAgeMinutes: "number", approvalTtlMinutes: "number", allowDestructiveMigrations: "boolean",
  nginxPrivilege: "string", nginxManagedDir: "string", nginxLayout: "string", mode: "string",
  requireSignedReleases: "boolean", supervisors: "supervisors", scanBlockSeverity: "string", intentionallyPublicPorts: "ports", infrastructureNetwork: "string",
};

const need = (cond: unknown, msg: string): void => { if (!cond) throw new ProtocolError("BAD_REQUEST", msg); };
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, what: string, re = /^[A-Za-z0-9._-]{1,128}$/): string => { if (typeof v !== "string" || !re.test(v)) throw new ProtocolError("BAD_REQUEST", `invalid ${what}`); return v; };

export class AgentServer {
  readonly state: AgentState; readonly audit: AuditLog; readonly auth: Auth;
  private readonly spawnWorker: SpawnWorker;
  constructor(home?: string, spawnWorker: SpawnWorker = defaultSpawnWorker, source?: string) {
    this.spawnWorker = spawnWorker; this.state = new AgentState(home); this.audit = new AuditLog(this.state.home); this.auth = new Auth(this.state, this.audit, source);
  }

  async handle(req: Request): Promise<Response> {
    const id = typeof req?.id === "number" ? req.id : 0;
    try {
      if (!req || typeof req.op !== "string") throw new ProtocolError("BAD_REQUEST", "malformed request");
      if (!(req.op in OPERATIONS)) throw new ProtocolError("UNKNOWN_OPERATION", `unknown operation "${req.op}"`);
      const args = obj(req.args);
      switch (req.op as OperationName) {
        case "hello": return ok(id, this.auth.hello(args as { versions?: number[]; challenge?: string }), true);
        case "enroll": return ok(id, this.auth.enroll(args), true);
        case "session.open": return ok(id, this.auth.openSession(args), true);
      }
      const who = this.auth.authorize(req);
      const result = await this.dispatch(req.op as OperationName, args, who);
      return ok(id, result, RAW_OPS.has(req.op));
    } catch (e) {
      if (e instanceof ProtocolError) return fail(id, e.code, e.message);
      return fail(id, "INTERNAL", "internal error (details are in the agent's audit log, sanitized)");
    }
  }

  private actor(w: Principal) { return { clientId: w.clientId, name: w.name, role: w.role }; }

  private async dispatch(op: OperationName, a: Record<string, unknown>, who: Principal): Promise<unknown> {
    const st = this.state; const engine = new Engine(st, this.audit); const actor = this.actor(who);
    const app = (): string => str(a["app"], "app", /^[a-z][a-z0-9-]{0,62}$/);
    switch (op) {
      case "whoami": return { ...who, environmentId: st.env().id, environment: st.env().label ?? null, mode: st.policy().mode, agentVersion: AGENT_VERSION };
      case "session.close": this.auth.closeSession(); return { closed: true };
      case "inspect": return inspect(st);
      case "policy.get": return st.policy();
      case "policy.set": return this.setPolicy(obj(a["changes"]), who);
      case "policy.compat": return compatibility(st.policy(), AGENT_VERSION);
      case "policy.history": return { entries: st.policyHistory().map(({ before: _b, ...e }) => e) };
      case "policy.migrate": return this.migratePolicy(str(a["id"], "id", /^[a-z][a-z0-9-]{0,62}$/), a["digest"], a["preview"] === true, who);
      case "policy.revert": return this.revertPolicy(str(a["entry"], "entry", /^ph[0-9a-z]{6,24}$/), who);
      case "release.propose": {
        const art = a["artifact"] ? this.artifactRef(obj(a["artifact"])) : undefined;
        return engine.propose(a["declaration"], a["pipeline"] ? (a["pipeline"] as never) : undefined, actor, art, a["signed"] ? (obj(a["signed"]) as unknown as SignedManifest) : undefined);
      }
      case "network.exposure": return this.exposure();
      case "privilege.inspect": return inspectPrivilege();
      case "app.overview": return engine.overview(app());
      case "services.runtime": return engine.runtimeView();
      case "endpoints.list": return engine.endpoints(app());
      case "app.config": return engine.appConfig(app());
      case "nginx.discover": { const d = discoverNginx({ managedDir: st.policy().nginxManagedDir }); return { ...d, files: d.files.map(({ servers, upstreams, ...f }) => ({ ...f, servers, upstreams })) }; }
      case "nginx.read": return this.nginxRead(str(a["file"], "file", /^\/[A-Za-z0-9_.\/-]{1,200}$/));
      case "nginx.backups": return listBackups(st.home, app());
      case "nginx.apply": return engine.exclusiveNginx(async () => this.nginxApply(a, actor));
      case "trust.list": return st.trust().map((s) => ({ keyId: s.keyId, name: s.name, addedAt: s.addedAt, addedBy: s.addedBy, apps: s.apps ?? null, notAfter: s.notAfter ?? null, revokedAt: s.revokedAt ?? null, revokedReason: s.revokedReason ?? null, publicKey: s.publicKey }));
      case "trust.add": {
        const publicKey = str(a["publicKey"], "publicKey", /^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\s*$/); const name = str(a["name"], "name", /^[A-Za-z][A-Za-z0-9 ._@-]{0,62}$/);
        let keyId: string; try { keyId = fingerprint(publicKey); } catch { throw new ProtocolError("BAD_REQUEST", "that is not a valid public key"); }
        const apps = a["apps"] === undefined ? undefined : (Array.isArray(a["apps"]) ? (a["apps"] as unknown[]).map((x) => str(x, "app", /^[a-z][a-z0-9-]{0,62}$/)) : (need(false, "apps is a list of application names"), []));
        const notAfter = a["notAfter"] === undefined ? undefined : (need(typeof a["notAfter"] === "string" && !Number.isNaN(Date.parse(a["notAfter"] as string)), "notAfter is a date"), a["notAfter"] as string);
        const list = st.trust(); const existing = list.find((s) => s.keyId === keyId);
        if (existing) throw new ProtocolError("CONFLICT", existing.revokedAt ? "that key was revoked here; a revoked key is never trusted again (generate a new one)" : "that signer is already trusted");
        list.push({ keyId, name, publicKey: publicKey.trim() + "\n", addedAt: nowIso(), addedBy: who.name, ...(apps ? { apps } : {}), ...(notAfter ? { notAfter } : {}) }); st.saveTrust(list);
        this.audit.append("trust.signer-added", "ok", actor, { environment: st.env().id }, { keyId, name, apps: apps ?? "all", notAfter: notAfter ?? null });
        return { keyId, name };
      }
      case "trust.revoke": {
        const keyId = str(a["keyId"], "keyId", /^SHA256:[A-Za-z0-9+/]{43}$/); const list = st.trust(); const s = list.find((x) => x.keyId === keyId);
        if (!s) throw new ProtocolError("NOT_FOUND", "unknown signer");
        if (s.revokedAt) return { keyId, revoked: true, already: true };
        s.revokedAt = nowIso(); if (typeof a["reason"] === "string") s.revokedReason = (a["reason"] as string).slice(0, 200); st.saveTrust(list);
        this.audit.append("trust.signer-revoked", "ok", actor, { environment: st.env().id }, { keyId, name: s.name, reason: s.revokedReason ?? null });
        return { keyId, revoked: true };
      }
      case "signature.verify": {
        const src = obj(a["source"]); need(src["kind"] === "git" || src["kind"] === "artifact", "source.kind is git or artifact");
        return verifySigned(obj(a["signed"]) as unknown as SignedManifest, st.trust(), { app: str(a["app"], "app", /^[a-z][a-z0-9-]{0,62}$/), source: (src["kind"] === "git" ? { kind: "git", commit: str(src["commit"], "commit", /^[0-9a-f]{40,64}$/) } : { kind: "artifact", sha256: str(src["sha256"], "sha256", /^[0-9a-f]{64}$/) }) });
      }
      case "release.approve": return engine.approve(app(), a["planHash"], actor);
      case "release.start": return engine.effective(engine.start(app(), a["planHash"], actor, this.spawnWorker));
      case "release.cancel": return engine.cancel(app(), a["deployment"], actor);
      case "release.rollback": return engine.effective(engine.rollback(app(), actor, a["to"], this.spawnWorker));
      case "release.recover": return engine.recover(app(), actor);
      case "release.status": return engine.status(app(), a["deployment"]);
      case "release.history": return engine.history(app(), Number(a["limit"] ?? 30)).map((d) => engine.effective(d));
      case "release.list": return engine.releases(app());
      case "release.get": { const d = engine.deployment(app(), str(a["deployment"], "deployment")); if (!d) throw new ProtocolError("NOT_FOUND", "unknown deployment"); return engine.effective(d); }
      case "release.plans": return engine.plans(app());
      case "release.gc": { const removed = engine.gc(app(), st.policy().retentionMin); this.audit.append("release.gc", "ok", actor, { environment: st.env().id, app: app() }, { removed }); return { removed }; }
      case "logs.read": this.registerStoredSecrets(); return engine.logs(app(), { deployment: a["deployment"], service: a["service"], bytes: a["bytes"] });
      case "service.status": return engine.serviceStatus(app());
      case "service.restart": return engine.serviceAction(app(), a["service"], "restart", actor);
      case "service.start": return engine.serviceAction(app(), a["service"], "start", actor);
      case "service.stop": return engine.serviceAction(app(), a["service"], "stop", actor);
      case "proxy.status": {
        const vh = discoverVhosts(defaultDiscoveryDirs(st.policy()));
        return { nginx: findNginx() ?? null, managedDir: st.policy().nginxManagedDir, vhosts: vh, note: `files starting with "${MARKER}" are PSO-managed; everything else is external and is never modified` };
      }
      case "audit.read": return this.audit.read(Math.min(Number(a["limit"] ?? 100), 1000), { ...(typeof a["event"] === "string" ? { event: a["event"] } : {}), ...(typeof a["deployment"] === "string" ? { deployment: a["deployment"] } : {}) });
      case "audit.verify": return this.audit.verify();
      case "client.list": return st.clients().map((c) => ({ id: c.id, name: c.name, role: c.role, createdAt: c.createdAt, createdBy: c.createdBy, revoked: !!c.revoked, lastSeen: c.lastSeen }));
      case "client.revoke": {
        const id = str(a["clientId"], "clientId", /^SHA256:[A-Za-z0-9+/]{43}$/);
        const clients = st.clients(); const c = clients.find((x) => x.id === id); if (!c) throw new ProtocolError("NOT_FOUND", "unknown client");
        if (roleRank(c.role) > roleRank(who.role)) throw new ProtocolError("FORBIDDEN", "a client with a higher role cannot be revoked by a lower one");
        if (c.role === "superadmin" && clients.filter((x) => x.role === "superadmin" && !x.revoked).length <= 1) throw new ProtocolError("POLICY", "the last superadministrator cannot be revoked (enroll another first)");
        c.revoked = true; c.revokedAt = nowIso(); st.saveClients(clients);
        st.saveSessions(st.sessions().map((s) => (s.clientId === id ? { ...s, revoked: true } : s))); // every session of that client ends now
        this.audit.append("client.revoked", "ok", actor, { environment: st.env().id }, { target: id, targetName: c.name });
        return { revoked: true };
      }
      case "client.role": {
        const id = str(a["clientId"], "clientId", /^SHA256:[A-Za-z0-9+/]{43}$/); const role = a["role"] as Role; need(ROLES.includes(role), "invalid role");
        const clients = st.clients(); const c = clients.find((x) => x.id === id); if (!c) throw new ProtocolError("NOT_FOUND", "unknown client");
        if (c.role === "superadmin" && role !== "superadmin" && clients.filter((x) => x.role === "superadmin" && !x.revoked).length <= 1) throw new ProtocolError("POLICY", "the last superadministrator keeps the role");
        const before = c.role; c.role = role; st.saveClients(clients); st.saveSessions(st.sessions().map((s) => (s.clientId === id ? { ...s, revoked: true } : s)));
        this.audit.append("client.role", "ok", actor, { environment: st.env().id }, { target: id, from: before, to: role });
        return { id, role };
      }
      case "enroll.create": {
        const role = (a["role"] as Role) ?? "deployer"; need(ROLES.includes(role), "invalid role");
        if (roleRank(role) > roleRank(who.role) || (role === "superadmin" && who.role !== "superadmin")) throw new ProtocolError("FORBIDDEN", "an enrollment token cannot grant a role above the creator's own");
        const t = Auth.createToken(st, role, Number(a["minutes"] ?? 15), who.name);
        this.audit.append("enroll.token-created", "ok", actor, { environment: st.env().id }, { role, expiresAt: t.expiresAt, tokenId: t.id });
        return { token: t.token, expiresAt: t.expiresAt, role, note: "single use; shown once" };
      }
      case "secret.set": {
        const name = str(a["name"], "secret name", /^[A-Za-z][A-Za-z0-9._-]{0,63}$/); need(typeof a["value"] === "string" && (a["value"] as string).length > 0 && (a["value"] as string).length < 64 * 1024, "a value is required");
        ensureDir(P.secrets(st.home)); const f = join(P.secrets(st.home), name); writeFileSync(f, a["value"] as string, { mode: 0o600 }); try { chmodSync(f, 0o600); } catch { /* not supported */ }
        this.audit.append("secret.set", "ok", actor, { environment: st.env().id }, { name }); // the value is never audited
        return { name, stored: true };
      }
      case "secret.list": return existsSync(P.secrets(st.home)) ? readdirSync(P.secrets(st.home)).sort() : [];
      case "secret.remove": { const name = str(a["name"], "secret name", /^[A-Za-z][A-Za-z0-9._-]{0,63}$/); rmSync(join(P.secrets(st.home), name), { force: true }); this.audit.append("secret.removed", "ok", actor, { environment: st.env().id }, { name }); return { removed: true }; }
      case "provision.plan": return this.provisionPlan();
      case "provision.apply": return this.provisionApply(actor);
      case "artifact.begin": {
        need(Number.isInteger(a["size"]) && (a["size"] as number) > 0 && (a["size"] as number) <= 2 * 1024 ** 3, "invalid size"); const sum = str(a["sha256"], "sha256", /^[0-9a-f]{64}$/);
        const uploadId = `u${Date.now().toString(36)}${sha256(String(Math.random())).slice(0, 6)}`; ensureDir(join(P.incoming(st.home), uploadId));
        writeJson(join(P.incoming(st.home), uploadId, "meta.json"), { size: a["size"], sha256: sum, received: 0, next: 0, by: who.clientId });
        return { uploadId };
      }
      case "artifact.chunk": {
        const uploadId = str(a["uploadId"], "uploadId", /^u[0-9a-z]{6,24}$/); const dir = join(P.incoming(st.home), uploadId); const mf = join(dir, "meta.json");
        if (!existsSync(mf)) throw new ProtocolError("NOT_FOUND", "unknown upload"); const meta = JSON.parse(readFileSync(mf, "utf8")) as { size: number; received: number; next: number; by: string };
        if (meta.by !== who.clientId) throw new ProtocolError("FORBIDDEN", "this upload belongs to another client");
        need(a["index"] === meta.next, "chunks must arrive in order"); need(typeof a["data"] === "string", "data required");
        const buf = Buffer.from(a["data"] as string, "base64"); if (meta.received + buf.length > meta.size) throw new ProtocolError("BAD_REQUEST", "more data than declared");
        const fd = openSync(join(dir, "artifact.tgz"), "a", 0o600); try { writeSync(fd, buf); } finally { closeSync(fd); }
        meta.received += buf.length; meta.next++; writeJson(mf, meta); return { received: meta.received };
      }
      case "artifact.commit": {
        const uploadId = str(a["uploadId"], "uploadId", /^u[0-9a-z]{6,24}$/); const dir = join(P.incoming(st.home), uploadId); const mf = join(dir, "meta.json");
        if (!existsSync(mf)) throw new ProtocolError("NOT_FOUND", "unknown upload"); const meta = JSON.parse(readFileSync(mf, "utf8")) as { size: number; sha256: string; received: number };
        if (meta.received !== meta.size) throw new ProtocolError("PRECONDITION", `incomplete upload: ${meta.received} of ${meta.size} bytes`);
        const actual = await sha256File(join(dir, "artifact.tgz"));
        if (actual !== meta.sha256) { rmSync(dir, { recursive: true, force: true }); throw new ProtocolError("PRECONDITION", "checksum mismatch after transfer: the upload was discarded"); }
        this.audit.append("artifact.received", "ok", actor, { environment: st.env().id }, { uploadId, sha256: actual, size: meta.size });
        return { uploadId, sha256: actual, size: meta.size, verified: "checksum of the transferred bytes (this proves transfer integrity, not who built the artifact)" };
      }
      default: throw new ProtocolError("UNKNOWN_OPERATION", `operation ${op} is not available`);
    }
  }

  /** Secrets live on this host: load them into the redactor so that application logs, which the application writes, cannot return one. */
  private registerStoredSecrets(): void {
    const dir = P.secrets(this.state.home); if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) { try { registerSecret(readFileSync(join(dir, f), "utf8").trimEnd()); } catch { /* unreadable */ } }
  }

  private artifactRef(a: Record<string, unknown>): { uploadId: string; sha256: string; size: number } {
    const uploadId = str(a["uploadId"], "uploadId", /^u[0-9a-z]{6,24}$/); const mf = join(P.incoming(this.state.home), uploadId, "meta.json");
    if (!existsSync(mf)) throw new ProtocolError("NOT_FOUND", "unknown upload");
    const m = JSON.parse(readFileSync(mf, "utf8")) as { size: number; sha256: string; received: number };
    if (m.received !== m.size) throw new ProtocolError("PRECONDITION", "the upload is not complete");
    return { uploadId, sha256: m.sha256, size: m.size };
  }

  private setPolicy(changes: Record<string, unknown>, who: Principal): unknown {
    const cur = this.state.policy(); const next: Record<string, unknown> = { ...cur }; const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, raw] of Object.entries(changes)) {
      const kind = POLICY_KEYS[k]; if (!kind) throw new ProtocolError("BAD_REQUEST", `unknown policy setting "${k}"`);
      const v = (kind === "strategies" || kind === "supervisors" || kind === "ports") && typeof raw === "string" ? raw.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (kind === "ports" ? Number(x) : x)) : raw; // a CLI sends "a,b"
      if (kind === "boolean") need(typeof v === "boolean", `${k} is true or false`);
      if (kind === "number") need(typeof v === "number" && v >= 0 && v <= 100000, `${k} is a number`);
      if (kind === "string") need(typeof v === "string" && v.length < 300, `${k} is a string`);
      if (kind === "strategies") need(Array.isArray(v) && v.length > 0 && v.every((x) => ["blue-green", "rolling", "recreate", "static"].includes(String(x))), "allowedStrategies lists blue-green, rolling and/or recreate");
      if (kind === "supervisors") need(Array.isArray(v) && v.length > 0 && v.every((x) => ["process", "systemd"].includes(String(x))), "supervisors lists process and/or systemd");
      if (kind === "ports") need(Array.isArray(v) && v.every((x) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 65535), "intentionallyPublicPorts lists ports 1-65535");
      if (k === "infrastructureNetwork") need(v === "single-server" || v === "distributed", "infrastructureNetwork is single-server or distributed");
      if (k === "scanBlockSeverity") need(["none", "critical", "high", "medium", "low"].includes(String(v)), "scanBlockSeverity is none, critical, high, medium or low");
      if (k === "mode") need(["disabled", "development", "protected"].includes(String(v)), "mode is disabled, development or protected");
      if (k === "nginxPrivilege") need(v === "direct" || v === "sudo", "nginxPrivilege is direct or sudo");
      if (k === "nginxLayout") need(["pso.d", "sites", "conf.d"].includes(String(v)), "nginxLayout is pso.d, sites or conf.d");
      if (k === "staticRoot") need(typeof v === "string" && /^\/[A-Za-z0-9_./-]{1,200}$/.test(v) && !v.split("/").includes("..") && !v.includes("//"), "staticRoot is an absolute path without .. segments");
      if (k === "nginxManagedDir") need(/^\/[A-Za-z0-9_./-]+$/.test(String(v)), "nginxManagedDir is an absolute path");
      if (JSON.stringify(cur[k as keyof Policy]) !== JSON.stringify(v)) diff[k] = { from: cur[k as keyof Policy], to: v };
      next[k] = v;
    }
    if (next["mode"] === "protected" && (next["approvalsRequired"] as number) < 1 && cur.mode !== "protected" && changes["approvalsRequired"] === undefined) next["approvalsRequired"] = 1;
    this.state.setPolicy(next as unknown as Policy);
    if (Object.keys(diff).length) this.state.appendPolicyHistory({ id: `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: nowIso(), by: this.actor(who).name ?? "unknown", kind: "set", changes: diff, before: cur });
    this.audit.append("policy.changed", "ok", this.actor(who), { environment: this.state.env().id }, diff);
    return { changed: diff, policy: next };
  }

  /**
   * Applies one named migration. Without `digest` (or with preview) nothing changes: the exact difference is returned. Applying requires the digest of the
   * difference that was previewed, so a policy that moved in between is refused instead of being changed in a way nobody looked at.
   */
  private migratePolicy(id: string, digest: unknown, preview: boolean, who: Principal): unknown {
    const m = MIGRATIONS.find((x) => x.id === id); if (!m) throw new ProtocolError("NOT_FOUND", `unknown policy migration "${id}"`);
    const cur = this.state.policy(); const pv = previewMigration(m, cur);
    if (preview || digest === undefined) return { applied: false, preview: pv };
    if (!pv.pending) return { applied: false, preview: pv, note: "the policy already satisfies this migration: nothing to change" };
    if (digest !== pv.digest) throw new ProtocolError("PLAN_STALE", "the difference changed since it was previewed: preview it again");
    const next = { ...cur, ...Object.fromEntries(Object.entries(pv.changes).map(([k, v]) => [k, v.to])) } as Policy;
    this.state.setPolicy(next);
    const entry: PolicyHistoryEntry = { id: `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: nowIso(), by: this.actor(who).name ?? "unknown", kind: "migration", migration: id, changes: pv.changes, before: cur };
    this.state.appendPolicyHistory(entry);
    this.audit.append("policy.migrated", "ok", this.actor(who), { environment: this.state.env().id }, { migration: id, changes: pv.changes, entry: entry.id });
    return { applied: true, entry: entry.id, changes: pv.changes };
  }

  /** Undoes one history entry by restoring the previous value of each key it changed, only while those keys still hold the value the entry set. */
  private revertPolicy(entryId: string, who: Principal): unknown {
    const hist = this.state.policyHistory(); const e = hist.find((x) => x.id === entryId);
    if (!e) throw new ProtocolError("NOT_FOUND", "unknown policy history entry");
    if (e.revertedBy) throw new ProtocolError("CONFLICT", "this entry was already reverted");
    const cur = this.state.policy() as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(e.changes)) if (digestOf("v", { x: { from: null, to: cur[k] } }) !== digestOf("v", { x: { from: null, to: v.to } })) throw new ProtocolError("CONFLICT", `"${k}" was changed again after this entry: revert the later change first`);
    const next = { ...cur, ...Object.fromEntries(Object.entries(e.changes).map(([k, v]) => [k, v.from])) } as unknown as Policy;
    this.state.setPolicy(next);
    const rid = `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    e.revertedBy = rid; this.state.savePolicyHistory(hist);
    this.state.appendPolicyHistory({ id: rid, at: nowIso(), by: this.actor(who).name ?? "unknown", kind: "revert", changes: Object.fromEntries(Object.entries(e.changes).map(([k, v]) => [k, { from: v.to, to: v.from }])), before: this.state.policy() });
    this.audit.append("policy.reverted", "ok", this.actor(who), { environment: this.state.env().id }, { entry: entryId, restored: Object.fromEntries(Object.entries(e.changes).map(([k, v]) => [k, v.from])) });
    return { reverted: entryId, restored: Object.fromEntries(Object.entries(e.changes).map(([k, v]) => [k, v.from])) };
  }

  private exposure(): unknown {
    const st = this.state; const p = st.policy(); const eng = new Engine(st, this.audit); const ngx = discoverNginx({ managedDir: p.nginxManagedDir });
    const declared = new Set<number>(); for (const f of ngx.files) if (f.managedBy === "pso") for (const s of f.servers) for (const l of s.listens) if (!(l.address && /^127\./.test(l.address))) declared.add(l.port);
    const listeners = assessExposure({ listeners: readListeners(), owners: readProcessOwners(), policy: { intentionallyPublicPorts: p.intentionallyPublicPorts, infrastructureNetwork: p.infrastructureNetwork }, psoPorts: eng.psoPorts(), nginxDeclaredPorts: declared });
    const findings = findingsOf(listeners); const by = (v: string): number => listeners.filter((x) => x.verdict === v).length;
    return { measuredAt: nowIso(), policy: { intentionallyPublicPorts: p.intentionallyPublicPorts, infrastructureNetwork: p.infrastructureNetwork }, listeners, findings, summary: { loopbackOnly: listeners.filter((x) => x.binding === "loopback").length, intentionallyPublic: by("intentionally-public"), unexpectedAllInterfaces: by("unexpected-all-interfaces"), unexpectedPrivate: by("unexpected-private-binding"), unclassified: by("unclassified-all-interfaces") }, notes: ["Reachability from outside is UNKNOWN to the server itself: a listener on all interfaces may still be blocked by a firewall or cloud network rule. A client machine can verify it separately.", "Process names are only known for processes of the agent's own user; for the rest the component is inferred from the well-known port and labelled so."], remediation: "PSO generates a plan (see findings.remediation) and never changes infrastructure itself: an administrator applies it." };
  }

  private nginxRead(file: string): unknown {
    const d = discoverNginx({ managedDir: this.state.policy().nginxManagedDir }); const f = d.files.find((x) => x.path === file); if (!f) throw new ProtocolError("NOT_FOUND", "that file is not part of the nginx configuration PSO can see");
    if (f.size > 256 * 1024) throw new ProtocolError("PRECONDITION", "file is larger than 256 KB");
    const text = readFileSync(file, "utf8"); return { path: f.path, kind: f.kind, managedBy: f.managedBy, app: f.app ?? null, release: f.release ?? null, symlinkTarget: f.symlinkTarget ?? null, editable: f.managedBy === "pso" && !!f.app, sha256: f.sha256, content: text, note: "private TLS keys are never read: only their paths appear in the configuration" };
  }

  /** Edit, enable or disable a PSO-managed nginx file. Ownership, the marker, a base hash (concurrent edits), a directive lint, nginx -t and an automatic restore guard it. */
  private nginxApply(a: Record<string, unknown>, actor: ReturnType<AgentServer["actor"]>): unknown {
    const st = this.state; const policy = st.policy(); const file = str(a["file"], "file", /^\/[A-Za-z0-9_.\/-]{1,200}$/); const action = str(a["action"], "action", /^(edit|enable|disable|restore)$/);
    const d = discoverNginx({ managedDir: policy.nginxManagedDir }); const f = d.files.find((x) => x.path === file);
    if (!f) throw new ProtocolError("NOT_FOUND", "that file is not part of the nginx configuration PSO can see");
    if (f.managedBy !== "pso" || !f.app) throw new ProtocolError("FORBIDDEN", "this file is managed outside PSO: it is read-only here (adopt it through a deployment first)");
    if (f.symlinkTarget) throw new ProtocolError("FORBIDDEN", "PSO does not write through symbolic links");
    const app = f.app; const link = f.kind === "sites-available" ? `/etc/nginx/sites-enabled/${basename(file)}` : undefined;
    const unsafe = assertSafeWriteTarget({ file, ...(link ? { link } : {}) }, policy); if (unsafe) throw new ProtocolError("FORBIDDEN", unsafe);
    const audit = (outcome: "ok" | "denied", extra: Record<string, unknown>): void => { this.audit.append(`nginx.${action}`, outcome, actor, { environment: st.env().id, app }, { file, ...extra }); };
    if (action === "restore") {
      const id = str(a["backupId"], "backupId", /^[A-Za-z0-9_.-]{1,80}$/); if (!listBackups(st.home, app).some((b) => b.id === id)) throw new ProtocolError("NOT_FOUND", "no such backup for this application");
      const r = restoreProxy(st.home, policy, id); audit(r.ok ? "ok" : "denied", { backupId: id, error: r.error ? redactText(r.error).slice(0, 200) : undefined });
      if (!r.ok) throw new ProtocolError("FAILED", r.error ?? "restore failed"); return { restored: true, backupId: id };
    }
    if (action === "edit") {
      const content = a["content"]; if (typeof content !== "string") throw new ProtocolError("BAD_REQUEST", "content is required");
      if (a["expectedHash"] !== f.sha256) { audit("denied", { reason: "concurrent-modification" }); throw new ProtocolError("CONFLICT", "the file changed after you read it (a deployment or another administrator): read it again and redo the edit"); }
      const first = content.split("\n")[0] ?? ""; const old = readFileSync(file, "utf8"); const oldFirst = old.split("\n")[0] ?? "";
      if (first !== oldFirst || !/^# Managed by PSO Web \(app=/.test(first)) { audit("denied", { reason: "marker-changed" }); throw new ProtocolError("POLICY", "the first line (the PSO ownership marker) must stay exactly as it is"); }
      const rel = /^# pso-release: (\S+)/m.exec(old)?.[1]; if (rel && !new RegExp(`^# pso-release: ${rel}$`, "m").test(content)) { audit("denied", { reason: "release-marker-changed" }); throw new ProtocolError("POLICY", "the # pso-release marker must stay as it is"); }
      const problems = lintNginx(content); if (problems.length) { audit("denied", { reason: "lint", problems }); throw new ProtocolError("POLICY", `the configuration was refused: ${problems.join("; ")}`); }
      const r = applyProxy(st.home, policy, { file, ...(link ? { link } : {}) }, app, content, `edit${Date.now()}`);
      audit(r.error ? "denied" : "ok", { backupId: r.backupId ?? null, changed: r.changed, error: r.error ? redactText(r.error).slice(0, 200) : undefined });
      if (r.error) throw new ProtocolError("FAILED", `${r.error}${r.testOutput ? ` (${r.testOutput.split("\n")[0]})` : ""}. The previous configuration is in force${r.restored ? " (restored)" : ""}`);
      return { applied: r.changed, reloaded: r.reloaded, backupId: r.backupId ?? null, sha256: sha256(content), note: "the next deployment of this application re-renders this file from its declaration and overwrites manual edits" };
    }
    if (!link) throw new ProtocolError("PRECONDITION", "enable/disable applies to the sites-available/sites-enabled layout; this file is not in sites-available (a PSO-owned directory is always effective)");
    if (action === "enable") { if (!existsSync(link)) symlinkSync(file, link); } else { try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch { /* already disabled */ } }
    if (!nginxTest(policy).ok) { if (action === "enable") unlinkSync(link); else symlinkSync(file, link); audit("denied", { reason: "nginx -t failed after the change; reverted" }); throw new ProtocolError("FAILED", "nginx rejected the configuration after the change; reverted"); }
    const rl = nginxReload(policy); audit(rl.ok ? "ok" : "denied", { link });
    if (!rl.ok) throw new ProtocolError("FAILED", `reload failed: ${redactText(rl.out).slice(0, 200)}`);
    return { applied: true, reloaded: true, enabled: action === "enable" };
  }

  private provisionPlan(): unknown {
    const p = this.state.policy(); const i = inspect(this.state); const user = i.user.name; const dir = p.nginxManagedDir;
    const nginxBin = findNginx() ?? "/usr/sbin/nginx";
    const steps: Array<{ id: string; title: string; status: "ok" | "agent" | "admin" | "info"; detail: string }> = [];
    const dirsOk = existsSync(P.identity(this.state.home)) && existsSync(P.apps(this.state.home));
    steps.push({ id: "agent-dirs", title: "Agent directories and identity", status: dirsOk ? "ok" : "agent", detail: dirsOk ? "present" : "will be created by provision:apply (unprivileged, in the agent's home)" });
    steps.push({ id: "node", title: "Node.js for the agent", status: "ok", detail: `node ${process.versions.node} (the agent itself runs on it)` });
    for (const [tool, label] of [["git", "git (git sources)"], ["nginx", "nginx (blue-green and rolling)"], ["java", "java (Spring Boot services)"]] as const) {
      const t = i.tools[tool]; steps.push({ id: `tool-${tool}`, title: label, status: t.available ? "ok" : "admin", detail: t.available ? `found ${t.version ?? ""}`.trim() : `not installed. PSO never installs operating-system packages: install it with your package manager if you need it` });
    }
    if (i.tools.nginx.available) {
      steps.push({ id: "nginx-dir", title: `PSO-owned nginx directory ${dir}`, status: i.nginx.managedDirWritable ? "ok" : "admin", detail: i.nginx.managedDirWritable ? "exists and is writable by the agent user" : "must be created by an administrator and owned by the agent user (script below)" });
      let incl = false; try { incl = readFileSync("/etc/nginx/nginx.conf", "utf8").includes(`${dir}/`); } catch { /* unreadable */ }
      steps.push({ id: "nginx-include", title: "nginx includes the PSO directory", status: incl ? "ok" : "admin", detail: incl ? "include directive found" : `add \`include ${dir}/*.conf;\` inside the http { } block of nginx.conf (one line; PSO will not edit nginx.conf)` });
      // a privileged command that WORKS is not evidence of least privilege: the EFFECTIVE sudo rules are assessed (see privilege.inspect)
      const pv = i.privilege; const works = i.nginx.configValid === true;
      steps.push({ id: "nginx-sudo", title: "Narrow sudo rule for nginx -t / nginx -s reload", status: pv.narrowPolicyVerified && works ? "ok" : "admin", detail: pv.narrowPolicyVerified && works ? `verified: explicit commands only (${pv.commands.join("; ")})` : works ? `nginx -t works, but NOT because of a narrow rule: effective sudo privilege is ${pv.level.toUpperCase()}. ${pv.recommendation}` : pv.level === "unknown" ? `could not be verified (${pv.recommendation}); the script below grants exactly nginx -t and nginx -s reload` : "only these two commands are granted, nothing else (script below)" });
      if (pv.level === "unrestricted" || pv.level === "broad") steps.push({ id: "privilege-finding", title: `Effective sudo privilege of ${pv.user}: ${pv.level}`, status: "admin", detail: `${pv.evidence.join(" | ")}. ${pv.recommendation}` });
    }
    const sdv = i.systemd; const sdPresent = i.tools.systemd.available || /not reachable/.test(sdv.reason ?? "");
    if (sdPresent) steps.push({ id: "systemd-linger", title: "systemd runtime driver: lingering for the deploy user (optional)", status: sdv.available && sdv.linger ? "ok" : "admin", detail: sdv.available && sdv.linger ? "the user manager runs without a login session: services survive logout and restart at boot" : "only needed when a deployment declares runtime.supervisor: systemd. PSO uses the deploy user's OWN systemd manager (no root, no units under /etc, no sudo rule); one admin command keeps it running at boot (script below)" });
    steps.push({ id: "firewall", title: "Firewall", status: "info", detail: "PSO never changes firewall rules and opens no management port: the agent is reached through SSH only" });
    steps.push({ id: "tls-dns", title: "TLS certificates and DNS", status: "info", detail: "PSO does not obtain certificates or change DNS. Certificates are referenced by file path; DNS is yours" });
    const script = ["#!/bin/sh", "# Review before running as root. Idempotent. PSO never runs this for you.", "set -eu",
      `mkdir -p ${dir}`, `chown ${user}: ${dir}`, `chmod 755 ${dir}`,
      `grep -q '${dir}/' /etc/nginx/nginx.conf || echo "NOTE: add 'include ${dir}/*.conf;' inside http { } of /etc/nginx/nginx.conf"`,
      `printf '%s\\n' '${user} ALL=(root) NOPASSWD: ${nginxBin} -t, ${nginxBin} -s reload' > /etc/sudoers.d/pso-nginx`, "chmod 440 /etc/sudoers.d/pso-nginx", "visudo -cf /etc/sudoers.d/pso-nginx",
      ...(sdPresent ? [`loginctl enable-linger ${user}   # optional: only needed for runtime.supervisor: systemd`] : [])].join("\n");
    return { steps, adminScript: script, listeningPorts: listeningPorts().length, note: "provision:apply performs only the steps marked `agent`; steps marked `admin` need you to run them (or not) as root" };
  }

  private provisionApply(actor: ReturnType<AgentServer["actor"]>): unknown {
    const st = this.state; const done: string[] = [];
    for (const d of [P.identity(st.home), P.state(st.home), P.secrets(st.home), P.incoming(st.home), P.apps(st.home), P.nginx(st.home)]) if (!existsSync(d)) { ensureDir(d); done.push(`created ${d}`); }
    if (!existsSync(st.file("policy.json"))) { st.setPolicy(defaultPolicy("disabled")); done.push("wrote default policy (disabled)"); }
    this.audit.append("provision.apply", "ok", actor, { environment: st.env().id }, { done });
    return { applied: done, remaining: (this.provisionPlan() as { steps: Array<{ id: string; status: string }> }).steps.filter((s) => s.status === "admin").map((s) => s.id) };
  }
}

/** Handshake and enrollment answers carry keys, signatures and (for enroll.create) a one-time token ON PURPOSE; every other answer is sanitized. */
const RAW_OPS = new Set(["hello", "enroll", "session.open", "enroll.create"]);
const ok = (id: number, result: unknown, raw = false): Response => ({ id, ok: true, result: raw ? result : redactValue(result) });
const fail = (id: number, code: ErrorCode, message: string): Response => ({ id, ok: false, error: { code, message: redactText(message) } });

/** Reads requests from stdin, writes responses to stdout. Never logs to stdout/stderr. */
export async function serve(home?: string): Promise<void> {
  const server = new AgentServer(home);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (r: Response): void => { process.stdout.write(JSON.stringify(r) + "\n"); };
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      if (line.length > MAX_MESSAGE_BYTES) { write(fail(0, "BAD_REQUEST", "message too large")); return; }
      let req: Request; try { req = JSON.parse(line) as Request; } catch { write(fail(0, "BAD_REQUEST", "not JSON")); return; }
      write(await server.handle(req));
    });
  });
  await new Promise<void>((r) => rl.on("close", r));
  await chain;
}

