import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { normalizePrefix, servicePrefix } from "@pso/core";
import { currentPrincipal } from "@pso/security";
import { Injectable } from "./decorators.ts";
import { DEFAULT_HTTP_LIMITS, type HttpLimits } from "./limits.ts";
import { Telemetry, traceparentOf, type UpstreamOutcome } from "./telemetry.ts";
import { TlsMaterial, mayForwardBearer, type UpstreamPolicy } from "./upstream-security.ts";
import { log } from "./logger.ts";
import { encodeMultipart } from "./upload.ts";
import { HttpError } from "./errors.ts";
import { contexts, rawBodies, type RequestContext } from "./context.ts";
import { sendAndClose, sendProblem } from "./responses.ts";
import type { ServiceName } from "./services.ts";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

// ---------- upstream discovery (declared, never scanned) ----------
export function loadUpstreams(workspaceFile: string | undefined, env: NodeJS.ProcessEnv = process.env): Map<string, { host: string; port: number; prefix: string }> {
  const map = new Map<string, { host: string; port: number; prefix: string }>();
  if (workspaceFile) {
    try {
      const ws = JSON.parse(readFileSync(workspaceFile, "utf8").replace(/^\uFEFF/, "")) as { services: Array<{ name: string; port: number; role?: string; runtime?: "node" | "spring-boot"; prefix?: string }> };
      for (const s of ws.services) if (s.role !== "orchestrator") map.set(s.name, { host: "127.0.0.1", port: s.port, prefix: servicePrefix({ name: s.name, runtime: s.runtime ?? "node", ...(s.prefix !== undefined ? { prefix: s.prefix } : {}) }) });
    } catch {
      if (!Object.keys(env).some((k) => k.startsWith("PSO_UPSTREAM_"))) log("warn", "no workspace file and no PSO_UPSTREAM_* variables: no upstream services registered", { file: workspaceFile });
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("PSO_UPSTREAM_") || !v || /_(PREFIX|TLS|TLS_CA_FILE|TLS_CERT_FILE|TLS_KEY_FILE|TLS_KEY_PASSPHRASE|TLS_SERVER_NAME|FORWARD|AUDIENCE|ALLOW_PLAINTEXT)$/.test(k)) continue; // policy variables of an upstream are not upstreams
    const m = /^([^:]+):(\d{1,5})$/.exec(v);
    if (!m || !HOSTNAME.test(m[1]!) || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error(`${k} must be host:port (got an invalid value)`);
    map.set(k.slice("PSO_UPSTREAM_".length).toLowerCase().replace(/_/g, "-"), { host: m[1]!, port: Number(m[2]), prefix: normalizePrefix(env[`${k}_PREFIX`] ?? "") });
  }
  return map;
}

/** Why an upstream exchange failed, mapped to the gateway status the client receives. */
export function upstreamFailure(err: NodeJS.ErrnoException, timedOut: boolean): { status: 502 | 503 | 504; error: string } {
  if (timedOut) return { status: 504, error: "upstream_timeout" };
  const code = err.code ?? "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)|ERR_TLS|HOSTNAME_MISMATCH|DEPTH_ZERO|ERR_SSL|ALERT/.test(code)) return { status: 502, error: "upstream_tls" }; // certificate or handshake problem: permanent, not "unreachable"
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(code)) return { status: 503, error: "upstream_unavailable" };
  if (code === "ETIMEDOUT") return { status: 504, error: "upstream_timeout" };
  return { status: 502, error: "bad_gateway" }; // reset, malformed response, protocol errors
}

export interface ForwardOptions {
  /** upstream path (without the service prefix); default: the request path */
  path?: string;
  /** largest upstream response accepted for this call; default MAX_UPSTREAM_RESPONSE_BYTES */
  maxResponseBytes?: number;
}
/** A declared upstream service with its security policy (TLS / mutual TLS, credential forwarding). */
export interface UpstreamTarget { host: string; port: number; prefix: string; policy?: UpstreamPolicy; material?: TlsMaterial }
const DEFAULT_POLICY: UpstreamPolicy = { forward: "inherit", allowPlaintext: false };

/** Hygienic reverse proxy available to every module as an injectable provider. */
export class Upstream {
  static services = new Map<string, UpstreamTarget>();
  /** set by bootstrap(); upstream calls are measured when present */
  static telemetry: Telemetry | undefined;
  static limits: HttpLimits = DEFAULT_HTTP_LIMITS;
  /** which credentials are forwarded to upstream services on guarded routes (security.propagation.forward) */
  static credentials: "bearer" | "none" = "bearer";

