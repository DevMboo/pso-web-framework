---
title: Transactional outbox or direct publish?
description: When publishing straight to the broker is enough and when the event must be stored in the same database transaction - the failure it prevents, what it costs, and why the Node orchestrator has no outbox.
order: 34
keywords: [decision, outbox, dispatch, transaction, publish, consistency, at-least-once]
related: [dispatch/outbox, dispatch/reliability, decisions/why-no-typescript-outbox, spring/postgresql-crud, decisions/http-or-dispatch]
---
## The question

Your service saves something and must announce it. Do you call `publish` directly after the save, or write the event into the database in the same transaction and let a relay publish it?

## The failure the outbox prevents

```flow title="The failure the outbox removes"
[1] save order | OK (committed)
[2] publish event | process crashes or broker unreachable -> the order exists, the event never does
```

or the reverse: publish first, then the database transaction fails, and the world is told about an order that does not exist. A broker and a database cannot commit together, so one of them can be ahead of the other.

## The short answer

| | Direct publish | Outbox |
|---|---|---|
| Atomic with your data | no | yes: the event row commits or rolls back with your rows |
| Failure window | between commit and publish; an event can be lost | none for the pair (order, event row); delivery is retried until the broker acknowledges |
| Delivery | at-least-once if you retry; can be at-most-once if you do not | at-least-once (a crash between acknowledgement and mark-published repeats the event with the same id) |
| Latency | immediate | the relay's poll interval (configurable) plus publish time |
| Cost | none | one table, a relay, retention to manage; Spring + JDBC database only |
| Complexity | trivial | small: `pso dispatch:outbox`, `outbox.publish(...)` in a `@Transactional` method |

## Decision flow

1. **Is losing the event acceptable** (a metric, a cache hint, a log of something recoverable)? Direct publish is fine.
2. **Does another system's correctness depend on this event** (billing, inventory, an audit trail)? Outbox.
3. **Is the event produced where there is no database transaction** (the Node orchestrator)? There is no outbox there by design ([why](/decisions/why-no-typescript-outbox)). Emit the event from the Spring service that owns the change.
4. **Can the consumer deduplicate** on the event id? Required either way; the outbox does not make delivery exactly-once.

## With the outbox

```bash
pso database:enable postgresql --service orders
pso dispatch:install redis --service orders
pso dispatch:outbox --service orders
```

```java
@Transactional
public ProductResponse create(ProductRequest request) {
    Product saved = products.save(mapper.toEntity(request));
    outbox.publish("catalog.product-created", Map.of("productId", saved.getId().toString()));  // rolls back with the product
    return mapper.toResponse(saved);
}
```

A broker outage no longer fails the request: rows wait with their attempts and the last error class recorded, and the relay publishes when the broker returns. Rows that exhaust `max-attempts` are marked failed and kept for you to inspect; they are never deleted automatically. The behavior is covered in [the outbox page](/dispatch/outbox).

## Consequences

- **Operate the table.** Monitor pending and failed rows. A growing backlog is your broker or relay telling you something.
- **Eventual, not instant.** Do not build a flow that expects the consumer to have run by the time the HTTP response returns.
- **Idempotent consumers are still mandatory.**

## Anti-patterns

- Publishing inside the transaction directly ("it is in the `@Transactional` method, so it is atomic"): the broker call is not part of the transaction.
- Using the outbox table as a general queue.
- Relying on the outbox to give exactly-once.

## Related

[Transactional outbox](/dispatch/outbox) · [Reliability](/dispatch/reliability) · [PostgreSQL CRUD](/spring/postgresql-crud) · [HTTP or Dispatch](/decisions/http-or-dispatch)
