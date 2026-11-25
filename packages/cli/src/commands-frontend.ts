import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import { formatDiagnostic, hasErrors, projectPath, type FrontendDecl, type WorkspaceConfig } from "@pso/core";
import { BUILTIN_MIDDLEWARES, DEFAULT_FEI_PORT, DEFAULT_MEI_PORT, flattenRoutes } from "@pso/frontend";
import {
  FEI_FILE, MEI_FILE, ROUTES_FILE, TOOLCHAIN, buildGraph, buildFeiManifest, buildRemoteManifest, freePort, generateProject, loadFrontends, readDecl, renderTree, validateEcosystem,
  feiOf, type EcosystemReport, type LoadedFei, type LoadedFrontends,
} from "@pso/frontend/node";
import { type Command, type Ctx, emit, kebabName, reportWrites, requireWorkspace, saveWorkspace } from "./commands.ts";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { npmInvocation } from "./proc.ts";
import { camel, pascal, renderTemplate } from "./templates.ts";
import { vendorFramework } from "./vendor.ts";
import { CONTRACT_FILE, buildContract, contractVersionOf } from "./frontend-contracts.ts";
import { INFRA_HOOKS, engine, reconcileAfter } from "./commands-infra.ts";
import { plan } from "@pso/infra";
import { releaseSigningFromFlags, withReleaseKey } from "./frontend-signing.ts";

/**
 * FEI / MEI: the distributed frontend of a workspace. Projects live under `frontends/` (FEIs) and `frontends/modules/` (MEIs) in the standard layout, `frontend/` in a flat 0.1 workspace, and are declared in pso.workspace.json
 * (`frontends`), and their contracts in FEI.pso.ts / MEI.pso.ts / ROUTES.pso.ts (read statically, never executed).
 */
const GITIGNORE = "node_modules\ndist\n.pso/generated\n.env\n";

const vars = (extra: Record<string, string | number>): Record<string, string | number> => ({
  mf: TOOLCHAIN["@module-federation/enhanced"], react: TOOLCHAIN.react, router: TOOLCHAIN["react-router-dom"], icons: TOOLCHAIN["react-icons"],
  rspack: TOOLCHAIN["@rspack/core"], devServer: TOOLCHAIN["@rspack/dev-server"], tailwind: TOOLCHAIN.tailwindcss, cssLoader: TOOLCHAIN["css-loader"], postcss: TOOLCHAIN.postcss,
  postcssLoader: TOOLCHAIN["postcss-loader"], typescript: TOOLCHAIN.typescript, typesReact: TOOLCHAIN["@types/react"], typesReactDom: TOOLCHAIN["@types/react-dom"], ...extra,
});

const withPrefix = (raw: string, prefix: "fei" | "mei"): string => kebabName(raw.startsWith(`${prefix}-`) ? raw : `${prefix}-${raw}`, prefix === "fei" ? "FEI" : "MEI");
const frontends = (c: WorkspaceConfig): FrontendDecl[] => c.frontends ?? [];

