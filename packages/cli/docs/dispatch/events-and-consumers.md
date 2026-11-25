---
title: Declaring, publishing and consuming events
description: EVENTS.pso.ts and @DispatchConsumer in TypeScript, dispatch/*.events.json and @PsoEventHandler in Java.
order: 3
status: implemented
keywords: [defineEvents, EVENTS.pso.ts, DispatchConsumer, PsoEventHandler, PsoDispatch, publish, consume]
related: [dispatch/contracts, dispatch/providers, dispatch/reliability, orchestrator/module]
---
Nothing is inferred and nothing is discovered by running your code: events and consumers are declared, and `pso dispatch:validate` reads the declarations statically.

## TypeScript (orchestrator)

Each module that uses events has an `EVENTS.pso.ts`. It lists the events and the consumer classes that are active:

```ts title="src/dispatch/users/EVENTS.pso.ts"
import { defineEvents } from "@pso/dispatch";
import { UserCreatedConsumer } from "./users.consumer";

export default defineEvents({
  events: [{ name: "users.created", version: 1, channel: "users.events", key: "userId", schema: "schemas/user-created.schema.ts" }],
  consumers: [UserCreatedConsumer],
});
```

```ts title="src/dispatch/users/users.consumer.ts"
import { DispatchConsumer, type ConsumeContext } from "@pso/dispatch";

@DispatchConsumer("users.created", { group: "billing" })
export class UserCreatedConsumer {
  async handle(payload: { userId: string }, ctx: ConsumeContext): Promise<void> {
    // idempotent work; ctx.attempt is 1 on the first try
  }
}
```

A decorated class that is not listed in `consumers` is never registered; `pso dispatch:validate` reports it (`PSO_DISPATCH_008`). Publish through the injected abstract `Dispatch`:

`Dispatch` is built in like `Upstream`: inject it by constructor type in any provider or controller of the module, without listing it in `providers`.

```ts
import { Dispatch } from "@pso/dispatch";

export class UsersService {
  constructor(private readonly dispatch: Dispatch) {}
  async create(userId: string) {
    await this.dispatch.publish("users.created", { userId }, { correlationId: "…" });
  }
}
```

`publish` resolves when the provider acknowledged the event; the result states what that acknowledgement means for the provider. It never means "consumed". With dispatch disabled, `Dispatch.publish` fails with `PSO_DISPATCH_DISABLED`.

## Java (Spring Boot)

Declarations are JSON files on the classpath, `src/main/resources/dispatch/*.events.json`:

```json
{ "events": [ { "name": "users.created", "version": 1, "channel": "users.events", "key": "userId", "compatibility": "full",
                "schema": { "type": "object", "required": ["userId"], "properties": { "userId": { "type": "string" } } } } ] }
```

```java
@Component
class UserHandlers {
    record UserCreated(String userId) {}

    @PsoEventHandler("users.created")
    void on(UserCreated event, ConsumeContext ctx) { /* idempotent work */ }
}

@Service
class Users {
    private final PsoDispatch dispatch;
    Users(PsoDispatch dispatch) { this.dispatch = dispatch; }
    void create(String id) { dispatch.publish("users.created", java.util.Map.of("userId", id)); }
}
```

A service that only consumes an event sets `"publish": false` on it; publishing it then fails with `PSO_DISPATCH_NOT_PUBLISHER`. Several services may consume the same channel in separate groups (the group defaults to the service name); a message whose type belongs to another consumer on the same channel is acknowledged and skipped.

## Generators, and the difference between a local event and a Dispatch event

Two mechanisms carry the word "event". They are not interchangeable and each has its own generators:

| | Local application event | PSO Dispatch event |
|---|---|---|
| Reach | the same process | every service that declares it, through the broker |
| Delivery | synchronous, in the publisher's thread; lost with the process | at least once; retries and dead letters |
| Contract | a Java class | a versioned declaration with a schema, checked by `pso dispatch:validate` |
| Generators | `pso make:event`, `pso make:listener` (Spring) | `pso make:dispatch-event`, `pso make:dispatch-handler` (Spring and orchestrator) |
| API | `ApplicationEventPublisher`, `@EventListener` | `PsoDispatch` / `Dispatch`, `@PsoEventHandler` / `@DispatchConsumer` |

```bash
pso dispatch:install redis --service orders
pso make:dispatch-event orders.placed --service orders --fields "orderId:string,customerId:string,total:number" --key orderId
pso make:dispatch-event orders.placed --service billing --consume-only --fields "orderId:string,customerId:string,total:number"
pso make:dispatch-handler orders.placed --service billing
pso dispatch:validate
```

In a layered service the payload record and the handler are written to `application/event/` (package `<base>.application.event`);
in a service with the 0.1 layout they go to `events/`.

The publisher gets the declaration and the payload record; a consumer declares the same event with `--consume-only` (`"publish": false`) and gets a handler:

```java title="orders: src/main/java/com/pso/orders/application/event/OrdersPlacedEvent.java (generated)"
package com.pso.orders.application.event;

