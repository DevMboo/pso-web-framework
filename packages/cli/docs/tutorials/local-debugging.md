---
title: Diagnose a local workspace
description: Use static checks, route inspection, health, logs and Studio in a reliable order.
order: 7
keywords: [tutorial, debugging, validate, diagnostics, studio, health]
related: [getting-started/troubleshooting, devops/studio, reference/troubleshooting]
---

When an endpoint fails, first find out whether the declaration is valid, then whether the process is running, and finally whether the request satisfies its policy. This order avoids treating a missing route as a network or JWT problem.

The examples use the workspace of [Build your first application](/tutorials/first-application): the `catalog` service and the
`gateway` orchestrator with its `products` module, started with `pso infra:init --identity keycloak --runtime docker` and
`pso docker:up --vendor`.

```bash
pso validate
pso config:validate
pso security:check
pso routes:list
pso routes:inspect products
pso services:health
pso docker:ps
```

`pso validate` reads workspace structure, modules, route declarations and dispatch contracts statically. Fix its errors before starting the server; a broken route does not become partially active. `routes:list` and `routes:inspect` answer whether the desired path is declared and which service receives it. `services:health` checks a live process rather than assuming that registration means readiness.

Run `pso studio` in another terminal. Studio links routes, diagnostics, configuration and log lines to the corresponding documentation, and its API client sends the module's reference requests with a development user. It binds to loopback and gives you a one-time URL; keep that URL private. Studio masks secrets and does not expose remote access or process controls.

Where the logs are depends on how the workspace runs:

| Runtime | Status | Logs |
|---|---|---|
| Docker (`pso docker:up`, the default of `pso infra:init --runtime docker`) | `pso docker:ps` | `pso docker:logs gateway`, `pso docker:logs catalog` (tokens and secrets masked) |
| processes (`pso dev`, a workspace without `pso.infra.json`) | `pso services:health` | `.pso/logs/<service>.log` |

## Interpret the HTTP result

| Result | First check |
|---|---|
| `401` | Bearer token, issuer, audience and key source in both gateway and service |
| `403` | Scope or role required by the route versus the verified token |
| `404` | Whose answer is it? An `instance` that starts with the service prefix (`/catalog/...`) means the service answered: check the id or path. Otherwise the gateway has no such route: check `ROUTES.pso.ts` and the controller action |
| `413` | Body size limit |
| `431` | Header size limit |
| `502`, `503`, `504` | Upstream health, connection and timeout logs |

For a specific diagnostic code, open [Diagnostics](/reference/diagnostics). For a symptom-to-fix procedure, use [Troubleshooting](/reference/troubleshooting). Dispatch configuration can be inspected without a broker using `pso dispatch:inspect`; `pso dispatch:doctor` deliberately connects to it.

## A worked session

Suppose `GET /products` answers `503`. Following the order above:

1. `pso validate` prints `OK`: the declarations are fine.
2. `pso routes:inspect products` shows `GET /products  ->  catalog:8081` with `guard jwt, scopes products:read` and the Spring handler `application/rest/ProductController.java`: the route points at the service you expect.
3. `pso services:health` (Expected output when nothing runs):

```text evidence="expected"
DOWN  catalog            http://127.0.0.1:8081/actuator/health
DOWN  gateway            http://127.0.0.1:3000/health/ready
```

   exit code 1: the service is down. That explains the `503`; it is not a routing or token problem.
4. Start the service (`pso docker:up`) and read its log (`pso docker:logs catalog`); then repeat the request.

For a `401` or `403`, step 3 is replaced by the orchestrator's log: it states the reason (`reason=missing_header`, `missing=scope:products:read`) with the correlation id that is also in the response body, so you can match a client's report to the exact line ([logging](/devops/logging)).

## The same request, three layers

| Layer | Where to look |
|---|---|
| declaration | `pso validate`, `pso routes:list` |
| process | `pso docker:ps`, `pso docker:logs <name>`; or `pso services:health` and `.pso/logs/<service>.log` for processes |
| policy | the `WARN [security]` lines; `pso security:policy` |

## Common mistakes

- Debugging the network when `pso validate` already fails.
- Reading a `404` as an outage: it usually means the route is not declared.
- Pasting logs with tokens into a ticket: the orchestrator redacts them, but your own tools may not.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| a request disappears | the gateway refused it before the service | the gateway log line: status, `correlationId`, `path` | read the status; `401` and `403` never reach the service |
| the service shows no request line | the service does not log every request | the gateway line instead | search by `x-correlation-id` |
| the orchestrator exits at start | a refused configuration | the last `error` line | [Why the orchestrator refuses to start](/reference/startup-failures) |
| logs are plain in a terminal | `NO_COLOR` or `CI` is set, or output is redirected | the environment | unset them, or `PSO_LOG_COLOR=always` |
