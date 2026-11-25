import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceDecl } from "@pso/core";
import { CliError } from "./fsx.ts";

/**
 * The environment of one project (the orchestrator or a service) in development: which files it comes from and in what order.
 * `pso dev` starts every process with it, and the static commands (`pso security:check`, `pso security:validate`, `pso lint`,
 * `pso validate`, `pso config:*`) read the same sources, so what is validated is what runs.
 *
 * Sources, lowest to highest priority (a later one replaces an earlier one, variable by variable):
 *
 *   1. <workspace>/.env.<environment>          shared by every project of the workspace     (for example .env.development)
 *   2. <project>/.env                          this project only
 *   3. <project>/.env.<environment>            this project only, this environment only
 *   4. the environment `pso dev` itself runs in   explicit, external: it always wins over files
 *   5. what the workspace declares for the project  PORT, HOST, PSO_WORKSPACE, PSO_SERVICE (set by `pso dev`, never by a file)
 *
 * <environment> is PSO_ENV, "development" when it is not set. Rules that keep this predictable:
 *   - a project's files reach that project only: nothing written for one service is visible to another one;
 *   - <workspace>/.env is NOT read: that name belongs to Docker Compose (the variables of the containers), which are not the
 *     variables of processes running on the developer's machine;
 *   - the files are a development mechanism. A production process gets its variables from its platform; when the evaluated
 *     environment is production no file is read, so a developer's .env can never make a production check pass;
 *   - values are never printed: only file names and variable names appear in output.
 */
export interface EnvSource {
  /** path relative to the workspace root, forward slashes */
  file: string;
  scope: "workspace" | "project";
  /** names of the variables the file defines */
  keys: string[];
}

export interface ProjectEnv {
  /** the files' variables, merged in priority order (sources 1 to 3 above) */
  fromFiles: Record<string, string>;
  /** the files that exist and were read, lowest priority first */
  sources: EnvSource[];
  environment: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Reads the text of a .env file: `NAME=value`, optional `export `, `#` comments, blank lines, single quotes (literal), double quotes
 * (with \n, \r, \t, \\ and \" escapes), and an unquoted value that ends at ` #`. The same subset `node --env-file` accepts, so the
 * orchestrator's own `npm run dev` and `pso dev` agree on what a file says. A line that is not one of these is an error that names
 * the file and the line number, never the line's content.
 */
export function parseEnvFile(text: string, label = ".env"): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !NAME.test(m[1]!)) throw new CliError(`${label}: line ${i + 1} is not NAME=value`, "Use NAME=value lines; '#' starts a comment. The content of the line is not shown because it may hold a secret");
    let value = m[2]!;
    if (value.startsWith('"')) {
      const end = value.search(/(?<!\\)"(?=\s*(#.*)?$)/);
      const close = end > 0 ? end : value.lastIndexOf('"');
      if (close <= 0) throw new CliError(`${label}: line ${i + 1} has an unterminated double quote`);
      value = value.slice(1, close).replace(/\\(n|r|t|\\|")/g, (_w, c: string) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' })[c]!);
    } else if (value.startsWith("'")) {
      const close = value.indexOf("'", 1);
      if (close < 0) throw new CliError(`${label}: line ${i + 1} has an unterminated single quote`);
      value = value.slice(1, close);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

/** The environment files of a project for one environment, in priority order. Production reads none (see the file comment). */
export function projectEnv(root: string, svc: Pick<ServiceDecl, "path">, environment: string): ProjectEnv {
  const fromFiles: Record<string, string> = {};
  const sources: EnvSource[] = [];
  if (environment === "production") return { fromFiles, sources, environment };
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(environment)) throw new CliError(`Invalid environment name "${environment.slice(0, 40)}"`, "Use development, test, staging, production or a name made of letters, digits, - and _");
  const candidates: Array<[file: string, scope: EnvSource["scope"]]> = [
    [`.env.${environment}`, "workspace"],
    [`${svc.path}/.env`, "project"],
    [`${svc.path}/.env.${environment}`, "project"],
  ];
  for (const [rel, scope] of candidates) {
    const abs = join(root, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    let values: Record<string, string>;
    try { values = parseEnvFile(readFileSync(abs, "utf8"), rel); }
    catch (e) { if (e instanceof CliError) throw e; throw new CliError(`${rel} could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
    Object.assign(fromFiles, values);
    sources.push({ file: rel, scope, keys: Object.keys(values).sort() });
  }
  return { fromFiles, sources, environment };
}

/** Variables `pso dev` sets from the workspace declaration: a file cannot change them (the workspace file is their single source). */
export const DECLARED_BY_WORKSPACE = ["PORT", "HOST", "PSO_WORKSPACE", "PSO_SERVICE"] as const;

export interface EffectiveEnv {
  env: NodeJS.ProcessEnv;
  sources: EnvSource[];
  environment: string;
  /** names defined in a file AND in the external environment: the external value is the one used */
  overriddenByEnvironment: string[];
  /** names a file tried to set although the workspace declares them: ignored */
  ignoredDeclared: string[];
}

/**
 * The effective environment of a project: its files under the external environment (`base`, normally process.env). This is what
 * `pso dev` hands to the process (before adding the workspace-declared variables) and what the static commands evaluate.
 */
export function effectiveProjectEnv(root: string, svc: Pick<ServiceDecl, "path">, base: NodeJS.ProcessEnv = process.env, environment: string = base["PSO_ENV"] ?? "development"): EffectiveEnv {
  const p = projectEnv(root, svc, environment);
  const ignoredDeclared = DECLARED_BY_WORKSPACE.filter((k) => k in p.fromFiles);
  const files = Object.fromEntries(Object.entries(p.fromFiles).filter(([k]) => !(DECLARED_BY_WORKSPACE as readonly string[]).includes(k)));
  const overriddenByEnvironment = Object.keys(files).filter((k) => base[k] !== undefined && base[k] !== files[k]).sort();
  return { env: { ...files, ...base }, sources: p.sources, environment, overriddenByEnvironment, ignoredDeclared };
}

/** One line that says where a project's environment comes from. Names only, never values. */
export function describeSources(e: Pick<EffectiveEnv, "sources" | "environment">): string {
  const files = e.sources.map((s) => `${s.file} (${s.keys.length} variable${s.keys.length === 1 ? "" : "s"})`);
  if (e.environment === "production") return "the process environment only (environment files are not read for production)";
  return ["the process environment", ...files].join(", ");
}
