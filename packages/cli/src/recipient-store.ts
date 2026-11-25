import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPair } from "./psopkg.ts";

/**
 * The recipient identity of one developer: an X25519 key pair generated LOCALLY, so a private key never travels to the maintainer.
 *
 *   <store>/identity.json   public key, fingerprints, the protected private key, pinned signer fingerprints (the independent trust anchor)
 *
 * The private key is protected in one of two ways:
 *  - "dpapi": Windows DPAPI, scope CurrentUser, through the system PowerShell (no native module). Only the same Windows user on the same machine
 *    (profile) can unprotect it. A different account, an elevated session of another account, a reinstalled Windows or a new machine cannot.
 *  - "passphrase": scrypt + AES-256-GCM. Portable, and the format of the backup export. Used where DPAPI is unavailable (for instance
 *    PowerShell Constrained Language Mode) and for recovery.
 * The private key is never written to disk in plaintext by this module. Node cannot reliably wipe strings from memory, so the key
 * lives in memory only for the time of the operation that needs it; that is a limitation, not a guarantee.
 */
export class RecipientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "RecipientError"; this.code = code; }
}

export interface PinnedSigner { fingerprint: string; label: string; pinnedAt: string }
export type Protection =
  | { kind: "dpapi"; scope: "CurrentUser"; user: string; machine: string }
  | { kind: "passphrase"; kdf: "scrypt"; salt: string; N: number; r: number; p: number; iv: string; tag: string };
export interface Identity {
  schema: 1; label: string; createdAt: string;
  /** 16 hex characters: the id the .psopkg header uses to find this recipient */
  keyId: string;
  /** SHA-256 of the public key (SPKI DER), 64 hex characters: what a human compares out of band */
  fingerprint: string;
  publicKeyPem: string;
  protection: Protection;
  /** the protected private key (DPAPI blob, or the AES-GCM ciphertext), base64 */
  privateBlob: string;
  pinnedSigners: PinnedSigner[];
}

const ENTROPY = "PSO recipient identity v1";
const sha256hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
export const fullFingerprint = (publicKeyPem: string): string => sha256hex(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }));
/** 64 hex characters grouped for reading aloud and comparing: `ab12 cd34 ...` */
export const groupFingerprint = (fp: string): string => fp.replace(/(.{4})/g, "$1 ").trim();
export const normalizeFingerprint = (s: string): string => s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();

export function defaultStoreDir(): string {
  const e = process.env["PSO_RECIPIENT_HOME"];
  if (e) return e;
  if (process.platform === "win32") return join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "PSO", "recipient");
  return join(homedir(), ".pso", "recipient");
}
const identityFile = (dir: string): string => join(dir, "identity.json");
export const identityExists = (dir: string = defaultStoreDir()): boolean => existsSync(identityFile(dir));

// ---------------------------------------------------------------- DPAPI through the system PowerShell
function powershell(): string {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function dpapi(op: "Protect" | "Unprotect", base64: string): string {
  if (process.platform !== "win32") throw new RecipientError("DPAPI_UNAVAILABLE", "Windows DPAPI is only available on Windows; use --store passphrase");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())",
    `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$r=[Security.Cryptography.ProtectedData]::${op}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($r))",
  ].join(";");
  const r = spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { input: base64, encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (r.error || r.status !== 0) {
    const detail = ((r.stderr ?? "") + (r.error?.message ?? "")).replace(/\s+/g, " ").trim();
    if (/Constrained|not allowed|cannot be performed|ConstrainedLanguage/i.test(detail)) throw new RecipientError("DPAPI_UNAVAILABLE", "PowerShell is in Constrained Language Mode on this machine, so DPAPI cannot be used; use --store passphrase");
    if (op === "Unprotect") throw new RecipientError("DPAPI_UNPROTECT_FAILED", `the private key could not be unprotected by this Windows account (${userInfo().username}). It was protected by another account or machine, or the profile changed. Do not run the installer elevated as a different user; restore the key from your passphrase backup, or enroll a new key (see the recipient guide)`);
    throw new RecipientError("DPAPI_PROTECT_FAILED", `DPAPI protection failed${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  return (r.stdout ?? "").trim();
}

// ---------------------------------------------------------------- passphrase protection
const SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const;
function sealWithPassphrase(plain: Buffer, passphrase: string): { protection: Extract<Protection, { kind: "passphrase" }>; blob: string } {
  if (passphrase.length < 12) throw new RecipientError("PASSPHRASE_WEAK", "the passphrase must have at least 12 characters");
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { ...SCRYPT, maxmem: 128 * 1024 * 1024 });
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("PSO recipient identity v1"));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { protection: { kind: "passphrase", kdf: "scrypt", salt: salt.toString("base64"), ...SCRYPT, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") }, blob: ct.toString("base64") };
}
function openWithPassphrase(p: Extract<Protection, { kind: "passphrase" }>, blob: string, passphrase: string): Buffer {
  try {
    const key = scryptSync(passphrase, Buffer.from(p.salt, "base64"), 32, { N: p.N, r: p.r, p: p.p, maxmem: 128 * 1024 * 1024 });
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64"));
    d.setAAD(Buffer.from("PSO recipient identity v1"));
    d.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(blob, "base64")), d.final()]);
  } catch { throw new RecipientError("PASSPHRASE_WRONG", "the passphrase is wrong or the identity file was modified"); }
}

