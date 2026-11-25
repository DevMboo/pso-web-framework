import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { currentPrincipal } from "@pso/security";
import { Injectable } from "./decorators.ts";
import { log } from "./logger.ts";
import { currentRequest } from "./context.ts";
import { traceContextFrom, traceparentOf, type UpstreamOutcome } from "./telemetry.ts";
import { mayForwardBearer, type UpstreamPolicy } from "./upstream-security.ts";
import { Upstream, upstreamFailure } from "./upstream.ts";
import type { ServiceName } from "./services.ts";

/**
 * `UpstreamClient`: calls from the orchestrator to the services it is registered with, for actions that COMPOSE a response from
 * several services instead of forwarding the request to one (`Upstream.forward`, which is unchanged).
 *
 * It is deliberately not a general HTTP client:
 *  - the destination is the NAME of a registered upstream service (pso.workspace.json or PSO_UPSTREAM_<NAME>); there is no URL
 *    parameter, the path is relative to that service and its endpoint prefix is applied here, once;
 *  - inside a request, the service must also be declared by the active route (`metadata: { services: ["customers", "orders"] }` in
 *    ROUTES.pso.ts, checked by `pso validate`): a call to a service the route did not declare is refused before anything is sent;
 *  - the transport is the upstream's own: its TLS and mutual TLS material, certificate and host-name verification (never disabled) and
 *    the production rule that refuses plain HTTP to another host are the ones `forward()` uses, from the same configuration;
 *  - the caller's credentials are never sent unless the call asks for them (`credentials: "caller"`), and then only when the upstream
 *    policy, the transport and the token audience allow it, exactly as for `forward()`. A refusal is an error, not a silent omission;
 *  - redirects are not followed, the response is read up to a size limit, every call has a deadline and can be cancelled; when the
 *    client of the current request disconnects, the calls made on its behalf are aborted;
 *  - the correlation id and the trace of the current request travel with every call.
 *
 * Failures are `UpstreamCallError`s. Left uncaught in an action they become a Problem Details answer that never contains the
 * service's response body (see the mapping in runtime.ts); caught, they let the action translate a downstream outcome on purpose.
 */


export type UpstreamCallKind =
  /** the name is not a registered upstream service */
  | "unknown_service"
  /** refused before anything was sent: undeclared on the route, an unsafe path or header, credentials that may not travel */
  | "policy"
  | "timeout"
  | "unavailable"
  | "tls"
  | "response_too_large"
  /** the service answered something that is not the expected JSON (or text) */
  | "invalid_response"
  | "cancelled"
  /** the service answered with a status outside 2xx; `status` is set */
  | "status";

/** The fields of an RFC 9457 problem a service answered with. Informational: for the action's own decisions and logs. */
export interface UpstreamProblem { type?: string; title?: string; status?: number; code?: string; detail?: string }

export class UpstreamCallError extends Error {
  readonly service: string;
  readonly kind: UpstreamCallKind;
  /** the status the service answered with (kind "status"), otherwise undefined */
  readonly status: number | undefined;
  /** the parsed problem document of that answer, when the service sent one */
  readonly problem: UpstreamProblem | undefined;
  constructor(service: string, kind: UpstreamCallKind, message: string, extra: { status?: number; problem?: UpstreamProblem } = {}) {
    super(message);
    this.name = "UpstreamCallError";
    this.service = service; this.kind = kind; this.status = extra.status; this.problem = extra.problem;
  }
  /** True when the service answered with this status (for example `e.is(404)` to translate "not found" on purpose). */
  is(status: number): boolean { return this.kind === "status" && this.status === status; }
}

/**
 * The problem an UpstreamCallError becomes when the action does not handle it. The service's own body is never part of the answer.
 *   - the service answered 404 or 409: the same status, as `upstream_not_found` / `upstream_conflict` (the usual meaning of those
 *     answers for the caller: something it referred to does not exist, or its change conflicts);
 *   - any other 4xx: 502 `upstream_rejected` (the orchestrator made a request the service refused: that is not the caller's 400/401/403);
 *   - 5xx, or an answer that is not what was expected: 502 `bad_gateway`;
 *   - no answer: 504 `upstream_timeout`, 503 `upstream_unavailable`, 502 `upstream_tls` / `upstream_response_too_large`;
 *   - refused before anything was sent: 502 `unknown_service`, 500 `upstream_policy`.
 * An action that knows better catches the error and raises its own `HttpError`.
 */
