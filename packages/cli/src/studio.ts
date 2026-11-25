import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findWorkspaceRoot, loadWorkspace } from "@pso/core";
import * as data from "./studio-data.ts";
import { StudioCloud } from "./studio-cloud.ts";
import { FrontendOps } from "./studio-frontend-ops.ts";
import { StudioInfra } from "./studio-infra.ts";
import { ApiClient } from "./studio-apiclient.ts";
import { StudioRemote } from "./studio-remote.ts";
import type { Cloud } from "@pso/deploy";

const here = dirname(fileURLToPath(import.meta.url));
export const STUDIO_DIR = join(here, "..", "studio");
// a framework checkout keeps dependencies in <repo>/node_modules; an installed distribution has node_modules/lucide-static next to node_modules/@pso
const LUCIDE = [join(here, "..", "..", "..", "node_modules", "lucide-static", "icons"), join(here, "..", "..", "node_modules", "lucide-static", "icons"), join(here, "..", "..", "..", "lucide-static", "icons")].find((d) => existsSync(d)) ?? join(here, "..", "..", "..", "node_modules", "lucide-static", "icons");
const PORTAL_ASSETS = join(here, "..", "portal", "assets");

export interface Studio { url: string; token: string; port: number; close(): Promise<void> }

export const scrub = data.scrub;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
};
/** Same policy for Studio and the embedded documentation: no inline code, no remote origins, no framing, no form posts. */
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Serves a file below `base` and nothing outside it. */
function safeFile(base: string, rel: string): string | undefined {
  const abs = normalize(join(base, rel));
  if (abs !== base && !abs.startsWith(base + sep)) return undefined;
  try { return statSync(abs).isFile() ? abs : undefined; } catch { return undefined; }
}