// ---------------------------------------------------------------- store
function lockDirectory(dir: string): void {
  try { chmodSync(dir, 0o700); } catch { /* not supported on this file system */ }
  if (process.platform === "win32") {
    // remove inherited permissions and grant only the current user: best effort, never a guarantee against an administrator
    spawnSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe"), [dir, "/inheritance:r", "/grant:r", `${userInfo().username}:(OI)(CI)F`], { windowsHide: true, timeout: 30_000 });
  }
}
function write(dir: string, id: Identity): void {
  mkdirSync(dir, { recursive: true });
  const f = identityFile(dir), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(id, null, 2), { mode: 0o600 });
  renameSync(tmp, f);
}
export function readIdentity(dir: string = defaultStoreDir()): Identity {
  if (!identityExists(dir)) throw new RecipientError("IDENTITY_MISSING", `no recipient identity in ${dir}. Run the recipient utility first: pso-recipient init`);
  try {
    const id = JSON.parse(readFileSync(identityFile(dir), "utf8")) as Identity;
    if (id.schema !== 1 || !id.publicKeyPem || !id.privateBlob || !id.protection) throw new Error("shape");
    if (fullFingerprint(id.publicKeyPem) !== id.fingerprint) throw new Error("fingerprint");
    return id;
  } catch { throw new RecipientError("IDENTITY_CORRUPT", `the recipient identity in ${dir} is damaged. Restore it from your backup (pso-recipient restore) or enroll a new key`); }
}

export interface CreateOptions { dir?: string; label: string; store: "dpapi" | "passphrase"; passphrase?: string; force?: boolean }
/** Generates the key pair locally and stores it protected. Returns only public information. */
export function createIdentity(o: CreateOptions): { dir: string; label: string; keyId: string; fingerprint: string; publicKeyPem: string; store: string } {
  const dir = o.dir ?? defaultStoreDir();
  if (identityExists(dir) && !o.force) throw new RecipientError("IDENTITY_EXISTS", `an identity already exists in ${dir}. Overwriting it would make every release encrypted for it unreadable; use a backup, or pass --force deliberately`);
  if (!/^[A-Za-z0-9._ -]{1,60}$/.test(o.label)) throw new RecipientError("LABEL_INVALID", "the label may contain letters, digits, space, dot, underscore and hyphen (60 characters at most)");
  const kp = generateKeyPair("recipient");
  const pem = Buffer.from(kp.privateKeyPem, "utf8");
  let protection: Protection, blob: string;
  if (o.store === "dpapi") { blob = dpapi("Protect", pem.toString("base64")); protection = { kind: "dpapi", scope: "CurrentUser", user: userInfo().username, machine: process.env["COMPUTERNAME"] ?? "" }; }
  else { if (!o.passphrase) throw new RecipientError("PASSPHRASE_REQUIRED", "--store passphrase needs a passphrase"); const s = sealWithPassphrase(pem, o.passphrase); protection = s.protection; blob = s.blob; }
  pem.fill(0);
  const existing = identityExists(dir) ? readIdentitySafe(dir) : undefined;
  const id: Identity = { schema: 1, label: o.label, createdAt: new Date().toISOString(), keyId: kp.id, fingerprint: fullFingerprint(kp.publicKeyPem), publicKeyPem: kp.publicKeyPem, protection, privateBlob: blob, pinnedSigners: existing?.pinnedSigners ?? [] };
  mkdirSync(dir, { recursive: true });
  lockDirectory(dir);
  write(dir, id);
  return { dir, label: id.label, keyId: id.keyId, fingerprint: id.fingerprint, publicKeyPem: id.publicKeyPem, store: id.protection.kind };
}
function readIdentitySafe(dir: string): Identity | undefined { try { return readIdentity(dir); } catch { return undefined; } }

