---
title: ROUTES.pso.ts and routing
description: The authoritative route registry, the three-way validation and why decorators alone expose nothing.
order: 4
keywords: [ROUTES.pso.ts, defineRoutes, routing, validation, PSO_ROUTE_004]
related: [orchestrator/module, orchestrator/controllers, decisions/why-routes-pso-mandatory, security/secure-routing]
---
PSO enforces one invariant at build time and at start-up:

> An HTTP endpoint exists if and only if it is explicitly declared in the route registry, belongs to a valid module, references a compatible decorated controller action, and passes all applicable security and dependency validations.

| File | Role | Question it answers |
|---|---|---|
| `MODULE.pso.ts` | Module composition | Which controllers and providers belong to this module? |
| `ROUTES.pso.ts` | Route declaration (authoritative) | Which endpoints are exposed, with which policy? |
| `*.controller.ts` | Controller implementation | What does each endpoint do? |

## ROUTES.pso.ts

:::include file="examples/users/routes/ROUTES.pso.ts" title="src/modules/users/routes/ROUTES.pso.ts"

Each entry supports: `method`, `path` (the full public path), `controller`, `action`, `security` (`{ public: true }` or `{ guard, scopes }`), `guards`, `middleware`, `filters`, `metadata` (`metadata.service` names the upstream the action forwards to) and `version` (served under `/v<version>`).

## Why decorators alone do not expose anything

`@Delete("/:id")` on `remove()` only describes that method. In the example it is **not** in `ROUTES.pso.ts`, so `DELETE /users/:id` answers `404`. A controller that is not listed in `MODULE.pso.ts` is never even loaded. There is no implicit discovery, no fallback when `ROUTES.pso.ts` is missing and no wildcard registration.

## What is validated

The same validator runs in `pso validate` (on the AST, executing nothing) and in `bootstrap()` (on decorator metadata). Any error stops start-up and **no route is activated**:

1. the controller is declared in `MODULE.pso.ts`;
2. the route is declared in `ROUTES.pso.ts`;
3. the controller action exists;
4. the action has an HTTP decorator;
5. the declared method matches the decorator;
6. the declared path equals the `@RestController` prefix plus the action path;
7. constructor dependencies resolve;
8. the security policy is satisfied (deny by default; a declaration can never weaken a guard);
9. there are no duplicate or conflicting routes (`/users/:id` and `/users/:userId` collide);
10. the module is consistent (name, own registry, imports, no cycles).

```text evidence="expected"
PSO_ROUTE_004

Route declaration mismatch.

Module: users
Route: GET /users/:id
Controller: UsersController
Action: findById

Expected: @Get("/:id")
Found: @Post("/:id")

Route activation denied.
```

Nothing is silently corrected. See the [diagnostics reference](/reference/diagnostics) for every code.

## Generate routes

```bash
pso make:route users findAll --method GET --path / --public
pso make:route users findById --method GET --path /:id --guard jwt --scopes users:read
pso make:resource customer --service catalog --route /customers --scopes customers:read
```

`make:route` adds the decorated action **and** the declaration, refuses duplicates, never overwrites existing code and rolls everything back if the result would be invalid.

> [!WARNING]
> Declaring a route is not authentication. `security: { public: true }` is an explicit decision; otherwise a guard is required. A route that is public **and** guarded is rejected.

## What you see

Expected output for a gateway with a guarded route forwarded to a service and a public route of its own:

```text evidence="expected"
$ pso routes:list
GET     /products                product.findAll        -> catalog        guard:jwt
GET     /reports/summary         reports.summary                          public

$ pso routes:inspect product.findAll
GET /products  ->  catalog:8081
access:   guard jwt, scopes products:read
defined:  orchestrators/gateway/src/modules/product/routes/ROUTES.pso.ts
contract: present
handlers: services/catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java
```

Note that the public route's path is the **controller prefix plus the action path**: a module whose controller has `@RestController("/reports")` and an action `@Get("/summary")` is served at `/reports/summary`, and `make:route --path /summary` is relative to the prefix.

