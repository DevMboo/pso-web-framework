import { diag, cmp, type Diagnostic } from "./diagnostics.ts";

/**
 * Neutral description of the HTTP modules of an orchestrator. It is built from the TypeScript AST by
 * the CLI (static validation, nothing is executed) and from decorator metadata by the runtime. Both feed the
 * SAME validator below, so the invariant is enforced identically at build time and at start-up:
 *
 *   an endpoint exists if and only if it is declared in ROUTES.pso.ts, belongs to a valid module (MODULE.pso.ts),
 *   references a compatible decorated controller action, and passes every security and dependency validation.
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ActionModel { name: string; method?: string; path?: string; public?: boolean; guards?: string[]; scopes?: string[]; roles?: string[] }
export interface ControllerModel {
  name: string;
  /** has @Controller() / @RestController() */
  decorated: boolean;
  prefix?: string;
  public?: boolean;
  guards?: string[];
  scopes?: string[];
  roles?: string[];
  actions: ActionModel[];
  /** constructor dependency class names */
  deps: string[];
}
export interface ProviderModel { name: string; deps: string[] }
export interface RouteDecl {
  method: string;
  path: string;
  controller: string;
  action: string;
  public?: boolean;
  guards?: string[];
  scopes?: string[];
  roles?: string[];
  middleware?: string[];
  interceptors?: string[];
  filters?: string[];
  version?: string;
  /** upstream service the action forwards to (informational + enforced by the runtime) */
  service?: string;
  /** upstream services the action calls through UpstreamClient to compose its response (enforced by the runtime) */
  services?: string[];
  /** optional response contract (status -> DTO expression), published to typed frontends; metadata only */
  responses?: Record<string, string>;
}
export interface ModuleModel {
  /** directory name under routes/ */
  dir: string;
  moduleFile?: string;
  routesFile?: string;
  hasModule: boolean;
  hasRoutes: boolean;
  name?: string;
  controllers: string[];
  providers: string[];
  exports: string[];
  imports: string[];
  /** MODULE.pso.ts references this directory's own ROUTES.pso */
  routesFromOwnRegistry: boolean;
  /** every controller class found (declared or not) */
  controllerModels: ControllerModel[];
  providerModels: ProviderModel[];
  /** controller classes present in the module directory but missing from `controllers` (static analysis only) */
  undeclaredControllers: string[];
  routes: RouteDecl[];
  /** module-level policy: requirements that apply to every route of the module (they can only add, never remove) */
  security?: { guards?: string[]; scopes?: string[]; roles?: string[] };
  shapeErrors: string[];
}

export interface ModelContext {
  /** names of available guards / middleware / filters */
  guards: ReadonlySet<string>;
  middleware: ReadonlySet<string>;
  filters: ReadonlySet<string>;
  /** names of available interceptors (optional for callers that predate them: a route naming one is then unknown) */
  interceptors?: ReadonlySet<string>;
  /** classes the framework provides to every module (e.g. Upstream) */
  builtins: ReadonlySet<string>;
  /** framework default policy: a route with no explicit security inherits this guard ("authenticated"). Undefined = such routes are rejected. */
  defaultGuard?: string;
}

export interface ActiveRoute {
  module: string;
  method: HttpMethod;
  /** final path including the optional /v<version> prefix */
  path: string;
  controller: string;
  action: string;
  public: boolean;
  guards: string[];
  /** every scope must be present */
  scopes: string[];
  /** AND of ORs: each set (module, controller, action, route) needs at least one of its roles */
  roleSets: string[][];
  middleware: string[];
  interceptors: string[];
  filters: string[];
  version?: string;
  service?: string;
  /** services the action may call through UpstreamClient (metadata.services) */
  services?: string[];
}

export const normalizePath = (p: string): string => {
  const s = ("/" + p).replace(/\/+/g, "/");
  return s.length > 1 ? s.replace(/\/$/, "") : s;
};
export const joinPaths = (a: string, b: string): string => normalizePath(`${a}/${b}`);
/** the path a method decorator needs so that prefix + path equals `full` */
const relativeTo = (prefix: string, full: string): string => {
  const p = normalizePath(prefix);
  if (p === "/") return full;
  return full === p ? "/" : full.startsWith(p + "/") ? full.slice(p.length) : full;
};
const signature = (p: string): string => p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":");
const decorator = (method: string | undefined, path: string | undefined): string =>
  method ? `@${method.charAt(0)}${method.slice(1).toLowerCase()}("${path ?? ""}")` : "(none)";