/** The private key PEM, unprotected for the caller. The passphrase is only needed for identities stored with it. */
export function loadPrivateKeyPem(o: { dir?: string; passphrase?: string } = {}): string {
  const id = readIdentity(o.dir ?? defaultStoreDir());
  if (id.protection.kind === "dpapi") return Buffer.from(dpapi("Unprotect", id.privateBlob), "base64").toString("utf8");
  const pass = o.passphrase ?? process.env["PSO_RECIPIENT_PASSPHRASE"];
  if (!pass) throw new RecipientError("PASSPHRASE_REQUIRED", "this identity is protected by a passphrase: set PSO_RECIPIENT_PASSPHRASE or pass it to the tool");
  return openWithPassphrase(id.protection, id.privateBlob, pass).toString("utf8");
}

// ---------------------------------------------------------------- pinned signers (the independent trust anchor)
// Stored in <store>/trust.json, NOT in the identity: a developer who installs a public (unencrypted) release has no recipient identity, and a
// clean machine must be able to establish trust before anything else exists. Pins written by earlier versions inside identity.json are still honoured.
// A pin is only ever created by an explicit act of the person (pin-signer, or the fingerprint typed into the installer): never from the installer's own contents.
const trustFile = (dir: string): string => join(dir, "trust.json");
const FP_RE = /^[0-9a-f]{64}$/;
function readTrustFile(dir: string): PinnedSigner[] {
  if (!existsSync(trustFile(dir))) return [];
  try {
    const j = JSON.parse(readFileSync(trustFile(dir), "utf8")) as { schema?: number; pinnedSigners?: PinnedSigner[] };
    if (j.schema !== 1 || !Array.isArray(j.pinnedSigners) || !j.pinnedSigners.every((p) => FP_RE.test(p.fingerprint))) throw new Error("shape");
    return j.pinnedSigners;
  } catch { throw new RecipientError("TRUST_STORE_CORRUPT", `the signer trust store ${trustFile(dir)} is damaged. Remove it and pin the signer again with the fingerprint the maintainer gave you (pso-recipient pin-signer --fingerprint ...)`); }
}
function writeTrustFile(dir: string, pins: PinnedSigner[]): void {
  mkdirSync(dir, { recursive: true });
  const f = trustFile(dir), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: 1, pinnedSigners: pins }, null, 2), { mode: 0o600 });
  renameSync(tmp, f);
}
export function pinSigner(o: { dir?: string; fingerprint: string; label: string }): PinnedSigner {
  const dir = o.dir ?? defaultStoreDir();
  const fp = normalizeFingerprint(o.fingerprint);
  if (!FP_RE.test(fp)) throw new RecipientError("FINGERPRINT_INVALID", "a signer fingerprint is the 64 hexadecimal characters of the SHA-256 of the signing public key");
  const pin: PinnedSigner = { fingerprint: fp, label: o.label, pinnedAt: new Date().toISOString() };
  writeTrustFile(dir, [...readTrustFile(dir).filter((p) => p.fingerprint !== fp), pin]);
  return pin;
}
/** Signer rotation, second half: once the old key is retired, stop accepting it. Removes the pin from both the trust store and a legacy identity pin. */
export function unpinSigner(o: { dir?: string; fingerprint: string }): boolean {
  const dir = o.dir ?? defaultStoreDir();
  const fp = normalizeFingerprint(o.fingerprint);
  if (!FP_RE.test(fp)) throw new RecipientError("FINGERPRINT_INVALID", "a signer fingerprint is the 64 hexadecimal characters of the SHA-256 of the signing public key");
  const before = readTrustFile(dir);
  let removed = before.some((p) => p.fingerprint === fp);
  if (removed) writeTrustFile(dir, before.filter((p) => p.fingerprint !== fp));
  if (identityExists(dir)) { const id = readIdentity(dir); if (id.pinnedSigners.some((p) => p.fingerprint === fp)) { id.pinnedSigners = id.pinnedSigners.filter((p) => p.fingerprint !== fp); write(dir, id); removed = true; } }
  return removed;
}
export function pinnedSigners(dir: string = defaultStoreDir()): PinnedSigner[] {
  const legacy = identityExists(dir) ? readIdentity(dir).pinnedSigners : [];
  const all = [...readTrustFile(dir)];
  for (const p of legacy) if (!all.some((x) => x.fingerprint === p.fingerprint)) all.push(p);
  return all;
}

