import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fingerprint, generateIdentity, randomToken, sha256, signText, verifyText } from "../crypto.ts";
import { AGENT_VERSION, OPERATIONS, PROTOCOL_VERSIONS, ProtocolError, REQUEST_SKEW_MS, ROLES, enrollPayload, helloPayload, roleRank, sessionPayload, verifyRequest, type OperationName, type Request, type Role } from "../protocol.ts";
import { AgentState, AuditLog, P, defaultPolicy, ensureDir, nowIso, readJson, writeJson, type ClientRecord, type EnrollToken, type Policy } from "./state.ts";
import { writeFileSync, chmodSync } from "node:fs";

/**
 * Identity, enrollment, sessions and authorization of the agent.
 *
 *  - The server identity key is generated at provisioning, stays in `identity/` (mode 600) and is only ever used to sign challenges.
 *  - The first administrator is created at provisioning as a single-use, expiring enrollment token for the role `superadmin`. The agent
 *    stores only a hash of the token's secret. Whoever enrolls first with it becomes superadmin by presenting a public key; no permanent
 *    secret of the administrator exists on the server, and none travels to the client.
 *  - There are no passwords: clients authenticate with Ed25519 keys, so there is no password verifier to protect or leak.
 *  - Authentication failures are rate limited per client and per source address, with growing lock-outs.
 */
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60_000;

export interface Principal { clientId: string; name: string; role: Role; sessionId: string }

export class Auth {
  /** per-connection nonce: a handshake or enrollment signature is valid for exactly one connection */
  readonly serverNonce = randomToken(24);
  private principal: Principal | undefined;
  readonly state: AgentState; readonly audit: AuditLog; private readonly source: string;
  constructor(state: AgentState, audit: AuditLog, source: string = process.env["SSH_CONNECTION"]?.split(" ")[0] ?? "local") { this.state = state; this.audit = audit; this.source = source; }

  get current(): Principal | undefined { return this.principal; }

  // ------------------------------------------------------------ provisioning (run on the server by its administrator)
  static provision(state: AgentState, mode: Policy["mode"], opts: { emitToken: boolean; tokenMinutes?: number; environment?: string }): { envId: string; fingerprint: string; alreadyProvisioned: boolean; bootstrapToken?: string; expiresAt?: string; mode: Policy["mode"] } {
    ensureDir(P.identity(state.home)); ensureDir(P.state(state.home)); ensureDir(P.secrets(state.home)); ensureDir(P.incoming(state.home)); ensureDir(P.apps(state.home));
    const audit = new AuditLog(state.home);
    const already = state.provisioned();
    if (!already) {
      const id = generateIdentity();
      writeFileSync(P.serverKey(state.home), id.privateKey, { mode: 0o600 }); try { chmodSync(P.serverKey(state.home), 0o600); } catch { /* not supported */ }
      writeFileSync(P.serverPub(state.home), id.publicKey);
      writeJson(state.file("env.json"), { id: `env_${randomToken(9)}`, createdAt: nowIso(), ...(opts.environment ? { label: opts.environment } : {}) });
      state.setPolicy(defaultPolicy(mode));
      audit.append("provision", "ok", { name: "host-administrator" }, { environment: state.env().id }, { mode });
    }
    const fp = fingerprint(readFileSync(P.serverPub(state.home), "utf8"));
    let bootstrapToken: string | undefined; let expiresAt: string | undefined;
    const hasAdmin = state.clients().some((c) => c.role === "superadmin" && !c.revoked);
    if (!hasAdmin && opts.emitToken) {
      const t = Auth.createToken(state, "superadmin", opts.tokenMinutes ?? 30, "provisioning");
      bootstrapToken = t.token; expiresAt = t.expiresAt;
      audit.append("enroll.bootstrap-created", "ok", { name: "host-administrator" }, { environment: state.env().id }, { expiresAt });
    }
    return { envId: state.env().id, fingerprint: fp, alreadyProvisioned: already, ...(bootstrapToken ? { bootstrapToken, expiresAt } : {}), ...(expiresAt && !bootstrapToken ? {} : {}), mode: state.policy().mode };
  }

  static createToken(state: AgentState, role: Role, minutes: number, createdBy: string): { token: string; expiresAt: string; id: string } {
    const id = randomToken(6); const secret = randomToken(24);
    const expiresAt = new Date(Date.now() + Math.min(Math.max(minutes, 1), 24 * 60) * 60_000).toISOString();
    const tokens = state.tokens().filter((t) => !t.used && Date.parse(t.expiresAt) > Date.now()); // expired and used tokens are dropped
    tokens.push({ id, secretHash: sha256(secret), role, expiresAt, createdBy, createdAt: nowIso() });
    state.saveTokens(tokens);
    return { token: `pso-enroll-${id}.${secret}`, expiresAt, id };
  }

