import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { servicePrefix, discover, loadWorkspace, topoOrder, resolveConfig, redact, envLayer, LAYERS, type ServiceDecl, type WorkspaceConfig } from "@pso/core";
import { SecurityConfigError, describeConfig, loadSecurityConfig } from "@pso/security";
import { readRegistry, type RegistryEntry } from "./dev.ts";
import { liveHealth } from "./commands-services.ts";
import { securityCheck } from "./commands-security.ts";
import { readJsonSafe } from "./util-json.ts";
import { springSummary, validateSpring } from "./spring-config.ts";
import { discoverDispatch, lockFindings, readLock } from "./dispatch-static.ts";
import { probe } from "./commands-dispatch.ts";
import { analyzeOrchestrator, routeRows, serviceReferenceDiagnostics, type Analysis } from "./http-static.ts";
import { connect } from "node:net";
import { buildGraph } from "@pso/frontend/node";
import { frontendReport } from "./commands-frontend.ts";
import { CONTRACT_FILE, buildContract, contractVersionOf } from "./frontend-contracts.ts";

/** Everything here is READ-ONLY and derived from the workspace, the dev registry, live probes and log files. Nothing is simulated. */

export type Health = "healthy" | "degraded" | "unhealthy" | "stopped" | "unknown";
export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;

// ------------------------------------------------------------------ redaction

/** Removes anything that looks like a credential before it leaves the machine's process. */
export const scrub = (line: string): string =>
  line
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "***JWT***")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "***PRIVATE KEY***")
    .replace(/((?:password|secret|token|api[-_]?key)["']?\s*[:=]\s*)["']?[^\s"',;]+/gi, "$1***");

const SECRET_KEY = /pass(word|wd)?|secret|token|authorization|api[-_]?key|cookie|private|credential/i;
/** Recursively scrubs a parsed value: secret-looking keys are masked, strings are pattern-scrubbed. Depth and size bounded. */
export function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return scrub(v).slice(0, 2000);
  if (depth > 4 || v === null || typeof v !== "object") return typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) out[k] = SECRET_KEY.test(k) ? "***" : scrubValue(x, depth + 1);
  return out;
}

// ------------------------------------------------------------------ small cache (static analysis parses TypeScript)

const memo = new Map<string, { at: number; value: unknown }>();
export const clearCache = (): void => memo.clear();
function cached<T>(key: string, ttlMs: number, make: () => T): T {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = make();
  memo.set(key, { at: Date.now(), value });
  return value;
}

export const orchestratorOf = (root: string, ws: WorkspaceConfig): { decl: ServiceDecl; dir: string } | undefined => {
  const decl = ws.services.find((s) => s.role === "orchestrator");
  return decl ? { decl, dir: join(root, ...decl.path.split("/")) } : undefined;
};
const analysisOf = (root: string, ws: WorkspaceConfig): Analysis | undefined => {
  const o = orchestratorOf(root, ws);
  return o ? cached(`analysis:${o.dir}`, 1500, () => analyzeOrchestrator(o.dir)) : undefined;
};

// ------------------------------------------------------------------ health

export interface HealthVerdict { state: Health; reason: string }
/** Health is derived from a live probe and the dev registry, never from registration alone. */
export function classify(live: { status: "UP" | "DOWN"; httpStatus: number | null; ms: number | null } | undefined, reg: RegistryEntry | null | undefined): HealthVerdict {
  if (!live) return { state: "unknown", reason: "the health probe did not run" };
  if (live.status === "UP") {
    if (reg && reg.state !== "READY") return { state: "degraded", reason: `answers its health endpoint, but pso dev reports lifecycle state ${reg.state}` };
    if (live.ms !== null && live.ms > 1000) return { state: "degraded", reason: `health endpoint answered in ${live.ms} ms (over 1000 ms)` };
    return { state: "healthy", reason: `HTTP ${live.httpStatus} from the health endpoint${live.ms !== null ? ` in ${live.ms} ms` : ""}` };
  }
  if (live.httpStatus !== null) return { state: "unhealthy", reason: `health endpoint answered HTTP ${live.httpStatus}` };
  if (reg && ["FAILED", "READY", "INITIALIZED", "VALIDATED"].includes(reg.state)) return { state: "unhealthy", reason: `pso dev reports ${reg.state}${reg.error ? `: ${scrub(String(reg.error)).slice(0, 200)}` : ""}, but nothing answers on the port` };
  return { state: "stopped", reason: "nothing answers on the declared port and pso dev has no running process for it" };
}

async function liveAll(ws: WorkspaceConfig, reg: ReturnType<typeof readRegistry>) {
  const health = await Promise.all(ws.services.map(liveHealth));
  return ws.services.map((s) => {
    const live = health.find((h) => h.name === s.name);
    const registry = reg?.services.find((x) => x.name === s.name) ?? null;
    return { s, live, registry, verdict: classify(live, registry) };
  });
}

