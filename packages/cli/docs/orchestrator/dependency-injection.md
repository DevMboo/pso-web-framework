---
title: Dependency injection in the orchestrator
description: A complete example - a service injected into a controller, exported and imported across modules - with the exact diagnostics for each mistake and the rules of the container.
order: 11
keywords: [injectable, imports, exports, PSO_MODULE_006, PSO_MODULE_007, constructor]
related: [concepts/dependency-injection, orchestrator/services-and-providers, orchestrator/module]
---
The `users` module injects `UsersService` into `UsersController` through the constructor:

```typescript {4}
@Controller()
@RestController("/users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}
  // ...
}
```

`MODULE.pso.ts` lists `UsersService` in `providers`, so the dependency resolves. Remove it and `pso validate` fails:

```text evidence="expected"
PSO_MODULE_006

Dependency cannot be resolved.

Module: users
Controller: UsersController

Expected: UsersService listed in providers or exported by an imported module
Found: not available in this module

Module activation denied.
```

The orchestrator refuses to start with the same diagnostic, so the mistake cannot reach traffic.

## Step by step: share a provider between modules

1. Create the modules and the provider:

```bash
pso make:module pricing
pso make:service pricing --export        # PricingService, exported
pso make:module orders
pso make:controller orders
```

2. Make `orders` import `pricing` (edit `src/modules/orders/MODULE.pso.ts`):

```typescript
import pricingModule from "../pricing/MODULE.pso";
export default defineModule({ name: "orders", controllers: [OrdersController], providers: [], routes: ordersRoutes, imports: [pricingModule], exports: [] });
```

3. Inject it:

```typescript
constructor(private readonly pricing: PricingService) {}
```

4. Check. Verified: with the `imports` entry missing, `pso validate` printed `ERROR PSO_MODULE_006 gw/src/modules/orders/MODULE.pso.ts: Dependency cannot be resolved.` (Expected `PricingService` listed in providers or exported by an imported module; Found: not available in this module) and exited 1; with the import added it printed `OK` and exited 0. `pso validate` prints `OK`. If you forget the `imports` entry the diagnostic is `PSO_MODULE_006`; if you import a module that does not exist it is `PSO_MODULE_008`.

## A provider that needs another provider

```typescript
@Injectable()
export class OrdersService {
  constructor(private readonly pricing: PricingService) {}
}
```

Both in `providers` (or one exported by an imported module), `@Injectable()` on the class that has dependencies. The container builds them in dependency order. A cycle is `PSO_MODULE_007` and the message shows the path.

## Rules

- Constructor types are the contract. An interface or `any` becomes `Object` and is unresolvable.
- Providers are singletons per process.
- `Upstream` is built in: inject it anywhere without declaring it.
- Cycles (`A` needs `B` needs `A`) fail with `PSO_MODULE_007` before start-up.
- Spring Boot services use Spring's own container; none of this applies there.

## Alternatives when you need an abstraction

The container has no token-based or optional injection. Common ways to get the same effect:

| Need | Approach |
|---|---|
| swap an implementation in tests | extend the class and list the subclass under `providers` in a test module; or pass the dependency as a constructor argument in a unit test (no container) |
| two implementations of one idea | two classes with a shared abstract base class; inject the one you need by class |
| configuration | read it from configuration at the point of use, not from a provider tree |

## Common mistakes

- Depending on an interface type.
- Listing the same class in two modules instead of exporting it.
- Forgetting `@Injectable()` on a class with constructor parameters.

## Next steps

- [Services and providers](/orchestrator/services-and-providers)
- [Module composition](/concepts/module-composition)
