import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  detectNodeStructure, detectSpringStructure, nodeLayout, springBasePackageDir, springLayout, findWorkspaceRoot, loadWorkspace,
  type NodeLayout, type NodeStructure, type SpringLayout, type SpringStructure, type StructureFinding,
} from "@pso/core";
import { CliError } from "./fsx.ts";

/**
 * The structure of one project of the workspace, for the CLI: what its files show, checked against what pso.workspace.json declares
 * (`structure`). Every generator and analyser asks this once, so a project is never written to with the wrong convention.
 */

/** The `structure` declared for the project at `projectDir` in its workspace, if any. */
export function declaredStructure(projectDir: string): string | undefined {
  const root = findWorkspaceRoot(projectDir);
  if (!root) return undefined;
  try {
    const ws = loadWorkspace(root).config;
    return ws?.services.find((s) => resolve(root, ...s.path.split("/")) === resolve(projectDir))?.structure;
  } catch { return undefined; }
}

export interface OrchestratorStructure { finding: StructureFinding<NodeStructure>; layout: NodeLayout; src: string }
export function orchestratorStructure(orchDir: string, declared = declaredStructure(orchDir)): OrchestratorStructure {
  const src = join(orchDir, "src");
  const finding = detectNodeStructure(src, declared);
  return { finding, layout: nodeLayout(finding.structure), src };
}

export interface SpringProjectStructure {
  finding: StructureFinding<SpringStructure>; layout: SpringLayout;
  /** the base Java package (com.example.products) and its directory */
  pkg: string; pkgDir: string;
}
export function springStructure(projectRoot: string, declared = declaredStructure(projectRoot)): SpringProjectStructure {
  const javaRoot = join(projectRoot, "src", "main", "java");
  const pkgDir = existsSync(javaRoot) ? springBasePackageDir(javaRoot) : undefined;
  if (!pkgDir) throw new CliError("Cannot find the @SpringBootApplication class", "Run this inside a Spring Boot PSO service, or pass --service <name>");
  // a Java package mirrors its directory under src/main/java
  const pkg = relative(javaRoot, pkgDir).split(sep).join(".");
  const finding = detectSpringStructure(pkgDir, declared);
  return { finding, layout: springLayout(finding.structure), pkg, pkgDir };
}

/** Throws when a project mixes conventions or contradicts its declaration: generators never write into an ambiguous project. */
export function requireConsistent(f: StructureFinding, project: string): void {
  if (f.problems.length) throw new CliError(`${project}: ${f.problems.join("; ")}`, "Nothing was written. `pso structure:inspect` shows what to move to follow one convention");
}

/** Absolute directory of an application-wide component kind of the orchestrator at `orchDir` (src/.app/guards or src/guards). */
export const orchestratorComponentDir = (orchDir: string, kind: "guards" | "middlewares" | "filters" | "interceptors" | "configs" | "contracts" | "decorators" | "hooks"): string =>
  join(orchDir, "src", ...orchestratorStructure(orchDir).layout.component(kind).split("/"));

/** Absolute directory that holds one sub-directory per HTTP module (src/modules or src/routes). */
export const orchestratorModulesDir = (orchDir: string): string => join(orchDir, "src", ...orchestratorStructure(orchDir).layout.modulesDir.split("/"));

/** The JPA settings of a layered service with a database: Flyway owns the schema, Hibernate only validates the mapping; UTC everywhere. */
export const LAYERED_JPA_YML = `  jpa:\n    open-in-view: false            # no database access while a response is rendered\n    hibernate:\n      ddl-auto: validate           # Flyway owns the schema (db/migration); Hibernate only checks the entities match it\n    properties:\n      hibernate:\n        jdbc:\n          time_zone: UTC\n`;

/** True when `dir` holds an orchestrator source tree in either structure. */
export const isOrchestratorDir = (dir: string): boolean => ["modules", "routes", ".app"].some((d) => existsSync(join(dir, "src", d)));
