---
title: Minimal main.ts
description: The whole entry point, what bootstrap() does step by step, its options, what it logs on success and on failure, and which environment variables it reads.
order: 2
keywords: [bootstrap, main.ts, startup, environment, StartupError, dryRun]
related: [orchestrator/architecture, decisions/why-minimal-bootstrap, devops/logging, concepts/runtime-lifecycle]
---
```typescript title="src/main.ts"
import "reflect-metadata";
import { bootstrap } from "@pso/http";

bootstrap({ appDir: __dirname });
```

That is the essential entry point (the generated file also wires a workspace file path and shutdown handling, see [First orchestrator](/getting-started/first-orchestrator)).

## What `bootstrap()` does

The steps, in the order the framework performs and logs them (security and telemetry initialisation are reported by their own log lines before the listener line):

1. Reads the effective configuration (variables, `PSO_CFG_*`, `pso.config*.json`), including logging and HTTP limits. An invalid value stops start-up.
2. Loads the named guards, middleware, filters and interceptors from the compiled app directory (`.app/guards/`, `.app/middlewares/`, `.app/filters/`, `.app/interceptors/`), including module-local ones (`modules/<module>/guards/`).
3. Loads every `modules/<module>/MODULE.pso.js` and its `routes/ROUTES.pso.js`. Controller files (`modules/<module>/controllers/`) are reached only through a module's `controllers`; an undeclared controller is never loaded. A 0.1 project keeps `routes/<module>/` ([compatibility](/architecture/structure-migration)).
4. Builds the neutral model and runs the **same validator** as `pso validate`. Any error aborts start-up with a `StartupError` and nothing listens.
5. Initialises security (JWT keys, JWKS); a configuration problem stops start-up.
6. Constructs providers and controllers through the dependency container, and registers the business validators of DTOs.
7. Registers only the validated routes, plus the framework `health` module.
8. Starts rate limiting, telemetry and, if enabled, Dispatch; then listens on `HOST:PORT` with request timeouts and a connection limit.

## Options

| Option | Meaning |
|---|---|
| `appDir` | directory of the **compiled** application (contains `.app/` and `modules/`; a 0.1 build contains `routes/`, `guards/`, `middlewares/`, `filters/`); required |
| `projectDir` | the project directory where `pso.config.json` lives; defaults to the parent of `appDir` |
| `workspaceFile` | `pso.workspace.json`, the upstream registry in development |
| `port`, `host` | listen address (`3000`, `127.0.0.1` by default; the environment `PORT`/`HOST` is applied by the generated `main.ts`) |
| `dryRun` | validate and return without listening (used by tests) |

## What success looks like

Verified output of a real run (pretty format on a terminal; JSON when piped):

```text evidence="verified"
2026-11-08 14:54:30.517 INFO  [startup] starting orchestrator  service=gateway environment=development logLevel=info logFormat=pretty node=v24.18.0
2026-11-08 14:54:30.519 INFO  upstream configured  service=catalog tls=false mutualTls=false forward=inherit audienceBound=false
2026-11-08 14:54:30.531 INFO  [security] security initialized (pem, ES256)
2026-11-08 14:54:30.537 INFO  [http] orchestrator listening  host=127.0.0.1 port=39477 routes=4 modules=2
```

`routes` counts your declared routes plus the two framework health routes (here 2 + 2); `modules` counts your modules, not the framework `health` module.

## What failure looks like

A validator that is declared on a DTO but not listed in the module providers (Expected output, JSON format):

```json evidence="expected"
{"ts":"2026-11-08T14:15:46.651Z","level":"error","msg":"startup failed","error":"POST /orders: validator NameRules must be listed in the providers of module \"orders\"\nnothing was started","diagnostics":["PSO_DTO_VALIDATOR_UNREGISTERED"]}
```

The process exits with code 1 and nothing listens. Typical causes and the codes you will see:

| Code | Cause |
|---|---|
| `PSO_MODULE_*` | module declaration, route registry, controller registration, dependency or import problems |
| `PSO_ROUTE_*` | route and controller disagree, duplicates, missing policy, unknown guard/middleware/filter (`PSO_ROUTE_008`) |
| `PSO_SEC_*` | security configuration (missing JWT settings, undeclared custom guard) |
| `PSO_DTO_*` | invalid DTO declaration or unregistered business validator |

`pso validate` prints the same diagnostics in full, without starting anything, so run it first.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3000`, `127.0.0.1` | listen address |
| `PSO_WORKSPACE` | workspace file next to the project | upstream registry in development |
| `PSO_UPSTREAM_<NAME>` | none | `host:port` of an upstream in production |
| `MAX_BODY_BYTES` | 1048576 | JSON body limit (also the limit for the ordinary fields of a multipart form) |
| `MAX_UPLOAD_BYTES` | 10485760 | whole multipart request ([file uploads](/orchestrator/file-uploads)) |
| `UPSTREAM_TIMEOUT_MS` | 5000 | upstream timeout |
| `RATE_LIMIT_PER_MINUTE` | 600 | per-client limit |
| `MAX_CONNECTIONS` | 1000 | connection limit |
| `PSO_LOG_LEVEL`, `PSO_LOG_FORMAT`, `PSO_LOG_COLOR` | `info`, terminal-dependent, `auto` | logging ([guide](/devops/logging)) |
| `PSO_JWT_*` | none | JWT guard settings, see [Authentication](/security/authentication) |

The complete list, with the canonical configuration key behind each, is the [variables reference](/reference/environment-variables).

## Variations

- Run the compiled file directly in a container: `node dist/main.js` (no `tsc` at run time).
- Validate in CI without starting: `pso validate`.
- Different port per environment: set `PORT`; keep `pso.workspace.json` in step.

## Common mistakes

- Passing the `src` directory as `appDir`: it must be the compiled output (`__dirname` in the compiled `main.js`).
- Adding routes in `main.ts`: there is no such API; exposure is `ROUTES.pso.ts` ([why](/decisions/why-minimal-bootstrap)).

## Next steps

- [Module](/orchestrator/module)
- [Request and response lifecycle](/orchestrator/request-lifecycle)
