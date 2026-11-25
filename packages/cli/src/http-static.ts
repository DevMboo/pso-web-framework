import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  validateModules, normalizePath, joinPaths, nodeLayout, type ActionModel, type ControllerModel, type Diagnostic, type ModuleModel, type ProviderModel,
  type RouteDecl, type ModelContext, type WorkspaceConfig, type NodeLayout,
} from "@pso/core";
import { orchestratorStructure } from "./project-structure.ts";
import { crudModules } from "./crud-binding.ts";

/**
 * Static analysis of HTTP modules with the TypeScript compiler API. Files are PARSED, never imported or executed,
 * and the resulting neutral model goes through the same validator the runtime uses (@pso/core validateModules).
 */

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8").replace(/^﻿/, ""), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
const str = (n: ts.Node | undefined): string | undefined => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
const bool = (n: ts.Node | undefined): boolean | undefined => (n?.kind === ts.SyntaxKind.TrueKeyword ? true : n?.kind === ts.SyntaxKind.FalseKeyword ? false : undefined);
const arr = <T>(n: ts.Node | undefined, f: (e: ts.Expression) => T | undefined): T[] | undefined => {
  if (!n || !ts.isArrayLiteralExpression(n)) return undefined;
  const out: T[] = [];
  for (const e of n.elements) { const v = f(e); if (v === undefined) return undefined; out.push(v); }
  return out;
};
const ident = (e: ts.Expression): string | undefined => (ts.isIdentifier(e) ? e.text : undefined);

function props(o: ts.ObjectLiteralExpression, errors: string[], where: string): Map<string, ts.Expression> {
  const m = new Map<string, ts.Expression>();
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name))) m.set(p.name.text, p.initializer);
    else if (ts.isShorthandPropertyAssignment(p)) m.set(p.name.text, p.name);
    else errors.push(`${where}: only plain \`key: value\` properties are allowed (no spread or computed keys), so the declaration can be verified without running it`);
  }
  return m;
}

/** `export default <callee>({...})` */
function defaultCall(sf: ts.SourceFile, callee: string): ts.ObjectLiteralExpression | undefined {
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && ts.isCallExpression(st.expression) && ts.isIdentifier(st.expression.expression) && st.expression.expression.text === callee) {
      const a = st.expression.arguments[0];
      if (a && ts.isObjectLiteralExpression(a)) return a;
    }
  }
  return undefined;
}

/** identifier -> import specifier */
function importMap(sf: ts.SourceFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
    const spec = st.moduleSpecifier.text;
    if (st.importClause.name) m.set(st.importClause.name.text, spec);
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) m.set(e.name.text, spec);
  }
  return m;
}

const decoName = (d: ts.Decorator): { name: string; args: readonly ts.Expression[] } | undefined => {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return { name: e.expression.text, args: e.arguments };
  return undefined;
};
const HTTP = new Set(["Get", "Post", "Put", "Patch", "Delete"]);

interface ClassInfo { name: string; file: string; controller: ControllerModel; provider: ProviderModel }

