import { X509Certificate, createHash } from "node:crypto";
import { createDevCertificate, describeCertificate, type DevCertificate } from "@pso/core";
import { readText } from "./fsutil.ts";

/** Below this many days a certificate is reported as expiring (it stays valid and is never replaced implicitly). */
export const EXPIRY_WARNING_DAYS = 30;

export interface CertCheck { ok: boolean; problems: string[]; warnings: string[]; facts: Record<string, string | number | boolean> }

export const fingerprint = (pem: string): string => createHash("sha256").update(new X509Certificate(pem).raw).digest("hex").match(/.{2}/g)!.slice(0, 16).join(":");

/** Checks an authority: present, a CA, its key (when given) belongs to it, valid now. */
export function checkAuthority(certFile: string, keyFile?: string, now = new Date()): CertCheck {
  const problems: string[] = [], warnings: string[] = [];
  const cert = readText(certFile), key = keyFile ? readText(keyFile) : undefined;
  if (!cert) return { ok: false, problems: ["the authority certificate is missing"], warnings, facts: {} };
  if (keyFile && !key) problems.push("the authority's private key is missing");
  try {
    const f = describeCertificate(cert, key, now);
    if (!f.ca) problems.push("is not a certificate authority");
    if (f.expired) problems.push(`expired on ${f.notAfter.toISOString().slice(0, 10)}`);
    else if (f.notYetValid) problems.push(`not valid before ${f.notBefore.toISOString().slice(0, 10)}`);
    else if (f.daysLeft < EXPIRY_WARNING_DAYS) warnings.push(`expires in ${f.daysLeft} day(s)`);
    if (key && f.matchesKey !== true) problems.push("the private key does not belong to the certificate");
    if (/PRIVATE KEY/.test(cert)) problems.push("the certificate file contains a private key");
    return { ok: problems.length === 0, problems, warnings, facts: { fingerprint: fingerprint(cert), notAfter: f.notAfter.toISOString(), daysLeft: f.daysLeft, subject: f.subject } };
  } catch { return { ok: false, problems: ["is not a PEM certificate"], warnings, facts: {} }; }
}

/** Checks a leaf: present with its key, issued by `caFile`, valid now, names every required DNS name, usable for the required purposes. */
export function checkLeaf(certFile: string, keyFile: string, caFile: string, names: readonly string[], opts: { client?: boolean } = {}, now = new Date()): CertCheck {
  const problems: string[] = [], warnings: string[] = [];
  const cert = readText(certFile), key = readText(keyFile), ca = readText(caFile);
  if (!cert) return { ok: false, problems: ["the certificate is missing"], warnings, facts: {} };
  if (!key) return { ok: false, problems: ["the private key is missing"], warnings, facts: {} };
  try {
    const f = describeCertificate(cert, key, now);
    const leaf = new X509Certificate(cert);
    if (f.matchesKey !== true) problems.push("the private key does not belong to the certificate");
    if (f.ca) problems.push("is a certificate authority, not a leaf certificate");
    if (f.expired) problems.push(`expired on ${f.notAfter.toISOString().slice(0, 10)}`);
    else if (f.notYetValid) problems.push(`not valid before ${f.notBefore.toISOString().slice(0, 10)}`);
    else if (f.daysLeft < EXPIRY_WARNING_DAYS) warnings.push(`expires in ${f.daysLeft} day(s): rotate it with pso infra:rotate`);
    const missing = names.filter((n) => !f.names.includes(n.toLowerCase()));
    if (missing.length) problems.push(`does not name ${missing.join(", ")} (it names ${f.names.join(", ") || "nothing"})`);
    if (ca) { try { const a = new X509Certificate(ca); if (!(leaf.checkIssued(a) && leaf.verify(a.publicKey))) problems.push("was not issued by the current authority"); } catch { problems.push("the authority certificate is not valid PEM"); } }
    else problems.push("the authority certificate is missing");
    if (opts.client && !/1\.3\.6\.1\.5\.5\.7\.3\.2|TLS Web Client Authentication|clientAuth/.test(String(leaf.keyUsage ?? []))) problems.push("is not usable as a TLS client certificate (extended key usage clientAuth)");
    return { ok: problems.length === 0, problems, warnings, facts: { fingerprint: fingerprint(cert), notAfter: f.notAfter.toISOString(), daysLeft: f.daysLeft, names: f.names.join(",") } };
  } catch { return { ok: false, problems: ["the certificate or key is not valid PEM"], warnings, facts: {} }; }
}

export function issueAuthority(commonName: string, days = 825): DevCertificate {
  return createDevCertificate({ commonName, ca: true, notAfter: new Date(Date.now() + days * 86_400_000) });
}
export function issueLeaf(issuer: DevCertificate, commonName: string, names: readonly string[], opts: { client?: boolean; days?: number } = {}): DevCertificate {
  return createDevCertificate({ commonName, names: [...new Set(names)], issuer, ...(opts.client ? { client: true } : {}), notAfter: new Date(Date.now() + (opts.days ?? 397) * 86_400_000) });
}
