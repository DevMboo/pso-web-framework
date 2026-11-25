import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { join } from "node:path";
import { InfraError } from "./contract.ts";
import { readText } from "./fsutil.ts";
import { netRequest } from "./net.ts";
import { paths } from "./render.ts";
import { lookupSecret, rememberSecret } from "./secrets.ts";
import type { Topology } from "./topology.ts";

const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** Signs a development token with the pso-dev identity's key (ES256). Development environments only. */
export function mintDevToken(root: string, t: Topology, o: { sub: string; scopes: string[]; ttlSec?: number }): string {
  if (t.identity?.provider !== "pso-dev") throw new InfraError(`environment "${t.env}" does not use the pso-dev identity provider`, "PSO_INFRA_IDENTITY_KIND", t.identity?.provider === "keycloak" ? "Sign in through the identity provider, or use a password grant for a development user (Studio API Client)" : undefined);
  if (t.kind !== "development") throw new InfraError("development tokens are only minted for development environments", "PSO_INFRA_IDENTITY_DEV");
  const pem = readText(join(root, ...`${paths.identity(t.env)}/signing-key.pem`.split("/")));
  if (!pem) throw new InfraError("the development signing key has not been provisioned", "PSO_INFRA_NOT_PROVISIONED", `Run: pso infra:apply --env ${t.env}`);
  const jwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" }) as Record<string, string>;
  const kid = createHash("sha256").update(JSON.stringify({ crv: jwk["crv"], kty: jwk["kty"], x: jwk["x"], y: jwk["y"] })).digest("base64url").slice(0, 16);
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const body = b64(JSON.stringify({ iss: t.identity.issuer, aud: t.identity.audience, sub: o.sub, scp: o.scopes, scope: o.scopes.join(" "), iat: now, nbf: now - 5, exp: now + (o.ttlSec ?? 900) }));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64(sig)}`;
}

/** How a process on this machine reaches the environment's public hosts: every public name maps to loopback in development. */
export function localResolution(t: Topology): Record<string, string> {
  return t.kind === "development" ? Object.fromEntries(t.publicHosts.map((h) => [h, "127.0.0.1"])) : {};
}
export function environmentCa(root: string, t: Topology): string | undefined {
  return t.tlsSource === "pso-dev-ca" ? readText(join(root, ...`${paths.ca(t.env)}/ca.crt`.split("/"))) : readText(`${t.decl.tls!.dir!.replace(/\/+$/, "")}/ca.crt`);
}

/**
 * A real access token from the environment's Keycloak for a development user (resource owner password grant through the development-only
 * API client). Used by the Studio API Client and the validation scenarios; the password is read from the user's secret and never shown.
 */
export async function developmentUserToken(root: string, t: Topology, username: string): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
  const idp = t.identity;
  if (idp?.provider !== "keycloak") throw new InfraError(`environment "${t.env}" has no PSO-managed Keycloak`, "PSO_INFRA_IDENTITY_KIND");
  if (t.kind !== "development") throw new InfraError("password grants are only available in development environments", "PSO_INFRA_IDENTITY_DEV");
  if (!idp.users.some((u) => u.username === username)) throw new InfraError(`"${username}" is not a declared development user (${idp.users.map((u) => u.username).join(", ") || "none"})`, "PSO_INFRA_IDENTITY_USER");
  const pw = lookupSecret(root, t.env, t.secretProvider, `user-${username}`), cs = lookupSecret(root, t.env, t.secretProvider, "idp-api-client");
  if (!pw.value || !cs.value) throw new InfraError("the development credentials have not been provisioned", "PSO_INFRA_NOT_PROVISIONED", `Run: pso infra:apply --env ${t.env}`);
  rememberSecret(pw.value); rememberSecret(cs.value);
  const body = new URLSearchParams({ grant_type: "password", client_id: "pso-api-client", client_secret: cs.value, username, password: pw.value, scope: "openid" }).toString();
  const ca = environmentCa(root, t);
  const r = await netRequest({ url: idp.tokenEndpoint, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) }, body, ...(ca ? { ca } : {}), resolve: localResolution(t), timeoutMs: 15_000 });
  if (r.status !== 200) throw new InfraError(`the identity provider refused the token request (HTTP ${r.status})`, "PSO_INFRA_TOKEN", "Is the stack running (pso docker:ps) and was the realm imported after the last change (pso docker:restart idp)?");
  const j = JSON.parse(r.body.toString("utf8")) as { access_token: string; expires_in: number; scope?: string };
  rememberSecret(j.access_token);
  return { accessToken: j.access_token, expiresIn: j.expires_in, scope: j.scope ?? "" };
}
