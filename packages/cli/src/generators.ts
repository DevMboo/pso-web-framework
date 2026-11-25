import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { walkFiles, NAME_PATTERNS, CONVENTIONS, type Runtime } from "@pso/core";
import { CliError } from "./fsx.ts";
import { pascal, camel } from "./templates.ts";
import { orchestratorStructure, requireConsistent, springStructure } from "./project-structure.ts";
import { APP_KIND, layeredSpringFiles, modularNodeFiles } from "./generators-structured.ts";

export const NODE_MAKE = ["middleware", "filter", "guard", "service", "config", "provider", "hook", "contract", "interceptor", "decorator"] as const;
export const SPRING_MAKE = ["controller", "service", "port", "adapter", "mapper", "repository", "event", "listener", "dto", "config", "guard", "entity", "filter", "exception", "client", "request", "response"] as const;
/** kinds that exist only in the official structures (modular orchestrator, layered service) */
const NEW_NODE = new Set(["interceptor", "decorator"]);
const NEW_SPRING = new Set(["entity", "filter", "exception", "client", "request", "response"]);

/** Finds the Java package of the service from its @SpringBootApplication class. */
export function findJavaPackage(projectRoot: string): string {
  const base = join(projectRoot, "src", "main", "java");
  const find = (dir: string): string | undefined => {
    for (const p of walkFiles(dir).files) if (p.endsWith(".java") && readFileSync(p, "utf8").includes("@SpringBootApplication")) return p;
    return undefined;
  };
  let file: string | undefined;
  try { file = find(base); } catch { /* handled below */ }
  const m = file && /^\s*package\s+([\w.]+)\s*;/m.exec(readFileSync(file, "utf8"));
  if (!m) throw new CliError("Cannot find the @SpringBootApplication class", "Run this inside a Spring Boot PSO service, or pass --service <name>");
  return m[1]!;
}

export interface MakeOpts {
  route?: string; method?: string;
  /** the endpoint prefix PSO applies to every controller of the Spring service (pso.service.prefix); "" when there is none */
  servicePrefix?: string;
  /** make:dto in a layered service: a response record (application/dto/response) instead of a request record */
  response?: boolean;
  /** the project root, for checks against existing files (a repository needs its entity) */
  projectRoot?: string;
}

/**
 * True when a controller path begins with the service prefix itself (controller "orders" in the service whose prefix is /orders, or
 * --route /orders/archive there). The service then serves it at <prefix><route>, a path that starts with the prefix twice, which the
 * Spring starter refuses unless the controller declares it (@RepeatsServicePrefix). Compared segment by segment: /orders-archive
 * does not repeat /orders. One rule for make:controller and make:resource.
 */
export function repeatsPrefix(prefix: string, route: string): boolean {
  if (prefix === "" || prefix === "/") return false;
  const p = prefix.split("/").filter(Boolean), r = route.split("/").filter(Boolean);
  return r.length >= p.length && p.every((seg, i) => r[i] === seg);
}

export interface Generated {
  files: Record<string, string>;
}

