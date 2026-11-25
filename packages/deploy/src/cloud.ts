import { spawnSync } from "node:child_process";
import { runReleaseOp, uploadBuild, type AgentReleaseChange, type AgentReleases, type RemoteShell } from "./agent-releases.ts";
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AgentClient, CloudError, type ConnectOptions } from "./client.ts";
import { newCredentialRef, resolveCredentialProvider, type CredentialProvider } from "./credentials.ts";
import { generateIdentity, sha256 } from "./crypto.ts";
import { servicesOf, validateDeployment, validatePipeline, type DeclDiagnostic, type DeploymentDecl, type PipelineDecl } from "./declare.ts";
import { describeConnection, LocalStore, type AuthKind, type ConnectionRecord, type SignerRecord } from "./local-state.ts";
import { diagnose, probeHttps, resolveUrls, runTest, tcpProbe, type ResolvedUrl, type TestRequest, type UrlEntry } from "./access.ts";
import { lintNginx } from "./agent/visibility.ts";
import { explainSshFailure, inspectKeyFile, repairKeyFile, type KeyAccess, type RepairResult } from "./keyaccess.ts";
import { generateSigner, signManifest, treeDigest, type ReleaseManifest, type SignedManifest, type TrustedSigner } from "./signing.ts";
import { redactValue, registerSecret } from "./redact.ts";
import { loadDeclarationFile } from "./static-load.ts";
import { agentCommand, openTunnel, pinHostKey, scanHostKey, sshExec, unpinHost, validateConnectionShape, type HostKeyCandidate } from "./ssh.ts";

/**
 * The operational facade used by the CLI AND by Studio: every operation they expose goes through here, so they cannot disagree about
 * policy. This class holds no deployment logic (that lives in the agent's engine); it manages connections, credentials, declarations
 * and the conversation with the agent.
 */
export interface DeclarationFile { file: string; relative: string; kind: "deployment" | "pipeline"; name: string; environment?: string; value: unknown; diagnostics: DeclDiagnostic[]; hash: string }

export function discoverDeclarations(root: string): DeclarationFile[] {
  const out: DeclarationFile[] = [];
  const dirs = [root, join(root, "deploy")];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/(^|\.)(deployment|pipeline)\.pso\.ts$/i.test(f) && !/^(DEPLOYMENT|PIPELINE)\.pso\.ts$/.test(f)) continue;
      const file = join(dir, f); const l = loadDeclarationFile(file);
      const kind = /pipeline/i.test(f) ? "pipeline" : "deployment";
      const v = l.value as { name?: string; environment?: string } | undefined;
      const diagnostics = [...l.diagnostics, ...(l.value !== undefined && l.diagnostics.every((x) => x.level !== "error") ? (kind === "deployment" ? validateDeployment(l.value) : validatePipeline(l.value)) : [])];
      if (l.kind && l.kind !== kind) diagnostics.push({ level: "error", code: "PSO-DEC-KIND", path: file, message: `this file defines a ${l.kind} but is named like a ${kind}` });
      out.push({ file, relative: file.slice(root.length + 1).replace(/\\/g, "/"), kind, name: v?.name ?? basename(f), ...(v?.environment ? { environment: v.environment } : {}), value: l.value, diagnostics, hash: l.hash });
    }
  }
  return out;
}

export interface AddConnectionSpec {
  name: string; host: string; port?: number; user: string; auth: AuthKind; keyPath?: string; passphrase?: string; password?: string;
  jump?: { host: string; port: number; user: string }; timeoutSeconds?: number; agentDir?: string;
}
export interface TestStep { step: string; ok: boolean; detail: string }

export class Cloud {
  readonly store: LocalStore; readonly creds: () => CredentialProvider;
  private providerCache: CredentialProvider | undefined;
  constructor(opts: { store?: LocalStore; creds?: CredentialProvider } = {}) {
    this.store = opts.store ?? new LocalStore();
    this.creds = () => (this.providerCache ??= opts.creds ?? resolveCredentialProvider({ home: this.store.home, env: process.env, platform: process.platform }));
  }
  private deps() { return { store: this.store, creds: this.creds() }; }

  // ------------------------------------------------------------ connections
  list() { return this.store.connections().map(describeConnection); }
  get(name: string): ConnectionRecord { const c = this.store.connection(name); if (!c) throw new CloudError(`no connection named "${name}"`, "NOT_FOUND", "List them with `pso connection:list`"); return c; }

  /** Step 1 of adding a server: ask it for its SSH host keys. The user must approve a fingerprint before it is pinned. */
  hostKeys(host: string, port = 22): HostKeyCandidate[] { return scanHostKey(host, port); }

