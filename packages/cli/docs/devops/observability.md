---
title: Runtime telemetry and OpenTelemetry
description: What the orchestrator measures, the authenticated diagnostics endpoint, W3C trace propagation, the opt-in OTLP export and how Studio shows it without inventing numbers.
order: 8
status: partial
keywords: [telemetry, metrics, tracing, traceparent, opentelemetry, otlp, diagnostics, PSO_DIAGNOSTICS_TOKEN, studio]
related: [devops/studio, devops/health-and-observability, dispatch/security-and-observability, security/rate-limiting]
---
> [!STATUS]
> Implemented and verified for the **TypeScript orchestrator** (real traffic, real OTLP collector endpoints, real Redis for the dispatch counters, Studio in a real browser) and for **Spring Boot services** through `pso-observability-starter`. Export uses the **official OpenTelemetry SDK / Micrometer exporters**. Consumer lag and dead-letter depth are **not exported** and therefore not shown. OpenTelemetry **logs** are not exported (logs stay structured JSON with the correlation and trace ids).

Everything below is measured from real requests. A value that cannot be measured is reported as unavailable, never as zero.

## What is measured

| Signal | Detail |
|---|---|
| HTTP requests | count by status class, duration histogram per declared route (`http.server.request.duration`, seconds, fixed bounds 5 ms to 10 s), in-flight requests, 401/403/429 counts. Unknown paths are one `unmatched` label; routes are the **declared** templates, never raw URLs |
| Upstream calls | latency histogram and outcome per upstream: `ok`, `timeout`, `unavailable`, `tls`, `bad_gateway`, `response_too_large`, `aborted` |
| Rate limiting | provider and allowed/denied/backend-failure counters (absent when limiting is off) |
| Dispatch | publish/consume/retry/dead-letter counters and the broker health seen by the adapter (absent when dispatch is not installed) |
| Lifecycle | `starting`, `ready`, `draining`, `stopped`; shutdown start and in-flight count; a client that disconnects is recorded as 499, not as a success |

A request is recorded when its connection closes, so every exit path (including aborts) is counted exactly once.

## The diagnostics endpoint

`GET /_pso/telemetry` exists **only** when `PSO_DIAGNOSTICS_TOKEN` (32 or more characters) is set; otherwise the path does not exist (`404`). With a token it requires `Authorization: Bearer <token>` (constant-time comparison) and answers `401` otherwise. The token is a secret: set it as a variable or `"${env:NAME}"`; a value written in `pso.config.json` is refused at start-up, and a token shorter than 32 characters stops start-up. The document contains no credentials, payloads, raw paths or client addresses, and the diagnostics calls themselves are not counted.

## Distributed tracing

