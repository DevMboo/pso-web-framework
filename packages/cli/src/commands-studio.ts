import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { discover, loadWorkspace, validateWorkspaceShape, topoOrder, WORKSPACE_FILE, hasErrors, formatDiagnostic, type ServiceDecl, type WorkspaceConfig } from "@pso/core";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, kebabName, type Command, type Ctx } from "./commands.ts";
import { startStudio } from "./studio.ts";
import { buildSite, serveSite } from "./portal/build.ts";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { CLI_VERSION } from "./portal/content.ts";
import { routeRows } from "./http-static.ts";
import { orchestratorComponentDir, orchestratorModulesDir } from "./project-structure.ts";

function openBrowser(url: string, ctx: Ctx): void {
  if (ctx.flags["no-open"] === true || process.env["PSO_NO_BROWSER"]) return;
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* the URL is printed anyway */ }
}

function untilSignal(stop: () => Promise<void>, ctx: Ctx): Promise<void> {
  return new Promise((done) => {
    let stopping = false;
    const h = () => { if (stopping) return; stopping = true; ctx.print("\nstopping..."); stop().then(done, done); };
    process.once("SIGINT", h); process.once("SIGTERM", h);
  });
}

const rowsOf = (root: string, ws: WorkspaceConfig) => {
  const orch = ws.services.find((s) => s.role === "orchestrator");
  if (!orch) throw new CliError("No orchestrator in this workspace");
  // a route forwards to `service`, or (an action route) calls the services its metadata declares: the first is its target
  return routeRows(join(root, ...orch.path.split("/"))).map((r) => ({ ...r, service: r.service || r.services[0] || "", file: `${orch.path}/${r.file}`, guard: r.guard }));
};

