import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceConfig } from "./workspace.ts";

/**
 * The one place that decides where the projects of a workspace live.
 *
 * Standard layout (0.2.0, mandatory for new workspaces):
 *
 *   workspace/
 *   ├── .infra/              managed operational infrastructure (written by the infra:* commands; only its ignore rule at creation)
 *   ├── orchestrators/<name> TypeScript orchestrators
 *   ├── services/<name>      Spring Boot microservices
 *   ├── frontends/<fei>      FEIs (application shells)
 *   │   └── modules/<mei>    MEIs (microfrontends)
 *   ├── shared/              workspace-level shared material (contracts, schemas)
 *   ├── docs/
 *   ├── tests/               cross-project tests
 *   ├── pso.workspace.json
 *   └── README.md
 *
 * Flat layout (0.1 and early 0.2 workspaces): services and orchestrators at the root, FEIs and MEIs under `frontend/`. It stays
 * supported as it is: a project is ALWAYS found through the `path` declared in pso.workspace.json, never by guessing, and nothing
 * is ever moved automatically. New projects of a flat workspace are generated in the flat layout so that one workspace never mixes
 * the two.
 */
export type WorkspaceLayout = "standard" | "flat";
export type ProjectKind = "orchestrator" | "service" | "fei" | "mei";

export const WORKSPACE_DIRS = {
  infra: ".infra",
  orchestrators: "orchestrators",
  services: "services",
  frontends: "frontends",
  modules: "frontends/modules",
  shared: "shared",
  docs: "docs",
  tests: "tests",
} as const;

/** The directories `pso create workspace` creates, in display order. */
export const STANDARD_WORKSPACE_DIRS: readonly string[] = [WORKSPACE_DIRS.infra, WORKSPACE_DIRS.orchestrators, WORKSPACE_DIRS.services, WORKSPACE_DIRS.frontends, WORKSPACE_DIRS.modules, WORKSPACE_DIRS.shared, WORKSPACE_DIRS.docs, WORKSPACE_DIRS.tests];

const CONTAINER: Record<ProjectKind, string> = { orchestrator: WORKSPACE_DIRS.orchestrators, service: WORKSPACE_DIRS.services, fei: WORKSPACE_DIRS.frontends, mei: WORKSPACE_DIRS.modules };
const FLAT_CONTAINER: Record<ProjectKind, string> = { orchestrator: "", service: "", fei: "frontend", mei: "frontend" };

const parentOf = (path: string): string => { const p = path.replace(/\\/g, "/").replace(/\/+$/, ""); const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };

/** Is this declared path where the standard layout puts a project of this kind? */
export function isStandardPath(kind: ProjectKind, path: string): boolean { return parentOf(path) === CONTAINER[kind]; }

/**
 * The layout of a workspace. With declared projects, their paths decide: standard when every project is in its standard place, flat
 * otherwise. Without any project yet, the directories decide: a workspace created with the standard structure has `orchestrators/` or
 * `services/`; an older (or `--layout flat`) workspace has neither and stays flat. Without a root, an empty workspace is standard.
 */
export function workspaceLayout(config: Pick<WorkspaceConfig, "services" | "frontends">, root?: string): WorkspaceLayout {
  const all: Array<[ProjectKind, string]> = [
    ...config.services.map((s): [ProjectKind, string] => [s.role === "orchestrator" ? "orchestrator" : "service", s.path]),
    ...(config.frontends ?? []).map((f): [ProjectKind, string] => [f.kind, f.path]),
  ];
  if (all.length) return all.every(([k, p]) => isStandardPath(k, p)) ? "standard" : "flat";
  if (root === undefined) return "standard";
  return existsSync(join(root, WORKSPACE_DIRS.orchestrators)) || existsSync(join(root, WORKSPACE_DIRS.services)) ? "standard" : "flat";
}

/** Where a NEW project of this kind goes (workspace-relative, forward slashes). */
export function projectPath(config: Pick<WorkspaceConfig, "services" | "frontends">, kind: ProjectKind, name: string, root?: string): string {
  const base = workspaceLayout(config, root) === "standard" ? CONTAINER[kind] : FLAT_CONTAINER[kind];
  return base ? `${base}/${name}` : name;
}

/** The workspace copy of the orchestrator contract the frontends are generated from (used to diff contract versions). */
export function frontendContractPath(config: Pick<WorkspaceConfig, "services" | "frontends">, root?: string): string {
  return workspaceLayout(config, root) === "standard" ? `${WORKSPACE_DIRS.shared}/contracts/orchestrator.contract.json` : "frontend/contracts/orchestrator.contract.json";
}

/** The projects that are not where the standard layout would put them: input of the (never automatic) layout migration plan. */
export function layoutMoves(config: Pick<WorkspaceConfig, "services" | "frontends">): Array<{ name: string; kind: ProjectKind; from: string; to: string }> {
  const out: Array<{ name: string; kind: ProjectKind; from: string; to: string }> = [];
  for (const s of config.services) { const kind: ProjectKind = s.role === "orchestrator" ? "orchestrator" : "service"; if (!isStandardPath(kind, s.path)) out.push({ name: s.name, kind, from: s.path, to: `${CONTAINER[kind]}/${s.name}` }); }
  for (const f of config.frontends ?? []) if (!isStandardPath(f.kind, f.path)) out.push({ name: f.name, kind: f.kind, from: f.path, to: `${CONTAINER[f.kind]}/${f.name}` });
  return out;
}
