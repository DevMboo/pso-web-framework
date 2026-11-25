import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Runtime, RuntimeConvention } from "./conventions.ts";

/**
 * Application structure conventions.
 *
 * TypeScript orchestrator
 *   modular (official, 0.2.0+)   src/.app/{configs,contracts,decorators,filters,guards,interceptors,middlewares}  application-wide components
 *                                src/modules/<module>/{controllers,services,providers,contracts,dto,mappers,routes/ROUTES.pso.ts,MODULE.pso.ts}
 *                                src/shared/                                                                   reusable, non-business code
 *   legacy (0.1)                 src/{guards,middlewares,filters,configs,contracts,services,...}  src/routes/<module>/{MODULE,ROUTES}.pso.ts
 *
 * Java Spring Boot microservice (relative to the base package)
 *   layered (official, 0.2.0+)   application/{rest,service,dto/request,dto/response,mapper}
 *                                infrastructure/{persistence,entity,config,security,filter,client}   shared/{exception,constant,validation}
 *   legacy (0.1)                 routes/ application/ contracts/ ports/ adapters/ persistence/ events/ configs/ security/
 *
 * Java deliberately does NOT use the TypeScript conventions: there are no providers, no modules and no .app package.
 *
 * The structure of a project is what its files show. A declaration (`structure` in pso.workspace.json) may state it; files that
 * contradict the declaration, or files of both conventions in one project, are an error: conventions are never mixed silently.
 */
export type NodeStructure = "modular" | "legacy";
export type SpringStructure = "layered" | "legacy";
export type Structure = NodeStructure | SpringStructure;

/** The directory that holds the application-wide components of a modular orchestrator, relative to its source root (src/ or dist/). */
export const APP_DIR = ".app";
export const MODULES_DIR = "modules";
export const SHARED_DIR = "shared";

/** Application-wide component kinds of an orchestrator and the directory each one lives in (relative to the source root). */
export type AppComponent = "guards" | "middlewares" | "filters" | "interceptors" | "configs" | "contracts" | "decorators" | "hooks";

export interface NodeLayout {
  structure: NodeStructure;
  /** directory of an application-wide component kind, relative to the source root */
  component(kind: AppComponent): string;
  /** the directory that contains one sub-directory per HTTP module */
  modulesDir: string;
  /** ROUTES.pso of a module, relative to the module directory, without extension */
  routesFile: string;
  /** a module-local directory for a kind (controllers, services, ...), relative to the module directory; "" = the module directory itself */
  moduleDir(kind: "controllers" | "services" | "providers" | "contracts" | "dto" | "dto/request" | "dto/response" | "mappers" | "guards" | "middlewares" | "filters" | "interceptors" | "hooks"): string;
}

const MODULAR: NodeLayout = {
  structure: "modular",
  component: (kind) => `${APP_DIR}/${kind}`,
  modulesDir: MODULES_DIR,
  routesFile: "routes/ROUTES.pso",
  moduleDir: (kind) => kind,
};
const LEGACY_NODE: NodeLayout = {
  structure: "legacy",
  component: (kind) => kind,
  modulesDir: "routes",
  routesFile: "ROUTES.pso",
  // 0.1 modules kept every file next to MODULE.pso.ts; module-local guards, middlewares and filters had their own sub-directory
  moduleDir: (kind) => (["guards", "middlewares", "filters", "interceptors"].includes(kind) ? kind : ""),
};
export const nodeLayout = (s: NodeStructure): NodeLayout => (s === "modular" ? MODULAR : LEGACY_NODE);

export interface SpringLayout {
  structure: SpringStructure;
  /** package (relative to the base package, "/"-separated) of a Java kind; undefined when the structure has no place for it */
  pkg(kind: SpringKind): string | undefined;
}
export type SpringKind = "controller" | "service" | "request" | "response" | "dto" | "mapper" | "repository" | "entity" | "config" | "security" | "filter" | "exception" | "constant" | "validation" | "client" | "event" | "listener" | "port" | "adapter" | "guard";

const LAYERED_PKG: Partial<Record<SpringKind, string>> = {
  controller: "application/rest", service: "application/service", request: "application/dto/request", response: "application/dto/response", dto: "application/dto",
  mapper: "application/mapper", repository: "infrastructure/persistence", entity: "infrastructure/entity", config: "infrastructure/config",
  security: "infrastructure/security", guard: "infrastructure/security", filter: "infrastructure/filter", client: "infrastructure/client",
  exception: "shared/exception", constant: "shared/constant", validation: "shared/validation", event: "application/event", listener: "application/event",
};
const LEGACY_PKG: Partial<Record<SpringKind, string>> = {
  controller: "routes", service: "application", dto: "contracts", request: "contracts", response: "contracts", mapper: "adapters", repository: "persistence",
  port: "ports", adapter: "adapters", event: "events", listener: "events", config: "configs", guard: "security", security: "security",
};
export const springLayout = (s: SpringStructure): SpringLayout => ({ structure: s, pkg: (k) => (s === "layered" ? LAYERED_PKG : LEGACY_PKG)[k] });

