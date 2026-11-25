import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT, type JWK } from "jose";
import * as x509 from "@peculiar/x509";

export const ISS = "https://idp.test", AUD = "pso-api";
export const tmp = (p = "pso-sec-") => mkdtempSync(join(tmpdir(), p));

export interface KeyPair { privateKey: CryptoKey; publicKey: CryptoKey; kid: string; alg: string }
export async function keypair(alg = "ES256", kid = `k-${Math.random().toString(36).slice(2, 8)}`): Promise<KeyPair> {
  const k = await generateKeyPair(alg, { extractable: true });
  return { privateKey: k.privateKey, publicKey: k.publicKey, kid, alg };
}
export const jwkOf = async (k: KeyPair): Promise<JWK> => ({ ...(await exportJWK(k.publicKey)), kid: k.kid, alg: k.alg, use: "sig" });
export const pemOf = (k: KeyPair): Promise<string> => exportSPKI(k.publicKey);

export interface Claims { iss?: string; aud?: string | string[]; sub?: string | null; exp?: string | number; nbf?: string | number; scope?: string; roles?: unknown; extra?: Record<string, unknown>; header?: Record<string, unknown> }
export async function sign(k: KeyPair, c: Claims = {}): Promise<string> {
  const jwt = new SignJWT({ scope: c.scope ?? "users:read", ...(c.roles !== undefined ? { roles: c.roles } : {}), ...(c.extra ?? {}) }).setProtectedHeader({ alg: k.alg, kid: k.kid, ...(c.header ?? {}) }).setIssuedAt().setIssuer(c.iss ?? ISS).setAudience(c.aud ?? AUD);
  if (c.sub !== null) jwt.setSubject(c.sub ?? "user-1");
  if (c.exp !== null) jwt.setExpirationTime(c.exp ?? "5m");
  if (c.nbf !== undefined) jwt.setNotBefore(c.nbf);
  return jwt.sign(k.privateKey);
}
export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A controllable identity provider JWKS endpoint. */
export interface Idp { server: Server; port: number; url: string; hits: () => number; set(o: Partial<IdpState>): void; close(): Promise<void> }
interface IdpState { keys: JWK[]; status: number; delayMs: number; redirect: string | undefined; contentType: string; body: string | undefined }
export async function idp(keys: JWK[]): Promise<Idp> {
  const st: IdpState = { keys, status: 200, delayMs: 0, redirect: undefined, contentType: "application/json", body: undefined };
  let hits = 0;
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    hits++;
    const respond = () => {
      if (st.redirect) { res.writeHead(302, { location: st.redirect }); return res.end(); }
      res.writeHead(st.status, { "content-type": st.contentType });
      res.end(st.body ?? JSON.stringify({ keys: st.keys }));
    };
    if (st.delayMs > 0) setTimeout(respond, st.delayMs); else respond();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, port, url: `http://127.0.0.1:${port}/jwks`, hits: () => hits, set: (o) => Object.assign(st, o), close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Writes a self-signed X.509 certificate for `k` valid in the given window. */
export async function certificate(k: KeyPair, notBefore: Date, notAfter: Date): Promise<string> {
  x509.cryptoProvider.set(globalThis.crypto);
  const alg = k.alg.startsWith("ES") ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const cert = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: "01", name: "CN=pso-test", notBefore, notAfter, signingAlgorithm: alg, keys: { privateKey: k.privateKey, publicKey: k.publicKey } });
  return cert.toString("pem");
}

export function writeFile(dir: string, name: string, text: string): string { const p = join(dir, name); writeFileSync(p, text); return p; }

/** Environment for a PEM-key configuration. */
export const pemEnv = (file: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_PUBLIC_KEY_FILE: file, PSO_JWT_ALGORITHMS: "ES256", ...extra });
export const jwksEnv = (uri: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PSO_JWT_ISSUER: ISS, PSO_JWT_AUDIENCE: AUD, PSO_JWT_JWKS_URI: uri, PSO_JWT_ALGORITHMS: "ES256", ...extra });