// ------------------------------------------------------------------ routes

export function routesOf(root: string, ws: WorkspaceConfig) {
  const o = orchestratorOf(root, ws);
  if (!o) return [];
  const a = analysisOf(root, ws);
  const known = new Set(ws.services.filter((s) => s.role !== "orchestrator").map((s) => s.name));
  return cached(`routes:${o.dir}`, 1500, () => routeRows(o.dir, a).map((r) => ({
    id: r.id, module: r.module, method: r.method, path: r.path, service: r.service, access: r.access, scopes: r.scopes,
    controller: `${r.controller}.${r.action}`, controllerClass: r.controller, action: r.action, guards: r.guards, public: r.public, file: r.file,
    // a route is active only when the whole registry validated (fail closed) and its target service is declared
    active: r.active, serviceDeclared: r.service === "" || known.has(r.service),
  })));
}

// ------------------------------------------------------------------ modules

export function modulesOf(root: string, ws: WorkspaceConfig) {
  const a = analysisOf(root, ws);
  if (!a) return { orchestrator: false, modules: [], imports: [], diagnostics: [], ok: false };
  const byDir = (d: { file?: string; message: string }, dir: string) => (d.file ?? "").includes(`routes/${dir}/`) || new RegExp(`^Module:\\s*${dir}\\s*$`, "m").test(d.message);
  const names = new Map(a.models.filter((m) => m.name).map((m) => [m.name!, m.dir]));
  const modules = a.models.map((m) => ({
    dir: m.dir, name: m.name ?? null, hasModule: m.hasModule, hasRoutes: m.hasRoutes, moduleFile: m.moduleFile ?? null, routesFile: m.routesFile ?? null,
    controllers: m.controllers, providers: m.providers, imports: m.imports, exports: m.exports, routesFromOwnRegistry: m.routesFromOwnRegistry,
    routeCount: m.routes.length, undeclaredControllers: m.undeclaredControllers, shapeErrors: m.shapeErrors,
    security: m.security ?? null,
    providerDeps: m.providerModels.map((p) => ({ name: p.name, deps: p.deps })),
    controllerDeps: m.controllerModels.map((c) => ({ name: c.name, deps: c.deps })),
    diagnostics: a.diagnostics.filter((d) => byDir(d, m.dir)).map((d) => ({ code: d.code, severity: d.severity, message: scrub(d.message), ...(d.file ? { file: d.file } : {}), ...(d.hint ? { hint: d.hint } : {}) })),
  }));
  const imports = a.models.flatMap((m) => m.imports.map((i) => ({ from: m.name ?? m.dir, to: i, resolved: names.has(i) })));
  const general = a.diagnostics.filter((d) => !a.models.some((m) => byDir(d, m.dir)));
  return { orchestrator: true, ok: a.ok, modules, imports, diagnostics: general.map((d) => ({ code: d.code, severity: d.severity, message: scrub(d.message), ...(d.file ? { file: d.file } : {}) })) };
}

// ------------------------------------------------------------------ overview / summary / services

export async function overview(root: string, ws: WorkspaceConfig) {
  const reg = readRegistry(root);
  const rows = await liveAll(ws, reg);
  return {
    workspace: ws.name,
    devSession: reg ? { pid: reg.pid } : null,
    services: rows.map(({ s, live, registry, verdict }) => ({
      name: s.name, role: s.role ?? "service", runtime: s.runtime, port: s.port, prefix: s.runtime === "spring-boot" ? servicePrefix(s) : null, dependsOn: s.dependsOn ?? [], live, registry, health: verdict,
    })),
  };
}

export async function summary(root: string, ws: WorkspaceConfig) {
  const reg = readRegistry(root);
  const rows = await liveAll(ws, reg);
  const counts: Record<Health, number> = { healthy: 0, degraded: 0, unhealthy: 0, stopped: 0, unknown: 0 };
  for (const r of rows) counts[r.verdict.state]++;
  const a = analysisOf(root, ws);
  const routes = routesOf(root, ws);
  const errors = (a?.diagnostics ?? []).filter((d) => d.severity === "error").length + (a ? serviceReferenceDiagnostics(a, ws).length : 0);
  const failed = rows.filter((r) => r.registry?.state === "FAILED" || r.verdict.state === "unhealthy").map((r) => r.s.name);
  const dispatch = existsSync(join(root, "pso.dispatch.json"));
  return {
    workspace: ws.name,
    devSession: reg ? { pid: reg.pid } : null,
    services: { total: rows.length, ...counts },
    routes: { declared: routes.length, active: routes.filter((r) => r.active).length },
    modules: { total: a?.models.length ?? 0, orchestrator: !!a },
    validationErrors: errors,
    failedServices: failed,
    dispatch: { installed: dispatch },
    runtime: reg ? "dev session running" : "no dev session (services may still run elsewhere)",
  };
}