export interface StructureFinding<S extends Structure = Structure> {
  structure: S;
  /** how it was decided: the files that show it, the declaration, or the default for a project with no marker yet */
  source: "files" | "declaration" | "default";
  /** files/directories that show each convention (relative to the inspected directory) */
  evidence: { current: string[]; other: string[] };
  /** non-empty when the project mixes conventions or contradicts its declaration */
  problems: string[];
}

const isDir = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const entries = (p: string): string[] => { try { return readdirSync(p); } catch { return []; } };
/** a directory that holds at least one file (at any depth), ignoring .gitkeep placeholders */
const hasFiles = (p: string, depth = 4): boolean => isDir(p) && depth > 0 && entries(p).some((e) => { const f = join(p, e); return isDir(f) ? hasFiles(f, depth - 1) : e !== ".gitkeep"; });
const MODULE_FILE = /^(MODULE|ROUTES)\.pso\.(ts|js)$/;
const hasModuleFiles = (p: string): boolean => entries(p).some((m) => { const d = join(p, m); return isDir(d) && (entries(d).some((f) => MODULE_FILE.test(f)) || entries(join(d, "routes")).some((f) => MODULE_FILE.test(f))); });

/**
 * The structure of an orchestrator source root (src/ of the project, or dist/ of its build). The modular markers are .app/ and modules/;
 * the legacy ones are module files under routes/ and application-wide component files directly under the source root.
 */
export function detectNodeStructure(sourceRoot: string, declared?: string): StructureFinding<NodeStructure> {
  const modular: string[] = [], legacy: string[] = [];
  if (hasFiles(join(sourceRoot, APP_DIR))) modular.push(`${APP_DIR}/`);
  if (hasModuleFiles(join(sourceRoot, MODULES_DIR))) modular.push(`${MODULES_DIR}/`);
  if (hasModuleFiles(join(sourceRoot, "routes"))) legacy.push("routes/");
  for (const d of ["guards", "middlewares", "filters", "interceptors", "configs", "contracts", "decorators", "services", "providers", "hooks"]) if (hasFiles(join(sourceRoot, d))) legacy.push(`${d}/`);
  return decide<NodeStructure>("modular", "legacy", modular, legacy, declared, "modular",
    "the orchestrator mixes the modular structure (src/.app, src/modules) with the 0.1 structure (src/routes, src/guards, ...)");
}

/**
 * The structure of a Spring Boot service, from its base package directory (src/main/java/<package path>). Layered markers are the
 * application/{rest,service,dto,mapper} and infrastructure/ packages; legacy ones are the 0.1 packages and classes directly in application/.
 */
export function detectSpringStructure(basePackageDir: string, declared?: string): StructureFinding<SpringStructure> {
  const layered: string[] = [], legacy: string[] = [];
  for (const d of ["application/rest", "application/service", "application/dto", "application/mapper", "infrastructure", "shared"]) if (hasFiles(join(basePackageDir, ...d.split("/")))) layered.push(`${d}/`);
  for (const d of ["routes", "contracts", "ports", "adapters", "persistence", "events", "configs", "security"]) if (hasFiles(join(basePackageDir, d))) legacy.push(`${d}/`);
  if (entries(join(basePackageDir, "application")).some((f) => f.endsWith(".java"))) legacy.push("application/*.java");
  return decide<SpringStructure>("layered", "legacy", layered, legacy, declared, "layered",
    "the service mixes the layered structure (application/rest, application/service, infrastructure/...) with the 0.1 structure (routes/, contracts/, ...)");
}

function decide<S extends Structure>(official: S, old: S, officialEvidence: string[], oldEvidence: string[], declared: string | undefined, fallback: S, mixedMessage: string): StructureFinding<S> {
  const problems: string[] = [];
  if (declared !== undefined && declared !== official && declared !== old) problems.push(`structure "${declared}" is not one of: ${official}, ${old}`);
  if (officialEvidence.length && oldEvidence.length) problems.push(`${mixedMessage}: ${[...officialEvidence, ...oldEvidence].join(", ")}. Keep one convention (pso structure:inspect shows a migration plan)`);
  const shown: S | undefined = officialEvidence.length ? official : oldEvidence.length ? old : undefined;
  if (declared && shown && declared !== shown && !problems.length) problems.push(`pso.workspace.json declares structure "${declared}" but the files follow "${shown}" (${(shown === official ? officialEvidence : oldEvidence).join(", ")})`);
  const structure = (shown ?? (declared === official || declared === old ? declared : fallback)) as S;
  return { structure, source: shown ? "files" : declared ? "declaration" : "default", evidence: { current: structure === official ? officialEvidence : oldEvidence, other: structure === official ? oldEvidence : officialEvidence }, problems };
}

