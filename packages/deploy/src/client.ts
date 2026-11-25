import type { ChildProcess } from "node:child_process";
import { explainSshFailure } from "./keyaccess.ts";
import { createInterface } from "node:readline";
import { fingerprint, randomToken, signText, verifyText } from "./crypto.ts";
import { readSecret, type CredentialProvider } from "./credentials.ts";
import type { ConnectionRecord, LocalStore } from "./local-state.ts";
import { PROTOCOL_VERSIONS, enrollPayload, helloPayload, sessionPayload, signRequest, type Request, type Response } from "./protocol.ts";
import { redactText } from "./redact.ts";
import { spawnAgentOverSsh } from "./ssh.ts";

/** A line-oriented, request/response channel to an agent. Implemented over SSH, over a child process and in-process (tests). */
export interface Transport { send(req: Request, timeoutMs: number): Promise<Response>; close(): void }

export class CloudError extends Error {
  readonly code: string; readonly hint: string | undefined;
  constructor(message: string, code: string = "ERROR", hint?: string) { super(message); this.code = code; this.hint = hint; }
}

export class StdioTransport implements Transport {
  private nextWaiters = new Map<number, (r: Response) => void>();
  private closed = false; private stderr = "";
  private readonly child: ChildProcess; private readonly onClose: (() => void) | undefined;
  constructor(child: ChildProcess, onClose?: () => void) {
    this.child = child; this.onClose = onClose;
    createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (l) => { try { const r = JSON.parse(l) as Response; const w = this.nextWaiters.get(r.id); if (w) { this.nextWaiters.delete(r.id); w(r); } } catch { /* ignore non-protocol output */ } });
    child.stderr?.on("data", (b: Buffer) => { this.stderr = (this.stderr + b.toString("utf8")).slice(-2000); });
    child.on("close", () => { this.closed = true; for (const w of this.nextWaiters.values()) w({ id: -1, ok: false, error: { code: "INTERNAL", message: `CONNECTION_CLOSED${this.stderr.trim() ? `: ${redactText(this.stderr.trim())}` : ""}${explainSshFailure(this.stderr) ? ` - ${explainSshFailure(this.stderr)!.advice}` : ""}` } }); this.nextWaiters.clear(); this.onClose?.(); });
  }
  send(req: Request, timeoutMs: number): Promise<Response> {
    return new Promise((res, rej) => {
      if (this.closed) return res({ id: req.id, ok: false, error: { code: "INTERNAL", message: "CONNECTION_CLOSED" } });
      const t = setTimeout(() => { this.nextWaiters.delete(req.id); rej(new CloudError(`no answer from the server within ${Math.round(timeoutMs / 1000)}s (the operation may still be running there; check its status)`, "TIMEOUT")); }, timeoutMs);
      this.nextWaiters.set(req.id, (r) => { clearTimeout(t); res(r.id === -1 ? { ...r, id: req.id } : r); });
      this.child.stdin!.write(JSON.stringify(req) + "\n", (e) => { if (e) { clearTimeout(t); res({ id: req.id, ok: false, error: { code: "INTERNAL", message: "CONNECTION_CLOSED" } }); } });
    });
  }
  close(): void { try { this.child.stdin?.end(); } catch { /* closed */ } setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } }, 1500).unref(); }
}

export const READ_ONLY_OPS = new Set(["whoami", "inspect", "policy.get", "release.status", "release.history", "release.list", "release.get", "release.plans", "logs.read", "service.status", "proxy.status", "audit.read", "audit.verify", "client.list", "secret.list", "provision.plan"]);

export interface ConnectOptions {
  /** accept the agent identity the first time (only safe when it was obtained through the authenticated SSH channel, e.g. right after provisioning) */
  pinAgent?: string;
  transport?: () => Transport;
  /** do not open a session (enrollment) */
  noSession?: boolean;
  requestTimeoutMs?: number;
}

