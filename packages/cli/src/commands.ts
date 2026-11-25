import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  derivePrefix, normalizePrefix, servicePrefix, discover, validateProject, buildManifest, serializeManifest, hasErrors, formatDiagnostic, findWorkspaceRoot, loadWorkspace,
  WORKSPACE_FILE, topoOrder, NAME_PATTERNS, type Diagnostic, type Runtime, type ServiceDecl, type WorkspaceConfig,
} from "@pso/core";
import { CliError, writeFiles, type WriteResult } from "./fsx.ts";
import { str } from "./args.ts";
import { renderTemplate, pascal } from "./templates.ts";
import { makeFiles, NODE_MAKE, SPRING_MAKE, type MakeOpts } from "./generators.ts";
import { analyzeOrchestrator, routeRows, serviceReferenceDiagnostics } from "./http-static.ts";
import { validateSpring } from "./spring-config.ts";
import { dispatchFindings } from "./dispatch-static.ts";
import { frameworkSpecs, psoJavaInstalled, psoJavaVersion } from "./specs.ts";
import { createFrontend, frontendDiagnostics } from "./commands-frontend.ts";
import { reconcileAfter } from "./commands-infra.ts";
import { PRODUCT } from "./crud-spec.ts";
import { springCrudFiles, springSharedFiles } from "./spring-crud-gen.ts";
import { orchestratorCrudCollection, orchestratorCrudFiles, orchestratorCrudTests } from "./orchestrator-crud-gen.ts";
import { orchestratorCrudDoc, springCrudDoc } from "./crud-docs.ts";
import { bindModule, crudBindingFor, unboundModules } from "./crud-binding.ts";
import { LAYERED_JPA_YML } from "./project-structure.ts";

export interface Ctx {
  cwd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  print: (s: string) => void;
}

export interface Command {
  /**
   * The usage line. It is also the declaration of what the command accepts: every `--flag` written here is accepted (with a value
   * when one is shown after it) and any other flag is refused before the command runs (see cli-spec.ts).
   */
  usage: string;
  summary: string;
  /** flags accepted without being advertised in the usage line (compatibility aliases) */
  options?: Readonly<Record<string, "boolean" | "value">>;
  /** largest number of positional arguments after the command name; more is a usage error */
  args?: number;
  /** what to do after the command succeeded (shown by --help) */
  next?: string;
  run(ctx: Ctx): number | Promise<number>;
}

import { json, emit } from "./emit.ts";
export { json, emit };

export function reportWrites(ctx: Ctx, results: WriteResult[]): number {
  const dry = ctx.flags["dry-run"] === true;
  const conflicts = results.filter((r) => r.action === "conflict");
  emit(ctx, { dryRun: dry, files: results }, results.map((r) => `${dry ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`).join("\n"));
  if (conflicts.length) {
    ctx.print(`\n${conflicts.length} file(s) already exist with different content and were NOT modified. Use --force to overwrite.`);
    return 1;
  }
  return 0;
}

export function requireWorkspace(ctx: Ctx): { root: string; config: WorkspaceConfig } {
  const root = findWorkspaceRoot(ctx.cwd);
  if (!root) throw new CliError(`No ${WORKSPACE_FILE} found in ${ctx.cwd} or any parent`, "Run `pso create workspace <name>` first");
  const { config, diagnostics } = loadWorkspace(root);
  if (!config) throw new CliError(`Invalid workspace:\n${diagnostics.map(formatDiagnostic).join("\n")}`, "Fix the workspace file, then retry");
  return { root, config };
}

export const saveWorkspace = (root: string, c: WorkspaceConfig) => writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify(c, null, 2) + "\n");

export const kebabName = (raw: string | undefined, what: string): string => {
  if (!raw) throw new CliError(`Missing ${what} name`);
  if (!NAME_PATTERNS.kebab.test(raw)) throw new CliError(`Invalid ${what} name "${raw}"`, "Use kebab-case, e.g. api-gateway");
  return raw;
};

function nextPort(c: WorkspaceConfig, start: number): number {
  const used = new Set(c.services.map((s) => s.port));
  let p = start;
  while (used.has(p)) p++;
  return p;
}