/** Discovery convention of the modular orchestrator: every kind with the directories (relative to src/) that may hold it. */
export const NODE_MODULAR_CONVENTION: RuntimeConvention = {
  runtime: "node",
  sourceRoot: "src",
  nameStyle: "kebab",
  kinds: [
    { kind: "module", dir: MODULES_DIR, suffix: "MODULE.pso.ts", exact: true, paths: ["modules/*"] },
    { kind: "route-registry", dir: MODULES_DIR, suffix: "ROUTES.pso.ts", exact: true, paths: ["modules/*/routes"] },
    { kind: "controller", dir: MODULES_DIR, suffix: ".controller.ts", paths: ["modules/*/controllers"] },
    { kind: "service", dir: MODULES_DIR, suffix: ".service.ts", paths: ["modules/*/services", "shared", "shared/**"] },
    { kind: "provider", dir: MODULES_DIR, suffix: ".provider.ts", paths: ["modules/*/providers"] },
    { kind: "dto", dir: MODULES_DIR, suffix: ".dto.ts", paths: ["modules/*/dto", "modules/*/dto/request", "modules/*/dto/response", "shared", "shared/**"] },
    { kind: "mapper", dir: MODULES_DIR, suffix: ".mapper.ts", paths: ["modules/*/mappers"] },
    { kind: "type-contract", dir: MODULES_DIR, suffix: ".contract.ts", paths: ["modules/*/contracts", ".app/contracts"] },
    { kind: "contract", dir: ".app/contracts", suffix: ".contract.json", paths: [".app/contracts"] },
    { kind: "guard", dir: ".app/guards", suffix: ".guard.ts", paths: [".app/guards", "modules/*/guards"] },
    { kind: "middleware", dir: ".app/middlewares", suffix: ".middleware.ts", paths: [".app/middlewares", "modules/*/middlewares"] },
    { kind: "filter", dir: ".app/filters", suffix: ".filter.ts", paths: [".app/filters", "modules/*/filters"] },
    { kind: "interceptor", dir: ".app/interceptors", suffix: ".interceptor.ts", paths: [".app/interceptors", "modules/*/interceptors"] },
    { kind: "decorator", dir: ".app/decorators", suffix: ".decorator.ts", paths: [".app/decorators"] },
    { kind: "config", dir: ".app/configs", suffix: ".config.ts", paths: [".app/configs"] },
    { kind: "hook", dir: MODULES_DIR, suffix: ".hook.ts", paths: ["modules/*/hooks", ".app/hooks"] },
    { kind: "dispatch", dir: "dispatch", suffix: ".dispatch.ts", paths: ["dispatch", "dispatch/**"] },
  ],
};

/** Discovery convention of the layered Spring service: every kind with the packages (relative to the base package) that may hold it. */
export const SPRING_LAYERED_CONVENTION: RuntimeConvention = {
  runtime: "spring-boot",
  sourceRoot: "src/main/java",
  nameStyle: "pascal",
  kinds: [
    { kind: "controller", dir: "application/rest", suffix: "Controller.java", paths: ["application/rest"] },
    { kind: "service", dir: "application/service", suffix: "Service.java", paths: ["application/service"] },
    { kind: "request", dir: "application/dto/request", suffix: "Request.java", paths: ["application/dto/request"] },
    { kind: "response", dir: "application/dto/response", suffix: "Response.java", paths: ["application/dto/response"] },
    { kind: "mapper", dir: "application/mapper", suffix: "Mapper.java", paths: ["application/mapper"] },
    { kind: "repository", dir: "infrastructure/persistence", suffix: "Repository.java", paths: ["infrastructure/persistence"] },
    { kind: "entity", dir: "infrastructure/entity", suffix: "Entity.java", paths: ["infrastructure/entity"] },
    { kind: "config", dir: "infrastructure/config", suffix: "Config.java", paths: ["infrastructure/config", "infrastructure/security"] },
    { kind: "filter", dir: "infrastructure/filter", suffix: "Filter.java", paths: ["infrastructure/filter"] },
    { kind: "client", dir: "infrastructure/client", suffix: "Client.java", paths: ["infrastructure/client"] },
    { kind: "exception", dir: "shared/exception", suffix: "Exception.java", paths: ["shared/exception"] },
    { kind: "event", dir: "application/event", suffix: "Event.java", paths: ["application/event"] },
    { kind: "listener", dir: "application/event", suffix: "Listener.java", paths: ["application/event"] },
  ],
};

/** The discovery convention for a runtime and structure (the legacy ones are CONVENTIONS in conventions.ts). */
export function conventionOf(runtime: Runtime, structure: Structure, legacy: Record<Runtime, RuntimeConvention>): RuntimeConvention {
  if (runtime === "node") return structure === "modular" ? NODE_MODULAR_CONVENTION : legacy.node;
  return structure === "layered" ? SPRING_LAYERED_CONVENTION : legacy["spring-boot"];
}

/** True when `dir` (segments relative to the source root, or to the base package for Java) matches one of the patterns ("*" one segment, "**" any). */
export function matchesPath(dir: readonly string[], patterns: readonly string[]): boolean {
  const match = (d: readonly string[], p: readonly string[]): boolean => {
    if (!p.length) return !d.length;
    if (p[0] === "**") return match(d, p.slice(1)) || (d.length > 0 && match(d.slice(1), p));
    return d.length > 0 && (p[0] === "*" || p[0] === d[0]) && match(d.slice(1), p.slice(1));
  };
  return patterns.some((pat) => match(dir, pat.split("/")));
}