export async function serviceDetail(root: string, ws: WorkspaceConfig, name: string) {
  const s = ws.services.find((x) => x.name === name);
  if (!s) return undefined;
  const reg = readRegistry(root);
  const live = await liveHealth(s);
  const registry = reg?.services.find((x) => x.name === s.name) ?? null;
  const resources = discover(join(root, ...s.path.split("/")), s.runtime).resources.map((r) => ({ kind: r.kind, id: r.id, file: r.file }));
  const routes = routesOf(root, ws).filter((r) => r.service === s.name);
  const findings = securityCheck(root, ws).filter((f) => f.resource.startsWith(s.path)).map((f) => ({ id: f.id, severity: f.severity, message: scrub(f.message) }));
  return {
    name: s.name, role: s.role ?? "service", runtime: s.runtime, path: s.path, host: "127.0.0.1", port: s.port, healthPath: s.health ?? null, database: s.db ?? null,
    health: classify(live, registry), probe: live, registry: registry ? { state: registry.state, pid: registry.pid, error: registry.error ? scrub(String(registry.error)).slice(0, 300) : null } : null,
    dependsOn: s.dependsOn ?? [], dependents: ws.services.filter((x) => (x.dependsOn ?? []).includes(s.name)).map((x) => x.name),
    routes, resources, findings,
    // Spring services: the effective PSO configuration read statically from application*.yml (never any secret value)
    spring: s.runtime === "spring-boot" ? { ...springSummary(root, s), findings: validateSpring(root, s).map((f) => ({ id: f.id, severity: f.severity, message: scrub(f.message), remediation: f.remediation })) } : null,
  };
}

export function graph(root: string, ws: WorkspaceConfig) {
  const edges = new Map(ws.services.map((s) => [s.name, s.dependsOn ?? []] as [string, string[]]));
  let order: string[] = []; let cycle: string | null = null;
  try { order = topoOrder(edges); } catch (e) { cycle = (e as Error).message; }
  const orch = ws.services.find((s) => s.role === "orchestrator");
  const routeEdges = routesOf(root, ws).filter((r) => r.service).map((r) => ({ from: orch?.name ?? "orchestrator", to: r.service, label: `${r.method} ${r.path}` }));
  return { nodes: ws.services.map((s) => s.name), dependencies: [...edges].flatMap(([from, tos]) => tos.map((to) => ({ from, to }))), routes: routeEdges, startupOrder: order, cycle };
}

// ------------------------------------------------------------------ configuration and environments

export function configOf(root: string, ws: WorkspaceConfig, service: string | undefined, env: string) {
  const layers: Parameters<typeof resolveConfig>[0] = {};
  if (ws.config) layers.workspace = { source: "pso.workspace.json", values: ws.config };
  const s = ws.services.find((x) => x.name === service);
  if (s) {
    const v = readJsonSafe(join(root, ...s.path.split("/"), "pso.config.json")); if (v) layers.service = { source: `${s.path}/pso.config.json`, values: v };
    const e = readJsonSafe(join(root, ...s.path.split("/"), `pso.config.${env}.json`)); if (e) layers["environment-file"] = { source: `${s.path}/pso.config.${env}.json`, values: e };
  }
  const ev = envLayer(process.env); if (Object.keys(ev).length) layers["environment-variables"] = { source: "PSO_CFG_*", values: ev };
  const r = resolveConfig(layers);
  return { values: [...r.values].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, v]) => ({ key, value: redact(key, v), origin: v.origin })), diagnostics: r.diagnostics };
}

