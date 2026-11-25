import "reflect-metadata";
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ActionModel, ControllerModel, ModuleModel, ProviderModel, RouteDecl, ModuleDefinition } from "@pso/core";
import { K, readMeta, type HttpBinding } from "./decorators.ts";
import type { RoutesDefinition, RouteEntry } from "./routes.ts";

type Ctor = (abstract new (...args: never[]) => unknown) & { name: string };
const proto = (c: Ctor) => (c as unknown as { prototype: object }).prototype;

const depsOf = (c: Ctor): string[] => {
  const t = Reflect.getMetadata("design:paramtypes", c) as Array<{ name?: string } | undefined> | undefined;
  return (t ?? []).map((x) => x?.name ?? "Object");
};

export function controllerModel(c: Ctor): ControllerModel {
  const bindings = readMeta<HttpBinding[]>(K.routes, c) ?? [];
  const actions: ActionModel[] = Object.getOwnPropertyNames(proto(c)).filter((n) => n !== "constructor" && typeof (proto(c) as Record<string, unknown>)[n] === "function").map((name) => {
    const b = bindings.find((x) => x.action === name);
    const guards = readMeta<string[]>(K.guards, proto(c), name);
    const scopes = readMeta<string[]>(K.scopes, proto(c), name);
    const roles = readMeta<string[]>(K.roles, proto(c), name);
    return { name, ...(b ? { method: b.method, path: b.path } : {}), ...(readMeta<boolean>(K.pub, proto(c), name) ? { public: true } : {}), ...(guards ? { guards } : {}), ...(scopes ? { scopes } : {}), ...(roles ? { roles } : {}) };
  });
  const guards = readMeta<string[]>(K.guards, c);
  const scopes = readMeta<string[]>(K.scopes, c);
  const classRoles = readMeta<string[]>(K.roles, c);
  const prefix = readMeta<string>(K.prefix, c);
  return {
    name: c.name, decorated: readMeta<boolean>(K.controller, c) === true && prefix !== undefined, ...(prefix !== undefined ? { prefix } : {}),
    ...(readMeta<boolean>(K.pub, c) ? { public: true } : {}), ...(guards ? { guards } : {}), ...(scopes ? { scopes } : {}), ...(classRoles ? { roles: classRoles } : {}), actions, deps: depsOf(c),
  };
}

const routeDecl = (r: RouteEntry): RouteDecl => ({
  method: r.method, path: r.path, controller: r.controller.name, action: r.action,
  ...(r.security?.public ? { public: true } : {}),
  guards: [...(r.security?.guard ? [r.security.guard] : []), ...(r.guards ?? [])],
  ...(r.security?.scopes ? { scopes: [...r.security.scopes] } : {}), ...(r.security?.roles ? { roles: [...r.security.roles] } : {}),
  ...(r.middleware ? { middleware: [...r.middleware] } : {}), ...(r.interceptors ? { interceptors: [...r.interceptors] } : {}), ...(r.filters ? { filters: [...r.filters] } : {}),
  ...(r.version ? { version: r.version } : {}), ...(typeof r.metadata?.service === "string" ? { service: r.metadata.service } : {}),
  ...(Array.isArray(r.metadata?.services) ? { services: r.metadata.services.filter((x): x is string => typeof x === "string") } : {}),
});