function createWorkspace(ctx: Ctx): number {
  const name = kebabName(ctx.positionals[1], "workspace");
  const root = resolve(ctx.cwd, name);
  const cfg: WorkspaceConfig = { schemaVersion: 1, name, services: [] };
  const files = {
    [WORKSPACE_FILE]: JSON.stringify(cfg, null, 2) + "\n",
    "README.md": `# ${name}\n\nPSO workspace. Add projects with \`pso create orchestrator <name>\` and \`pso create service <name> --runtime spring-boot\`, then run \`pso validate\`.\n`,
    ".gitignore": "node_modules\ndist\ntarget\n.pso/\n",
  };
  return reportWrites(ctx, writeFiles(root, files, { dryRun: ctx.flags["dry-run"] === true, force: ctx.flags["force"] === true }));
}

async function createProjectIn(ctx: Ctx, role: "orchestrator" | "service"): Promise<number> {
  const { root, config } = requireWorkspace(ctx);
  const name = kebabName(ctx.positionals[1], role);
  if (config.services.some((s) => s.name === name)) throw new CliError(`A project named "${name}" already exists in this workspace`);
  if (role === "orchestrator" && config.services.some((s) => s.role === "orchestrator")) throw new CliError("This workspace already has an orchestrator", "A workspace has exactly one public entry point");
  const runtime = (str(ctx.flags["runtime"]) ?? (role === "orchestrator" ? "node" : "spring-boot")) as Runtime;
  if (role === "orchestrator" && runtime !== "node") throw new CliError("The orchestrator runtime is node");
  if (role === "service" && runtime !== "spring-boot") throw new CliError(`Unsupported service runtime "${runtime}"`, "Supported: spring-boot");

  const portFlag = str(ctx.flags["port"]);
  if (portFlag !== undefined && (!/^\d{4,5}$/.test(portFlag) || Number(portFlag) < 1024 || Number(portFlag) > 65535)) throw new CliError(`Invalid --port "${portFlag}"`, "Use a port between 1024 and 65535");
  if (portFlag !== undefined && config.services.some((x) => x.port === Number(portFlag))) throw new CliError(`Port ${portFlag} is already used by another service of this workspace`);
  const port = portFlag !== undefined ? Number(portFlag) : nextPort(config, role === "orchestrator" ? 3000 : 8081);
  const firstService = config.services.find((s) => s.role !== "orchestrator")?.name;
  // structure: the official one (modular orchestrator, layered Spring service) unless the 0.1 layout is asked for explicitly
  const structureFlag = str(ctx.flags["structure"]);
  const official = role === "orchestrator" ? "modular" : "layered";
  if (structureFlag !== undefined && structureFlag !== "legacy" && structureFlag !== official) throw new CliError(`Invalid --structure "${structureFlag}"`, `Use ${official} (the default) or legacy (the 0.1 layout)`);
  const legacy = structureFlag === "legacy";
  // template: the reference CRUD (default) or an empty project with the same foundations
  const template = str(ctx.flags["template"]) ?? (legacy ? "empty" : "crud");
  if (template !== "crud" && template !== "empty") throw new CliError(`Invalid --template "${template}"`, "Use crud (a working reference CRUD, the default) or empty");
  if (legacy && template === "crud") throw new CliError("The reference CRUD uses the official structure", "Drop --structure legacy, or use --template empty");
  const dbFlag = str(ctx.flags["db"]);
  if (dbFlag !== undefined && dbFlag !== "postgres" && dbFlag !== "none") throw new CliError(`Unsupported database "${dbFlag}"`, "Supported: postgres (or none with --template empty)");
  if (dbFlag && dbFlag !== "none" && role === "orchestrator") throw new CliError("--db applies to services, not the orchestrator");
  if (role === "service" && template === "crud" && dbFlag === "none") throw new CliError("The reference CRUD persists its data in PostgreSQL", "Use --template empty for a service without a database");
  // the CRUD needs PostgreSQL: the dependency is declared, so the infrastructure engine provisions it; the empty template has none unless asked
  const db = role === "service" && (dbFlag === "postgres" || (dbFlag === undefined && template === "crud")) ? "postgres" : undefined;
  const pkgFlag = str(ctx.flags["package"]);
  if (pkgFlag !== undefined && (role === "orchestrator" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkgFlag))) throw new CliError(role === "orchestrator" ? "--package applies to Spring services" : `Invalid --package "${pkgFlag}"`, "Example: --package com.example.products (lower-case, at least two segments)");
  const pkg = pkgFlag ?? `com.pso.${name.replace(/-/g, "")}`;
  const dbDeps = db ? `    <dependency>
      <groupId>com.pso</groupId>
      <artifactId>pso-data-spring-boot-starter</artifactId>
    </dependency>
` : "";
  const dbTestDeps = db ? `    <dependency>
      <groupId>io.zonky.test</groupId>
      <artifactId>embedded-postgres</artifactId>
      <version>2.1.0</version>
      <scope>test</scope>
    </dependency>
` : "";
  const dbname = name.replace(/-/g, "_");
  const prefixFlag = str(ctx.flags["prefix"]);
  if (prefixFlag !== undefined && role === "orchestrator") throw new CliError("--prefix applies to services, not the orchestrator");
  let prefix = "";
  try { prefix = role === "orchestrator" ? "" : prefixFlag !== undefined ? normalizePrefix(prefixFlag) : derivePrefix(name); } catch (e) { throw new CliError((e as Error).message, "Example: --prefix /users (\"/\" means no prefix)"); }
  // the layered structure also fixes how JPA treats the schema: Flyway owns it, Hibernate only validates the mapping; UTC everywhere
  const jpa = !legacy ? LAYERED_JPA_YML : "";
  const springDb = db ? `  datasource:\n    url: \${DB_URL:jdbc:postgresql://localhost:5432/${dbname}}\n    username: \${DB_USER:}\n    password: \${DB_PASSWORD:}\n${legacy ? "" : "    hikari:\n      maximum-pool-size: \${DB_POOL_SIZE:10}\n"}  flyway:\n    enabled: true\n${jpa}` : "";
  const files: Record<string, string> = {};
  let crudFiles: string[] = [];
  let binding: { service: string; source: string } | undefined;
  if (role === "orchestrator") {
    const vars = { name, port, prefix, psoVersion: psoJavaVersion(), springDb, dbProvider: "none", pkg, pkgpath: pkg.split(".").join("/"), firstService: firstService ?? "none", dbDeps, dbTestDeps, dbname, crudSection: "", ...frameworkSpecs() };
    if (legacy) Object.assign(files, renderTemplate("orchestrator", vars));
    else {
      Object.assign(files, renderTemplate("orchestrator-modular", vars));
      if (template === "crud") {
        binding = crudBindingFor(root, config, PRODUCT, str(ctx.flags["crud-service"]));
        const module = PRODUCT.plural;
        const bound = config.services.find((s) => s.name === binding!.service);
        const bprefix = bound ? servicePrefix(bound) : `/${binding.service}`;
        const mod = { ...orchestratorCrudFiles(PRODUCT, { service: binding.service, module, reference: true }), ...orchestratorCrudTests(PRODUCT, { module }), [`docs/api/${PRODUCT.plural}.collection.json`]: orchestratorCrudCollection(PRODUCT, { service: binding.service, servicePrefix: bprefix === "/" ? "" : bprefix }) };
        crudFiles = Object.keys(mod).sort();
        Object.assign(files, mod, { "docs/reference-crud.md": orchestratorCrudDoc(PRODUCT, { orchestrator: name, module, service: binding.service, files: crudFiles }) });
        files["README.md"] = files["README.md"]!.replace("\n## Run", `## Reference CRUD\n\nThe \`${module}\` module is a working example bound to the microservice **${binding.service}** (${binding.source}): see\n[docs/reference-crud.md](docs/reference-crud.md) for the request lifecycle, the endpoints and how to remove it.\n\n## Run`);
      }
    }
  } else {
    const crudSection = template === "crud" ? `## Reference CRUD\n\nA complete ${PRODUCT.name} API (\`${prefix === "/" ? "" : prefix}/${PRODUCT.plural}\`) shows the structure at work: see [docs/reference-crud.md](docs/reference-crud.md) for every\nfile, the endpoints, and how to remove it or generate another resource the same way.\n` : "";
    const vars = { name, port, prefix, psoVersion: psoJavaVersion(), springDb, dbProvider: db ? "postgresql" : "none", pkg, pkgpath: pkg.split(".").join("/"), firstService: firstService ?? "none", dbDeps, dbTestDeps, dbname, crudSection, ...frameworkSpecs() };
    if (legacy) Object.assign(files, renderTemplate("service-spring", vars), db ? renderTemplate("service-spring-postgres", vars) : {});
    else {
      Object.assign(files, renderTemplate("service-spring-layered", vars), db ? renderTemplate("service-spring-postgres", vars) : {});
      // the empty database-backed service has no migration yet: keep the placeholder; the CRUD brings V1
      Object.assign(files, springSharedFiles(pkg, { data: !!db }));
      if (template === "crud") {
        delete files["src/main/resources/db/migration/.gitkeep"];
        const crud = springCrudFiles(PRODUCT, { pkg, migrationVersion: 1, servicePrefix: prefix === "/" ? "" : prefix, withShared: false, reference: true });
        crudFiles = Object.keys(crud).sort();
        Object.assign(files, crud, { "docs/reference-crud.md": springCrudDoc(PRODUCT, { service: name, pkg, prefix: prefix === "/" ? "" : prefix, files: crudFiles }) });
      }
    }
  }

  const decl: ServiceDecl = { name, path: name, runtime, role: role === "orchestrator" ? "orchestrator" : "service", ...(role !== "orchestrator" && runtime === "spring-boot" ? { prefix } : {}), ...(db ? { db: "postgres" as const } : {}), port, health: role === "orchestrator" ? "/health/ready" : "/actuator/health" };
  const results = writeFiles(join(root, name), files, { dryRun: ctx.flags["dry-run"] === true, force: ctx.flags["force"] === true });
  const code = reportWrites(ctx, results);
  if (code === 0 && ctx.flags["dry-run"] !== true) {
    config.services.push(decl);
    saveWorkspace(root, config);
    ctx.print(`registered "${name}" in ${WORKSPACE_FILE} (port ${port})`);
    if (binding) ctx.print(`reference CRUD: module "${PRODUCT.plural}" bound to service "${binding.service}" (${binding.source})`);
    // a CRUD service adopts the orchestrator's reference module that is still waiting for its service
    const orch = config.services.find((s) => s.role === "orchestrator");
    if (role === "service" && template === "crud" && orch) {
      for (const m of unboundModules(join(root, ...orch.path.split("/")), config).filter((x) => x.resource === PRODUCT.name)) {
        const fromPrefix = derivePrefix(m.service), toPrefix = prefix === "/" ? "" : prefix;
        const changed = bindModule(m, name, { from: fromPrefix === "/" ? "" : fromPrefix, to: toPrefix });
        if (changed.length) ctx.print(`reference CRUD: orchestrator module "${m.module}" was waiting for "${m.service}"; now bound to "${name}" (${changed.length} file(s) updated)`);
      }
    }
    await reconcileAfter(ctx, root, `creating ${role} "${name}"`);
    if (runtime === "spring-boot" && !psoJavaInstalled(psoJavaVersion())) ctx.print(`
note: the PSO Java artifacts (${psoJavaVersion()}) are not in your local Maven repository yet. Run: pso java:install`);
  }
  return code;
}

