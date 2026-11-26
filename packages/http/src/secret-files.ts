import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Secrets of a container as variables of a Node service. The generated container topology mounts each secret as a file under /run/secrets
 * (never as a value in the compose file or the image) and names the ones this service reads as variables in PSO_SECRET_FILES:
 *
 *   PSO_SECRET_FILES=REDIS_URL,PSO_CHANNELS_BUS_SECRET      the file /run/secrets/<NAME> becomes the variable <NAME>
 *   PSO_SECRETS_DIR=/run/secrets                             (default) where the files are
 *
 * It runs first at start-up, before any configuration is read, so Dispatch, Channels and security see the values as ordinary variables. A
 * variable that is already set is kept (the platform's own value wins). A listed file that is missing or empty stops the start-up: the
 * service never runs half-configured. Values are never logged; only the names are returned.
 */
export function loadSecretFiles(env: NodeJS.ProcessEnv): { loaded: string[]; kept: string[] } {
  const list = env["PSO_SECRET_FILES"]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const dir = env["PSO_SECRETS_DIR"]?.trim() || "/run/secrets";
  const loaded: string[] = [], kept: string[] = [], problems: string[] = [];
  for (const name of list) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) { problems.push(`"${name.slice(0, 40)}" is not a variable name`); continue; }
    if (env[name] !== undefined && env[name] !== "") { kept.push(name); continue; }
    let value: string;
    try { value = readFileSync(join(dir, name), "utf8").replace(/\r?\n$/, ""); }
    catch (e) { problems.push(`${name}: ${join(dir, name)} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`); continue; }
    if (value === "") { problems.push(`${name}: ${join(dir, name)} is empty`); continue; }
    env[name] = value; loaded.push(name);
  }
  if (problems.length) throw new SecretFilesError(problems);
  return { loaded, kept };
}

export class SecretFilesError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`secret files named in PSO_SECRET_FILES are not usable: ${problems.join("; ")}`); this.problems = problems; }
}
