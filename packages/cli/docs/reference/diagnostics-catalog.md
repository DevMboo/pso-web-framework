---
title: Validation errors, one by one
description: Eleven real mistakes in modules, routes, services and security, the exact message `pso validate` prints for each, why it happens, how to fix it and how to prevent it.
order: 6
status: stable
keywords: [pso validate, diagnostics, PSO_MODULE_003, PSO_ROUTE_001, PSO_ROUTE_002, PSO_ROUTE_004, PSO_ROUTE_005, PSO_ROUTE_008, PSO_ROUTE_010, PSO_PORT_CONFLICT, PSO_MISPLACED_RESOURCE, security:validate]
related: [reference/troubleshooting, orchestrator/routes, orchestrator/module, concepts/module-composition, microservices/project-structure, security/security-configuration]
---
`pso validate` reads your sources without running them and refuses anything that would expose an endpoint by accident. This page shows what it says when you get something wrong. Each mistake below was **made on purpose** in a generated workspace (`gateway` with an `orders` module, plus a `catalog` service) and the output was copied from the run. A test repeats these mistakes and checks that the same codes come back, so the page cannot drift from the CLI.

The baseline, before any mistake:

```bash
pso validate
```

```text evidence="verified"
gateway: 4 resource(s), digest f7c1e0ee9cd0
catalog: 3 resource(s), digest 6c847b46dc80
OK
```

Every failure ends with the same two summary lines and `FAILED`, and the exit code is non-zero, so `pso validate` works as a CI gate ([CI/CD](/devops/ci-cd)). The summaries are left out below.

## How to read a diagnostic

| Part | Meaning |
|---|---|
| `ERROR` | blocks validation. `WARN` and `INFO` do not |
| `PSO_<AREA>_<NNN>` | a stable code. Search for it in the docs, in the logs and in your CI output |
| the path | the file the problem is in |
| `Module`, `Route`, `Controller`, `Action` | where it was found |
| `Expected` / `Found` | what the rule wanted and what the source says |
| the last sentence | the consequence: for example "Route activation denied" |

## Module and route errors

### 1. A controller that the module does not register (`PSO_MODULE_003`, `PSO_ROUTE_001`)

**The mistake.** `MODULE.pso.ts` lost its controller:

```typescript title="orchestrators/gateway/src/modules/orders/MODULE.pso.ts"
export default defineModule({
  name: "orders",
  controllers: [],
```

```text evidence="verified"
ERROR   PSO_MODULE_003 orchestrators/gateway/src/modules/orders/MODULE.pso.ts: Controller is not declared in MODULE.pso.ts.

Module: orders
Controller: OrdersController

A controller absent from the module declaration is never registered.

Controller rejected.
ERROR   PSO_ROUTE_001 orchestrators/gateway/src/modules/orders/routes/ROUTES.pso.ts: Route references a controller that is not part of the module.

Module: orders
Route: GET /orders
Controller: OrdersController
Action: list

Expected: OrdersController listed in MODULE.pso.ts controllers
Found: controllers: []

Route activation denied.
```

**Why.** `MODULE.pso.ts` controls what is registered. A decorated class that no module lists is dead code, and a route that points at it cannot be activated. Two codes appear because both files are inconsistent.

**Fix.** Add the controller back: `controllers: [OrdersController]`.

**Prevention.** Generate controllers with `pso make:controller`, which edits the module for you.

### 2. A route that names an action that does not exist (`PSO_ROUTE_002`)

**The mistake.** `ROUTES.pso.ts` says `action: "listAll"`, the controller has `list`.

```text evidence="verified"
ERROR   PSO_ROUTE_002 orchestrators/gateway/src/modules/orders/routes/ROUTES.pso.ts: Controller action does not exist.

Module: orders
Route: GET /orders
Controller: OrdersController
Action: listAll

Expected: method listAll() on OrdersController
Found: actions: list

Route activation denied.
```

**Fix.** Use a name listed after `Found: actions:`. **Prevention.** `pso make:route` writes the decorator and the registry entry together and rolls back if they disagree.

### 3. A method that differs from the decorator (`PSO_ROUTE_004`)

**The mistake.** The registry says `POST`, the action is `@Get("/")`.

