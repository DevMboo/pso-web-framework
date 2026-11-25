import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerSecret } from "./redact.ts";

/**
 * Credential protection for the machine that runs the CLI or Studio.
 *
 * Secrets live in a CredentialProvider, never in a project file, a log, a manifest or an argument list. A provider is chosen
 * explicitly or detected from the operating system:
 *
 *   windows-credential-manager  Windows Credential Manager (CredWrite/CredRead through PowerShell; the secret is sent on stdin)
 *   secret-service              the Linux Secret Service / system keyring through `secret-tool` (secret on stdin)
 *   macos-keychain              the macOS Keychain through `security -i` (secret on stdin as hex). IMPLEMENTED BUT NOT EXERCISED in
 *                               this repository's test environment
 *   encrypted-file              AES-256-GCM with a key derived (scrypt) from a passphrase or key file the user provides explicitly
 *
 * If none is available, operations fail with instructions. There is NO plaintext fallback.
 * Guarantees and limits: a native store protects against other users and against disk theft; it does NOT protect against malware
 * running as the same user, which can ask the same store for the secret. The encrypted-file provider is exactly as strong as its
 * passphrase or key file.
 */
export interface CredentialProvider {
  readonly id: string;
  availability(): { ok: boolean; reason?: string };
  set(ref: string, secret: string): void;
  get(ref: string): string | undefined;
  remove(ref: string): boolean;
}

export class CredentialStoreError extends Error {}
const unavailable = (why: string): CredentialStoreError => new CredentialStoreError(`No protected credential store is available: ${why}. PSO never stores secrets in plain text. Configure one: on Linux install libsecret-tools (secret-tool) with a running keyring, or set PSO_CREDENTIAL_PROVIDER=encrypted-file with PSO_CREDENTIAL_PASSPHRASE or PSO_CREDENTIAL_KEYFILE.`);
const safeRef = (ref: string): string => { if (!/^[A-Za-z0-9._:-]{1,120}$/.test(ref)) throw new CredentialStoreError("invalid credential reference"); return ref; };
const run = (cmd: string, args: string[], input?: string) => spawnSync(cmd, args, { input, encoding: "utf8", windowsHide: true, timeout: 30_000 });

