// The only module that touches the network. Views receive plain data; they never build URLs or handle fetch errors.
// Strategy: one GET per call, obsolete requests are aborted when a view is left, results are not cached (the server caches analysis),
// and the connection indicator reflects the outcome of real requests only.

const listeners = new Set();
export const connection = { state: "connecting", lastOk: null, lastError: null };
const setConn = (state, extra = {}) => { Object.assign(connection, { state }, extra); for (const l of listeners) l(connection); };
export const onConnection = (fn) => { listeners.add(fn); fn(connection); return () => listeners.delete(fn); };

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let scope = new AbortController();
/** Aborts every request that belongs to the view being left. */
export function cancelPending() { scope.abort(); scope = new AbortController(); }

export async function get(path, params = {}, { signal } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const url = q.size ? `${path}?${q}` : path;
  const ac = new AbortController();
  const abort = () => ac.abort();
  scope.signal.addEventListener("abort", abort, { once: true });
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  // Remote operations (a reachability check measures several layers, a verify can take half a minute) legitimately outlast the 15 s allowed for a local request
  const remote = path.startsWith("/api/cloud/") || path.startsWith("/api/remote/") || path === "/api/infra/validate" || path === "/api/containers/logs"; const timer = setTimeout(() => { timedOut = true; abort(); }, remote ? 120_000 : 15_000);
  try {
    const r = await fetch(url, { credentials: "same-origin", signal: ac.signal, headers: { accept: "application/json" } });
    if (r.status === 403) { setConn("unauthorized", { lastError: "The access token is missing or expired. Reopen the URL printed by `pso studio`." }); throw new ApiError("Access denied: reopen the URL printed by `pso studio`.", 403); }
    if (!r.ok && path.startsWith("/api/cloud/")) { // a failure of the REMOTE server or a policy refusal is not a Studio connection problem
      let b = null; try { b = await r.json(); } catch { /* not JSON */ }
      throw new ApiError(b?.error ? (b.hint ? `${b.error} (${b.hint})` : b.error) : `${path} answered HTTP ${r.status}`, r.status);
    }
    if (!r.ok) { setConn("error", { lastError: `HTTP ${r.status}` }); throw new ApiError(`${path} answered HTTP ${r.status}`, r.status); }
    const body = await r.json();
    if (body && body.error === "invalid workspace") throw new ApiError("The workspace file is invalid. Run `pso validate` to see why.", 422);
    setConn("connected", { lastOk: new Date(), lastError: null });
    return body;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (timedOut && remote) throw new ApiError("The operation on the remote server took longer than two minutes. Studio itself is fine; try again or use the CLI.", 0); // a slow REMOTE call is not a broken Studio connection
    if (timedOut) { setConn("error", { lastError: "request timed out" }); throw new ApiError("The Studio server did not answer in time.", 0); }
    if (e && e.name === "AbortError") throw e; // superseded by navigation: callers ignore it
    setConn("disconnected", { lastError: "cannot reach the Studio server" });
    throw new ApiError("Cannot reach the Studio server. Is `pso studio` still running?", 0);
  } finally { clearTimeout(timer); scope.signal.removeEventListener("abort", abort); }
}

/** The only mutating call. Studio refuses it unless it was started with --remote; the headers are the CSRF defence (see studio-cloud.ts). */
export async function post(path, body = {}) {
  let r;
  try { r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pso-studio": "1", accept: "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new ApiError("Cannot reach the Studio server. Is `pso studio` still running?", 0); }
  let data = null; try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError(data?.error ? (data.hint ? `${data.error} (${data.hint})` : data.error) : `HTTP ${r.status}`, r.status);
  return data;
}

export const isAbort = (e) => e && e.name === "AbortError";

export const api = {
  summary: (p) => get("/api/summary", p),
  overview: (p) => get("/api/overview", p),
  workspace: () => get("/api/workspace"),
  graph: () => get("/api/graph"),
  routes: () => get("/api/routes"),
  modules: () => get("/api/modules"),
  service: (name) => get(`/api/services/${encodeURIComponent(name)}`),
  security: (env) => get("/api/security", { env }),
  logs: (p) => get("/api/logs", p),
  dispatch: (p) => get("/api/dispatch", p),
  telemetry: () => get("/api/telemetry"),
  diagnostics: (p) => get("/api/diagnostics", p),
  frontend: (p) => get("/api/frontend", p),
  frontendOps: () => get("/api/frontend/ops"),
  frontendOp: (body) => post("/api/frontend/ops", body),
  environments: (env) => get("/api/environments", { env }),
  infraEnvironments: () => get("/api/infra/environments"),
  infra: (env) => get("/api/infra", { env }),
  infraValidate: (env, probe) => get("/api/infra/validate", { env, probe: probe ? 1 : undefined }),
  certificates: (env) => get("/api/infra/certificates", { env }),
  hosts: (env) => get("/api/infra/hosts", { env }),
  deployment: (env) => get("/api/infra/deployment", { env }),
  containers: (env) => get("/api/containers", { env }),
  containerLogs: (env, name, tail) => get("/api/containers/logs", { env, name, tail }),
  infraOp: (body) => post("/api/ops/infra", body),
  remote: { hosts: () => get("/api/remote/hosts"), host: (name) => get("/api/remote/host", { name }), environment: (env) => get("/api/remote/environment", { env }), logs: (env, service, tail) => get("/api/remote/logs", { env, service, tail }), job: (id) => get("/api/remote/job", { id }), op: (body) => post("/api/ops/remote", body) },
  containerOp: (body) => post("/api/ops/containers", body),
  client: { targets: (env) => get("/api/client/targets", { env }), history: () => get("/api/client/history"), collections: () => get("/api/client/collections"), send: (body) => post("/api/client/send", body), cancel: (requestId) => post("/api/client/cancel", { requestId }), clearHistory: () => post("/api/client/history/clear", {}), saveCollections: (c) => post("/api/client/collections", c) },
  aiContext: () => get("/api/ai-context"),
  cloud: {
    overview: () => get("/api/cloud/overview"),
    hostKeys: (host, port) => get("/api/cloud/hostkeys", { host, port }),
    env: (env, what, p) => get(`/api/cloud/env/${encodeURIComponent(env)}/${what}`, p),
    deployment: (env, id) => get(`/api/cloud/env/${encodeURIComponent(env)}/deployment/${encodeURIComponent(id)}`),
    localAudit: () => get("/api/cloud/local-audit"),
    post: (path, body) => post(`/api/cloud/${path}`, body),
    envPost: (env, what, body) => post(`/api/cloud/env/${encodeURIComponent(env)}/${what}`, body),
  },
};
