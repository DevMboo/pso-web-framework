import type { PsoApi, PsoRequestOptions } from "@pso/frontend";

export * from "./channels.ts";

/**
 * The PSO frontend API client: native fetch, orchestrator only.
 *
 * What it guarantees (and what it cannot):
 *  - it builds every URL from the configured same-origin base path plus a validated relative path. An absolute URL, a protocol-relative
 *    URL, a backslash, `..` or control characters are refused BEFORE a request exists. That keeps application code honest; it does not
 *    stop other scripts of the page from calling `fetch`. The boundary that does is the deployment: same-origin routing, a restrictive
 *    Content-Security-Policy (`connect-src 'self'`) and private networking of the services.
 *  - the access token never leaves the `AuthSource` that owns it; a MEI sees only this client.
 *  - non-idempotent requests are never repeated automatically, unless the caller supplied an Idempotency-Key.
 */

export interface ProblemDetails { type?: string; title?: string; status?: number; detail?: string; instance?: string; code?: string; correlationId?: string; errors?: Array<{ field?: string; message: string }>; [k: string]: unknown }
export type ApiErrorKind = "problem" | "http" | "network" | "timeout" | "cancelled" | "invalid-response" | "refused";

export class PsoApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly problem: ProblemDetails | undefined;
  readonly correlationId: string | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(kind: ApiErrorKind, message: string, o: { status?: number; problem?: ProblemDetails; correlationId?: string; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "PsoApiError";
    this.kind = kind;
    this.status = o.status;
    this.problem = o.problem;
    this.correlationId = o.correlationId ?? o.problem?.correlationId;
    this.retryAfterMs = o.retryAfterMs;
    if (o.cause !== undefined) this.cause = o.cause;
  }
  get isUnauthorized(): boolean { return this.status === 401; }
  get isForbidden(): boolean { return this.status === 403; }
  /** field-level validation messages, when the orchestrator sent them */
  get fieldErrors(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const e of this.problem?.errors ?? []) (out[e.field ?? "_"] ??= []).push(e.message);
    return out;
  }
}

/** Where credentials come from. Implemented by the FEI; a MEI never sees it. */
export interface AuthSource {
  /** a bearer token valid now, or undefined when the user is signed out or cookies carry the session */
  getAccessToken(): Promise<string | undefined> | string | undefined;
  /** called once (shared by concurrent requests) after a 401; true when a new credential is available and the request may be repeated */
  refresh?(): Promise<boolean>;
  /** called when the session is definitely gone (401 after refresh) */
  onUnauthorized?(error: PsoApiError): void;
  /** value of the anti-CSRF token for cookie sessions; sent as `X-CSRF-Token` on unsafe methods */
  getCsrfToken?(): string | undefined;
}

export interface ApiRequest { method: string; url: URL; headers: Headers; body: BodyInit | undefined; signal: AbortSignal }
export interface ApiMiddleware {
  name?: string;
  request?(req: ApiRequest): ApiRequest | void | Promise<ApiRequest | void>;
  response?(res: Response, req: ApiRequest): Response | void | Promise<Response | void>;
}

