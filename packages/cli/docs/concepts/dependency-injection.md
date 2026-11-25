---
title: Dependency injection
description: How providers are declared, resolved and scoped in the orchestrator - the rules of the small container, a worked example, what fails before start-up and why Spring is not wrapped.
order: 8
keywords: [di, injectable, provider, constructor, singleton, PSO_MODULE_006, PSO_MODULE_007]
related: [orchestrator/services-and-providers, orchestrator/dependency-injection, orchestrator/dto-validation, decisions/controller-or-service]
---
The orchestrator has a deliberately small container.

- Providers are classes listed in `providers` of `MODULE.pso.ts`. Nothing is found by scanning.
- Dependencies are the **constructor parameter types**, read from TypeScript's emitted metadata. That is why the orchestrator is compiled with `emitDecoratorMetadata`.
- Providers are singletons, created once, in dependency order.
- A controller or provider may depend on: a provider of its own module, a provider **exported** by an imported module, or the built-in `Upstream`.
- Anything else is rejected before start-up (`PSO_MODULE_006`), and provider cycles are rejected too (`PSO_MODULE_007`).

A class with constructor dependencies needs `@Injectable()` so that TypeScript emits its parameter metadata. Spring Boot services use Spring's own context; PSO does not replace it.

## Why so small

A large container (scopes, factories, lazy proxies, property injection) is a second language to learn and a source of start-up surprises. This one answers a narrow question, "which instances does this class need, and do they exist?", in a way a tool can verify **without running your code**. The price is that you cannot do request-scoped injection or inject by string token; you pass request data as arguments.

## A worked example

```typescript
@Injectable() export class PricingService { total(items) { /* ... */ } }
@Injectable() export class OrdersService { constructor(private readonly pricing: PricingService) {} }

@Controller() @RestController("/orders")
export class OrdersController { constructor(private readonly orders: OrdersService) {} }
```

```typescript
// MODULE.pso.ts
providers: [PricingService, OrdersService],   // order does not matter: the container sorts out dependencies
controllers: [OrdersController],
```

At start-up the container builds `PricingService`, then `OrdersService` with it, then the controller with that. All three are shared by every request, so keep per-request state out of fields.

## What the failures look like

| Mistake | When it is found | Code |
|---|---|---|
| a constructor asks for a class that is not available in the module | `pso validate` and start-up | `PSO_MODULE_006` |
| `A` needs `B` and `B` needs `A` | `pso validate` and start-up; the message shows `A -> B -> A` | `PSO_MODULE_007` |
| the class has constructor dependencies but no `@Injectable()` | at run time the parameter arrives `undefined` | add the decorator |

## Business validators use the same container

A `@Validate(Rules)` class on a DTO is a provider like any other: it is listed in `providers`, constructed by the container, and may depend on other providers. One that is not listed stops the start-up ([DTO validation](/orchestrator/dto-validation)).

## Spring

In Spring services use constructor injection with Spring's annotations (`@Service`, `@Component`, `@RequiredArgsConstructor` with Lombok in generated code). PSO adds starters and auto-configuration; the context is Spring's.

## Common mistakes

- Expecting a new instance per request.
- Listing a class in two modules instead of exporting it from one.
- Depending on an interface type: TypeScript interfaces are erased, so the container has nothing to look up. Depend on a class.

## Next steps

- [Services and providers](/orchestrator/services-and-providers)
- [Dependency injection in the orchestrator](/orchestrator/dependency-injection)