export function problemKindOf(e: UpstreamCallError): string {
  switch (e.kind) {
    case "unknown_service": return "unknown_service";
    case "policy": return "upstream_policy";
    case "timeout": return "upstream_timeout";
    case "unavailable": return "upstream_unavailable";
    case "tls": return "upstream_tls";
    case "response_too_large": return "upstream_response_too_large";
    case "status": return e.status === 404 ? "upstream_not_found" : e.status === 409 ? "upstream_conflict" : (e.status ?? 500) < 500 ? "upstream_rejected" : "bad_gateway";
    default: return "bad_gateway";
  }
}

export type UpstreamMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface UpstreamCallOptions {
  method?: UpstreamMethod;
  /** values for the `:name` segments of the path; each one is encoded as a single path segment */
  params?: Readonly<Record<string, string | number>>;
  query?: Readonly<Record<string, string | number | boolean | undefined | null>>;
  /** sent as JSON */
  body?: unknown;
  /** extra request headers. Hop-by-hop, identity, credential, correlation and framing headers are refused. */
  headers?: Readonly<Record<string, string>>;
  /** deadline for the whole call in milliseconds; at most (and by default) http.limits.upstreamResponseTimeoutMs */
  timeoutMs?: number;
  /** cancels the call */
  signal?: AbortSignal;
  /** largest response accepted; default http.limits.maxUpstreamResponseBytes */
  maxResponseBytes?: number;
  /** "caller" sends the bearer token of the current request when the upstream policy allows it; default "none" */
  credentials?: "none" | "caller";
  /** how the response body is read; default "json" (an empty body is `undefined`) */
  responseType?: "json" | "text";
}
export interface UpstreamResponse<T> { status: number; headers: Readonly<Record<string, string>>; data: T }

const REFUSED_HEADER = /^(connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|host|content-length|content-type|authorization|cookie|x-pso-.*|x-forwarded-.*|forwarded|x-correlation-id|traceparent|tracestate)$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const DEFAULT_POLICY: UpstreamPolicy = { forward: "inherit", allowPlaintext: false };

/** The path sent to the service: a literal, absolute path whose `:name` segments are replaced by encoded values. */
export function buildServicePath(service: string, path: string, params: Readonly<Record<string, string | number>> = {}): string {
  const refuse = (why: string): never => { throw new UpstreamCallError(service, "policy", `refused path for "${service}": ${why}`); };
  if (typeof path !== "string" || !path.startsWith("/")) refuse("it must start with \"/\" (paths are relative to the service; a URL is never accepted)");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\?#]/.test(path) || path.includes("//")) refuse("it contains a character that is not allowed in a path (use `query` for the query string)");
  const used = new Set<string>();
  const out = path.split("/").map((seg) => {
    if (seg === "." || seg === "..") refuse("it contains a relative segment");
    if (!seg.startsWith(":")) {
      let plain: string;
      try { plain = decodeURIComponent(seg); } catch { return refuse("it contains an invalid escape sequence"); }
      if (plain === "." || plain === ".." || /[/\\]/.test(plain)) refuse("it contains an encoded path separator or relative segment");
      return seg;
    }
    const name = seg.slice(1);
    const value = params[name];
    if (value === undefined || value === null || String(value) === "") refuse(`the path parameter "${name}" has no value`);
    used.add(name);
    const text = String(value);
    if (text === "." || text === "..") refuse(`the value of "${name}" is a relative segment`);
    return encodeURIComponent(text);
  }).join("/");
  for (const k of Object.keys(params)) if (!used.has(k)) refuse(`the parameter "${k}" does not appear in the path`);
  return out;
}

function queryString(query: UpstreamCallOptions["query"]): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) q.append(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

const single = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.join(", ") : v);
function safeHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) { const s = single(v); if (s !== undefined && k !== "set-cookie") out[k] = s; }
  return out;
}