/** Builds the neutral model of one module from already-loaded definitions (used by the runtime and by tests). */
export function modelFromDefinitions(dir: string, def: ModuleDefinition | undefined, routes: RoutesDefinition | undefined, extra: { shapeErrors?: string[]; moduleFile?: string; routesFile?: string } = {}): ModuleModel {
  const controllers = (def?.controllers ?? []) as Ctor[];
  const providers = (def?.providers ?? []) as Ctor[];
  const referenced = new Set<Ctor>([...controllers, ...((routes?.routes ?? []).map((r) => r.controller) as Ctor[])]);
  return {
    dir, hasModule: def !== undefined, hasRoutes: routes !== undefined, ...(def ? { name: def.name } : {}),
    ...(extra.moduleFile ? { moduleFile: extra.moduleFile } : {}), ...(extra.routesFile ? { routesFile: extra.routesFile } : {}),
    controllers: controllers.map((c) => c.name), providers: providers.map((c) => c.name), exports: ((def?.exports ?? []) as Ctor[]).map((c) => c.name),
    imports: (def?.imports ?? []).map((i) => i.name),
    routesFromOwnRegistry: def !== undefined && routes !== undefined && def.routes === routes,
    controllerModels: [...referenced].map(controllerModel),
    providerModels: providers.map((p): ProviderModel => ({ name: p.name, deps: depsOf(p) })),
    undeclaredControllers: [], routes: (routes?.routes ?? []).map(routeDecl), ...(def?.security ? { security: { ...(def.security.guards ? { guards: [...def.security.guards] } : {}), ...(def.security.scopes ? { scopes: [...def.security.scopes] } : {}), ...(def.security.roles ? { roles: [...def.security.roles] } : {}) } } : {}), shapeErrors: extra.shapeErrors ?? [],
  };
}

export interface LoadedModule { model: ModuleModel; def: ModuleDefinition | undefined; routes: RoutesDefinition | undefined; ignoredControllerFiles: string[] }

export interface LoadModulesOptions {
  /** ROUTES.pso of a module relative to its directory, without extension: "ROUTES.pso" (0.1) or "routes/ROUTES.pso" (modular) */
  routesFile?: string;
  /** the name of the modules directory, for diagnostics ("routes" or "modules") */
  label?: string;
}

/**
 * Loads the compiled modules of `modulesDir` (dist/modules, or dist/routes in the 0.1 structure). Only MODULE.pso.js and ROUTES.pso.js of
 * each module are loaded; controller files are reached exclusively through the module declaration, so an undeclared controller is
 * never even required, let alone registered.
 */
export function loadModules(modulesDir: string, options: LoadModulesOptions = {}): LoadedModule[] {
  if (!existsSync(modulesDir)) return [];
  const routesRel = options.routesFile ?? "ROUTES.pso";
  const label = options.label ?? "routes";
  const req = createRequire(join(modulesDir, "noop.js"));
  const out: LoadedModule[] = [];
  for (const dir of readdirSync(modulesDir).sort()) {
    const d = join(modulesDir, dir);
    if (!statSync(d).isDirectory()) continue;
    const files = readdirSync(d);
    const moduleFile = join(d, "MODULE.pso.js"), routesFile = join(d, ...`${routesRel}.js`.split("/"));
    const hasModule = files.includes("MODULE.pso.js"), hasRoutes = existsSync(routesFile);
    // controllers live next to MODULE.pso (0.1) or in controllers/ (modular)
    const ctrlDir = existsSync(join(d, "controllers")) ? "controllers/" : "";
    const controllerFiles = (ctrlDir ? readdirSync(join(d, "controllers")) : files).filter((f) => f.endsWith(".controller.js"));
    if (!hasModule && !hasRoutes && controllerFiles.length === 0) continue; // not an HTTP module directory
    const shapeErrors: string[] = [];
    let def: ModuleDefinition | undefined, routes: RoutesDefinition | undefined;
    if (hasRoutes) { try { routes = (req(routesFile) as { default?: RoutesDefinition }).default; } catch (e) { shapeErrors.push(`ROUTES.pso could not be loaded: ${(e as Error).message}`); } }
    if (hasModule) { try { def = (req(moduleFile) as { default?: ModuleDefinition }).default; } catch (e) { shapeErrors.push(`MODULE.pso could not be loaded: ${(e as Error).message}`); } }
    if (hasModule && !def && shapeErrors.length === 0) shapeErrors.push("MODULE.pso must default-export defineModule({...})");
    const m = modelFromDefinitions(dir, def, hasRoutes ? (routes ?? ({ routes: [] } as RoutesDefinition)) : undefined, { shapeErrors, moduleFile: `${label}/${dir}/MODULE.pso`, routesFile: `${label}/${dir}/${routesRel}` });
    // a directory with controllers but no MODULE: report it, never register it
    out.push({ model: { ...m, hasModule }, def, routes, ignoredControllerFiles: controllerFiles.map((f) => `${label}/${dir}/${ctrlDir}${f}`) });
  }
  return out;
}
