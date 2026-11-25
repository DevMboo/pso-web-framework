import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NAME_PATTERNS, WORKSPACE_DIRS, derivePrefix, layoutMoves, servicePrefix, workspaceLayout, type ServiceDecl } from "@pso/core";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { camel, pascal } from "./templates.ts";
import { emit, make, requireWorkspace, resolveProject, type Command, type Ctx } from "./commands.ts";
import { emptyPlan, modulePaths, reader } from "./http-gen.ts";
import { requireModule, runPlan } from "./commands-http.ts";
import { reconcileAfter } from "./commands-infra.ts";
import { resourceFrom, names, type ResourceSpec } from "./crud-spec.ts";
import { springCrudFiles, springSharedFiles } from "./spring-crud-gen.ts";
import { orchestratorCrudCollection, orchestratorCrudFiles, orchestratorCrudTests } from "./orchestrator-crud-gen.ts";
import { bindModule, crudModules } from "./crud-binding.ts";
import { requireConsistent, springStructure } from "./project-structure.ts";
import { structurePlan } from "./structure-plan.ts";

const dry = (ctx: Ctx): boolean => ctx.flags["dry-run"] === true;
const kebab = (raw: string | undefined, what: string): string => {
  if (!raw) throw new CliError(`Missing ${what}`);
  if (!NAME_PATTERNS.kebab.test(raw)) throw new CliError(`Invalid ${what} "${raw}"`, "Use kebab-case, e.g. order-line");
  return raw;
};
const nextMigration = (svcDir: string): number => {
  const dir = join(svcDir, "src", "main", "resources", "db", "migration");
  const v = existsSync(dir) ? readdirSync(dir).map((f) => /^V(\d+)__/.exec(f)?.[1]).filter((x): x is string => !!x).map(Number) : [];
  return (v.length ? Math.max(...v) : 0) + 1;
};

/** Spring side of make:crud: the layered resource files, the shared foundation when missing, the next migration. Nothing is overwritten. */
function springCrud(ctx: Ctx, root: string, svc: ServiceDecl, r: ResourceSpec): Array<{ path: string; action: string }> {
  const dir = join(root, ...svc.path.split("/"));
  const st = springStructure(dir);
  requireConsistent(st.finding, svc.name);
  if (st.layout.structure !== "layered") throw new CliError(`${svc.name} follows the 0.1 structure; make:crud generates the layered one`, "Use pso make:resource there, or migrate the service first (pso structure:inspect)");
  if (svc.db !== "postgres") throw new CliError(`${svc.name} has no database: a CRUD persists its data`, "Enable PostgreSQL first: pso database:enable postgresql --service " + svc.name);
  const prefix = servicePrefix(svc);
  // a service created before 0.2.0 may still accept unknown JSON properties (Spring's default): the generated test then does not assert it
  const yml = join(dir, "src", "main", "resources", "application.yml");
  const strictJson = existsSync(yml) && /fail-on-unknown-properties:\s*true/.test(readFileSync(yml, "utf8"));
  if (!strictJson && !dry(ctx)) ctx.print(`note: ${svc.name} accepts JSON properties its contracts do not declare (Spring's default). Refuse them with spring.jackson.deserialization.fail-on-unknown-properties: true in application.yml`);
  const files = springCrudFiles(r, { pkg: st.pkg, migrationVersion: nextMigration(dir), servicePrefix: prefix === "/" ? "" : prefix, withShared: false, reference: false, strictJson });
  const taken = Object.keys(files).filter((f) => existsSync(join(dir, ...f.split("/"))) || (f.includes("/db/migration/") && existsSync(join(dir, "src/main/resources/db/migration")) && readdirSync(join(dir, "src/main/resources/db/migration")).some((x) => x.endsWith(`__create_${names(r).table}.sql`))));
  if (taken.length) throw new CliError(`${svc.name} already has the ${r.name} resource (${taken.length} file(s) exist, e.g. ${taken[0]})`, "Existing code is never overwritten; choose another resource name");
  // the shared foundation (exceptions, paging) is written only where it is missing: a project's own changes are kept
  for (const [k, v] of Object.entries(springSharedFiles(st.pkg))) if (!existsSync(join(dir, ...k.split("/")))) files[k] = v;
  return writeFiles(dir, files, { dryRun: dry(ctx) }).map((x) => ({ path: `${svc.path}/${x.path}`, action: x.action }));
}