function problemOf(contentType: string, body: Buffer): UpstreamProblem | undefined {
  if (!/^application\/(problem\+)?json\b/i.test(contentType) || body.length === 0) return undefined;
  try {
    const o = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return undefined;
    const text = (k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string).slice(0, 500) : undefined);
    const p: UpstreamProblem = {};
    for (const k of ["type", "title", "code", "detail"] as const) { const v = text(k); if (v !== undefined) p[k] = v; }
    if (typeof o["status"] === "number") p.status = o["status"];
    return Object.keys(p).length ? p : undefined;
  } catch { return undefined; }
}

export class UpstreamClient {
  /** `GET` and the parsed JSON body. */
  async get<T = unknown>(service: ServiceName, path: string, opts: Omit<UpstreamCallOptions, "method" | "body"> = {}): Promise<T> {
    return (await this.call<T>(service, path, { ...opts, method: "GET" })).data;
  }
  async post<T = unknown>(service: ServiceName, path: string, body: unknown, opts: Omit<UpstreamCallOptions, "method" | "body"> = {}): Promise<T> {
    return (await this.call<T>(service, path, { ...opts, method: "POST", body })).data;
  }
  async put<T = unknown>(service: ServiceName, path: string, body: unknown, opts: Omit<UpstreamCallOptions, "method" | "body"> = {}): Promise<T> {
    return (await this.call<T>(service, path, { ...opts, method: "PUT", body })).data;
  }
  async patch<T = unknown>(service: ServiceName, path: string, body: unknown, opts: Omit<UpstreamCallOptions, "method" | "body"> = {}): Promise<T> {
    return (await this.call<T>(service, path, { ...opts, method: "PATCH", body })).data;
  }
  async delete<T = unknown>(service: ServiceName, path: string, opts: Omit<UpstreamCallOptions, "method" | "body"> = {}): Promise<T> {
    return (await this.call<T>(service, path, { ...opts, method: "DELETE" })).data;
  }

  /** One call with full control. Resolves for a 2xx answer; every other outcome is an `UpstreamCallError`. */
  call<T = unknown>(service: ServiceName, path: string, opts: UpstreamCallOptions = {}): Promise<UpstreamResponse<T>> {
    const name = String(service);
    const ctx = currentRequest();
    const correlationId = ctx?.correlationId ?? randomUUID();
    const refuse = (kind: UpstreamCallKind, message: string): Promise<never> => {
      log("warn", "upstream call refused", { component: "upstream-client", service: name, reason: kind, detail: message, correlationId });
      return Promise.reject(new UpstreamCallError(name, kind, message));
    };
    const target = Upstream.services.get(name);
    if (!target) return refuse("unknown_service", `"${name}" is not a registered upstream service (pso.workspace.json or PSO_UPSTREAM_<NAME>)`);
    // the declaration is the authority: inside a request, only the services the active route names may be called
    if (ctx) {
      const declared = [...(ctx.route.service ? [ctx.route.service] : []), ...(ctx.route.services ?? [])];
      if (!declared.includes(name)) return refuse("policy", `route ${ctx.route.method} ${ctx.route.path} calls "${name}" but declares ${declared.length ? declared.map((d) => `"${d}"`).join(", ") : "no service"}: add it to metadata.services of the route in ROUTES.pso.ts`);
    }
    const method = opts.method ?? "GET";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return refuse("policy", `unsupported method ${JSON.stringify(String(method).slice(0, 12))}`);
    if (opts.body !== undefined && (method === "GET" || method === "DELETE")) return refuse("policy", `${method} calls do not take a body`);
    let fullPath: string;
    try { fullPath = target.prefix + buildServicePath(name, path, opts.params) + queryString(opts.query); }
    catch (e) { return refuse("policy", (e as Error).message); }

    const L = Upstream.limits;
    const ceiling = L.upstreamResponseTimeoutMs;
    const timeoutMs = opts.timeoutMs === undefined ? ceiling : opts.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ceiling) return refuse("policy", `timeoutMs must be a whole number between 1 and ${ceiling} (http.limits.upstreamResponseTimeoutMs)`);
    const maxResponse = opts.maxResponseBytes ?? L.maxUpstreamResponseBytes;
    if (!Number.isInteger(maxResponse) || maxResponse < 1) return refuse("policy", "maxResponseBytes must be a positive whole number");

