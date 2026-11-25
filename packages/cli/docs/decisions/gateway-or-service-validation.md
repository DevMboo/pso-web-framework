---
title: Validate in the gateway or in the service?
description: Where input validation should live when a request crosses the orchestrator and a Spring service - what each layer is responsible for, what it costs to duplicate, and a decision flow.
order: 31
keywords: [decision, validation, gateway, spring, jakarta, dto, authoritative]
related: [orchestrator/dto-validation, spring/postgresql-crud, reference/error-standard, decisions/controller-or-service]
---
## The question

A request goes through the orchestrator to a Spring service. The body must be valid. Who checks it?

## The short answer

**The service is always the authority for its own data.** The gateway may validate too, for different reasons. Gateway validation never replaces the service's.

| | Gateway (`@Body(Dto)`) | Spring service (Jakarta Validation) |
|---|---|---|
| Purpose | refuse obviously wrong input early and consistently; protect the gateway's own logic | guarantee that stored and processed data is valid, whoever calls |
| Who can bypass it | anyone who reaches the service directly (another service, a job, a mistake in network rules) | nobody: it is the last check before the data is used |
| Implementation | declarative PSO decorators (`@Dto`, `@Required`, `@Email`, ...) | Bean Validation annotations (`@NotBlank`, `@Size`, `@Email`), activated by `@Valid` |
| Error | `400 application/problem+json`, code `PSO_VALIDATION_FAILED`, `errors: [{field, message}]` | the same shape and code from PSO's problem advice |

The two are different implementations; messages differ in wording, and Jakarta's built-in messages follow the JVM's language (a Portuguese JVM answers `deve ser maior que 0`), so clients should rely on `field` and `code`, not on message text. The observable contract (status, code, field list, correlation id) is the same, on purpose.

## Decision flow

1. **Does the gateway action only forward the body to a service?** Keep `@Body()`/the raw forward. The body must reach the service untouched, and the service validates. Adding a DTO in the gateway would duplicate rules that can drift.
2. **Does the gateway handle the request itself** (composes, aggregates, answers alone)? Use `@Body(Dto)`: the gateway owns that input.
3. **Is there a rule that needs data** (uniqueness, existence)? It belongs in the service that owns the data (or a gateway [business validator](/orchestrator/dto-validation) if the gateway really owns the check). A gateway should not query another service just to validate a field when the service will do it anyway.
4. **Is the cost of a bad request high?** (expensive upstream call, paid API, long-running work). Validate early at the gateway **and** in the service.

## What duplication costs

- **Drift.** Two sets of rules disagree over time: the gateway accepts `quantity: 0`, the service rejects it. The client sees a `400` from the service with different wording than the gateway would have used. Mitigate by keeping gateway rules to the *shape* and basic limits, and leave business rules in the service.
- **Maintenance.** Two places to change. The contract files (`*.contract.json`) are the shared description; change them first.
- **Latency.** Negligible: validation is in-process.

## What skipping the gateway check costs

- Obviously malformed requests (wrong types, missing fields) travel to the service before being refused. Under attack, that is extra internal traffic. [Rate limiting](/security/rate-limiting) and body-size limits at the gateway still apply either way.

## Examples

| Situation | Choice |
|---|---|
| `POST /products` forwarded to `catalog` | forward as is; Jakarta Validation in `catalog` (run end to end in [Build a CRUD API](/tutorials/crud-api)) |
| `POST /orders` where the gateway computes totals from several services and answers | `@Body(CreateOrderDto)` in the gateway; each upstream still validates what it receives |
| `GET /products?page=` | `@Query("page", { type: "integer", min: 1 })` at the gateway is cheap and prevents junk reaching the service; the service still bounds page size |
| uniqueness of a SKU | the service (its database constraint is the final authority) |

## Anti-patterns

- Treating a passing gateway check as proof of validity inside the service.
- Disabling the service's validation "because the gateway does it".
- Writing different rules in the two places for the same field.

## Related

[Validate request bodies](/orchestrator/dto-validation) · [PostgreSQL CRUD](/spring/postgresql-crud) · [Error standard](/reference/error-standard)
