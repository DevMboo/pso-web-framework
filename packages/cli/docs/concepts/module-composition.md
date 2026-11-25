---
title: Module composition
description: How MODULE.pso.ts, ROUTES.pso.ts and controllers compose one HTTP module, how modules share providers, and the one invariant the framework enforces.
order: 6
keywords: [module, composition, defineModule, imports, exports, ROUTES.pso.ts]
related: [orchestrator/module, orchestrator/routes, decisions/why-module-pso, orchestrator/services-and-providers]
---
A module is a directory under `src/modules/` with three kinds of file. None is enough alone. Think of the directory as a boundary: composition says what belongs together, the route registry says what callers may reach, and the controller performs the work.

| File | Role | Question it answers |
|---|---|---|
| `MODULE.pso.ts` | Composition | Which controllers and providers belong to this module? |
| `ROUTES.pso.ts` | Declaration | Which endpoints are exposed, under which security policy? |
| `*.controller.ts` | Implementation | What does each endpoint do? |

The following files are the complete `users` example in this repository. They are a **concept example**: to run them you also need a workspace and the registered `users-key` guard shown in [Guards](/orchestrator/guards). The important detail is the `remove` action at the end of the controller.

:::include file="examples/users/MODULE.pso.ts" title="src/modules/users/MODULE.pso.ts"

:::include file="examples/users/routes/ROUTES.pso.ts" title="src/modules/users/routes/ROUTES.pso.ts"

:::include file="examples/users/controllers/users.controller.ts" title="src/modules/users/controllers/users.controller.ts"

Read the chain in order:

1. `MODULE.pso.ts` registers `UsersController` and `UsersService`; the controller's constructor can receive the service because it is a provider of this module.
2. `ROUTES.pso.ts` declares three public HTTP operations and assigns their access policies. Only `GET /users` is anonymous; the other two require `users-key`.
3. The controller implements four decorated methods. `remove` has `@Delete`, but there is **no DELETE entry** in `ROUTES.pso.ts`, so callers cannot reach it.

| Method | Controller action | In the route registry? | Exposed? |
|---|---|---|---|
| `GET /users` | `findAll` | yes, public | yes |
| `GET /users/:id` | `findById` | yes, guarded | yes |
| `POST /users` | `create` | yes, guarded | yes |
| `DELETE /users/:id` | `remove` | no | no |

## The invariant

An HTTP endpoint exists **if and only if** it is declared in `ROUTES.pso.ts`, belongs to a valid module, references a compatible decorated controller action and passes every security and dependency validation.

Each failed condition has its own diagnostic: a controller missing from `MODULE.pso.ts` is `PSO_MODULE_003`, a registry that points at a missing action is `PSO_ROUTE_002`, a method or path that disagrees with the decorator is `PSO_ROUTE_004`/`005`.

In a workspace containing this module, run `pso validate` first, then `pso routes:list`. Validation establishes that the files agree; the route list should show only the three declared operations. Calling `DELETE /users/1` is a separate runtime check and should be refused as an undeclared route. This distinction is why adding a decorator is never the whole procedure for adding an endpoint.

## Sharing between modules

Modules compose through `imports` and `exports`: a module may use providers that an imported module exports, and only those.

```typescript evidence="illustrative" title="Two module declarations, excerpts"
// orders/MODULE.pso.ts: OrdersService is local; PricingService is available to importers.
providers: [OrdersService, PricingService], exports: [PricingService]

// billing/MODULE.pso.ts: the import makes PricingService available here.
imports: [ordersModule]
```

Provider dependencies are resolved from constructor parameter types and must be available inside the module, exported by an imported module, or built in (`Upstream`).

The excerpts show only the relationship, not complete files. For imports, provider declarations, a failing diagnostic and its correction in a runnable workspace, follow [Dependency injection](/orchestrator/dependency-injection). The reason to export only selected providers is to keep each module's internal services from becoming an accidental public dependency.

## Variations

| Shape | When |
|---|---|
| one module per resource (`product`, `customer`) | the default; what `make:resource` produces |
| one module with several controllers | closely related endpoints sharing providers |
| a module with providers and no routes | shared logic exported to others (routes may be empty) |

## Common mistakes

- Creating a controller and forgetting the module's `controllers` list (`PSO_MODULE_003`).
- Putting the same provider in two modules rather than exporting it.
- Making `ROUTES.pso.ts` dynamic (loops, spread): it must be literal so it can be verified without running ([declarative architecture](/concepts/declarative-architecture)).

## Next steps

- [Module](/orchestrator/module) and [Routing](/orchestrator/routes)
- [Why `MODULE.pso.ts`](/decisions/why-module-pso)