export function environments(root: string, ws: WorkspaceConfig, selected: string) {
  const o = orchestratorOf(root, ws);
  const per = ENVIRONMENTS.map((env) => {
    const sources = [
      { layer: "defaults", source: "built-in defaults", present: true },
      { layer: "workspace", source: "pso.workspace.json", present: !!ws.config },
      ...ws.services.map((s) => ({ layer: "service", source: `${s.path}/pso.config.json`, present: existsSync(join(root, ...s.path.split("/"), "pso.config.json")) })),
      ...ws.services.map((s) => ({ layer: "environment-file", source: `${s.path}/pso.config.${env}.json`, present: existsSync(join(root, ...s.path.split("/"), `pso.config.${env}.json`)) })),
      { layer: "environment-variables", source: "PSO_CFG_* / PSO_JWT_* (names only; values never shown)", present: Object.keys(process.env).some((k) => k.startsWith("PSO_CFG_") || k.startsWith("PSO_JWT_")) },
    ];
    let validation: { status: "valid" | "invalid" | "not-applicable"; issues: Array<{ code: string; key?: string; message: string }> } = { status: "not-applicable", issues: [] };
    if (o) {
      try { loadSecurityConfig({ projectDir: o.dir, environment: env }); validation = { status: "valid", issues: [] }; }
      catch (e) { validation = { status: "invalid", issues: e instanceof SecurityConfigError ? e.issues.map((i) => ({ code: i.code, ...(i.key ? { key: i.key } : {}), message: scrub(i.message) })) : [{ code: "PSO_SEC_ERROR", message: "security configuration could not be evaluated" }] }; }
    }
    return { env, sources, validation, missing: validation.issues.filter((i) => i.code === "PSO_SEC_MISSING" || i.code === "PSO_SEC_ENV_MISSING").map((i) => i.key ?? i.message) };
  });
  return {
    selected, precedence: [...LAYERS], environments: per,
    scopes: [undefined, ...ws.services.map((s) => s.name)].map((n) => ({ scope: n ?? "(workspace)", ...configOf(root, ws, n, selected) })),
  };
}

// ------------------------------------------------------------------ security

function certificateStatus(file: string | undefined) {
  if (!file || !existsSync(file)) return { available: false, reason: "no certificate file is configured or it cannot be read" };
  try {
    const x = new X509Certificate(readFileSync(file));
    const now = Date.now(), from = Date.parse(x.validFrom), to = Date.parse(x.validTo);
    const state = now < from ? "not-yet-valid" : now > to ? "expired" : "valid";
    return { available: true, state, validFrom: new Date(from).toISOString(), validTo: new Date(to).toISOString(), daysLeft: Math.floor((to - now) / 86_400_000) };
  } catch { return { available: false, reason: "the configured key file is a public key, not an X.509 certificate (no validity period to show)" }; }
}

export function securityOf(root: string, ws: WorkspaceConfig, env = process.env["PSO_ENV"] ?? "development") {
  const o = orchestratorOf(root, ws);
  const routes = routesOf(root, ws);
  const coverage = {
    total: routes.length,
    public: routes.filter((r) => r.public).length,
    protected: routes.filter((r) => !r.public && r.guards.length > 0).length,
    denied: routes.filter((r) => !r.public && r.guards.length === 0).length,
    withScopes: routes.filter((r) => r.scopes.length > 0).length,
  };
  let authentication: Record<string, unknown> = { configured: false, reason: "this workspace has no orchestrator" };
  if (o) {
    try {
      const cfg = loadSecurityConfig({ projectDir: o.dir, environment: env });
      authentication = { configured: true, valid: true, environment: env, ...describeConfig(cfg) };
      const k = cfg.authentication.key;
      authentication["certificate"] = k.kind === "pem" ? certificateStatus(k.file) : { available: false, reason: "keys come from a remote JWKS; certificates are not inspected" };
    } catch (e) {
      authentication = { configured: false, valid: false, environment: env, issues: e instanceof SecurityConfigError ? e.issues.map((i) => ({ code: i.code, ...(i.key ? { key: i.key } : {}), message: scrub(i.message) })) : [{ code: "PSO_SEC_ERROR", message: "unreadable security configuration" }] };
    }
  }
  const publicRoutes = routes.filter((r) => r.public).map((r) => ({ method: r.method, path: r.path, module: r.module }));
  const policies = routes.filter((r) => !r.public).map((r) => ({ method: r.method, path: r.path, module: r.module, access: r.access, scopes: r.scopes }));
  const findings = securityCheck(root, ws).map((f) => ({ ...f, message: scrub(f.message) }));
  return { authentication, coverage, publicRoutes, policies, findings, note: "These are configuration and static-analysis results. An empty findings list does not prove the application is secure." };
}

// ------------------------------------------------------------------ logs

export interface LogEntry { service: string; ts: string | null; level: string; msg: string; correlationId: string | null; fields: Record<string, unknown>; raw: boolean }
const LEVELS = ["debug", "info", "warn", "error"] as const;
function parseLine(service: string, line: string): LogEntry {
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const { ts, level, msg, correlationId, ...rest } = j;
      const lv = String(level ?? "info").toLowerCase();
      return { service, ts: typeof ts === "string" ? ts : null, level: lv === "warning" ? "warn" : lv === "fatal" ? "error" : lv, msg: scrub(String(msg ?? "")).slice(0, 1000), correlationId: typeof correlationId === "string" ? correlationId : null, fields: scrubValue(rest) as Record<string, unknown>, raw: false };
    }
  } catch { /* plain text line */ }
  const text = scrub(line).slice(0, 1000);
  const level = /\b(error|exception|fatal)\b/i.test(text) ? "error" : /\bwarn(ing)?\b/i.test(text) ? "warn" : "info";
  return { service, ts: null, level, msg: text, correlationId: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(text)?.[0] ?? null, fields: {}, raw: true };
}