function classesOf(file: string): ClassInfo[] {
  const sf = parse(file);
  const out: ClassInfo[] = [];
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    let decorated = false, hasController = false, prefix: string | undefined, isPublic = false;
    const guards: string[] = [], scopes: string[] = [];
    for (const d of ts.canHaveDecorators(st) ? (ts.getDecorators(st) ?? []) : []) {
      const dn = decoName(d);
      if (!dn) continue;
      if (dn.name === "Controller") hasController = true;
      else if (dn.name === "RestController") prefix = str(dn.args[0]) ?? "/";
      else if (dn.name === "Public") isPublic = true;
      else if (dn.name === "UseGuards") guards.push(...dn.args.map((a) => str(a)).filter((x): x is string => !!x));
      else if (dn.name === "Scopes") scopes.push(...dn.args.map((a) => str(a)).filter((x): x is string => !!x));
    }
    decorated = hasController && prefix !== undefined;
    const actions: ActionModel[] = [];
    let deps: string[] = [];
    for (const mem of st.members) {
      if (ts.isConstructorDeclaration(mem)) deps = mem.parameters.map((p) => (p.type && ts.isTypeReferenceNode(p.type) ? p.type.typeName.getText(sf) : "Object"));
      if (!ts.isMethodDeclaration(mem) || !ts.isIdentifier(mem.name)) continue;
      const a: ActionModel = { name: mem.name.text };
      const g: string[] = [], s: string[] = [];
      for (const d of ts.canHaveDecorators(mem) ? (ts.getDecorators(mem) ?? []) : []) {
        const dn = decoName(d);
        if (!dn) continue;
        if (HTTP.has(dn.name) && a.method === undefined) { a.method = dn.name.toUpperCase(); a.path = str(dn.args[0]) ?? "/"; }
        else if (dn.name === "Public") a.public = true;
        else if (dn.name === "UseGuards") g.push(...dn.args.map((x) => str(x)).filter((x): x is string => !!x));
        else if (dn.name === "Scopes") s.push(...dn.args.map((x) => str(x)).filter((x): x is string => !!x));
      }
      if (g.length) a.guards = g;
      if (s.length) a.scopes = s;
      actions.push(a);
    }
    const controller: ControllerModel = { name: st.name.text, decorated, ...(prefix !== undefined ? { prefix } : {}), ...(isPublic ? { public: true } : {}), ...(guards.length ? { guards } : {}), ...(scopes.length ? { scopes } : {}), actions, deps };
    out.push({ name: st.name.text, file, controller, provider: { name: st.name.text, deps } });
  }
  return out;
}

const specToDir = (spec: string): string | undefined => /^\.\.\/([^/]+)\/MODULE\.pso(\.[jt]s)?$/.exec(spec)?.[1];

/** every .ts file of a module directory (recursively for the modular structure: controllers/, services/, providers/, dto/, ...) */
function moduleSources(d: string, recursive: boolean, rel = ""): string[] {
  const out: string[] = [];
  for (const f of readdirSync(join(d, rel)).sort()) {
    const r = rel ? `${rel}/${f}` : f, full = join(d, r);
    if (statSync(full).isDirectory()) { if (recursive) out.push(...moduleSources(d, true, r)); continue; }
    if (f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "MODULE.pso.ts" && f !== "ROUTES.pso.ts") out.push(r);
  }
  return out;
}