export async function startStudio(opts: { root: string; port?: number; remote?: boolean; cloud?: Cloud; frontendOps?: boolean; ops?: boolean }): Promise<Studio> {
  const ops = new FrontendOps({ root: opts.root, enabled: opts.frontendOps === true, cli: join(here, "..", "bin", "pso.js") });
  const infra = new StudioInfra({ root: opts.root, ops: opts.ops === true });
  const client = new ApiClient({ root: opts.root, allowNonDevelopment: opts.ops === true });
  const remote = new StudioRemote({ root: opts.root, ops: opts.ops === true });
  const sc = new StudioCloud({ root: opts.root, enabled: opts.remote === true, ...(opts.cloud ? { cloud: opts.cloud } : {}) });
  const token = randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  let port = opts.port ?? 0;
  let docsDir: string | undefined;
  const authed = (req: IncomingMessage): boolean => {
    const c = /(?:^|;\s*)pso_studio=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const b = Buffer.from(c);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };
  const send = (res: ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8", extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": CSP, "cross-origin-resource-policy": "same-origin", "cross-origin-opener-policy": "same-origin", "x-frame-options": "DENY",
      ...extra,
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body));

  async function api(path: string, q: URLSearchParams): Promise<unknown> {
    const { config, diagnostics } = loadWorkspace(opts.root);
    if (!config) return { error: "invalid workspace", diagnostics: diagnostics.map((d) => ({ code: d.code, message: data.scrub(d.message) })) };
    const root = opts.root;
    if (q.get("fresh") === "1") data.clearCache(); // explicit re-validation: re-run the static analysis
    switch (path) {
      case "/api/overview": return data.overview(root, config);
      case "/api/summary": return data.summary(root, config);
      case "/api/graph": return data.graph(root, config);
      case "/api/routes": return data.routesOf(root, config);
      case "/api/modules": return data.modulesOf(root, config);
      case "/api/config": {
        const env = q.get("env") ?? "development";
        return { scopes: [undefined, ...config.services.map((s) => s.name)].map((n) => ({ scope: n ?? "(workspace)", ...data.configOf(root, config, n, env) })) };
      }
      case "/api/environments": {
        const env = q.get("env") ?? "development";
        return data.environments(root, config, (data.ENVIRONMENTS as readonly string[]).includes(env) ? env : "development");
      }
      case "/api/security": return data.securityOf(root, config, q.get("env") ?? undefined);
      case "/api/logs": return data.logsOf(root, q);
      case "/api/dispatch": return data.dispatchOf(root, config, q.get("probe") === "1");
      case "/api/telemetry": return data.telemetryOf(config);
      case "/api/diagnostics": return data.diagnosticsOf(root, config);
      case "/api/frontend": return data.frontendOf(root, config);
      case "/api/frontend/ops": return ops.status();
      case "/api/infra/environments": return infra.environments().body;
      case "/api/infra": return infra.infra(q.get("env") ?? undefined).body;
      case "/api/infra/validate": return (await infra.validate(q.get("env") ?? undefined, q.get("probe") === "1")).body;
      case "/api/infra/certificates": return infra.certificates(q.get("env") ?? undefined).body;
      case "/api/infra/hosts": return infra.hosts(q.get("env") ?? undefined).body;
      case "/api/infra/deployment": return infra.deployment(q.get("env") ?? undefined).body;
      case "/api/containers": return infra.containers(q.get("env") ?? undefined).body;
      case "/api/containers/logs": return infra.logs(q.get("env") ?? undefined, q.get("name") ?? "", Number(q.get("tail") ?? 300)).body;
      case "/api/client/targets": { try { return { targets: client.targets(q.get("env") ?? undefined), endpoints: client.endpoints() }; } catch (e) { return { error: (e as Error).message, targets: [], endpoints: [] }; } }
      case "/api/client/history": return { history: client.history() };
      case "/api/remote/hosts": return remote.hosts().body;
      case "/api/remote/host": return remote.host(q.get("name") ?? "", q.get("root") ?? undefined).body;
      case "/api/remote/environment": return remote.environment(q.get("env") ?? "").body;
      case "/api/remote/logs": return remote.logs(q.get("env") ?? "", q.get("service") ?? "", Number(q.get("tail") ?? 200)).body;
      case "/api/remote/job": return remote.job(q.get("id") ?? "").body;
      case "/api/client/collections": return client.collections();
      case "/api/ai-context": return { markdown: await data.aiContext(root, config) };
      case "/api/workspace": return { name: config.name, root: "(local workspace)", services: config.services.length, environment: process.env["PSO_ENV"] ?? "development", readOnly: opts.remote !== true && opts.ops !== true, remoteManagement: opts.remote === true, operations: opts.ops === true };
      default: {
        const m = /^\/api\/services\/([a-z][a-z0-9-]*)$/.exec(path);
        return m ? await data.serviceDetail(root, config, m[1]!) : undefined;
      }
    }
  }

  /** Documentation is built once, on first use, into a private temp directory and mounted at /docs/ on the same origin. */
  async function docsRoot(): Promise<string> {
    if (docsDir) return docsDir;
    const { buildSite } = await import("./portal/build.ts");
    const { ALL_COMMANDS } = await import("./registry.ts");
    const dir = join(tmpdir(), `pso-studio-docs-${process.pid}-${Date.now()}`);
    buildSite(dir, ALL_COMMANDS, {});
    docsDir = dir;
    return dir;
  }

  const server: Server = createServer(async (req, res) => {
    try {
      // DNS-rebinding defence: only our own loopback origin may talk to us
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: "bad host" });
      const cloudPath = (req.url ?? "").startsWith("/api/cloud/");
      const opsPath = (req.url ?? "").split("?")[0] === "/api/frontend/ops";
      const p0 = (req.url ?? "").split("?")[0]!;
      const POSTS = new Set(["/api/ops/remote", "/api/ops/infra", "/api/ops/containers", "/api/client/send", "/api/client/cancel", "/api/client/history/clear", "/api/client/collections"]);
      if (req.method !== "GET" && !((cloudPath || opsPath || POSTS.has(p0)) && req.method === "POST")) return send(res, 405, JSON.stringify({ error: "read-only" }), undefined, { allow: "GET" });
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (url.pathname === "/" && url.searchParams.get("t")) {
        if (url.searchParams.get("t") !== token) return json(res, 403, { error: "forbidden" });
        return send(res, 302, "", "text/plain", { location: "/", "set-cookie": `pso_studio=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (!authed(req)) return json(res, 403, { error: "forbidden: open the URL printed by `pso studio`" });

      if (POSTS.has(url.pathname) && req.method === "POST") {
        // the same CSRF defence as every mutating endpoint: same-origin Origin, a custom header a cross-site form cannot set, JSON only
        const origin = req.headers.origin ?? "";
        if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: "cross-origin request refused" });
        if (req.headers["x-pso-studio"] !== "1" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 403, { error: "missing request headers" });
        const limit = url.pathname === "/api/client/send" ? 15 * 1024 * 1024 : 600 * 1024;
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += (chunk as Buffer).length; if (size > limit) return json(res, 413, { error: "request too large" }); chunks.push(chunk as Buffer); }
        let body: Record<string, unknown>; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; } catch { return json(res, 400, { error: "invalid JSON" }); }
        if (url.pathname === "/api/ops/remote") { const r = remote.operate(body); return json(res, r.status, r.body); }
        if (url.pathname === "/api/ops/infra") { const r = await infra.operate("infra", body); return json(res, r.status, r.body); }
        if (url.pathname === "/api/ops/containers") { const r = await infra.operate("containers", body); return json(res, r.status, r.body); }
        if (url.pathname === "/api/client/send") { const r = await client.send(body as never); return json(res, r.status, r.body); }
        if (url.pathname === "/api/client/cancel") return json(res, 200, { cancelled: client.cancel(String(body["requestId"] ?? "")) });
        if (url.pathname === "/api/client/history/clear") { client.clearHistory(); return json(res, 200, { cleared: true }); }
        const r = client.saveCollections(body); return json(res, r.status, r.body);
      }
      if (url.pathname === "/api/frontend/ops" && req.method === "POST") {
        // the same CSRF defence as the Cloud operations: same-origin Origin, a custom header a cross-site form cannot set, JSON only
        const origin = req.headers.origin ?? "";
        if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: "cross-origin request refused" });
        if (req.headers["x-pso-studio"] !== "1" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 403, { error: "missing request headers" });
        let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 16 * 1024) return json(res, 413, { error: "request too large" }); }
        let body: Record<string, unknown>; try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { return json(res, 400, { error: "invalid JSON" }); }
        const { config } = loadWorkspace(opts.root);
        const r = await ops.run(body, (config?.frontends ?? []).map((f) => f.name)); return json(res, r.status, r.body);
      }
      if (url.pathname.startsWith("/api/cloud/")) {
        if (req.method === "POST") {
          // CSRF defence for the only mutating endpoints: same-origin Origin, a custom header a cross-site form cannot set, JSON only
          const origin = req.headers.origin ?? "";
          if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: "cross-origin request refused" });
          if (req.headers["x-pso-studio"] !== "1" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 403, { error: "missing request headers" });
          let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 256 * 1024) return json(res, 413, { error: "request too large" }); }
          let body: Record<string, unknown>; try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { return json(res, 400, { error: "invalid JSON" }); }
          const r = await sc.post(url.pathname, body); return json(res, r.status, r.body);
        }
        const r = await sc.get(url.pathname, url.searchParams); return json(res, r.status, r.body);
      }
      if (url.pathname.startsWith("/api/")) {
        const out = await api(url.pathname, url.searchParams);
        return out === undefined ? json(res, 404, { error: "not found" }) : json(res, 200, out);
      }
      if (url.pathname.startsWith("/icons/")) {
        const name = url.pathname.slice(7).replace(/\.svg$/, "");
        if (!/^[a-z0-9-]{1,48}$/.test(name)) return send(res, 404, "");
        const f = join(LUCIDE, `${name}.svg`);
        return existsSync(f) ? send(res, 200, readFileSync(f), TYPES[".svg"]) : send(res, 404, "");
      }
      if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
        const f = join(PORTAL_ASSETS, url.pathname.slice(1)); // the official PSO favicon, shared with the documentation
        return existsSync(f) ? send(res, 200, readFileSync(f), TYPES[url.pathname.slice(-4)] ?? TYPES[".svg"]) : send(res, 404, "");
      }
      if (url.pathname === "/docs") return send(res, 302, "", "text/plain", { location: "/docs/" });
      if (url.pathname.startsWith("/docs/")) {
        let rel: string;
        try { rel = decodeURIComponent(url.pathname.slice(6)); } catch { return send(res, 400, ""); }
        if (rel === "" || rel.endsWith("/")) rel += "index.html";
        const f = safeFile(await docsRoot(), rel);
        return f ? send(res, 200, readFileSync(f), TYPES[f.slice(f.lastIndexOf("."))] ?? "application/octet-stream") : send(res, 404, "not found", "text/plain");
      }
      // Studio application: index.html plus allow-listed static folders (js/, css/)
      if (url.pathname === "/") return send(res, 200, readFileSync(join(STUDIO_DIR, "index.html")), TYPES[".html"]);
      if (/^\/(js|css)\/[A-Za-z0-9._/-]+\.(js|css)$/.test(url.pathname)) {
        const f = safeFile(STUDIO_DIR, url.pathname.slice(1));
        return f ? send(res, 200, readFileSync(f), TYPES[f.slice(f.lastIndexOf("."))]!) : send(res, 404, "");
      }
      return send(res, 404, "");
    } catch {
      json(res, 500, { error: "internal error" }); // never leak internals
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r)); // loopback only
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`, token, port,
    close: () => new Promise((r) => { ops.close(); client.close(); sc.closeTunnels(); server.closeAllConnections(); server.close(() => { if (docsDir) { try { rmSync(docsDir, { recursive: true, force: true }); } catch { /* temp is reaped by the OS */ } } r(); }); }),
  };
}

export { findWorkspaceRoot };
