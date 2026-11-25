import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { diag, sortDiagnostics, type Diagnostic } from "./diagnostics.ts";
import { findCycles } from "./graph.ts";

export const WORKSPACE_FILE = "pso.workspace.json";

export type ServiceRuntime = "node" | "spring-boot";

export interface ServiceDecl {
  name: string;
  /** path relative to the workspace root */
  path: string;
  runtime: ServiceRuntime;
  /** the orchestrator is the single public entry point */
  role?: "orchestrator" | "service";
  port: number;
  dependsOn?: string[];
  /**
   * Endpoint prefix of the service (e.g. /users). Spring services apply it themselves (pso.service.prefix); the orchestrator adds it
   * when forwarding. Default for spring-boot services: derived from the name (users-service becomes /users). "/" means no prefix.
   */
  prefix?: string;
  health?: string;
  /** database the service owns (each service owns its data; databases are never shared by default) */
  db?: "postgres";
  /** explicit dev command (argv, no shell); defaults come from the runtime */
  dev?: { command: string[] };
  /**
   * The structural convention of the project: "modular" (orchestrator, src/.app + src/modules), "layered" (Spring, application/ +
   * infrastructure/ + shared/) or "legacy" (the 0.1 layouts). Optional: the files decide; a declaration that the files contradict is an error.
   */
  structure?: "modular" | "layered" | "legacy";
}

/** A frontend project: the application shell (FEI) or a microfrontend (MEI). Their contracts live in FEI.pso.ts / MEI.pso.ts. */
export interface FrontendDecl {
  name: string;
  kind: "fei" | "mei";
  /** path relative to the workspace root */
  path: string;
  /** development server port */
  port: number;
}

export interface WorkspaceConfig {
  schemaVersion: 1;
  name: string;
  services: ServiceDecl[];
  /** frontend projects (optional: workspaces without a frontend do not have this member) */
  frontends?: FrontendDecl[];
  /** workspace-level configuration (layer 2) */
  config?: Record<string, unknown>;
}

export const findWorkspaceRoot = (from: string): string | undefined => {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
};

export function loadWorkspace(root: string): { config?: WorkspaceConfig; diagnostics: Diagnostic[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, WORKSPACE_FILE), "utf8").replace(/^﻿/, "")); // editors on Windows may add a BOM
  } catch (e) {
    return { diagnostics: [diag("error", "PSO_WORKSPACE_UNREADABLE", `Cannot read ${WORKSPACE_FILE}: ${(e as Error).message}`)] };
  }
  const ds = validateWorkspaceShape(raw);
  return ds.some((d) => d.severity === "error") ? { diagnostics: ds } : { config: raw as WorkspaceConfig, diagnostics: ds };
}

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PREFIX = /^(\/[a-z0-9][a-z0-9._~-]*)+$/;

/** Normalizes a service prefix like the Java starter does: leading slash, no duplicate or trailing slashes; "" and "/" mean none. Throws on invalid input. */
export function normalizePrefix(raw: string): string {
  let p = raw.trim().replace(/\/+/g, "/");
  if (p === "" || p === "/") return "";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  if (p.split("/").some((s) => s === "." || s === "..") || !PREFIX.test(p)) throw new Error(`invalid prefix "${raw}": use lower-case letters, digits and . _ ~ - separated by /`);
  return p;
}

/** users-service becomes /users; notification-service becomes /notification; other names are used as is. */
export function derivePrefix(serviceName: string): string {
  const base = serviceName.endsWith("-service") && serviceName.length > 8 ? serviceName.slice(0, -8) : serviceName;
  return normalizePrefix(`/${base}`);
}

/** The effective prefix of a service: explicit, else derived for Spring Boot services, else none. */
export function servicePrefix(s: Pick<ServiceDecl, "name" | "runtime" | "prefix">): string {
  return s.prefix !== undefined ? normalizePrefix(s.prefix) : s.runtime === "spring-boot" ? derivePrefix(s.name) : "";
}