public record OrdersPlacedEvent(String orderId, String customerId, double total) {
}
```

```java title="billing: src/main/java/com/pso/billing/application/event/OrdersPlacedHandler.java (generated)"
package com.pso.billing.application.event;

import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import org.springframework.stereotype.Component;

@Component
public class OrdersPlacedHandler {

    @PsoEventHandler("orders.placed")
    public void on(OrdersPlacedEvent event, ConsumeContext ctx) {
        // idempotent work; ctx.attempt() is 1 on the first try
    }
}
```

```java title="orders: publishing (your code)"
package com.pso.orders.application.service;

import com.pso.dispatch.PsoDispatch;
import com.pso.orders.application.event.OrdersPlacedEvent;
import org.springframework.stereotype.Service;

@Service
public class OrderEvents {

    private final PsoDispatch dispatch;

    public OrderEvents(PsoDispatch dispatch) {
        this.dispatch = dispatch;
    }

    public void placed(String orderId, String customerId, double total) {
        dispatch.publish("orders.placed", new OrdersPlacedEvent(orderId, customerId, total));
    }
}
```

In the orchestrator the same two commands write `src/dispatch/<module>/EVENTS.pso.ts`, the schema under `schemas/` and a `@DispatchConsumer` class listed in `consumers`. A published version is never edited: declare the next `--version`. Inside a transaction that also changes data, publish through the transactional outbox ([Outbox](/dispatch/outbox)).

A local event, for comparison (it never leaves the service):

```bash
pso make:event order-placed --service orders
pso make:listener order-placed --service orders
```

## Rules

- Declare the event first; publishing an undeclared type fails.
- Channel names and event names are validated (lower-case, dotted or dashed).
- Handlers must be idempotent: delivery is at-least-once ([Reliability](/dispatch/reliability)).
- Do not construct broker clients in application code; use the API above.

## What it looks like when it runs

A real consumer, its retries, the dead-letter entry and the counters are in the [walkthrough](/dispatch/walkthrough). The static views of the same declarations (expected):

```text evidence="expected"
$ pso dispatch:consumers
orders.placed                gw  OrderPlacedConsumer  group gw  (src/dispatch/orders/orders.consumer.ts)

$ pso dispatch:events
orders.placed@1  channel orders.demo62984  gw consumes  schema yes  consumers: gw
orders.confirmed@1  channel orders.confirmed.demo62984  gw publishes  schema none  consumers: -
```

## Variations

| You want | Do |
|---|---|
| a consumer that republishes | inject `Dispatch` in the consumer constructor and call `publish` ([walkthrough](/dispatch/walkthrough)) |
| ordered processing per entity | declare `key` on the event (for example `orderId`) |
| a consume-only event | `publish: false` on its declaration |
| to chain correlation | pass `{ correlationId, causationId }` to `publish`; they are not copied automatically |

## Common mistakes

- A handler that is not idempotent.
- Letting a failing handler retry forever: set `retry.max-attempts` and watch the dead letters.
- Publishing an event this service declared `publish: false` (`PSO_DISPATCH_NOT_PUBLISHER`).
- Publishing an undeclared type (`PSO_DISPATCH_UNKNOWN_EVENT`).

## Next steps

- [Reliability](/dispatch/reliability)
- [Contracts](/dispatch/contracts)
