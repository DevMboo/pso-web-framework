import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { canonical, fingerprint, generateIdentity, signText, verifyText } from "./crypto.ts";

/**
 * Release signing and authenticity.
 *
 * INTEGRITY answers "are these the bytes that were named?" (a digest, a commit id). AUTHENTICITY answers "did a signer this environment
 * trusts produce that name?" (a signature checked against the environment's trust store). A checksum alone is integrity only: anyone who can
 * alter the artifact can alter its checksum. PSO therefore reports the two separately and never lets one stand in for the other.
 *
 * Only standard primitives: Ed25519 signatures and SHA-256 from node:crypto (the same ones the management protocol uses). The signed text
 * carries a domain-separation prefix so a release signature can never be replayed as a request signature or the other way round.
 * Private signing keys are created on the signer's machine, stored in its credential store, and never travel: not in generated projects,
 * packages, manifests or the agent. The server only ever holds PUBLIC keys.
 *
 * Residual: a git commit id is a SHA-1 digest unless the repository uses the SHA-256 object format. The signature binds the commit id, so
 * it is as strong as git's object model; use artifact sources (SHA-256) where that matters.
 */
export const MANIFEST_DOMAIN = "pso-release-manifest-v1\n";

export interface ReleaseManifest {
  v: 1;
  app: string;
  source: { kind: "git"; commit: string; gitTree?: string; url?: string } | { kind: "artifact"; sha256: string };
  /** SHA-256 over the extracted file tree (see `treeDigest`); optional, checked by the server after it unpacks the release */
  treeHash?: string;
  /** strictly increasing per application: a manifest with a sequence not greater than the last deployed one is a replay or a downgrade */
  sequence: number;
  createdAt: string;
  /** free text for humans (provenance: who built it, from which pipeline run); never interpreted */
  provenance?: { builder?: string; pipelineRun?: string; note?: string };
}
export interface SignedManifest { manifest: string; signatures: Array<{ keyId: string; sig: string }> }

export interface TrustedSigner {
  keyId: string; name: string; publicKey: string; addedAt: string; addedBy: string;
  /** an application list narrows what this signer may sign for; absent = every application of this environment */
  apps?: string[];
  notAfter?: string; revokedAt?: string; revokedReason?: string;
}

/** Hash of the file tree, independent of the platform (paths use "/", `.git` is ignored). */
export function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".git") continue; const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) { h.update(relative(dir, p).split(sep).join("/")); h.update("\0"); h.update(readFileSync(p)); h.update("\0"); }
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest("hex");
}

export const generateSigner = (): { publicKey: string; privateKey: string; keyId: string } => { const k = generateIdentity(); return { ...k, keyId: fingerprint(k.publicKey) }; };

export function signManifest(manifest: ReleaseManifest, privateKeyPem: string, publicKeyPem: string, existing?: SignedManifest): SignedManifest {
  const text = canonical(manifest);
  if (existing && existing.manifest !== text) throw new Error("the manifest differs from the one already signed: sign the same manifest, or start a new one");
  const keyId = fingerprint(publicKeyPem);
  const sig = signText(privateKeyPem, MANIFEST_DOMAIN + text);
  return { manifest: text, signatures: [...(existing?.signatures ?? []).filter((s) => s.keyId !== keyId), { keyId, sig }] };
}

export type Integrity = "verified" | "failed" | "not-checked";
export type Authenticity = "verified" | "unsigned" | "invalid-signature" | "untrusted-signer" | "revoked-signer" | "expired-signer" | "signer-not-allowed-for-app" | "manifest-mismatch";
export interface Provenance {
  integrity: Integrity; authenticity: Authenticity;
  signer?: { keyId: string; name: string }; sequence?: number; manifestHash?: string; signedAt?: string;
  reasons: string[];
}
const unsigned = (): Provenance => ({ integrity: "not-checked", authenticity: "unsigned", reasons: ["the release carries no signature"] });

/**
 * Verifies a signed manifest against the environment's trust store and against the release it claims to describe.
 * `expect` is what the SERVER resolved itself (the commit it will fetch, or the artifact's checksum): the manifest must name exactly that.
 * A manifest that verifies but names a different release is `manifest-mismatch`, never a pass.
 */