function moduleModel(modulesRoot: string, dir: string, layout: NodeLayout = nodeLayout("legacy")): ModuleModel {
  const d = join(modulesRoot, dir);
  const files = readdirSync(d).filter((f) => statSync(join(d, f)).isFile());
  const routesRel = `${layout.routesFile}.ts`;
  const hasModule = files.includes("MODULE.pso.ts"), hasRoutes = existsSync(join(d, ...routesRel.split("/")));
  const shapeErrors: string[] = [];
  const base = `src/${layout.modulesDir}/${dir}`;
  const m: ModuleModel = {
    dir, hasModule, hasRoutes, controllers: [], providers: [], exports: [], imports: [], routesFromOwnRegistry: false,
    controllerModels: [], providerModels: [], undeclaredControllers: [], routes: [], shapeErrors,
    ...(hasModule ? { moduleFile: `${base}/MODULE.pso.ts` } : {}), ...(hasRoutes ? { routesFile: `${base}/${routesRel}` } : {}),
  };
  const classes: ClassInfo[] = moduleSources(d, layout.structure === "modular").flatMap((f) => classesOf(join(d, ...f.split("/"))));
  m.controllerModels = classes.map((c) => c.controller);
  m.providerModels = classes.map((c) => c.provider);

  if (hasModule) {
    const sf = parse(join(d, "MODULE.pso.ts"));
    const imports = importMap(sf);
    const lit = defaultCall(sf, "defineModule");
    if (!lit) shapeErrors.push("MODULE.pso.ts must `export default defineModule({ ... })` with an object literal");
    else {
      const p = props(lit, shapeErrors, "MODULE.pso.ts");
      m.name = str(p.get("name"));
      if (m.name === undefined) shapeErrors.push('"name" must be a string literal');
      const list = (k: string): string[] => {
        const v = p.get(k);
        if (v === undefined) return [];
        const r = arr(v, ident);
        if (!r) { shapeErrors.push(`"${k}" must be an array of identifiers`); return []; }
        return r;
      };
      m.controllers = list("controllers"); m.providers = list("providers"); m.exports = list("exports");
      m.imports = list("imports").map((id) => specToDir(imports.get(id) ?? "") ?? id);
      const r = p.get("routes");
      const rid = r && ident(r);
      const ownRoutes = new RegExp(`^\\./${layout.routesFile.replace(/\./g, "\\.")}(\\.[jt]s)?$`);
      m.routesFromOwnRegistry = !!rid && ownRoutes.test(imports.get(rid) ?? "");
      m.undeclaredControllers = classes.filter((c) => c.file.endsWith(".controller.ts") && !m.controllers.includes(c.name)).map((c) => c.name);
      // controllers named in the module must exist as classes
      for (const c of m.controllers) if (!classes.some((x) => x.name === c)) shapeErrors.push(`controller ${c} is declared but no such class exists in ${layout.modulesDir}/${dir}/`);
    }
  }

  if (hasRoutes) {
    const sf = parse(join(d, ...routesRel.split("/")));
    const lit = defaultCall(sf, "defineRoutes");
    if (!lit) shapeErrors.push("ROUTES.pso.ts must `export default defineRoutes({ routes: [ ... ] })` with an object literal");
    else {
      const p = props(lit, shapeErrors, "ROUTES.pso.ts");
      const list = p.get("routes");
      if (!list || !ts.isArrayLiteralExpression(list)) shapeErrors.push('"routes" must be an array literal');
      else for (const el of list.elements) {
        if (!ts.isObjectLiteralExpression(el)) { shapeErrors.push("every route must be an object literal"); continue; }
        const rp = props(el, shapeErrors, "ROUTES.pso.ts route");
        const ctl = rp.get("controller");
        const sec = rp.get("security");
        const sp = sec && ts.isObjectLiteralExpression(sec) ? props(sec, shapeErrors, "security") : new Map<string, ts.Expression>();
        const meta = rp.get("metadata");
        const mp = meta && ts.isObjectLiteralExpression(meta) ? props(meta, shapeErrors, "metadata") : new Map<string, ts.Expression>();
        const guard = str(sp.get("guard"));
        const guards = [...(guard ? [guard] : []), ...(arr(rp.get("guards"), str) ?? [])];
        const scopes = arr(sp.get("scopes"), str);
        const decl: RouteDecl = {
          method: str(rp.get("method")) ?? "?", path: str(rp.get("path")) ?? "?", controller: (ctl && ident(ctl)) ?? "?", action: str(rp.get("action")) ?? "?",
          ...(bool(sp.get("public")) ? { public: true } : {}), guards, ...(scopes ? { scopes } : {}),
          ...(arr(rp.get("middleware"), str) ? { middleware: arr(rp.get("middleware"), str)! } : {}), ...(arr(rp.get("filters"), str) ? { filters: arr(rp.get("filters"), str)! } : {}),
          ...(arr(rp.get("interceptors"), str) ? { interceptors: arr(rp.get("interceptors"), str)! } : {}),
          ...(str(rp.get("version")) ? { version: str(rp.get("version"))! } : {}), ...(str(mp.get("service")) ? { service: str(mp.get("service"))! } : {}),
          ...(arr(mp.get("services"), str) ? { services: arr(mp.get("services"), str)! } : {}),
          ...(() => {
            const rs = rp.get("responses"); if (!rs) return {};
            if (!ts.isObjectLiteralExpression(rs)) { shapeErrors.push(`${str(rp.get("method")) ?? "?"} ${str(rp.get("path")) ?? "?"}: "responses" must be an object literal of status: "DtoName" strings`); return {}; }
            const out: Record<string, string> = {};
            for (const [code, v] of props(rs, shapeErrors, "responses")) { const t = str(v); if (!/^[1-5]\d\d$/.test(code) || t === undefined) shapeErrors.push(`${str(rp.get("method")) ?? "?"} ${str(rp.get("path")) ?? "?"}: response "${code}" must be an HTTP status code with a string literal value`); else out[code] = t; }
            return { responses: out };
          })(),
        };
        m.routes.push(decl);
      }
    }
  }
  return m;
}