  /** Forwards the current request to `service`. The service must match the route's declared `metadata.service`. */
  forward(req: IncomingMessage, res: ServerResponse, service: ServiceName, opts: ForwardOptions = {}): Promise<void> {
    return this.exchange(req, res, service, opts);
  }

  /**
   * Streams a download from `service` to the client: the upstream response is piped with backpressure (a slow client slows the upstream read,
   * a client that goes away stops it), the size limit is `maxResponseBytes` (default MAX_UPSTREAM_RESPONSE_BYTES, raise it for large files)
   * and successful responses are hardened: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store`
   * and `Content-Disposition: attachment` unless the service chose a disposition.
   */
  forwardDownload(req: IncomingMessage, res: ServerResponse, service: ServiceName, opts: ForwardOptions = {}): Promise<void> {
    return this.exchange(req, res, service, { ...opts, download: true });
  }

  /**
   * Forwards the files and fields of a VALIDATED upload DTO (`@Body(Dto)` with `@FileField`) to `service` as a fresh multipart request.
   * Only declared, valid fields are sent; the client's raw body, content type and identity headers are never relayed. Correlation, trace and
   * the credentials allowed by the upstream policy travel exactly as in `forward()`. `opts.path` is the upstream path (without the service prefix).
   */
  forwardUpload(req: IncomingMessage, res: ServerResponse, service: ServiceName, dto: object, opts: { path?: string } = {}): Promise<void> {
    return this.exchange(req, res, service, { ...opts, body: encodeMultipart(dto) });
  }