```text evidence="verified"
ERROR   PSO_ROUTE_004 orchestrators/gateway/src/modules/orders/routes/ROUTES.pso.ts: Route declaration mismatch.

Module: orders
Route: POST /orders
Controller: OrdersController
Action: list

Expected: @Post("/")
Found: @Get("/")

Route activation denied.
```

**Why.** The registry and the decorator are two statements about one endpoint. PSO never guesses which one you meant. **Fix.** Make both the same.

### 4. A path that differs from the controller (`PSO_ROUTE_005`)

**The mistake.** `path: "/order"` where the controller says `/orders`.

```text evidence="verified"
ERROR   PSO_ROUTE_005 orchestrators/gateway/src/modules/orders/routes/ROUTES.pso.ts: Route path does not match the controller.

Module: orders
Route: GET /order
Controller: OrdersController
Action: list

Expected: path "/orders" (from @RestController("/orders") + @Get("/"))
Found: path "/order"

Route activation denied.
```

**Fix.** The public path is the controller prefix plus the action path; copy it from the `Expected` line.

### 5. A guard that does not exist (`PSO_ROUTE_008`)

**The mistake.** `guard: "jwtt"`.

```text evidence="verified"
ERROR   PSO_ROUTE_008 orchestrators/gateway/src/modules/orders/routes/ROUTES.pso.ts: Unknown guard.

Module: orders
Route: GET /orders
Controller: OrdersController
Action: list

Expected: an existing guard named "jwtt"
Found: available: jwt

Route activation denied.
```

**Why it matters.** A typo in a guard must never turn into an unprotected route, so the route is refused. **Fix.** Use a name from `available:`.

### 6. A route that forwards to a service that is not in the workspace (`PSO_ROUTE_010`)

**The mistake.** `metadata: { service: "billing" }` while the workspace has only `catalog`.

```text evidence="verified"
ERROR   PSO_ROUTE_010 orchestrators/gateway/src/modules/orders/routes/ROUTES.pso.ts: Route targets an unknown service.

Module: orders
Route: GET /orders

Expected: one of catalog
Found: billing

Route activation denied.
```

**Fix.** Register the service (`pso create service billing` or `pso services:register`), or correct the name.

### 7. A decorated action with no route: no error, and nothing exposed

**The mistake.** `ROUTES.pso.ts` has `routes: []` while the controller still has `@Get`.

```text evidence="verified"
gateway: 4 resource(s), digest f7c1e0ee9cd0
catalog: 3 resource(s), digest 6c847b46dc80
OK
```

This is **correct behaviour, not a gap**: decorators describe, `ROUTES.pso.ts` decides. A request to `GET /orders` answers `404` because the route does not exist. If an endpoint "does nothing", check the registry first (`pso routes:list`).

### 8. A deleted route registry (`PSO_MODULE_002`)

**The mistake.** `ROUTES.pso.ts` was removed.

```text evidence="verified"
ERROR   PSO_MODULE_002 orchestrators/gateway/src/modules/orders/MODULE.pso.ts: Route registry missing.

Module: orders

routes/orders/ROUTES.pso.ts does not exist. Controllers are never exposed without an explicit route registry.

No route of this module is activated.
```

**Fix.** Restore the file, or recreate the module with `pso make:module`.

## Workspace and layout errors

### 9. Two services on one port (`PSO_PORT_CONFLICT`)

```text evidence="verified"
ERROR   PSO_PORT_CONFLICT pso.workspace.json: Services "gateway" and "catalog" both use port 3000
        hint: Give each service its own port
```

**Fix.** Change one `port` in `pso.workspace.json`. `pso dev` also checks ports before starting anything, so a conflict never leaves half a platform running.

### 10. A class in the wrong directory (`PSO_MISPLACED_RESOURCE`)

**The mistake.** A mapper in a `misc/` package:

```text evidence="verified"
ERROR   PSO_MISPLACED_RESOURCE services/catalog/src/main/java/com/pso/catalog/misc/OrderMapper.java: mapper "OrderMapper" must live in "application/mapper/" (under the application package) in the layered structure
        hint: Move it, or generate it with `pso make:mapper` which places it correctly
```