const uniq = <T>(a: T[]): T[] => [...new Set(a)];

function fail(code: string, title: string, d: { module: string; route?: string; controller?: string; action?: string; expected?: string; found?: string; reason?: string }, file: string | undefined, denied = "Route activation denied."): Diagnostic {
  const lines = [title, "", `Module: ${d.module}`, ...(d.route ? [`Route: ${d.route}`] : []), ...(d.controller ? [`Controller: ${d.controller}`] : []), ...(d.action ? [`Action: ${d.action}`] : [])];
  if (d.expected !== undefined) lines.push("", `Expected: ${d.expected}`, `Found: ${d.found ?? "(nothing)"}`);
  if (d.reason) lines.push("", d.reason);
  lines.push("", denied);
  return diag("error", code, lines.join("\n"), file);
}

export interface ModelResult { diagnostics: Diagnostic[]; routes: ActiveRoute[]; ok: boolean }

/** The single authority on whether an endpoint may exist. Pure: no I/O, no execution. */
export function validateModules(mods: readonly ModuleModel[], ctx: ModelContext): ModelResult {
  const out: Diagnostic[] = [];
  const candidates: ActiveRoute[] = [];
  const seenNames = new Set<string>();
  for (const m of mods) {
    if (!m.hasModule || !m.name) continue;
    if (seenNames.has(m.name)) out.push(fail("PSO_MODULE_004", "Duplicate module name.", { module: m.dir, reason: `Another module is already named "${m.name}" ("health" is reserved by the framework).` }, m.moduleFile));
    seenNames.add(m.name);
  }
  const byName = new Map(mods.filter((m) => m.hasModule && m.name).map((m) => [m.name!, m]));

  for (const m of [...mods].sort((a, b) => cmp(a.dir, b.dir))) {
    const mod = m.dir;
    const file = m.routesFile ?? m.moduleFile;
    if (!m.hasModule) {
      out.push(fail("PSO_MODULE_001", "Module declaration missing.", { module: mod, reason: `The directory routes/${mod}/ contains HTTP code but no MODULE.pso.ts. There is no fallback discovery.` }, m.routesFile, "No route of this directory is activated."));
      continue;
    }
    if (!m.hasRoutes) {
      out.push(fail("PSO_MODULE_002", "Route registry missing.", { module: mod, reason: `routes/${mod}/ROUTES.pso.ts does not exist. Controllers are never exposed without an explicit route registry.` }, m.moduleFile, "No route of this module is activated."));
      continue;
    }
    for (const e of m.shapeErrors) out.push(fail("PSO_MODULE_004", "Invalid module declaration.", { module: mod, reason: e }, m.moduleFile));
    if (m.name !== undefined && m.name !== mod) out.push(fail("PSO_MODULE_004", "Invalid module declaration.", { module: mod, expected: `name: "${mod}"`, found: `name: "${m.name}"` }, m.moduleFile));
    if (!m.routesFromOwnRegistry) out.push(fail("PSO_MODULE_005", "Module does not reference its route registry.", { module: mod, expected: `routes: <default export of ./ROUTES.pso>`, found: "a different or missing value" }, m.moduleFile));
    for (const c of m.undeclaredControllers) out.push(fail("PSO_MODULE_003", "Controller is not declared in MODULE.pso.ts.", { module: mod, controller: c, reason: "A controller absent from the module declaration is never registered." }, m.moduleFile, "Controller rejected."));
    for (const imp of m.imports) if (!byName.has(imp)) out.push(fail("PSO_MODULE_008", "Imported module not found.", { module: mod, expected: "an existing module under routes/", found: imp }, m.moduleFile));

    // dependency resolution (check 7)
    const available = new Set([...m.providers, ...ctx.builtins, ...m.imports.flatMap((i) => byName.get(i)?.exports ?? [])]);
    const deps = new Map<string, string[]>();
    for (const p of m.providerModels.filter((x) => m.providers.includes(x.name))) deps.set(p.name, p.deps);
    for (const c of m.controllerModels.filter((x) => m.controllers.includes(x.name))) deps.set(c.name, c.deps);
    for (const [owner, ds] of deps) for (const d of ds) if (!available.has(d)) out.push(fail("PSO_MODULE_006", "Dependency cannot be resolved.", { module: mod, controller: owner, expected: `${d} listed in providers or exported by an imported module`, found: "not available in this module" }, m.moduleFile, "Module activation denied."));
    const cycle = findProviderCycle(deps, m.providers);
    if (cycle) out.push(fail("PSO_MODULE_007", "Circular provider dependency.", { module: mod, reason: cycle.join(" -> ") }, m.moduleFile, "Module activation denied."));

    // route-by-route validation (checks 1-6, 8, 9)
    for (const r of m.routes) {
      const label = `${r.method} ${r.path}`;
      const base = { module: mod, route: label, controller: r.controller, action: r.action };
      if (!(HTTP_METHODS as readonly string[]).includes(r.method) || !r.path.startsWith("/") || /[\s?#]/.test(r.path)) {
        out.push(fail("PSO_ROUTE_009", "Invalid route declaration.", { ...base, reason: `method must be one of ${HTTP_METHODS.join(", ")} and path must start with "/" without spaces, "?" or "#".` }, m.routesFile));
        continue;
      }
      const cm = m.controllerModels.find((c) => c.name === r.controller);
      if (!m.controllers.includes(r.controller) || !cm) {
        out.push(fail("PSO_ROUTE_001", "Route references a controller that is not part of the module.", { ...base, expected: `${r.controller} listed in MODULE.pso.ts controllers`, found: m.controllers.includes(r.controller) ? "the controller class could not be found" : `controllers: [${m.controllers.join(", ")}]` }, m.routesFile));
        continue;
      }
      const act = cm.actions.find((a) => a.name === r.action);
      if (!act) { out.push(fail("PSO_ROUTE_002", "Controller action does not exist.", { ...base, expected: `method ${r.action}() on ${r.controller}`, found: `actions: ${cm.actions.map((a) => a.name).join(", ") || "(none)"}` }, m.routesFile)); continue; }
      if (!cm.decorated) { out.push(fail("PSO_ROUTE_003", "Controller is not decorated.", { ...base, expected: "@Controller() and @RestController(prefix)", found: "no controller decorator" }, m.routesFile)); continue; }
      if (!act.method) { out.push(fail("PSO_ROUTE_003", "Action has no HTTP decorator.", { ...base, expected: decorator(r.method, "..."), found: "no @Get/@Post/@Put/@Patch/@Delete decorator" }, m.routesFile)); continue; }
      const resolved = joinPaths(cm.prefix ?? "", act.path ?? "/");
      let ok = true;
      if (act.method !== r.method) {
        out.push(fail("PSO_ROUTE_004", "Route declaration mismatch.", { ...base, expected: decorator(r.method, relativeTo(cm.prefix ?? "", normalizePath(r.path))), found: decorator(act.method, act.path) }, m.routesFile));
        ok = false;
      }
      if (normalizePath(r.path) !== resolved) {
        out.push(fail("PSO_ROUTE_005", "Route path does not match the controller.", { ...base, expected: `path "${resolved}" (from @RestController("${cm.prefix ?? ""}") + ${decorator(act.method, act.path)})`, found: `path "${r.path}"` }, m.routesFile));
        ok = false;
      }
      // security (check 8). Precedence is fixed and every level can only ADD requirements:
      //   framework default < module < controller < action < route declaration. Nothing can downgrade a protected route.
      let guards = uniq([...(m.security?.guards ?? []), ...(cm.guards ?? []), ...(act.guards ?? []), ...(r.guards ?? [])]);
      const scopes = uniq([...(m.security?.scopes ?? []), ...(cm.scopes ?? []), ...(act.scopes ?? []), ...(r.scopes ?? [])]);
      const roleSets = [m.security?.roles, cm.roles, act.roles, r.roles].filter((x): x is string[] => !!x && x.length > 0);
      const isPublic = r.public === true || cm.public === true || act.public === true;
      const restricts = guards.length > 0 || scopes.length > 0 || roleSets.length > 0;
      if (isPublic && restricts) {
        out.push(fail("PSO_ROUTE_007", "Security policy conflict.", { ...base, reason: `The route is public but also requires authentication or authorization (${[...guards, ...scopes.map((x) => `scope:${x}`), ...roleSets.map((x) => `role:${x.join("|")}`)].join(", ")}). A declaration must never weaken a protected endpoint.` }, m.routesFile)); ok = false;
      } else if (!isPublic) {
        if (guards.length === 0) {
          if (ctx.defaultGuard) guards = [ctx.defaultGuard]; // framework default policy: authenticated
          else { out.push(fail("PSO_ROUTE_007", restricts ? "Authorization requirements without an authentication guard." : "Route has no security policy.", { ...base, reason: "Deny by default: declare `public: true` explicitly or require a guard (guards: [\"jwt\"])." }, m.routesFile)); ok = false; }
        }
      }
      for (const [kind, names, known] of [["guard", guards, ctx.guards], ["middleware", r.middleware ?? [], ctx.middleware], ["interceptor", r.interceptors ?? [], ctx.interceptors ?? new Set<string>()], ["filter", r.filters ?? [], ctx.filters]] as const) {
        for (const n of names) if (!known.has(n)) { out.push(fail("PSO_ROUTE_008", `Unknown ${kind}.`, { ...base, expected: `an existing ${kind} named "${n}"`, found: `available: ${[...known].sort().join(", ") || "(none)"}` }, m.routesFile)); ok = false; }
      }
      if (!ok) continue;
      candidates.push({
        module: mod, method: r.method as HttpMethod, path: r.version ? joinPaths(`/v${r.version}`, resolved) : resolved, controller: r.controller, action: r.action,
        public: isPublic, guards, scopes, roleSets, middleware: r.middleware ?? [], interceptors: r.interceptors ?? [], filters: r.filters ?? [],
        ...(r.version ? { version: r.version } : {}), ...(r.service ? { service: r.service } : {}), ...(r.services?.length ? { services: [...r.services] } : {}),
      });
    }
  }

  // check 9: duplicate / conflicting declarations (path parameters with different names still collide)
  const seen = new Map<string, ActiveRoute>();
  for (const r of candidates) {
    const key = `${r.method} ${signature(r.path)}`;
    const prev = seen.get(key);
    if (prev) out.push(fail("PSO_ROUTE_006", "Duplicate or conflicting route declaration.", { module: r.module, route: `${r.method} ${r.path}`, controller: r.controller, action: r.action, reason: `Conflicts with ${prev.method} ${prev.path} declared by ${prev.controller}.${prev.action} in module ${prev.module}.` }, undefined));
    else seen.set(key, r);
  }

  const diagnostics = out.sort((a, b) => cmp(a.code, b.code) || cmp(a.message, b.message));
  const ok = diagnostics.every((d) => d.severity !== "error");
  // fail closed: when anything is wrong nothing is activated
  return { diagnostics, routes: ok ? candidates.sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method)) : [], ok };
}