How each kind of request is answered (expected; full bodies on [First endpoint](/getting-started/first-endpoint)):

| Request | Answer |
|---|---|
| a declared public route | `200` |
| a declared guarded route, no token | `401 PSO_AUTH_UNAUTHORIZED` |
| a declared guarded route, token without the scope | `403 PSO_AUTH_FORBIDDEN` |
| a method that is decorated but not declared | `404 PSO_HTTP_NOT_FOUND` |
| a path nobody declared | `404 PSO_HTTP_NOT_FOUND` |

## Variations

| You want | Declare |
|---|---|
| public read | `security: { public: true }` on a `GET` (the generators refuse public non-GET routes) |
| a guarded write with its own scope | `security: { guard: "jwt", scopes: ["orders:write"] }` |
| several guards (all must pass) | `guards: ["jwt", "orders-key"]` |
| middleware or a filter for one route | `middleware: ["audit"]`, `filters: ["conflict"]` ([guide](/orchestrator/middleware-and-filters)) |
| a versioned path | `version` ("served under /v<version>", as documented in the route entry type; confirm with `pso routes:list` for your route) |
| the gateway to forward | `metadata: { service: "catalog" }` and an action that calls `Upstream.forward` |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| a new action answers `404` | it is not in `ROUTES.pso.ts`: `pso make:route`, then `pso routes:list` |
| `PSO_ROUTE_004` / `005` | method or path in the registry differs from the decorators: make them agree |
| `PSO_ROUTE_006` | two routes collide (`/users/:id` and `/users/:userId` are the same route) |
| `PSO_ROUTE_007` | no security policy, or public and guarded together |
| `PSO_ROUTE_008` | an unknown guard, middleware or filter name |
| `PSO_ROUTE_009` | an invalid declaration (a method that does not exist, a path that does not start with `/` or contains spaces, `?` or `#`) |
| `PSO_ROUTE_010` | the route targets a service that is not declared in the workspace |
| the route works in `pso validate` but 404s at run time | the compiled `dist` is stale: rebuild (`npm run build`) |

## Declaring the services an action composes

A route that forwards names one service; a route whose action builds its response from several services names all of them:

```ts
metadata: { service: "catalog" }                              // Upstream.forward
metadata: { services: ["customers", "orders", "catalog"] }    // UpstreamClient
```

Both are checked the same way: `pso validate` refuses a name that is not a service of the workspace (`PSO_ROUTE_010`), and at run time an action cannot reach a service its route did not declare. `pso make:route ... --compose customers,orders` writes the declaration together with the action ([upstream clients](/orchestrator/upstream-clients)).

## Canonical syntax and what stays optional

The string-based declarations on this page are the canonical syntax and keep working unchanged. Two things can be added on top, and neither replaces a declaration:

| Addition | Effect | Without it |
|---|---|---|
| `pso types` (`src/pso-types.d.ts`) | the compiler checks service and guard names in `metadata`, `security.guard`, `guards`, `Upstream.forward` and `UpstreamClient` | any string compiles; `pso validate` and start-up still refuse unknown names |
| the generators (`make:route`, `make:resource`, `make:controller`) | the controller action and its `ROUTES.pso.ts` entry are written together and rolled back together | you write both by hand; `pso validate` reports any difference |

The path appears in the declaration and on the controller on purpose: the declaration is the application's intent, the controller its implementation, and PSO compares the two before anything is exposed. An action name is checked by `pso validate` and at start-up (`PSO_ROUTE_004`), not by the compiler: typing it in `defineRoutes` would reject declarations that are valid today.

## Common mistakes

- Treating `routes:list` output as proof of runtime behavior: it is the declaration.
- Writing the full path in `make:route --path` when the controller already has a prefix.
- Declaring a route and forgetting that the controller must be in `MODULE.pso.ts` (`PSO_MODULE_003`).

## Next steps

- [Controllers](/orchestrator/controllers)
- [Secure routing](/security/secure-routing)
- [Module](/orchestrator/module)
