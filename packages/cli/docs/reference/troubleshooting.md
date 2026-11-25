---
title: Troubleshooting by symptom
description: Diagnose routing, modules, DTO validation, JWT, connectivity, databases, migrations, brokers, telemetry, installation and updates - each with symptoms, causes, diagnostic commands, log lines, the fix, how to verify and how to prevent it.
order: 6
keywords: [troubleshooting, diagnostics, 401, 403, 404, 413, 431, 502, 503, 504, broker, outbox, flyway, hikari, telemetry, installer]
related: [reference/diagnostics, getting-started/troubleshooting, tutorials/local-debugging, devops/logging]
---
Start at the workspace root with `pso validate`. Then use `pso routes:inspect <route id or path>` for a route, `pso services:health` for running processes, `pso security:check` for policy, `pso config:validate` for configuration and `pso dispatch:validate` for event declarations. They answer different questions; a clean static check cannot prove that an upstream or a broker is reachable.

This page is organised by symptom. When you already have an error code or a log line, go straight to the page that owns it: [Validation errors, one by one](/reference/diagnostics-catalog) for what `pso validate` prints, [Why the orchestrator refuses to start](/reference/startup-failures) for start-up refusals, and [Checking Dispatch](/dispatch/diagnostics) for broker checks and contract errors.

Every entry has the same shape: **symptom**, **likely causes**, **diagnose**, **resolve**, **verify**, **prevent**. Log lines are from the orchestrator's pretty format (JSON in production has the same fields); output marked *verified* was captured from a real run.

## How to use this page: common mistakes

- Starting at the symptom without running `pso validate` first.
- Fixing the log message instead of the cause (for example raising a timeout for a service that is down).
- Posting logs or configuration in a ticket without checking for secrets.

## Routing and modules

### A decorated action answers 404

- **Symptom.** `404 PSO_HTTP_NOT_FOUND` for a method you wrote.
- **Causes.** The route is not in `ROUTES.pso.ts` (decorators never expose); the method or path differs; the controller is not in `MODULE.pso.ts`.
- **Diagnose.** `pso routes:list` (is it there?); `pso routes:inspect product.findAll` prints the chain (it prints the target, access, where the route is defined, its contract and its handler).
- **Resolve.** `pso make:route <module> <action> --method M --path P --service <orchestrator>`.
- **Verify.** `pso routes:list` shows it; the request now answers `401`/`403`/`200` instead of `404`.
- **Prevent.** Always add routes with the generator; review `ROUTES.pso.ts` in code review.

### The orchestrator refuses to start with PSO_MODULE_* or PSO_ROUTE_*

- **Symptom.** `ERROR startup failed ... diagnostics=["PSO_MODULE_006"]`, exit code 1, nothing listening.
- **Diagnose.** `pso validate` prints the full message. Expected output for an unresolved provider:

```text evidence="expected"
ERROR   PSO_MODULE_006 gw/src/modules/orders/MODULE.pso.ts: Dependency cannot be resolved.
Module: orders
Controller: OrdersController
Expected: PricingService listed in providers or exported by an imported module
Found: not available in this module
Module activation denied.
```

- **Resolve.** Add the provider to `providers`, or import the module that exports it. The other module and route codes (`PSO_MODULE_001`/`002`/`003`, `PSO_ROUTE_001`/`002`/`004`/`005`/`008`/`010`) are reproduced one by one, with their exact messages, in [Validation errors, one by one](/reference/diagnostics-catalog); `PSO_MODULE_007` is a provider cycle and `PSO_ROUTE_007` a route with no security policy, a route that is both public and restricted, or scopes without a guard.
- **Verify.** `pso validate` prints `OK`.
- **Prevent.** `pso validate` in CI; it needs no dependencies.

## DTO validation

### 400 PSO_VALIDATION_FAILED with a field list

- **Symptom.** `400 application/problem+json`, `errors: [{field, message}]`.
- **Causes.** The body breaks a rule (for example `"customer": "must have at least 3 characters"`, `"admin": "is not allowed"`).
- **Diagnose.** Read `errors`; the `request` log line shows `status=400` and the correlation id. Values are never logged, so reproduce with the client.
- **Resolve.** Fix the request, or change the DTO if the rule is wrong.
- **Prevent.** Share the DTO's rules with client developers; remember unknown properties are rejected by default ([DTO validation](/orchestrator/dto-validation)).

