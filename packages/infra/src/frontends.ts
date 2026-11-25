import type { WorkspaceConfig } from "@pso/core";
import { loadFrontends } from "@pso/frontend/node";
import type { FrontendInfo } from "./topology.ts";

/** Reads every FEI of the workspace statically (FEI.pso.ts, ROUTES.pso.ts and the MEIs it mounts): nothing is executed. */
export function readFrontends(root: string, ws: WorkspaceConfig): { frontends: FrontendInfo[]; scopes: string[] } {
  if (!ws.frontends?.length) return { frontends: [], scopes: [] };
  const loaded = loadFrontends(root, ws.frontends);
  const scopes = new Set<string>();
  const frontends = loaded.feis.map((f): FrontendInfo => {
    const own: string[] = [];
    for (const m of f.definition.microfrontends) for (const s of m.scopes ?? []) { own.push(s); scopes.add(s); }
    for (const m of loaded.meis.filter((x) => x.definition.host === f.definition.name)) for (const s of m.definition.security?.scopes ?? []) scopes.add(s);
    const routes: string[] = [];
    const walk = (rs: Array<{ path: string; scopes?: string[]; children?: unknown[] }>, base: string) => { for (const r of rs) { for (const s of r.scopes ?? []) scopes.add(s); const p = `${base}/${r.path}`.replace(/\/+/g, "/"); if (/\.[A-Za-z0-9]+$|\/:[^/]+$/.test(p)) routes.push(p); if (Array.isArray(r.children)) walk(r.children as typeof rs, p); } };
    if (f.routes) walk(f.routes.routes as never, "");
    return {
      name: f.definition.name, port: f.definition.server?.port ?? f.project.port ?? 4200, authentication: f.definition.security?.authentication ?? "jwt",
      microfrontends: f.definition.microfrontends.map((m) => m.name), scopes: own, orchestratorBasePath: f.definition.orchestrator.basePath ?? "/api", routes: routes.filter((r) => r !== "/"),
    };
  });
  return { frontends, scopes: [...scopes].sort() };
}
