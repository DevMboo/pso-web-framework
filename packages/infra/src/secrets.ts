import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INFRA_DIR, type SecretProvider } from "./contract.ts";
import { readText } from "./fsutil.ts";

/**
 * Secrets are referenced, never copied into configuration: `secret://<name>`. Each environment resolves a reference through ONE provider:
 *   local  `.infra/secrets/<env>/<name>`, a file readable by its owner only (development: PSO may generate it)
 *   env    the variable PSO_SECRET_<NAME> injected by the platform that runs the stack (CI, a container platform, systemd)
 *   file   `<secrets.dir>/<name>`, a mounted secret file (Docker/Kubernetes secrets, a vault agent)
 * Generated configuration (compose, nginx, realm) contains only references and mount points. The value is read at the last moment by
 * the process that needs it, and every value PSO has seen is masked in its own output and logs.
 */
export const SECRET_REF = /^secret:\/\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
export const secretRef = (name: string): string => `secret://${name}`;
export const envVarOf = (name: string): string => `PSO_SECRET_${name.toUpperCase().replace(/-/g, "_")}`;
export const localSecretPath = (env: string, name: string): string => `${INFRA_DIR}/secrets/${env}/${name}`;

export function generateSecretValue(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }

export interface SecretLookup { value?: string; source: string; present: boolean }
export function lookupSecret(root: string, env: string, provider: SecretProvider, name: string, fileDir?: string): SecretLookup {
  if (provider === "local") {
    const rel = localSecretPath(env, name);
    const v = readText(join(root, ...rel.split("/")))?.trim();
    return v ? { value: v, source: rel, present: true } : { source: rel, present: false };
  }
  if (provider === "env") {
    const k = envVarOf(name);
    const v = process.env[k];
    return v ? { value: v, source: `$${k}`, present: true } : { source: `$${k}`, present: false };
  }
  const f = join(fileDir ?? "/run/secrets", name);
  const v = existsSync(f) ? readText(f)?.trim() : undefined;
  return v ? { value: v, source: f, present: true } : { source: f, present: false };
}

/** Values PSO has read or generated in this process: masked in everything it prints or logs. */
const known = new Set<string>();
export const rememberSecret = (v: string): void => { if (v.length >= 8) known.add(v); };

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]"],
  [/((?:password|passwd|secret|token|client_secret|authorization)["']?\s*[:=]\s*["']?)(?!secret:\/\/)(?!null\b)[^\s"',;&}]{4,}/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]"],
];
/** Masks only the values PSO knows are secret (environment secrets, issued and typed tokens): safe for structured content such as a JSON response. */
export function redactKnown(text: string): string { let t = text; for (const v of known) t = t.split(v).join("[REDACTED]"); return t; }

/** Removes key material, tokens, credentials and every known secret value from a text that is about to be shown or stored. */
export function redact(text: string): string {
  let t = text;
  for (const v of known) t = t.split(v).join("[REDACTED]");
  for (const [re, rep] of PATTERNS) t = t.replace(re, rep);
  return t;
}
