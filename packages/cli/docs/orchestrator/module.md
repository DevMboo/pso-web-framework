---
title: MODULE.pso.ts
description: Compose a module - its controllers, providers, route registry, imports and exports - with the generators, the rules, the diagnostics you will see and the shapes modules take in practice.
order: 3
keywords: [MODULE.pso.ts, defineModule, controllers, providers, imports, exports, PSO_MODULE_003]
related: [orchestrator/routes, concepts/module-composition, decisions/why-module-pso, orchestrator/services-and-providers]
---
`MODULE.pso.ts` declares what belongs to a module and explicitly imports its route registry.

:::include file="examples/users/MODULE.pso.ts" title="src/modules/users/MODULE.pso.ts"

| Field | Meaning |
|---|---|
| `name` | Must equal the directory name (`kebab-case`). `health` is reserved. |
| `controllers` | Controller classes of this module. A controller absent here is never registered. |
| `providers` | Injectable classes available inside the module (services, guards helpers, business validators). |
| `channels` | `@Channel` classes of [PSO Channels](/orchestrator/channels). Optional; a decorated class that is not listed is never active. |
| `routes` | Must be the default export of this directory's `ROUTES.pso.ts` (`PSO_MODULE_005` otherwise). |
| `imports` | Other modules whose `exports` this module may use. |
| `exports` | Providers other modules may use. |

## Generate it

```bash
pso make:module users
pso make:controller users
pso make:service users --export
```

Expected output of the first and a service command (expected):

```text evidence="expected"
$ pso make:module orders --service gw
created  src/modules/orders/MODULE.pso.ts
created  src/modules/orders/routes/ROUTES.pso.ts
$ pso make:service orders --service gw
updated  src/modules/orders/MODULE.pso.ts
created  src/modules/orders/services/orders.service.ts
```

`make:controller` and `make:service` add the class to `controllers` / `providers` through the TypeScript AST, adding the import and leaving everything else in the file untouched. A new module exposes nothing: its `ROUTES.pso.ts` is empty until you add routes.

## What you will see when it is wrong

| Situation | Diagnostic |
|---|---|
| a `*.controller.ts` exists in the directory but is not in `controllers` | `PSO_MODULE_003`, and at run time it is never loaded |
| the directory has HTTP code but no `MODULE.pso.ts` | `PSO_MODULE_001` (verified output on [Convention over configuration](/concepts/convention-over-configuration)) |
| `ROUTES.pso.ts` missing | `PSO_MODULE_002` |
| `name` differs from the directory, or is duplicated | `PSO_MODULE_004` |
| `routes` is not the default export of `./ROUTES.pso` | `PSO_MODULE_005` |
| a constructor dependency is neither local nor exported by an imported module | `PSO_MODULE_006` |
| a provider cycle | `PSO_MODULE_007` |
| `imports` names a module that does not exist | `PSO_MODULE_008` |

## Variations

**Controller and service in one module** (the common case): `controllers: [OrdersController]`, `providers: [OrdersService]`.

**A module that only shares logic**:

```typescript
export default defineModule({ name: "pricing", controllers: [], providers: [PricingService], routes: pricingRoutes, imports: [], exports: [PricingService] });
```

**A module that uses it**:

```typescript
export default defineModule({ name: "orders", controllers: [OrdersController], providers: [OrdersService], routes: ordersRoutes, imports: [pricingModule], exports: [] });
```

**A module with a business validator** ([DTO validation](/orchestrator/dto-validation)): the validator class goes in `providers`, otherwise start-up refuses.

## Rules

- The declaration must be statically analyzable: arrays of identifiers, string-literal `name`.
- A controller class in the directory that is **not** listed in `controllers` is rejected by `pso validate` (`PSO_MODULE_003`) and ignored, never loaded, at runtime.
- Constructor dependencies must resolve (`PSO_MODULE_006`) and must not form a cycle (`PSO_MODULE_007`).

## Common mistakes

- Adding a controller file by hand and forgetting the list.
- Renaming the directory without renaming `name`.
- Exporting everything "just in case": exports are the module's public surface; keep it small.

## Next steps

- [Routing](/orchestrator/routes)
- [Services and providers](/orchestrator/services-and-providers)