export function logsOf(root: string, q: URLSearchParams) {
  const dir = join(root, ".pso", "logs");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".log")).sort() : [];
  const only = q.get("service");
  const levels = new Set((q.get("level") ?? "").split(",").filter((l) => (LEVELS as readonly string[]).includes(l)));
  const text = (q.get("q") ?? "").toLowerCase();
  const corr = q.get("correlationId") ?? "";
  const minutes = Number(q.get("minutes") ?? 0);
  const since = minutes > 0 ? Date.now() - minutes * 60_000 : 0;
  const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 300), 1000));
  const entries: LogEntry[] = [];
  for (const f of files) {
    const service = f.slice(0, -4);
    if (only && only !== service) continue;
    let lines: string[] = [];
    try { lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter(Boolean).slice(-5000); } catch { /* unreadable log */ }
    for (const l of lines) entries.push(parseLine(service, l));
  }
  const matched = entries.filter((e) => {
    if (levels.size && !levels.has(e.level)) return false;
    if (corr && e.correlationId !== corr) return false;
    if (since && (e.ts === null || Date.parse(e.ts) < since)) return false;
    if (text && !(`${e.msg} ${JSON.stringify(e.fields)}`.toLowerCase().includes(text))) return false;
    return true;
  });
  matched.sort((a, b) => (a.ts ?? "") < (b.ts ?? "") ? -1 : (a.ts ?? "") > (b.ts ?? "") ? 1 : 0);
  return {
    services: files.map((f) => f.slice(0, -4)),
    total: matched.length, truncated: matched.length > limit, entries: matched.slice(-limit),
    note: since ? "The time range only matches lines that carry a timestamp." : undefined,
  };
}

// ------------------------------------------------------------------ dispatch

/**
 * Declared dispatch topology read statically (event contracts, handlers, provider configuration) plus, only on request, a REAL
 * connection test per service. Live consumer state (lag, retries, dead letters) needs runtime telemetry that PSO services do not
 * export yet, so it is reported as unavailable rather than invented.
 */
export async function dispatchOf(root: string, ws: WorkspaceConfig, probeBrokers = false) {
  const all = discoverDispatch(root, ws);
  const lock = lockFindings(all, readLock(root));
  const services = all.map((d) => ({
    service: d.service, runtime: d.runtime, provider: d.provider, installedAdapter: d.installed, enabled: d.enabled,
    events: d.events.map((e) => ({ name: e.name, version: e.version, channel: e.channel, publish: e.publish, compatibility: e.compatibility, hasSchema: !!e.schema, key: e.key ?? null })),
    consumers: d.consumers.map((c) => ({ event: c.event, handler: c.target, group: c.group ?? d.service })),
    deadLetter: [...new Set(d.events.map((e) => `${e.channel}.dlq`))],
    findings: [...d.findings, ...lock.filter((f) => d.events.some((e) => f.file === e.file || f.file === e.schemaFile))].map((f) => ({ code: f.code, severity: f.severity, message: scrub(f.message), file: f.file ?? null, hint: f.hint ?? null })),
  }));
  const edges: Array<{ from: string; to: string; kind: "publishes" | "consumes"; event: string }> = [];
  for (const d of all) {
    for (const e of d.events) if (e.publish) edges.push({ from: d.service, to: `channel:${e.channel}`, kind: "publishes", event: e.name });
    for (const c of d.consumers) { const ev = d.events.find((e) => e.name === c.event); if (ev) edges.push({ from: `channel:${ev.channel}`, to: d.service, kind: "consumes", event: c.event }); }
  }
  const channels = [...new Set(all.flatMap((d) => d.events.map((e) => e.channel)))].sort().map((name) => ({
    name, deadLetter: `${name}.dlq`,
    events: [...new Set(all.flatMap((d) => d.events.filter((e) => e.channel === name).map((e) => e.name)))].sort(),
    publishers: [...new Set(all.filter((d) => d.events.some((e) => e.channel === name && e.publish)).map((d) => d.service))],
    consumers: all.flatMap((d) => d.consumers.filter((c) => d.events.find((e) => e.name === c.event)?.channel === name).map((c) => ({ service: d.service, event: c.event, handler: c.target, group: c.group ?? d.service }))),
  }));
  const live = probeBrokers ? await Promise.all(all.filter((d) => d.installed || d.provider !== "none").map((d) => probe(root, d, ws.services.find((s) => s.name === d.service)!))) : null;
  return {
    anyInstalled: all.some((d) => d.installed), anyEnabled: all.some((d) => d.enabled),
    services, channels, edges, live,
    liveNote: "Declared topology comes from the source files. Connection status appears only after you run the check, and it is a real connection attempt.",
    telemetry: { available: false, reason: "PSO services do not export dispatch runtime metrics yet, so processing state, retry counts, dead-letter counts and consumer lag cannot be shown here. This is not the same as zero events. Use the service logs and your broker's tools." },
  };
}