  add(spec: AddConnectionSpec, approvedHostKey: string): ConnectionRecord {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(spec.name)) throw new CloudError("a connection name is kebab-case", "BAD_NAME");
    if (this.store.connection(spec.name)) throw new CloudError(`connection "${spec.name}" already exists`, "EXISTS", "Use `pso connection:rotate` to change its credentials or remove it first");
    const rec: ConnectionRecord = { name: spec.name, host: spec.host, port: spec.port ?? 22, user: spec.user, auth: { kind: spec.auth }, timeoutSeconds: spec.timeoutSeconds ?? 15, agentDir: spec.agentDir ?? ".pso-agent", createdAt: new Date().toISOString(), credentialVersion: 1, ...(spec.jump ? { jump: spec.jump } : {}) };
    const bad = validateConnectionShape(rec); if (bad) throw new CloudError(bad, "BAD_CONNECTION");
    if (spec.auth === "key") {
      if (!spec.keyPath || !existsSync(spec.keyPath)) throw new CloudError("--key must name an existing private key file (it stays where it is; PSO stores only its path)", "NO_KEY");
      rec.auth.keyPath = resolve(spec.keyPath);
    }
    if (spec.auth === "password" && !spec.password) throw new CloudError("password authentication needs a password (entered interactively or on stdin, never as an argument)", "NO_SECRET");
    const provider = this.creds(); // fails early, with instructions, when no protected store is available
    pinHostKey(this.store.knownHostsFile, rec.host, rec.port, approvedHostKey);
    rec.hostKeyFingerprint = approvedHostKey;
    if (spec.password) { registerSecret(spec.password); rec.auth.passwordRef = newCredentialRef(); provider.set(rec.auth.passwordRef, spec.password); }
    if (spec.passphrase) { registerSecret(spec.passphrase); rec.auth.passphraseRef = newCredentialRef(); provider.set(rec.auth.passphraseRef, spec.passphrase); }
    this.store.saveConnection(rec);
    this.store.audit("connection.added", { name: rec.name, host: rec.host, port: rec.port, user: rec.user, auth: rec.auth.kind, hostKey: approvedHostKey });
    return rec;
  }

  /** Walks the layers of a connection and reports each one: reachability and host identity, agent, agent identity, session. */
  async test(name: string, opts: { pinAgent?: string } = {}): Promise<{ ok: boolean; steps: TestStep[] }> {
    const c = this.get(name); const steps: TestStep[] = [];
    const push = (step: string, ok: boolean, detail: string): boolean => { steps.push({ step, ok, detail }); return ok; };
    if (c.auth.kind === "key" && c.auth.keyPath) { const ka = inspectKeyFile(c.auth.keyPath); if (ka.verdict !== "ok") { push("key-file", false, `${ka.detail}${ka.verdict === "too-open" ? `. OpenSSH will refuse this key: run \`pso connection:key ${name}\`` : ""}`); } else push("key-file", true, ka.detail); }
    const ssh = this.sshCtx(c);
    const r = sshExec(c, ssh, `printf pso-ok`, undefined, (c.timeoutSeconds + 10) * 1000);
    if (!push("ssh", r.status === 0 && r.stdout === "pso-ok", r.status === 0 ? `connected as ${c.user}@${c.host}:${c.port}; host key verified against the pinned ${c.hostKeyFingerprint}` : `failed: ${r.stderr.trim().split("\n").slice(-1)[0] ?? "no output"}`)) return { ok: false, steps };
    let client: AgentClient;
    try { client = await AgentClient.connect(c, this.deps(), { ...(opts.pinAgent ? { pinAgent: opts.pinAgent } : {}), noSession: !c.clientId }); } catch (e) { push("agent", false, (e as Error).message); return { ok: false, steps }; }
    try {
      if (!push("agent", client.agent.provisioned, client.agent.provisioned ? `agent ${client.agent.agentVersion} (management mode: ${client.agent.mode})` : "the agent is not provisioned: run `pso agent:install`")) return { ok: false, steps };
      // `--pin-agent` is a request to PIN: the claim "pinned" below is only true once it is saved (the challenge-response already proved the key)
      if (opts.pinAgent && client.agent.fingerprint === opts.pinAgent && c.agentFingerprint !== opts.pinAgent) { c.agentFingerprint = opts.pinAgent; this.store.saveConnection(c); this.store.audit("agent.pinned", { name, fingerprint: opts.pinAgent }); }
      push("agent-identity", true, `${client.agent.fingerprint} verified by challenge-response and pinned`);
      if (client.agent.mode === "disabled") { push("mode", false, "remote management is DISABLED on this server"); return { ok: false, steps }; }
      if (!c.clientId) { push("session", false, "no enrolled client identity: run `pso agent:enroll`"); return { ok: false, steps }; }
      const who = await client.call<{ role: string; environment: string | null }>("whoami");
      push("session", true, `authenticated as ${client.session.name} (role ${who.role}${who.environment ? `, environment ${who.environment}` : ""})`);
      return { ok: true, steps };
    } catch (e) { push("session", false, (e as Error).message); return { ok: false, steps }; } finally { client.close(); }
  }

  /**
   * The registered connection and the SSH context to use it (pinned known_hosts, secrets from the credential store), for other PSO
   * providers that run their own fixed commands over the same strict SSH (the 0.2.0 remote host provider). Never returns key material.
   */
  sshFor(name: string): { connection: ConnectionRecord; ctx: { knownHosts: string; secrets: { password?: string; passphrase?: string } } } {
    const c = this.get(name);
    if (!c.hostKeyFingerprint) throw new CloudError(`connection "${name}" has no approved host key`, "NO_HOST_KEY", "Add it again with --accept-host-key <fingerprint>");
    return { connection: c, ctx: this.sshCtx(c) };
  }

  private sshCtx(c: ConnectionRecord) {
    const secrets: { password?: string; passphrase?: string } = {};
    if (c.auth.passwordRef) { const v = this.creds().get(c.auth.passwordRef); if (v === undefined) throw new CloudError("the SSH password is missing from the credential store", "NO_CREDENTIAL"); registerSecret(v); secrets.password = v; }
    if (c.auth.passphraseRef) { const v = this.creds().get(c.auth.passphraseRef); if (v === undefined) throw new CloudError("the SSH key passphrase is missing from the credential store", "NO_CREDENTIAL"); registerSecret(v); secrets.passphrase = v; }
    return { knownHosts: this.store.knownHostsFile, secrets };
  }

  /** Replaces the SSH password or passphrase of a connection (rotation). The old secret is removed from the store. */
  rotateSshSecret(name: string, value: string): void {
    const c = this.get(name); const p = this.creds(); registerSecret(value);
    const kind = c.auth.kind === "password" ? "passwordRef" : c.auth.passphraseRef ? "passphraseRef" : undefined;
    if (!kind) throw new CloudError(`connection "${name}" uses ${c.auth.kind === "agent" ? "an ssh-agent" : "an unprotected key"}: there is no stored secret to rotate (rotate the key itself on the server and in your ssh-agent)`, "NOTHING_TO_ROTATE");
    const old = c.auth[kind]; const ref = newCredentialRef(); p.set(ref, value); c.auth[kind] = ref; c.credentialVersion++; this.store.saveConnection(c);
    if (old) p.remove(old);
    this.store.audit("credential.rotated", { name, kind: kind === "passwordRef" ? "ssh-password" : "ssh-passphrase", version: c.credentialVersion });
  }

  /** Rotates the Ed25519 client key: a new key is enrolled (with a token created by the current identity), then the old client is revoked. */
  async rotateClientKey(name: string): Promise<{ clientId: string; previous: string }> {
    const c = this.get(name); if (!c.clientId || !c.clientKeyRef) throw new CloudError("this connection has no enrolled client key", "NOT_ENROLLED");
    const cl = await AgentClient.connect(c, this.deps());
    try {
      const role = cl.session.role ?? "deployer";
      const t = await cl.call<{ token: string }>("enroll.create", { role, minutes: 5 });
      const fresh = generateIdentity();
      const probe = await AgentClient.connect(c, this.deps(), { noSession: true });
      let enrolled; try { enrolled = await probe.enroll(t.token, fresh.publicKey, fresh.privateKey, `${cl.session.name ?? name} (rotated)`); } finally { probe.close(); }
      const oldRef = c.clientKeyRef, oldId = c.clientId; const ref = newCredentialRef(); this.creds().set(ref, fresh.privateKey);
      await cl.call("client.revoke", { clientId: oldId });
      c.clientKeyRef = ref; c.clientId = enrolled.clientId; c.credentialVersion++; this.store.saveConnection(c); this.creds().remove(oldRef);
      this.store.audit("credential.rotated", { name, kind: "client-key", previous: oldId, now: enrolled.clientId });
      return { clientId: enrolled.clientId, previous: oldId };
    } finally { cl.close(); }
  }

  /** Revokes the client identity on the server (best effort when it is unreachable) and deletes every local secret of the connection. */
  async revoke(name: string): Promise<{ serverRevoked: boolean; localRemoved: string[] }> {
    const c = this.get(name); let serverRevoked = false;
    if (c.clientId && c.clientKeyRef) { try { const cl = await AgentClient.connect(c, this.deps()); try { await cl.call("client.revoke", { clientId: c.clientId }); serverRevoked = true; } finally { cl.close(); } } catch { /* unreachable or already revoked: the local part still happens */ } }
    const removed: string[] = [];
    for (const ref of [c.auth.passwordRef, c.auth.passphraseRef, c.clientKeyRef]) if (ref && this.creds().remove(ref)) removed.push("credential");
    delete c.auth.passwordRef; delete c.auth.passphraseRef; delete c.clientKeyRef; delete c.clientId; c.revoked = true; this.store.saveConnection(c);
    this.store.audit("credential.revoked", { name, serverRevoked });
    return { serverRevoked, localRemoved: removed };
  }

  remove(name: string): { removed: boolean } {
    const c = this.get(name);
    for (const ref of [c.auth.passwordRef, c.auth.passphraseRef, c.clientKeyRef]) if (ref) this.creds().remove(ref);
    unpinHost(this.store.knownHostsFile, c.host, c.port);
    this.store.removeConnection(name); this.store.audit("connection.removed", { name });
    return { removed: true };
  }

  /** A private tunnel from a loopback port here to a loopback port on the server, through the authenticated SSH connection. */
  /** Diagnoses the access rights of the connection's private key file (never reads the key itself, never changes anything). */
  keyAccess(name: string): KeyAccess { const c = this.get(name); if (c.auth.kind !== "key" || !c.auth.keyPath) throw new CloudError(`connection "${name}" does not use a key file`, "NOT_A_KEY_CONNECTION"); return inspectKeyFile(c.auth.keyPath); }
  /** Restricts the key file to its owner. Only with the user's explicit confirmation; it touches exactly the file the connection names. */
  repairKeyAccess(name: string, o: { confirm: boolean }): RepairResult { const c = this.get(name); if (c.auth.kind !== "key" || !c.auth.keyPath) throw new CloudError(`connection "${name}" does not use a key file`, "NOT_A_KEY_CONNECTION"); if (!o.confirm) throw new CloudError("changing the access rights of a private key file needs your explicit confirmation", "CONFIRM"); return repairKeyFile(c.auth.keyPath, { confirm: true }); }
  tunnel(name: string, localPort: number, remotePort: number): { localPort: number; close(): void; exited: Promise<number | null> } {
    const c = this.get(name); const t = openTunnel(c, this.sshCtx(c), localPort, remotePort);
    this.store.audit("tunnel.opened", { name, localPort, remotePort });
    return { localPort, close: () => { t.close(); this.store.audit("tunnel.closed", { name, localPort, remotePort }); }, exited: new Promise((r) => t.child.on("close", r)) };
  }

  // ------------------------------------------------------------ agent lifecycle
  static bundlePath(): string { return new URL("../agent/pso-agent.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); }

  /** Installs the agent over SSH, provisions it in the chosen mode, and enrolls THIS machine as its first superadministrator. */
  async installAgent(name: string, o: { mode: "development" | "protected"; environment: string; yes: boolean }): Promise<{ fingerprint: string; environmentId: string; role: string; version: string; agentDir: string }> {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(o.environment)) throw new CloudError("--environment is a lower-case name (letters, digits, -)", "BAD_ENVIRONMENT");
    if (o.mode !== "development" && o.mode !== "protected") throw new CloudError("--mode is development or protected", "BAD_MODE");
    const c = this.get(name); const ssh = this.sshCtx(c);
    const bundle = Cloud.bundlePath(); if (!existsSync(bundle)) throw new CloudError("the agent bundle is missing from this installation", "NO_BUNDLE", "Run `npm run build` (repository checkout) or reinstall PSO");
    const data = readFileSync(bundle); const sum = sha256(data);
    const d = c.agentDir;
    const step = (cmd: string, input?: Buffer | string) => { const r = sshExec(c, ssh, cmd, input); if (r.status !== 0) throw new CloudError(`remote step failed: ${r.stderr.trim().split("\n").slice(-2).join(" | ") || `exit ${r.status}`}`, "REMOTE_FAILED"); return r.stdout; };
    const run: RemoteShell = (cmd, input) => sshExec(c, ssh, cmd, input);
    const dirExpr = `"$HOME/${d}"`;
    let ver: { agent: string };
    try { const file = uploadBuild(run, dirExpr, data); const r = runReleaseOp<AgentReleaseChange>(run, dirExpr, { op: "install", dir: "__DIR__", file, sha256: sum, by: c.user, source: "install", retain: 5 }); ver = { agent: r.to.split("+")[0]! }; }
    catch (e) { throw new CloudError((e as Error).message, "INTEGRITY"); }
    const prov = JSON.parse(step(agentCommand(c, `provision --mode ${o.mode} --environment ${o.environment} --emit-token`)).trim()) as { fingerprint: string; environmentId: string; bootstrapToken?: string; alreadyProvisioned: boolean };
    if (!prov.bootstrapToken) throw new CloudError(prov.alreadyProvisioned ? "this server is already provisioned and has an administrator: ask them to enroll you (`pso agent:enroll` with a token from `enroll.create`)" : "no bootstrap token was issued", "ALREADY_PROVISIONED");
    registerSecret(prov.bootstrapToken);
    c.agentFingerprint = prov.fingerprint; // obtained over the authenticated, host-key-verified SSH channel
    const keys = generateIdentity();
    const cl = await AgentClient.connect(c, this.deps(), { pinAgent: prov.fingerprint, noSession: true });
    try {
      if (cl.agent.fingerprint !== prov.fingerprint) throw new CloudError("the agent answering the protocol is not the one that was provisioned", "IDENTITY");
      const e = await cl.enroll(prov.bootstrapToken, keys.publicKey, keys.privateKey, `${process.env["USERNAME"] ?? process.env["USER"] ?? "operator"}@pso-studio`);
      const ref = newCredentialRef(); this.creds().set(ref, keys.privateKey);
      c.clientKeyRef = ref; c.clientId = e.clientId; c.role = e.role; c.environmentId = e.environmentId; this.store.saveConnection(c);
      this.store.audit("agent.installed", { name, agentVersion: ver.agent, fingerprint: prov.fingerprint, mode: o.mode, environment: o.environment, role: e.role });
      return { fingerprint: prov.fingerprint, environmentId: e.environmentId, role: e.role, version: ver.agent, agentDir: d };
    } finally { cl.close(); }
  }

  /** Enrolls this machine with a token an administrator created (`enroll.create`). */
  async enroll(name: string, token: string): Promise<{ clientId: string; role: string }> {
    const c = this.get(name); registerSecret(token);
    if (!c.agentFingerprint) throw new CloudError("the agent identity is not pinned for this connection", "NOT_PINNED", "Run `pso connection:test --pin-agent <fingerprint>` after verifying the fingerprint on the server (`pso-agent status`)");
    const keys = generateIdentity(); const cl = await AgentClient.connect(c, this.deps(), { noSession: true });
    try {
      const e = await cl.enroll(token, keys.publicKey, keys.privateKey, `${process.env["USERNAME"] ?? process.env["USER"] ?? "operator"}@pso`);
      const ref = newCredentialRef(); this.creds().set(ref, keys.privateKey);
      if (c.clientKeyRef) this.creds().remove(c.clientKeyRef);
      c.clientKeyRef = ref; c.clientId = e.clientId; c.role = e.role; c.environmentId = e.environmentId; this.store.saveConnection(c); this.store.audit("agent.enrolled", { name, clientId: e.clientId, role: e.role });
      return e;
    } finally { cl.close(); }
  }

  async pinAgent(name: string, fp: string): Promise<{ fingerprint: string }> {
    const c = this.get(name); const cl = await AgentClient.connect(c, this.deps(), { pinAgent: fp, noSession: true });
    try { if (cl.agent.fingerprint !== fp) throw new CloudError("fingerprint mismatch", "IDENTITY"); c.agentFingerprint = fp; this.store.saveConnection(c); this.store.audit("agent.pinned", { name, fingerprint: fp }); return { fingerprint: fp }; } finally { cl.close(); }
  }

  /** Upgrades the remote agent in place: verified upload, a start check, an atomic swap, and the previous file kept for recovery. */
  /**
   * Installs a new build of the agent as a NEW versioned release and activates it with one atomic link replacement. Every earlier release stays (within the
   * retention) and can be returned to with `rollbackAgent`; two builds of the same version are different releases. Identity, roles, policy, credentials and
   * deployments are in the agent's state directories and are not touched.
   */
  upgradeAgent(name: string): { from: string; to: string; kept: string; release: string; previous: string | null; changed: boolean } {
    const c = this.get(name); const ssh = this.sshCtx(c); const d = c.agentDir; const data = readFileSync(Cloud.bundlePath()); const sum = sha256(data);
    const run: RemoteShell = (cmd, input) => sshExec(c, ssh, cmd, input); const dirExpr = `"$HOME/${d}"`;
    const before = JSON.parse(run(`PSO_AGENT_HOME="$HOME/${d}" node "$HOME/${d}/bin/pso-agent.mjs" version`).stdout.trim() || "{}") as { agent?: string };
    let r: AgentReleaseChange;
    try { r = runReleaseOp<AgentReleaseChange>(run, dirExpr, { op: "install", dir: "__DIR__", file: uploadBuild(run, dirExpr, data), sha256: sum, by: c.user, source: "upgrade", retain: 5 }); }
    catch (e) { throw new CloudError((e as Error).message, "INTEGRITY"); }
    this.store.audit("agent.upgraded", { name, from: r.from, to: r.to, changed: r.changed, previous: r.previous });
    return { from: before.agent ?? "?", to: r.to.split("+")[0]!, kept: r.previous ? `releases/${r.previous}` : "(none)", release: r.to, previous: r.previous, changed: r.changed };
  }

  /** The agent releases kept on the server: the active one, the previous one, each build's checksum and installation, and the history. */
  agentReleases(name: string): AgentReleases {
    const c = this.get(name); const ssh = this.sshCtx(c);
    return runReleaseOp<AgentReleases>((cmd, input) => sshExec(c, ssh, cmd, input), `"$HOME/${c.agentDir}"`, { op: "list", dir: "__DIR__" });
  }

  /** Returns to an earlier agent release (the previous one, or a named one): its checksum is re-verified and it must start before the link is switched. */
  rollbackAgent(name: string, to?: string): AgentReleaseChange {
    const c = this.get(name); const ssh = this.sshCtx(c);
    let r: AgentReleaseChange;
    try { r = runReleaseOp<AgentReleaseChange>((cmd, input) => sshExec(c, ssh, cmd, input), `"$HOME/${c.agentDir}"`, { op: "rollback", dir: "__DIR__", ...(to ? { to } : {}), by: c.user }); }
    catch (e) { throw new CloudError((e as Error).message, "REMOTE_FAILED"); }
    this.store.audit("agent.rolled-back", { name, from: r.from, to: r.to });
    return r;
  }

  /** Removes the management tooling from the server. Applications and their data stay unless `purgeApplications` is given. */
  uninstallAgent(name: string, o: { purgeApplications?: boolean } = {}): unknown {
    const c = this.get(name); const ssh = this.sshCtx(c); const d = c.agentDir;
    const r = sshExec(c, ssh, `PSO_AGENT_HOME="$HOME/${d}" node "$HOME/${d}/bin/pso-agent.mjs" uninstall${o.purgeApplications ? " --purge-applications" : ""}`);
    if (r.status !== 0) throw new CloudError(`uninstall refused or failed: ${r.stderr.trim().split("\n").slice(-1)[0] ?? ""}`, "REMOTE_FAILED");
    if (!o.purgeApplications) sshExec(c, ssh, `rm -f "$HOME/${d}/bin/pso-agent.mjs" "$HOME/${d}/bin/pso-agent.prev.mjs" "$HOME/${d}/bin/pso-agent.new.mjs"`);
    this.store.audit("agent.uninstalled", { name, purgeApplications: !!o.purgeApplications });
    return JSON.parse(r.stdout.trim() || "{}");
  }

  // ------------------------------------------------------------ talking to the agent
  async connect(name: string, opts: ConnectOptions = {}): Promise<AgentClient> { return AgentClient.connect(this.get(name), this.deps(), opts); }
  async with<T>(name: string, fn: (c: AgentClient) => Promise<T>, opts: ConnectOptions = {}): Promise<T> { const c = await this.connect(name, opts); try { return await fn(c); } finally { c.close(); } }

  // ------------------------------------------------------------ operational visibility (the CLI and Studio call exactly these)
  /** Adds a trust anchor for this environment's TLS certificate. Verification stays on. */
  setTlsCa(conn: string, file: string | undefined): void { const c = this.get(conn); if (file) { if (!existsSync(file)) throw new CloudError(`CA file not found: ${file}`, "NOT_FOUND"); if (!/-----BEGIN CERTIFICATE-----/.test(readFileSync(file, "utf8"))) throw new CloudError("that file is not a PEM certificate", "BAD_REQUEST"); c.tlsCaFile = file; } else delete c.tlsCaFile; this.store.saveConnection(c); this.store.audit("connection.tls-ca", { connection: conn, set: !!file }); }
  async applicationOverview(conn: string, app: string): Promise<any> {
    const ov = await this.with(conn, (c) => c.call<any>("app.overview", { app })); const rec = this.get(conn);
    return { ...ov, server: { address: rec.host, port: rec.port, user: rec.user }, resolvedUrls: resolveUrls(ov.urls, rec.host), tlsCaFile: rec.tlsCaFile ?? null };
  }
  /** A missing CA file is a clear, actionable error, never a hang or a silent TLS failure (the file moves when a workspace moves). */
  private requireCaFile(file: string | undefined): void { if (file && !existsSync(file)) throw new CloudError(`the CA certificate file for this environment does not exist: ${file}`, "CA_FILE_MISSING", "Set it again: Studio, Applications, Set CA file (or `pso release:url <app> --verify --ca-file <file> --save-ca`). TLS verification stays on."); }
  async reachability(conn: string, app: string, o: { caFile?: string; tunnel?: boolean } = {}): Promise<import("./access.ts").Reachability> {
    const ov = await this.applicationOverview(conn, app); const rec = this.get(conn); const caFile = o.caFile ?? rec.tlsCaFile; this.requireCaFile(caFile);
    const expo = await this.with(conn, (c) => c.call<any>("network.exposure")).catch(() => undefined);
    const target = (ov.urls as UrlEntry[]).find((u) => u.visibility === "public-binding" && !u.redirectsTo && u.scheme === "https") ?? (ov.urls as UrlEntry[]).find((u) => u.visibility === "public-binding" && !u.redirectsTo);
    let tunnelBase: string | null = null; let tunnelNote: string | undefined;
    if (o.tunnel && target) {
      const local = 20000 + Math.floor(Math.random() * 20000); const t = this.tunnel(conn, local, target.port);
      try { await new Promise((r) => setTimeout(r, 2500)); const host = target.host && !/^\d+\.\d+\.\d+\.\d+$/.test(target.host) ? target.host : undefined;
        const p = await probeHttps(`${target.scheme}://127.0.0.1:${local}/`, { ...(caFile ? { caFile } : {}), ...(host ? { servername: host } : {}), path: ov.services?.[0]?.instances?.[0]?.localHealth ? "/" : "/" });
        if (p.outcome === "reachable") { tunnelBase = `${target.scheme}://127.0.0.1:${local}`; tunnelNote = `through an authenticated SSH tunnel: ${p.detail} in ${p.ms} ms`; } else tunnelNote = `the tunnel opened but the request failed: ${p.outcome}: ${p.detail}`;
      } finally { t.close(); }
    }
    const listeningAll = expo?.listeners?.some((l: any) => target && l.port === target.port && l.binding === "all-interfaces");
    return diagnose(app, ov, { host: rec.host, ...(caFile ? { caFile } : {}), tunnelBase, ...(tunnelNote ? { tunnelNote } : {}) }, listeningAll);
  }
  /** Listeners and findings from the server, plus (optionally) a plain TCP check from THIS machine for each all-interface or public listener. */
  async exposure(conn: string, o: { verifyFromClient?: boolean } = {}): Promise<any> {
    const r = await this.with(conn, (c) => c.call<any>("network.exposure")); const host = this.get(conn).host;
    if (o.verifyFromClient) for (const l of r.listeners) if (l.binding !== "loopback") l.clientProbe = { from: "this machine", result: await tcpProbe(host, l.port), note: "'no-answer' means silent (dropped or filtered), 'refused' means the host answered; neither proves who is responsible" };
    return r;
  }
  async privileges(conn: string): Promise<any> { return this.with(conn, (c) => c.call<any>("privilege.inspect")); }
  async runtime(conn: string): Promise<any> { return this.with(conn, (c) => c.call<any>("services.runtime")); }
  async appConfig(conn: string, app: string): Promise<any> { return this.with(conn, (c) => c.call<any>("app.config", { app })); }
  async endpoints(conn: string, app: string): Promise<any> {
    const [ep, ov] = await Promise.all([this.with(conn, (c) => c.call<any>("endpoints.list", { app })), this.applicationOverview(conn, app)]);
    const base = (ov.resolvedUrls as ResolvedUrl[]).find((u) => u.visibility === "public-binding" && !u.redirectsTo && u.scheme === "https") ?? (ov.resolvedUrls as ResolvedUrl[]).find((u) => u.visibility === "public-binding" && !u.redirectsTo);
    const origin = base ? base.url.replace(/\/$/, "") : null;
    return { ...ep, baseUrl: origin, routes: (ep.routes as any[]).map((r) => ({ ...r, fullUrl: origin ? `${origin}${r.path}` : null, exposure: r.public ? "public (no token)" : "authenticated", verified: "not-verified" })) };
  }
  async nginxView(conn: string): Promise<any> { return this.with(conn, (c) => c.call<any>("nginx.discover")); }
  async nginxRead(conn: string, file: string): Promise<any> { return this.with(conn, (c) => c.call<any>("nginx.read", { file })); }
  async nginxBackups(conn: string, app: string): Promise<any[]> { return this.with(conn, (c) => c.call<any[]>("nginx.backups", { app })); }
  /** Validates an edit WITHOUT touching the server: the same lint the server applies (nginx -t itself runs on apply, with automatic restore). */
  nginxLint(content: string): string[] { return lintNginx(content); }
  async nginxApply(conn: string, o: { file: string; action: "edit" | "enable" | "disable" | "restore"; content?: string; expectedHash?: string; backupId?: string }): Promise<any> {
    const r = await this.with(conn, (c) => c.call<any>("nginx.apply", o)); this.store.audit("nginx." + o.action, { connection: conn, file: o.file }); return r;
  }
  /** One request to the application's own URL (never a typed host), strict TLS, tokens only over verified TLS, state-changing methods only when confirmed. */
  async testRequest(conn: string, app: string, req: TestRequest, o: { urlIndex?: number; confirmMutating?: boolean; viaTunnel?: boolean; caFile?: string } = {}): Promise<any> {
    const ov = await this.applicationOverview(conn, app); const urls = (ov.resolvedUrls as ResolvedUrl[]).filter((u) => !u.redirectsTo);
    const pick = urls[o.urlIndex ?? Math.max(0, urls.findIndex((u) => u.visibility === "public-binding" && u.scheme === "https"))]; if (!pick) throw new CloudError("this application has no URL to test", "NOT_FOUND");
    const caFile = o.caFile ?? this.get(conn).tlsCaFile; this.requireCaFile(caFile); let baseUrl = pick.url; let tunnel: { close(): void } | undefined; let via = "direct";
    if (o.viaTunnel || pick.visibility === "private") { const local = 20000 + Math.floor(Math.random() * 20000); tunnel = this.tunnel(conn, local, pick.port); await new Promise((r) => setTimeout(r, 2500)); baseUrl = `${pick.scheme}://127.0.0.1:${local}${pick.path === "/" ? "" : pick.path}`; via = "ssh-tunnel"; }
    try {
      const r = await runTest(req, { baseUrl, ...(caFile ? { caFile } : {}), ...(o.confirmMutating ? { confirmMutating: true } : {}) });
      this.store.audit("endpoint.tested", { connection: conn, app, method: req.method.toUpperCase(), path: req.path, status: r.status, via, mutating: r.mutating });
      return { ...r, via, target: pick.url };
    } finally { tunnel?.close(); }
  }

  // ------------------------------------------------------------ release signing (the private key lives in the credential store of THIS machine only)
  signers(): Array<Omit<SignerRecord, "privateRef">> { return this.store.signers().map(({ privateRef: _p, ...s }) => s); }
  signerGenerate(name: string): Omit<SignerRecord, "privateRef"> {
    if (!/^[A-Za-z][A-Za-z0-9 ._@-]{0,62}$/.test(name)) throw new CloudError("a signer name is 1-63 characters: letters, digits, space . _ @ -", "BAD_REQUEST");
    const list = this.store.signers(); if (list.some((s) => s.name === name)) throw new CloudError(`a signer named "${name}" already exists`, "CONFLICT", "Choose another name; rotation means a NEW key");
    const k = generateSigner(); const privateRef = newCredentialRef(); registerSecret(k.privateKey);
    this.creds().set(privateRef, k.privateKey); // fails (never falls back to plain text) when no protected store is available
    const rec: SignerRecord = { name, keyId: k.keyId, publicKey: k.publicKey, createdAt: new Date().toISOString(), privateRef };
    this.store.saveSigners([...list, rec]); this.store.audit("signer.generated", { name, keyId: k.keyId });
    const { privateRef: _p, ...pub } = rec; return pub;
  }
  /** Removes the private key from this machine. It does NOT revoke trust on servers: do that with `trustRevoke` first if the key may be compromised. */
  signerRemove(name: string): { removed: boolean } {
    const list = this.store.signers(); const s = list.find((x) => x.name === name); if (!s) return { removed: false };
    this.creds().remove(s.privateRef); this.store.saveSigners(list.filter((x) => x.name !== name)); this.store.audit("signer.removed", { name, keyId: s.keyId }); return { removed: true };
  }
  /**
   * Signs something on THIS machine with a local signer (a frontend release manifest, for example): `fn` receives the private key and
   * returns the signed result. The key is registered with the redactor, is never returned by this method, and the use is audited.
   */
  signWithSigner<T>(name: string, purpose: string, fn: (privateKeyPem: string, signer: Omit<SignerRecord, "privateRef">) => T): T {
    const s = this.store.signers().find((x) => x.name === name); if (!s) throw new CloudError(`no signer named "${name}"`, "NOT_FOUND", "Create one with signer:generate");
    const key = this.creds().get(s.privateRef); if (!key) throw new CloudError("the private key of that signer is not in this machine's credential store", "NOT_FOUND");
    registerSecret(key); const { privateRef: _p, ...pub } = s;
    const out = fn(key, pub); this.store.audit("signer.used", { name, keyId: s.keyId, purpose }); return out;
  }
  /** Builds the manifest of a release from the directory it was built from. For a git source the commit is read from that checkout. */
  buildManifest(o: { app: string; path: string; sequence: number; artifactFile?: string; url?: string; provenance?: ReleaseManifest["provenance"] }): ReleaseManifest {
    const git = (a: string[]) => spawnSync("git", ["-C", o.path, ...a], { encoding: "utf8", windowsHide: true });
    let source: ReleaseManifest["source"]; let treeHash: string | undefined;
    if (o.artifactFile) { source = { kind: "artifact", sha256: createHash("sha256").update(readFileSync(o.artifactFile)).digest("hex") }; treeHash = treeDigest(o.path); }
    else {
      const head = git(["rev-parse", "HEAD"]); if (head.status !== 0) throw new CloudError(`${o.path} is not a git checkout (give --artifact for an artifact release)`, "BAD_REQUEST");
      const dirty = git(["status", "--porcelain"]).stdout.trim(); if (dirty) throw new CloudError("the checkout has uncommitted changes: sign a clean commit (the server deploys the commit, not your working tree)", "PRECONDITION");
      source = { kind: "git", commit: head.stdout.trim(), gitTree: git(["rev-parse", "HEAD^{tree}"]).stdout.trim(), ...(o.url ? { url: o.url } : {}) };
    }
    if (!Number.isInteger(o.sequence) || o.sequence < 1) throw new CloudError("sequence is a positive integer, greater than the last signed release of this application", "BAD_REQUEST");
    return { v: 1, app: o.app, source, ...(treeHash ? { treeHash } : {}), sequence: o.sequence, createdAt: new Date().toISOString(), ...(o.provenance ? { provenance: o.provenance } : {}) };
  }
  signRelease(signer: string, manifest: ReleaseManifest): SignedManifest {
    const s = this.store.signers().find((x) => x.name === signer); if (!s) throw new CloudError(`no signer named "${signer}"`, "NOT_FOUND", "Create one with signer:generate");
    const key = this.creds().get(s.privateRef); if (!key) throw new CloudError("the private key of that signer is not in this machine's credential store", "NOT_FOUND");
    registerSecret(key); const out = signManifest(manifest, key, s.publicKey); this.store.audit("release.signed", { signer, keyId: s.keyId, app: manifest.app, sequence: manifest.sequence }); return out;
  }
  async trustList(conn: string): Promise<TrustedSigner[]> { return this.with(conn, (c) => c.call<TrustedSigner[]>("trust.list")); }
  async trustAdd(conn: string, o: { signer?: string; publicKey?: string; name?: string; apps?: string[]; notAfter?: string }): Promise<{ keyId: string; name: string }> {
    const local = o.signer ? this.store.signers().find((s) => s.name === o.signer) : undefined; if (o.signer && !local) throw new CloudError(`no signer named "${o.signer}"`, "NOT_FOUND");
    const publicKey = local?.publicKey ?? o.publicKey; const name = o.name ?? local?.name; if (!publicKey || !name) throw new CloudError("give a local signer, or a public key and a name", "BAD_REQUEST");
    const r = await this.with(conn, (c) => c.call<{ keyId: string; name: string }>("trust.add", { publicKey, name, ...(o.apps ? { apps: o.apps } : {}), ...(o.notAfter ? { notAfter: o.notAfter } : {}) }));
    this.store.audit("trust.added", { connection: conn, keyId: r.keyId, name: r.name }); return r;
  }
  async trustRevoke(conn: string, keyId: string, reason?: string): Promise<unknown> { const r = await this.with(conn, (c) => c.call("trust.revoke", { keyId, ...(reason ? { reason } : {}) })); this.store.audit("trust.revoked", { connection: conn, keyId }); return r; }
  async verifyOnServer(conn: string, app: string, signed: SignedManifest, source: { kind: "git"; commit: string } | { kind: "artifact"; sha256: string }): Promise<unknown> { return this.with(conn, (c) => c.call("signature.verify", { app, signed, source })); }

  // ------------------------------------------------------------ releases (the same calls serve the CLI and Studio)
  /** Asks the agent for a plan (it inspects the server and pins a branch or tag to a commit). Nothing is changed on the server except the stored proposal. */
  async plan(conn: string, decl: DeploymentDecl, pipeline: PipelineDecl | undefined, baseDir: string = process.cwd(), signed?: SignedManifest): Promise<import("./agent/plan.ts").Plan> {
    return this.with(conn, async (c) => {
      const artifact = await this.prepareSource(c, decl, baseDir);
      const p = await c.call<import("./agent/plan.ts").Plan>("release.propose", { declaration: decl, ...(pipeline ? { pipeline } : {}), ...(artifact ? { artifact } : {}), ...(signed ? { signed } : {}) });
      this.store.audit("release.planned", { connection: conn, app: p.app, environment: p.environment, release: p.candidateRelease, strategy: p.strategy.type, blockers: p.blockers.length, plan: p.hash });
      return p;
    });
  }
  async approve(conn: string, app: string, planHash: string): Promise<{ approvals: number; required: number }> { const r = await this.with(conn, (c) => c.call<{ approvals: number; required: number }>("release.approve", { app, planHash })); this.store.audit("release.approved", { connection: conn, app, plan: planHash }); return r; }
  async start(conn: string, app: string, planHash: string): Promise<import("./agent/engine.ts").Deployment> { const d = await this.with(conn, (c) => c.call<import("./agent/engine.ts").Deployment>("release.start", { app, planHash })); this.store.audit("release.started", { connection: conn, app, deployment: d.id, release: d.releaseId }); return d; }
  /** Polls the deployment on the server until it ends or its worker disappears. Safe to call again after any disconnection. */
  async follow(conn: string, app: string, id: string, onUpdate?: (d: import("./agent/engine.ts").Deployment & { effectiveState: string }) => void, timeoutMs = 30 * 60_000): Promise<import("./agent/engine.ts").Deployment & { effectiveState: string }> {
    const t0 = Date.now(); let last = "";
    for (;;) {
      const d = await this.with(conn, (c) => c.call<import("./agent/engine.ts").Deployment & { effectiveState: string }>("release.get", { app, deployment: id }));
      const key = `${d.effectiveState}|${d.stages.map((s) => s.status).join(",")}`; if (key !== last) { last = key; onUpdate?.(d); }
      if (["COMPLETED", "FAILED", "CANCELLED", "ROLLED_BACK", "INTERRUPTED"].includes(d.effectiveState)) return d;
      if (Date.now() - t0 > timeoutMs) throw new CloudError("gave up waiting; the deployment continues on the server (see release:status)", "TIMEOUT");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Prepares the source of a declaration for the agent: an uploaded artifact, or nothing for git. Returns the reference to put in the proposal. */
  async prepareSource(c: AgentClient, decl: DeploymentDecl, baseDir: string): Promise<{ uploadId: string; sha256: string; size: number } | undefined> {
    if (decl.source.provider !== "artifact") return undefined;
    let file = resolve(baseDir, decl.source.path); let cleanup: (() => void) | undefined;
    if (!existsSync(file)) throw new CloudError(`artifact not found: ${decl.source.path}`, "NO_ARTIFACT");
    if (statSync(file).isDirectory()) {
      const dir = mkdtempSync(join(tmpdir(), "pso-art-")); const out = join(dir, "artifact.tgz");
      // a RELATIVE output name, run in its own directory: GNU tar (Git for Windows) reads "C:\\..." as the remote host "C"; bsdtar accepts both
      const r = spawnSync("tar", ["-czf", "artifact.tgz", "-C", file, "."], { windowsHide: true, cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new CloudError(`could not pack the artifact directory (tar is required): ${(r.stderr || r.error?.message || "").toString().split("\n")[0]}`, "TAR");
      file = out; cleanup = () => rmSync(dir, { recursive: true, force: true });
    }
    try {
      const size = statSync(file).size; const sum = await new Promise<string>((res, rej) => { const h = createHash("sha256"); const s = createReadStream(file); s.on("data", (b) => h.update(b)); s.on("end", () => res(h.digest("hex"))); s.on("error", rej); });
      const { uploadId } = await c.call<{ uploadId: string }>("artifact.begin", { size, sha256: sum });
      let index = 0; for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024 })) { await c.call("artifact.chunk", { uploadId, index: index++, data: (chunk as Buffer).toString("base64") }, 180_000); }
      await c.call("artifact.commit", { uploadId });
      return { uploadId, sha256: sum, size };
    } finally { cleanup?.(); }
  }
}