export const STUDIO_COMMANDS: Record<string, Command> = {
  "studio": {
    usage: "pso studio [--port N] [--no-open] [--remote] [--frontend-ops] [--ops]",
    summary: "Open the local developer dashboard (live services, graph, routes, config, security, logs)",
    async run(ctx) {
      const { root } = requireWorkspace(ctx);
      const remote = ctx.flags["remote"] === true, frontendOps = ctx.flags["frontend-ops"] === true, infraOps = ctx.flags["ops"] === true;
      const s = await startStudio({ root, port: Number(str(ctx.flags["port"]) ?? 0), remote, frontendOps, ops: infraOps });
      ctx.print(`PSO Studio (${[remote ? "remote management ENABLED: deployments and credentials can be managed from this page" : "", frontendOps ? "frontend operations ENABLED: validate, build, development servers, local publish and rollback" : "", infraOps ? "infrastructure operations ENABLED: provision, repair, rotate, start and stop containers (each needs a typed confirmation)" : ""].filter(Boolean).join("; ") || "read-only"}, loopback only)\n  ${s.url}\nThe URL contains a one-time access token; do not share it. Press Ctrl+C to stop.`);
      openBrowser(s.url, ctx);
      await untilSignal(s.close, ctx);
      return 0;
    },
  },

  "docs": {
    usage: "pso docs [--port N] [--no-open] [--repository <https-url>] | pso docs --build <dir> [--repository <https-url>] [--json]",
    summary: "Serve the documentation portal locally, or write the complete static site (search, llms.txt, AI context) with --build",
    async run(ctx) {
      const { ALL_COMMANDS } = await import("./registry.ts");
      const repo = str(ctx.flags["repository"]);
      if (repo && !/^https:\/\//.test(repo)) throw new CliError("--repository must be an https URL");
      const opts = repo ? { repository: repo } : {};
      const out = str(ctx.flags["build"]);
      if (out) {
        const dir = resolve(ctx.cwd, out);
        const r = buildSite(dir, ALL_COMMANDS, opts);
        emit(ctx, { directory: dir, version: r.version, pages: r.pages.length, files: r.files.length }, `wrote ${r.pages.length} pages and ${r.files.length} files (version ${r.version}) to ${dir}`);
        return 0;
      }
      const dir = join(tmpdir(), `pso-docs-${CLI_VERSION}-${process.pid}`);
      buildSite(dir, ALL_COMMANDS, opts);
      const d = await serveSite(dir, Number(str(ctx.flags["port"]) ?? 0));
      ctx.print(`Documentation ${CLI_VERSION}: ${d.url}
Press Ctrl+C to stop.`);
      openBrowser(d.url, ctx);
      await untilSignal(async () => { await d.close(); rmSync(dir, { recursive: true, force: true }); }, ctx);
      return 0;
    },
  },

  "graph": {
    usage: "pso graph [--mermaid] [--json]",
    summary: "Show service dependencies and orchestrator routes together",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const deps = config.services.flatMap((s) => (s.dependsOn ?? []).map((d) => ({ from: s.name, to: d, kind: "depends-on" })));
      const orch = config.services.find((s) => s.role === "orchestrator");
      const routes = orch ? rowsOf(root, config).map((r) => ({ from: orch.name, to: r.service, kind: "route", label: `${r.method} ${r.path}` })) : [];
      const order = topoOrder(new Map(config.services.map((s) => [s.name, s.dependsOn ?? []] as [string, string[]])));
      if (ctx.flags["mermaid"] === true) {
        const id = (n: string) => n.replace(/-/g, "_");
        ctx.print(["graph LR", ...deps.map((e) => `  ${id(e.from)} -->|depends on| ${id(e.to)}`), ...routes.filter((e) => e.to).map((e) => `  ${id(e.from)} -.->|${e.label}| ${id(e.to)}`)].join("\n"));
      } else emit(ctx, { nodes: config.services.map((s) => s.name), dependencies: deps, routes, startupOrder: order }, [`startup order: ${order.join(" -> ")}`, ...deps.map((e) => `${e.from} depends on ${e.to}`), ...routes.map((e) => `${e.from} routes ${e.label} -> ${e.to || "(answered by the orchestrator)"}`)].join("\n"));
      return 0;
    },
  },

  "routes:inspect": {
    usage: "pso routes:inspect <id-or-path> [--json]",
    summary: "Show one orchestrator route in full: target, access policy, contract and the service-side handler",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const q = ctx.positionals[0];
      const all = rowsOf(root, config);
      const r = all.find((x) => x.id === q) ?? all.find((x) => x.path === q && x.method === "GET") ?? all.find((x) => x.path === q || x.module === q);
      if (!r) throw new CliError(`No route "${q ?? ""}"`, "Use a route id or exact path; see `pso routes:list`");
      const svc = config.services.find((s) => s.name === r.service);
      const contractFile = join(orchestratorComponentDir(join(root, ...(config.services.find((s) => s.role === "orchestrator")!.path.split("/"))), "contracts"), `${r.module}.contract.json`);
      const orchRoot = join(root, ...(config.services.find((s) => s.role === "orchestrator")!.path.split("/")));
      const moduleContracts = join(orchestratorModulesDir(orchRoot), r.module, "contracts"); // a module's typed contract (modular structure)
      const typed = existsSync(moduleContracts) ? readdirSync(moduleContracts).filter((f) => f.endsWith(".contract.ts")) : [];
      const contract = existsSync(contractFile) ? (JSON.parse(readFileSync(contractFile, "utf8")) as unknown) : typed.length ? { typed: typed.map((f) => `${relative(root, join(moduleContracts, f)).split(sep).join("/")}`) } : null;
      const handlers = svc && svc.runtime === "spring-boot" ? discover(join(root, ...svc.path.split("/")), "spring-boot").resources.filter((x) => x.kind === "controller").map((x) => x.file).filter((f) => {
        // the exact path (a forwarding route), or the class mapping of its first segment (a layered controller: @RequestMapping("/products") + "/{id}")
        const src = readFileSync(join(root, ...svc.path.split("/"), ...f.split("/")), "utf8");
        const first = r.path.split("/").filter(Boolean)[0];
        return src.includes(`"${r.path}"`) || (first !== undefined && !first.startsWith(":") && new RegExp(`@RequestMapping\\(\\s*(?:value\\s*=\\s*|path\\s*=\\s*)?"/${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(src));
      }) : [];
      const data = { ...r, serviceDeclared: !!svc, servicePort: svc?.port ?? null, contract, handlers: handlers.map((h) => `${svc!.path}/${h}`) };
      emit(ctx, data, [`${r.method} ${r.path}  ->  ${r.service}${svc ? `:${svc.port}` : " (UNDECLARED)"}${r.upstream !== r.path ? ` ${r.upstream}` : ""}`, `access:   ${r.public ? "public" : `guard ${r.guard ?? "(none: denied)"}`}${r.scopes.length ? `, scopes ${r.scopes.join(", ")}` : ""}`, `defined:  ${r.file}`, `contract: ${contract ? ((contract as { typed?: string[] }).typed ? `typed (${(contract as { typed: string[] }).typed.join(", ")})` : "present") : "none"}`, `handlers: ${data.handlers.join(", ") || "none found"}`].join("\n"));
      return 0;
    },
  },

  "init": {
    usage: "pso init [--dry-run] [--force] [--json]",
    summary: "Create pso.workspace.json in the current directory from the Node/Spring projects found in it",
    run(ctx) {
      const root = resolve(ctx.cwd);
      const file = join(root, WORKSPACE_FILE);
      if (existsSync(file) && ctx.flags["force"] !== true) throw new CliError(`${WORKSPACE_FILE} already exists`, "Use --force to regenerate it (existing declarations would be replaced)");
      const found: ServiceDecl[] = [];
      let nextSvc = 8081;
      for (const d of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const n = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(n)) continue;
        if (existsSync(join(root, d.name, "pom.xml"))) found.push({ name: n, path: d.name, runtime: "spring-boot", role: "service", port: nextSvc++, health: "/actuator/health" });
        else if (existsSync(join(root, d.name, "package.json")) && existsSync(join(root, d.name, "src", "main.ts"))) found.push({ name: n, path: d.name, runtime: "node", role: "orchestrator", port: 3000, health: "/health/ready" });
      }
      const orchs = found.filter((s) => s.role === "orchestrator");
      if (orchs.length > 1) for (const o of orchs.slice(1)) { o.role = "service"; o.port = nextSvc++; }
      const name = root.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
      const cfg: WorkspaceConfig = { schemaVersion: 1, name: /^[a-z]/.test(name) ? name : `w-${name}`, services: found };
      const ds = validateWorkspaceShape(cfg);
      if (hasErrors(ds)) throw new CliError(ds.map(formatDiagnostic).join("\n"));
      if (ctx.flags["dry-run"] !== true) writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
      emit(ctx, { dryRun: ctx.flags["dry-run"] === true, workspace: cfg }, `${ctx.flags["dry-run"] === true ? "[dry-run] " : ""}${WORKSPACE_FILE}: ${found.length} project(s) found${found.map((s) => `\n  ${s.name} (${s.runtime}, ${s.role}) :${s.port}`).join("")}`);
      return 0;
    },
  },
};

export { kebabName, loadWorkspace };
