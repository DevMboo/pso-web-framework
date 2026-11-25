---
title: "0.1 hexagonal layout (compatibility)"
description: The simplified ports-and-adapters layout of 0.1 Java services, kept for existing projects - what each layer owns, a worked port-and-adapter example, and how it maps to the mandatory layered structure of new services.
order: 90
keywords: [hexagonal, ports, adapters, domain, dependency direction]
related: [microservices/project-structure, decisions/controller-or-service, spring/postgresql-crud]
---
> [!NOTE]
> This page describes the **0.1 legacy Java structure**, which existing projects retain. New services use the [official layered structure](/architecture/java-microservice) (`application/`, `infrastructure/`, `shared/`); `make:port` and `make:adapter` are legacy generators and are refused in a layered service.

The legacy service uses a **simplified** hexagonal layout: only the directories that have an architectural purpose exist.

| Layer | Directory | Responsibility |
|---|---|---|
| Inbound adapter | `routes/` | HTTP controllers: translate requests to application calls |
| Application | `application/` | use cases and domain services |
| Ports | `ports/` | interfaces the application needs from the outside |
| Outbound adapters | `adapters/`, `persistence/` | implement ports: databases, remote clients, mappers |
| Events | `events/` | domain events and listeners |
| Contracts | `contracts/` | DTOs shared with callers: never domain entities |

Dependencies point inward: controllers call services, services depend on ports, adapters implement ports. Domain models are not shared between services; they exchange DTOs defined by versioned contracts ([Service contracts](/microservices/service-contracts)).

PSO does not enforce import direction at compile time; it enforces **where classes live and what they are called**, which keeps the layering visible in code review.

## A worked example: taking payments

The service must charge a card. The provider is a remote API today and may change.

```bash
pso make:port payment-gateway --service orders       # ports/PaymentGatewayPort.java
pso make:adapter payment-gateway --service orders    # adapters/PaymentGatewayAdapter.java
```

```java
// ports/PaymentGatewayPort.java : what the application needs, in the application's words
public interface PaymentGatewayPort { PaymentResult charge(Money amount, String token); }

// application/OrderService.java : knows only the port
@Service @RequiredArgsConstructor
public class OrderService {
    private final PaymentGatewayPort payments;
    @Transactional public OrderResponse place(OrderRequest r) { /* ... */ payments.charge(total, r.paymentToken()); /* ... */ }
}

// adapters/PaymentGatewayAdapter.java : the remote API lives here, through PsoHttpClient
@Component @RequiredArgsConstructor
class PaymentGatewayAdapter implements PaymentGatewayPort {
    private final PsoHttpClient http;
    public PaymentResult charge(Money amount, String token) { return http.post("payments", "/charges", new ChargeRequest(amount, token), PaymentResult.class); }
}
```

What this buys you: `OrderService` is tested with a fake port and no network; replacing the provider changes one class; the secure-client rules (declared destinations, no redirects) live in one adapter ([Spring HTTP client](/spring/http-client)).

## When not to add a port

| Situation | Do instead |
|---|---|
| one implementation and no boundary (an in-process helper) | a plain `@Service` |
| a Spring Data repository | the repository interface already is the port; inject it into the service |
| the "adapter" would only forward to one method | skip the layer |

Generated services start with controllers, configuration and DTOs only. Add `ports/` and `adapters/` when a boundary appears, not before.

## Testing consequences

| Layer | Test with |
|---|---|
| controller | MockMvc with real JWT validation (the generated tests) |
| service | a unit test with fake ports |
| adapter | a test against a local fake server |
| persistence | the embedded PostgreSQL ([PostgreSQL CRUD](/spring/postgresql-crud)) |

## Common mistakes

- Returning entities from controllers.
- Letting adapters call services (the arrow points the wrong way).
- Interfaces for everything "for testability" when a constructor-injected fake of a concrete class would do.

## Next steps

- [Java project structure](/microservices/project-structure)
- [Controller or service?](/decisions/controller-or-service)
