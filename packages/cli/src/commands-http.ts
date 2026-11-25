import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatDiagnostic, findWorkspaceRoot, loadWorkspace, NAME_PATTERNS, type Diagnostic } from "@pso/core";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { pascal } from "./templates.ts";
import { emit, make, resolveProject, type Command, type Ctx } from "./commands.ts";
import { analyzeOrchestrator } from "./http-static.ts";
import { addController, addProvider, addRoute, applyPlan, classify, dtoSource, emptyPlan, ensureModule, modulePaths, type Plan } from "./http-gen.ts";
import { orchestratorStructure } from "./project-structure.ts";

const dry = (ctx: Ctx) => ctx.flags["dry-run"] === true;
const key = (d: Diagnostic) => `${d.code}|${d.file ?? ""}|${d.message}`;

/**
 * Applies a plan transactionally and re-validates the whole orchestrator. If the change introduces any diagnostic
 * that did not exist before, everything is rolled back: generators can never leave the three declarations inconsistent.
 */
export function runPlan(ctx: Ctx, root: string, fullPlan: Plan): number {
  const { rows, plan } = classify(root, fullPlan);
  const before = new Set(analyzeOrchestrator(root).diagnostics.map(key));
  if (dry(ctx)) { emit(ctx, { dryRun: true, files: rows }, rows.map((r) => `[dry-run] ${r.action.padEnd(8)} ${r.path}`).join("\n") || "(nothing to do)"); return 0; }
  const applied = applyPlan(root, plan);
  const introduced = analyzeOrchestrator(root).diagnostics.filter((d) => d.severity === "error" && !before.has(key(d)));
  if (introduced.length) {
    applied.rollback();
    throw new CliError(`The change would leave the module inconsistent and was rolled back:\n${introduced.map(formatDiagnostic).join("\n")}`);
  }
  emit(ctx, { dryRun: false, files: rows }, rows.map((r) => `${r.action.padEnd(8)} ${r.path}`).join("\n") || "(nothing to do)");
  return 0;
}

function orchestrator(ctx: Ctx) {
  const p = resolveProject(ctx);
  if (p.runtime !== "node") throw new CliError("This command generates orchestrator (Node.js) code", "Run it in the orchestrator project or pass --service <orchestrator>");
  return p;
}

const need = (ctx: Ctx, i: number, what: string): string => {
  const v = ctx.positionals[i];
  if (!v) throw new CliError(`Missing ${what}`);
  if (!NAME_PATTERNS.kebab.test(v)) throw new CliError(`Invalid ${what} "${v}"`, "Use kebab-case, e.g. customer-orders");
  return v;
};
export const requireModule = (root: string, mod: string) => {
  if (!existsSync(join(root, modulePaths(root).module(mod)))) throw new CliError(`Module "${mod}" does not exist`, `Run \`pso make:module ${mod}\` first`);
};

/**
 * Wraps the generic generator: Spring projects keep their behaviour, orchestrators use the module-aware handler. The two forms take
 * different options; one that belongs to the other form is refused (it would otherwise be ignored without a word).
 */
const aware = (kind: string, node: (ctx: Ctx, root: string) => number, usage: string, only: { node?: string[]; spring?: string[] } = {}): Command => {
  const generic = make(kind);
  return {
    usage, summary: `Generate a ${kind} (orchestrator: inside a module; Spring: hexagonal layout)`,
    run(ctx) {
      const p = resolveProject(ctx);
      const foreign = (p.runtime === "node" ? only.spring : only.node)?.filter((f) => ctx.flags[f] !== undefined) ?? [];
      if (foreign.length) throw new CliError(`${foreign.map((f) => `--${f}`).join(", ")} ${foreign.length > 1 ? "do" : "does"} not apply to ${p.runtime === "node" ? "the orchestrator" : "a Spring Boot service"}`, `Usage: ${usage}`, 2);
      return p.runtime === "node" ? node(ctx, p.root) : generic.run(ctx);
    },
  };
};