export const STRUCTURE_COMMANDS: Record<string, Command> = {
  "make:crud": {
    usage: "pso make:crud <resource> [--service <spring-service>] [--orchestrator] [--to <service>] [--plural <name>] [--fields \"code:string:unique:filter:sort,total:decimal:precision=12:scale=2:min=0\"] [--module <name>] [--dry-run] [--json]",
    summary: "Generate a complete CRUD resource in the official structures: in a Spring service (entity, Flyway migration, repository with database-level filters, request/response records, mapper, transactional service, controller with scopes, tests) and/or, with --orchestrator, the matching orchestrator module (DTOs, contract, provider, service, mapper, controller, routes) bound to that service",
    next: "`pso validate`; then `./mvnw test` in the service and `npm test` in the orchestrator",
    async run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const r = resourceFrom(kebab(ctx.positionals[0], "resource name"), str(ctx.flags["plural"]), str(ctx.flags["fields"]));
      const svcName = str(ctx.flags["service"]);
      const svc = svcName ? config.services.find((s) => s.name === svcName) : undefined;
      if (svcName && !svc) throw new CliError(`Unknown service "${svcName}"`, `Known: ${config.services.map((s) => s.name).join(", ")}`);
      const wantOrch = ctx.flags["orchestrator"] === true || svc?.role === "orchestrator";
      const spring = svc && svc.runtime === "spring-boot" ? svc : undefined;
      if (!spring && !wantOrch) throw new CliError("Name the Spring service with --service, and/or add --orchestrator", "Example: pso make:crud order --service sales --orchestrator");
      const rows: Array<{ path: string; action: string }> = [];
      if (spring) rows.push(...springCrud(ctx, root, spring, r));
      if (wantOrch) {
        const orch = config.services.find((s) => s.role === "orchestrator");
        if (!orch) throw new CliError("This workspace has no orchestrator", "pso create orchestrator <name>");
        const to = str(ctx.flags["to"]) ?? spring?.name;
        if (!to) throw new CliError("Which service serves the resource? Pass --to <service> (or --service <spring-service>)");
        if (!config.services.some((s) => s.name === to && s.role !== "orchestrator")) throw new CliError(`"${to}" is not a service of this workspace`, "Create it first, or bind later with pso crud:bind");
        const orchDir = join(root, ...orch.path.split("/"));
        const P = modulePaths(orchDir);
        if (!P.modular) throw new CliError(`${orch.name} follows the 0.1 structure; make:crud generates a modular module`, "Use pso make:module / make:route there, or migrate the orchestrator first (pso structure:inspect)");
        const module = kebab(str(ctx.flags["module"]) ?? r.plural, "module name");
        if (existsSync(join(orchDir, P.module(module)))) throw new CliError(`Module "${module}" already exists in ${orch.name}`, "Choose another --module, or extend the module with pso make:route");
        const plan = emptyPlan();
        const toDecl = config.services.find((s) => s.name === to)!;
        const toPrefix = servicePrefix(toDecl);
        Object.assign(plan.create, orchestratorCrudFiles(r, { service: to, module, reference: false, paths: P }), orchestratorCrudTests(r, { module }), { [`docs/api/${r.plural}.collection.json`]: orchestratorCrudCollection(r, { service: to, servicePrefix: toPrefix === "/" ? "" : toPrefix }) });
        // runPlan re-validates the whole orchestrator and rolls everything back if the new module would leave it inconsistent
        const code = runPlan({ ...ctx, print: () => {} }, orchDir, plan);
        if (code !== 0) return code;
        rows.push(...Object.keys(plan.create).sort().map((p) => ({ path: `${orch.path}/${p}`, action: "created" }))); // the "[dry-run] " prefix below says nothing was written, as for the service's files
      }
      emit(ctx, { dryRun: dry(ctx), resource: r.name, files: rows }, rows.map((x) => `${dry(ctx) ? "[dry-run] " : ""}${x.action.padEnd(10)} ${x.path}`).join("\n"));
      if (!dry(ctx)) {
        const n = names(r);
        ctx.print(`\n${n.Resource} CRUD: scopes ${n.readScope} / ${n.writeScope}${wantOrch ? `, public route GET ${n.path}/options` : ""}. Development users with every scope get them on the next identity reconciliation.`);
        await reconcileAfter(ctx, root, `generating the ${r.name} CRUD`);
      }
      return 0;
    },
  },

  "crud:bind": {
    usage: "pso crud:bind <module> --to <service> [--json]",
    summary: "Bind a CRUD module of the orchestrator to the microservice that serves its resource (the <R>_SERVICE contract constant and the metadata.services of its routes, together)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const orch = config.services.find((s) => s.role === "orchestrator");
      if (!orch) throw new CliError("This workspace has no orchestrator");
      const mod = kebab(ctx.positionals[0], "module name");
      const to = kebab(str(ctx.flags["to"]), "service name (--to)");
      if (!config.services.some((s) => s.name === to && s.role !== "orchestrator")) throw new CliError(`"${to}" is not a service of this workspace`, `Known: ${config.services.filter((s) => s.role !== "orchestrator").map((s) => s.name).join(", ")}`);
      const m = crudModules(join(root, ...orch.path.split("/"))).find((x) => x.module === mod);
      if (!m) throw new CliError(`Module "${mod}" is not a CRUD module (no contracts/*.contract.ts with a *_SERVICE binding)`);
      const pre = (name: string) => { const d = config.services.find((s) => s.name === name); const p = d ? servicePrefix(d) : derivePrefix(name); return p === "/" ? "" : p; };
      const changed = bindModule(m, to, { from: pre(m.service), to: pre(to) });
      emit(ctx, { module: mod, from: m.service, to, changed }, changed.length ? `module "${mod}": ${m.service} -> ${to} (${changed.length} file(s))` : `module "${mod}" is already bound to ${to}`);
      return 0;
    },
  },

  "make:mapper": {
    usage: "pso make:mapper <module> <name> [--service <orchestrator>] [--dry-run] [--json]   (Spring: pso make:mapper <name> --service <svc> [--dry-run] [--force] [--json])",
    summary: "Generate a mapper. Orchestrator (modular): a mapping function in modules/<module>/mappers/; Spring: a mapper component (layered: application/mapper)",
    run(ctx) {
      const p = resolveProject(ctx);
      if (p.runtime !== "node") return make("mapper").run(ctx);
      const mod = kebab(ctx.positionals[0], "module name"), name = kebab(ctx.positionals[1], "mapper name");
      requireModule(p.root, mod);
      const P = modulePaths(p.root);
      if (!P.modular) throw new CliError("Mappers have their own directory in the modular structure only", "In a 0.1 orchestrator write the function next to the controller");
      const rel = P.mapper(mod, name);
      if (reader(p.root, emptyPlan())(rel) !== undefined) throw new CliError(`${rel} already exists`, "Existing code is never overwritten");
      const plan = emptyPlan();
      plan.create[rel] = `/**\n * Mapper "${name}": converts what a microservice returns into what this API publishes. Copy only the fields of the public contract,\n * so nothing internal leaks by accident.\n */\nexport function to${pascal(name)}Response(record: { id: string }): { id: string } {\n  return { id: record.id };\n}\n`;
      return runPlan(ctx, p.root, plan);
    },
  },

  "make:contract": {
    usage: "pso make:contract <module> <name> [--service <orchestrator>] [--dry-run] [--json] | pso make:contract <name> [--route /path] [--method GET] [--service <name>] [--dry-run] [--force] [--json]",
    summary: "Generate a contract. With a module (modular orchestrator): TypeScript types of a microservice API in modules/<module>/contracts/; without: a JSON service contract (src/.app/contracts/, 0.1: src/contracts/)",
    run(ctx) {
      if (ctx.positionals.length < 2) return make("contract").run(ctx);
      const p = resolveProject(ctx);
      if (p.runtime !== "node") throw new CliError("The module form of make:contract applies to the orchestrator");
      const mod = kebab(ctx.positionals[0], "module name"), name = kebab(ctx.positionals[1], "contract name");
      requireModule(p.root, mod);
      const P = modulePaths(p.root);
      if (!P.modular) throw new CliError("Module contracts exist in the modular structure", "In a 0.1 orchestrator use pso make:contract <name> (JSON)");
      const rel = P.contract(mod, name);
      if (reader(p.root, emptyPlan())(rel) !== undefined) throw new CliError(`${rel} already exists`, "Existing code is never overwritten");
      const plan = emptyPlan();
      plan.create[rel] = `/** The API of the microservice this module calls for "${name}": the shapes it answers and accepts (no runtime code). */\nexport interface ${pascal(name)}Record {\n  id: string;\n}\n\nexport type ${pascal(name)}Id = ${pascal(name)}Record["id"];\nexport const ${camel(name)}Fields = ["id"] as const;\n`;
      return runPlan(ctx, p.root, plan);
    },
  },

  "structure:inspect": {
    usage: "pso structure:inspect [--service <name>] [--json]",
    summary: "Show the workspace layout (standard, or flat with the plan to move its projects into orchestrators/, services/, frontends/ and frontends/modules/), the structural convention of each project (modular / layered / 0.1), mixed or contradictory structures, and for a 0.1 project the migration plan: every file to move, the imports, route declarations, module registrations and Java package declarations it affects. Read-only: nothing is moved",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const only = str(ctx.flags["service"]);
      const targets = config.services.filter((s) => !only || s.name === only);
      if (only && !targets.length) throw new CliError(`Unknown service "${only}"`);
      const reports = targets.map((s) => structurePlan(join(root, ...s.path.split("/")), s));
      const lines: string[] = [];
      // the workspace level: where the projects are (inspection only; PSO never moves a project directory)
      const layout = workspaceLayout(config, root); const moves = layoutMoves(config);
      lines.push(`workspace layout: ${layout}${layout === "standard" ? " (orchestrators/, services/, frontends/, frontends/modules/)" : " (0.1: projects outside the standard directories; still supported)"}`);
      if (moves.length) {
        lines.push("  plan to the standard layout (inspection only: nothing is moved):");
        for (const m of moves) lines.push(`    move    ${m.from}  ->  ${m.to}   (${m.kind})`);
        lines.push(`    update  pso.workspace.json: the "path" of ${moves.length} project(s)`, "    then    pso infra:apply (regenerates the compose files and environments from the new paths), pso validate", "  Stop running processes first (pso dev, pso docker:down), commit, move the directories, edit the paths, then validate.");
      }
      if (!existsSync(join(root, WORKSPACE_DIRS.infra))) lines.push(`  note: ${WORKSPACE_DIRS.infra}/ does not exist yet; pso infra:init creates it`);
      for (const r of reports) {
        lines.push(`${r.service} (${r.runtime}): ${r.structure}${r.source === "default" ? " (no marker yet: the official structure)" : ""}${r.problems.length ? "  MIXED" : ""}`);
        for (const p of r.problems) lines.push(`  problem: ${p}`);
        if (r.moves.length) {
          lines.push(`  migration plan to the ${r.target} structure (inspection only: nothing is moved):`);
          for (const m of r.moves) lines.push(`    move    ${m.from}  ->  ${m.to}${m.note ? `   (${m.note})` : ""}`);
          for (const f of r.references) lines.push(`    update  ${f.file}: ${f.what}`);
          if (r.manual.length) for (const m of r.manual) lines.push(`    manual  ${m}`);
          lines.push(`  ${r.moves.length} file(s) to move, ${r.references.length} file(s) whose imports, package declarations or registrations change. Back up first (commit), move, then pso validate and the project's tests.`);
        }
      }
      emit(ctx, { layout, layoutMoves: moves, projects: reports }, lines.join("\n"));
      return reports.some((r) => r.problems.length) ? 1 : 0;
    },
  },
};