function loadAll(root: string, c: WorkspaceConfig): LoadedFrontends { return loadFrontends(root, frontends(c)); }
function report(root: string, c: WorkspaceConfig): { loaded: LoadedFrontends; eco: EcosystemReport } {
  const loaded = loadAll(root, c);
  const eco = validateEcosystem(root, loaded);
  // a MEI must not create its own history: that would fight the FEI over the URL
  for (const m of loaded.meis) {
    const src = join(m.project.dir, "src");
    for (const f of existsSync(src) ? walk(src) : []) {
      if (!/\.(tsx?|jsx?)$/.test(f)) continue;
      const text = readFileSync(f, "utf8");
      const hit = /\b(BrowserRouter|HashRouter|MemoryRouter|createBrowserRouter|createHashRouter|createMemoryRouter|RouterProvider)\b/.exec(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""));
      if (hit) eco.diagnostics.push({ code: "PSO_MEI_OWN_ROUTER", severity: "error", message: `${m.project.name}: ${f.slice(root.length + 1).replace(/\\/g, "/")} uses ${hit[1]}: a microfrontend renders inside the router of its host and must not create its own history`, file: `${m.project.path}/src`, hint: "Use <Routes>/<Route>, useNavigate and useParams only; navigation to other microfrontends goes through usePsoContext().navigate" });
      if (/\bfetch\s*\(\s*["'`]https?:/.test(text)) eco.diagnostics.push({ code: "PSO_MEI_DIRECT_URL", severity: "error", message: `${m.project.name}: ${f.slice(root.length + 1).replace(/\\/g, "/")} calls an absolute URL with fetch: backend calls go through usePsoContext().api (orchestrator only)`, file: `${m.project.path}/src` });
    }
  }
  const orch = c.services.find((s) => s.role === "orchestrator");
  for (const fei of loaded.feis) {
    if (orch && fei.definition.orchestrator.service !== orch.name) eco.diagnostics.push({ code: "PSO_FEI_ORCHESTRATOR_UNKNOWN", severity: "error", message: `${fei.project.name}: ${FEI_FILE} names orchestrator "${fei.definition.orchestrator.service}" but the workspace's orchestrator is "${orch.name}"`, file: `${fei.project.path}/${FEI_FILE}` });
    if (!orch) eco.diagnostics.push({ code: "PSO_FEI_ORCHESTRATOR_MISSING", severity: "error", message: `${fei.project.name} talks to orchestrator "${fei.definition.orchestrator.service}" but this workspace has none`, file: `${fei.project.path}/${FEI_FILE}`, hint: "Create it: pso create orchestrator <name>" });
  }
  // typed contracts: a project's generated copy must match the orchestrator it talks to
  if (orch) {
    try {
      const current = buildContract(root, c).version;
      for (const f of frontends(c)) {
        const file = join(root, ...f.path.split("/"), ...CONTRACT_FILE.split("/"));
        const have = existsSync(file) ? contractVersionOf(readFileSync(file, "utf8")) : undefined;
        if (have !== undefined && have !== current) eco.diagnostics.push({ code: "PSO_FRONTEND_CONTRACT_STALE", severity: "warning", message: `${f.name}: ${CONTRACT_FILE} is from orchestrator contract ${have}, the orchestrator is now at ${current}`, file: `${f.path}/${CONTRACT_FILE}`, hint: "Run: pso frontend:contracts" });
      }
    } catch { /* the orchestrator's own validation reports its problems */ }
  }
  const seen = new Set<string>();
  eco.diagnostics = eco.diagnostics.filter((d) => { const k = `${d.code}|${d.file}|${d.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { loaded, eco };
}
function walk(dir: string): string[] { const out: string[] = []; for (const n of readdirSync(dir)) { const p = join(dir, n); if (n === "node_modules") continue; if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }

/** `pso validate` calls this: the frontend diagnostics of the workspace, [] when there is no frontend. */
export function frontendDiagnostics(root: string, c: WorkspaceConfig): EcosystemReport["diagnostics"] {
  if (frontends(c).length === 0) return [];
  return report(root, c).eco.diagnostics.map((d) => ({ ...d }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// source updates (literal data edited through the AST, everything else preserved byte for byte)

function arrayOf(sf: ts.SourceFile, prop: string): ts.ArrayLiteralExpression | undefined {
  let found: ts.ArrayLiteralExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === prop && ts.isArrayLiteralExpression(n.initializer)) { found = n.initializer; return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
const parseTs = (text: string): ts.SourceFile => ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);

export function appendToArray(text: string, prop: string, element: string): string {
  const arr = arrayOf(parseTs(text), prop);
  if (!arr) throw new CliError(`"${prop}" array not found: the file was changed by hand in a way PSO cannot edit`, `Add the entry manually or restore \`${prop}: []\``);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const body = element.split("\n").map((l) => `    ${l}`).join(nl);
  if (arr.elements.length === 0) return text.slice(0, arr.getStart()) + `[${nl}${body},${nl}  ]` + text.slice(arr.getEnd());
  const last = arr.elements[arr.elements.length - 1]!;
  return text.slice(0, last.getEnd()) + `,${nl}${body}` + text.slice(last.getEnd());
}
export function removeFromArray(text: string, prop: string, pred: (el: ts.Expression) => boolean): { text: string; removed: boolean } {
  const arr = arrayOf(parseTs(text), prop);
  if (!arr) return { text, removed: false };
  const idx = arr.elements.findIndex(pred);
  if (idx < 0) return { text, removed: false };
  const el = arr.elements[idx]!;
  let start = el.getFullStart(), end = el.getEnd();
  if (text[end] === ",") end++; else if (idx > 0) start = arr.elements[idx - 1]!.getEnd();
  const out = text.slice(0, start) + text.slice(end);
  return { text: out.replace(/\[\s*,?\s*\]/, "[]"), removed: true };
}
const nameOf = (el: ts.Expression): string | undefined => { if (!ts.isObjectLiteralExpression(el)) return undefined; for (const p of el.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "name" && ts.isStringLiteralLike(p.initializer)) return p.initializer.text; return undefined; };
const pathOf = (el: ts.Expression): string | undefined => { if (!ts.isObjectLiteralExpression(el)) return undefined; for (const p of el.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "path" && ts.isStringLiteralLike(p.initializer)) return p.initializer.text; return undefined; };

// ---------------------------------------------------------------------------------------------------------------------------------
// create

function projectDir(root: string, d: FrontendDecl): string { return resolve(root, ...d.path.split("/")); }

export async function createFrontend(ctx: Ctx, kind: "fei" | "mei"): Promise<number> {
  const { root, config } = requireWorkspace(ctx);
  const rawName = ctx.positionals[1];
  if (!rawName) throw new CliError(`Missing ${kind.toUpperCase()} name`, `Example: pso create ${kind} ${kind === "fei" ? "commerce" : "customers"}`);
  const name = withPrefix(rawName, kind);
  const domain = name.replace(/^(fei|mei)-/, "");
  const all = frontends(config);
  if (all.some((f) => f.name === name) || config.services.some((s) => s.name === name)) throw new CliError(`A project named "${name}" already exists in this workspace`);
  const orch = config.services.find((s) => s.role === "orchestrator");
  if (!orch) throw new CliError("This workspace has no orchestrator", "Create one first: pso create orchestrator <name>. Frontends talk only to the orchestrator");
  const shells = all.filter((f) => f.kind === "fei");
  const hostFlag = str(ctx.flags["host"]);
  const host = kind === "mei" ? (hostFlag !== undefined ? withPrefix(hostFlag, "fei") : shells.length === 1 ? shells[0]!.name : undefined) : undefined;
  if (kind === "mei" && !host) throw new CliError(shells.length ? `This workspace has ${shells.length} FEIs: say which one hosts the microfrontend` : "This workspace has no FEI to host the microfrontend", shells.length ? `Pass --host <fei>: ${shells.map((s) => s.name).join(", ")}` : "Create the shell first (pso create fei <name>) or pass --host <fei-name>");
  if (kind === "mei" && shells.length && !shells.some((s) => s.name === host)) throw new CliError(`--host "${host}" is not a FEI of this workspace`, `Known: ${shells.map((s) => s.name).join(", ")}`);
  const portFlag = str(ctx.flags["port"]);
  if (portFlag !== undefined && (!/^\d{4,5}$/.test(portFlag) || Number(portFlag) < 1024 || Number(portFlag) > 65535)) throw new CliError(`Invalid --port "${portFlag}"`, "Use a port between 1024 and 65535");
  const used = [...config.services.map((s) => s.port), ...all.map((f) => f.port)];
  if (portFlag !== undefined && used.includes(Number(portFlag))) throw new CliError(`Port ${portFlag} is already used by another project of this workspace`);
  const port = portFlag !== undefined ? Number(portFlag) : freePort(used, kind === "fei" ? DEFAULT_FEI_PORT : DEFAULT_MEI_PORT);
  const path = projectPath(config, kind, name, root);
  const title = pascal(domain);
  const files = renderTemplate(kind, vars({ name, title, Domain: title, domain, domainCamel: camel(domain), port, orchestrator: orch.name, host: host ?? "" }));
  files[".gitignore"] = GITIGNORE;
  const dir = join(root, ...path.split("/"));
  const dry = ctx.flags["dry-run"] === true;
  const results = writeFiles(dir, files, { dryRun: dry, force: ctx.flags["force"] === true });
  const code = reportWrites(ctx, results);
  if (code !== 0 || dry) return code;
  config.frontends = [...all, { name, kind, path, port }];
  saveWorkspace(root, config);
  ctx.print(`registered "${name}" in pso.workspace.json (port ${port})`);
  generateProject(dir);
  const v = vendorFramework(dir);
  ctx.print(`vendored ${v.packages.length} framework package(s) into ${path}/vendor/pso`);
  if (kind === "mei" && ctx.flags["register"] === true) await registerMei(ctx, root, config, name, { fei: host, ...(ctx.flags["public"] === true ? { public: true } : {}), ...(str(ctx.flags["scopes"]) ? { scopes: str(ctx.flags["scopes"]) } : {}) });
  if (ctx.flags["install"] === true) npmInstall(dir, ctx);
  await reconcileAfter(ctx, root, `creating ${kind.toUpperCase()} "${name}"`);
  ctx.print(kind === "fei"
    ? `\nnext: cd ${path} && npm install     (or re-run with --install)\n      pso create mei <domain>          then: pso fei:register <domain>\n      pso frontend:dev`
    : `\nnext: cd ${path} && npm install     (or re-run with --install)\n      pso fei:register ${domain}${ctx.flags["register"] === true ? "   (done)" : ""}\n      pso frontend:dev --standalone ${domain}     (develop it alone) or pso frontend:dev (with the shell)`);
  return 0;
}

function npmInstall(dir: string, ctx: Ctx): void {
  const inv = npmInvocation("npm", ["install", "--no-audit", "--no-fund"]);
  ctx.print(`npm install in ${dir} ...`);
  const r = spawnSync(inv.command, inv.args, { cwd: dir, stdio: "inherit", timeout: 600_000 });
  if (r.status !== 0) throw new CliError(`npm install failed in ${dir}`, "Fix the error above and run `npm install` in that directory");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// register

/**
 * The FEI a command acts on: --fei when given, else the shell the MEI is built for (its MEI.pso.ts `host`), else the only FEI. With several
 * shells and nothing that decides, the command refuses instead of guessing: registering a MEI in the wrong shell would expose it there.
 */
export function targetFei(root: string, config: WorkspaceConfig, flag: string | undefined, mei?: string): FrontendDecl {
  const shells = frontends(config).filter((f) => f.kind === "fei");
  if (!shells.length) throw new CliError("This workspace has no FEI", "Create one: pso create fei <name>");
  if (flag !== undefined) {
    const n = withPrefix(flag, "fei");
    const s = shells.find((x) => x.name === n);
    if (!s) throw new CliError(`Unknown FEI "${flag}"`, `Known: ${shells.map((x) => x.name).join(", ")}`);
    return s;
  }
  if (mei) {
    const m = frontends(config).find((f) => f.name === mei && f.kind === "mei");
    const host = m ? (readDecl(join(projectDir(root, m), MEI_FILE), "defineMEI").value as { host?: string } | undefined)?.host : undefined;
    const s = host ? shells.find((x) => x.name === host) : undefined;
    if (s) return s;
  }
  if (shells.length === 1) return shells[0]!;
  throw new CliError(`This workspace has ${shells.length} FEIs: pass --fei <name>`, `Known: ${shells.map((x) => x.name).join(", ")}`);
}

async function registerMei(ctx: Ctx, root: string, config: WorkspaceConfig, rawName: string, o: { path?: string | undefined; scopes?: string | undefined; title?: string | undefined; icon?: string | undefined; loading?: string | undefined; fei?: string | undefined; public?: boolean }): Promise<number> {
  const name = withPrefix(rawName, "mei");
  const domain = name.replace(/^mei-/, "");
  const meiDecl = frontends(config).find((f) => f.name === name && f.kind === "mei");
  if (!meiDecl) throw new CliError(`"${name}" is not a MEI of this workspace`, `Known: ${frontends(config).filter((f) => f.kind === "mei").map((f) => f.name).join(", ") || "(none)"}. Create it with: pso create mei ${domain}`);
  const feiDecl = targetFei(root, config, o.fei, name);
  const meiHost = (readDecl(join(projectDir(root, meiDecl), MEI_FILE), "defineMEI").value as { host?: string } | undefined)?.host;
  if (meiHost && meiHost !== feiDecl.name) throw new CliError(`${name} is built for "${meiHost}", not "${feiDecl.name}"`, `A MEI belongs to one shell: register it with --fei ${meiHost}, or change "host" in ${meiDecl.path}/${MEI_FILE}`);
  const feiFile = join(projectDir(root, feiDecl), FEI_FILE);
  const text = readFileSync(feiFile, "utf8");
  const decl = readDecl(feiFile, "defineFEI");
  const def = decl.value as { microfrontends?: Array<{ name: string; path: string }> } | undefined;
  if (!def) throw new CliError(`${FEI_FILE} cannot be read: ${decl.diagnostics.map((d) => d.message).join("; ")}`);
  if (def.microfrontends?.some((m) => m.name === name)) { ctx.print(`"${name}" is already registered in ${FEI_FILE}`); return 0; }
  const path = o.path ?? `/${domain}`;
  const clash = def.microfrontends?.find((m) => m.path === path || m.path.startsWith(`${path}/`) || path.startsWith(`${m.path}/`));
  if (clash) throw new CliError(`The path "${path}" overlaps "${clash.name}" (${clash.path})`, "Give each microfrontend its own route prefix (--path /other)");
  if (o.public && o.scopes !== undefined) throw new CliError("--public and --scopes contradict each other: a visitor without a session has no scopes", "Register the MEI public (no entry scopes) or protected (with --scopes), not both");
  const scopes = o.public ? [] : (o.scopes ?? `${domain}:read`).split(",").map((s) => s.trim()).filter(Boolean);
  const entry = [`{`, `  name: ${JSON.stringify(name)},`, `  path: ${JSON.stringify(path)},`, ...(o.public ? [`  public: true,`] : [`  scopes: ${JSON.stringify(scopes)},`]), `  loading: ${JSON.stringify(o.loading ?? "lazy")},`, ...(o.title ? [`  title: ${JSON.stringify(o.title)},`] : []), ...(o.icon ? [`  icon: ${JSON.stringify(o.icon)},`] : []), `}`].join("\n");
  const next = appendToArray(text, "microfrontends", entry);
  if (ctx.flags["dry-run"] === true) { ctx.print(`[dry-run] would register ${name} at ${path} (scopes: ${scopes.join(", ")}) in ${feiDecl.path}/${FEI_FILE}`); return 0; }
  writeFileSync(feiFile, next);
  ctx.print(`registered ${name} at ${path} (${o.public ? "public" : `scopes: ${scopes.join(", ")}`}) in ${feiDecl.path}/${FEI_FILE}`);
  // the entry scopes of the shell and the scopes the MEI declares are one decision: keep them consistent instead of reporting a mismatch
  if (scopes.length) {
    const meiFile = join(projectDir(root, meiDecl), MEI_FILE);
    const mt = readFileSync(meiFile, "utf8");
    const declared = ((readDecl(meiFile, "defineMEI").value as { security?: { scopes?: string[] } } | undefined)?.security?.scopes) ?? [];
    const add = scopes.filter((s) => !declared.includes(s));
    const arr = arrayOf(parseTs(mt), "scopes");
    if (add.length && arr) {
      const updated = mt.slice(0, arr.getEnd() - 1) + add.map((s, i) => `${arr.elements.length || i ? ", " : ""}${JSON.stringify(s)}`).join("") + mt.slice(arr.getEnd() - 1);
      writeFileSync(meiFile, updated);
      ctx.print(`added ${add.join(", ")} to security.scopes of ${meiDecl.path}/${MEI_FILE}`);
    } else if (add.length) ctx.print(`note: ${meiDecl.path}/${MEI_FILE} has no security.scopes list: add ${add.join(", ")} to it`);
  }
  const { eco } = report(root, config);
  const mine = eco.diagnostics.filter((d) => d.message.includes(name));
  if (mine.length) ctx.print(mine.map(formatDiagnostic).join("\n"));
  if (ctx.flags["register"] !== true || ctx.positionals[0] !== "mei") await reconcileAfter(ctx, root, `registering ${name} in ${feiDecl.name}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// process helpers for dev and build

async function portFree(port: number): Promise<boolean> {
  return new Promise((res) => { const s = createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(port, "127.0.0.1"); });
}
function npmRun(dir: string, script: string, env: NodeJS.ProcessEnv, label: string, ctx: Ctx, inherit = false): ChildProcess {
  const inv = npmInvocation("npm", ["run", script]);
  const p = spawn(inv.command, inv.args, { cwd: dir, env: { ...process.env, ...env }, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
  const pipe = (s: NodeJS.ReadableStream | null) => { if (!s) return; let buf = ""; s.on("data", (c: Buffer) => { buf += c.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ""; for (const l of lines) if (l.trim()) ctx.print(`[${label}] ${l}`); }); };
  pipe(p.stdout); pipe(p.stderr);
  return p;
}
const killTree = (p: ChildProcess): void => { if (!p.pid) return; if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); else p.kill("SIGTERM"); };
const exited = (p: ChildProcess): Promise<number> => new Promise((r) => p.on("exit", (c) => r(c ?? 1)));

function requireInstalled(dir: string, name: string): void {
  if (!existsSync(join(dir, "node_modules", "@rspack", "core"))) throw new CliError(`${name} has no installed dependencies`, `Run: cd ${dir} && npm install   (or pso frontend:install)`);
}

function sizes(dist: string): { totalGzip: number; files: Array<{ file: string; bytes: number; gzip: number }> } {
  const files = walk(dist).filter((f) => /\.(js|css)$/.test(f) && !/mf-stats|manifest/.test(f)).map((f) => { const b = readFileSync(f); return { file: f.slice(dist.length + 1).replace(/\\/g, "/"), bytes: b.length, gzip: gzipSync(b).length }; });
  return { totalGzip: files.reduce((a, f) => a + f.gzip, 0), files };
}

export const FRONTEND_COMMANDS: Record<string, Command> = {
  "fei:register": {
    usage: "pso fei:register <mei> [--fei <name>] [--path /prefix] [--scopes a:read,b:write] [--public] [--title <text>] [--icon <name>] [--loading lazy|eager] [--dry-run]",
    summary: "Register a MEI with the FEI: adds it to FEI.pso.ts (mount path, entry scopes, loading) and validates the relationship",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (!ctx.positionals[0]) throw new CliError("Missing MEI name", "Example: pso fei:register customers");
      const loading = str(ctx.flags["loading"]);
      if (loading !== undefined && loading !== "lazy" && loading !== "eager") throw new CliError(`Invalid --loading "${loading}"`, "Use lazy or eager");
      const path = str(ctx.flags["path"]);
      if (path !== undefined && !/^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(path)) throw new CliError(`Invalid --path "${path}"`, "Use a lower-case path such as /customers");
      return registerMei(ctx, root, config, ctx.positionals[0], { path, scopes: str(ctx.flags["scopes"]), title: str(ctx.flags["title"]), icon: str(ctx.flags["icon"]), loading, fei: str(ctx.flags["fei"]), public: ctx.flags["public"] === true });
    },
  },
  "fei:unregister": {
    usage: "pso fei:unregister <mei> [--fei <name>] [--dry-run]",
    summary: "Remove a MEI from FEI.pso.ts (the MEI project itself is not deleted)",
    async run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (!ctx.positionals[0]) throw new CliError("Missing MEI name");
      const name = withPrefix(ctx.positionals[0], "mei");
      const feiDecl = targetFei(root, config, str(ctx.flags["fei"]), name);
      const feiFile = join(projectDir(root, feiDecl), FEI_FILE);
      const { text, removed } = removeFromArray(readFileSync(feiFile, "utf8"), "microfrontends", (el) => nameOf(el) === name);
      if (!removed) throw new CliError(`"${name}" is not registered in ${FEI_FILE}`);
      if (ctx.flags["dry-run"] === true) { ctx.print(`[dry-run] would unregister ${name}`); return 0; }
      writeFileSync(feiFile, text);
      ctx.print(`unregistered ${name} from ${feiDecl.path}/${FEI_FILE} (the project ${frontends(config).find((f) => f.name === name)?.path ?? ""} was not touched)`);
      await reconcileAfter(ctx, root, `unregistering ${name} from ${feiDecl.name}`);
      return 0;
    },
  },
  "frontend:validate": {
    usage: "pso frontend:validate [--json]",
    summary: "Validate the FEI/MEI declarations, their relationships, route ownership and conflicts, contract compatibility and the architecture rules (exit 1 on errors)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (frontends(config).length === 0) { emit(ctx, { ok: true, diagnostics: [] }, "no frontend projects in this workspace"); return 0; }
      const { eco } = report(root, config);
      const errors = hasErrors(eco.diagnostics);
      emit(ctx, { ok: !errors, ...eco }, (eco.diagnostics.length ? eco.diagnostics.map(formatDiagnostic).join("\n") + "\n" : "") + `${eco.feis.length ? eco.feis.join(", ") : "(no FEI)"}: ${eco.meis.length} microfrontend project(s), ${eco.routes.length} route(s)\n${errors ? "FAILED" : "OK"}`);
      return errors ? 1 : 0;
    },
  },
  "frontend:inspect": {
    usage: "pso frontend:inspect [<project>] [--json]",
    summary: "Show a frontend project: identity, port, orchestrator, registered MEIs, middleware order, scopes and effective routes",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const { loaded, eco } = report(root, config);
      const want = ctx.positionals[0];
      const rows = [...loaded.feis.map((f) => ({ kind: "fei", ...f })), ...loaded.meis.map((m) => ({ kind: "mei", ...m }))].filter((r) => !want || r.project.name === want || r.project.name === `fei-${want}` || r.project.name === `mei-${want}`);
      if (want && rows.length === 0) throw new CliError(`Unknown frontend project "${want}"`, `Known: ${frontends(config).map((f) => f.name).join(", ") || "(none)"}`);
      const data = rows.map((r) => ({ name: r.project.name, kind: r.kind, path: r.project.path, port: r.project.port, definition: r.definition, routes: eco.routes.filter((x) => x.owner === r.project.name).map((x) => ({ path: x.path, page: x.page ?? null, redirect: x.redirect ?? null, scopes: x.scopes })) }));
      emit(ctx, data, data.map((d) => {
        const def = d.definition as { orchestrator: { service: string }; middlewares?: string[]; microfrontends?: Array<{ name: string; path: string; scopes?: string[] }>; host?: string; security?: { scopes?: string[] } };
        return [`${d.name}  (${d.kind.toUpperCase()}, :${d.port}, ${d.path})`, `  orchestrator: ${def.orchestrator.service}`,
          ...(d.kind === "fei" ? [`  middlewares: ${(def.middlewares ?? [...BUILTIN_MIDDLEWARES]).join(" -> ")}`, ...(def.microfrontends ?? []).map((m) => `  mounts ${m.path.padEnd(14)} ${m.name}  scopes=[${(m.scopes ?? []).join(",")}]`)] : [`  host: ${def.host}`, `  scopes: ${(def.security?.scopes ?? []).join(", ") || "(none)"}`]),
          ...d.routes.map((r) => `  route ${r.path.padEnd(28)} ${r.redirect ? `-> ${r.redirect}` : (r.page ?? "")}`)].join("\n");
      }).join("\n\n") || "(no frontend projects)");
      return 0;
    },
  },
  "frontend:routes": {
    usage: "pso frontend:routes [--json]",
    summary: "List the effective browser routes of the whole frontend ecosystem with their owners (exit 1 on conflicts)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const { eco } = report(root, config);
      const conflict = eco.diagnostics.some((d) => d.code === "PSO_ROUTE_CONFLICT" || d.code === "PSO_FEI_ROUTE_CONFLICT");
      emit(ctx, { routes: eco.routes, diagnostics: eco.diagnostics.filter((d) => /ROUTE/.test(d.code)) }, [...[...eco.routes].sort((a, b) => (a.app + a.path < b.app + b.path ? -1 : 1)).map((r) => `${eco.feis.length > 1 ? `${r.app.padEnd(16)} ` : ""}${r.path.padEnd(32)} ${r.owner.padEnd(16)} ${r.redirect ? `-> ${r.redirect}` : (r.page ?? "")}${r.scopes.length ? `  [${r.scopes.join(",")}]` : ""}`), ...eco.diagnostics.filter((d) => /ROUTE/.test(d.code)).map(formatDiagnostic)].join("\n") || "(no routes)");
      return conflict ? 1 : 0;
    },
  },
  "frontend:graph": {
    usage: "pso frontend:graph [--mermaid] [--json]",
    summary: "Show how the FEI, its MEIs and the orchestrator relate",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const g = buildGraph(loadAll(root, config));
      if (ctx.flags["mermaid"] === true) ctx.print(["graph TD", ...g.edges.map((e) => `  ${e.from.replace(/-/g, "_")}["${e.from}"] -->|${e.label}| ${e.to.replace(/-/g, "_")}["${e.to}"]`)].join("\n"));
      else emit(ctx, g, renderTree(g));
      return 0;
    },
  },
  "frontend:install": {
    usage: "pso frontend:install [<project>] [--dry-run]",
    summary: "Vendor the framework packages into the frontend projects and run `npm install` in each (or only in <project>)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const list = frontends(config).filter((f) => !ctx.positionals[0] || f.name === withPrefix(ctx.positionals[0], f.kind));
      if (!list.length) throw new CliError("No matching frontend project");
      for (const f of list) {
        const dir = projectDir(root, f);
        const v = vendorFramework(dir, { dryRun: ctx.flags["dry-run"] === true });
        ctx.print(`${f.name}: ${v.packages.length} framework package(s) vendored${v.changed.length ? ` (${v.changed.length} dependency spec(s) updated)` : ""}`);
        if (ctx.flags["dry-run"] !== true) npmInstall(dir, ctx);
      }
      return 0;
    },
  },
  "frontend:make": {
    usage: "pso frontend:make middleware|route <name> [--project <fei-or-mei>] [--page ./src/pages/X.tsx] [--dry-run] [--force]",
    summary: "Generate a navigation middleware (FEI: src/middlewares, MEI: domain middleware) or add a route with its page to ROUTES.pso.ts",
    args: 2,
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const what = ctx.positionals[0], name = ctx.positionals[1];
      if ((what !== "middleware" && what !== "route") || !name) throw new CliError("Usage: pso frontend:make middleware <name> | route </path>");
      const all = frontends(config);
      const pn = str(ctx.flags["project"]);
      const decl = pn ? all.find((f) => f.name === pn || f.name === `fei-${pn}` || f.name === `mei-${pn}`) : all.length === 1 ? all[0] : undefined;
      if (!decl) throw new CliError(pn ? `Unknown frontend project "${pn}"` : "Several frontend projects exist: pass --project <name>", `Known: ${all.map((f) => f.name).join(", ") || "(none)"}`);
      const dir = projectDir(root, decl);
      const dry = ctx.flags["dry-run"] === true, force = ctx.flags["force"] === true;
      if (what === "middleware") {
        const n = kebabName(name, "middleware");
        if ((BUILTIN_MIDDLEWARES as readonly string[]).includes(n)) throw new CliError(`"${n}" is a built-in middleware name`);
        const file = `src/middlewares/${n}.ts`;
        const body = `import { defineMiddleware } from "@pso/frontend";\n\n// Navigation middleware "${n}". It shapes what the interface shows; it is not a security boundary (the orchestrator enforces access).\nexport default defineMiddleware({\n  name: "${n}",\n\n  async execute(context, next) {\n    // context.to      the destination (path, query, params, owner, scopes)\n    // context.get/set values shared with the next middlewares${decl.kind === "mei" ? ` (a MEI middleware may only set keys under "mei.${decl.name}.")` : ""}\n    // context.deny(403, "reason") or context.redirect("/somewhere") stops the pipeline\n    return next();\n  },\n});\n`;
        const res = writeFiles(dir, { [file]: body }, { dryRun: dry, force });
        if (reportWrites(ctx, res) !== 0) return 1;
        if (!dry) {
          const declFile = join(dir, decl.kind === "fei" ? FEI_FILE : MEI_FILE);
          const t = readFileSync(declFile, "utf8");
          if (decl.kind === "fei") { const a = arrayOf(parseTs(t), "middlewares"); if (a && !a.elements.some((e) => ts.isStringLiteralLike(e) && e.text === n)) writeFileSync(declFile, t.slice(0, a.getEnd() - 1) + `${a.elements.length ? ", " : ""}${JSON.stringify(n)}` + t.slice(a.getEnd() - 1)); }
          else if (!/middlewares\s*:/.test(t)) writeFileSync(declFile, t.replace(/\}\);\s*$/, `\n  middlewares: [${JSON.stringify(n)}],\n});\n`));
          else { const a = arrayOf(parseTs(t), "middlewares"); if (a && !a.elements.some((e) => ts.isStringLiteralLike(e) && e.text === n)) writeFileSync(declFile, t.slice(0, a.getEnd() - 1) + `${a.elements.length ? ", " : ""}${JSON.stringify(n)}` + t.slice(a.getEnd() - 1)); }
          ctx.print(`added "${n}" to ${decl.kind === "fei" ? FEI_FILE : MEI_FILE}${decl.kind === "fei" ? " (last in the pipeline: move it where it belongs)" : ""}`);
        }
        return 0;
      }
      if (!/^\/[A-Za-z0-9._~\-/:*]*$/.test(name)) throw new CliError(`Invalid route path "${name}"`, "Example: /new or /:id/edit (relative to the mount path)");
      const component = (name === "/" ? "Index" : name.split("/").filter(Boolean).map((s) => pascal(s.replace(/^:/, "By-").replace(/[^A-Za-z0-9-]/g, "").toLowerCase() || "x")).join("")).replace(/-/g, "");
      const page = str(ctx.flags["page"]) ?? `./src/pages/${component}.tsx`;
      const routesFile = join(dir, ROUTES_FILE);
      const t = readFileSync(routesFile, "utf8");
      if (new RegExp(`path:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(t)) throw new CliError(`Route "${name}" already exists in ${ROUTES_FILE}`);
      const res = writeFiles(dir, { [page.replace(/^\.\//, "")]: `export default function ${component}() {\n  return (\n    <div className="mx-auto max-w-4xl">\n      <h1 className="text-2xl font-semibold">${component}</h1>\n    </div>\n  );\n}\n` }, { dryRun: dry, force });
      if (reportWrites(ctx, res) !== 0) return 1;
      if (!dry) { writeFileSync(routesFile, appendToArray(t, "routes", `{ path: ${JSON.stringify(name)}, page: ${JSON.stringify(page)}, title: ${JSON.stringify(component)} }`)); ctx.print(`added route ${name} to ${decl.path}/${ROUTES_FILE}`); }
      return 0;
    },
  },
  "frontend:dev": {
    usage: "pso frontend:dev [--fei <name>] [--standalone <mei>] [--only <project>] [--no-install-check]",
    summary: "Start the development servers: every FEI and its registered MEIs (ports from their declarations), one FEI with its MEIs (--fei), or one MEI alone with the development host adapter (--standalone)",
    async run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const { loaded, eco } = report(root, config);
      if (hasErrors(eco.diagnostics) && ctx.flags["no-install-check"] !== true) { ctx.print(eco.diagnostics.map(formatDiagnostic).join("\n")); throw new CliError("The frontend declarations have errors", "Fix them (pso frontend:validate) before starting"); }
      const orch = config.services.find((s) => s.role === "orchestrator");
      const orchUrl = process.env["PSO_ORCHESTRATOR_URL"] ?? `http://localhost:${orch?.port ?? 3000}`;
      const standalone = str(ctx.flags["standalone"]);
      const only = str(ctx.flags["only"]);
      let projects = [...loaded.feis.map((f) => ({ decl: frontends(config).find((x) => x.name === f.project.name)!, role: "fei" as const, shell: f as LoadedFei | undefined })), ...loaded.meis.map((m) => ({ decl: frontends(config).find((f) => f.name === m.project.name)!, role: "mei" as const, shell: loaded.feis.find((f) => f.definition.name === m.definition.host) }))];
      const feiFlag = str(ctx.flags["fei"]);
      if (feiFlag !== undefined) { const shell = targetFei(root, config, feiFlag); projects = projects.filter((p) => p.shell?.project.name === shell.name); }
      if (standalone) { const n = withPrefix(standalone, "mei"); projects = projects.filter((p) => p.decl.name === n); if (!projects.length) throw new CliError(`Unknown MEI "${standalone}"`); }
      else if (only) projects = projects.filter((p) => p.decl.name === only || p.decl.name === `fei-${only}` || p.decl.name === `mei-${only}`);
      if (!projects.length) throw new CliError("No frontend project to start");
      for (const p of projects) { requireInstalled(projectDir(root, p.decl), p.decl.name); if (!(await portFree(p.decl.port))) throw new CliError(`Port ${p.decl.port} (${p.decl.name}) is already in use`, "Stop the other process or change the port in pso.workspace.json and the project's declaration"); }
      const portOf = (s: LoadedFei | undefined) => s?.definition.server?.port ?? DEFAULT_FEI_PORT;
      const children = projects.map((p) => npmRun(projectDir(root, p.decl), "dev", { PSO_ORCHESTRATOR_URL: orchUrl, PSO_FEI_PORT: String(portOf(p.shell)), ...(standalone ? { PSO_MEI_STANDALONE: "1" } : {}), FORCE_COLOR: "0" }, p.decl.name, ctx));
      ctx.print(standalone ? `standalone: http://localhost:${projects[0]!.decl.port}/  (orchestrator proxied from ${orchUrl})` : `shell${projects.filter((p) => p.role === "fei").length > 1 ? "s" : ""}: ${projects.filter((p) => p.role === "fei").map((p) => `${p.decl.name} http://localhost:${portOf(p.shell)}/`).join("  ") || "(none)"}   microfrontends: ${projects.filter((p) => p.role === "mei").map((p) => `${p.decl.name}:${p.decl.port}`).join(", ") || "(none registered)"}   orchestrator: ${orchUrl}`);
      const stop = () => { for (const c of children) killTree(c); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      const codes = await Promise.all(children.map(exited));
      return codes.every((c) => c === 0 || c === null) ? 0 : 1;
    },
  },
  "frontend:build": {
    usage: "pso frontend:build [<project>] [--base-path /commerce/ | --env <name>] [--version 1.0.0] [--allow-dev-token] [--signer <name> | --sign-key <pem-file> --key-id <id>] [--json]",
    summary: "Build the FEI and/or MEIs independently (hashed assets); a MEI also gets its release manifest (file hashes, contract, shared versions, optional ed25519 signature)",
    async run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const { loaded, eco } = report(root, config);
      if (hasErrors(eco.diagnostics)) { ctx.print(eco.diagnostics.map(formatDiagnostic).join("\n")); throw new CliError("The frontend declarations have errors", "Fix them (pso frontend:validate) before building"); }
      const only = ctx.positionals[0];
      const list = frontends(config).filter((f) => !only || f.name === only || f.name === `fei-${only}` || f.name === `mei-${only}`);
      if (!list.length) throw new CliError(only ? `Unknown frontend project "${only}"` : "No frontend projects in this workspace");
      const envName = str(ctx.flags["env"]);
      if (envName !== undefined && str(ctx.flags["base-path"]) !== undefined) throw new CliError("--base-path and --env both decide the base path: use one");
      // with --env every shell is built for the base path the infrastructure contract gives it in that environment
      const envBases: Record<string, string> = envName !== undefined ? Object.fromEntries(engine(() => plan(root, envName, INFRA_HOOKS)).topology.frontends.map((x) => [x.name, x.basePath])) : {};
      const basePath = str(ctx.flags["base-path"]) ?? "/";
      if (!/^\/([A-Za-z0-9._~-]+\/)*$/.test(basePath)) throw new CliError(`Invalid --base-path "${basePath}"`, `Use an absolute path ending in "/", such as /commerce/`);
      const signing = releaseSigningFromFlags(ctx.flags);
      const results: Array<Record<string, unknown>> = [];
      for (const f of list) {
        const dir = projectDir(root, f);
        requireInstalled(dir, f.name);
        const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PSO_FRONTEND_MODE: "production", PSO_BASE_PATH: f.kind === "fei" ? (envBases[f.name] ?? basePath) : "/", FORCE_COLOR: "0", ...(ctx.flags["allow-dev-token"] === true ? { PSO_ALLOW_DEV_TOKEN: "1" } : {}) };
        const t0 = Date.now();
        const p = npmRun(dir, "build", env, f.name, ctx);
        const code = await exited(p);
        if (code !== 0) throw new CliError(`Build of ${f.name} failed`, "The compiler output is above");
        const ms = Date.now() - t0;
        const sz = sizes(join(dir, "dist"));
        const row: Record<string, unknown> = { project: f.name, kind: f.kind, buildMs: ms, gzipBytes: sz.totalGzip, files: sz.files.length };
        const shell = feiOf(loaded, f.name);
        const budget = f.kind === "fei" ? shell?.definition.budgets?.shellKb : shell?.definition.budgets?.remoteKb;
        if (budget !== undefined) { row["budgetKb"] = budget; if (sz.totalGzip > budget * 1024) { ctx.print(`${f.name}: ${(sz.totalGzip / 1024).toFixed(1)} KB gzip exceeds the budget of ${budget} KB`); throw new CliError(`${f.name} exceeds its performance budget`, "Raise `budgets` in FEI.pso.ts deliberately or reduce the bundle"); } }
        if (f.kind === "fei" && shell) {
          const version = str(ctx.flags["version"]) ?? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
          const rel = buildFeiManifest({ dir, definition: shell.definition, version, basePath: envBases[f.name] ?? basePath });
          row["version"] = version; row["manifestFiles"] = rel.files.length;
        }
        if (f.kind === "mei") {
          const m = loaded.meis.find((x) => x.project.name === f.name)!;
          const version = str(ctx.flags["version"]) ?? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
          const mount = shell?.definition.microfrontends.find((x) => x.name === f.name)?.path ?? `/${f.name.replace(/^mei-/, "")}`;
          const own = m.routes ? flattenRoutes(m.routes, f.name, mount, ROUTES_FILE) : [];
          const manifest = withReleaseKey(signing, `frontend:build ${f.name}@${version}`, (signWith) => buildRemoteManifest({ dir, definition: m.definition, routes: own, version, ...(signWith ? { signWith } : {}) }));
          row["version"] = version; row["signed"] = manifest.signature !== undefined; row["manifestFiles"] = manifest.files.length;
        }
        results.push(row);
      }
      emit(ctx, results, results.map((r) => `${String(r["project"]).padEnd(18)} ${String(Math.round(Number(r["buildMs"]) / 100) / 10).padStart(6)} s   ${(Number(r["gzipBytes"]) / 1024).toFixed(1).padStart(7)} KB gzip${r["version"] ? `   release ${String(r["version"])}${r["kind"] === "fei" ? " (shell manifest; sign the release with release:sign)" : r["signed"] ? " (signed)" : " (unsigned)"}` : ""}`).join("\n"));
      return 0;
    },
  },
};
const ARGS: Record<string, number> = { "fei:register": 1, "fei:unregister": 1, "frontend:validate": 0, "frontend:inspect": 1, "frontend:routes": 0, "frontend:graph": 0, "frontend:install": 1, "frontend:make": 2, "frontend:dev": 0, "frontend:build": 1 };
for (const [k, c] of Object.entries(FRONTEND_COMMANDS)) if (c.args === undefined) c.args = ARGS[k]!;
void mkdirSync;

/** The shared read-only analysis of the frontend ecosystem (used by `pso validate`, the frontend commands and Studio). */
export const frontendReport = report;
