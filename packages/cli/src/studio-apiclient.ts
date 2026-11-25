import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspace } from "@pso/core";
import { atomicWrite, developmentUserToken, environmentCa, localResolution, mintDevToken, netRequest, NetError, plan, protectFile, redact, redactKnown, rememberSecret, type Topology } from "@pso/infra";
import { INFRA_HOOKS, hasInfraContract } from "./commands-infra.ts";
import { analyzeOrchestrator, routeRows } from "./http-static.ts";

/**
 * The Studio API Client: real HTTP requests to the workspace's own endpoints, executed by the Studio server (so TLS is verified against the
 * environment's authority and local host names resolve without touching the system).
 *
 * Execution boundary (it is not a proxy): a request names a TARGET, never a URL. Targets are derived from the declarations: the API and
 * each shell through the edge, each service directly (development, published on loopback), each service as a local process. The server
 * builds the URL from the target's origin and a path, and refuses anything whose origin differs after construction. No redirect is
 * followed, bodies and responses are size-limited, every request has a deadline and can be cancelled. Credentials are attached by the
 * server from the environment's own identity (development users) or typed by the developer; they are masked in the history, which keeps
 * no bodies and is readable by its owner only.
 */
export interface ReferenceCollection { name: string; description?: string; file: string; variables: Array<[string, string]>; requests: Array<{ name: string; method: string; path: string; target?: string; note?: string; query?: Array<[string, string]>; headers?: Array<[string, string]>; body?: { kind: string; text?: string }; auth?: { kind: string; user?: string } }> }
export interface ClientTarget { id: string; label: string; origin: string; kind: "edge" | "service" | "process"; note?: string; refused?: string }
export interface Endpoint { method: string; path: string; access: string; scopes: string[]; module: string; source: string; service?: string }
export interface SendBody {
  env?: string; target: string; method: string; path: string; query?: Array<[string, string]>; headers?: Array<[string, string]>;
  body?: { kind: "none" } | { kind: "json"; text: string } | { kind: "raw"; text: string; contentType?: string } | { kind: "form"; fields: Array<[string, string]> } | { kind: "multipart"; fields: Array<[string, string]>; files: Array<{ field: string; filename: string; contentType?: string; base64: string }> };
  auth?: { kind: "none" } | { kind: "bearer"; token: string } | { kind: "dev-user"; user: string };
  timeoutMs?: number; requestId?: string;
}
export interface HistoryEntry { id: string; at: string; env: string; target: string; method: string; path: string; query: Array<[string, string]>; headers: Array<[string, string]>; auth: string; bodyKind: string; bodyBytes: number; status: number | null; timeMs: number | null; error?: string; responseBytes?: number }

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$|token|secret|password|passwd|session|signature/i;
const FORBIDDEN_HEADERS = /^(host|content-length|transfer-encoding|connection|upgrade|te|trailer|expect|keep-alive|proxy-.*)$/i;
const MAX_REQUEST = 10 * 1024 * 1024, MAX_RESPONSE = 5 * 1024 * 1024;
const mask = (k: string, v: string) => (SENSITIVE.test(k) ? (k.toLowerCase() === "authorization" ? v.replace(/^(\w+)\s+.*/, "$1 [REDACTED]") : "[REDACTED]") : redact(v));

export class ApiClient {
  private readonly root: string;
  private readonly allowNonDevelopment: boolean;
  private readonly inflight = new Map<string, AbortController>();
  constructor(o: { root: string; allowNonDevelopment: boolean }) { this.root = o.root; this.allowNonDevelopment = o.allowNonDevelopment; }

  private historyFile() { return join(this.root, ".pso", "studio", "api-history.json"); }
  private collectionsFile() { return join(this.root, ".pso", "studio", "api-collections.json"); }

  private topology(env?: string): Topology | undefined {
    if (!hasInfraContract(this.root)) return undefined;
    const t = plan(this.root, env, INFRA_HOOKS).topology;
    if (t.kind !== "development" && !this.allowNonDevelopment) throw Object.assign(new Error(`requests to the ${t.kind} environment "${t.env}" need Studio started with --ops`), { status: 403 });
    return t;
  }