### Start-up: invalid DTO or unregistered validator

- **Symptom.** `startup failed ... diagnostics=["PSO_DTO_VALIDATOR_UNREGISTERED"]`, or `PSO_DTO_INVALID` (a DTO class without `@Dto()` or a field without a type decorator).
- **Resolve.** Add `@Dto()` / the type decorator; list the validator class in the module `providers`.
- **Verify.** The orchestrator starts and `orchestrator listening` appears.

## Authentication and authorization

### 401 on every guarded request

- **Causes.** No key source configured; issuer or audience differ; algorithm not allowed; token expired.
- **Diagnose.** The log says why: `WARN [security] authentication failed reason=missing_header route="GET /customers"`. `pso security:check` reports a missing configuration before you start (`SEC005`). If the orchestrator itself exits at start-up (`PSO_SEC_MISSING`, `PSO_SEC_ALGORITHM`, `PSO_SEC_PEM_PATH`, `PSO_SEC_JWKS_INSECURE`), the refusal and its fix are in [Why the orchestrator refuses to start](/reference/startup-failures).
- **Resolve.** Set `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` and a key source; compare the token's `iss`, `aud`, `alg`, `exp`. Never disable verification to clear a `401`.
- **Verify.** The request returns `200` (or the service's answer).
- **Prevent.** Keep a documented development token helper; run `security:check` in CI.

### 403 with a valid token

- **Diagnose.** Log line: `WARN [security] authorization denied (doc-corr-0003)  missing=scope:customers:read route="GET /customers"`.
- **Resolve.** Grant the scope at the identity provider or correct the route's `scopes`; never make a protected route public.

## Connectivity

### 502, 503 or 504 from the orchestrator

- **Meaning.** `503 PSO_UPSTREAM_UNAVAILABLE` could not connect (when the service is down); `504` timed out; `502` unknown service or invalid answer.
- **Diagnose.** `pso services:health` (prints `DOWN catalog http://127.0.0.1:8081/actuator/health` and exits 1); the service's log with the same correlation id; the route's `metadata.service` against `pso.workspace.json`; in production `PSO_UPSTREAM_<NAME>`.
- **Resolve.** Start or repair the service, fix its port or health path, or raise a justified timeout (`http.limits.upstreamTimeoutMs`).
- **Verify.** `pso services:health` exits 0.
- **Prevent.** Probe readiness in your platform; alert on `503` rates.

### TLS errors to an upstream (`502 PSO_UPSTREAM_TLS`)

- **Causes.** Certificate expired, signed by an unknown CA, or naming another host.
- **Resolve.** Configure the CA file and server name ([service identity](/security/service-identity)); rotate the certificate files (the orchestrator picks up changes without restart). Verification cannot be disabled.

### 500 PSO_INTERNAL_ERROR from an action

- **Symptom.** `500 application/problem+json` with `"code":"PSO_INTERNAL_ERROR"` and a generic detail.
- **Causes.** Anything your action threw that is not an `HttpError`.
- **Diagnose.** The orchestrator logs `request (<correlation id>) ... status=500` and nothing else: no message and no stack for an unexpected error (a known limitation of the current release). Reproduce with the same input; wrap the suspect call in `try/catch` and log with `log("error", "...", { correlationId })`, or add a [filter](/orchestrator/middleware-and-filters) that logs and returns `false`.
- **Resolve and verify.** Fix the bug; the same request no longer answers `500`.
- **Prevent.** Throw `HttpError` for expected failures; keep actions small and tested.

## Databases and migrations

### Hikari: Connection is not available, request timed out

- **Symptom.** `HikariPool-1 - Connection is not available, request timed out after 5000ms`.
- **Causes.** Pool exhausted by slow queries or a transaction left open; pool too small; database unreachable.
- **Diagnose.** Service log; the database's active sessions; `DB_POOL_SIZE`.
- **Resolve.** Fix the slow query or the open transaction; size the pool from the database limit divided by instances.
- **Prevent.** Statement timeouts at the database role; metrics on pool wait time ([PostgreSQL CRUD](/spring/postgresql-crud)).

### Flyway: checksum mismatch or missing table

- **Symptoms.** `FlywayValidateException: Validate failed ... checksum mismatch`; `Schema-validation: missing table [products]`.
- **Causes.** An applied migration was edited; the migration did not run (wrong `DB_URL`, `flyway.enabled`).
- **Resolve.** Restore the edited migration and add a new version; fix the URL.
- **Verify.** Start-up logs `Successfully applied N migrations` (see the first-start log in [Build a CRUD API](/tutorials/crud-api)); `SELECT version, success FROM flyway_schema_history`.
- **Prevent.** Never edit applied migrations; `ddl-auto: validate`.

### Maven cannot resolve `com.pso` artifacts

- **Resolve.** `pso java:install` for local development; for containers or CI the artifacts must be in a repository the build can reach ([Maven dependencies](/microservices/maven-dependencies)).

## Brokers and outbox

### Dispatch fails at start-up

- **Diagnose.** `pso dispatch:inspect`, `pso dispatch:validate`, then `pso dispatch:doctor`, which really connects to the broker (reports up, down or not configured).
- **Log.** `ERROR [dispatch] dispatch initialization failed code=... detail=...` (credentials appear redacted).
- **Resolve.** Install the matching adapter, enable it explicitly and set a reachable broker URL; RabbitMQ refuses to publish to a channel with no bound queue until a consumer exists.

### Repeated deliveries or dead letters

- **Causes.** At-least-once delivery after a crash; a handler that keeps failing (retries, then the `.dlq` channel).
- **Diagnose.** The event id and group in the dead-letter headers (`x-pso-reason`, `x-pso-attempts`); broker tooling.
- **Resolve.** Make the handler idempotent; fix the schema or handler, then republish deliberately (no automatic replay).

### An outbox row stays pending or failed

- **Diagnose.** The `pso_outbox` row's attempts and last error class; broker reachability.
- **Resolve.** Restore the broker (rows are retried with backoff); inspect rows past `max-attempts` (kept, never deleted automatically).

## Telemetry

### `/_pso/telemetry` answers 404 or 401

- **Causes.** Diagnostics are off by default; the token is shorter than 32 characters or wrong.
- **Resolve.** Set `PSO_DIAGNOSTICS_TOKEN` (32 or more characters) and send it as a bearer token ([observability](/devops/observability)).

### No traces or metrics in the collector

- **Causes.** Export is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the endpoint is unsafe or unreachable.
- **Diagnose.** The start-up log; Studio's observability view says "not configured" or "not instrumented" rather than showing zeros.

## Installation and updates

### `pso: command not found` or the command runs old code

- **Resolve.** Add the npm global bin directory to `PATH`; rebuild the checkout (`npm run build`) so the linked command sees changes ([installation](/getting-started/installation)).

### `INSTALL_EXISTS`, `PSOPKG_SIGNATURE`, `CATALOG_*`

- **Example.** Installing the same version twice (asserted by the installer lifecycle test): `error: INSTALL_EXISTS: version 0.1.0 is already installed`.
- **`PSOPKG_SIGNATURE`.** The package is not signed by a key you trust, or was modified: nothing was written. Check the `--trust` key and the source of the file.
- **`CATALOG_SIGNATURE`/`CATALOG_EXPIRED`/`CATALOG_REPLAY`.** The catalog is forged, expired or older than one already seen; fetch a fresh one.
- **`PACKAGE_HASH`.** The package does not match its catalog entry; the install was aborted and the active version is unchanged.

### The installed `pso` cannot start after damage

- **Resolve.** Run repair from a known-good CLI copy against the same `--root` ([distribution](/devops/distribution-and-installation)).

### The installer's uninstaller does not run

- **Known limitation.** On a machine with an application-control policy the **unsigned** `unins000.exe` was blocked. Sign the installer with your certificate, or remove with `pso uninstall --complete --yes --root <dir>`.

## Tooling

| Symptom | Fix |
|---|---|
| `/customers` becomes `C:/Program Files/Git/customers` | Git Bash rewrote it; use PowerShell or `MSYS_NO_PATHCONV=1` |
| port N already in use | find the process (`netstat -ano`), do not stop what you do not recognise, or change the port |
| `docker:build` says the daemon is not running | start Docker; nothing was built |
| Studio cannot connect | start `pso studio` in the workspace and use its fresh one-time URL; remote access is unsupported |

The [diagnostics reference](/reference/diagnostics) is generated from framework codes: use the exact code your installed CLI emits. For a guided investigation, follow [Diagnose a local workspace](/tutorials/local-debugging).