// ------------------------------------------------------------------ diagnostics + AI context

const DOC: Array<[RegExp, string]> = [
  [/^PSO_ROUTE_/, "orchestrator/routes.html"], [/^PSO_MODULE_/, "orchestrator/module.html"], [/^PSO_SEC_/, "security/security-configuration.html"],
  [/^SEC0/, "security/auditing.html"], [/^PSO_CONFIG/, "concepts/configuration.html"], [/^PSO_/, "reference/diagnostics.html"],
];
export const docFor = (code: string): string | null => DOC.find(([re]) => re.test(code))?.[1] ?? null;

export async function diagnosticsOf(root: string, ws: WorkspaceConfig) {
  const a = analysisOf(root, ws);
  const items: Array<{ source: string; code: string; severity: string; message: string; file?: string; hint?: string; docs: string | null; command: string | null }> = [];
  for (const d of a?.diagnostics ?? []) items.push({ source: "routes", code: d.code, severity: d.severity, message: scrub(d.message), ...(d.file ? { file: d.file } : {}), ...(d.hint ? { hint: d.hint } : {}), docs: docFor(d.code), command: "pso validate" });
  if (a) for (const d of serviceReferenceDiagnostics(a, ws)) items.push({ source: "routes", code: d.code, severity: d.severity, message: scrub(d.message), ...(d.file ? { file: d.file } : {}), docs: docFor(d.code), command: "pso routes:list" });
  for (const f of securityCheck(root, ws)) items.push({ source: "security", code: f.id, severity: f.severity, message: scrub(f.message), file: f.resource, hint: f.remediation, docs: docFor(f.id), command: "pso security:check" });
  const sec = securityOf(root, ws).authentication as { issues?: Array<{ code: string; message: string }> };
  for (const i of sec.issues ?? []) items.push({ source: "security-config", code: i.code, severity: "error", message: i.message, docs: docFor(i.code), command: null });
  const rank: Record<string, number> = { critical: 0, error: 0, high: 1, warning: 2, medium: 2, low: 3, info: 4 };
  items.sort((x, y) => (rank[x.severity] ?? 5) - (rank[y.severity] ?? 5));
  return { total: items.length, items };
}

/** Sanitized, copy-safe context for AI-assisted troubleshooting: structure and findings only, never values. */
export async function aiContext(root: string, ws: WorkspaceConfig): Promise<string> {
  const s = await summary(root, ws);
  const d = await diagnosticsOf(root, ws);
  const routes = routesOf(root, ws).slice(0, 60);
  const lines = [
    `# PSO Studio diagnostic context`, ``,
    `Workspace: ${s.workspace}`,
    `Services: ${s.services.total} (healthy ${s.services.healthy}, degraded ${s.services.degraded}, unhealthy ${s.services.unhealthy}, stopped ${s.services.stopped}, unknown ${s.services.unknown})`,
    `Routes: ${s.routes.declared} declared, ${s.routes.active} active; modules: ${s.modules.total}; validation errors: ${s.validationErrors}`,
    ``, `## Routes`, ...routes.map((r) => `- ${r.method} ${r.path} -> ${r.service || "(orchestrator)"} [${r.access}${r.scopes.length ? `; scopes ${r.scopes.join(",")}` : ""}]${r.active ? "" : " (inactive)"}`),
    ``, `## Diagnostics`, ...(d.items.length ? d.items.slice(0, 40).map((i) => `- [${i.severity}] ${i.code}: ${i.message.split("\n")[0]}${i.file ? ` (${i.file})` : ""}`) : ["- none reported"]),
    ``, `Secrets, tokens and key material are never included. Ask the developer for specifics instead of guessing values.`,
  ];
  return scrub(lines.join("\n"));
}

export { loadWorkspace };


// ------------------------------------------------------------------ runtime telemetry
export type TelemetryState = "healthy" | "degraded" | "unavailable" | "not-configured" | "not-instrumented" | "unknown";
export interface TelemetryRow {
  service: string; runtime: string; state: TelemetryState; reason: string; collectedAt: string | null;
  /** only present when the service really answered: never zeros for a service that did not */
  metrics: null | {
    requests: number; serverErrors: number; clientErrors: number; unauthorized: number; forbidden: number; rateLimited: number; inFlight: number; avgLatencyMs: number | null; uptimeSeconds: number;
    upstream: Array<{ service: string; calls: number; failures: number; avgLatencyMs: number | null }>;
    rateLimit: null | { provider: string; allowed: number; denied: number; backendFailures: number };
    dispatch: null | { health: string; published: number | null; consumed: number | null; retried: number | null; deadLettered: number | null };
    shutdown: null | { inFlightAtStart: number; finishedAt: string | null };
  };
}

