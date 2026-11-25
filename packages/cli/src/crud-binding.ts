import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAME_PATTERNS, detectSpringStructure, springBasePackageDir, type WorkspaceConfig } from "@pso/core";
import { CliError } from "./fsx.ts";
import { names, type ResourceSpec } from "./crud-spec.ts";

/**
 * Binding of an orchestrator CRUD module to the microservice that serves its resource. The binding is explicit and lives in the
 * module: the `<R>_SERVICE` constant of contracts/<r>.contract.ts (used by the provider) and `metadata.services` of its routes (what
 * allows the calls). It is resolved from the workspace declarations and the services' code, never assumed from a service name:
 *
 *   --crud-service <name>                   the developer says it
 *   exactly one service serves the resource  (its layered code has application/rest/<R>Controller.java) -> that one
 *   none yet                                 the module is generated bound to "<plural>" and reported; the first service created with
 *                                            the reference CRUD later rebinds it (pso create service ...), or `pso crud:bind` does
 *
 * An unbound module never stops the orchestrator: its routes answer a 502 "upstream not configured" problem and the rest runs.
 */

/** Spring services of the workspace whose layered code serves the resource. */
export function servicesServing(root: string, config: WorkspaceConfig, r: ResourceSpec): string[] {
  const R = names(r).Resource;
  return config.services.filter((s) => s.runtime === "spring-boot").filter((s) => {
    const java = join(root, ...s.path.split("/"), "src", "main", "java");
    const base = existsSync(java) ? springBasePackageDir(java) : undefined;
    return !!base && detectSpringStructure(base).structure === "layered" && existsSync(join(base, "application", "rest", `${R}Controller.java`));
  }).map((s) => s.name);
}

export function crudBindingFor(root: string, config: WorkspaceConfig, r: ResourceSpec, flag: string | undefined): { service: string; source: string } {
  if (flag !== undefined) {
    if (!NAME_PATTERNS.kebab.test(flag)) throw new CliError(`Invalid --crud-service "${flag}"`, "Name a service of the workspace (kebab-case)");
    const known = config.services.find((s) => s.name === flag);
    if (known && known.role === "orchestrator") throw new CliError("--crud-service names the microservice, not the orchestrator");
    return { service: flag, source: known ? "chosen with --crud-service" : "chosen with --crud-service; create that service with the reference CRUD next" };
  }
  const found = servicesServing(root, config, r);
  if (found.length > 1) throw new CliError(`Several services serve ${names(r).path}: ${found.join(", ")}`, "Choose one with --crud-service <name>");
  if (found.length === 1) return { service: found[0]!, source: `the service of this workspace that serves ${names(r).path}` };
  return { service: r.plural, source: `no service serves ${names(r).path} yet: the first one created with the reference CRUD is bound automatically, or run pso crud:bind ${r.plural} --to <service>` };
}

const SERVICE_CONST = /export const ([A-Z0-9_]+_SERVICE) = "([a-z][a-z0-9-]*)";/;

export interface CrudModule { module: string; resource: string; service: string; contractFile: string; routesFile: string; collectionFile: string }

/** CRUD modules of a modular orchestrator (those whose contracts/ file declares the `<R>_SERVICE` binding). */
export function crudModules(orchDir: string): CrudModule[] {
  const modules = join(orchDir, "src", "modules");
  if (!existsSync(modules)) return [];
  const out: CrudModule[] = [];
  for (const m of readdirSync(modules).sort()) {
    const contracts = join(modules, m, "contracts");
    if (!existsSync(contracts)) continue;
    for (const f of readdirSync(contracts).filter((x) => x.endsWith(".contract.ts"))) {
      const hit = SERVICE_CONST.exec(readFileSync(join(contracts, f), "utf8"));
      if (hit) out.push({ module: m, resource: f.replace(/\.contract\.ts$/, ""), service: hit[2]!, contractFile: join(contracts, f), routesFile: join(modules, m, "routes", "ROUTES.pso.ts"), collectionFile: join(orchDir, "docs", "api", `${m}.collection.json`) });
    }
  }
  return out;
}

/** Rebinds a CRUD module to another service: the contract constant and every `services: ["<old>"]` of its routes. Returns the files changed. */
export function bindModule(m: CrudModule, to: string, prefixes?: { from: string; to: string }): string[] {
  if (!NAME_PATTERNS.kebab.test(to)) throw new CliError(`Invalid service name "${to}"`);
  const changed: string[] = [];
  const c = readFileSync(m.contractFile, "utf8");
  const nc = c.replace(SERVICE_CONST, (_all, k: string) => `export const ${k} = ${JSON.stringify(to)};`);
  if (nc !== c) { writeFileSync(m.contractFile, nc); changed.push(m.contractFile); }
  if (existsSync(m.routesFile)) {
    const r = readFileSync(m.routesFile, "utf8");
    const esc = m.service.replace(/[-]/g, "\\-");
    const nr = r.replace(new RegExp(`services: \\["${esc}"\\]`, "g"), `services: [${JSON.stringify(to)}]`).replace(new RegExp(`here "${esc}"`, "g"), `here "${to}"`);
    if (nr !== r) { writeFileSync(m.routesFile, nr); changed.push(m.routesFile); }
  }
  // the reference collection's direct request names the service and its prefix
  if (existsSync(m.collectionFile)) {
    const c = readFileSync(m.collectionFile, "utf8");
    let nc = c.split(`"process:${m.service}"`).join(JSON.stringify(`process:${to}`)).split(`directly to ${m.service} `).join(`directly to ${to} `).split(`API of ${m.service} `).join(`API of ${to} `);
    if (prefixes && prefixes.from !== prefixes.to) nc = nc.split(`"path": "${prefixes.from}/`).join(`"path": "${prefixes.to}/`);
    if (nc !== c) { writeFileSync(m.collectionFile, nc); changed.push(m.collectionFile); }
  }
  return changed;
}

/** CRUD modules bound to a service the workspace does not declare (yet). */
export const unboundModules = (orchDir: string, config: WorkspaceConfig): CrudModule[] =>
  crudModules(orchDir).filter((m) => !config.services.some((s) => s.name === m.service && s.role !== "orchestrator"));