export function verifySigned(signed: SignedManifest | undefined, trust: TrustedSigner[], expect: { app: string; source: { kind: "git"; commit: string } | { kind: "artifact"; sha256: string } }, now = Date.now()): Provenance {
  if (!signed || typeof signed.manifest !== "string" || !Array.isArray(signed.signatures) || !signed.signatures.length) return unsigned();
  let m: ReleaseManifest;
  try { m = JSON.parse(signed.manifest) as ReleaseManifest; } catch { return { integrity: "failed", authenticity: "invalid-signature", reasons: ["the manifest is not valid JSON"] }; }
  if (canonical(m) !== signed.manifest) return { integrity: "failed", authenticity: "invalid-signature", reasons: ["the manifest is not in canonical form (what was signed is not what is presented)"] };
  const manifestHash = createHash("sha256").update(signed.manifest).digest("hex");
  const base = { manifestHash, ...(typeof m.sequence === "number" ? { sequence: m.sequence } : {}), signedAt: m.createdAt };
  const reasons: string[] = [];
  const matches = m.v === 1 && m.app === expect.app && m.source?.kind === expect.source.kind
    && (expect.source.kind === "git" ? (m.source as { commit: string }).commit === expect.source.commit : (m.source as { sha256: string }).sha256 === expect.source.sha256)
    && Number.isInteger(m.sequence) && m.sequence >= 1;
  if (!matches) reasons.push(`the signed manifest describes a different release (app ${m.app}, ${m.source?.kind ?? "?"} ${m.source && "commit" in m.source ? m.source.commit.slice(0, 12) : m.source && "sha256" in m.source ? m.source.sha256.slice(0, 12) : "?"}) than the one this server resolved`);
  let worst: Authenticity = "untrusted-signer"; let cryptoValid = false;
  for (const s of signed.signatures) {
    const t = trust.find((x) => x.keyId === s.keyId);
    if (!t) { reasons.push(`signature by ${s.keyId.slice(0, 20)}…: that key is not trusted by this environment`); continue; }
    if (!verifyText(t.publicKey, MANIFEST_DOMAIN + signed.manifest, s.sig)) { worst = "invalid-signature"; reasons.push(`signature by ${t.name}: invalid (the manifest or the signature was altered)`); continue; }
    cryptoValid = true; // the signature is genuine for a key this server knows: whether that key may be relied on is decided below
    if (t.revokedAt) { worst = worst === "invalid-signature" ? worst : "revoked-signer"; reasons.push(`signer ${t.name} was revoked at ${t.revokedAt}${t.revokedReason ? ` (${t.revokedReason})` : ""}`); continue; }
    if (t.notAfter && Date.parse(t.notAfter) < now) { worst = worst === "invalid-signature" ? worst : "expired-signer"; reasons.push(`signer ${t.name} expired at ${t.notAfter}`); continue; }
    if (t.apps && !t.apps.includes(expect.app)) { worst = worst === "invalid-signature" ? worst : "signer-not-allowed-for-app"; reasons.push(`signer ${t.name} may not sign for ${expect.app}`); continue; }
    if (!matches) return { ...base, integrity: "failed", authenticity: "manifest-mismatch", signer: { keyId: t.keyId, name: t.name }, reasons };
    return { ...base, integrity: "verified", authenticity: "verified", signer: { keyId: t.keyId, name: t.name }, reasons: [`signed by ${t.name} (${t.keyId.slice(0, 20)}…)`] };
  }
  // integrity: a genuine signature over exactly the release the server resolved. A forged or altered manifest proves nothing; an unknown key cannot be checked at all.
  const integrity: Integrity = !matches ? "failed" : cryptoValid ? "verified" : worst === "invalid-signature" ? "failed" : "not-checked";
  return { ...base, integrity, authenticity: matches ? worst : "manifest-mismatch", reasons };
}

export const describeProvenance = (p: Provenance): string => p.authenticity === "verified" ? `authentic: signed by ${p.signer?.name}; integrity verified` : `NOT authentic (${p.authenticity}); integrity ${p.integrity}${p.reasons.length ? `: ${p.reasons[0]}` : ""}`;
