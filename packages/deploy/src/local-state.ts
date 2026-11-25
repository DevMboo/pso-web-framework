import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, sha256 } from "./crypto.ts";
import { redactValue } from "./redact.ts";
import { defaultHome } from "./credentials.ts";

/**
 * State kept on the machine of the person using the CLI or Studio (PSO_CLOUD_HOME, default ~/.pso-cloud): the registry of connections, the pinned
 * SSH host keys, and a local audit trail. It holds REFERENCES to credentials (opaque ids in the credential store), never secret values.
 */
export type AuthKind = "key" | "agent" | "password";
export interface JumpHost { host: string; port: number; user: string }
export interface ConnectionRecord {
  name: string;
  host: string;
  port: number;
  user: string;
  auth: { kind: AuthKind; /** path of a private key file that stays where it is (it is never copied) */ keyPath?: string; /** reference of the key's passphrase in the credential store */ passphraseRef?: string; /** reference of the password in the credential store */ passwordRef?: string };
  jump?: JumpHost;
  timeoutSeconds: number;
  /** SSH host key fingerprint approved by the user (SHA256:...); the connection fails if the server presents another */
  hostKeyFingerprint?: string;
  /** location of the agent on the server, relative to its home directory */
  agentDir: string;
  agentFingerprint?: string;
  /** reference (credential store) of the Ed25519 client key used with the agent, and its identifier on the server */
  /** a PEM file with the certificate authority of this environment's TLS certificates (private CA); verification stays ON, it only adds a trust anchor */
  tlsCaFile?: string;
  clientKeyRef?: string;
  clientId?: string;
  role?: string;
  environmentId?: string;
  createdAt: string;
  credentialVersion: number;
  revoked?: boolean;
}

interface Registry { version: 1; connections: Record<string, ConnectionRecord> }

/** A release-signing identity of THIS machine. `privateRef` is a reference into the credential store; the private key itself is never in this file. */
export interface SignerRecord { name: string; keyId: string; publicKey: string; createdAt: string; privateRef: string }

export class LocalStore {
  readonly home: string;
  constructor(home: string = defaultHome()) { this.home = home; mkdirSync(home, { recursive: true }); try { chmodSync(home, 0o700); } catch { /* not supported on this file system */ } }

  private get registryFile(): string { return join(this.home, "connections.json"); }
  get knownHostsFile(): string { return join(this.home, "known_hosts"); }
  get auditFile(): string { return join(this.home, "audit.jsonl"); }

  private read(): Registry { return existsSync(this.registryFile) ? (JSON.parse(readFileSync(this.registryFile, "utf8")) as Registry) : { version: 1, connections: {} }; }
  private write(r: Registry): void {
    const tmp = `${this.registryFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
    renameSync(tmp, this.registryFile);
  }
  connections(): ConnectionRecord[] { return Object.values(this.read().connections).sort((a, b) => a.name.localeCompare(b.name)); }
  connection(name: string): ConnectionRecord | undefined { return this.read().connections[name]; }
  saveConnection(c: ConnectionRecord): void { const r = this.read(); r.connections[c.name] = c; this.write(r); }
  removeConnection(name: string): boolean { const r = this.read(); if (!r.connections[name]) return false; delete r.connections[name]; this.write(r); return true; }

  private get signersFile(): string { return join(this.home, "signers.json"); }
  signers(): SignerRecord[] { return existsSync(this.signersFile) ? (JSON.parse(readFileSync(this.signersFile, "utf8")) as SignerRecord[]) : []; }
  saveSigners(s: SignerRecord[]): void { const tmp = `${this.signersFile}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(tmp, this.signersFile); }

  /** Local audit trail: sanitized, append-only, hash-chained (tamper-EVIDENT for accidental or unsophisticated changes; a user with write access to the file can rewrite the whole chain). */
  audit(event: string, data: Record<string, unknown> = {}): void {
    const prev = this.lastAuditHash();
    const body = { ts: new Date().toISOString(), event, data: redactValue(data), prev };
    const line = JSON.stringify({ ...body, hash: sha256(canonical(body)) });
    mkdirSync(dirname(this.auditFile), { recursive: true });
    appendFileSync(this.auditFile, line + "\n", { mode: 0o600 });
  }
  private lastAuditHash(): string {
    if (!existsSync(this.auditFile)) return "genesis";
    const lines = readFileSync(this.auditFile, "utf8").trimEnd().split("\n");
    try { return (JSON.parse(lines[lines.length - 1]!) as { hash: string }).hash; } catch { return "corrupt"; }
  }
  readAudit(limit = 200): Array<Record<string, unknown>> {
    if (!existsSync(this.auditFile)) return [];
    return readFileSync(this.auditFile, "utf8").trimEnd().split("\n").filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { event: "corrupt-line" }; } });
  }
  verifyAudit(): { ok: boolean; entries: number; brokenAt?: number } {
    if (!existsSync(this.auditFile)) return { ok: true, entries: 0 };
    let prev = "genesis"; let n = 0;
    for (const line of readFileSync(this.auditFile, "utf8").trimEnd().split("\n").filter(Boolean)) {
      n++;
      try {
        const { hash, ...body } = JSON.parse(line) as { hash: string; prev: string };
        if (body.prev !== prev || sha256(canonical(body)) !== hash) return { ok: false, entries: n, brokenAt: n };
        prev = hash;
      } catch { return { ok: false, entries: n, brokenAt: n }; }
    }
    return { ok: true, entries: n };
  }
}

/** Public view of a connection: nothing that could help an attacker beyond what the user already sees. */
export const describeConnection = (c: ConnectionRecord) => ({
  name: c.name, host: c.host, port: c.port, user: c.user, auth: c.auth.kind, keyPath: c.auth.keyPath, hasPassphrase: !!c.auth.passphraseRef, hasPassword: !!c.auth.passwordRef,
  jump: c.jump, timeoutSeconds: c.timeoutSeconds, hostKeyFingerprint: c.hostKeyFingerprint, agentFingerprint: c.agentFingerprint, tlsCaFile: c.tlsCaFile, clientId: c.clientId, role: c.role,
  environmentId: c.environmentId, enrolled: !!c.clientKeyRef && !!c.clientId, revoked: !!c.revoked, credentialVersion: c.credentialVersion, createdAt: c.createdAt,
});
