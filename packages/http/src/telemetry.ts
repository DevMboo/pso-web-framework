import { randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Runtime telemetry of the orchestrator. Everything here is measured from real requests: nothing is estimated and nothing is invented.
 * A value that cannot be measured is reported as unavailable by the consumer (Studio), never as zero.
 *
 *  - Counters and fixed-bucket histograms for HTTP requests and upstream calls (OpenTelemetry names and units: seconds).
 *  - W3C Trace Context: an incoming \`traceparent\` is continued (and forwarded upstream with a new span id); without one a trace starts here.
 *  - A diagnostics snapshot served only to a caller that presents PSO_DIAGNOSTICS_TOKEN (see runtime.ts); never served otherwise.
 *  - An OPTIONAL OTLP/HTTP (JSON) exporter, enabled only by the standard OTEL_EXPORTER_OTLP_ENDPOINT variable. Nothing is sent anywhere by default.
 */
export const DURATION_BOUNDS_S = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

class Histogram {
  readonly counts = new Array<number>(DURATION_BOUNDS_S.length + 1).fill(0);
  count = 0;
  sum = 0;
  max = 0;
  record(seconds: number): void {
    this.count++; this.sum += seconds; if (seconds > this.max) this.max = seconds;
    let i = 0;
    while (i < DURATION_BOUNDS_S.length && seconds > DURATION_BOUNDS_S[i]!) i++;
    this.counts[i]!++;
  }
  snapshot(): { count: number; sumSeconds: number; maxSeconds: number; buckets: number[] } { return { count: this.count, sumSeconds: this.sum, maxSeconds: this.max, buckets: [...this.counts] }; }
}

export interface TraceContext { traceId: string; spanId: string; parentSpanId: string | undefined; sampled: boolean }
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** Continues the caller's trace when the header is valid (all-zero ids are invalid per the spec); otherwise starts a new one. */
export function traceContextFrom(header: string | string[] | undefined): TraceContext {
  const raw = Array.isArray(header) ? header[0] : header;
  const m = raw ? TRACEPARENT.exec(raw.trim().toLowerCase()) : null;
  if (m && !/^0+$/.test(m[1]!) && !/^0+$/.test(m[2]!)) return { traceId: m[1]!, spanId: hex(8), parentSpanId: m[2]!, sampled: (parseInt(m[3]!, 16) & 1) === 1 };
  return { traceId: hex(16), spanId: hex(8), parentSpanId: undefined, sampled: true };
}
export const traceparentOf = (c: TraceContext, spanId: string = c.spanId): string => `00-${c.traceId}-${spanId}-${c.sampled ? "01" : "00"}`;

export interface RequestRecord { method: string; route: string; status: number; seconds: number; trace: TraceContext; startedAtMs: number; correlationId: string }
export interface UpstreamSpan { traceId: string; spanId: string; parentSpanId: string; startedAtMs: number }
/** Receives every measured event; the OpenTelemetry bridge is one implementation. It must never throw into the request path. */
export interface TelemetrySink {
  request(r: RequestRecord): void;
  upstream(service: string, outcome: string, seconds: number, span: UpstreamSpan | undefined): void;
}
export type UpstreamOutcome = "ok" | "timeout" | "unavailable" | "tls" | "bad_gateway" | "response_too_large" | "aborted";


export interface ExternalSnapshots {
  rateLimit?: () => { provider: string; allowed: number; denied: number; backendFailures: number; keys: number } | undefined;
  dispatch?: () => Record<string, unknown> | undefined;
  channels?: () => Record<string, unknown> | undefined;
  readiness?: () => { status: string; detail?: string };
}

export class Telemetry {
  readonly service: string;
  readonly startedAt = Date.now();
  state: "starting" | "ready" | "draining" | "stopped" = "starting";
  private readonly duration = new Map<string, Histogram>();           // key: method|route|class
  private readonly byClass: Record<string, number> = { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  private total = 0;
  private auth = { unauthorized: 0, forbidden: 0 };
  private rateLimited = 0;
  private inFlight = 0;
  private maxInFlight = 0;
  private readonly upstreamHist = new Map<string, Histogram>();       // key: service
  private readonly upstreamOutcomes = new Map<string, number>();      // key: service|outcome
  private shutdown: { startedAt: number; inFlightAtStart: number; finishedAt?: number } | undefined;
  externals: ExternalSnapshots = {};
  sink: TelemetrySink | undefined;

  constructor(service: string) { this.service = service; }

  requestStarted(): void { this.inFlight++; if (this.inFlight > this.maxInFlight) this.maxInFlight = this.inFlight; }

  requestFinished(r: RequestRecord): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    try { this.sink?.request(r); } catch { /* telemetry never affects requests */ }
    this.total++;
    const cls = `${Math.floor(r.status / 100)}xx`;
    this.byClass[cls] = (this.byClass[cls] ?? 0) + 1;
    if (r.status === 401) this.auth.unauthorized++;
    if (r.status === 403) this.auth.forbidden++;
    if (r.status === 429) this.rateLimited++;
    const key = `${r.method}|${r.route}|${cls}`;
    let h = this.duration.get(key);
    if (!h) { if (this.duration.size >= 500) return; h = new Histogram(); this.duration.set(key, h); } // bounded cardinality: routes are declared, never raw paths
    h.record(r.seconds);
  }

  upstreamCall(service: string, outcome: UpstreamOutcome, seconds: number, span?: UpstreamSpan): void {
    try { this.sink?.upstream(service, outcome, seconds, span); } catch { /* telemetry never affects requests */ }
    let h = this.upstreamHist.get(service);
    if (!h) { if (this.upstreamHist.size >= 100) return; h = new Histogram(); this.upstreamHist.set(service, h); }
    h.record(seconds);
    const k = `${service}|${outcome}`;
    this.upstreamOutcomes.set(k, (this.upstreamOutcomes.get(k) ?? 0) + 1);
  }


  beginShutdown(): void { this.state = "draining"; this.shutdown = { startedAt: Date.now(), inFlightAtStart: this.inFlight }; }
  endShutdown(): void { this.state = "stopped"; if (this.shutdown) this.shutdown.finishedAt = Date.now(); }

  /** The diagnostics document. Contains no credentials, no payloads, no raw paths and no client addresses. */
  snapshot(): Record<string, unknown> {
    const up: Record<string, unknown> = {};
    for (const [svc, h] of this.upstreamHist) {
      const outcomes: Record<string, number> = {};
      for (const [k, n] of this.upstreamOutcomes) { const [s, o] = k.split("|"); if (s === svc) outcomes[o!] = n; }
      up[svc] = { latency: h.snapshot(), outcomes };
    }
    const routes: Array<Record<string, unknown>> = [];
    for (const [k, h] of this.duration) { const [method, route, cls] = k.split("|"); routes.push({ method, route, class: cls, ...h.snapshot() }); }
    return {
      schema: 1, instrumented: true, service: this.service, state: this.state, uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000), at: new Date().toISOString(),
      readiness: this.externals.readiness?.() ?? { status: this.state === "ready" ? "UP" : "DOWN" },
      http: { requests: this.total, byClass: { ...this.byClass }, unauthorized: this.auth.unauthorized, forbidden: this.auth.forbidden, rateLimited: this.rateLimited, inFlight: this.inFlight, maxInFlight: this.maxInFlight, durationBoundsSeconds: [...DURATION_BOUNDS_S], routes },
      upstream: up,
      rateLimit: this.externals.rateLimit?.() ?? null,
      dispatch: this.externals.dispatch?.() ?? null,
      ...(this.externals.channels ? { channels: this.externals.channels() ?? null } : {}),
      shutdown: this.shutdown ?? null,
      tracing: { exporter: this.sink ? "opentelemetry" : "none" },
    };
  }

  /** for the exporter */
  histograms(): { duration: Map<string, Histogram>; upstream: Map<string, Histogram> } { return { duration: this.duration, upstream: this.upstreamHist }; }
  counters(): { byClass: Record<string, number>; rateLimited: number; unauthorized: number; forbidden: number; inFlight: number; upstreamOutcomes: Map<string, number> } {
    return { byClass: this.byClass, rateLimited: this.rateLimited, unauthorized: this.auth.unauthorized, forbidden: this.auth.forbidden, inFlight: this.inFlight, upstreamOutcomes: this.upstreamOutcomes };
  }
}

/** Constant-time check of the diagnostics bearer token. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (\S+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DiagnosticsConfig { token: string | undefined }
export class DiagnosticsConfigError extends Error {}
/** The diagnostics endpoint exists only with a strong token (32+ characters); a weak token is a start-up error, never a silent downgrade. */
export function loadDiagnostics(env: NodeJS.ProcessEnv): DiagnosticsConfig {
  const t = env["PSO_DIAGNOSTICS_TOKEN"];
  if (t === undefined || t === "") return { token: undefined };
  if (t.length < 32) throw new DiagnosticsConfigError("PSO_DIAGNOSTICS_TOKEN must be at least 32 characters (use a random value); the diagnostics endpoint stays off until it is");
  return { token: t };
}

// ---------------------------------------------------------------- optional OpenTelemetry export (configuration)
export interface OtlpConfig { endpoint: URL; headers: Record<string, string>; intervalMs: number; traces: boolean; serviceName: string; protocol: "http/protobuf" | "http/json" }
export class OtlpConfigError extends Error {}

/** Standard OTEL_* variables only. Nothing is exported unless OTEL_EXPORTER_OTLP_ENDPOINT is set. */
export function loadOtlp(env: NodeJS.ProcessEnv, defaultService: string): OtlpConfig | undefined {
  const raw = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!raw) return undefined;
  let endpoint: URL;
  try { endpoint = new URL(raw); } catch { throw new OtlpConfigError("OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL"); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new OtlpConfigError("OTEL_EXPORTER_OTLP_ENDPOINT must be http:// or https://");
  if (endpoint.username || endpoint.password) throw new OtlpConfigError("OTEL_EXPORTER_OTLP_ENDPOINT must not contain credentials; use OTEL_EXPORTER_OTLP_HEADERS");
  if ((env["PSO_ENV"] ?? env["NODE_ENV"]) === "production" && endpoint.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new OtlpConfigError("in production a remote OTLP endpoint must use https://");
  const protocol = env["OTEL_EXPORTER_OTLP_PROTOCOL"] ?? "http/protobuf";
  if (protocol !== "http/protobuf" && protocol !== "http/json") throw new OtlpConfigError('OTEL_EXPORTER_OTLP_PROTOCOL must be "http/protobuf" or "http/json" (gRPC is not supported)');
  const headers: Record<string, string> = {};
  for (const part of (env["OTEL_EXPORTER_OTLP_HEADERS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i < 1 || !/^[A-Za-z0-9-]+$/.test(part.slice(0, i))) throw new OtlpConfigError("OTEL_EXPORTER_OTLP_HEADERS must look like name=value,name2=value2");
    headers[part.slice(0, i)] = part.slice(i + 1);
  }
  const interval = Number(env["PSO_OTEL_EXPORT_INTERVAL_MS"] ?? 10_000);
  if (!Number.isInteger(interval) || interval < 500 || interval > 600_000) throw new OtlpConfigError("PSO_OTEL_EXPORT_INTERVAL_MS must be between 500 and 600000");
  return { endpoint, headers, intervalMs: interval, traces: env["PSO_OTEL_TRACES"] !== "false", serviceName: env["OTEL_SERVICE_NAME"] || defaultService, protocol };
}