export class AgentClient {
  private seq = 0; private sid: string | undefined; private id = 0;
  agent: { fingerprint?: string; publicKey?: string; environmentId?: string; mode?: string; provisioned: boolean; agentVersion?: string; serverNonce?: string } = { provisioned: false };
  session: { role?: string; name?: string; expiresAt?: string } = {};
  readonly conn: ConnectionRecord; private transport: Transport; private readonly deps: { store: LocalStore; creds: CredentialProvider }; private readonly opts: ConnectOptions; private readonly clientKey: string | undefined;
  private constructor(conn: ConnectionRecord, transport: Transport, deps: { store: LocalStore; creds: CredentialProvider }, opts: ConnectOptions, clientKey: string | undefined) { this.conn = conn; this.transport = transport; this.deps = deps; this.opts = opts; this.clientKey = clientKey; }

  static async connect(conn: ConnectionRecord, deps: { store: LocalStore; creds: CredentialProvider }, opts: ConnectOptions = {}): Promise<AgentClient> {
    if (conn.revoked) throw new CloudError(`connection "${conn.name}" was revoked on this machine`, "REVOKED", "Add the connection again to use it");
    const key = conn.clientKeyRef ? readSecret(deps.creds, conn.clientKeyRef) : undefined;
    if (conn.clientKeyRef && key === undefined) throw new CloudError("the client key of this connection is missing from the credential store", "NO_CREDENTIAL", "Run `pso connection:rotate` or enroll again");
    const c = new AgentClient(conn, opts.transport ? opts.transport() : AgentClient.sshTransport(conn, deps), deps, opts, key);
    try { await c.handshake(); } catch (e) { c.close(); throw e; }
    return c;
  }

  private static sshTransport(conn: ConnectionRecord, deps: { store: LocalStore; creds: CredentialProvider }): Transport {
    const secrets: { password?: string; passphrase?: string } = {};
    if (conn.auth.passwordRef) { const p = readSecret(deps.creds, conn.auth.passwordRef); if (p === undefined) throw new CloudError("the SSH password is missing from the credential store", "NO_CREDENTIAL"); secrets.password = p; }
    if (conn.auth.passphraseRef) { const p = readSecret(deps.creds, conn.auth.passphraseRef); if (p === undefined) throw new CloudError("the SSH key passphrase is missing from the credential store", "NO_CREDENTIAL"); secrets.passphrase = p; }
    const { child } = spawnAgentOverSsh(conn, { knownHosts: deps.store.knownHostsFile, secrets });
    return new StdioTransport(child);
  }

  private async raw(op: string, args: unknown, auth?: Request["auth"], timeoutMs = this.opts.requestTimeoutMs ?? 120_000): Promise<unknown> {
    const req: Request = { v: 1, id: ++this.id, op, args, ...(auth ? { auth } : {}) };
    const r = await this.transport.send(req, timeoutMs);
    if (!r.ok) throw this.toError(r.error.code, r.error.message);
    return r.result;
  }
  private toError(code: string, message: string): CloudError {
    if (message.startsWith("CONNECTION_CLOSED")) return new CloudError(`the connection to ${this.conn.host} closed${message.length > 17 ? ` (${message.slice(19)})` : ""}`, "CONNECTION_CLOSED", "Check the SSH connection with `pso connection:test`");
    return new CloudError(message, code, code === "FORBIDDEN" ? "Ask an administrator of the environment for a higher role" : code === "NOT_PROVISIONED" ? "Run `pso agent:install`" : undefined);
  }

