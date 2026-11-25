import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

/** A disposable local PKI for tests: certificate authorities and leaf certificates generated in memory, never persisted by this helper. */
x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export interface Ca { cert: x509.X509Certificate; keys: CryptoKeyPair; pem: string; cn: string }
export interface Leaf { certPem: string; keyPem: string }

const pemKey = async (k: CryptoKey): Promise<string> => {
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", k)).toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`;
};
let serial = 1;
const hours = (h: number): Date => new Date(Date.now() + h * 3600_000);

export async function newCa(cn: string): Promise<Ca> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: String(serial++).padStart(4, "0"), name: `CN=${cn}`, notBefore: hours(-2), notAfter: hours(24 * 30), signingAlgorithm: ALG, keys,
    extensions: [new x509.BasicConstraintsExtension(true, 1, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)],
  });
  return { cert, keys, pem: cert.toString("pem"), cn };
}

export interface IssueOptions { cn: string; dns?: string[]; ips?: string[]; usage: "server" | "client"; notBefore?: Date; notAfter?: Date }

export async function issue(ca: Ca, o: IssueOptions): Promise<Leaf> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const san = [...(o.dns ?? []).map((value) => ({ type: "dns" as const, value })), ...(o.ips ?? []).map((value) => ({ type: "ip" as const, value }))];
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: String(serial++).padStart(4, "0"), subject: `CN=${o.cn}`, issuer: ca.cert.subject, notBefore: o.notBefore ?? hours(-1), notAfter: o.notAfter ?? hours(24 * 7),
    signingAlgorithm: ALG, publicKey: keys.publicKey, signingKey: ca.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([o.usage === "server" ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth], true),
      ...(san.length ? [new x509.SubjectAlternativeNameExtension(san)] : []),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await pemKey(keys.privateKey) };
}