/** Safe JSON for printing: every value goes through the redactor first. */
export const safe = (v: unknown): unknown => redactValue(v);
export const declFor = (decls: DeclarationFile[], env: string): { deployment: DeclarationFile; pipeline: DeclarationFile | undefined } => {
  const dep = decls.filter((d) => d.kind === "deployment" && (d.environment === env || d.name === env));
  if (dep.length === 0) throw new CloudError(`no deployment declaration for "${env}" (looked for DEPLOYMENT.pso.ts and deploy/*.deployment.pso.ts)`, "NO_DECLARATION", "Create one with `pso environment:add`");
  if (dep.length > 1) throw new CloudError(`more than one declaration targets "${env}": ${dep.map((d) => d.relative).join(", ")}`, "AMBIGUOUS");
  const d = dep[0]!; const errs = d.diagnostics.filter((x) => x.level === "error");
  if (errs.length) throw new CloudError(`${d.relative} is invalid:\n${errs.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`, "INVALID_DECLARATION");
  const pname = (d.value as DeploymentDecl).pipeline;
  const pl = pname ? decls.find((x) => x.kind === "pipeline" && (x.name === pname)) : decls.find((x) => x.kind === "pipeline" && /^PIPELINE\.pso\.ts$/.test(basename(x.file)));
  if (pname && pname !== "default" && !pl) throw new CloudError(`pipeline "${pname}" is not declared (deploy/${pname}.pipeline.pso.ts)`, "NO_PIPELINE");
  if (pl && pl.diagnostics.some((x) => x.level === "error")) throw new CloudError(`${pl.relative} is invalid:\n${pl.diagnostics.filter((x) => x.level === "error").map((e) => `  ${e.path}: ${e.message}`).join("\n")}`, "INVALID_PIPELINE");
  return { deployment: d, pipeline: pl };
};
export const servicesNames = (d: DeploymentDecl): string[] => servicesOf(d).map((s) => s.name);
export type { DeploymentDecl, PipelineDecl };