// ------------------------------------------------------------------ Windows Credential Manager
const PS_PRELUDE = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class PsoCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CRED { public uint Flags; public uint Type; public string TargetName; public string Comment; public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWriteW(ref CRED c, uint f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string t, uint type, uint f, out IntPtr p);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDeleteW(string t, uint type, uint f);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string secret) {
    byte[] b = Encoding.UTF8.GetBytes(secret);
    if (b.Length > 2560) throw new Exception("secret too large for Credential Manager");
    IntPtr m = Marshal.AllocCoTaskMem(b.Length); Marshal.Copy(b, 0, m, b.Length);
    CRED c = new CRED(); c.Type = 1; c.TargetName = target; c.UserName = "pso"; c.CredentialBlobSize = (uint)b.Length; c.CredentialBlob = m; c.Persist = 2;
    bool ok = CredWriteW(ref c, 0); Marshal.FreeCoTaskMem(m);
    if (!ok) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
  }
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null;
    CRED c = (CRED)Marshal.PtrToStructure(p, typeof(CRED)); byte[] b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p);
    return Encoding.UTF8.GetString(b);
  }
  public static bool Delete(string target) { return CredDeleteW(target, 1, 0); }
}
"@
`;
const psEncoded = (body: string): string[] => ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PS_PRELUDE + body, "utf16le").toString("base64")];

export class WindowsCredentialManager implements CredentialProvider {
  readonly id = "windows-credential-manager";
  availability() { return process.platform === "win32" ? { ok: true } : { ok: false, reason: "not Windows" }; }
  set(ref: string, secret: string): void {
    const r = run("powershell.exe", psEncoded(`$s=[Console]::In.ReadToEnd(); [PsoCred]::Write('pso:${safeRef(ref)}', $s)`), secret);
    if (r.status !== 0) throw new CredentialStoreError("Windows Credential Manager refused the write");
  }
  get(ref: string): string | undefined {
    const r = run("powershell.exe", psEncoded(`$v=[PsoCred]::Read('pso:${safeRef(ref)}'); if ($v -eq $null) { exit 3 }; [Console]::Out.Write($v)`));
    if (r.status === 3) return undefined;
    if (r.status !== 0) throw new CredentialStoreError("Windows Credential Manager refused the read");
    return r.stdout;
  }
  remove(ref: string): boolean {
    const r = run("powershell.exe", psEncoded(`if (-not [PsoCred]::Delete('pso:${safeRef(ref)}')) { exit 3 }`));
    return r.status === 0;
  }
}

// ------------------------------------------------------------------ Linux Secret Service
export class SecretServiceProvider implements CredentialProvider {
  readonly id = "secret-service";
  availability() {
    if (process.platform !== "linux") return { ok: false, reason: "not Linux" };
    const r = run("secret-tool", ["--version"]);
    return r.error ? { ok: false, reason: "secret-tool is not installed" } : { ok: true };
  }
  set(ref: string, secret: string): void {
    const r = run("secret-tool", ["store", "--label", `PSO ${safeRef(ref)}`, "service", "pso", "ref", ref], secret);
    if (r.status !== 0) throw new CredentialStoreError("the system keyring refused the write (is a keyring unlocked and running?)");
  }
  get(ref: string): string | undefined {
    const r = run("secret-tool", ["lookup", "service", "pso", "ref", safeRef(ref)]);
    return r.status === 0 && r.stdout.length ? r.stdout : undefined;
  }
  remove(ref: string): boolean { return run("secret-tool", ["clear", "service", "pso", "ref", safeRef(ref)]).status === 0; }
}

// ------------------------------------------------------------------ macOS Keychain (unverified here)
export class MacKeychainProvider implements CredentialProvider {
  readonly id = "macos-keychain";
  availability() { return process.platform === "darwin" ? { ok: true } : { ok: false, reason: "not macOS" }; }
  set(ref: string, secret: string): void {
    const hex = Buffer.from(Buffer.from(secret, "utf8").toString("base64")).toString("hex");
    const r = run("security", ["-i"], `add-generic-password -U -a pso -s ${safeRef(ref)} -X ${hex}\n`);
    if (r.status !== 0) throw new CredentialStoreError("the macOS Keychain refused the write");
  }
  get(ref: string): string | undefined {
    const r = run("security", ["find-generic-password", "-a", "pso", "-s", safeRef(ref), "-w"]);
    return r.status === 0 ? Buffer.from(r.stdout.trim(), "base64").toString("utf8") : undefined;
  }
  remove(ref: string): boolean { return run("security", ["delete-generic-password", "-a", "pso", "-s", safeRef(ref)]).status === 0; }
}

// ------------------------------------------------------------------ encrypted file (explicitly configured)
interface EncFile { version: 1; kdf: "scrypt"; salt: string; entries: Record<string, { iv: string; tag: string; ct: string }> }
export class EncryptedFileProvider implements CredentialProvider {
  readonly id = "encrypted-file";
  private key: Buffer | undefined;
  private readonly file: string; private readonly keyMaterial: () => { passphrase?: string; keyFile?: string };
  constructor(file: string, keyMaterial: () => { passphrase?: string; keyFile?: string }) { this.file = file; this.keyMaterial = keyMaterial; }
  availability() {
    const m = this.keyMaterial();
    if (m.keyFile) {
      if (!existsSync(m.keyFile)) return { ok: false, reason: `PSO_CREDENTIAL_KEYFILE does not exist` };
      if (process.platform !== "win32" && (statSync(m.keyFile).mode & 0o077) !== 0) return { ok: false, reason: "the key file must not be readable by group or others (chmod 600)" };
      return readFileSync(m.keyFile).length >= 32 ? { ok: true } : { ok: false, reason: "the key file must contain at least 32 bytes" };
    }
    return m.passphrase && m.passphrase.length >= 12 ? { ok: true } : { ok: false, reason: "set PSO_CREDENTIAL_PASSPHRASE (12+ characters) or PSO_CREDENTIAL_KEYFILE" };
  }
  private load(): EncFile {
    if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, "utf8")) as EncFile;
    return { version: 1, kdf: "scrypt", salt: randomBytes(16).toString("base64"), entries: {} };
  }
  private derive(f: EncFile): Buffer {
    if (this.key) return this.key;
    const a = this.availability();
    if (!a.ok) throw unavailable(`encrypted-file provider: ${a.reason}`);
    const m = this.keyMaterial();
    const secret = m.keyFile ? readFileSync(m.keyFile) : Buffer.from(m.passphrase!, "utf8");
    this.key = scryptSync(secret, Buffer.from(f.salt, "base64"), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    return this.key;
  }
  private save(f: EncFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* not supported on this file system */ }
  }
  set(ref: string, secret: string): void {
    const f = this.load(); const key = this.derive(f); const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    c.setAAD(Buffer.from(safeRef(ref)));
    const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
    f.entries[ref] = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    this.save(f);
  }
  get(ref: string): string | undefined {
    const f = this.load(); const e = f.entries[safeRef(ref)]; if (!e) return undefined;
    const d = createDecipheriv("aes-256-gcm", this.derive(f), Buffer.from(e.iv, "base64"), { authTagLength: 16 });
    d.setAAD(Buffer.from(ref)); d.setAuthTag(Buffer.from(e.tag, "base64"));
    try { return Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8"); } catch { throw new CredentialStoreError("the encrypted credential file could not be decrypted: wrong passphrase or key file, or the file was modified"); }
  }
  remove(ref: string): boolean {
    const f = this.load(); if (!f.entries[safeRef(ref)]) return false; delete f.entries[ref]; this.save(f); return true;
  }
}

/** For tests and embedding only: lives in memory, never touches disk. Never selected automatically. */
export class MemoryCredentialProvider implements CredentialProvider {
  readonly id = "memory";
  private readonly m = new Map<string, string>();
  availability() { return { ok: true }; }
  set(ref: string, secret: string): void { this.m.set(safeRef(ref), secret); }
  get(ref: string): string | undefined { return this.m.get(ref); }
  remove(ref: string): boolean { return this.m.delete(ref); }
}

export interface ProviderEnv { home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }

/** Picks the provider: the explicit one (PSO_CREDENTIAL_PROVIDER), else the native one of this operating system. Throws; never degrades. */
export function resolveCredentialProvider(pe: ProviderEnv = { home: defaultHome(), env: process.env, platform: process.platform }): CredentialProvider {
  const want = pe.env["PSO_CREDENTIAL_PROVIDER"];
  const file = new EncryptedFileProvider(join(pe.home, "credentials.enc.json"), () => ({ ...(pe.env["PSO_CREDENTIAL_PASSPHRASE"] ? { passphrase: pe.env["PSO_CREDENTIAL_PASSPHRASE"] } : {}), ...(pe.env["PSO_CREDENTIAL_KEYFILE"] ? { keyFile: pe.env["PSO_CREDENTIAL_KEYFILE"] } : {}) }));
  const all: CredentialProvider[] = [new WindowsCredentialManager(), new MacKeychainProvider(), new SecretServiceProvider(), file];
  if (want) {
    const p = all.find((x) => x.id === want);
    if (!p) throw new CredentialStoreError(`unknown PSO_CREDENTIAL_PROVIDER "${want}" (one of: ${all.map((x) => x.id).join(", ")})`);
    const a = p.availability();
    if (!a.ok) throw unavailable(`${want}: ${a.reason}`);
    return p;
  }
  const native = pe.platform === "win32" ? all[0]! : pe.platform === "darwin" ? all[1]! : all[2]!;
  const a = native.availability();
  if (!a.ok) throw unavailable(`${native.id}: ${a.reason}`);
  return native;
}

/** Local state of the machine running the CLI or Studio. PSO_HOME is taken (it is the installation root of `pso setup`), so this has its own variable. */
export const defaultHome = (): string => process.env["PSO_CLOUD_HOME"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".", ".pso-cloud");

/** A new opaque reference. It carries no information about the secret or where it is used. */
export const newCredentialRef = (): string => `cred_${randomBytes(12).toString("hex")}`;

/** Reads a secret and registers it with the redactor, so that it is masked wherever it could be printed afterwards. */
export function readSecret(p: CredentialProvider, ref: string): string | undefined {
  const v = p.get(ref);
  registerSecret(v);
  return v;
}