  targets(env?: string): ClientTarget[] {
    const { config } = loadWorkspace(this.root);
    const out: ClientTarget[] = [];
    const t = this.topology(env);
    if (t) {
      if (t.orchestrator) out.push({ id: "edge:api", label: `API through the edge (${t.api.origin})`, origin: t.api.origin, kind: "edge" });
      for (const f of t.frontends) out.push({ id: `edge:${f.name}`, label: `${f.name} origin (${f.origin}, same-origin API path ${f.info.orchestratorBasePath})`, origin: f.origin, kind: "edge" });
      if (t.kind === "development" && t.decl.publishServices === true) for (const s of t.services) out.push({ id: `service:${s.name}`, label: `${s.name} directly (container, https://127.0.0.1:${s.port})`, origin: `https://127.0.0.1:${s.port}`, kind: "service", ...(s.mtls ? { refused: `${s.name} requires a client certificate (mutual TLS): call it through the orchestrator` } : {}) });
    }
    for (const s of config?.services ?? []) out.push({ id: `process:${s.name}`, label: `${s.name} as a local process (pso dev, http://127.0.0.1:${s.port})`, origin: `http://127.0.0.1:${s.port}`, kind: "process" });
    return out;
  }

  /** Endpoints discovered from the declarations: the orchestrator's ROUTES.pso.ts and the services' operation contracts. */
  endpoints(): Endpoint[] {
    const { config } = loadWorkspace(this.root);
    if (!config) return [];
    const out: Endpoint[] = [];
    const orch = config.services.find((s) => s.role === "orchestrator");
    if (orch) {
      const dir = join(this.root, ...orch.path.split("/"));
      try { for (const r of routeRows(dir, analyzeOrchestrator(dir))) out.push({ method: r.method, path: r.path, access: r.access, scopes: r.scopes ?? [], module: `${r.module}.${r.action}`, source: "orchestrator", ...(r.service ? { service: r.service } : {}) }); } catch { /* reported by pso validate */ }
    }
    for (const s of config.services.filter((x) => x.runtime === "spring-boot")) {
      const cdir = join(this.root, ...s.path.split("/"), "src", "main", "resources", "contracts");
      if (!existsSync(cdir)) continue;
      for (const f of readdirSync(cdir).filter((x) => x.endsWith(".contract.json")).sort()) {
        try {
          const c = JSON.parse(readFileSync(join(cdir, f), "utf8")) as { operations?: Array<{ method?: string; path?: string; name?: string }>; method?: string; path?: string };
          const ops = c.operations ?? (c.method && c.path ? [{ method: c.method, path: c.path, name: f.replace(/\.contract\.json$/, "") }] : []);
          for (const o of ops) if (o.method && o.path) out.push({ method: o.method.toUpperCase(), path: o.path, access: "service contract (authorized by the service)", scopes: [], module: o.name ?? f, source: `contract:${s.name}`, service: s.name });
        } catch { /* not a contract */ }
      }
    }
    return out;
  }

