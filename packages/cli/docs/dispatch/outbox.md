---
title: Transactional outbox
description: Store the event in the same database transaction as your data and relay it afterwards (Spring Boot + PostgreSQL).
order: 7
status: partial
keywords: [outbox, transactional outbox, pso_outbox, relay, skip locked, dispatch:outbox]
related: [dispatch/reliability, dispatch/installation, microservices/persistence]
---
> [!STATUS]
> Implemented for **Spring Boot with a JDBC database** and verified against a real PostgreSQL and Redis. There is **no TypeScript outbox**.

Without an outbox, "save the order, then publish `orders.created`" can lose the event if the process dies in between. The outbox closes that gap: the event is inserted into `pso_outbox` through your `JdbcTemplate` inside the same transaction as the business change, and a relay publishes it afterwards.

```bash
pso database:enable postgresql --service orders-service
pso dispatch:install redis --service orders-service
pso dispatch:outbox --service orders-service     # migration V<n>__pso_outbox.sql + pso.dispatch.outbox.enabled=true
```

In a layered service the event is published from the transactional service in `application/service/`, with its payload record
from `application/event/` (`pso make:dispatch-event orders.created --fields "orderId:string"`):

```java title="orders-service/src/main/java/com/pso/orders/application/service/OrderService.java"
package com.pso.orders.application.service;

import com.pso.orders.application.dto.request.CreateOrderRequest;
import com.pso.orders.application.dto.response.OrderResponse;
import com.pso.orders.application.event.OrdersCreatedEvent;
import com.pso.orders.application.mapper.OrderMapper;
import com.pso.orders.infrastructure.persistence.OrderRepository;
import com.pso.spring.autoconfigure.dispatch.Outbox;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository repository;
    private final OrderMapper mapper;
    private final Outbox outbox;

    @Transactional
    public OrderResponse create(CreateOrderRequest request) {
        OrderResponse created = mapper.toResponse(repository.saveAndFlush(mapper.toEntity(request)));
        outbox.publish("orders.created", new OrdersCreatedEvent(created.id().toString()));   // rolls back with the order
        return created;
    }
}
```

The outbox stores events only while Dispatch is enabled (`pso.dispatch.enabled: true`, also in the test profile): otherwise
`Outbox.publish` throws `PSO_DISPATCH_DISABLED` and the transaction is not completed. [The outbox tutorial](/tutorials/transactional-outbox)
does this on a generated CRUD service and runs its tests.

`Outbox.publish` applies the same checks as `PsoDispatch.publish` (declared, publishable, schema, size) at insert time, so an invalid event fails in your transaction, not later.

## Relay behavior

- Rows are read with `FOR UPDATE SKIP LOCKED`, so several instances can run relays at once without sending a row twice concurrently.
- A row is marked published only **after** the broker acknowledged it. A crash between the acknowledgement and the update republishes the row with the **same event id**: still at-least-once, so consumers deduplicate on the id.
- A broker failure records `attempts`, `last_error` (the error class, never a message with credentials) and a backoff; after `max-attempts` the row gets `failed_at` and is left for you to inspect. It is never deleted automatically.
- Published rows older than `retention` are deleted; pending and failed rows are never deleted.

Settings: `pso.dispatch.outbox.{enabled, poll-interval, batch-size, max-attempts, retry-backoff, retention}`. Enabling the outbox without a database, or without dispatch, stops start-up with the command to run.

Services created before 2026-11-14 may contain an `outbox_event` table from an earlier service template; it is unrelated, not used by the relay and no longer generated ([what to do with it](/microservices/persistence)).

## Verify failure recovery

In a test environment, publish an event inside a transaction that you deliberately roll back: neither the business row nor the `pso_outbox` row should remain. Then commit with the broker unavailable. The row should remain pending while relay attempts fail; after broker recovery, the relay can publish it. Observe the event id in the consumer and apply a unique constraint or equivalent idempotent business operation so a repeated publication has no second effect.

If rows accumulate, check `pso.dispatch.enabled`, broker connectivity with `pso dispatch:doctor`, and the outbox attempt and error-class columns. A row marked failed is retained for an operator to investigate; there is no documented automatic replay command. The [step-by-step outbox tutorial](/tutorials/transactional-outbox) follows this recovery path.

## What to look at when it misbehaves

| Symptom | Look at | Resolve |
|---|---|---|
| events are not published after a commit | `pso_outbox` rows: `published_at` is null and `attempts` is growing | restore the broker; the relay retries with backoff and records the error class in `last_error` |
| a row has `failed_at` set | the row reached `pso.dispatch.outbox.max-attempts` | inspect the error; fix the cause; it is kept for you, never deleted automatically |
| the same event arrives twice | a crash between the broker acknowledgement and the row update | consumers deduplicate on the event id (at-least-once) |
| `outbox.publish` throws in your transaction | the event is undeclared, consume-only, violates its schema or is too large | fix the declaration or payload; the transaction rolls back, as intended |
| the table keeps growing | `retention` removes **published** rows only | pending and failed rows stay until handled |

A step-by-step exercise (commit while the broker is down, then restore it) is in [Make an event follow a database commit](/tutorials/transactional-outbox); the decision of whether you need it is [outbox or direct publish?](/decisions/outbox-or-direct-publish).

## Next steps

- [Transactional outbox tutorial](/tutorials/transactional-outbox)
- [Reliability](/dispatch/reliability)