const names = (dir: string, suffix: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => f.slice(0, -suffix.length)) : []);

export interface Analysis {
  models: ModuleModel[];
  diagnostics: Diagnostic[];
  /** routes that passed validation (empty when anything is wrong: fail closed) */
  active: ReturnType<typeof validateModules>["routes"];
  ok: boolean;
  context: ModelContext;
  /** the structural convention of the orchestrator */
  structure?: "modular" | "legacy";
}

/** the framework-owned module that serves /health/live and /health/ready (declared in @pso/http, mirrored here) */
function healthModel(): ModuleModel {
  const route = (a: string): RouteDecl => ({ method: "GET", path: `/health/${a}`, controller: "HealthController", action: a, public: true, guards: [] });
  return { dir: "health", hasModule: true, hasRoutes: true, name: "health", controllers: ["HealthController"], providers: [], exports: [], imports: [], routesFromOwnRegistry: true, controllerModels: [{ name: "HealthController", decorated: true, prefix: "/health", actions: [{ name: "live", method: "GET", path: "/live", public: true }, { name: "ready", method: "GET", path: "/ready", public: true }], deps: [] }], providerModels: [], undeclaredControllers: [], routes: [route("live"), route("ready")], shapeErrors: [] };
}

export function analyzeOrchestrator(orchDir: string): Analysis {
  const { finding, layout, src } = orchestratorStructure(orchDir);
  const modulesRoot = join(src, ...layout.modulesDir.split("/"));
  const dirs = existsSync(modulesRoot) ? readdirSync(modulesRoot).filter((n) => statSync(join(modulesRoot, n)).isDirectory()).sort() : [];
  const models = dirs.map((d) => moduleModel(modulesRoot, d, layout));
  // application-wide components plus module-local ones (the same namespaces the runtime builds)
  const kind = (k: "guards" | "middlewares" | "filters" | "interceptors", suffix: string): Set<string> => {
    const local = layout.moduleDir(k);
    return new Set([...names(join(src, ...layout.component(k).split("/")), suffix), ...(local ? dirs.flatMap((d) => names(join(modulesRoot, d, local), suffix)) : [])]);
  };
  const context: ModelContext = {
    guards: kind("guards", ".guard.ts"), middleware: kind("middlewares", ".middleware.ts"), filters: kind("filters", ".filter.ts"), interceptors: kind("interceptors", ".interceptor.ts"),
    builtins: new Set(["Upstream", "UpstreamClient", "Dispatch", "ChannelPublisher"]), // the same built-ins the runtime provides (http/src/runtime.ts)
  };
  // framework-owned health module is part of the model the runtime validates; it has no source to analyse
  const v = validateModules([...models, healthModel()], context);
  const structural: Diagnostic[] = finding.problems.map((message) => ({ code: "PSO_STRUCTURE_MIXED", severity: "error" as const, message, hint: "Keep one convention: `pso structure:inspect` shows what to move" }));
  return { models, diagnostics: [...structural, ...v.diagnostics.map((d) => ({ ...d, ...(d.file ? { file: d.file } : {}) }))], active: structural.length ? [] : v.routes, ok: v.ok && !structural.length, context, structure: layout.structure };
}