  exchange(req: IncomingMessage, res: ServerResponse, service: string, opts: ForwardOptions & { download?: boolean; body?: { contentType: string; length: number; stream: Readable } }): Promise<void> {
    const ctx = contexts.get(req);
    if (!ctx) return Promise.reject(new HttpError(500, "forward() called outside a request"));
    if (ctx.route.service !== service) return Promise.reject(new HttpError(500, `route declares service "${ctx.route.service ?? "(none)"}" but the action forwards to "${service}"`));
    const target = Upstream.services.get(service);
    if (!target) { sendProblem(res, req, "unknown_service", ctx.correlationId); return Promise.resolve(); }
    const L = Upstream.limits;
    const declared = req.headers["content-length"] === undefined ? 0 : Number(req.headers["content-length"]);
    const maxResponse = opts.maxResponseBytes ?? L.maxUpstreamResponseBytes;
    if (!opts.body && declared > L.maxBodyBytes) { sendAndClose(res, req, "payload_too_large", ctx.correlationId); return Promise.resolve(); }
    const url = new URL(req.url ?? "/", "http://localhost");
    return new Promise((done) => {
      let settled = false, timedOut = false;
      const t0 = process.hrtime.bigint();
      const startedAtMs = Date.now();
      const clientSpanId = randomBytes(8).toString("hex"); // the same id travels in traceparent and names the exported client span
      let outcome: UpstreamOutcome = "ok";
      const settle = (): void => { if (!settled) { settled = true; clearTimeout(deadline); Upstream.telemetry?.upstreamCall(service, outcome, Number(process.hrtime.bigint() - t0) / 1e9, { traceId: ctx.trace.traceId, spanId: clientSpanId, parentSpanId: ctx.trace.spanId, startedAtMs }); done(); } };
      const onResponse = (r: IncomingMessage): void => {
        const len = r.headers["content-length"] === undefined ? undefined : Number(r.headers["content-length"]);
        if (len !== undefined && (!Number.isFinite(len) || len > maxResponse)) {
          // nothing committed yet: a stable gateway failure instead of a truncated body
          r.destroy(); up.destroy();
          outcome = "response_too_large";
          log("warn", "upstream response rejected: too large or invalid length", { service, correlationId: ctx.correlationId });
          sendAndClose(res, req, "upstream_response_too_large", ctx.correlationId);
          return settle();
        }
        const h = { ...r.headers } as Record<string, string | string[] | undefined>;
        for (const k of Object.keys(h)) if (HOP.has(k)) delete h[k];
        h["x-correlation-id"] = ctx.correlationId;
        if (opts.download && (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 300) {
          h["x-content-type-options"] = "nosniff"; h["content-security-policy"] = "sandbox"; h["cache-control"] = "private, no-store";
          h["content-disposition"] ??= "attachment";
        }
        res.writeHead(r.statusCode ?? 502, h);
        let got = 0;
        r.on("data", (c: Buffer) => {
          got += c.length;
          if (got > maxResponse) { // headers are already committed: close the stream, never send a second status
            outcome = "response_too_large";
            log("warn", "upstream stream exceeded the response limit and was closed", { service, correlationId: ctx.correlationId });
            r.destroy(); up.destroy(); res.destroy(); settle();
          }
        });
        r.on("error", () => { res.destroy(); settle(); });
        r.on("aborted", () => { res.destroy(); settle(); });
        r.pipe(res); // pipe applies backpressure: a slow client pauses the upstream read
        r.on("end", settle);
      };
      const outgoingHeaders = (): Record<string, string> => {
        const h = forwardHeaders(req, ctx, target, clientSpanId);
        if (opts.body) { h["content-type"] = opts.body.contentType; h["content-length"] = String(opts.body.length); } // rebuilt body: nothing of the client's framing is reused
        return h;
      };
      const reqOptions = { host: target.host, port: target.port, method: req.method, path: target.prefix + (opts.path ?? url.pathname) + url.search, headers: outgoingHeaders(), timeout: L.upstreamTimeoutMs };
      const up = target.material
        ? httpsRequest({ ...reqOptions, agent: target.material.current(), ...(target.material.serverName ? { servername: target.material.serverName } : {}) }, onResponse)
        : httpRequest(reqOptions, onResponse);
      const deadline = setTimeout(() => { timedOut = true; up.destroy(new Error("upstream deadline")); }, L.upstreamResponseTimeoutMs);
      deadline.unref();
      up.on("timeout", () => { timedOut = true; up.destroy(new Error("upstream timeout")); });
      up.on("error", (err: NodeJS.ErrnoException) => {
        const f = upstreamFailure(err, timedOut);
        outcome = ({ upstream_timeout: "timeout", upstream_unavailable: "unavailable", upstream_tls: "tls" } as Record<string, UpstreamOutcome>)[f.error] ?? "bad_gateway";
        if (!res.headersSent && !res.destroyed) sendProblem(res, req, f.error, ctx.correlationId); else res.destroy();
        settle();
      });
      // the client went away (or aborted): stop the upstream work and release the connection
      res.on("close", () => { if (!res.writableFinished) { outcome = "aborted"; up.destroy(); settle(); } });
      if (opts.body) {
        const out = opts.body.stream;
        out.once("error", () => { outcome = "bad_gateway"; up.destroy(); });
        res.once("close", () => out.destroy());
        out.pipe(up); // backpressure: the next chunk is read from disk only when the upstream accepted the previous one
        return;
      }
      const consumed = rawBodies.get(req);
      if (consumed) { up.end(consumed); return; }
      let received = 0;
      const onData = (c: Buffer): void => {
        received += c.length;
        if (received > L.maxBodyBytes) {
          outcome = "aborted"; req.off("data", onData); req.unpipe(up); up.destroy();
          sendAndClose(res, req, "payload_too_large", ctx.correlationId);
          settle();
        }
      };
      req.on("data", onData);
      req.pipe(up);
    });
  }
}
// `Upstream` is built into every module. Decorators are applied by call because this package is plain ESM.
Injectable()(Upstream);

/** Never trust client identity headers; Authorization only travels on guarded routes. */
function forwardHeaders(req: IncomingMessage, ctx: RequestContext, target?: UpstreamTarget, clientSpanId: string = randomBytes(8).toString("hex")): Record<string, string> {
  const h: Record<string, string> = {};
  // the user's token goes to this upstream only when its own policy, the transport and the token audience all allow it
  const fwd = mayForwardBearer({ routePublic: ctx.route.public, global: Upstream.credentials, policy: target?.policy ?? DEFAULT_POLICY, tls: !!target?.material, host: target?.host ?? "127.0.0.1", principalAudiences: currentPrincipal()?.audiences });
  if (!fwd.forward && fwd.reason && fwd.reason !== "policy" && fwd.reason !== "public route" && req.headers["authorization"]) log("warn", "bearer token not forwarded to upstream", { reason: fwd.reason, service: ctx.route.service, correlationId: ctx.correlationId });
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP.has(key) || key.startsWith("x-pso-") || key === "x-forwarded-for" || key === "x-correlation-id" || key === "traceparent") continue;
    if (key === "authorization" && !fwd.forward) continue;
    if (typeof v === "string") h[key] = v;
  }
  h["x-correlation-id"] = ctx.correlationId;
  h["traceparent"] = traceparentOf(ctx.trace, clientSpanId); // a child span: the upstream continues the same trace
  return h;
}