/** Deterministic health classification of a real diagnostics snapshot. The rules are documented in docs/devops/studio. */
export function classifyTelemetry(s: Record<string, any>): { state: "healthy" | "degraded"; reason: string } {
  const reasons: string[] = [];
  if (s.state && s.state !== "ready") reasons.push(`the service reports state "${s.state}"`);
  if (s.readiness && s.readiness.status !== "UP") reasons.push("readiness is not UP");
  const http = s.http ?? {};
  if ((http.requests ?? 0) >= 20 && (http.byClass?.["5xx"] ?? 0) / http.requests >= 0.05) reasons.push("5xx responses are 5% or more of the requests");
  if ((s.rateLimit?.backendFailures ?? 0) > 0) reasons.push("the shared rate limit backend failed");
  const d = s.dispatch?.health?.status;
  if (s.dispatch && d !== undefined && d !== "up" && d !== "unknown") reasons.push(`the dispatch broker is ${d}`);
  for (const [name, u] of Object.entries<any>(s.upstream ?? {})) {
    const calls = u.latency?.count ?? 0;
    const failed = Object.entries<number>(u.outcomes ?? {}).filter(([o]) => o !== "ok" && o !== "aborted").reduce((n, [, c]) => n + c, 0);
    if (calls >= 10 && failed / calls >= 0.5) reasons.push(`upstream "${name}" failed in half of the calls or more`);
  }
  return reasons.length ? { state: "degraded", reason: reasons.join("; ") } : { state: "healthy", reason: "readiness UP and no degradation rule matched" };
}

