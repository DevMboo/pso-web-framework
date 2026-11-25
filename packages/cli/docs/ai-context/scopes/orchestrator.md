---
title: Orchestrator conventions
description: Node.js + TypeScript orchestrator layout, API, dependency injection and guards.
order: 3
scope: orchestrator
base: true
keywords: [ai, orchestrator, node]
---
## Layout (src/)

| Kind | Directory | File |
|---|---|---|
| module | `src/modules/<module>/` | `MODULE.pso.ts` |
| route-registry | `src/modules/<module>/routes/` | `ROUTES.pso.ts` |
| controller | `src/modules/<module>/controllers/` | `*.controller.ts` |
| service | `src/modules/<module>/services/`, `src/shared/`, `src/shared/.../` | `*.service.ts` |
| provider | `src/modules/<module>/providers/` | `*.provider.ts` |
| dto | `src/modules/<module>/dto/`, `src/modules/<module>/dto/request/`, `src/modules/<module>/dto/response/`, `src/shared/`, `src/shared/.../` | `*.dto.ts` |
| mapper | `src/modules/<module>/mappers/` | `*.mapper.ts` |
| type-contract | `src/modules/<module>/contracts/`, `src/.app/contracts/` | `*.contract.ts` |
| contract | `src/.app/contracts/` | `*.contract.json` |
| guard | `src/.app/guards/`, `src/modules/<module>/guards/` | `*.guard.ts` |
| middleware | `src/.app/middlewares/`, `src/modules/<module>/middlewares/` | `*.middleware.ts` |
| filter | `src/.app/filters/`, `src/modules/<module>/filters/` | `*.filter.ts` |
| interceptor | `src/.app/interceptors/`, `src/modules/<module>/interceptors/` | `*.interceptor.ts` |
| decorator | `src/.app/decorators/` | `*.decorator.ts` |
| config | `src/.app/configs/` | `*.config.ts` |
| hook | `src/modules/<module>/hooks/`, `src/.app/hooks/` | `*.hook.ts` |
| dispatch | `src/dispatch/`, `src/dispatch/.../` | `*.dispatch.ts` |

Mandatory for new orchestrators (`pso create orchestrator`). `src/main.ts` only calls `bootstrap()`; `src/shared/` holds code of no single module. A 0.1 orchestrator (`src/routes/<module>/`) keeps its layout: see the structure migration guide.

- Entry point `src/main.ts` calls `bootstrap({ appDir: __dirname })` from `@pso/http`. Do not put routing logic there.
- The project is **compiled** with `tsc` (CommonJS, `experimentalDecorators`, `emitDecoratorMetadata`) and runs from `dist/`. Use `npm run build`, `npm run dev` or `pso dev`.
- Relative imports in module files are extensionless (`./users.service`).

## API (from `@pso/http` and `@pso/core`)

{{facts:api}}

## Rules

- Constructor parameter types are the dependency contract. Classes with dependencies need `@Injectable()`. A dependency must be a provider of the module, exported by an imported module, or `Upstream`.
- In the official structure, application-wide guards live in `src/.app/guards/<name>.guard.ts`; module-local guards live in `src/modules/<module>/guards/`. The `src/guards/` and `src/routes/<module>/guards/` paths belong to 0.1 projects. A guard is `Guard = (req, route) => true | false | { allow: false, status: 401 | 403 }`. Its name is the file name without `.guard.ts`.
- Middleware runs after the guards; filters handle thrown errors and return `true` when handled.
- `@Body()` parses JSON with limits and does **not** validate fields. `@Body(MyDto)` validates against a `@Dto` class (see the add-dto task); otherwise validate in the action or in the Spring service.
- HTTP limits are configuration, not code: `http.limits.*` / `MAX_BODY_BYTES`, `MAX_UPSTREAM_RESPONSE_BYTES`, `UPSTREAM_TIMEOUT_MS`, `MAX_CONCURRENT_REQUESTS` ... (one precedence: variable > `PSO_CFG_*` > `pso.config.<env>.json` > `pso.config.json` > defaults). Oversized bodies are `413`, upstream failures `502/503/504` problems; do not buffer bodies yourself.
- Domain logic does not belong in the orchestrator; forward to the owning service with `this.upstream.forward(req, res, "service")`, and set `metadata: { service: "service" }` on the route.
- To build one response from several services, inject `UpstreamClient` and declare `metadata: { services: ["a", "b"] }` on the route (`pso make:route ... --compose a,b`). It calls registered services by NAME only (no URL), applies each service's prefix, propagates the correlation id, sends the caller's token only with `credentials: "caller"`, has a deadline (`timeoutMs`) and a size limit, and throws `UpstreamCallError`. A service the route did not declare is refused. It makes one attempt: no retries, no transactions across services.
- In the official structure, `pso make:provider|make:hook <name> --module <module>` writes `@Injectable()` classes in `src/modules/<module>/providers/` or `hooks/` and registers them in that module's `MODULE.pso.ts`. A hook implements `onReady()` and/or `onShutdown()`. Application-wide configuration is a plain importable module in `src/.app/configs/`. The top-level `src/providers/`, `src/hooks/` and `src/configs/` paths belong to 0.1 projects. Nothing runs merely because a file exists.
- An unexpected error always answers the sanitized problem `PSO_INTERNAL_ERROR`; never return or log exception messages yourself. The log has the error type and its origin; message and stack only with `logging.errorDetails` (development).
- Optional typing: `pso types` writes `src/pso-types.d.ts` so the compiler checks service and guard names. String declarations stay valid without it.

## Request pipeline (in order)

rate limit (per address; then per principal and route policy after the guards), route match (undeclared = 404), guards (401/403), middleware, parameter and body binding (400/413/415), action, response (201 for POST, 200 otherwise), filters on errors.
