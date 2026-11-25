---
title: Make an event follow a database commit
description: Add PSO Dispatch and the Spring transactional outbox to a generated layered CRUD service, publish an event in the same transaction as the business change, and handle duplicate delivery safely.
order: 6
status: partial
keywords: [tutorial, outbox, postgresql, transaction, relay, idempotency, application/event, application/service]
related: [dispatch/outbox, dispatch/reliability, tutorials/event-driven, architecture/java-microservice]
---

Suppose an order must be saved and an `orders.created` event published. A direct `save()` followed by `publish()` can lose the
event when the process dies between those calls. The Spring outbox inserts the event in the same database transaction as the order;
a relay publishes committed rows later.

This tutorial starts from a generated layered service (`application/`, `infrastructure/`, `shared/`) with an `Order` CRUD and adds
the outbox to its transactional service. Every command and file below was generated and run with the installed CLI; the service's
generated tests (16) pass with the change, against an embedded PostgreSQL.

## 1. A service with an Order resource

```bash
pso create workspace shop
cd shop
pso create service orders --template empty --db postgres
pso make:crud order --service orders --fields "code:string:unique:length=3-32,total:decimal:precision=12:scale=2:min=0"
```

`make:crud` writes the layered resource: `infrastructure/entity/OrderEntity.java`, `infrastructure/persistence/OrderRepository.java`,
the request and response records in `application/dto/`, the mapper, the transactional `application/service/OrderService.java`, the
controller in `application/rest/` and the migration `V1__create_orders.sql`.

## 2. Dispatch, the outbox and the event

```bash
pso dispatch:install redis --service orders
pso dispatch:outbox --service orders
pso make:dispatch-event orders.created --service orders --fields "orderId:string" --key orderId
pso dispatch:validate
```

```text evidence="expected"
src/main/resources/db/migration/V2__pso_outbox.sql: the pso_outbox table
application.yml: pso.dispatch.outbox.enabled = true
updated    src/main/resources/dispatch/orders.events.json
created    src/main/java/com/pso/orders/application/event/OrdersCreatedEvent.java
```

`dispatch:install` adds the Redis starter (and an in-process adapter for the service's tests); `dispatch:outbox` adds the next Flyway
migration with the `pso_outbox` table and enables the relay; `make:dispatch-event` declares `orders.created` in
`src/main/resources/dispatch/orders.events.json` and writes its payload record in the layered package `application/event/`.

## 3. Write atomically

Change the generated service: inject the starter's `Outbox` and store the event in the transaction that creates the order.

```java title="orders/src/main/java/com/pso/orders/application/service/OrderService.java"
package com.pso.orders.application.service;

import com.pso.orders.application.dto.request.CreateOrderRequest;
import com.pso.orders.application.dto.response.OrderResponse;
import com.pso.orders.application.event.OrdersCreatedEvent;
import com.pso.orders.application.mapper.OrderMapper;
import com.pso.orders.infrastructure.entity.OrderEntity;
import com.pso.orders.infrastructure.persistence.OrderRepository;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
...
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository repository;
    private final OrderMapper mapper;
    private final Outbox outbox;

    @Transactional
    public OrderResponse create(CreateOrderRequest request) {
        if (repository.existsByCode(request.code().strip())) {
            throw duplicateCode();
        }
        OrderEntity entity = mapper.toEntity(request);
        OrderResponse created = mapper.toResponse(saveAndFlush(entity));
        outbox.publish("orders.created", new OrdersCreatedEvent(created.id().toString()));   // an INSERT into pso_outbox, in this transaction
        return created;
    }
    ...
}
```

If the schema check of the event or the database insert fails, the whole transaction rolls back: neither the order nor the event is
kept. `Outbox.publish` applies the same checks as `PsoDispatch.publish` (declared, publishable, schema, size) at insert time. The
event is not sent here; the relay sends committed rows.

## 4. Enable Dispatch where the outbox runs

The outbox stores events only while Dispatch is enabled. With `pso.dispatch.enabled: false` (the generated default) `Outbox.publish`
throws `PSO_DISPATCH_DISABLED` and the transaction is not completed: the order is not created either. Enable it for the service's
tests, which use the in-process adapter and need no broker:

```yaml title="orders/src/main/resources/application-test.yml"
pso:
  dispatch:
    enabled: true      # the outbox stores events only while Dispatch is enabled; the memory provider needs no broker
    provider: memory   # tests publish and consume in process (com.pso:pso-dispatch-test): no broker is needed
```

```bash
cd orders
./mvnw test
```

`Tests run: 16, Failures: 0, Errors: 0` in the run made for this page. For a running environment set `PSO_DISPATCH_ENABLED=true`
and the broker URL in the service's environment (an environment managed by `pso infra:init` and `pso docker:up` generates the
service's environment into `.infra/`).

## How the relay behaves

The relay claims rows with `FOR UPDATE SKIP LOCKED` and marks one published after broker acknowledgement. A crash between broker
acknowledgement and the row update can publish the **same event id** again. Consumers must therefore remain idempotent, even with
the outbox. On broker outage, inspect `attempts`, `last_error` and `failed_at`; failed rows remain for investigation. Published rows
are eventually removed according to retention. These behaviours (commit and rollback atomicity, relay, broker failure and recovery,
maximum attempts, concurrent relays, retention) are covered by the framework's tests against a real PostgreSQL and Redis; the page
[Transactional outbox](/dispatch/outbox) lists them.

> [!STATUS]
> This outbox is implemented for Spring Boot with JDBC. There is no TypeScript outbox, and delivery remains at least once. See
> [outbox limits](/dispatch/outbox).

## Check it yourself

```sql
SELECT id, attempts, published_at IS NOT NULL AS published, failed_at IS NOT NULL AS failed, left(coalesce(last_error, ''), 40) AS last_error FROM pso_outbox ORDER BY created_at;
```

The columns come from the generated migration: `id`, `created_at`, `attempts`, `next_attempt_at`, `last_error`, `published_at`,
`failed_at` (plus the event's own columns). Expected behaviour, not captured in a transcript: a freshly committed row has
`attempts = 0`, `published = false`; after the relay runs, `published = true`. With the broker down the row stays unpublished and
`attempts` grows with the error class in `last_error`; after `max-attempts` the row gets `failed_at` and stays for you to inspect.

## Exercise failure recovery

In a non-production environment, create an order while the broker is unavailable: the order and the outbox row remain. Restore the
broker, then verify the relay publishes the row and the consumer (`pso make:dispatch-handler orders.created` in the consuming service,
written to its `application/event/`) handles it once in business terms. Also make the transaction fail after `publish` and verify it
leaves neither order nor outbox row.

## Variations and decisions

| Question | Answer |
|---|---|
| must the event be atomic with my data? | yes: outbox. no: direct publish with `PsoDispatch` is simpler ([decision](/decisions/outbox-or-direct-publish)) |
| the orchestrator needs this | it has no outbox by design ([why](/decisions/why-no-typescript-outbox)): emit the event from the owning Spring service |
| duplicates | possible after a crash between acknowledgement and marking published; consumers deduplicate on the event id |
| a service created before 0.2 (0.1 layout) | the same commands work; its classes live in `application/` and `events/` ([compatibility](/architecture/structure-migration)) |

## Common mistakes

- Calling `publish` on the broker client directly inside the transaction.
- Leaving `pso.dispatch.enabled` false where the outbox runs: every create fails with `PSO_DISPATCH_DISABLED`.
- Expecting the consumer to have run when the HTTP response returns.
- Deleting failed rows to "clean up" before understanding the error.
