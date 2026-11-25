---
title: Health checks and observability
description: Health endpoints, logs and correlation ids in one place, with what each runtime exposes, what a probe returns, and where the deeper guides are.
order: 6
status: partial
keywords: [health, readiness, liveness, logs, correlation id, observability, opentelemetry, probes]
related: [orchestrator/request-lifecycle, devops/development-environment, devops/logging, devops/observability]
---
## Health

| Service | Endpoints |
|---|---|
| Orchestrator | `GET /health/live`, `GET /health/ready` (framework module; public; exempt from rate limiting) |
| Spring | `GET /actuator/health` with liveness/readiness probes enabled; details never shown |

`pso dev`, `pso services:health`, Docker `HEALTHCHECK` and the deploy `--health-url` check all use them. Verified answer of the orchestrator's readiness endpoint:

```text evidence="expected"
GET /health/ready  ->  200  {"status":"UP","upstreams":1}
```

That body is unchanged for an orchestrator without dependencies. Readiness answers **503** with `{"status":"DOWN", ...}` and `Retry-After: 5` in three cases: start-up has not finished, shutdown has begun, or a **required dependency** of this instance is unavailable. Dependencies are reported under `checks` (the key appears only when there is something to report):

```text evidence="expected"
GET /health/ready  ->  503  {"status":"DOWN","upstreams":1,"checks":{"dispatch":{"status":"DOWN","required":true,"detail":"probe timed out after 2000 ms"}},"state":"ready"}
```

| Dependency (`checks` key) | Present when | Required by default |
|---|---|---|
| `dispatch` | Dispatch is enabled | yes |
| `channels` | Channels use the Redis bus | yes |
| `rateLimit` | rate limiting uses Redis | only with the failure policy `closed` (with `open` requests are still served) |

Probes run in the background (every 5 seconds, each bounded to 2 seconds; `http.readiness.intervalMs` and `http.readiness.timeoutMs`), so a request to `/health/ready` only reads the last result. A dependency is reported `DOWN` after two consecutive failed probes and `UP` again on the first success. To keep an instance in rotation while a dependency is down, list it in `http.readiness.optional` (`PSO_READINESS_OPTIONAL=dispatch,channels`): it is still reported, with `"required":false`. Upstream services are counted, never probed: one unavailable service must not take every gateway instance out of rotation. Liveness (`/health/live`) never looks at dependencies. Details never contain addresses or credentials.

This is what `pso services:health` prints when nothing is running (exit code 1):

```text evidence="expected"
DOWN  catalog            http://127.0.0.1:8081/actuator/health
DOWN  gateway            http://127.0.0.1:3000/health/ready
```

| Probe | Use it for | Do not use it for |
|---|---|---|
| liveness (`/health/live`) | "restart me if I am stuck" | checking dependencies: a down upstream must not restart the gateway |
| readiness (`/health/ready`) | "send me traffic" | slow checks: it is called often |

## Logs

The orchestrator logs one line per request (timestamp, level, correlation id, trace id, method, path, status, duration) plus start-up and security events, as readable coloured text on a terminal and as JSON elsewhere; Spring services use Spring Boot's console pattern locally and structured JSON in `prod`/`staging`. Tokens, keys and secrets are redacted. See the full guide: [Logging](/devops/logging).

## Correlation ids

A client-supplied `x-correlation-id` is **accepted when it is well-formed** (8 to 64 characters of `A-Z a-z 0-9 . _ -`) and replaced by a generated UUID when it is not. The orchestrator returns it in the response (header and error body) and sends it to the upstream service, so one request can be followed across logs. Spring services apply the same rule and put it in the logging context.

## Metrics and traces

The orchestrator has request and upstream metrics, W3C trace propagation and an opt-in OpenTelemetry export (OTLP over protobuf by default, or JSON) with the official SDK; Spring services get the same through `pso-observability-starter`, which is off unless an OTLP endpoint is configured. Studio shows what was measured and says "not instrumented" or "unavailable" instead of showing zeros. See [Runtime telemetry](/devops/observability). Dispatch keeps in-process counters and adapter health ([Dispatch observability](/dispatch/security-and-observability)).

## Not implemented

OTLP logs export and sampling policies beyond the sampling probability setting; consumer lag and dead-letter depth are not exported. `pso dispatch:health` is not implemented (exit code 2); use `pso dispatch:doctor`.

## A minimal production setup

1. Probes: liveness and readiness on the paths above.
2. Logs: `PSO_LOG_FORMAT=json` for the orchestrator, the `prod` profile for Spring, shipped from stdout.
3. Metrics and traces: set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector.
4. Alerts: `ERROR`/`FATAL` logs, readiness failing, dead-letter channels non-empty.

## Common mistakes

- Pointing a liveness probe at a path that checks the database.
- Alerting on `4xx`: they are mostly client mistakes; alert on `5xx` and on latency.
- Dropping the correlation id in your own HTTP clients.

## Next steps

- [Logging](/devops/logging)
- [Runtime telemetry](/devops/observability)
- [Studio](/devops/studio)