export interface RouteRow {
  id: string; module: string; method: string; path: string; controller: string; action: string; service: string;
  /** the services a composing route declared (metadata.services); empty for a forwarding route */
  services: string[];
  access: string; guard: string | null; guards: string[]; scopes: string[]; public: boolean; file: string; upstream: string; active: boolean;
  /** the optional response contract the route declares (status -> DTO expression) */
  responses: Record<string, string>;
}

/** Declared routes with their effective policy (what `routes:list`, Studio and the security tools show). */
export function routeRows(orchDir: string, a = analyzeOrchestrator(orchDir)): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const m of a.models) for (const r of m.routes) {
    const cm = m.controllerModels.find((c) => c.name === r.controller);
    const act = cm?.actions.find((x) => x.name === r.action);
    const guards = [...new Set([...(r.guards ?? []), ...(cm?.guards ?? []), ...(act?.guards ?? [])])];
    const isPublic = r.public === true || cm?.public === true || act?.public === true;
    const path = normalizePath(r.version ? joinPaths(`/v${r.version}`, r.path) : r.path);
    rows.push({
      id: `${m.dir}.${r.action}`, module: m.dir, method: r.method, path, controller: r.controller, action: r.action, service: r.service ?? "", services: r.services ?? [],
      access: isPublic ? "public" : guards.length ? `guard:${guards.join("+")}` : "denied", guard: guards[0] ?? null, guards,
      scopes: [...new Set([...(r.scopes ?? []), ...(cm?.scopes ?? []), ...(act?.scopes ?? [])])], public: isPublic,
      file: m.routesFile ?? `src/routes/${m.dir}/ROUTES.pso.ts`, upstream: path, active: a.ok, responses: r.responses ?? {},
    });
  }
  return rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.method < y.method ? -1 : 1));
}

/** Workspace-level checks that need the service list (unknown upstream services). */
export function serviceReferenceDiagnostics(a: Analysis, ws: WorkspaceConfig, orchDir?: string): Diagnostic[] {
  const known = new Set(ws.services.filter((s) => s.role !== "orchestrator").map((s) => s.name));
  const out: Diagnostic[] = [];
  // a CRUD module generated before the service it is bound to: the orchestrator still starts (those routes answer 502 "upstream not
  // configured" until the service exists), so it is a warning that says how to finish, not an error that blocks the workspace
  const awaiting = new Set(orchDir ? crudModules(orchDir).map((c) => `${c.module}|${c.service}`) : []);
  const warned = new Set<string>();
  for (const m of a.models) for (const r of m.routes) for (const name of [...(r.service ? [r.service] : []), ...(r.services ?? [])]) if (!known.has(name)) {
    if (awaiting.has(`${m.dir}|${name}`)) {
      if (!warned.has(m.dir)) out.push({ code: "PSO_CRUD_UNBOUND", severity: "warning", message: `Module "${m.dir}" is bound to the service "${name}", which this workspace does not declare yet: its routes answer 502 (upstream not configured) until it exists.`, hint: `Create it with \`pso create service ${name}\` (the reference CRUD), or bind the module to an existing service: pso crud:bind ${m.dir} --to <service>`, ...(m.routesFile ? { file: m.routesFile } : {}) });
      warned.add(m.dir);
      continue;
    }
    out.push({ code: "PSO_ROUTE_010", severity: "error", message: `Route targets an unknown service.\n\nModule: ${m.dir}\nRoute: ${r.method} ${r.path}\n\nExpected: one of ${[...known].join(", ") || "(no services declared)"}\nFound: ${name}\n\nRoute activation denied.`, file: `src/routes/${m.dir}/ROUTES.pso.ts` });
  }
  return out;
}