/** Passphrase-protected export of the private key for recovery after an account change or a machine replacement. */
export function exportBackup(o: { dir?: string; out: string; passphrase: string; unlockPassphrase?: string }): { out: string; fingerprint: string } {
  const id = readIdentity(o.dir ?? defaultStoreDir());
  const pem = Buffer.from(loadPrivateKeyPem({ ...(o.dir ? { dir: o.dir } : {}), ...(o.unlockPassphrase ? { passphrase: o.unlockPassphrase } : {}) }), "utf8");
  const s = sealWithPassphrase(pem, o.passphrase);
  pem.fill(0);
  if (existsSync(o.out)) throw new RecipientError("BACKUP_EXISTS", `${o.out} already exists; backups are never overwritten`);
  writeFileSync(o.out, JSON.stringify({ schema: 1, kind: "pso-recipient-backup", label: id.label, createdAt: new Date().toISOString(), keyId: id.keyId, fingerprint: id.fingerprint, publicKeyPem: id.publicKeyPem, pinnedSigners: pinnedSigners(o.dir ?? defaultStoreDir()), protection: s.protection, privateBlob: s.blob }, null, 2), { mode: 0o600 });
  return { out: o.out, fingerprint: id.fingerprint };
}
export function restoreBackup(o: { dir?: string; file: string; passphrase: string; store: "dpapi" | "passphrase"; newPassphrase?: string; force?: boolean }): { fingerprint: string; store: string } {
  const dir = o.dir ?? defaultStoreDir();
  if (identityExists(dir) && !o.force) throw new RecipientError("IDENTITY_EXISTS", `an identity already exists in ${dir}; pass --force to replace it`);
  let b: Identity & { kind?: string };
  try { b = JSON.parse(readFileSync(o.file, "utf8")); if (b.kind !== "pso-recipient-backup" || b.protection.kind !== "passphrase") throw new Error("shape"); } catch { throw new RecipientError("BACKUP_INVALID", "the file is not a PSO recipient backup"); }
  const pem = openWithPassphrase(b.protection, b.privateBlob, o.passphrase);
  if (fullFingerprint(b.publicKeyPem) !== b.fingerprint) throw new RecipientError("BACKUP_INVALID", "the backup's public key does not match its fingerprint");
  let protection: Protection, blob: string;
  if (o.store === "dpapi") { blob = dpapi("Protect", pem.toString("base64")); protection = { kind: "dpapi", scope: "CurrentUser", user: userInfo().username, machine: process.env["COMPUTERNAME"] ?? "" }; }
  else { const s = sealWithPassphrase(pem, o.newPassphrase ?? o.passphrase); protection = s.protection; blob = s.blob; }
  pem.fill(0);
  mkdirSync(dir, { recursive: true });
  lockDirectory(dir);
  write(dir, { schema: 1, label: b.label, createdAt: b.createdAt, keyId: b.keyId, fingerprint: b.fingerprint, publicKeyPem: b.publicKeyPem, protection, privateBlob: blob, pinnedSigners: [] });
  for (const p of b.pinnedSigners ?? []) if (FP_RE.test(p.fingerprint ?? "")) pinSigner({ dir, fingerprint: p.fingerprint, label: p.label });
  return { fingerprint: b.fingerprint, store: protection.kind };
}

/** Public, non-secret description for status output. */
export function describeIdentity(dir: string = defaultStoreDir()): { dir: string; label: string; keyId: string; fingerprint: string; store: string; user?: string; machine?: string; pinnedSigners: PinnedSigner[] } {
  const id = readIdentity(dir);
  return { dir, label: id.label, keyId: id.keyId, fingerprint: id.fingerprint, store: id.protection.kind, ...(id.protection.kind === "dpapi" ? { user: id.protection.user, machine: id.protection.machine } : {}), pinnedSigners: pinnedSigners(dir) };
}
export function removeIdentity(dir: string = defaultStoreDir()): void { rmSync(identityFile(dir), { force: true }); }