  // ------------------------------------------------------------ rate limiting
  private failKeys(clientId?: string): string[] { return [`src:${this.source}`, ...(clientId ? [`client:${clientId}`] : [])]; }
  private failures(): Record<string, { count: number; first: number; lockedUntil: number; strikes: number }> { return readJson(this.state.file("authfail.json"), {}); }
  private checkLocked(clientId?: string): void {
    const f = this.failures(); const now = Date.now();
    for (const k of this.failKeys(clientId)) if ((f[k]?.lockedUntil ?? 0) > now) throw new ProtocolError("RATE_LIMITED", `too many failed attempts; try again in ${Math.ceil((f[k]!.lockedUntil - now) / 1000)} seconds`);
  }
  private recordFailure(clientId: string | undefined, why: string): void {
    const f = this.failures(); const now = Date.now();
    for (const k of this.failKeys(clientId)) {
      const e = f[k] && now - f[k]!.first < FAIL_WINDOW_MS ? f[k]! : { count: 0, first: now, lockedUntil: 0, strikes: f[k]?.strikes ?? 0 };
      e.count++;
      if (e.count >= MAX_FAILS) { e.strikes++; e.lockedUntil = now + Math.min(15 * 60_000 * 2 ** (e.strikes - 1), 24 * 3600_000); e.count = 0; e.first = now; }
      f[k] = e;
    }
    writeJson(this.state.file("authfail.json"), f);
    this.audit.append("auth.failure", "denied", clientId ? { clientId } : {}, { environment: this.state.env().id }, { reason: why, source: this.source });
  }
  private clearFailures(clientId: string): void { const f = this.failures(); for (const k of this.failKeys(clientId)) delete f[k]; writeJson(this.state.file("authfail.json"), f); }

  // ------------------------------------------------------------ handshake
  hello(args: { versions?: number[]; challenge?: string }): unknown {
    const versions = Array.isArray(args.versions) ? args.versions : [];
    const common = PROTOCOL_VERSIONS.filter((v) => versions.includes(v)).sort((a, b) => b - a)[0];
    if (common === undefined) throw new ProtocolError("UNSUPPORTED_VERSION", `no common protocol version (agent speaks ${PROTOCOL_VERSIONS.join(", ")}; client offered ${versions.join(", ") || "none"}); upgrade the older side`);
    if (typeof args.challenge !== "string" || args.challenge.length < 16 || args.challenge.length > 200) throw new ProtocolError("BAD_REQUEST", "a challenge of at least 16 characters is required");
    if (!this.state.provisioned()) return { version: common, agentVersion: AGENT_VERSION, provisioned: false, mode: "disabled", serverNonce: this.serverNonce };
    const pub = readFileSync(P.serverPub(this.state.home), "utf8");
    const sig = signText(readFileSync(P.serverKey(this.state.home), "utf8"), helloPayload(args.challenge, AGENT_VERSION, this.serverNonce));
    return { version: common, agentVersion: AGENT_VERSION, provisioned: true, mode: this.state.policy().mode, environmentId: this.state.env().id, publicKey: pub, fingerprint: fingerprint(pub), signature: sig, serverNonce: this.serverNonce };
  }

  private requireEnabled(): void {
    if (!this.state.provisioned()) throw new ProtocolError("NOT_PROVISIONED", "this server has no PSO agent identity yet: run `pso agent:install`");
    if (this.state.policy().mode === "disabled") throw new ProtocolError("FORBIDDEN", "remote management is DISABLED on this server (mode: disabled). A host administrator enables it with `pso-agent set-mode development|protected`");
  }