  async send(b: SendBody): Promise<{ status: number; body: unknown }> {
    const method = String(b.method ?? "").toUpperCase();
    if (!METHODS.has(method)) return { status: 400, body: { error: `method must be one of ${[...METHODS].join(", ")}` } };
    if (typeof b.path !== "string" || !/^\/[^\s#]*$/.test(b.path) || b.path.startsWith("//") || /[\\\u0000-\u001f]/.test(b.path) || /^\/[a-z]+:/i.test(b.path)) return { status: 400, body: { error: "path must be an absolute path such as /catalog/products (no scheme, host or //)" } };
    if (/(^|\/)\.\.?(\/|$)/.test(b.path.split("?")[0]!)) return { status: 400, body: { error: "path must not contain . or .. segments" } };
    let t: Topology | undefined;
    try { t = this.topology(b.env); } catch (e) { return { status: (e as { status?: number }).status ?? 400, body: { error: (e as Error).message } }; }
    const target = this.targets(b.env).find((x) => x.id === b.target);
    if (!target) return { status: 400, body: { error: `unknown target "${b.target}": requests go only to the workspace's own endpoints` } };
    if (target.refused) return { status: 403, body: { error: target.refused } };
    const url = new URL(b.path, target.origin);
    for (const [k, v] of b.query ?? []) if (k) url.searchParams.append(k, v);
    if (url.origin !== new URL(target.origin).origin) return { status: 400, body: { error: "the request would leave its target" } };
    const headers: Record<string, string> = {};
    for (const [k, v] of b.headers ?? []) {
      if (!k) continue;
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(k) || /[\r\n]/.test(v)) return { status: 400, body: { error: `invalid header "${k}"` } };
      if (FORBIDDEN_HEADERS.test(k)) return { status: 400, body: { error: `header "${k}" is set by the client itself` } };
      headers[k.toLowerCase()] = v;
    }
    let payload: Buffer | undefined, bodyKind = b.body?.kind ?? "none";
    const body = b.body ?? { kind: "none" as const };
    if (body.kind === "json") { try { JSON.parse(body.text); } catch (e) { return { status: 400, body: { error: `the JSON body is not valid: ${(e as Error).message}` } }; } payload = Buffer.from(body.text); headers["content-type"] ??= "application/json"; }
    else if (body.kind === "raw") { payload = Buffer.from(body.text); headers["content-type"] ??= body.contentType || "text/plain; charset=utf-8"; }
    else if (body.kind === "form") { payload = Buffer.from(new URLSearchParams(body.fields).toString()); headers["content-type"] = "application/x-www-form-urlencoded"; }
    else if (body.kind === "multipart") {
      const boundary = `----pso-${randomBytes(12).toString("hex")}`;
      const parts: Buffer[] = [];
      for (const [k, v] of body.fields) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/["\r\n]/g, "")}"\r\n\r\n${v}\r\n`));
      for (const f of body.files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field.replace(/["\r\n]/g, "")}"; filename="${f.filename.replace(/["\r\n]/g, "")}"\r\nContent-Type: ${(f.contentType || "application/octet-stream").replace(/[\r\n]/g, "")}\r\n\r\n`), Buffer.from(f.base64, "base64"), Buffer.from("\r\n"));
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      payload = Buffer.concat(parts); headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
    }
    if (payload && payload.length > MAX_REQUEST) return { status: 413, body: { error: "the request body is larger than 10 MB" } };
    if (payload && (method === "GET" || method === "HEAD")) return { status: 400, body: { error: `${method} requests have no body` } };
    let authNote = "none";
    try {
      if (b.auth?.kind === "bearer") { if (!/^[A-Za-z0-9._~+/=-]{8,8192}$/.test(b.auth.token)) return { status: 400, body: { error: "the bearer token contains characters a token cannot have" } }; headers["authorization"] = `Bearer ${b.auth.token}`; rememberSecret(b.auth.token); authNote = "bearer (typed)"; }
      else if (b.auth?.kind === "dev-user") {
        if (!t) return { status: 400, body: { error: "development users need pso.infra.json" } };
        const user = b.auth.user;
        const tok = t.identity?.provider === "pso-dev" ? mintDevToken(this.root, t, { sub: user, scopes: t.identity.users.find((u) => u.username === user)?.scopes ?? [] }) : (await developmentUserToken(this.root, t, user)).accessToken;
        headers["authorization"] = `Bearer ${tok}`; authNote = `development user ${user} (${t.identity?.provider})`;
      }
    } catch (e) { return { status: 502, body: { error: `could not obtain a token: ${redact((e as Error).message)}` } }; }
    if (payload) headers["content-length"] = String(payload.length);
    const timeoutMs = Math.min(Math.max(Number(b.timeoutMs ?? 30_000) || 30_000, 1000), 120_000);
    const id = typeof b.requestId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.requestId) ? b.requestId : randomUUID();
    const ac = new AbortController();
    this.inflight.set(id, ac);
    const entry: HistoryEntry = { id, at: new Date().toISOString(), env: t?.env ?? "(process)", target: target.id, method, path: b.path, query: (b.query ?? []).map(([k, v]) => [k, mask(k, v)]), headers: Object.entries(headers).filter(([k]) => k !== "content-length").map(([k, v]) => [k, mask(k, v)]), auth: authNote, bodyKind, bodyBytes: payload?.length ?? 0, status: null, timeMs: null };
    try {
      const ca = t ? environmentCa(this.root, t) : undefined;
      const r = await netRequest({ url: url.href, method, headers, ...(payload ? { body: payload } : {}), ...(target.origin.startsWith("https:") && ca ? { ca } : {}), resolve: t ? localResolution(t) : {}, timeoutMs, signal: ac.signal, maxBytes: MAX_RESPONSE, ...(target.kind === "service" ? { servername: target.id.slice(8) } : {}) } as never);
      entry.status = r.status; entry.timeMs = r.timeMs; entry.responseBytes = r.body.length;
      const ct = String(r.headers["content-type"] ?? "");
      const textual = /json|text|xml|javascript|html|csv|problem/i.test(ct) || r.body.length === 0;
      const respHeaders = Object.entries(r.headers).map(([k, v]) => [k, mask(k, Array.isArray(v) ? v.join(", ") : String(v))]);
      return { status: 200, body: { id, status: r.status, statusText: r.statusText, timeMs: r.timeMs, url: url.href, headers: respHeaders, size: r.body.length, truncated: r.truncated, contentType: ct, ...(textual ? { text: redactKnown(r.body.toString("utf8")) } : { base64: r.body.subarray(0, 64 * 1024).toString("base64") }), tls: r.tls ?? null } };
    } catch (e) {
      const ne = e as NetError;
      entry.error = ne.message; entry.timeMs = ne.timeMs ?? null;
      return { status: 200, body: { id, error: redact(ne.message), code: ne.code ?? "PSO_NET_ERROR", timeMs: ne.timeMs ?? null, url: url.href } };
    } finally {
      this.inflight.delete(id);
      this.record(entry);
    }
  }

  cancel(id: string): boolean { const ac = this.inflight.get(id); if (!ac) return false; ac.abort(); return true; }

  history(): HistoryEntry[] { try { return JSON.parse(readFileSync(this.historyFile(), "utf8")) as HistoryEntry[]; } catch { return []; } }
  clearHistory(): void { this.writeProtected(this.historyFile(), "[]\n"); }
  private record(e: HistoryEntry): void { const h = [e, ...this.history()].slice(0, 100); this.writeProtected(this.historyFile(), JSON.stringify(h, null, 2) + "\n"); }
  private writeProtected(f: string, text: string) { mkdirSync(join(f, ".."), { recursive: true }); atomicWrite(f, text, { sensitive: true }); protectFile(f); }

  /** Saved requests and variables. Values of sensitive headers and variables are never stored: they are kept as `{{name}}` references. */
  collections(): { requests: Array<Record<string, unknown>>; variables: Array<[string, string]>; reference: ReferenceCollection[] } {
    let own: { requests: Array<Record<string, unknown>>; variables: Array<[string, string]> } = { requests: [], variables: [] };
    try { own = JSON.parse(readFileSync(this.collectionsFile(), "utf8")); } catch { /* none saved yet */ }
    return { ...own, reference: this.referenceCollections() };
  }
  /**
   * Reference collections: version-controlled request sets of the workspace (the orchestrator's docs/api/*.collection.json, written by
   * the reference CRUD and pso make:crud). Read-only here. They never hold a token: authentication is a development user's NAME.
   */
  referenceCollections(): ReferenceCollection[] {
    const { config } = loadWorkspace(this.root);
    const orch = config?.services.find((s) => s.role === "orchestrator");
    if (!orch) return [];
    const dir = join(this.root, ...orch.path.split("/"), "docs", "api");
    if (!existsSync(dir)) return [];
    const out: ReferenceCollection[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".collection.json")).sort()) {
      try {
        const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<ReferenceCollection>;
        if (!Array.isArray(c.requests)) continue;
        const requests = c.requests.filter((r) => typeof r === "object" && r && typeof r.method === "string" && typeof r.path === "string" && !(r.auth && "token" in (r.auth as object))).slice(0, 100);
        out.push({ name: String(c.name ?? f), ...(c.description ? { description: String(c.description) } : {}), file: `${orch.path}/docs/api/${f}`, variables: Array.isArray(c.variables) ? c.variables.filter((v): v is [string, string] => Array.isArray(v) && v.length === 2 && !SENSITIVE.test(String(v[0]))) : [], requests });
      } catch { /* not a collection */ }
    }
    return out;
  }
  saveCollections(c: { requests?: unknown; variables?: unknown }): { status: number; body: unknown } {
    if (!Array.isArray(c.requests) || !Array.isArray(c.variables)) return { status: 400, body: { error: "requests and variables must be lists" } };
    const text = JSON.stringify(c);
    if (text.length > 512 * 1024) return { status: 413, body: { error: "collections are limited to 512 KB" } };
    const clean = { requests: (c.requests as Array<Record<string, unknown>>).slice(0, 200).map((r) => ({ ...r, headers: Array.isArray(r["headers"]) ? (r["headers"] as Array<[string, string]>).map(([k, v]) => [k, SENSITIVE.test(k) && !/^\{\{[A-Za-z0-9_.-]+\}\}$/.test(v) && !/^Bearer \{\{[A-Za-z0-9_.-]+\}\}$/.test(v) ? "{{" + k.toLowerCase().replace(/[^a-z0-9]+/g, "_") + "}}" : v]) : [], auth: (r["auth"] as { kind?: string } | undefined)?.kind === "bearer" ? { kind: "bearer", token: "{{token}}" } : r["auth"] })), variables: (c.variables as Array<[string, string]>).slice(0, 200).filter(([k]) => typeof k === "string" && !SENSITIVE.test(k)) };
    this.writeProtected(this.collectionsFile(), JSON.stringify(clean, null, 2) + "\n");
    return { status: 200, body: { saved: clean.requests.length, variables: clean.variables.length, droppedSensitiveVariables: (c.variables as unknown[]).length - clean.variables.length } };
  }
  close(): void { for (const ac of this.inflight.values()) ac.abort(); }
}