export interface ApiClientOptions {
  /** the orchestrator's public path on this origin, e.g. "/api" */
  basePath: string;
  /** the origin of the page; defaults to `location.origin` */
  origin?: string;
  auth?: AuthSource;
  middlewares?: ApiMiddleware[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** extra attempts for idempotent requests after a network error or 502/503/504 (default 1, max 3) */
  retries?: number;
  retryDelayMs?: number;
  /** correlation id for requests of this client; a fresh one is made per request when omitted */
  correlationId?: () => string;
  /** use cookies instead of bearer tokens (same-origin sessions); needs `getCsrfToken` */
  credentials?: "same-origin" | "omit";
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const uuid = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

/** A path is acceptable when it is absolute-path-relative to the orchestrator: `/customers/42`. */
export function assertApiPath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/")) throw new PsoApiError("refused", `API path "${String(path).slice(0, 60)}" must start with "/": the client talks only to the orchestrator`);
  if (path.startsWith("//") || /^\/[\\]/.test(path)) throw new PsoApiError("refused", `API path "${path.slice(0, 60)}" looks like an absolute URL and was refused`);
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new PsoApiError("refused", "API path contains control or backslash characters");
  const pure = path.split(/[?#]/)[0]!;
  let decoded = pure;
  try { decoded = decodeURIComponent(pure); } catch { throw new PsoApiError("refused", "API path is not valid percent-encoding"); }
  if (decoded.split("/").some((s) => s === "..") || pure.split("/").some((s) => s === "..")) throw new PsoApiError("refused", "API path contains a parent-directory segment");
  if (/^\/[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.includes("://")) throw new PsoApiError("refused", "API path contains a scheme");
}

export function createApiClient(o: ApiClientOptions): PsoApi & { use(mw: ApiMiddleware): void; readonly basePath: string } {
  if (!/^(\/([A-Za-z0-9._~-]+\/?)*)?$/.test(o.basePath)) throw new Error(`createApiClient: basePath must be a same-origin path such as "/api" (got ${JSON.stringify(o.basePath)})`);
  const base = o.basePath.replace(/\/+$/, "");
  const origin = o.origin ?? (globalThis as { location?: { origin: string } }).location?.origin;
  if (!origin) throw new Error("createApiClient: no origin (pass `origin` outside a browser)");
  const pageOrigin = new URL(origin).origin;
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const mws: ApiMiddleware[] = [...(o.middlewares ?? [])];
  const timeout = o.timeoutMs ?? 30_000;
  const retries = Math.min(Math.max(o.retries ?? 1, 0), 3);
  const inflight = new Map<string, Promise<unknown>>();
  let refreshing: Promise<boolean> | undefined;
  const credentials = o.credentials ?? "omit";

  const refreshOnce = (): Promise<boolean> => {
    if (!o.auth?.refresh) return Promise.resolve(false);
    refreshing ??= o.auth.refresh().catch(() => false).finally(() => { refreshing = undefined; }); // one refresh for all concurrent 401s
    return refreshing;
  };

  async function attempt(method: string, path: string, body: BodyInit | undefined, opts: PsoRequestOptions, json: boolean, parse: "json" | "blob"): Promise<unknown> {
    assertApiPath(path);
    const url = new URL(base + path, pageOrigin);
    if (url.origin !== pageOrigin) throw new PsoApiError("refused", "the resolved URL left the page's origin");
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const idempotent = IDEMPOTENT.has(method) || (opts.idempotencyKey !== undefined && method === "POST");
    const maxAttempts = idempotent ? 1 + retries : 1;
    let lastError: PsoApiError | undefined;
    let refreshed = false;

    for (let n = 1; n <= maxAttempts; n++) {
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs ?? timeout);
      const onAbort = () => ctl.abort();
      if (opts.signal?.aborted) { clearTimeout(timer); throw new PsoApiError("cancelled", "request cancelled"); }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const correlationId = o.correlationId?.() ?? uuid();
      try {
        const headers = new Headers({ accept: parse === "json" ? "application/json, application/problem+json" : "*/*", "x-correlation-id": correlationId });
        if (json && body !== undefined) headers.set("content-type", "application/json");
        for (const [k, v] of Object.entries(opts.headers ?? {})) {
          if (/^(authorization|cookie|host|origin|x-correlation-id|x-csrf-token|content-length)$/i.test(k)) throw new PsoApiError("refused", `header "${k}" is managed by the client and cannot be set by application code`);
          headers.set(k, v);
        }
        if (opts.idempotencyKey) headers.set("idempotency-key", opts.idempotencyKey);
        const token = await o.auth?.getAccessToken();
        if (token) headers.set("authorization", `Bearer ${token}`);
        if (!SAFE.has(method)) { const csrf = o.auth?.getCsrfToken?.(); if (csrf) headers.set("x-csrf-token", csrf); }
        let req: ApiRequest = { method, url, headers, body, signal: ctl.signal };
        for (const m of mws) { const r = await m.request?.(req); if (r) req = r; }
        if (req.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        let res = await doFetch(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}), signal: req.signal, credentials, cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
        for (const m of mws) { const r = await m.response?.(res, req); if (r) res = r; }

        if (res.status === 401 && !refreshed && (idempotent || SAFE.has(method)) && o.auth?.refresh) {
          refreshed = true;
          if (await refreshOnce()) { n--; continue; }
        }
        if (!res.ok) {
          const err = await toError(res, correlationId);
          if (res.status === 401) o.auth?.onUnauthorized?.(err);
          if ([502, 503, 504].includes(res.status) && n < maxAttempts) { lastError = err; await delay(backoff(n, o.retryDelayMs, err.retryAfterMs), opts.signal); continue; }
          throw err;
        }
        if (parse === "blob") return await res.blob();
        if (res.status === 204 || res.status === 205 || res.headers.get("content-length") === "0") return undefined;
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > MAX_RESPONSE_BYTES) throw new PsoApiError("invalid-response", `the response is larger than ${MAX_RESPONSE_BYTES} bytes`, { status: res.status, correlationId });
        const text = await res.text();
        if (text === "") return undefined;
        try { return JSON.parse(text); } catch (e) { throw new PsoApiError("invalid-response", "the orchestrator answered with a body that is not valid JSON", { status: res.status, correlationId, cause: e }); }
      } catch (e) {
        if (e instanceof PsoApiError) throw e;
        const err = timedOut ? new PsoApiError("timeout", `no response within ${Math.round((opts.timeoutMs ?? timeout) / 1000)} s`, { correlationId, cause: e })
          : opts.signal?.aborted || (e as Error).name === "AbortError" ? new PsoApiError("cancelled", "request cancelled", { correlationId, cause: e })
          : new PsoApiError("network", "the orchestrator could not be reached", { correlationId, cause: e });
        if (err.kind === "network" && n < maxAttempts) { lastError = err; await delay(backoff(n, o.retryDelayMs), opts.signal); continue; }
        throw err;
      } finally { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); }
    }
    throw lastError ?? new PsoApiError("network", "request failed");
  }

  const send = (method: string, path: string, body: unknown, opts: PsoRequestOptions = {}, raw = false, parse: "json" | "blob" = "json"): Promise<never> => {
    const payload: BodyInit | undefined = raw ? (body as BodyInit) : body === undefined ? undefined : JSON.stringify(body);
    const run = () => attempt(method, path, payload, opts, !raw, parse);
    if (method === "GET" && opts.dedupe) {
      const key = `${path}|${JSON.stringify(opts.query ?? {})}`;
      const hit = inflight.get(key);
      if (hit) return hit as Promise<never>;
      const p = run().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p as Promise<never>;
    }
    return run() as Promise<never>;
  };

  return {
    basePath: base,
    use: (mw) => { mws.push(mw); },
    get: (p, opts) => send("GET", p, undefined, opts),
    post: (p, b, opts) => send("POST", p, b, opts),
    put: (p, b, opts) => send("PUT", p, b, opts),
    patch: (p, b, opts) => send("PATCH", p, b, opts),
    delete: (p, opts) => send("DELETE", p, undefined, opts),
    upload: (p, body, opts) => send("POST", p, body, opts, true),
    download: (p, opts) => send("GET", p, undefined, opts, false, "blob") as unknown as Promise<Blob>,
  };
}

async function toError(res: Response, correlationId: string): Promise<PsoApiError> {
  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
  const cid = res.headers.get("x-correlation-id") ?? correlationId;
  let text = "";
  try { text = (await res.text()).slice(0, 64 * 1024); } catch { /* body unreadable */ }
  const ct = res.headers.get("content-type") ?? "";
  if (/json/i.test(ct) && text) {
    try {
      const p = JSON.parse(text) as ProblemDetails;
      if (p && typeof p === "object") return new PsoApiError("problem", p.title ?? `HTTP ${res.status}`, { status: res.status, problem: p, correlationId: p.correlationId ?? cid, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
    } catch { /* fall through */ }
  }
  return new PsoApiError("http", `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`, { status: res.status, correlationId: cid, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
}

const backoff = (n: number, base = 250, retryAfter?: number): number => Math.min(retryAfter ?? base * 2 ** (n - 1) + Math.floor(Math.random() * base), 5000);
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PsoApiError("cancelled", "request cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new PsoApiError("cancelled", "request cancelled")); }, { once: true });
  });
}

/** Removes anything that looks like a credential before a value is logged or shown. */
export function redact(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return value;
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/("?(?:access_token|refresh_token|id_token|password|client_secret|code_verifier|authorization)"?\s*[:=]\s*"?)[^"&,\s}]+/gi, "$1[redacted]");
}