    const clientSpanId = randomBytes(8).toString("hex");
    const trace = ctx?.trace ?? traceContextFrom(undefined);
    const headers: Record<string, string> = { accept: opts.responseType === "text" ? "text/plain, */*;q=0.1" : "application/json" };
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (!HEADER_NAME.test(k) || REFUSED_HEADER.test(k)) return refuse("policy", `the header "${k.slice(0, 40)}" cannot be set on an upstream call`);
      // eslint-disable-next-line no-control-regex
      if (typeof v !== "string" || /[\u0000-\u001f\u007f]/.test(v)) return refuse("policy", `the header "${k}" has an invalid value`);
      headers[k.toLowerCase()] = v;
    }
    if ((opts.credentials ?? "none") === "caller") {
      const bearer = ctx?.req.headers["authorization"];
      if (!ctx || typeof bearer !== "string") return refuse("policy", `credentials: "caller" was requested for "${name}" but the current request carries no bearer token`);
      const fwd = mayForwardBearer({ routePublic: ctx.route.public, global: Upstream.credentials, policy: target.policy ?? DEFAULT_POLICY, tls: !!target.material, host: target.host, principalAudiences: currentPrincipal()?.audiences });
      if (!fwd.forward) return refuse("policy", `the caller's token may not be sent to "${name}": ${fwd.reason ?? "policy"}`);
      headers["authorization"] = bearer;
    }
    let payload: Buffer | undefined;
    if (opts.body !== undefined) {
      try { payload = Buffer.from(JSON.stringify(opts.body), "utf8"); } catch { return refuse("policy", "the body cannot be serialized as JSON"); }
      if (payload.length > L.maxBodyBytes) return refuse("policy", `the body is larger than http.limits.maxBodyBytes (${L.maxBodyBytes})`);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    headers["x-correlation-id"] = correlationId;
    headers["traceparent"] = traceparentOf(trace, clientSpanId);

    return new Promise<UpstreamResponse<T>>((resolve, reject) => {
      const t0 = process.hrtime.bigint();
      const startedAtMs = Date.now();
      let settled = false, timedOut = false, cancelled = false;
      const cleanup: Array<() => void> = [];
      const finish = (outcome: UpstreamOutcome, result: UpstreamResponse<T> | UpstreamCallError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        for (const c of cleanup) c();
        Upstream.telemetry?.upstreamCall(name, outcome, Number(process.hrtime.bigint() - t0) / 1e9, { traceId: trace.traceId, spanId: clientSpanId, parentSpanId: trace.spanId, startedAtMs });
        if (result instanceof UpstreamCallError) {
          if (result.kind !== "status") log("warn", "upstream call failed", { component: "upstream-client", service: name, reason: result.kind, correlationId });
          reject(result);
        } else resolve(result);
      };
      const fail = (outcome: UpstreamOutcome, kind: UpstreamCallKind, message: string, extra?: { status?: number; problem?: UpstreamProblem }): void => finish(outcome, new UpstreamCallError(name, kind, message, extra));

      const reqOptions = { host: target.host, port: target.port, method, path: fullPath, headers, timeout: L.upstreamTimeoutMs };
      const up = target.material
        ? httpsRequest({ ...reqOptions, agent: target.material.current(), ...(target.material.serverName ? { servername: target.material.serverName } : {}) })
        : httpRequest(reqOptions);
      const abort = (): void => { cancelled = true; up.destroy(new Error("cancelled")); };
      const deadline = setTimeout(() => { timedOut = true; up.destroy(new Error("upstream deadline")); }, timeoutMs);
      deadline.unref();
      if (opts.signal) {
        if (opts.signal.aborted) abort();
        else { opts.signal.addEventListener("abort", abort, { once: true }); cleanup.push(() => opts.signal!.removeEventListener("abort", abort)); }
      }
      // the client of the current request went away: the work done on its behalf stops
      if (ctx?.res) {
        const res = ctx.res;
        const onClose = (): void => { if (!res.writableFinished) abort(); };
        if (res.closed && !res.writableFinished) abort(); else { res.once("close", onClose); cleanup.push(() => res.off("close", onClose)); }
      }
      up.on("timeout", () => { timedOut = true; up.destroy(new Error("upstream timeout")); });
      up.on("error", (err: NodeJS.ErrnoException) => {
        if (cancelled) return fail("aborted", "cancelled", `the call to "${name}" was cancelled`);
        const f = upstreamFailure(err, timedOut);
        const kind: UpstreamCallKind = f.error === "upstream_timeout" ? "timeout" : f.error === "upstream_unavailable" ? "unavailable" : f.error === "upstream_tls" ? "tls" : "invalid_response";
        const outcome: UpstreamOutcome = kind === "timeout" ? "timeout" : kind === "unavailable" ? "unavailable" : kind === "tls" ? "tls" : "bad_gateway";
        fail(outcome, kind, kind === "timeout" ? `"${name}" did not answer in time` : kind === "unavailable" ? `"${name}" could not be reached` : kind === "tls" ? `the TLS connection to "${name}" could not be established or verified` : `the exchange with "${name}" failed`);
      });
      up.on("response", (r) => {
        const status = r.statusCode ?? 0;
        const declared = r.headers["content-length"] === undefined ? undefined : Number(r.headers["content-length"]);
        if (declared !== undefined && (!Number.isFinite(declared) || declared > maxResponse)) {
          r.destroy(); up.destroy();
          return fail("response_too_large", "response_too_large", `the response of "${name}" is larger than the limit (${maxResponse} bytes)`);
        }
        const chunks: Buffer[] = [];
        let got = 0;
        r.on("data", (c: Buffer) => {
          got += c.length;
          if (got > maxResponse) { r.destroy(); up.destroy(); fail("response_too_large", "response_too_large", `the response of "${name}" is larger than the limit (${maxResponse} bytes)`); return; }
          chunks.push(c);
        });
        r.on("error", () => fail(cancelled ? "aborted" : timedOut ? "timeout" : "bad_gateway", cancelled ? "cancelled" : timedOut ? "timeout" : "invalid_response", cancelled ? `the call to "${name}" was cancelled` : timedOut ? `"${name}" did not answer in time` : `the response of "${name}" was interrupted`));
        r.on("aborted", () => fail(cancelled ? "aborted" : "bad_gateway", cancelled ? "cancelled" : "invalid_response", cancelled ? `the call to "${name}" was cancelled` : `the response of "${name}" was interrupted`));
        r.on("end", () => {
          const body = Buffer.concat(chunks);
          const contentType = String(r.headers["content-type"] ?? "");
          // a redirect is an answer like any other: it is never followed, so a service cannot steer a call to another host
          if (status < 200 || status > 299) {
            const problem = problemOf(contentType, body);
            return fail(status >= 500 ? "bad_gateway" : "ok", "status", `"${name}" answered ${status}`, { status, ...(problem ? { problem } : {}) });
          }
          const responseHeaders = safeHeaders(r.headers);
          if (opts.responseType === "text") return finish("ok", { status, headers: responseHeaders, data: body.toString("utf8") as T });
          if (body.length === 0) return finish("ok", { status, headers: responseHeaders, data: undefined as T });
          if (!/^application\/([a-z0-9.-]+\+)?json\b/i.test(contentType)) return fail("bad_gateway", "invalid_response", `"${name}" answered ${status} with a body that is not JSON`);
          try { finish("ok", { status, headers: responseHeaders, data: JSON.parse(body.toString("utf8")) as T }); }
          catch { fail("bad_gateway", "invalid_response", `"${name}" answered ${status} with invalid JSON`); }
        });
      });
      up.end(payload);
    });
  }
}
// built into every module, like `Upstream`: inject it by constructor type without listing it in `providers`
Injectable()(UpstreamClient);
