/**
 * Node-side tooling of the frontend ecosystem: reading declarations without executing them, validating a whole FEI/MEI workspace,
 * generating the structural files a developer never writes by hand, the Rspack configurations and the release manifest.
 */
import ts from "typescript";
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  BUILTIN_MIDDLEWARES, CONTEXT_CONTRACT_VERSION, DEFAULT_FEI_PORT, DEFAULT_MEI_PORT,
  type FeiDefinition, type FrontendRoutesDefinition, type MeiDefinition,
} from "./contracts.ts";
import {
  checkOwnership, detectRouteConflicts, flattenRoutes, validateFei, validateMei, validateRelationships, validateRoutes,
  type FrontendDiagnostic, type MeiInfo, type ResolvedRoute,
} from "./validate.ts";
import { SHARED_SINGLETONS, installedVersions } from "./shared-versions.ts";
export { SHARED_SINGLETONS, installedVersions };
import { canonicalManifest, type FrontendRuntimeConfig, type RemoteManifest } from "./manifest.ts";
import { b64u } from "./manifest.ts";

export const FEI_FILE = "FEI.pso.ts";
export const MEI_FILE = "MEI.pso.ts";
export const ROUTES_FILE = "ROUTES.pso.ts";
export const GENERATED_DIR = ".pso/generated";
/** Versions the generated projects are pinned to. They were verified together by a real build. */
export const TOOLCHAIN = {
  "@rspack/core": "2.3.2", "@rspack/cli": "2.3.2", "@rspack/dev-server": "2.2.2", "@module-federation/enhanced": "2.9.3",
  react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-icons": "5.7.0",
  tailwindcss: "4.3.5", "@tailwindcss/postcss": "4.3.5", "postcss-loader": "8.2.1", "css-loader": "7.1.5", postcss: "8.5.6", typescript: "5.9.3",
  "@types/react": "18.3.12", "@types/react-dom": "18.3.1",
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// reading declarations (data only, never executed)

function evalNode(n: ts.Node, path: string, problems: string[]): unknown {
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n)) return evalNode(n.expression, path, problems);
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text);
  if (ts.isArrayLiteralExpression(n)) return n.elements.map((e, i) => evalNode(e, `${path}[${i}]`, problems));
  if (ts.isObjectLiteralExpression(n)) {
    const o: Record<string, unknown> = {};
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) { problems.push(`${path}: only \`key: value\` properties are allowed (no spreads, methods or computed keys): a declaration is data`); continue; }
      o[p.name.text] = evalNode(p.initializer, `${path}.${p.name.text}`, problems);
    }
    return o;
  }
  problems.push(`${path}: \`${n.getText().slice(0, 50)}\` is not a literal: frontend declarations are read without executing project code`);
  return undefined;
}

export type DeclKind = "defineFEI" | "defineMEI" | "defineFrontendRoutes";
export interface ParsedDecl { value?: unknown; problems: string[] }
export function parseFrontendDeclaration(source: string, file: string, kind: DeclKind): ParsedDecl {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  let expr: ts.Expression | undefined;
  for (const st of sf.statements) if (ts.isExportAssignment(st) && !st.isExportEquals) expr = st.expression;
  if (!expr) return { problems: [`no \`export default ${kind}({...})\` found`] };
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    if (expr.expression.text !== kind) return { problems: [`export default must be ${kind}({...}), not ${expr.expression.text}(...)`] };
    expr = expr.arguments[0];
  } else if (!(expr && ts.isObjectLiteralExpression(expr))) return { problems: [`export default must be ${kind}({...})`] };
  if (!expr) return { problems: [`${kind}() needs an object argument`] };
  const problems: string[] = [];
  const value = evalNode(expr, "$", problems);
  return { value, problems };
}