export interface Project { root: string; runtime: Runtime; name: string }

export function resolveProject(ctx: Ctx): Project {
  const svc = str(ctx.flags["service"]);
  if (svc) {
    const { root, config } = requireWorkspace(ctx);
    const s = config.services.find((x) => x.name === svc);
    if (!s) throw new CliError(`Unknown service "${svc}"`, `Known: ${config.services.map((x) => x.name).join(", ") || "(none)"}`);
    return { root: join(root, ...s.path.split("/")), runtime: s.runtime, name: s.name };
  }
  let dir = resolve(ctx.cwd);
  for (;;) {
    if (existsSync(join(dir, "pom.xml"))) return { root: dir, runtime: "spring-boot", name: dir };
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "main.ts"))) return { root: dir, runtime: "node", name: dir };
    const up = dirname(dir);
    if (up === dir) throw new CliError("Not inside a PSO project", "cd into a project or pass --service <name>");
    dir = up;
  }
}

/** Kinds whose template contains a path: only these take --route and --method. */
const ROUTED_KINDS = new Set(["controller", "contract"]);
const MAKE_SUMMARY: Readonly<Record<string, string>> = {
  middleware: "Generate a middleware in src/.app/middlewares/ (orchestrator; 0.1: src/middlewares/). It runs only for the routes that name it in ROUTES.pso.ts",
  filter: "Generate an error filter. Orchestrator: src/.app/filters/ (0.1: src/filters/), run for the routes that name it; Spring (layered): a servlet filter in infrastructure/filter",
  contract: "Generate a service contract (JSON) in src/.app/contracts/ (orchestrator; 0.1: src/contracts/): the operations the orchestrator expects from a service",
  config: "Generate a configuration artifact. Orchestrator: a plain module in src/.app/configs/ (0.1: src/configs/) used by importing it; Spring: a @Configuration class (layered: infrastructure/config)",
  interceptor: "Generate an interceptor in src/.app/interceptors/ (modular orchestrator). It runs around the action of the routes that name it (interceptors: [...] in ROUTES.pso.ts)",
  decorator: "Generate a reusable method decorator in src/.app/decorators/ (modular orchestrator): application metadata, never routing or security",
  entity: "Generate a JPA entity in infrastructure/entity (layered Spring service); add its table with pso make:migration",
  exception: "Generate an application exception in shared/exception (layered Spring service), answered as an RFC 9457 problem",
  client: "Generate an outbound client in infrastructure/client (layered Spring service) that calls a declared service through PsoHttpClient",
  request: "Generate a request record with Jakarta Validation in application/dto/request (layered Spring service)",
  response: "Generate a response record in application/dto/response (layered Spring service)",
  port: "Generate a port interface (Spring, 0.1 hexagonal layout only: ports/; the layered structure has no ports)",
  adapter: "Generate an adapter component (Spring, 0.1 hexagonal layout only: adapters/; layered services use clients: pso make:client)",
  mapper: "Generate a mapper component (Spring, layered: application/mapper; 0.1: adapters/). Orchestrator mappers: pso make:mapper <module> <name>",
  repository: "Generate a Spring Data repository (layered: infrastructure/persistence, for an existing entity; 0.1: persistence/). It does not enable a database: see `pso database:enable`",
};

