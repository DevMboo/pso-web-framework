import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadContract, pickEnvironment, secretProviderOf, INFRA_FILE } from "./contract.ts";
import { readText } from "./fsutil.ts";
import { paths } from "./render.ts";
import { SECRET_REF, lookupSecret, rememberSecret } from "./secrets.ts";

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
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    const ref = SECRET_REF.exec(v);
    if (ref) {
      const s = lookupSecret(root, picked.name, secretProviderOf(picked.env), ref[1]!, picked.env.secrets?.dir);
      if (!s.value) { missing.push(ref[1]!); continue; }
      rememberSecret(s.value); secrets.push(k); v = s.value;
    } else if (v.startsWith(".infra/")) v = join(root, ...v.split("/"));
    vars[k] = v;
  }
  return { env: picked.name, vars, secrets, missing, file: rel };
}