export const HTTP_COMMANDS: Record<string, Command> = {
  "make:module": {
    usage: "pso make:module <name> [--service <orchestrator>] [--dry-run] [--json]",
    summary: "Create an HTTP module: MODULE.pso.ts + an empty ROUTES.pso.ts (no endpoint is exposed yet)",
    run(ctx) {
      const { root } = orchestrator(ctx);
      const mod = need(ctx, 0, "module name");
      if (mod === "health") throw new CliError('"health" is reserved by the framework');
      if (existsSync(join(root, modulePaths(root).module(mod)))) throw new CliError(`Module "${mod}" already exists`);
      const plan = emptyPlan();
      ensureModule(root, plan, mod);
      return runPlan(ctx, root, plan);
    },
  },

  "make:controller": aware("controller", (ctx, root) => {
    const mod = need(ctx, 0, "module name");
    requireModule(root, mod);
    const base = ctx.positionals[1] ? need(ctx, 1, "controller name") : mod;
    const plan = emptyPlan();
    addController(root, plan, mod, base, str(ctx.flags["prefix"]) ?? `/${base}`);
    return runPlan(ctx, root, plan);
  }, "pso make:controller <module> [name] [--prefix /path] [--service <orchestrator>] [--dry-run] [--json]   (Spring: pso make:controller <name> --service <svc> [--route /path] [--method GET] [--dry-run] [--force] [--json])", { node: ["prefix"], spring: ["route", "method", "force"] }),

  "make:service": aware("service", (ctx, root) => {
    const mod = need(ctx, 0, "module name");
    requireModule(root, mod);
    const plan = emptyPlan();
    addProvider(root, plan, mod, ctx.positionals[1] ? need(ctx, 1, "service name") : mod, ctx.flags["export"] === true);
    return runPlan(ctx, root, plan);
  }, "pso make:service <module> [name] [--export] [--service <orchestrator>] [--dry-run] [--json]   (Spring: pso make:service <name> --service <svc> [--dry-run] [--force] [--json])", { node: ["export"], spring: ["force"] }),

  "make:dto": aware("dto", (ctx, root) => {
    const mod = need(ctx, 0, "module name");
    requireModule(root, mod);
    const name = need(ctx, 1, "dto name");
    const plan = emptyPlan();
    // modular: dto/request/ by default, dto/response/ with --response; 0.1: dto/
    const rel = modulePaths(root).dto(mod, name, ctx.flags["response"] === true ? "response" : "request");
    if (existsSync(join(root, rel))) throw new CliError(`${rel} already exists`);
    plan.create[rel] = dtoSource(`${pascal(name)}Dto`, str(ctx.flags["fields"]));
    return runPlan(ctx, root, plan);
  }, "pso make:dto <module> <name> [--response] [--fields \"name:string:min=3,email:email,age?:integer:min=18,document:file:mime=application/pdf:size=10MB\"]   [--service <orchestrator>] [--dry-run] [--json]   (Spring: pso make:dto <name> --service <svc> [--dry-run] [--force] [--json])", { node: ["fields"], spring: ["force"] }),

  "make:guard": aware("guard", (ctx, root) => {
    const first = need(ctx, 0, "name");
    const local = ctx.positionals[1] !== undefined;
    const { layout } = orchestratorStructure(root);
    const rel = local ? `${modulePaths(root).dir(first)}/guards/${need(ctx, 1, "guard name")}.guard.ts` : `src/${layout.component("guards")}/${first}.guard.ts`;
    if (local) requireModule(root, first);
    const res = writeFiles(root, { [rel]: `import type { Guard } from "@pso/http";\n\n// Deny by default: replace with real verification.\nconst guard: Guard = () => false;\nexport default guard;\n` }, { dryRun: dry(ctx), force: ctx.flags["force"] === true });
    emit(ctx, { dryRun: dry(ctx), files: res }, res.map((r) => `${dry(ctx) ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`).join("\n"));
    return res.some((r) => r.action === "conflict") ? 1 : 0;
  }, "pso make:guard <name> | <module> <name> [--service <name>] [--dry-run] [--force] [--json]   (application-wide in src/.app/guards/ (0.1: src/guards/); the module form creates <module>/guards/<name>.guard.ts)"),

  "make:route": {
    usage: "pso make:route <module> <action> --method GET --path / [--service <orchestrator>] [--controller name] [--public | --guard jwt --scopes a,b] [--upstream <service> | --compose <service,service>] [--dto <name>] [--download [--max-download 100MB]] [--dry-run] [--json]",
    summary: "Add a decorated controller action AND its ROUTES.pso.ts declaration, kept consistent (rolled back if validation fails). With --upstream the action forwards the request to one service; with --compose it gets the UpstreamClient and the route declares the services it may call to build its response. With --upstream and --dto the body is validated at the gateway and then forwarded unchanged; a DTO with file fields generates an upload (forwardUpload); --download a streamed file download (forwardDownload)",
    next: "`pso validate` and `pso routes:list`",
    run(ctx) {
      const { root } = orchestrator(ctx);
      const mod = need(ctx, 0, "module name");
      const action = ctx.positionals[1];
      if (!action) throw new CliError("Missing action name", "e.g. pso make:route users findAll --method GET --path /");
      const scopes = (str(ctx.flags["scopes"]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (scopes.some((s) => !/^[A-Za-z0-9:._-]+$/.test(s))) throw new CliError("Invalid scope name");
      // an authorization flag that cannot take effect is an error, never a route that is more open than it was asked to be
      if (ctx.flags["public"] === true && (ctx.flags["guard"] !== undefined || scopes.length)) throw new CliError("--public cannot be combined with --guard or --scopes", "A public route has no authorization policy; choose one", 2);
      const plan = emptyPlan();
      const ctl = str(ctx.flags["controller"]);
      const guard = str(ctx.flags["guard"]);
      const upstream = str(ctx.flags["upstream"]);
      const dtoFlag = str(ctx.flags["dto"]);
      const compose = (str(ctx.flags["compose"]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      // a service that is not registered can never be called: say so now instead of at start-up
      const wsRoot = findWorkspaceRoot(ctx.cwd);
      const known = wsRoot ? loadWorkspace(wsRoot).config?.services.filter((s) => s.role !== "orchestrator").map((s) => s.name) : undefined;
      for (const name of [...compose, ...(upstream ? [upstream] : [])]) if (known && !known.includes(name)) throw new CliError(`"${name}" is not a service of this workspace`, `Known: ${known.join(", ") || "(none)"}. Register it with \`pso create service\` or \`pso services:register\``);
      addRoute(root, plan, {
        mod, action, method: (str(ctx.flags["method"]) ?? "GET").toUpperCase(), path: str(ctx.flags["path"]) ?? "/",
        ...(ctl ? { controller: ctl } : {}), ...(ctx.flags["public"] === true ? { public: true } : {}), ...(guard ? { guard } : {}), ...(scopes.length ? { scopes } : {}), ...(upstream ? { service: upstream } : {}), ...(dtoFlag ? { dto: dtoFlag } : {}), ...(compose.length ? { services: compose } : {}),
        ...(ctx.flags["download"] === true ? { download: true } : {}), ...(str(ctx.flags["max-download"]) ? { maxDownload: str(ctx.flags["max-download"])! } : {}),
      });
      return runPlan(ctx, root, plan);
    },
  },
};