/** The endpoint prefix of the Spring service at `projectRoot`, from the workspace declaration (the same value the starter applies). */
function springPrefixOf(ctx: Ctx, projectRoot: string): string {
  const root = findWorkspaceRoot(ctx.cwd);
  const config = root ? loadWorkspace(root).config : undefined;
  const decl = config?.services.find((s) => resolve(root!, ...s.path.split("/")) === resolve(projectRoot));
  return decl ? servicePrefix(decl) : "";
}

export function make(kind: string): Command {
  const routed = ROUTED_KINDS.has(kind);
  return {
    usage: `pso make:${kind} <name> [--service <name>]${routed ? " [--route /path] [--method GET]" : ""}${kind === "dto" ? " [--response]" : ""} [--dry-run] [--force] [--json]`,
    summary: MAKE_SUMMARY[kind] ?? `Generate a ${kind} in the current (or --service) project`,
    run(ctx) {
      const name = ctx.positionals[0];
      if (!name) throw new CliError(`Missing ${kind} name`);
      const p = resolveProject(ctx);
      const opts: MakeOpts = {};
      const route = str(ctx.flags["route"]); if (route) opts.route = route;
      const method = str(ctx.flags["method"]); if (method) opts.method = method;
      if (ctx.flags["response"] === true) opts.response = true;
      if (p.runtime === "spring-boot" && kind === "controller") opts.servicePrefix = springPrefixOf(ctx, p.root);
      const { files } = makeFiles(p.runtime, kind, name, p.root, opts);
      return reportWrites(ctx, writeFiles(p.root, files, { dryRun: ctx.flags["dry-run"] === true, force: ctx.flags["force"] === true }));
    },
  };
}

