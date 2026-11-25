---
title: Logging in the orchestrator and in Spring services
description: Readable coloured output in the terminal, structured JSON in production, secrets removed, one correlation id across services, and how to diagnose HTTP and broker problems from the logs.
order: 11
status: stable
keywords: [logging, logs, PSO_LOG_LEVEL, PSO_LOG_FORMAT, PSO_LOG_COLOR, NO_COLOR, correlation id, json, structured, redaction, MDC, logback]
related: [devops/observability, devops/health-and-observability, orchestrator/dto-validation, reference/environment-variables, dispatch/security-and-observability]
---
## What you get

| | Node orchestrator | Spring Boot service |
|---|---|---|
| Terminal (a developer's machine) | `pretty`: time, level, `[component]`, message, `(correlation id)`, `key=value` context, coloured | Spring Boot's console pattern with `[service,correlationId,traceId]` added, coloured by Boot |
| Production / pipes / CI | `json`: one object per line, never any colour codes | structured JSON (ECS) from the `prod` and `staging` profiles |
| Level | `PSO_LOG_LEVEL` | `PSO_LOG_LEVEL` (root logger) |
| Colour | `PSO_LOG_COLOR`, `NO_COLOR`, `FORCE_COLOR` | `PSO_LOG_COLOR=detect|always|never` |
| Secrets | removed from messages and context | removed from every string in JSON output |
| Correlation | `x-correlation-id` accepted when well-formed, else generated | the same header, put in the logging context |

Both sides use the standard facilities of their ecosystem. There is no PSO logging server and no extra logging framework in your Spring service.

## Orchestrator

### See it work

Start the orchestrator and call it (output captured from a real run, `PSO_LOG_COLOR=never` so it can be pasted here):

```log evidence="expected"
2026-11-08 14:18:19.412 INFO  [startup] starting orchestrator  service=gw environment=development logLevel=info logFormat=pretty node=v24.18.0
2026-11-08 14:18:19.428 INFO  [security] security initialized (pem, ES256)
2026-11-08 14:18:19.434 INFO  [http] orchestrator listening  host=127.0.0.1 port=3000 routes=6 modules=2
2026-11-08 14:18:19.530 INFO  request (demo-corr-0001)  traceId=82b1e39923a376ea73ba19a092fca833 method=POST path=/orders status=201 ms=6.56
2026-11-08 14:18:19.536 INFO  request (demo-corr-0001)  traceId=d5bffcb133d75597de34f26b737428d9 method=POST path=/orders status=400 ms=1.17
```

Reading a line: `date time LEVEL [component] message (correlation-id)  key=value ...`.

On a terminal the level is coloured: TRACE grey, DEBUG cyan, INFO green, WARN yellow, ERROR red, FATAL white on red. The colours are standard ANSI palette entries, so a light or dark theme chooses the exact shade.

### Read a failure by its level

The documentation portal colours the level and marks WARN and ERROR lines with a visible edge. This is presentation only: the copied text contains no colour codes, and the level words remain readable without colour. The example below combines messages the runtime can emit; its values are illustrative, not one captured session.

```log evidence="illustrative" title="How a failure stands out in the portal"
2026-11-08 14:18:19.434 INFO  [http] orchestrator listening  host=127.0.0.1 port=3000
2026-11-08 14:18:19.530 WARN  [security] authentication failed  reason=missing_header route="GET /products"
--- separate startup attempt ---
2026-11-08 14:20:02.536 ERROR [dispatch] dispatch initialization failed  detail=broker unavailable
```

![A log example in the portal with INFO in green, a highlighted WARN line and a highlighted ERROR line](@/assets/screenshots/log-severity.png)

*The portal's log presentation after rendering the text above. The words and left-edge markers preserve the severity distinction when colour is unavailable.*

The WARN line tells you a request was rejected before a controller ran: compare the caller's token with the route policy. The ERROR line represents a **different startup attempt**: Dispatch failed to initialize, so that attempt did not start the listener. Check the configured provider and broker connection with `pso dispatch:doctor`. In a real run, use timestamps and correlation IDs to relate lines rather than assuming adjacent lines belong to one request.

### Configure it

| Variable | Values | Default |
|---|---|---|
| `PSO_LOG_LEVEL` | `trace` `debug` `info` `warn` `error` `fatal` `silent` | `info` |
| `PSO_LOG_FORMAT` | `pretty` `json` | `pretty` when stdout is a terminal, `json` otherwise |
| `PSO_LOG_COLOR` | `auto` `always` `never` | `auto` |

Prefer the environment variables. The orchestrator also reads `logging.level`, `logging.format` and `logging.color` from `pso.config.json` (and `PSO_CFG_logging__level`, ...), but only `logging.level` is in the configuration schema today: `pso config:validate` reports `logging.format` and `logging.color` as *unknown key* warnings (verified), although the runtime honours them. Use the variables to avoid the warning ([environment variables](/reference/environment-variables)). A wrong value stops the start with a message naming the variable; nothing silently falls back.

Colour rules, in order: `json` never has colour; `PSO_LOG_COLOR=never|always` is an explicit decision; then `NO_COLOR` (any non-empty value) turns it off; `FORCE_COLOR` forces it on (`0` or `false` off); otherwise colour is on only for a terminal that is not CI and not `TERM=dumb`.

```bash
PSO_LOG_LEVEL=debug pso dev                 # more detail while you investigate
NO_COLOR=1 pso dev                          # plain text
PSO_LOG_FORMAT=json PSO_LOG_LEVEL=warn node dist/main.js   # what a container should run
```

### JSON in production

```jsonl evidence="expected"
{"ts":"2026-11-08T14:18:19.536Z","level":"info","msg":"request","correlationId":"demo-corr-0001","traceId":"d5bffcb133d75597de34f26b737428d9","method":"POST","path":"/orders","status":400,"ms":1.17}
```

One object per line, `ts` in UTC, lower-case `level`, `msg`, then the context. Parse it with anything (`jq`, a log shipper). The keys `ts`, `level`, `msg` are stable.

### Secrets never reach the output

Before a line is written, the logger replaces: values under keys such as `authorization`, `cookie`, `password`, `secret`, `token`, `apiKey`, `credential`, `jwt`; JWTs and `Bearer`/`Basic` credentials anywhere in text; user and password inside URLs (`redis://user:pw@host` becomes `redis://[REDACTED]@host`); and `password=...`/`token=...` pairs. Errors keep their name, message and `code`; a stack trace (at most 8 frames) appears only at `debug` or `trace`.

This is a safety net, not permission to log secrets. Do not put request bodies or tokens in log context on purpose.

### What is logged at INFO, and what is not

INFO: start-up (environment, log settings), security initialised, configured upstreams, listener, one `request` line per request, shutdown. WARN: refused or degraded things that need attention (a token not forwarded, an upstream that is slow or unreachable). ERROR: failures (start-up refused, broker failure). Per-route registration and internal steps are `debug`. To silence the per-request line in a busy production service use `PSO_LOG_LEVEL=warn` and rely on [metrics](/devops/observability) for traffic.

## Unexpected errors

An error nobody handled (a bug, an unavailable dependency) always produces the same answer for the client, in every environment: `500` with the problem `PSO_INTERNAL_ERROR` and the correlation id, never the exception.

What the **log** records depends on one setting, because a message can quote request data:

| | Always | With error details |
|---|---|---|
| Error type, stable `code` | yes | yes |
| `component` (controller and action), `route`, `correlationId`, `traceId` | yes | yes |
| `origin`: the first line of your own code on the stack (`file:line:column`) | yes | yes |
| `message`, `stack`, `causes` (after redaction of tokens, JWTs, URL credentials, `key=value` secrets) | no | yes |

Error details are off by default, **on in a `pso dev` session**, and never honoured in production:

| Runtime | Setting | Variable |
|---|---|---|
| Orchestrator | `logging.errorDetails` | `PSO_LOG_ERROR_DETAILS=true` |
| Spring Boot | `pso.observability.error-details` | `PSO_LOG_ERROR_DETAILS=true` (the generated `application.yml` reads it) |

```text evidence="expected"
ERROR [SummaryController.boom] unhandled error in a request (corr-boom-000001)  route="GET /summary/boom" error=Error origin="SummaryController.boom (dist/modules/summary/summary.controller.js:41:11)" message="lookup failed: password=[REDACTED]"
    at SummaryController.boom (dist/modules/summary/summary.controller.js:41:11)
```

Without error details the same line stops after `origin`: enough to find the failing line from a production log. In production the setting is ignored and the log says so once at start-up (`logging.errorDetails is ignored in production`). An upstream call that an action did not handle is logged as `an upstream call failed and the action did not handle it` with `service`, `reason` and `upstreamStatus`, never with the service's response body.

## Spring Boot services

Generated services use Spring Boot's logging (Logback) and its structured-logging support. Nothing is replaced: your own `logback-spring.xml`, if you add one, wins.

### Local profile

```log evidence="expected"
2026-11-08T11:21:55.402-03:00  INFO [orders,,] 40436 --- [orders] [           main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port 18123 (http) with context path '/'
2026-11-08T11:21:55.413-03:00  INFO [orders,,] 40436 --- [orders] [           main] com.pso.orders.Application               : Started Application in 2.578 seconds (process running for 2.889)
```

`[orders,,]` is `[service, correlationId, traceId]`. The two ids are empty outside a request (start-up) and filled for lines logged while a request is being handled. The local profile sets `com.pso` to `DEBUG`.

### Production profile: structured JSON

`application-prod.yml` and `application-staging.yml` write Spring Boot's ECS JSON format, with secrets removed from every string field:

```jsonl evidence="expected"
{"@timestamp":"2026-11-08T14:21:57.890051500Z","log":{"level":"INFO","logger":"com.pso.orders.Application"},"process":{"pid":39476,"thread":{"name":"main"}},"service":{"name":"orders","version":"0.1.0","node":{}},"message":"The following 1 profile is active: \"prod\"","ecs":{"version":"8.11"}}
```

Inside a request the correlation id (and trace id, when OpenTelemetry tracing is on) are added to the JSON as context fields. To use another Boot format: `LOGGING_STRUCTURED_FORMAT_CONSOLE=logstash` (or `gelf`). To get readable text in production for a short investigation, start with `--logging.structured.format.console=` empty on that instance.

### Configure it

```bash
PSO_LOG_LEVEL=DEBUG ./mvnw spring-boot:run -Dspring-boot.run.profiles=local   # root level (TRACE DEBUG INFO WARN ERROR OFF)
PSO_LOG_COLOR=never ...                                                       # detect (default) | always | never
LOGGING_LEVEL_COM_PSO=TRACE ...                                               # one package, standard Spring relaxed binding
```

The redaction is a standard Boot extension point (`logging.structured.json.customizer`), configured in the profile files. The pattern layout used locally is not rewritten: it is for developers, and the framework itself does not log tokens or credentials.

## Following one request across services

The orchestrator reads `x-correlation-id` (8 to 64 characters of `A-Z a-z 0-9 . _ -`), replaces anything malformed with a new UUID, forwards it to upstreams, and returns it in the response and in every error body. Spring services do the same. So one id finds everything:

```bash
curl -i http://127.0.0.1:3000/catalog/products -H "x-correlation-id: trace-me-0001" -H "authorization: Bearer $TOKEN"
# orchestrator terminal:  grep trace-me-0001
# service terminal / JSON: grep trace-me-0001
```

## Diagnose with the logs

| Symptom | Look for | Usual cause and fix |
|---|---|---|
| `400` from a route that validates | the response `errors` list; the `request` line shows `status=400` | field rules; the log never contains the values, so reproduce with the client |
| `401` | `request ... status=401` | missing/invalid token; check `security initialized` at start-up and the issuer/audience variables |
| `503` from the orchestrator | `WARN` lines about the upstream; `status=503` | the service is not running or not reachable at the configured address |
| orchestrator does not start | one `ERROR startup failed ... diagnostics=[...]` line | the message names the route or the setting; nothing was started |
| broker problems | `ERROR [dispatch] dispatch initialization failed code=... detail=...` | broker URL, credentials (they appear redacted), network; check with `pso dispatch:doctor` |
| the same id appears in both runtimes but a field is missing | compare the JSON keys | Spring puts ids in the logging context; the orchestrator prints them as `correlationId` |

## Production checklist

- Run the orchestrator with `PSO_LOG_FORMAT=json` and ship stdout; do not rely on files inside the container.
- Keep `PSO_LOG_LEVEL=info` (or `warn` when traffic is high and you have metrics). Use `debug` for a short time and one instance.
- Never set colour in production. `json` already forces it off; for Spring the structured format has none.
- Treat logs as personal data: ids and paths can identify people. Apply your retention policy.
- Alert on `ERROR` and `FATAL`, and on the absence of the `orchestrator listening` line after a deploy.

## Next steps

- [Metrics, traces and OpenTelemetry](/devops/observability)
- [Validate request bodies](/orchestrator/dto-validation)
- [Environment variables](/reference/environment-variables)

## Colour in `pso dev`

`pso dev` pipes each service's output so it can also be saved to `.pso/logs/<service>.log`. Piped output is not a terminal, so services would normally print plain text. `pso dev` therefore handles colour itself, with no configuration:

- When `pso dev` runs in a terminal, Spring services are started with `PSO_LOG_COLOR=always` (levels are coloured by Spring Boot).
- Structured orchestrator lines (JSON) are re-formatted for the terminal: timestamp, coloured level, component, message and context.
- Each `[service]` prefix has its own colour, so services are easy to tell apart.
- The `.pso/logs` files never contain escape codes, and the orchestrator's JSON stays JSON, so Studio can still parse it.

Turn it off with `NO_COLOR=1` or `PSO_LOG_COLOR=never`. Force it when output is redirected with `FORCE_COLOR=1` or `PSO_LOG_COLOR=always`.