**Why.** The owning directory decides the kind of a class ([project structure](/microservices/project-structure)). That is what lets tools and people find things without reading every file. **Fix.** Move the file and its `package` declaration.

## Security errors

### 11. A guard with no JWT configuration (`SEC005`, `PSO_SEC_MISSING`)

A workspace whose orchestrator uses the `jwt` guard but has no issuer, audience or key source:

```bash
pso security:check
```

```text evidence="verified"
HIGH     SEC005 gateway
         jwt guard is used but security.authentication.issuer, security.authentication.audience, a key source (security.authentication.jwks.uri or security.authentication.publicKey.file) is not configured for "production"; the orchestrator will refuse to start
         fix: Declare security.authentication.* in pso.config.json (or set the PSO_JWT_* environment variables); the legacy security.jwt.* keys are still read
FAILED
```

```bash
pso security:validate
```

```text evidence="verified"
environment: development
INVALID gateway (orchestrator)
         high     PSO_SEC_MISSING: issuer is required (PSO_JWT_ISSUER)
         high     PSO_SEC_MISSING: audience is required (PSO_JWT_AUDIENCE)
         high     PSO_SEC_MISSING: a key source is required: security.authentication.jwks.uri (PSO_JWT_JWKS_URI) or security.authentication.publicKey.file (PSO_JWT_PUBLIC_KEY_FILE)
ok      catalog (spring-service)

Static validation only: key providers (JWKS reachability) are checked when each service starts.
```

And what the orchestrator itself does when it is started anyway (a route uses the `jwt` guard, no `PSO_JWT_*` set; the same in development and in production):

```json evidence="verified"
{"ts":"2026-11-08T16:48:08.841Z","level":"info","msg":"starting orchestrator","component":"startup","service":"gateway","environment":"development","logLevel":"info","logFormat":"json","node":"v24.18.0"}
{"ts":"2026-11-08T16:48:08.852Z","level":"error","msg":"security initialization failed","code":"PSO_SEC_MISSING","detail":"issuer is required (PSO_JWT_ISSUER)"}
{"ts":"2026-11-08T16:48:08.852Z","level":"error","msg":"security initialization failed","code":"PSO_SEC_MISSING","detail":"audience is required (PSO_JWT_AUDIENCE)"}
```

The process exits instead of serving unprotected routes. (A fresh orchestrator with no guarded route starts without any JWT setting: the check applies once a route uses the guard.)

**Fix.** Set the three values ([authentication](/security/authentication), [keys](/security/keys-and-pem)). Note the last line: this check is static. A key URL that is wrong or unreachable is found when the service starts, not here.

## Environment checks

```bash
pso doctor
```

```text evidence="verified"
ok      node    v24.18.0  (>=24)
ok      java    java version "25.0.3" 2026-04-21 LTS  (>=21 for Spring Boot services)
missing mvn     not found  (optional (or use Docker))
ok      docker  Docker version 29.6.1, build 8900f1d  (optional)
```

`mvn` is optional because generated services carry the Maven Wrapper (`./mvnw`). Versions in the output are those of the verification machine.

```bash
pso services:graph
```

```text evidence="verified"
startup order: catalog -> gateway
```

`pso dev` starts services in this order, and `pso services:health` calls each service's health URL.

## Checklist when something does not work

1. `pso validate`: structure first. Most "it does nothing" problems end here.
2. `pso routes:list`: is the endpoint registered, with the guard and upstream you expect?
3. `pso security:validate`: is authentication configured?
4. `pso doctor`: are Node and Java the right versions?
5. `pso services:health`: is anything actually running?
6. The response's `x-correlation-id`, searched in the gateway log ([logging](/devops/logging)).

## Common mistakes

- Reading only the first `ERROR`. A single root cause often produces several codes (see 1).
- Editing the decorator and forgetting the registry, or the opposite. Use `pso make:route`.
- Treating `OK` as "my endpoint exists": `OK` means the declarations are consistent, and an empty registry is consistent.
- Fixing a guard typo by removing the guard.

## Next steps

- [Troubleshooting](/reference/troubleshooting)
- [Routes](/orchestrator/routes)
- [Module composition](/concepts/module-composition)
- [Error standard](/reference/error-standard)
