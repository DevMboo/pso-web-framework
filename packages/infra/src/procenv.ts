import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadContract, pickEnvironment, secretProviderOf, INFRA_FILE } from "./contract.ts";
import { readText } from "./fsutil.ts";
import { paths } from "./render.ts";
import { SECRET_REF, lookupSecret, rememberSecret } from "./secrets.ts";

/** `${secret://name}` inside a value (for example the password inside a Redis address): resolved like a whole-value reference. */
const EMBEDDED_REF = /\$\{secret:\/\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}/g;

/**
 * The environment the infrastructure engine prepared for a service running as a local process (`pso dev`): read from
 * `.infra/env/<env>/<service>.env`, with `secret://` references resolved through the environment's provider at the moment the process
 * starts (the values exist only in that process's environment) and `.infra/...` paths made absolute. Undefined when the workspace has no
 * pso.infra.json or the file was not generated.
 */
export function processEnvironment(root: string, service: string, envName?: string): { env: string; vars: Record<string, string>; secrets: string[]; missing: string[]; file: string } | undefined {
  if (!existsSync(join(root, INFRA_FILE))) return undefined;
  const { contract, issues } = loadContract(root);
  if (issues.some((i) => i.severity === "error")) return undefined;
  let picked;
  try { picked = pickEnvironment(contract, envName); } catch { return undefined; }
  const rel = paths.env(picked.name, service);
  const text = readText(join(root, ...rel.split("/")));
  if (text === undefined) return undefined;
  const vars: Record<string, string> = {}, secrets: string[] = [], missing: string[] = [];
  const resolve = (name: string): string | undefined => {
    const s = lookupSecret(root, picked.name, secretProviderOf(picked.env), name, picked.env.secrets?.dir);
    if (!s.value) { if (!missing.includes(name)) missing.push(name); return undefined; }
    rememberSecret(s.value);
    return s.value;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    const ref = SECRET_REF.exec(v);
    if (ref) {
      const value = resolve(ref[1]!);
      if (value === undefined) continue;
      secrets.push(k); v = value;
    } else if (v.includes("${secret://")) {
      let incomplete = false;
      v = v.replace(EMBEDDED_REF, (_m, name: string) => { const value = resolve(name); if (value === undefined) { incomplete = true; return ""; } return value; });
      if (incomplete) continue;
      rememberSecret(v); secrets.push(k);
    } else if (v.startsWith(".infra/")) v = join(root, ...v.split("/"));
    vars[k] = v;
  }
  return { env: picked.name, vars, secrets, missing, file: rel };
}

/**
 * Variables that select where a service gets the keys that verify access tokens. Exactly one is allowed (PSO_SEC_KEY_CONFLICT otherwise),
 * so a service whose own configuration names one is configuring its authentication itself.
 */
export const KEY_SOURCE_VARIABLES = ["PSO_JWT_JWKS_URI", "PSO_JWT_PUBLIC_KEY_FILE"] as const;
/** The identity settings the infrastructure prepares as one coherent group (issuer, audience, key source, trust of the key host). */
export const IDENTITY_GROUP = /^PSO_(JWT|SECURITY_JWT)_[A-Z0-9_]+$/;

export interface MergedProcessEnvironment {
  /** variables taken from the infrastructure environment (names only) */
  added: string[];
  /** infrastructure variables NOT applied, with the reason (names only) */
  skipped: Array<{ names: string[]; reason: string }>;
}

/**
 * Adds the infrastructure environment of a service under what the process already has (its files and the environment of `pso dev`),
 * which always wins. The identity settings are one group, never mixed with the application's: when the application already selects a key
 * source (PSO_JWT_JWKS_URI or PSO_JWT_PUBLIC_KEY_FILE), none of the infrastructure's identity settings are added, so the infrastructure
 * can never introduce a second key source next to the application's. A conflict the application creates itself is still reported by the
 * security runtime (PSO_SEC_KEY_CONFLICT): nothing is hidden, the improper source is simply not there.
 */
export function mergeProcessEnvironment(target: Record<string, string | undefined>, infra: Record<string, string>): MergedProcessEnvironment {
  const added: string[] = [], skipped: MergedProcessEnvironment["skipped"] = [];
  const own = KEY_SOURCE_VARIABLES.filter((k) => target[k] !== undefined && target[k] !== "");
  const identity = Object.keys(infra).filter((k) => IDENTITY_GROUP.test(k)).sort();
  if (own.length && identity.length) skipped.push({ names: identity, reason: `the application selects its own key source (${own.join(", ")}): the identity settings of the infrastructure are not applied` });
  for (const [k, v] of Object.entries(infra)) {
    if (own.length && IDENTITY_GROUP.test(k)) continue;
    if (target[k] !== undefined) continue;
    target[k] = v; added.push(k);
  }
  return { added: added.sort(), skipped };
}