const MAKE_KINDS = [...new Set([...NODE_MAKE, ...SPRING_MAKE])].sort();

export function validateAll(ctx: Ctx): { diagnostics: Diagnostic[]; manifests: Array<{ service: string; digest: string; resources: number }> } {
  const root = findWorkspaceRoot(ctx.cwd);
  if (!root) throw new CliError(`No ${WORKSPACE_FILE} found in ${ctx.cwd} or any parent`, "Run `pso create workspace <name>` first");
  const diagnostics: Diagnostic[] = [];
  const manifests: Array<{ service: string; digest: string; resources: number }> = [];
  const { config, diagnostics: wsd } = loadWorkspace(root);
  diagnostics.push(...wsd);
  if (!config) return { diagnostics, manifests }; // invalid workspace: report, do not throw
  for (const s of config.services) {
    const projectRoot = join(root, ...s.path.split("/"));
    if (!existsSync(projectRoot)) { diagnostics.push({ code: "PSO_SERVICE_MISSING", severity: "error", message: `Service "${s.name}" path "${s.path}" does not exist`, file: WORKSPACE_FILE }); continue; }
    const d = discover(projectRoot, s.runtime, s.structure ? { declaredStructure: s.structure } : {});
    for (const x of validateProject(projectRoot, d)) diagnostics.push({ ...x, file: x.file ? `${s.path}/${x.file}` : s.path });
    if (s.role === "orchestrator" && s.runtime === "node") {
      // three-way validation: MODULE.pso.ts + ROUTES.pso.ts + decorated controllers (static, nothing is executed)
      const a = analyzeOrchestrator(projectRoot);
      for (const x of [...a.diagnostics, ...serviceReferenceDiagnostics(a, config, projectRoot)]) diagnostics.push({ ...x, file: x.file ? `${s.path}/${x.file}` : s.path });
    }
    if (s.runtime === "spring-boot") {
      // typed pso.* configuration, checked statically with the same rules the starters apply at start-up
      for (const f of validateSpring(root, s)) if (f.severity === "critical" || f.severity === "high") diagnostics.push({ code: `PSO_SPRING_${f.id}`, severity: "error", message: f.message, file: f.file ?? s.path, hint: f.remediation });
    }
    const m = buildManifest(d);
    manifests.push({ service: s.name, digest: m.digest, resources: m.resources.length });
    if (ctx.flags["write-manifest"] === true && ctx.flags["dry-run"] !== true) {
      mkdirSync(join(projectRoot, ".pso"), { recursive: true });
      writeFileSync(join(projectRoot, ".pso", "manifest.json"), serializeManifest(m));
    }
  }
  // dispatch declarations, schemas, contract lock and provider consistency (static; nothing is executed, no broker is contacted)
  for (const d of dispatchFindings(root, config)) {
    const svc = config.services.find((x) => x.name === d.service);
    for (const f of d.findings) if (f.severity !== "info") diagnostics.push({ code: f.code, severity: f.severity, message: `${d.service}: ${f.message}`, file: f.file ?? svc?.path, ...(f.hint ? { hint: f.hint } : {}) });
  }
  diagnostics.push(...crossValidate(root, config));
  diagnostics.push(...frontendDiagnostics(root, config));
  return { diagnostics, manifests };
}