export function validateWorkspaceShape(raw: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (c: string, m: string, h?: string) => out.push(diag("error", c, m, WORKSPACE_FILE, h));
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) return [diag("error", "PSO_WORKSPACE_SHAPE", "Workspace file must be a JSON object", WORKSPACE_FILE)];
  if (o["schemaVersion"] !== 1) err("PSO_SCHEMA_VERSION", `Unsupported schemaVersion ${JSON.stringify(o["schemaVersion"])} (this CLI supports 1)`, "Migrate the workspace file or upgrade @pso/cli");
  if (typeof o["name"] !== "string" || !NAME.test(o["name"])) err("PSO_WORKSPACE_SHAPE", `"name" must be kebab-case`);
  if (!Array.isArray(o["services"])) { err("PSO_WORKSPACE_SHAPE", `"services" must be an array`); return out; }

  const names = new Set<string>();
  const ports = new Map<number, string>();
  const edges = new Map<string, string[]>();

  for (const s of o["services"] as Array<Record<string, unknown>>) {
    const name = s?.["name"];
    if (typeof name !== "string" || !NAME.test(name)) { err("PSO_SERVICE_SHAPE", `Service name must be kebab-case: ${JSON.stringify(name)}`); continue; }
    if (names.has(name)) err("PSO_DUPLICATE_SERVICE", `Duplicate service "${name}"`);
    names.add(name);
    if (typeof s["path"] !== "string" || isAbsolute(s["path"]) || s["path"].split(/[\\/]/).includes("..")) err("PSO_SERVICE_PATH", `Service "${name}": path must be relative and stay inside the workspace`);
    if (s["runtime"] !== "node" && s["runtime"] !== "spring-boot") err("PSO_SERVICE_SHAPE", `Service "${name}": runtime must be "node" or "spring-boot"`);
    const port = s["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) err("PSO_SERVICE_PORT", `Service "${name}": port must be an integer between 1024 and 65535`);
    else {
      const other = ports.get(port);
      if (other) err("PSO_PORT_CONFLICT", `Services "${other}" and "${name}" both use port ${port}`, "Give each service its own port");
      else ports.set(port, name);
    }
    const dev = s["dev"] as { command?: unknown } | undefined;
    if (dev !== undefined && (typeof dev !== "object" || dev === null || !Array.isArray(dev.command) || dev.command.length === 0 || !dev.command.every((x) => typeof x === "string" && x.length > 0))) {
      err("PSO_SERVICE_DEV", `Service "${name}": dev.command must be a non-empty array of strings`);
    }
    if (s["prefix"] !== undefined) {
      try { if (typeof s["prefix"] !== "string") throw new Error("must be a string"); normalizePrefix(s["prefix"]); }
      catch (e) { err("PSO_SERVICE_PREFIX", `Service "${name}": ${(e as Error).message}`, `Example: "prefix": "/${name.replace(/-service$/, "")}"`); }
    }
    if (s["db"] !== undefined && s["db"] !== "postgres") err("PSO_SERVICE_SHAPE", `Service "${name}": db must be "postgres"`);
    if (s["structure"] !== undefined) {
      const allowed = s["runtime"] === "node" ? ["modular", "legacy"] : ["layered", "legacy"];
      if (typeof s["structure"] !== "string" || !allowed.includes(s["structure"])) err("PSO_SERVICE_SHAPE", `Service "${name}": structure must be ${allowed.map((x) => `"${x}"`).join(" or ")} for runtime ${String(s["runtime"])}`);
    }
    if (s["health"] !== undefined && (typeof s["health"] !== "string" || !s["health"].startsWith("/"))) err("PSO_SERVICE_SHAPE", `Service "${name}": health must be a path starting with "/"`);
    edges.set(name, Array.isArray(s["dependsOn"]) ? (s["dependsOn"] as string[]) : []);
  }
  if (o["frontends"] !== undefined) {
    if (!Array.isArray(o["frontends"])) err("PSO_FRONTEND_SHAPE", `"frontends" must be an array`);
    else {
      const feNames = new Set<string>();
      let feis = 0;
      for (const f of o["frontends"] as Array<Record<string, unknown>>) {
        const fname = f?.["name"];
        if (typeof fname !== "string" || !NAME.test(fname)) { err("PSO_FRONTEND_SHAPE", `Frontend name must be kebab-case: ${JSON.stringify(fname)}`); continue; }
        if (feNames.has(fname) || names.has(fname)) err("PSO_DUPLICATE_SERVICE", `Duplicate project name "${fname}" (frontend projects share the namespace of services)`);
        feNames.add(fname);
        if (f["kind"] !== "fei" && f["kind"] !== "mei") err("PSO_FRONTEND_SHAPE", `Frontend "${fname}": kind must be "fei" or "mei"`);
        else if (f["kind"] === "fei") feis++;
        if (typeof f["path"] !== "string" || isAbsolute(f["path"]) || f["path"].split(/[\\/]/).includes("..")) err("PSO_FRONTEND_PATH", `Frontend "${fname}": path must be relative and stay inside the workspace`);
        const fp = f["port"];
        if (typeof fp !== "number" || !Number.isInteger(fp) || fp < 1024 || fp > 65535) err("PSO_FRONTEND_PORT", `Frontend "${fname}": port must be an integer between 1024 and 65535`);
        else { const other = ports.get(fp); if (other) err("PSO_PORT_CONFLICT", `"${other}" and "${fname}" both use port ${fp}`, "Give each project its own port"); else ports.set(fp, fname); }
      }
      // 0.2.0: several FEIs are allowed; each is an independent application shell (its own port, host, base path, identity client,
      // runtime configuration, build output and publication lifecycle). Collisions between them are checked here (ports), by the
      // frontend validation (routes, MEI ownership) and by the infrastructure engine (hosts, base paths, artifacts).
      void feis;
    }
  }
  for (const [n, deps] of edges) for (const dep of deps) if (!edges.has(dep)) err("PSO_MISSING_DEPENDENCY", `Service "${n}" depends on unknown service "${dep}"`);
  for (const c of findCycles(edges)) err("PSO_CYCLE", `Circular service dependency: ${c.join(" -> ")}`);
  return sortDiagnostics(out);
}
