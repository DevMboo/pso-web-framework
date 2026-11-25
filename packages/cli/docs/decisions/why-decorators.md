---
title: Why controllers use decorators
description: Decorators for implementation metadata, with a compiled orchestrator.
order: 4
keywords: [decision, decorators, metadata, typescript, compile]
related: [orchestrator/controllers, orchestrator/architecture]
---
## Context

Controllers need to say, next to the code, which HTTP method and path an action implements, how parameters bind, and which providers they depend on.

## Decision

Use TypeScript decorators and emitted constructor metadata (`@Controller`, `@RestController`, `@Get`, `@Param`, `@Body`, `@Injectable`). They are metadata only; exposure still requires `ROUTES.pso.ts`.

## Consequences

- Familiar, readable controllers; dependency injection from constructor types.
- **The orchestrator must be compiled.** Node cannot run decorators or constructor parameter properties directly, so `tsc` (CommonJS, `experimentalDecorators`, `emitDecoratorMetadata`) builds `dist/` and `pso dev` does that for you.
- Type information is erased at run time, so a TypeScript type annotation never validates anything. DTO validation therefore uses explicit field decorators that record runtime metadata (`@Dto`, `@StringField`, ...), and `@Body(MyDto)` opts in ([DTO validation](/orchestrator/dto-validation)).
- The static validator reads the same decorators from the AST, so build-time and start-up checks agree.

## Alternatives considered

Plain functions with configuration objects (no compile step, but no constructor-type injection) and a decorator-free registry only. Decorators were chosen for ergonomics, with the compile step as the known cost.

## What it looks like in practice

```typescript
@Controller()
@RestController("/orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}          // injected from the constructor's type

  @Post("/")                                                     // describes: this action implements POST /orders
  create(@Body(CreateOrderDto) body: CreateOrderDto) { ... }     // binds and validates the body
}
```

The decorators say what the code *is*. They do not make it reachable: `ROUTES.pso.ts` does ([why](/decisions/why-routes-pso-mandatory)). A decorated method that is not declared answers `404 PSO_HTTP_NOT_FOUND` (verified).

## The costs you will notice

| Cost | What to do |
|---|---|
| a compile step (`tsc`) before running | `npm run dev` and `pso dev` do it; never run `.ts` directly |
| `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig.json` | the generated `tsconfig.json` has them; do not remove them |
| interfaces cannot be injected (erased at run time) | depend on classes |

## Decorators and the registry are checked against each other

Because the validator reads the decorators from the AST, it can compare them with `ROUTES.pso.ts`. A registry that says `POST` for an action decorated `@Get("/")` fails with `Expected: @Post("/")` and `Found: @Get("/")` (`PSO_ROUTE_004`), and a wrong path shows the decorator-derived path (`PSO_ROUTE_005`): see [Validation errors, one by one](/reference/diagnostics-catalog). Validation does not execute the controller to learn this ([why not](/decisions/why-no-code-execution-in-discovery)).

## When to revisit

If TypeScript's standard decorators and metadata story stabilises so that constructor-type injection works without `emitDecoratorMetadata`, the compile step could be simplified. The registry (`ROUTES.pso.ts`) does not depend on decorators for exposure, so such a change would not affect security.