export const COMMANDS: Record<string, Command> = {
  "create": {
    usage: "pso create workspace <name> | orchestrator <name> [--crud-service <service>] | service <name> --runtime spring-boot [--package com.example.name] [--db postgres|none] | fei <name> | mei <name> [--host <fei>] [--register [--public | --scopes a,b]] [--install]  [--template crud|empty] [--structure legacy] [--port <1024-65535>] [--prefix /path] [--dry-run] [--force] [--json]",
    summary: "Create a workspace, an orchestrator, a Spring Boot service, or a frontend project: the application shell (fei) or a microfrontend (mei)",
    run(ctx) {
      const what = ctx.positionals[0];
      if (what === "workspace") return createWorkspace(ctx);
      if (what === "orchestrator" || what === "service") return createProjectIn(ctx, what);
      if (what === "fei" || what === "mei") return createFrontend(ctx, what);
      throw new CliError(`Unknown create target "${what ?? ""}"`, "Use: workspace | orchestrator | service | fei | mei");
    },
  },
  "validate": {
    usage: "pso validate [--write-manifest [--dry-run]] [--json]",
    summary: "Validate workspace structure, conventions and contracts (exit 1 on errors)",
    run(ctx) {
      const { diagnostics, manifests } = validateAll(ctx);
      const errors = hasErrors(diagnostics);
      emit(ctx, { ok: !errors, diagnostics, manifests }, (diagnostics.length ? diagnostics.map(formatDiagnostic).join("\n") + "\n" : "") + manifests.map((m) => `${m.service}: ${m.resources} resource(s), digest ${m.digest.slice(0, 12)}`).join("\n") + `\n${errors ? "FAILED" : "OK"}`);
      return errors ? 1 : 0;
    },
  },
  "inspect": {
    usage: "pso inspect [--service <name>] [--json]",
    summary: "List the resources PSO discovered in a project",
    run(ctx) {
      const p = resolveProject(ctx);
      const d = discover(p.root, p.runtime);
      emit(ctx, { runtime: p.runtime, resources: d.resources, diagnostics: d.diagnostics }, d.resources.map((r) => `${r.kind.padEnd(11)} ${r.id.padEnd(28)} ${r.file}`).join("\n") || "(no resources)");
      return 0;
    },
  },
  "services:list": {
    usage: "pso services:list [--json]",
    summary: "List services declared in the workspace",
    run(ctx) {
      const { config } = requireWorkspace(ctx);
      const rows = [...config.services].sort((a, b) => (a.name < b.name ? -1 : 1));
      emit(ctx, rows, rows.map((s) => `${s.name.padEnd(20)} ${(s.role ?? "service").padEnd(13)} ${s.runtime.padEnd(12)} :${s.port}  deps=[${(s.dependsOn ?? []).join(",")}]`).join("\n") || "(no services)");
      return 0;
    },
  },
  "services:graph": {
    usage: "pso services:graph [--mermaid] [--json]",
    summary: "Show the service dependency graph and startup order",
    run(ctx) {
      const { config } = requireWorkspace(ctx);
      const edges = new Map(config.services.map((s) => [s.name, s.dependsOn ?? []] as [string, string[]]));
      const order = topoOrder(edges);
      if (ctx.flags["mermaid"] === true) {
        ctx.print(["graph TD", ...config.services.flatMap((s) => (s.dependsOn ?? []).map((d) => `  ${s.name.replace(/-/g, "_")} --> ${d.replace(/-/g, "_")}`))].join("\n"));
      } else emit(ctx, { startupOrder: order, edges: Object.fromEntries(edges) }, `startup order: ${order.join(" -> ")}`);
      return 0;
    },
  },
  "routes:list": {
    usage: "pso routes:list [--json] [--out <file>]",
    summary: "List the routes declared in ROUTES.pso.ts files with their effective policy; fails when the registry is invalid",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const orch = config.services.find((s) => s.role === "orchestrator");
      if (!orch) throw new CliError("No orchestrator in this workspace");
      const a = analyzeOrchestrator(join(root, orch.path));
      const rows = routeRows(join(root, orch.path), a);
      const outFile = typeof ctx.flags["out"] === "string" ? (ctx.flags["out"] as string) : undefined;
      // route metadata published WITH a release: package this file in the orchestrator's artifact (pso-release.json) and the deployed release can be explored without the source tree
      if (outFile && a.ok) writeFileSync(outFile, JSON.stringify({ schema: 1, kind: "pso-orchestrator-routes", generatedAt: new Date().toISOString(), service: orch.name, routes: rows }, null, 2));
      emit(ctx, { ok: a.ok, ...(outFile && a.ok ? { wrote: outFile } : {}), routes: rows.map((r) => ({ ...r, active: a.ok })), diagnostics: a.diagnostics }, [
        ...rows.map((r) => `${r.method.padEnd(7)} ${r.path.padEnd(24)} ${r.module}.${r.action.padEnd(14)} ${r.service || r.services.length ? `-> ${[...new Set([...(r.service ? [r.service] : []), ...r.services])].join(",").padEnd(14)}` : "".padEnd(17)} ${r.access}${a.ok ? "" : "  [NOT ACTIVE]"}`),
        ...(rows.length ? [] : ["(no routes declared)"]),
        ...a.diagnostics.map(formatDiagnostic),
      ].join("\n"));
      return a.ok ? 0 : 1;
    },
  },
  "doctor": {
    usage: "pso doctor [--json]",
    summary: "Check the local toolchain",
    run(ctx) {
      const checks = [
        { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version, need: ">=24" },
        ...["java", "mvn", "docker"].map((bin) => {
          const r = probe(bin);
          return { name: bin, ok: r.ok, detail: r.detail, need: bin === "mvn" ? "optional (or use Docker)" : bin === "docker" ? "optional" : ">=21 for Spring Boot services" };
        }),
      ];
      emit(ctx, checks, checks.map((c) => `${c.ok ? "ok     " : "missing"} ${c.name.padEnd(7)} ${c.detail}  (${c.need})`).join("\n"));
      return checks[0]!.ok ? 0 : 1;
    },
  },
};

