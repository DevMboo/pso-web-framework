---
title: Controller or service?
description: What belongs in a controller and what in a service or provider, in the orchestrator and in Spring - with a rule of thumb, a worked example and the consequences of getting it wrong.
order: 30
keywords: [decision, controller, service, provider, responsibilities, transaction]
related: [orchestrator/services-and-providers, orchestrator/controllers, spring/postgresql-crud, decisions/gateway-or-service-validation]
---
## The question

You are writing the code for an endpoint. Which lines go in the controller, and which in a service?

## The short answer

| | Controller | Service / provider |
|---|---|---|
| Job | translate HTTP to a call and back | do the work |
| Knows about | the request, the response, status codes, parameters, the DTO | the domain, other services, transactions |
| Does not know about | SQL, transactions, how other services are called | HTTP: no `req`, `res`, headers or status codes |
| Test with | a request (MockMvc, an HTTP call) | a plain unit test, no server |

If you can describe a line without the word "request", it probably belongs in the service.

## Worked example: "create an order"

```typescript
// orchestrator, controller: reads the validated body, calls, returns
@Post("/")
create(@Body(CreateOrderDto) body: CreateOrderDto) {
  return this.orders.place(body);
}

// provider: no HTTP anywhere
@Injectable()
export class OrdersService {
  constructor(private readonly pricing: PricingService) {}
  place(order: CreateOrderDto) { return { accepted: true, total: this.pricing.total(order) }; }
}
```

```java
// Spring: the controller parses and validates, the service owns the transaction
@PostMapping @ResponseStatus(HttpStatus.CREATED)
public ProductResponse create(@Valid @RequestBody ProductRequest r) { return service.create(r); }

@Service class ProductService { @Transactional public ProductResponse create(ProductRequest r) { /* ... */ } }
```

The complete Spring example, with tests, is [PostgreSQL CRUD](/spring/postgresql-crud).

## Trade-offs

**Fat controller.** Fast to write; the logic can only be exercised through HTTP, so tests are slower and fewer; the same rule gets copied into the next controller; in Spring a transaction ends up on the wrong layer.

**A service for everything.** Even a one-line pass-through gets a class. Harmless, but noise. Add the service when there is logic or when a second caller appears, not before.

## Consequences you will feel

- **Transactions** belong on service methods (one method, one unit of work). A controller or repository transaction either spans too much (holding a connection while rendering JSON) or too little (two repository calls with no common boundary).
- **Reuse.** A service called from a controller, a scheduled job and a message consumer behaves the same in all three. A controller cannot be reused.
- **Error mapping.** Services signal failures with exceptions or typed results (`ResponseStatusException` in Spring, `HttpError` in the orchestrator); the controller layer turns them into the standard Problem Details. Services should not build HTTP responses.

## In the orchestrator specifically

The orchestrator is a gateway. Many actions only forward (`Upstream.forward`); those need no service. Add a provider when the orchestrator itself composes several upstream calls, shapes a public response, or hosts a [business validator](/orchestrator/dto-validation). Business rules and data belong behind the gateway, in the owning microservice.

## When this rule bends

A three-line endpoint that reads one value and returns it does not need a service. Do not add layers to satisfy a diagram; add them when the controller stops being obviously correct at a glance.

## Related

[Services and providers](/orchestrator/services-and-providers) · [Controllers](/orchestrator/controllers) · [Gateway or service validation](/decisions/gateway-or-service-validation)

## Common mistakes

- A controller that opens transactions or builds SQL.
- A service that takes `req`/`res` or returns an HTTP status.
- Creating a service class per endpoint "for structure" with no logic in it.
