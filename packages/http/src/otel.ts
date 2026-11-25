import { randomBytes } from "node:crypto";
import { DURATION_BOUNDS_S, type OtlpConfig, type RequestRecord, type Telemetry, type TelemetrySink, type UpstreamSpan } from "./telemetry.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * OpenTelemetry export through the OFFICIAL SDK and OTLP exporters (@opentelemetry/sdk-metrics, sdk-trace-base, exporter-*-otlp-*). The SDK
 * packages are optional dependencies, loaded only when OTEL_EXPORTER_OTLP_ENDPOINT is set; without them a clear start-up error says what to install.
 *
 * The orchestrator measures (Telemetry) and this bridge publishes: histograms are recorded when an event happens, counters are read at export
 * time, and every span is created with the trace and span ids the orchestrator already handed to its callers and upstreams, so the exported tree
 * matches the headers that crossed the wire. Buffering is bounded (BatchSpanProcessor, 1000 spans) and shutdown flushes with a deadline.
 */
export interface OtelRuntime { sink: TelemetrySink; shutdown(): Promise<void> }

const hex = (n: number): string => randomBytes(n).toString("hex");
const PROTO_PKGS = { "http/protobuf": ["@opentelemetry/exporter-metrics-otlp-proto", "@opentelemetry/exporter-trace-otlp-proto"], "http/json": ["@opentelemetry/exporter-metrics-otlp-http", "@opentelemetry/exporter-trace-otlp-http"] } as const;

async function load(name: string): Promise<any> {
  try { return await import(name); }
  catch { throw new Error(`OpenTelemetry export needs the package ${name}: npm install ${name}`); }
}

