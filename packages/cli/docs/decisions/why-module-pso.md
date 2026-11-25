---
title: Why MODULE.pso.ts exists
description: Composition as an explicit, validated declaration.
order: 2
keywords: [decision, module, composition]
related: [orchestrator/module, concepts/module-composition]
---
## Context

A directory full of controllers and services does not say which ones belong together, which are public to other modules, or in what order things can be wired.

## Decision

Each module has a `MODULE.pso.ts` that lists its controllers and providers, imports its own route registry and states what it exports. A controller missing from it is never registered.

## Consequences

- Dependency injection is **scoped and checkable**: a controller can only receive providers the module declares or imports (`PSO_MODULE_006`).
- Module boundaries are visible in one small file; `exports` makes sharing deliberate.
- Accidentally adding a controller file does not expose or load anything.
- The cost is one extra file per module, which `pso make:module` and `make:controller` maintain through the AST.

## Alternatives considered

Scanning all `*.controller.ts` files (implicit and unsafe: a stray file would load) and a single global registry (poor locality).

## What it looks like in practice

A controller that exists on disk but is not listed is neither loaded nor exposed. Create `src/modules/ghost/controllers/ghost.controller.ts` without a `MODULE.pso.ts` and validation says so (expected):

```text evidence="expected"
ERROR   PSO_MODULE_001 gateway: Module declaration missing.
```

and a controller file inside a valid module but absent from `controllers` is `PSO_MODULE_003`. Both are found by `pso validate` before the application runs.

## Reproduced

Removing the controller from `controllers: []` is `PSO_MODULE_003` (the controller is never registered) together with `PSO_ROUTE_001` (a route points at a controller that is not part of the module); a deleted `ROUTES.pso.ts` is `PSO_MODULE_002`. The exact messages, with the `Expected` and `Found` lines, are in [Validation errors, one by one](/reference/diagnostics-catalog).

## The cost

One more file per module, and a rule: adding a controller means updating the module. The generators (`make:controller`, `make:service`) edit it for you, using the TypeScript AST so that your formatting survives.

## When to revisit

If modules become too fine-grained to be worth a file each, group related controllers in one module instead of dropping the declaration; the declaration is what makes dependency injection checkable.
