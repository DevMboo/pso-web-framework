import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

/**
 * X.509 certificates for DEVELOPMENT and TESTS: a certificate authority and the server (or client) certificates it signs, ECDSA P-256
 * with SHA-256, written with node:crypto only. This exists so that a local stack can run with real TLS and real verification instead
 * of plain HTTP or disabled checks. It is not a PKI: there is no revocation, no key protection and no audit trail. Production
 * certificates come from the organisation's own certificate authority.
 */
export interface DevCertificate { certPem: string; keyPem: string }
export interface DevCertificateOptions {
  commonName: string;
  /** DNS names and IP addresses of the subject alternative name (what a client verifies the host name against) */
  names?: readonly string[];
  /** a certificate authority (signs other certificates) instead of an end-entity certificate */
  ca?: boolean;
  /** the authority that signs this certificate; without it the certificate is self-signed */
  issuer?: DevCertificate;
  notBefore?: Date;
  notAfter?: Date;
  /** also usable as a TLS client certificate (mutual TLS) */
  client?: boolean;
}

const len = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, ...content: Buffer[]): Buffer => { const body = Buffer.concat(content); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...c: Buffer[]): Buffer => tlv(0x30, ...c);
const oid = (dotted: string): Buffer => {
  const p = dotted.split(".").map(Number);
  const bytes = [p[0]! * 40 + p[1]!];
  for (const v of p.slice(2)) { const stack = [v & 0x7f]; for (let x = v >> 7; x > 0; x >>= 7) stack.unshift((x & 0x7f) | 0x80); bytes.push(...stack); }
  return tlv(0x06, Buffer.from(bytes));
};
const time = (d: Date): Buffer => {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
};
const name = (cn: string): Buffer => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));
const ext = (id: string, critical: boolean, value: Buffer): Buffer => seq(oid(id), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), tlv(0x04, value));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const pem = (label: string, der: Buffer): string => `-----BEGIN ${label}-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd()}\n-----END ${label}-----\n`;

function altName(n: string): Buffer {
  const kind = isIP(n);
  if (kind === 4) return tlv(0x87, Buffer.from(n.split(".").map(Number)));
  if (kind === 6) throw new Error(`IPv6 subject alternative names are not supported here: ${n}`);
  if (!/^[A-Za-z0-9*]([A-Za-z0-9.*-]*[A-Za-z0-9])?$/.test(n)) throw new Error(`not a DNS name: ${n}`);
  return tlv(0x82, Buffer.from(n.toLowerCase(), "ascii"));
}

/** Creates a key pair and its certificate. The subject and issuer names are the common names only. */
export function createDevCertificate(o: DevCertificateOptions): DevCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signer: KeyObject = o.issuer ? createPrivateKey(o.issuer.keyPem) : privateKey;
  if (/[\n\r\\]/.test(o.commonName)) throw new Error("a common name cannot contain line breaks or backslashes");
  // the issuer field must be the authority's subject exactly: node prints special characters escaped, so they are unescaped here
  const issuerName = o.issuer ? new X509Certificate(o.issuer.certPem).subject.replace(/^CN=/, "").replace(/\\(.)/g, "$1") : o.commonName;
  const notBefore = o.notBefore ?? new Date(Date.now() - 5 * 60_000);
  const notAfter = o.notAfter ?? new Date(notBefore.getTime() + 365 * 86_400_000);
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 0x01; // positive, non-zero
  const extensions = [
    ext("2.5.29.19", true, o.ca ? seq(Buffer.from([0x01, 0x01, 0xff])) : seq()), // basicConstraints
    ext("2.5.29.15", true, o.ca ? Buffer.from([0x03, 0x02, 0x01, 0x06]) : Buffer.from([0x03, 0x02, 0x07, 0x80])), // keyUsage: keyCertSign+cRLSign | digitalSignature
    ...(o.ca ? [] : [ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"), ...(o.client ? [oid("1.3.6.1.5.5.7.3.2")] : [])))]), // serverAuth (+ clientAuth)
    ...(o.names?.length ? [ext("2.5.29.17", false, seq(...o.names.map(altName)))] : []),
  ];
  const tbs = seq(
    tlv(0xa0, Buffer.from([0x02, 0x01, 0x02])), // v3
    tlv(0x02, serial),
    ECDSA_SHA256,
    name(issuerName),
    seq(time(notBefore), time(notAfter)),
    name(o.commonName),
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = sign("sha256", tbs, { key: signer, dsaEncoding: "der" });
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0x00]), signature));
  return { certPem: pem("CERTIFICATE", der), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

export interface CertificateFacts { subject: string; issuer: string; names: string[]; notBefore: Date; notAfter: Date; ca: boolean; expired: boolean; notYetValid: boolean; daysLeft: number; matchesKey?: boolean }
/** What a certificate says, for diagnostics: never includes key material. `keyPem` checks that the private key belongs to it. */
export function describeCertificate(certPem: string, keyPem?: string, now = new Date()): CertificateFacts {
  const c = new X509Certificate(certPem);
  const notBefore = new Date(c.validFrom), notAfter = new Date(c.validTo);
  let matchesKey: boolean | undefined;
  if (keyPem !== undefined) { try { matchesKey = c.publicKey.equals(createPublicKey(createPrivateKey(keyPem))); } catch { matchesKey = false; } }
  return {
    subject: c.subject.replace(/\n/g, ", "), issuer: c.issuer.replace(/\n/g, ", "),
    names: (c.subjectAltName ?? "").split(",").map((s) => s.trim().replace(/^(DNS|IP Address):/, "")).filter(Boolean),
    notBefore, notAfter, ca: c.ca, expired: now > notAfter, notYetValid: now < notBefore,
    daysLeft: Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000),
    ...(matchesKey !== undefined ? { matchesKey } : {}),
  };
}