export async function startOtel(cfg: OtlpConfig, t: Telemetry): Promise<OtelRuntime> {
  const api = await load("@opentelemetry/api");
  const { MeterProvider, PeriodicExportingMetricReader } = await load("@opentelemetry/sdk-metrics");
  const { BasicTracerProvider, BatchSpanProcessor } = await load("@opentelemetry/sdk-trace-base");
  const { resourceFromAttributes } = await load("@opentelemetry/resources");
  const [metricsPkg, tracesPkg] = PROTO_PKGS[cfg.protocol];
  const { OTLPMetricExporter } = await load(metricsPkg);
  const base = cfg.endpoint.href.replace(/\/$/, "");
  const resource = resourceFromAttributes({ "service.name": cfg.serviceName, "service.namespace": "pso", "pso.service": t.service });

  // ---- metrics
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: base + "/v1/metrics", headers: cfg.headers }), exportIntervalMillis: cfg.intervalMs, exportTimeoutMillis: Math.min(cfg.intervalMs, 10_000) })],
  });
  const meter = meterProvider.getMeter("pso");
  const advice = { explicitBucketBoundaries: [...DURATION_BOUNDS_S] };
  const requestDuration = meter.createHistogram("http.server.request.duration", { unit: "s", description: "Duration of inbound HTTP requests", advice });
  const upstreamDuration = meter.createHistogram("pso.upstream.request.duration", { unit: "s", description: "Duration of calls to upstream services", advice });
  const upstreamRequests = meter.createCounter("pso.upstream.requests", { description: "Upstream calls by outcome" });
  const authFailures = meter.createCounter("pso.auth.failures", { description: "401 and 403 responses" });
  meter.createObservableUpDownCounter("http.server.active_requests", { unit: "{request}" }).addCallback((o: any) => o.observe(t.counters().inFlight));
  meter.createObservableCounter("pso.ratelimit.decisions", { description: "Rate limit decisions" }).addCallback((o: any) => {
    const r = t.externals.rateLimit?.();
    if (!r) return; // not configured: no data point, never a zero
    o.observe(r.allowed, { result: "allowed" }); o.observe(r.denied, { result: "denied" }); o.observe(r.backendFailures, { result: "backend_failure" });
  });
  const dispatchCounter = (name: string, key: string, description: string): void => {
    meter.createObservableCounter(name, { description }).addCallback((o: any) => {
      const m = (t.externals.dispatch?.()?.["metrics"] ?? undefined) as Record<string, number> | undefined;
      if (m && typeof m[key] === "number") o.observe(m[key]);
    });
  };
  dispatchCounter("pso.dispatch.published", "published", "Events published");
  dispatchCounter("pso.dispatch.publish_failures", "publishFailed", "Failed publications");
  dispatchCounter("pso.dispatch.consumed", "consumed", "Events handled successfully");
  dispatchCounter("pso.dispatch.handler_failures", "failed", "Handler failures");
  dispatchCounter("pso.dispatch.retries", "retried", "Retry attempts");
  dispatchCounter("pso.dispatch.dead_lettered", "deadLettered", "Events moved to the dead-letter channel");
  dispatchCounter("pso.dispatch.duplicates", "duplicates", "Duplicate deliveries suppressed");

  // ---- traces: ids are chosen by the orchestrator (they already went out in headers); the SDK owns batching and export
  let tracerProvider: any;
  let tracer: any;
  const next: { trace?: string; span?: string } = {};
  if (cfg.traces) {
    const { OTLPTraceExporter } = await load(tracesPkg);
    tracerProvider = new BasicTracerProvider({
      resource,
      idGenerator: { generateTraceId: () => next.trace ?? hex(16), generateSpanId: () => next.span ?? hex(8) },
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: base + "/v1/traces", headers: cfg.headers }), { maxQueueSize: 1000, maxExportBatchSize: 256, scheduledDelayMillis: Math.min(cfg.intervalMs, 5000), exportTimeoutMillis: 10_000 })],
    });
    tracer = tracerProvider.getTracer("pso");
  }
  const emit = (o: { name: string; kind: number; traceId: string; spanId: string; parentSpanId?: string; remoteParent?: boolean; startMs: number; endMs: number; attrs: Record<string, string | number>; error: boolean }): void => {
    if (!tracer) return;
    next.trace = o.traceId; next.span = o.spanId;
    try {
      const parent = o.parentSpanId ? api.trace.setSpanContext(api.ROOT_CONTEXT, { traceId: o.traceId, spanId: o.parentSpanId, traceFlags: api.TraceFlags.SAMPLED, isRemote: !!o.remoteParent }) : api.ROOT_CONTEXT;
      const span = tracer.startSpan(o.name, { kind: o.kind, startTime: o.startMs, attributes: o.attrs }, parent);
      if (o.error) span.setStatus({ code: api.SpanStatusCode.ERROR });
      span.end(o.endMs);
    } finally { next.trace = undefined; next.span = undefined; }
  };

  const sink: TelemetrySink = {
    request(r: RequestRecord): void {
      const cls = `${Math.floor(r.status / 100)}xx`;
      requestDuration.record(r.seconds, { "http.request.method": r.method, "http.route": r.route, "http.response.status_class": cls });
      if (r.status === 401) authFailures.add(1, { "pso.kind": "unauthorized" });
      if (r.status === 403) authFailures.add(1, { "pso.kind": "forbidden" });
      if (r.trace.sampled) emit({ name: `${r.method} ${r.route}`, kind: api.SpanKind.SERVER, traceId: r.trace.traceId, spanId: r.trace.spanId, ...(r.trace.parentSpanId ? { parentSpanId: r.trace.parentSpanId, remoteParent: true } : {}), startMs: r.startedAtMs, endMs: r.startedAtMs + r.seconds * 1000,
        attrs: { "http.request.method": r.method, "http.route": r.route, "http.response.status_code": r.status, "pso.correlation_id": r.correlationId }, error: r.status >= 500 });
    },
    upstream(service: string, outcome: string, seconds: number, span: UpstreamSpan | undefined): void {
      upstreamDuration.record(seconds, { "pso.upstream": service });
      upstreamRequests.add(1, { "pso.upstream": service, "pso.outcome": outcome });
      if (span) emit({ name: `upstream ${service}`, kind: api.SpanKind.CLIENT, traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, startMs: span.startedAtMs, endMs: span.startedAtMs + seconds * 1000, attrs: { "pso.upstream": service, "pso.outcome": outcome }, error: outcome !== "ok" && outcome !== "aborted" });
    },
  };

  return {
    sink,
    async shutdown(): Promise<void> {
      const bounded = (p: Promise<unknown>): Promise<unknown> => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, 5000).unref())]);
      await bounded(meterProvider.forceFlush()); await bounded(meterProvider.shutdown());
      if (tracerProvider) { await bounded(tracerProvider.forceFlush()); await bounded(tracerProvider.shutdown()); }
    },
  };
}