export function makeFiles(runtime: Runtime, kind: string, rawName: string, projectRoot: string, opts: MakeOpts = {}): Generated {
  const supported: readonly string[] = runtime === "node" ? NODE_MAKE : SPRING_MAKE;
  if (!supported.includes(kind)) throw new CliError(`Kind "${kind}" is not supported for runtime ${runtime}`, `Supported: ${supported.join(", ")}`);
  // the official structures place every kind by the project's convention; the 0.1 ones keep their own rules below
  if (runtime === "node") {
    const st = orchestratorStructure(projectRoot);
    requireConsistent(st.finding, "the orchestrator");
    if (st.layout.structure === "modular") return modularNodeFiles(kind, rawName, opts);
    if (NEW_NODE.has(kind)) throw new CliError(`make:${kind} needs the modular structure (src/.app/${APP_KIND[kind]}/)`, "This orchestrator follows the 0.1 layout; `pso structure:inspect` shows how to migrate it");
  } else {
    const st = springStructure(projectRoot);
    requireConsistent(st.finding, "the service");
    // an entity or a repository needs JPA: a service without a database of its own would not compile (the data starter of the h2
    // Maven profile does not count: it is absent from a normal build)
    if (st.layout.structure === "layered" && (kind === "entity" || kind === "repository")) {
      const pomFile = join(projectRoot, "pom.xml");
      const pom = existsSync(pomFile) ? readFileSync(pomFile, "utf8") : "";
      const main = pom.split("<profiles>")[0] ?? "";
      if (!/<artifactId>(pso-data-spring-boot-starter|spring-boot-starter-data-jpa)<\/artifactId>/.test(main)) throw new CliError(`make:${kind} needs a database: this service has no JPA dependency`, `Enable PostgreSQL first: pso database:enable postgresql --service ${basename(projectRoot)}`);
    }
    if (st.layout.structure === "layered") return layeredSpringFiles(kind, rawName, st.pkg, { ...opts, projectRoot });
    if (NEW_SPRING.has(kind)) throw new CliError(`make:${kind} needs the layered structure (application/, infrastructure/, shared/)`, "This service follows the 0.1 layout; `pso structure:inspect` shows how to migrate it");
  }
  const conv = CONVENTIONS[runtime];
  const spec = conv.kinds.find((k) => k.kind === kind);
  if (!spec) throw new CliError(`Kind "${kind}" is not supported for runtime ${runtime}`, `Supported: ${supported.join(", ")}`);

  // Names are validated before they ever reach a path or a template.
  const kebab = runtime === "node" ? rawName : rawName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (!NAME_PATTERNS.kebab.test(kebab)) throw new CliError(`Invalid name "${rawName}"`, "Use kebab-case, e.g. customer-orders");
  const method = (opts.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new CliError(`Invalid HTTP method "${opts.method}"`);
  const route = opts.route ?? `/${kebab}`;
  if (!/^\/[A-Za-z0-9/_-]*$/.test(route)) throw new CliError(`Invalid route "${route}"`, "Use letters, digits, '-', '_' and '/' only");

  if (runtime === "node") {
    const file = `src/${spec.dir}/${kebab}${spec.suffix}`;
    return { files: { [file]: nodeTemplate(kind, kebab, route, method) } };
  }
  const pkg = findJavaPackage(projectRoot);
  const cls = pascal(kebab);
  const dir = `src/main/java/${pkg.split(".").join("/")}/${spec.dir}`;
  const body = springTemplate(kind, `${pkg}.${spec.dir}`, cls, route, method, opts.servicePrefix ?? "");
  return { files: { [`${dir}/${cls}${spec.suffix}`]: body } };
}

export function nodeTemplate(kind: string, id: string, route: string, method: string): string {
  const n = camel(id);
  switch (kind) {
    case "guard":
      return `import type { Guard } from "@pso/http";

// Deny by default: replace with real verification (e.g. JWT validation against a JWKS).
const guard: Guard = () => false;
export default guard;
`;
    case "middleware":
      return `import type { Middleware } from "@pso/http";

// Runs after the guards of the routes that name it. End the response to stop the request.
const middleware: Middleware = () => {};
export default middleware;
`;
    case "filter":
      return `import type { Filter } from "@pso/http";

// Return true when the error was handled (the response has been written).
const filter: Filter = () => false;
export default filter;
`;
    case "contract":
      return JSON.stringify({ name: id, version: "0.1.0", service: "REPLACE_WITH_SERVICE", operations: [{ id: `${n}List`, method: "GET", path: route }] }, null, 2) + "\n";
    case "config":
      return `/**
 * Configuration "${id}" of this application.
 *
 * A plain module: the values are read once, when it is first imported, and it is used by importing it where it is needed:
 *
 *   import ${n}Config from "../../configs/${id}.config";
 *
 * The framework neither loads nor injects it, and it is not where framework settings live (limits, security, logging and
 * dispatch are in pso.config.json; see \`pso config:list\`). Read secrets from the environment, never write them here.
 */
export default Object.freeze({
  name: "${id}",
  // example: bucket: process.env["STORAGE_BUCKET"] ?? "local",
});
`;
    default:
      return `export default function ${n}${pascal(kind)}(): void {\n  // ${kind} "${id}"\n}\n`;
  }
}

export function springTemplate(kind: string, pkg: string, cls: string, route: string, method: string, servicePrefix: string): string {
  const head = `package ${pkg};\n\n`;
  const mapping = { GET: "GetMapping", POST: "PostMapping", PUT: "PutMapping", PATCH: "PatchMapping", DELETE: "DeleteMapping" }[method]!;
  switch (kind) {
    case "controller": {
      // the same rule as make:resource: a path that begins with the service prefix is legitimate when it is declared
      const repeats = repeatsPrefix(servicePrefix, route);
      return `${head}import java.util.List;\nimport org.springframework.web.bind.annotation.${mapping};\nimport org.springframework.web.bind.annotation.RequestMapping;\nimport org.springframework.web.bind.annotation.RestController;\n${repeats ? "import com.pso.spring.autoconfigure.RepeatsServicePrefix;\n" : ""}\n${repeats ? `// The service prefix ${servicePrefix} is applied by PSO, so this controller is served at ${servicePrefix}${route}. The path repeats the prefix on\n// purpose (the controller is named like the service): @RepeatsServicePrefix says so, otherwise PSO would refuse it as a mistake.\n` : ""}@RestController\n${repeats ? "@RepeatsServicePrefix\n" : ""}@RequestMapping("${route}")\npublic class ${cls}Controller {\n\n    @${mapping}\n    public List<String> handle() {\n        return List.of();\n    }\n}\n`;
    }
    case "service":
      return `${head}import lombok.RequiredArgsConstructor;\nimport org.springframework.stereotype.Service;\n\n/** Dependencies are final fields: Lombok generates the constructor and Spring injects through it. */\n@Service\n@RequiredArgsConstructor\npublic class ${cls}Service {\n}\n`;
    case "port":
      return `${head}public interface ${cls}Port {\n}\n`;
    case "repository":
      return `${head}public interface ${cls}Repository {\n}\n`;
    case "adapter":
      return `${head}import org.springframework.stereotype.Component;\n\n@Component\npublic class ${cls}Adapter {\n}\n`;
    case "mapper":
      return `${head}import org.springframework.stereotype.Component;\n\n@Component\npublic class ${cls}Mapper {\n}\n`;
    case "event":
      return `${head}public record ${cls}Event(String id) {\n}\n`;
    case "listener":
      return `${head}import org.springframework.context.event.EventListener;\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class ${cls}Listener {\n\n    @EventListener\n    public void on(Object event) {\n    }\n}\n`;
    case "dto":
      return `${head}import jakarta.validation.constraints.NotBlank;\n\npublic record ${cls}Dto(@NotBlank String id) {\n}\n`;
    case "config":
      return `${head}import org.springframework.context.annotation.Configuration;\n\n/** Spring configuration: found by the component scan of this service (every class under the application package), like any bean. */\n@Configuration\npublic class ${cls}Config {\n}\n`;
    default: // guard
      return `${head}import org.springframework.stereotype.Component;\n\n/** Deny by default. */\n@Component\npublic class ${cls}Guard {\n\n    public boolean allows() {\n        return false;\n    }\n}\n`;
  }
}