The orchestrator implements W3C Trace Context. A valid incoming `traceparent` is continued; an invalid or all-zero one starts a new trace. The trace is returned in the response `traceparent`, forwarded to upstream services with a **new child span id** (the caller's own span id is never forwarded), and written as `traceId` in the structured request log. Spring services receive the header; whether they propagate it further depends on their own instrumentation.

## OpenTelemetry export (opt-in)

Nothing leaves the process by default. Setting the standard `OTEL_EXPORTER_OTLP_ENDPOINT` enables a push of **metrics and spans** over OTLP/HTTP (`/v1/metrics`, `/v1/traces`) with the official `@opentelemetry/sdk-metrics`, `sdk-trace-base` and `exporter-*-otlp-*` packages (optional dependencies of `@pso/http`, loaded only when an endpoint is set; a missing package is a start-up error that names it). Spans carry the same trace and span ids that were put in the `traceparent` headers, so the exported tree matches what crossed the wire: server span, then one client span per upstream call.

| Variable | Meaning |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http(s)://collector:4318`; no credentials in the URL; in production a remote endpoint must be `https://` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default, per the specification) or `http/json`; gRPC is not supported |
| `OTEL_EXPORTER_OTLP_HEADERS` | `name=value,name2=value2` (for example an API key; never logged) |
| `OTEL_SERVICE_NAME` | resource `service.name` (default: the service name) |
| `PSO_OTEL_EXPORT_INTERVAL_MS` | export period, 500 to 600000 (default 10000) |
| `PSO_OTEL_TRACES=false` | export metrics only |

Metric names: `http.server.request.duration`, `http.server.active_requests`, `pso.upstream.request.duration`, `pso.upstream.requests`, `pso.auth.failures`, `pso.ratelimit.decisions` (only when rate limiting is configured), and `pso.dispatch.{published,publish_failures,consumed,handler_failures,retries,dead_lettered,duplicates}` (only when dispatch is installed): a subsystem that is not configured exports no data point, never a zero. Span buffering is bounded (1000 spans), shutdown flushes with a 5 s deadline, and export failures never affect requests. Sampling follows the incoming sampled flag; other sampling policies and OTLP logs are not implemented.

## Spring Boot services

Add `com.pso:pso-observability-starter`. It brings Micrometer Tracing with the OpenTelemetry bridge and the official OTLP exporters, and maps the same variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `PSO_OTEL_EXPORT_INTERVAL_MS`) onto Spring Boot's `management.otlp.*` properties at the lowest precedence. **Without an endpoint both exporters are switched off** (Boot would otherwise push to `localhost:4318`), while W3C `traceparent` propagation stays on. `PsoHttpClient` calls are observed (client span, `http.client.requests`, `traceparent` to the remote), inbound requests produce server spans and `http.server.requests`, and dispatch/outbox counters (`pso.dispatch.*`, `pso.outbox.*`, `pso.dispatch.broker.up`, `pso.ratelimit.decisions`) are Micrometer meters exported with the rest. The resource carries `service.name` from `pso.service.name`. Studio does not read Spring services' telemetry (only the orchestrator's diagnostics endpoint): use your collector.

## What Studio shows

Studio's **Observability** page has a *Runtime telemetry* panel. For each service it asks the diagnostics endpoint (Studio reads the same `PSO_DIAGNOSTICS_TOKEN` from its own environment; the token never goes to the browser) and shows one of six states:

| State | Meaning |
|---|---|
| Healthy | the service answered, readiness is UP and no degradation rule matched |
| Degraded | the service answered and at least one rule matched (the panel lists which) |
| Unavailable | the service did not answer on its port |
| Not configured | the service runs but its diagnostics endpoint is off |
| Not instrumented | the service has no PSO telemetry (Spring services) |
| Unknown | Studio has no token, or the tokens differ, or the answer was not understood |

Degradation rules: state other than `ready`, readiness not UP, 5xx at 5% or more of at least 20 requests, rate-limit backend failures, a dispatch broker reported down, or an upstream failing in half or more of at least 10 calls (client aborts do not count). Numbers (requests, 5xx, rate limited, average latency) appear only for services that answered; every other row says why there are none. The table also shows, per service that answered, the dispatch counters (published, consumed, retries, dead letters) and the broker health from the adapter's own probe, or "not installed"; the API additionally carries upstream and shutdown details.

## What you see (verified)

With `PSO_DIAGNOSTICS_TOKEN` set, the telemetry of a gateway that served a few requests includes Dispatch counters when Dispatch is enabled; the verified dispatch section from a real run is on [Walkthrough](/dispatch/walkthrough). The log side of the same requests is in [Logging](/devops/logging): one `request` line per request with the status, duration, correlation id and trace id.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/_pso/telemetry` is `404` | diagnostics are off by default: set `PSO_DIAGNOSTICS_TOKEN` (32 or more characters) |
| `401` from it | wrong or short token |
| nothing arrives at the collector | export is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; check the endpoint is safe and reachable |
| traces do not connect across services | send a W3C `traceparent`; the orchestrator continues and forwards it |

## Common mistakes

- Using the diagnostics token as a general API key.
- Alerting on raw counters without rates.
- Expecting metrics from a service that is not instrumented (Studio says "not instrumented").

## Next steps

- [Logging](/devops/logging)
- [Health checks and observability](/devops/health-and-observability)