for (const k of MAKE_KINDS) COMMANDS[`make:${k}`] = make(k);

import { spawnSync } from "node:child_process";
import { programInvocation } from "./proc.ts";
function probe(bin: string): { ok: boolean; detail: string } {
  // java and docker are executables; mvn is a batch wrapper on Windows. None of them is started through a shell command string.
  let inv: { command: string; args: string[] };
  try { inv = programInvocation(bin, bin === "java" ? ["-version"] : ["--version"]); } catch { return { ok: false, detail: "not found" }; }
  const r = spawnSync(inv.command, inv.args, { encoding: "utf8", timeout: 15000 });
  if (r.error || r.status !== 0) return { ok: false, detail: "not found" };
  return { ok: true, detail: ((r.stdout || r.stderr).split(/\r?\n/)[0] ?? "").trim() };
}

export { pascal };

/** Cross-project checks: contracts must name a declared service and match their mirror inside that service. */
function crossValidate(root: string, config: WorkspaceConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  const orch = config.services.find((s) => s.role === "orchestrator");
  if (!orch) return out;
  const orchDir = join(root, ...orch.path.split("/"));
  if (!existsSync(orchDir)) return out;
  const d = discover(orchDir, "node");
  for (const r of d.resources) {
    const file = join(orchDir, ...r.file.split("/"));
    const rel = `${orch.path}/${r.file}`;
    if (r.kind === "contract") {
      let c: { service?: string } = {};
      try { c = JSON.parse(readFileSync(file, "utf8")) as { service?: string }; } catch { continue; } // reported by validateProject
      const svc = config.services.find((s) => s.name === c.service);
      if (!svc) { out.push({ code: "PSO_CONTRACT_UNKNOWN_SERVICE", severity: "error", message: `Contract targets unknown service "${String(c.service)}"`, file: rel }); continue; }
      const mirror = join(root, ...svc.path.split("/"), "src", "main", "resources", "contracts", `${r.id}.contract.json`);
      if (existsSync(mirror) && readFileSync(mirror, "utf8") !== readFileSync(file, "utf8")) out.push({ code: "PSO_CONTRACT_DRIFT", severity: "error", message: `Contract "${r.id}" differs from its copy in service "${svc.name}"`, file: rel, hint: "Update both copies together (pso make:resource --force regenerates them)" });
    }
  }
  return out;
}
