export type Runtime = "node" | "spring-boot";
export type NameStyle = "kebab" | "pascal";

export interface KindSpec {
  kind: string;
  /** directory that owns this kind (for Java: the last package segment) */
  dir: string;
  /** file suffix including extension, e.g. ".controller.ts" or "Controller.java" */
  suffix: string;
  /** the suffix is the complete file name (MODULE.pso.ts) */
  exact?: boolean;
  /** other top-level directories that may also own this kind (module-local files live under routes/<module>/) */
  alsoIn?: string[];
  /**
   * Structure-aware placement (modular orchestrator, layered Spring service): the directories that may hold this kind, relative to the
   * source root ("*" = one segment, "**" = any). For Java they are matched against the END of the package path (the base package is free).
   */
  paths?: string[];
}

export const NAME_PATTERNS: Record<NameStyle, RegExp> = {
  kebab: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
  pascal: /^[A-Z][A-Za-z0-9]*$/,
};

export interface RuntimeConvention {
  runtime: Runtime;
  /** where discovery starts, relative to the project root */
  sourceRoot: string;
  nameStyle: NameStyle;
  kinds: KindSpec[];
}

/**
 * Node.js orchestrator. HTTP modules live in src/routes/<module>/ and need all three of:
 *   MODULE.pso.ts (composition), ROUTES.pso.ts (the authoritative endpoint registry), <name>.controller.ts (implementation).
 * A controller decorator alone never exposes an endpoint.
 */
export const NODE_CONVENTION: RuntimeConvention = {
  runtime: "node",
  sourceRoot: "src",
  nameStyle: "kebab",
  kinds: [
    { kind: "module", dir: "routes", suffix: "MODULE.pso.ts", exact: true },
    { kind: "route-registry", dir: "routes", suffix: "ROUTES.pso.ts", exact: true },
    { kind: "controller", dir: "routes", suffix: ".controller.ts" },
    { kind: "dto", dir: "routes", suffix: ".dto.ts" },
    { kind: "middleware", dir: "middlewares", suffix: ".middleware.ts", alsoIn: ["routes"] },
    { kind: "filter", dir: "filters", suffix: ".filter.ts", alsoIn: ["routes"] },
    { kind: "guard", dir: "guards", suffix: ".guard.ts", alsoIn: ["routes"] },
    { kind: "service", dir: "services", suffix: ".service.ts", alsoIn: ["routes"] },
    { kind: "dispatch", dir: "dispatch", suffix: ".dispatch.ts" },
    { kind: "config", dir: "configs", suffix: ".config.ts" },
    { kind: "provider", dir: "providers", suffix: ".provider.ts" },
    { kind: "hook", dir: "hooks", suffix: ".hook.ts" },
    { kind: "contract", dir: "contracts", suffix: ".contract.json" },
  ],
};

/**
 * Spring Boot microservice: simplified hexagonal layout directly under the application package.
 * Files are PascalCase Java classes whose suffix names the kind (CustomerController.java).
 */
export const SPRING_CONVENTION: RuntimeConvention = {
  runtime: "spring-boot",
  sourceRoot: "src/main/java",
  nameStyle: "pascal",
  kinds: [
    { kind: "controller", dir: "routes", suffix: "Controller.java" },
    { kind: "service", dir: "application", suffix: "Service.java" },
    { kind: "port", dir: "ports", suffix: "Port.java" },
    { kind: "adapter", dir: "adapters", suffix: "Adapter.java" },
    { kind: "mapper", dir: "adapters", suffix: "Mapper.java" },
    { kind: "repository", dir: "persistence", suffix: "Repository.java" },
    { kind: "event", dir: "events", suffix: "Event.java" },
    { kind: "listener", dir: "events", suffix: "Listener.java" },
    { kind: "dto", dir: "contracts", suffix: "Dto.java" },
    { kind: "config", dir: "configs", suffix: "Config.java" },
    { kind: "guard", dir: "security", suffix: "Guard.java" },
  ],
};

export const CONVENTIONS: Record<Runtime, RuntimeConvention> = { node: NODE_CONVENTION, "spring-boot": SPRING_CONVENTION };

export const SCHEMA_VERSION = 1;