  private async handshake(): Promise<void> {
    const challenge = randomToken(24);
    const h = (await this.raw("hello", { versions: [...PROTOCOL_VERSIONS], challenge })) as { version: number; agentVersion: string; provisioned: boolean; mode: string; environmentId?: string; publicKey?: string; fingerprint?: string; signature?: string; serverNonce: string };
    this.agent = { provisioned: h.provisioned, mode: h.mode, agentVersion: h.agentVersion, serverNonce: h.serverNonce, ...(h.environmentId ? { environmentId: h.environmentId } : {}) };
    if (!h.provisioned) return;
    // the agent proves possession of its key by signing OUR challenge (and its per-connection nonce): a recorded answer cannot be replayed
    if (!h.publicKey || !h.signature || !verifyText(h.publicKey, helloPayload(challenge, h.agentVersion, h.serverNonce), h.signature)) throw new CloudError("the agent did not prove its identity (bad signature)", "IDENTITY");
    const fp = fingerprint(h.publicKey);
    if (fp !== h.fingerprint) throw new CloudError("the agent's reported fingerprint does not match its key", "IDENTITY");
    const pinned = this.conn.agentFingerprint ?? this.opts.pinAgent;
    if (!pinned) throw new CloudError(`the agent identity ${fp} is not pinned for this connection`, "NOT_PINNED", "Run `pso agent:install` (or `pso connection:test --pin-agent <fingerprint>` after checking the fingerprint on the server with `pso-agent status`)");
    if (pinned !== fp) throw new CloudError(`AGENT IDENTITY CHANGED: this server presented ${fp} but ${pinned} is pinned. Someone may be impersonating the server, or it was reinstalled. Nothing was sent.`, "IDENTITY_CHANGED", "If the server was reinstalled on purpose, remove the connection and add it again");
    this.agent.fingerprint = fp; this.agent.publicKey = h.publicKey;
    if (this.opts.noSession || !this.clientKey || !this.conn.clientId) return;
    const clientNonce = randomToken(18);
    const s = (await this.raw("session.open", { clientId: this.conn.clientId, clientNonce, signature: signText(this.clientKey, sessionPayload(this.conn.clientId, h.serverNonce, clientNonce)) })) as { sessionId: string; role: string; name: string; expiresAt: string };
    this.sid = s.sessionId; this.session = { role: s.role, name: s.name, expiresAt: s.expiresAt };
  }

  /** Enrolls a new client key with a single-use token. The private key never leaves this machine. */
  async enroll(token: string, publicKey: string, privateKey: string, name: string): Promise<{ clientId: string; role: string; environmentId: string }> {
    const m = /^pso-enroll-([A-Za-z0-9_-]{6,12})\./.exec(token); if (!m) throw new CloudError("malformed enrollment token", "BAD_TOKEN");
    const signature = signText(privateKey, enrollPayload(m[1]!, publicKey, this.agent.serverNonce!));
    return (await this.raw("enroll", { token, publicKey, name, signature })) as { clientId: string; role: string; environmentId: string };
  }

  async call<T = unknown>(op: string, args: unknown = {}, timeoutMs?: number): Promise<T> {
    if (!this.sid || !this.clientKey) throw new CloudError("this connection has no enrolled client identity", "NOT_ENROLLED", "Run `pso agent:install` or `pso agent:enroll`");
    const send = async (): Promise<unknown> => this.raw(op, args, signRequest(this.clientKey!, this.sid!, ++this.seq, op, args), timeoutMs);
    try { return (await send()) as T; } catch (e) {
      const lost = e instanceof CloudError && (e.code === "CONNECTION_CLOSED" || e.code === "TIMEOUT");
      if (!lost) throw e;
      if (!READ_ONLY_OPS.has(op)) throw new CloudError(`the connection was lost during "${op}". It may or may not have been applied on the server: it was NOT retried automatically. A deployment started on the server keeps running independently; check it with \`pso release:status\`.`, "UNCERTAIN");
      // controlled reconnection for reads only: bounded attempts, growing pauses, a fresh session
      let last: unknown = e;
      for (const wait of [1000, 3000]) {
        await new Promise((r) => setTimeout(r, wait));
        try { this.transport.close(); this.transport = this.opts.transport ? this.opts.transport() : AgentClient.sshTransport(this.conn, this.deps); this.sid = undefined; this.seq = 0; await this.handshake(); return (await send()) as T; } catch (err) { last = err; }
      }
      throw last;
    }
  }

  close(): void { try { this.transport.close(); } catch { /* closed */ } }
}