  enroll(args: { token?: string; publicKey?: string; name?: string; signature?: string }): unknown {
    this.requireEnabled();
    this.checkLocked();
    const fail = (why: string): never => { this.recordFailure(undefined, `enroll: ${why}`); throw new ProtocolError("ENROLLMENT_REFUSED", "enrollment refused (invalid, expired or already used token)"); };
    const m = /^pso-enroll-([A-Za-z0-9_-]{6,12})\.([A-Za-z0-9_-]{20,60})$/.exec(String(args.token ?? ""));
    if (!m) return fail("malformed token");
    if (typeof args.publicKey !== "string" || args.publicKey.length > 1000) return fail("no public key");
    let fp: string; try { fp = fingerprint(args.publicKey); } catch { return fail("bad public key"); }
    // the client proves it holds the private key matching the key it asks to enroll
    if (typeof args.signature !== "string" || !verifyText(args.publicKey, enrollPayload(m[1]!, args.publicKey, this.serverNonce), args.signature)) return fail("bad possession proof");
    const tokens = this.state.tokens(); const t = tokens.find((x) => x.id === m[1]);
    if (!t || t.used || Date.parse(t.expiresAt) <= Date.now()) return fail("unknown, used or expired");
    const a = Buffer.from(sha256(m[2]!)), b = Buffer.from(t.secretHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return fail("wrong secret");
    t.used = true; t.usedAt = nowIso(); t.usedBy = fp; this.state.saveTokens(tokens); // single use, consumed before anything else can happen
    const clients = this.state.clients();
    const name = String(args.name ?? "client").replace(/[^A-Za-z0-9._@ -]/g, "").slice(0, 60) || "client";
    const rec: ClientRecord = { id: fp, name, publicKey: args.publicKey, role: t.role, createdAt: nowIso(), createdBy: t.createdBy };
    this.state.saveClients([...clients.filter((c) => c.id !== fp), rec]);
    this.audit.append("enroll", "ok", { clientId: fp, name, role: t.role }, { environment: this.state.env().id }, { tokenId: t.id, createdBy: t.createdBy });
    return { clientId: fp, role: t.role, environmentId: this.state.env().id };
  }

  openSession(args: { clientId?: string; clientNonce?: string; signature?: string }): unknown {
    this.requireEnabled();
    const id = String(args.clientId ?? "");
    this.checkLocked(id);
    const c = this.state.clients().find((x) => x.id === id);
    const ok = !!c && !c.revoked && typeof args.clientNonce === "string" && typeof args.signature === "string" && verifyText(c.publicKey, sessionPayload(id, this.serverNonce, args.clientNonce), args.signature);
    if (!ok) { this.recordFailure(id || undefined, c?.revoked ? "revoked client" : "bad signature"); throw new ProtocolError("UNAUTHENTICATED", "authentication failed"); }
    this.clearFailures(id);
    const pol = this.state.policy();
    const now = Date.now();
    const sessions = this.state.sessions().filter((s) => !s.revoked && Date.parse(s.expiresAt) > now); // expired sessions are dropped
    const s = { id: randomToken(18), clientId: id, createdAt: nowIso(), expiresAt: new Date(now + pol.sessionHours * 3600_000).toISOString(), idleExpiresAt: new Date(now + pol.sessionIdleMinutes * 60_000).toISOString(), lastSeq: 0 };
    sessions.push(s); this.state.saveSessions(sessions);
    c!.lastSeen = nowIso(); this.state.saveClients(this.state.clients().map((x) => (x.id === id ? c! : x)));
    this.audit.append("session.open", "ok", { clientId: id, name: c!.name, role: c!.role }, { environment: this.state.env().id }, { sessionId: s.id });
    this.principal = { clientId: id, name: c!.name, role: c!.role, sessionId: s.id };
    return { sessionId: s.id, expiresAt: s.expiresAt, idleMinutes: pol.sessionIdleMinutes, role: c!.role, name: c!.name };
  }

  /** Authenticates one request and checks that the caller's role allows the operation. */
  authorize(req: Request): Principal {
    this.requireEnabled();
    const need = OPERATIONS[req.op as OperationName];
    if (need === undefined) throw new ProtocolError("UNKNOWN_OPERATION", `unknown operation "${req.op}"`);
    if (need === null) throw new ProtocolError("BAD_REQUEST", "handshake operation");
    const a = req.auth;
    if (!a || typeof a.sid !== "string" || !Number.isInteger(a.seq) || typeof a.ts !== "number" || typeof a.sig !== "string") throw new ProtocolError("UNAUTHENTICATED", "a signed session is required");
    const sessions = this.state.sessions(); const s = sessions.find((x) => x.id === a.sid);
    const now = Date.now();
    if (!s || s.revoked || Date.parse(s.expiresAt) <= now || Date.parse(s.idleExpiresAt) <= now) throw new ProtocolError("SESSION_EXPIRED", "the session has expired or was revoked: sign in again");
    const c = this.state.clients().find((x) => x.id === s.clientId);
    if (!c || c.revoked) { s.revoked = true; this.state.saveSessions(sessions); throw new ProtocolError("UNAUTHENTICATED", "this client was revoked"); }
    if (Math.abs(now - a.ts) > REQUEST_SKEW_MS) { this.recordFailure(c.id, "clock skew"); throw new ProtocolError("REPLAY", "request time is outside the allowed window (check the clocks)"); }
    if (!verifyRequest(c.publicKey, a, req.op, req.args)) { this.recordFailure(c.id, "bad request signature"); throw new ProtocolError("UNAUTHENTICATED", "request signature invalid"); }
    if (a.seq <= s.lastSeq) { this.audit.append("auth.replay", "denied", { clientId: c.id, name: c.name }, { environment: this.state.env().id }, { op: req.op }); throw new ProtocolError("REPLAY", "request sequence already used"); }
    s.lastSeq = a.seq; s.idleExpiresAt = new Date(now + this.state.policy().sessionIdleMinutes * 60_000).toISOString();
    this.state.saveSessions(sessions);
    if (roleRank(c.role) < roleRank(need)) {
      this.audit.append("authz.denied", "denied", { clientId: c.id, name: c.name, role: c.role }, { environment: this.state.env().id }, { op: req.op, required: need });
      throw new ProtocolError("FORBIDDEN", `operation ${req.op} needs the role "${need}"; this client is "${c.role}"`);
    }
    this.principal = { clientId: c.id, name: c.name, role: c.role, sessionId: s.id };
    return this.principal;
  }

  closeSession(): void {
    if (!this.principal) return;
    const sessions = this.state.sessions(); const s = sessions.find((x) => x.id === this.principal!.sessionId);
    if (s) { s.revoked = true; this.state.saveSessions(sessions); }
    this.audit.append("session.close", "ok", { clientId: this.principal.clientId, name: this.principal.name }, { environment: this.state.env().id });
  }
}

export { ROLES };
export const keyExists = (state: AgentState): boolean => existsSync(P.serverKey(state.home));