function fetchDiagnostics(port: number, token: string): Promise<{ status: number; body?: any } | { error: string }> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/_pso/telemetry", method: "GET", timeout: 1500, headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > 1_048_576) { req.destroy(); resolve({ error: "response too large" }); } else chunks.push(c); });
      res.on("end", () => { if (res.statusCode !== 200) return resolve({ status: res.statusCode ?? 0 }); try { resolve({ status: 200, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { resolve({ error: "invalid JSON" }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ error: (e as NodeJS.ErrnoException).code ?? e.message }));
    req.end();
  });
}

const avgMs = (sum: number, count: number): number | null => (count > 0 ? Math.round((sum / count) * 10000) / 10 : null);

export async function telemetryOf(ws: WorkspaceConfig, env: NodeJS.ProcessEnv = process.env) {
  const token = env["PSO_DIAGNOSTICS_TOKEN"];
  const now = new Date().toISOString();
  const services: TelemetryRow[] = await Promise.all(ws.services.map(async (s): Promise<TelemetryRow> => {
    const base = { service: s.name, runtime: s.runtime, collectedAt: null as string | null, metrics: null };
    if (s.runtime !== "node") return { ...base, state: "not-instrumented", reason: "Studio reads the orchestrator's diagnostics endpoint only. Spring services export traces and metrics through OpenTelemetry (pso-observability-starter) to your collector; nothing is measured here." };
    if (!token) return { ...base, state: "unknown", reason: "Studio has no PSO_DIAGNOSTICS_TOKEN, so it cannot ask the service for its telemetry. Start Studio with the same token the service uses." };
    const r = await fetchDiagnostics(s.port, token);
    if ("error" in r) return { ...base, state: "unavailable", reason: `the service did not answer on port ${s.port} (${r.error}); is it running?` };
    if (r.status === 404) return { ...base, state: "not-configured", reason: "the service is running but its diagnostics endpoint is off: set PSO_DIAGNOSTICS_TOKEN (32+ characters) for the service." };
    if (r.status === 401) return { ...base, state: "unknown", reason: "the service rejected Studio's diagnostics token: the tokens differ." };
    if (r.status !== 200 || !r.body || r.body.instrumented !== true) return { ...base, state: "unknown", reason: `unexpected answer (HTTP ${r.status})` };
    const b = r.body;
    const http = b.http ?? {};
    const all = (http.routes ?? []) as Array<{ sumSeconds: number; count: number }>;
    const upstream = Object.entries<any>(b.upstream ?? {}).map(([name, u]) => ({
      service: name, calls: u.latency?.count ?? 0,
      failures: Object.entries<number>(u.outcomes ?? {}).filter(([o]) => o !== "ok" && o !== "aborted").reduce((n, [, c]) => n + c, 0),
      avgLatencyMs: avgMs(u.latency?.sumSeconds ?? 0, u.latency?.count ?? 0),
    }));
    const verdict = classifyTelemetry(b);
    return {
      ...base, state: verdict.state, reason: verdict.reason, collectedAt: typeof b.at === "string" ? b.at : now,
      metrics: {
        requests: http.requests ?? 0, serverErrors: http.byClass?.["5xx"] ?? 0, clientErrors: http.byClass?.["4xx"] ?? 0, unauthorized: http.unauthorized ?? 0, forbidden: http.forbidden ?? 0,
        rateLimited: http.rateLimited ?? 0, inFlight: http.inFlight ?? 0, uptimeSeconds: b.uptimeSeconds ?? 0,
        avgLatencyMs: avgMs(all.reduce((n, x) => n + x.sumSeconds, 0), all.reduce((n, x) => n + x.count, 0)),
        upstream,
        rateLimit: b.rateLimit ? { provider: b.rateLimit.provider, allowed: b.rateLimit.allowed, denied: b.rateLimit.denied, backendFailures: b.rateLimit.backendFailures } : null,
        dispatch: b.dispatch ? { health: b.dispatch.health?.status ?? "unknown", published: b.dispatch.metrics?.published ?? null, consumed: b.dispatch.metrics?.consumed ?? null, retried: b.dispatch.metrics?.retried ?? null, deadLettered: b.dispatch.metrics?.deadLettered ?? null } : null,
        shutdown: b.shutdown ? { inFlightAtStart: b.shutdown.inFlightAtStart, finishedAt: b.shutdown.finishedAt ? new Date(b.shutdown.finishedAt).toISOString() : null } : null,
      },
    };
  }));
  return {
    checkedAt: now, studioHasToken: !!token, services,
    note: "Every number comes from the service's own diagnostics endpoint. A service that cannot be measured has no numbers: it is shown with the reason, never as zero. Consumer lag and dead-letter depth are NOT shown: the runtime does not export them.",
  };
}

/** The frontend ecosystem (FEI + MEIs): declarations, relationships, routes, contract state and which development servers answer. Read-only. */
export async function frontendOf(root: string, ws: WorkspaceConfig) {
  const projects = ws.frontends ?? [];
  if (projects.length === 0) return { enabled: false as const, projects: [], graph: { nodes: [], edges: [] }, routes: [], diagnostics: [], contract: null };
  const { loaded, eco } = frontendReport(root, ws);
  const reachable = (port: number) => new Promise<boolean>((resolve) => { const s = connect({ port, host: "localhost", timeout: 400 }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); s.once("timeout", () => { s.destroy(); resolve(false); }); });
  const up = await Promise.all(projects.map((p) => reachable(p.port)));
  let contract: { current: string; projects: Array<{ name: string; version: string | null }> } | null = null;
  try {
    const current = buildContract(root, ws).version;
    contract = { current, projects: projects.map((p) => { const f = join(root, ...p.path.split("/"), ...CONTRACT_FILE.split("/")); return { name: p.name, version: existsSync(f) ? (contractVersionOf(readFileSync(f, "utf8")) ?? null) : null }; }) };
  } catch { /* the orchestrator's own validation reports it */ }
  return {
    enabled: true as const,
    fei: loaded.fei ? loaded.fei.project.name : null,
    feis: loaded.feis.map((x) => x.project.name),
    projects: projects.map((p, i) => ({ name: p.name, kind: p.kind, path: p.path, port: p.port, devServerUp: up[i]!, ...(p.kind === "mei" ? (() => { const m = loaded.meis.find((x) => x.project.name === p.name); const shell = loaded.feis.find((x) => x.definition.name === m?.definition.host); return { host: m?.definition.host ?? null, scopes: m?.definition.security?.scopes ?? [], mount: shell?.definition.microfrontends.find((x) => x.name === p.name)?.path ?? null, public: shell?.definition.microfrontends.find((x) => x.name === p.name)?.public ?? false, contract: m?.definition.contract?.context ?? "1.0" }; })() : (() => { const shell = loaded.feis.find((x) => x.project.name === p.name); return { microfrontends: shell?.definition.microfrontends.length ?? 0, middlewares: shell?.definition.middlewares ?? [], auth: shell?.definition.security?.authentication ?? "jwt" }; })()) })),
    graph: buildGraph(loaded),
    routes: eco.routes.map((r) => ({ app: r.app, path: r.path, owner: r.owner, page: r.page ?? null, redirect: r.redirect ?? null, scopes: r.scopes })),
    diagnostics: eco.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: scrub(d.message), ...(d.file ? { file: d.file } : {}), ...(d.hint ? { hint: d.hint } : {}) })),
    contract,
  };
}
