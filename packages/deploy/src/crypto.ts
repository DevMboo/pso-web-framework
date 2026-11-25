import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

/** Only standard primitives from node:crypto: Ed25519 signatures, SHA-256, a CSPRNG. No custom cryptography. */
export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Deterministic JSON: sorted keys, so that both sides sign and hash the same bytes. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export interface KeyPairPem { publicKey: string; privateKey: string }
export function generateIdentity(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
/** The identifier of a public key: SHA-256 of its DER encoding, shown as `SHA256:<base64>` like OpenSSH fingerprints. */
export function fingerprint(publicPem: string): string {
  const der = createPublicKey(publicPem).export({ type: "spki", format: "der" });
  return "SHA256:" + createHash("sha256").update(der).digest("base64").replace(/=+$/, "");
}
export const signText = (privatePem: string | KeyObject, text: string): string => edSign(null, Buffer.from(text), typeof privatePem === "string" ? createPrivateKey(privatePem) : privatePem).toString("base64");
export function verifyText(publicPem: string, text: string, signature: string): boolean {
  try { return edVerify(null, Buffer.from(text), createPublicKey(publicPem), Buffer.from(signature, "base64")); } catch { return false; }
}