function findProviderCycle(deps: Map<string, string[]>, providers: string[]): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    state.set(n, 1); stack.push(n);
    for (const d of deps.get(n) ?? []) {
      if (!providers.includes(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) { const c = visit(d); if (c) return c; }
    }
    stack.pop(); state.set(n, 2);
    return undefined;
  };
  for (const p of providers) if (!state.has(p)) { const c = visit(p); if (c) return c; }
  return undefined;
}

// ---- authoring helper exported as @pso/core `defineModule` ----

export interface ModuleDefinition {
  name: string;
  controllers?: readonly Function[];
  providers?: readonly Function[];
  /** @Channel classes of PSO Channels. A decorated class is inactive until it is listed here. */
  channels?: readonly Function[];
  /** the module's own ROUTES.pso default export */
  routes: { readonly routes: readonly unknown[] };
  imports?: readonly ModuleDefinition[];
  exports?: readonly Function[];
  /** module-level security: requirements added to every route of the module (they can only add, never weaken) */
  security?: { guards?: readonly string[]; scopes?: readonly string[]; roles?: readonly string[] };
}
export const MODULE_BRAND = Symbol.for("pso.module");

/** Declares an HTTP module. Validates the shape at load time; the full invariant is enforced by validateModules. */
export function defineModule<T extends ModuleDefinition>(def: T): Readonly<T> & { readonly [MODULE_BRAND]: true } {
  if (!def || typeof def !== "object") throw new Error("defineModule() expects an object");
  if (typeof def.name !== "string" || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(def.name)) throw new Error(`defineModule(): "name" must be kebab-case (got ${JSON.stringify(def.name)})`);
  for (const k of ["controllers", "providers", "channels", "imports", "exports"] as const) {
    const v = def[k];
    if (v !== undefined && !Array.isArray(v)) throw new Error(`defineModule("${def.name}"): "${k}" must be an array`);
  }
  if (!def.routes || !Array.isArray((def.routes as { routes?: unknown }).routes)) throw new Error(`defineModule("${def.name}"): "routes" must be the default export of ROUTES.pso (defineRoutes(...))`);
  return Object.freeze({ ...def, [MODULE_BRAND]: true as const });
}
