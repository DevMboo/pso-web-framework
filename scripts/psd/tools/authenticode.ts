// Operating-system-backed publisher trust: is this file signed with Authenticode by a certificate whose chain Windows trusts, and is the publisher the expected one?
// Windows does the cryptography (Get-AuthenticodeSignature = WinVerifyTrust: hash of the file, chain to a trusted root, code-signing EKU, revocation as configured).
// This module only judges the result, so the judgement can be tested without a certificate.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface SignatureInfo { status: string; subject: string; thumbprint: string; timestamped: boolean }
export interface Judgement { ok: boolean; reason: string }

/** The common name of a certificate subject (`CN=Example Publisher, O=..., C=BR`), honouring quoted values. */
export function commonName(subject: string): string | undefined {
  const m = /(?:^|,\s*)CN=(?:"([^"]*)"|([^,]*))/.exec(subject);
  return m ? (m[1] ?? m[2] ?? "").trim() : undefined;
}

/**
 * Accepts only: status Valid (file unmodified AND chain trusted by this Windows), a signer common name EXACTLY equal to the expected publisher,
 * and a timestamp (so a release stays verifiable after the certificate expires). Anything else - NotSigned, HashMismatch, UnknownError (untrusted
 * root, e.g. a self-signed certificate), NotTrusted - is refused. `thumbprints`, when given, additionally pins the leaf certificate.
 */
export function judgeSignature(info: SignatureInfo | undefined, publisher: string, thumbprints: string[] = []): Judgement {
  if (!info) return { ok: false, reason: "the signature could not be read" };
  if (info.status !== "Valid") return { ok: false, reason: `Windows does not accept the signature of this installer (status ${info.status})` };
  const cn = commonName(info.subject);
  if (!publisher || cn !== publisher) return { ok: false, reason: `the installer is signed by "${cn ?? info.subject}", not by "${publisher}"` };
  if (!info.timestamped) return { ok: false, reason: "the signature carries no trusted timestamp" };
  if (thumbprints.length && !thumbprints.map((t) => t.toLowerCase()).includes(info.thumbprint.toLowerCase())) return { ok: false, reason: "the signing certificate is not one of the expected certificates" };
  return { ok: true, reason: `signed by ${cn}, trusted by Windows` };
}

export function readAuthenticode(file: string): SignatureInfo | undefined {
  if (process.platform !== "win32") return undefined;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$s=Get-AuthenticodeSignature -LiteralPath $env:PSO_SIGCHECK_FILE",
    "$c=$s.SignerCertificate",
    "[pscustomobject]@{status=[string]$s.Status;subject=$(if($c){$c.Subject}else{''});thumbprint=$(if($c){$c.Thumbprint}else{''});timestamped=($null -ne $s.TimeStamperCertificate)}|ConvertTo-Json -Compress",
  ].join(";");
  const ps = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 60_000, windowsHide: true, env: { ...process.env, PSO_SIGCHECK_FILE: file } });
  if (r.error || r.status !== 0) return undefined;
  try { const j = JSON.parse((r.stdout ?? "").trim()) as SignatureInfo; return typeof j.status === "string" ? j : undefined; } catch { return undefined; }
}

export const verifyAuthenticode = (file: string, publisher: string, thumbprints: string[] = []): Judgement => judgeSignature(readAuthenticode(file), publisher, thumbprints);