export function readDecl(file: string, kind: DeclKind): { value?: unknown; diagnostics: FrontendDiagnostic[] } {
  if (!existsSync(file)) return { diagnostics: [{ code: "PSO_FRONTEND_FILE_MISSING", severity: "error", message: `${file} not found`, file }] };
  const r = parseFrontendDeclaration(readFileSync(file, "utf8"), file, kind);
  return { ...(r.value !== undefined ? { value: r.value } : {}), diagnostics: r.problems.map((message) => ({ code: "PSO_FRONTEND_DECLARATION", severity: "error" as const, message, file })) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// projects and the whole ecosystem

export type FrontendKind = "fei" | "mei";
export interface FrontendProject { kind: FrontendKind; name: string; /** workspace-relative, forward slashes */ path: string; dir: string; port?: number | undefined }
export interface LoadedFei { project: FrontendProject; definition: FeiDefinition; routes?: FrontendRoutesDefinition }
export interface LoadedMei { project: FrontendProject; definition: MeiDefinition; routes?: FrontendRoutesDefinition }
export interface LoadedFrontends {
  /** every valid FEI of the workspace (0.2.0: a workspace may have several independent application shells) */
  feis: LoadedFei[];
  /**
   * The FEI when the workspace has exactly one (compatibility with 0.1.x callers). Undefined with zero or several FEIs: code that must
   * work with several shells uses `feis` and `feiOf()`.
   */
  fei?: LoadedFei;
  meis: LoadedMei[];
  diagnostics: FrontendDiagnostic[];
}

/** The FEI a MEI is built for (its `host`), or the FEI named `name`. */
export function feiOf(loaded: LoadedFrontends, nameOrMei: string): LoadedFei | undefined {
  const direct = loaded.feis.find((f) => f.project.name === nameOrMei || f.project.name === `fei-${nameOrMei}`);
  if (direct) return direct;
  const mei = loaded.meis.find((m) => m.project.name === nameOrMei || m.project.name === `mei-${nameOrMei}`);
  return mei ? loaded.feis.find((f) => f.definition.name === mei.definition.host) : undefined;
}

const rel = (root: string, p: string): string => relative(root, p).split(sep).join("/");

export function loadFrontends(root: string, projects: ReadonlyArray<{ kind: FrontendKind; name: string; path: string; port?: number }>): LoadedFrontends {
  const diagnostics: FrontendDiagnostic[] = [];
  const out: LoadedFrontends = { feis: [], meis: [], diagnostics };
  for (const p of projects) {
    const dir = resolve(root, ...p.path.split("/"));
    const project: FrontendProject = { kind: p.kind, name: p.name, path: p.path, dir, port: p.port };
    if (!existsSync(dir)) { diagnostics.push({ code: "PSO_FRONTEND_PATH_MISSING", severity: "error", message: `frontend project "${p.name}": path "${p.path}" does not exist`, file: "pso.workspace.json" }); continue; }
    const declFile = join(dir, p.kind === "fei" ? FEI_FILE : MEI_FILE);
    const decl = readDecl(declFile, p.kind === "fei" ? "defineFEI" : "defineMEI");
    diagnostics.push(...decl.diagnostics.map((d) => ({ ...d, file: rel(root, d.file ?? declFile) })));
    const rf = join(dir, ROUTES_FILE);
    let routes: FrontendRoutesDefinition | undefined;
    if (existsSync(rf)) {
      const r = readDecl(rf, "defineFrontendRoutes");
      diagnostics.push(...r.diagnostics.map((d) => ({ ...d, file: rel(root, rf) })));
      if (r.value !== undefined) { const v = validateRoutes(r.value, rel(root, rf), { owner: p.kind }); diagnostics.push(...v); if (!v.some((x) => x.severity === "error")) routes = r.value as FrontendRoutesDefinition; }
    }
    if (decl.value === undefined) continue;
    const file = rel(root, declFile);
    if (p.kind === "fei") {
      const v = validateFei(decl.value, file); diagnostics.push(...v);
      if (!v.some((x) => x.severity === "error")) {
        const def = decl.value as FeiDefinition;
        if (def.name !== p.name) diagnostics.push({ code: "PSO_FRONTEND_NAME_MISMATCH", severity: "error", message: `${file} declares name "${def.name}" but the workspace registers this project as "${p.name}"`, file });
        else out.feis.push({ project, definition: def, ...(routes ? { routes } : {}) });
      }
    } else {
      const v = validateMei(decl.value, file); diagnostics.push(...v);
      if (!v.some((x) => x.severity === "error")) {
        const def = decl.value as MeiDefinition;
        if (def.name !== p.name) diagnostics.push({ code: "PSO_FRONTEND_NAME_MISMATCH", severity: "error", message: `${file} declares name "${def.name}" but the workspace registers this project as "${p.name}"`, file });
        else out.meis.push({ project, definition: def, ...(routes ? { routes } : {}) });
      }
    }
  }
  if (out.feis.length === 1) out.fei = out.feis[0];
  return out;
}

export interface EcosystemReport {
  diagnostics: FrontendDiagnostic[];
  /** every effective browser route; `app` is the FEI whose origin serves it (two FEIs may declare the same path: they are separate applications) */
  routes: Array<ResolvedRoute & { app: string }>;
  /** the single FEI (compatibility), undefined with several */
  fei?: string;
  feis: string[];
  meis: string[];
}

/** The complete static validation: declarations, relationships, route ownership and conflicts, files that must exist. */
export function validateEcosystem(root: string, loaded: LoadedFrontends): EcosystemReport {
  const diagnostics = [...loaded.diagnostics];
  const routes: EcosystemReport["routes"] = [];
  const exists = (dir: string, p: string) => existsSync(join(dir, ...p.replace(/^\.\//, "").split("/")));
  const feiNames = new Set(loaded.feis.map((f) => f.definition.name));
  // ports are a machine-wide resource: two shells (or a shell and a MEI of another shell) can never share one
  const ports = new Map<number, string>();
  for (const p of [...loaded.feis.map((f) => ({ name: f.definition.name, port: f.definition.server?.port ?? f.project.port ?? DEFAULT_FEI_PORT, file: rel(root, join(f.project.dir, FEI_FILE)) })), ...loaded.meis.map((m) => ({ name: m.definition.name, port: m.definition.server?.port ?? m.project.port, file: rel(root, join(m.project.dir, MEI_FILE)) }))]) {
    if (p.port === undefined) continue;
    const other = ports.get(p.port);
    if (other && other !== p.name) diagnostics.push({ code: "PSO_FRONTEND_PORT_CONFLICT", severity: "error", message: `${p.name} and ${other} both use port ${p.port}`, file: p.file, hint: "Give each frontend project its own development port" });
    else ports.set(p.port, p.name);
  }
  for (const fei of loaded.feis) {
    const feiFile = rel(root, join(fei.project.dir, FEI_FILE));
    const app = fei.definition.name;
    // each shell is evaluated only against the MEIs built for it: a MEI of another shell is not "unregistered" here
    const infos: MeiInfo[] = loaded.meis.filter((m) => m.definition.host === app || (loaded.feis.length === 1 && !feiNames.has(m.definition.host))).map((m) => ({ name: m.definition.name, file: rel(root, join(m.project.dir, MEI_FILE)), definition: m.definition }));
    diagnostics.push(...validateRelationships({ file: feiFile, definition: fei.definition }, infos).filter((d) => d.code !== "PSO_FRONTEND_PORT_CONFLICT"));
    for (const mf of fei.definition.microfrontends) {
      const owner = loaded.meis.find((m) => m.definition.name === mf.name);
      if (owner && owner.definition.host !== app && feiNames.has(owner.definition.host)) diagnostics.push({ code: "PSO_MEI_HOST_MISMATCH", severity: "error", message: `${feiFile} registers ${mf.name}, but ${mf.name} is built for "${owner.definition.host}"`, file: feiFile, hint: `A MEI belongs to one shell. Unregister it here (pso fei:unregister ${mf.name.replace(/^mei-/, "")} --fei ${app}) or change "host" in its MEI.pso.ts` });
    }
    for (const mw of fei.definition.middlewares ?? []) if (!(BUILTIN_MIDDLEWARES as readonly string[]).includes(mw) && !exists(fei.project.dir, `src/middlewares/${mw}.ts`) && !exists(fei.project.dir, `src/middlewares/${mw}.tsx`)) diagnostics.push({ code: "PSO_FEI_MIDDLEWARE_MISSING", severity: "error", message: `middleware "${mw}" is not built in and src/middlewares/${mw}.ts does not exist`, file: feiFile, hint: `Create it with: pso make:middleware ${mw} --service ${fei.project.name}` });
    const appRoutes: ResolvedRoute[] = [];
    if (fei.routes) appRoutes.push(...flattenRoutes(fei.routes, fei.project.name, "/", rel(root, join(fei.project.dir, ROUTES_FILE))));
    for (const mf of fei.definition.microfrontends) {
      const mei = loaded.meis.find((m) => m.definition.name === mf.name);
      if (!mei || (mei.definition.host !== app && feiNames.has(mei.definition.host))) continue;
      const rf = rel(root, join(mei.project.dir, ROUTES_FILE));
      if (!mei.routes) { diagnostics.push({ code: "PSO_MEI_NO_ROUTES", severity: "error", message: `${mf.name} has no valid ${ROUTES_FILE}: the FEI cannot know which routes it owns`, file: rel(root, mei.project.dir) }); continue; }
      const own = flattenRoutes(mei.routes, mf.name, mf.path, rf);
      diagnostics.push(...checkOwnership(own, mf.name, mf.path));
      appRoutes.push(...own);
      const walk = (rs: Array<{ page?: string; layout?: string }>) => { for (const r of rs) { for (const f of [r.page, r.layout]) if (f && !exists(mei.project.dir, f)) diagnostics.push({ code: "PSO_ROUTE_FILE_MISSING", severity: "error", message: `${mf.name}: route file ${f} does not exist`, file: rf }); } };
      walk(own);
      const mod = mei.definition.expose?.module ?? "./src/module.tsx";
      if (!exists(mei.project.dir, mod)) diagnostics.push({ code: "PSO_MEI_MODULE_MISSING", severity: "error", message: `${mf.name}: exposed module ${mod} does not exist`, file: rel(root, join(mei.project.dir, MEI_FILE)) });
      for (const mw of mei.definition.middlewares ?? []) if (!exists(mei.project.dir, `src/middlewares/${mw}.ts`)) diagnostics.push({ code: "PSO_MEI_MIDDLEWARE_MISSING", severity: "error", message: `${mf.name}: middleware "${mw}" does not exist in src/middlewares`, file: rel(root, join(mei.project.dir, MEI_FILE)) });
    }
    // route conflicts exist only inside one application: two shells are separate origins (or separate base paths)
    diagnostics.push(...detectRouteConflicts(appRoutes));
    // contradictory or dead security declarations, across the shell and its microfrontends
    const authOff = fei.definition.security?.authentication === "none";
    for (const mf of fei.definition.microfrontends) {
      const mei = loaded.meis.find((m) => m.definition.name === mf.name && m.definition.host === app);
      if (authOff && mei?.definition.security?.scopes?.length) diagnostics.push({ code: "PSO_FEI_AUTH_CONTRADICTION", severity: "error", message: `${mf.name} needs scopes (${mei.definition.security.scopes.join(", ")}), but ${app} has security.authentication "none": its pages could never be shown`, file: feiFile, hint: `Enable authentication in ${app}, or host ${mf.name} in a shell that has it` });
      if (Array.isArray(mf.public) && mei) {
        const own = appRoutes.filter((r) => r.owner === mf.name).map((r) => r.path);
        for (const p of mf.public) {
          const full = p === "/" ? mf.path : `${mf.path}${p.endsWith("/*") ? p.slice(0, -2) : p}`;
          if (!own.some((r) => r === full || r.startsWith(`${full}/`) || (p.endsWith("/*") && r.startsWith(full)) || r.replace(/\/:[^/]+/g, "/x") === full.replace(/\/:[^/]+/g, "/x"))) diagnostics.push({ code: "PSO_FEI_PUBLIC_PATH_UNROUTED", severity: "warning", message: `${feiFile}: ${mf.name} declares "${p}" public, but ${mf.name} has no route at ${full}`, file: feiFile, hint: "A public path that is not routed is either a typo or a page that will be added later" });
        }
      }
    }
    routes.push(...appRoutes.map((r) => ({ ...r, app })));
  }
  if (!loaded.feis.length && loaded.meis.length) diagnostics.push({ code: "PSO_FEI_MISSING", severity: "error", message: `MEI projects exist (${loaded.meis.map((m) => m.project.name).join(", ")}) but the workspace has no FEI`, hint: "Create one: pso create fei <name>" });
  if (loaded.feis.length > 1) {
    for (const m of loaded.meis) if (!feiNames.has(m.definition.host)) diagnostics.push({ code: "PSO_MEI_HOST_UNKNOWN", severity: "error", message: `${m.definition.name} declares host "${m.definition.host}", which is not a FEI of this workspace (${[...feiNames].join(", ")})`, file: rel(root, join(m.project.dir, MEI_FILE)), hint: "Set \"host\" in MEI.pso.ts to the shell that mounts it" });
  }
  return { diagnostics, routes, ...(loaded.fei ? { fei: loaded.fei.project.name } : {}), feis: loaded.feis.map((f) => f.project.name), meis: loaded.meis.map((m) => m.project.name) };
}

export interface GraphNode { id: string; kind: "fei" | "mei" | "orchestrator"; label: string; port?: number }
export interface FrontendGraph { nodes: GraphNode[]; edges: Array<{ from: string; to: string; label: string }> }
export function buildGraph(loaded: LoadedFrontends): FrontendGraph {
  const nodes: GraphNode[] = [], edges: FrontendGraph["edges"] = [];
  const add = (n: GraphNode) => { if (!nodes.some((x) => x.id === n.id)) nodes.push(n); };
  for (const f of loaded.feis) {
    add({ id: f.project.name, kind: "fei", label: f.project.name, port: f.definition.server?.port ?? DEFAULT_FEI_PORT });
    add({ id: f.definition.orchestrator.service, kind: "orchestrator", label: f.definition.orchestrator.service });
    for (const m of f.definition.microfrontends) {
      const mei = loaded.meis.find((x) => x.definition.name === m.name);
      add({ id: m.name, kind: "mei", label: m.name, ...(mei?.definition.server?.port !== undefined ? { port: mei.definition.server.port } : {}) });
      edges.push({ from: f.project.name, to: m.name, label: m.path });
      if (!edges.some((e) => e.from === m.name && e.to === f.definition.orchestrator.service)) edges.push({ from: m.name, to: f.definition.orchestrator.service, label: "via FEI context" });
    }
    edges.push({ from: f.project.name, to: f.definition.orchestrator.service, label: f.definition.orchestrator.basePath ?? "/api" });
  }
  return { nodes, edges };
}

export function renderTree(g: FrontendGraph): string {
  const feis = g.nodes.filter((n) => n.kind === "fei");
  if (!feis.length) return "(no FEI)";
  return feis.map((fei) => {
    const orchEdge = g.edges.find((e) => e.from === fei.id && g.nodes.find((n) => n.id === e.to)?.kind === "orchestrator");
    const meis = g.edges.filter((e) => e.from === fei.id && g.nodes.find((n) => n.id === e.to)?.kind === "mei").map((e) => ({ node: g.nodes.find((n) => n.id === e.to)!, label: e.label }));
    const lines = [`${fei.label}${fei.port ? ` (:${fei.port})` : ""}`];
    const items = [...meis.map((m) => `${m.node.label}${m.node.port ? ` (:${m.node.port})` : ""}  ${m.label}`), ...(orchEdge ? [`${orchEdge.to}  (orchestrator, ${orchEdge.label})`] : [])];
    items.forEach((it, i) => lines.push(`${i === items.length - 1 ? "└──" : "├──"} ${it}`));
    return lines.join("\n");
  }).join("\n\n");
}

/** The first free development port at or above `start`, skipping those in `used`. */
export function freePort(used: Iterable<number>, start: number): number { const u = new Set(used); let p = start; while (u.has(p)) p++; return p; }

// ---------------------------------------------------------------------------------------------------------------------------------
// generated structural files: the developer never writes federation or route plumbing

const write = (file: string, text: string) => { mkdirSync(join(file, ".."), { recursive: true }); if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text); };
const ident = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");
const j = JSON.stringify;

export interface RouteCodegenNode { path: string; page?: string; layout?: string; redirect?: string; title?: string | Record<string, string>; scopes?: string[]; meta?: Record<string, unknown>; children?: RouteCodegenNode[] }

function routeNodes(rs: FrontendRoutesDefinition["routes"], dir: string, indent: string): string {
  return rs.map((r) => {
    const parts = [`path: ${j(r.path)}`];
    if (r.page) parts.push(`load: () => import(${j(relFromGenerated(r.page))})`);
    if (r.layout) parts.push(`layout: () => import(${j(relFromGenerated(r.layout))})`);
    if (r.redirect) parts.push(`redirect: ${j(r.redirect)}`);
    if (r.title !== undefined) parts.push(`title: ${j(r.title)}`);
    if (r.scopes) parts.push(`scopes: ${j(r.scopes)}`);
    if (r.meta || r.public === true) parts.push(`meta: ${j({ ...(r.meta ?? {}), ...(r.public === true ? { public: true } : {}) })}`);
    if (r.children) parts.push(`children: [\n${routeNodes(r.children, dir, indent + "  ")}\n${indent}]`);
    return `${indent}{ ${parts.join(", ")} }`;
  }).join(",\n");
}
/** `./src/pages/X.tsx` (from the project root) as an import specifier from `.pso/generated/`. */
const relFromGenerated = (p: string): string => `../../${p.replace(/^\.\//, "")}`;

/** `.pso/generated/mei.ts`: identity, contract and lazy route table of a MEI. `src/module.tsx` only wraps it. */
export function generateMeiSources(dir: string, def: MeiDefinition, routes: FrontendRoutesDefinition): string[] {
  const g = join(dir, ...GENERATED_DIR.split("/"));
  const mws = def.middlewares ?? [];
  const text = `// GENERATED by \`pso frontend:*\` from ${MEI_FILE} and ${ROUTES_FILE}. Do not edit: change the declarations and run \`pso frontend:validate\`.
import type { MeiRouteNode } from "@pso/frontend-react";
${mws.map((m) => `import ${ident(m)} from "../../src/middlewares/${m}";`).join("\n")}

export const meiName = ${j(def.name)};
export const meiHost = ${j(def.host)};
export const contract = ${j(def.contract?.context ?? CONTEXT_CONTRACT_VERSION)};
export const middlewares = [${mws.map(ident).join(", ")}];
export const routes: MeiRouteNode[] = [
${routeNodes(routes.routes, dir, "  ")}
];
export default { name: meiName, host: meiHost, contract, middlewares, routes };
`;
  write(join(g, "mei.ts"), text);
  return ["mei.ts"];
}

/** `.pso/generated/fei.ts`: the FEI's declarations as typed data, custom middleware wiring and its own routes. */
export function generateFeiSources(dir: string, def: FeiDefinition, routes: FrontendRoutesDefinition | undefined): string[] {
  const g = join(dir, ...GENERATED_DIR.split("/"));
  const builtin = new Set<string>(BUILTIN_MIDDLEWARES);
  const order = def.middlewares ?? [...BUILTIN_MIDDLEWARES];
  const custom = order.filter((m) => !builtin.has(m));
  const text = `// GENERATED by \`pso frontend:*\` from ${FEI_FILE} and ${ROUTES_FILE}. Do not edit.
import type { FeiRuntimeDefinition, MeiRouteNode } from "@pso/frontend-react";
${custom.map((m) => `import ${ident(m)} from "../../src/middlewares/${m}";`).join("\n")}

export const fei: FeiRuntimeDefinition = {
  name: ${j(def.name)},
  orchestrator: ${j({ service: def.orchestrator.service, basePath: def.orchestrator.basePath ?? "/api" })},
  security: ${j({ authentication: def.security?.authentication ?? "jwt", session: def.security?.session ?? "centralized", loginPath: def.security?.loginPath ?? "/login" })},
  locale: ${j(def.locale ?? { default: "en", supported: ["en"] })},
  middlewares: ${j(order)},
  microfrontends: ${j(def.microfrontends.map((m) => ({ loading: "lazy", nav: !m.public, ...m })))},
};
export const customMiddlewares = { ${custom.map((m) => `${j(m)}: ${ident(m)}`).join(", ")} };
export const feiRoutes: MeiRouteNode[] = [
${routes ? routeNodes(routes.routes, dir, "  ") : ""}
];
`;
  write(join(g, "fei.ts"), text);
  return ["fei.ts"];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rspack configuration. The project's rspack.config.ts is one line; everything structural lives here.

export interface BuildEnv { mode: "development" | "production"; basePath: string; orchestratorUrl: string }
export function buildEnv(env: NodeJS.ProcessEnv = process.env): BuildEnv {
  const mode = env["NODE_ENV"] === "production" || env["PSO_FRONTEND_MODE"] === "production" ? "production" : "development";
  let basePath = env["PSO_BASE_PATH"] ?? "/";
  if (!/^\/([A-Za-z0-9._~-]+\/)*$/.test(basePath)) throw new Error(`PSO_BASE_PATH must be an absolute path ending in "/", such as "/commerce/" (got ${JSON.stringify(basePath)})`);
  if (!basePath.endsWith("/")) basePath += "/";
  return { mode, basePath, orchestratorUrl: env["PSO_ORCHESTRATOR_URL"] ?? "http://localhost:3000" };
}


function readProjectPkg(dir: string): { dependencies?: Record<string, string> } & Record<string, unknown> { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }; }
function sharedConfig(dir: string, eager: boolean): Record<string, { singleton: true; eager?: boolean; requiredVersion: string }> {
  const pkg = readProjectPkg(dir);
  const out: Record<string, { singleton: true; eager?: boolean; requiredVersion: string }> = {};
  for (const n of SHARED_SINGLETONS) {
    const v = pkg.dependencies?.[n] ?? (n === "react-router" ? pkg.dependencies?.["react-router-dom"] : undefined);
    if (!v) continue;
    // a vendored framework package (file: tarball) is shared at the version actually installed, never at a constant
    const installed = (() => { try { return (JSON.parse(readFileSync(join(dir, "node_modules", ...n.split("/"), "package.json"), "utf8")) as { version?: string }).version; } catch { return undefined; } })();
    const range = v.startsWith("file:") ? `^${installed ?? "0.2.0"}` : v.replace(/^[~^]?/, "^");
    out[n] = { singleton: true, requiredVersion: range, ...(eager ? { eager: true } : {}) };
  }
  return out;
}


async function baseRules(dir: string): Promise<Record<string, unknown>[]> {
  return [
    { test: /\.(tsx?|jsx?)$/, exclude: /node_modules/, loader: "builtin:swc-loader", type: "javascript/auto", options: { jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" } } },
    { test: /\.css$/, use: [{ loader: "postcss-loader", options: { postcssOptions: { plugins: [["@tailwindcss/postcss", { base: dir }]] } } }], type: "css/auto" },
    { test: /\.svg$/, type: "asset/resource" },
  ];
}

export interface FrontendBundleConfig { [k: string]: unknown }

/** The build toolchain belongs to the generated project (its own devDependencies), not to this package: it is resolved from the project. */
type Plugin = new (o: unknown) => unknown;
async function toolchain(dir: string): Promise<{ rspack: { HtmlRspackPlugin: Plugin; DefinePlugin: Plugin; CopyRspackPlugin: Plugin; SubresourceIntegrityPlugin: Plugin }; ModuleFederationPlugin: Plugin }> {
  const req = createRequire(join(dir, "package.json"));
  const load = async (spec: string): Promise<Record<string, unknown>> => {
    try { return (await import(pathToFileURL(req.resolve(spec)).href)) as Record<string, unknown>; }
    catch (e) { throw new Error(`cannot load "${spec}" from ${dir}: ${(e as Error).message}. Run \`npm install\` in the project`); }
  };
  const core = await load("@rspack/core");
  const mf = await load("@module-federation/enhanced/rspack");
  return { rspack: ((core["rspack"] ?? (core["default"] as Record<string, unknown>)?.["rspack"] ?? core["default"]) as never), ModuleFederationPlugin: mf["ModuleFederationPlugin"] as Plugin };
}

/** The configuration of a FEI: host with dynamic remotes, hashed assets, dev server proxying `/api`, runtime config served in development. */
export async function feiConfig(dir: string, overrides: { env?: NodeJS.ProcessEnv; devRuntimeConfig?: () => unknown } = {}): Promise<FrontendBundleConfig> {
  const env = buildEnv(overrides.env);
  const { rspack, ModuleFederationPlugin } = await toolchain(dir);
  const decl = readDecl(join(dir, FEI_FILE), "defineFEI");
  const def = decl.value as FeiDefinition | undefined;
  if (!def) throw new Error(`${FEI_FILE}: ${decl.diagnostics.map((d) => d.message).join("; ")}`);
  const routesDecl = existsSync(join(dir, ROUTES_FILE)) ? (readDecl(join(dir, ROUTES_FILE), "defineFrontendRoutes").value as FrontendRoutesDefinition | undefined) : undefined;
  generateFeiSources(dir, def, routesDecl);
  const production = env.mode === "production";
  const port = def.server?.port ?? DEFAULT_FEI_PORT;
  return {
    mode: env.mode, context: dir, entry: { main: "./src/main.tsx" }, target: "web",
    devtool: production ? false : "cheap-module-source-map",
    output: { crossOriginLoading: "anonymous", path: join(dir, "dist"), publicPath: env.basePath, filename: production ? "assets/[name].[contenthash:8].js" : "assets/[name].js", chunkFilename: production ? "assets/[name].[contenthash:8].js" : "assets/[name].js", cssFilename: production ? "assets/[name].[contenthash:8].css" : "assets/[name].css", cssChunkFilename: production ? "assets/[name].[contenthash:8].css" : "assets/[name].css", assetModuleFilename: "assets/[name].[contenthash:8][ext]", clean: true },
    resolve: { extensions: [".tsx", ".ts", ".jsx", ".js"], symlinks: true },
    module: { rules: await baseRules(dir) },
    experiments: { css: true },
    lazyCompilation: false, // on-demand compilation makes the dev server reload the page the first time a route chunk is built, which would end a memory-only session
    optimization: { splitChunks: { chunks: "async" }, runtimeChunk: false },
    performance: { hints: false },
    plugins: [
      new rspack.HtmlRspackPlugin({ template: join(dir, "index.html"), publicPath: env.basePath, scriptLoading: "defer", base: env.basePath === "/" ? false : { href: env.basePath } } as Record<string, unknown>),
      ...(production ? [new rspack.SubresourceIntegrityPlugin({ hashFuncNames: ["sha384"] })] : []),
      new rspack.DefinePlugin({ __PSO_DEV__: JSON.stringify(!production), __PSO_FEI__: JSON.stringify(def.name), __PSO_BASE_PATH__: JSON.stringify(env.basePath), __PSO_ALLOW_DEV_TOKEN__: JSON.stringify(!production || overrides.env?.["PSO_ALLOW_DEV_TOKEN"] === "1" || process.env["PSO_ALLOW_DEV_TOKEN"] === "1") }),
      new rspack.CopyRspackPlugin({ patterns: [{ from: join(dir, "public"), noErrorOnMissing: true }] }),
      new ModuleFederationPlugin({ name: ident(def.name), shared: sharedConfig(dir, true), manifest: false, dts: false }),
    ],
    devServer: {
      port, host: "localhost", hot: true, historyApiFallback: { index: `${env.basePath}index.html` }, allowedHosts: ["localhost"],
      proxy: [{ context: [def.orchestrator.basePath ?? "/api"], target: env.orchestratorUrl, pathRewrite: { [`^${def.orchestrator.basePath ?? "/api"}`]: "" }, ws: true, changeOrigin: false }],
      setupMiddlewares: (middlewares: Array<unknown> & { unshift(...a: unknown[]): void }) => {
        middlewares.unshift({ name: "pso-runtime-config", path: "/pso-runtime-config.json", middleware: (_req: unknown, res: { setHeader(k: string, v: string): void; end(s: string): void }) => { res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(overrides.devRuntimeConfig?.() ?? devRuntimeConfig(dir, def, env))); } });
        return middlewares;
      },
    },
  };
}

/** The runtime configuration the dev server publishes: remotes are the MEI projects next to this FEI, reached on their dev ports. Never used by a production build. */
export function devRuntimeConfig(dir: string, def: FeiDefinition, env: BuildEnv = buildEnv()): FrontendRuntimeConfig {
  const remotes: FrontendRuntimeConfig["remotes"] = {};
  const parent = resolve(dir, "..");
  const found = new Map<string, number>();
  for (const n of existsSync(parent) ? readdirSync(parent) : []) {
    const f = join(parent, n, MEI_FILE);
    if (!existsSync(f)) continue;
    const m = readDecl(f, "defineMEI").value as MeiDefinition | undefined;
    if (m?.name) found.set(m.name, m.server?.port ?? DEFAULT_MEI_PORT);
  }
  for (const mf of def.microfrontends) { const port = found.get(mf.name); if (port) remotes[mf.name] = { devEntry: `http://localhost:${port}/remoteEntry.js` }; }
  void env;
  return { schema: 1, fei: def.name, mode: "development", orchestrator: { basePath: def.orchestrator.basePath ?? "/api" }, remotes, auth: { kind: "dev-token" } };
}

/** The configuration of a MEI: federated remote exposing one module, hashed assets, dev server with CORS for the FEI only. */
export async function meiConfig(dir: string, overrides: { env?: NodeJS.ProcessEnv } = {}): Promise<FrontendBundleConfig> {
  const env = buildEnv(overrides.env);
  const { rspack, ModuleFederationPlugin } = await toolchain(dir);
  const decl = readDecl(join(dir, MEI_FILE), "defineMEI");
  const def = decl.value as MeiDefinition | undefined;
  if (!def) throw new Error(`${MEI_FILE}: ${decl.diagnostics.map((d) => d.message).join("; ")}`);
  const routesDecl = readDecl(join(dir, ROUTES_FILE), "defineFrontendRoutes").value as FrontendRoutesDefinition | undefined;
  if (!routesDecl) throw new Error(`${ROUTES_FILE} is missing or invalid: run pso frontend:validate`);
  generateMeiSources(dir, def, routesDecl);
  const production = env.mode === "production";
  const standalone = env.mode === "development" && process.env["PSO_MEI_STANDALONE"] === "1";
  const port = def.server?.port ?? DEFAULT_MEI_PORT;
  const feiPort = process.env["PSO_FEI_PORT"] ?? String(DEFAULT_FEI_PORT);
  const exposes = { "./module": def.expose?.module ?? "./src/module.tsx" };
  return {
    mode: env.mode, context: dir, entry: { main: standalone ? "./.pso/generated/standalone.tsx" : "./.pso/generated/empty.ts" }, target: "web",
    devtool: production ? false : "cheap-module-source-map",
    output: { crossOriginLoading: "anonymous", path: join(dir, "dist"), publicPath: "auto", filename: production ? "assets/[name].[contenthash:8].js" : "assets/[name].js", chunkFilename: production ? "assets/[name].[contenthash:8].js" : "assets/[name].js", cssFilename: production ? "assets/[name].[contenthash:8].css" : "assets/[name].css", cssChunkFilename: production ? "assets/[name].[contenthash:8].css" : "assets/[name].css", assetModuleFilename: "assets/[name].[contenthash:8][ext]", uniqueName: ident(def.name), clean: true },
    resolve: { extensions: [".tsx", ".ts", ".jsx", ".js"], symlinks: true },
    module: { rules: await baseRules(dir) },
    experiments: { css: true },
    lazyCompilation: false, // on-demand compilation makes the dev server reload the page the first time a route chunk is built, which would end a memory-only session
    optimization: { splitChunks: { chunks: "async" }, runtimeChunk: false },
    performance: { hints: false },
    plugins: [
      ...(production ? [new rspack.SubresourceIntegrityPlugin({ hashFuncNames: ["sha384"], htmlPlugin: false })] : []),
      new rspack.DefinePlugin({ __PSO_DEV__: JSON.stringify(!production), __PSO_MEI__: JSON.stringify(def.name), __PSO_HOST__: JSON.stringify(def.host) }),
      ...(standalone ? [new rspack.HtmlRspackPlugin({ templateContent: `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${def.name} (standalone)</title></head><body><div id="root"></div></body></html>` } as Record<string, unknown>)] : []),
      new ModuleFederationPlugin({ name: ident(def.name), filename: "remoteEntry.js", exposes, shared: sharedConfig(dir, false), manifest: true, dts: false }),
    ],
    devServer: {
      port, host: "localhost", hot: true, allowedHosts: ["localhost"], historyApiFallback: standalone,
      headers: { "Access-Control-Allow-Origin": `http://localhost:${feiPort}`, "Vary": "Origin", "Cache-Control": "no-store" },
      ...(standalone ? { proxy: [{ context: ["/api"], target: process.env["PSO_ORCHESTRATOR_URL"] ?? "http://localhost:3000", pathRewrite: { "^/api": "" }, ws: true }] } : {}),
    },
  };
}

/** `.pso/generated/empty.ts` and `standalone.tsx` (the development host adapter entry). */
export function generateMeiEntry(dir: string): void {
  const g = join(dir, ...GENERATED_DIR.split("/"));
  write(join(g, "empty.ts"), "// a MEI has no entry of its own: the host loads its exposed module\nexport {};\n");
  write(join(g, "standalone.tsx"), `// GENERATED: standalone development host. Compiled only when PSO_MEI_STANDALONE=1 (pso frontend:dev --standalone); never part of a build.
import { createMeiModule } from "@pso/frontend-react";
import { startStandalone } from "@pso/frontend-react/dev";
import mei from "./mei";
import "./standalone.css";
startStandalone(createMeiModule(mei));
`);
  write(join(g, "standalone.css"), `/* GENERATED: standalone host styles. In the FEI the shell provides the reset and the design tokens; here this file stands in for it. */
@import "tailwindcss";
@import "../../src/styles/index.css";
`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// release manifest

function walkFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n), r = base ? `${base}/${n}` : n;
    if (statSync(p).isDirectory()) out.push(...walkFiles(p, r)); else out.push(r);
  }
  return out;
}
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export interface BuildManifestOptions { dir: string; definition: MeiDefinition; routes: ResolvedRoute[]; version: string; signWith?: { keyId: string; privateKeyPem: string } }
/** Writes `dist/pso-manifest.json`: the hashed file list of a MEI release, optionally signed with an ed25519 key. */
export function buildRemoteManifest(o: BuildManifestOptions): RemoteManifest {
  const dist = join(o.dir, "dist");
  if (!existsSync(join(dist, "remoteEntry.js"))) throw new Error(`${dist}/remoteEntry.js not found: build the MEI first (pso frontend:build)`);
  const files = walkFiles(dist).filter((f) => f !== "pso-manifest.json").map((f) => { const b = readFileSync(join(dist, ...f.split("/"))); return { path: f, sha256: sha256(b), size: b.length }; });
  const m: RemoteManifest = {
    schema: 1, kind: "pso-mei-manifest", name: o.definition.name, host: o.definition.host, version: o.version,
    contract: { context: o.definition.contract?.context ?? CONTEXT_CONTRACT_VERSION }, entry: "remoteEntry.js", expose: "./module",
    shared: installedVersions(o.dir), scopes: o.definition.security?.scopes ?? [],
    routes: o.routes.map((r) => ({ path: r.path, ...(r.title !== undefined ? { title: r.title } : {}) })), files, createdAt: new Date().toISOString(),
  };
  if (o.signWith) m.signature = { keyId: o.signWith.keyId, alg: "ed25519", value: b64u.encode(new Uint8Array(edSign(null, Buffer.from(canonicalManifest(m)), createPrivateKey(o.signWith.privateKeyPem)))) };
  writeFileSync(join(dist, "pso-manifest.json"), JSON.stringify(m, null, 2) + "\n");
  return m;
}

/** Raw ed25519 public key (base64url) of a PEM key, in the form the runtime config's `trustedKeys` uses. */
export function publicKeyRaw(pem: string): string {
  const der = createPublicKey(pem.includes("PRIVATE") ? createPrivateKey(pem) : pem).export({ format: "der", type: "spki" });
  return b64u.encode(new Uint8Array(der.subarray(der.length - 32)));
}

/** Writes .pso/generated for the FEI or MEI project in `dir`. Returns the names of the files written. */
export function generateProject(dir: string): string[] {
  const root = resolve(dir);
  if (existsSync(join(root, FEI_FILE))) {
    const def = readDecl(join(root, FEI_FILE), "defineFEI").value as FeiDefinition | undefined;
    if (!def) throw new Error(`${FEI_FILE} cannot be read`);
    const routes = existsSync(join(root, ROUTES_FILE)) ? (readDecl(join(root, ROUTES_FILE), "defineFrontendRoutes").value as FrontendRoutesDefinition | undefined) : undefined;
    return generateFeiSources(root, def, routes);
  }
  if (existsSync(join(root, MEI_FILE))) {
    const def = readDecl(join(root, MEI_FILE), "defineMEI").value as MeiDefinition | undefined;
    const routes = readDecl(join(root, ROUTES_FILE), "defineFrontendRoutes").value as FrontendRoutesDefinition | undefined;
    if (!def || !routes) throw new Error(`${MEI_FILE} or ${ROUTES_FILE} cannot be read`);
    generateMeiEntry(root);
    return generateMeiSources(root, def, routes);
  }
  throw new Error(`no ${FEI_FILE} or ${MEI_FILE} in ${root}`);
}

export * from "./release.ts";
import type { FeiRelease } from "./release.ts";

/**
 * Writes `dist/pso-fei.json`: the FEI's release manifest (every file with its hash, the shared-context contract, the exact shared
 * dependency versions, the mounts and the base path), produced by the build exactly like a MEI's manifest, so publishing - by the CLI or
 * by the native cloud deployment - needs no source tree and no node_modules.
 */
export function buildFeiManifest(o: { dir: string; definition: FeiDefinition; version: string; basePath: string }): FeiRelease {
  const dist = join(o.dir, "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist}/index.html not found: build the FEI first (pso frontend:build)`);
  const files = walkFiles(dist).filter((f) => f !== "pso-fei.json").map((f) => { const b = readFileSync(join(dist, ...f.split("/"))); return { path: f, sha256: sha256(b), size: b.length }; });
  const rel: FeiRelease = {
    schema: 1, kind: "pso-fei-release", name: o.definition.name, version: o.version, contract: CONTEXT_CONTRACT_VERSION, shared: installedVersions(o.dir),
    mounts: o.definition.microfrontends.map((m) => ({ name: m.name, path: m.path })), basePath: o.basePath, files, createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dist, "pso-fei.json"), JSON.stringify(rel, null, 2) + "\n");
  return rel;
}
