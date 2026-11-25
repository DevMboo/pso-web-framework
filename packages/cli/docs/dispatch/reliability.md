---
title: Delivery guarantees, retries, dead letters and idempotency
description: What at-least-once means in PSO Dispatch and exactly what the runtime does on success, failure and poison messages.
order: 6
status: implemented
keywords: [at least once, retry, backoff, dead letter, dlq, poison, idempotency, acknowledgement]
related: [dispatch/overview, dispatch/contracts, dispatch/outbox, dispatch/providers]
---
**Guarantee: at-least-once.** A published event is delivered one or more times; handlers must be idempotent. PSO does not claim exactly-once, because a broker and a database cannot be committed atomically.

## What the consumer runtime does

1. Parse and validate the envelope, the version (`version` or `accepts`) and the payload schema.
2. If the event id was already processed by this group, acknowledge and skip (duplicate).
3. Run the handler. On success: record the id in the idempotency store, then **acknowledge** (acknowledgement is always after the handler).
4. On failure: retry in-process with exponential backoff (`retry.max-attempts`, `initial-delay`, `max-delay`, `multiplier`). The message stays unacknowledged during retries.
5. When attempts are exhausted: publish the original bytes to `<channel>.dlq` with headers `x-pso-reason`, `x-pso-attempts`, `x-pso-group`, `x-pso-original-channel`, `x-pso-dead-letter-id`, and only then acknowledge.
6. If publishing to the dead-letter channel fails, the message is **not** acknowledged and the transport redelivers it. With `dead-letter.enabled=false` an exhausted message is dropped and counted.

**Poison messages** (invalid envelope, unsupported version, schema violation) skip retries and go straight to the dead-letter channel. Publishing validates the same rules, so poison only comes from other producers or older contracts.

## Idempotency

The key is `group:eventId`. The store is a stated choice, logged at every start (`dispatch idempotency store`). `dispatch.idempotency.store` is `auto` by default: the provider's own Redis when the provider is `redis`, otherwise this process's memory (`retention` 24h by default). The in-memory store does not survive restarts or span instances: after a restart, or on another instance, a redelivered event runs its handler again (production logs a warning about it). Set `dispatch.idempotency.store: "redis"` with `dispatch.idempotency.redisUrl: "${env:NAME}"` to give RabbitMQ and Kafka consumers the durable, shared store too. For durable, shared deduplication use the Redis store (TypeScript `RedisIdempotencyStore`; Java Redis starter store) or make the handler itself idempotent, for example with a unique constraint. Treat the store as an optimization; correctness belongs in the handler.

### Concurrent consumers: the claim

An event id is **claimed atomically before the handler runs** (one Lua step in Redis; in memory inside one process), so two instances that receive the same event at the same moment do not both run it. The first one takes a lease on `group:eventId`; the others wait for it and then acknowledge the event as a duplicate. The runtime renews the lease while the handler runs and turns it into the completion record afterwards. Both runtimes write the same keys and values, so Node and Java consumers of one group share them.

| Situation | What happens |
|---|---|
| the same event reaches several instances at once | one runs the handler; the others wait, see the completion and acknowledge (`duplicates`) |
| the handler fails (retries exhausted) | the claim is released and the event is dead-lettered; a replay or redelivery is handled, not treated as a duplicate |
| the consumer dies after claiming | nobody renews the lease; after `dispatch.idempotency.lease` (default `30s`; Spring `pso.dispatch.idempotency.lease`) another consumer may claim the event |
| another consumer still holds the claim after one lease period | the delivery is given back to the broker (`contended`) and redelivered |
| the store cannot be reached | the handler does **not** run; the message is given back to the broker and an error is logged. Unreachable never means "not seen" |
| completion cannot be recorded after the handler ran | the message is acknowledged and an error is logged: a later redelivery of that id runs the handler again |
| a renewal finds the lease gone (a consumer cut off from the store for longer than the lease) | the handler keeps running, another consumer may run it too; counted as `leaseLost` and logged |

**The guarantee is at-least-once, not exactly-once.** The claim removes the concurrent-duplicate window while the store is reachable and leases are renewed; it cannot undo an effect outside the store. A handler that charges a card, sends an e-mail or calls another service must carry its own idempotency key (the event id is a good one) or a unique constraint, because a crash between the effect and the completion record, a lost lease, or a redelivery after `retention` runs it again. A custom `IdempotencyStore` that implements only `has`/`add` keeps working, with the earlier non-atomic check.

## Limits you should know

- Retries are in-process: a failing message blocks its consumer slot (and, per partition or stream, the messages behind it) for the duration of the backoff. There is no delayed redelivery.
- If a consumer crashes, the transport redelivers (Redis `XAUTOCLAIM`, RabbitMQ requeue, Kafka uncommitted offset). Duplicates are expected after crashes.
- A delivery that finds another consumer working on the same event id occupies its consumer slot while it waits (at most one lease period).
- Ordering is only per key within a partition or queue (see [Providers](/dispatch/providers)).
- Dead letters are not replayed automatically. Inspect the `.dlq` channel with your broker tooling and republish deliberately.

## The numbers from a real run

A consumer whose handler always fails, with `max-attempts 3`: three `WARN consumer failed ... attempt=N` lines with a growing delay, the original message in `<channel>.dlq` with `x-pso-reason: handler-failed:Error` and `x-pso-attempts: 3`, nothing left pending in the consumer group, and the counters `failed 3, retried 2, deadLettered 2` (the second dead letter was a poison message, counted also as `poison 1`). The full transcript is in the [walkthrough](/dispatch/walkthrough).

## Common mistakes

- Assuming dead letters are replayed: they are not.
- A handler that cannot tolerate a repeat.
- Large `retry.max-attempts` with long delays on an ordered channel: the retried message blocks the ones behind it.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| duplicates | all providers are at-least-once | the handler | make it idempotent; deduplicate on the event `id` |
| messages in `<channel>.dlq` | the retry budget ended | the consumer logs under the message's correlation id | fix the cause, then replay deliberately |
| events lost when a service crashes between saving and publishing | publishing after the database commit is not atomic | the code path | use the transactional outbox ([tutorial](/tutorials/transactional-outbox)) |
| Redis loses entries | trimming (`MAXLEN`) is approximate and persistence is the server's | the server's AOF setting and the stream length | size retention above the slowest consumer; enable AOF or replication |

Provider guarantees as printed by `pso dispatch:providers` are in [Checking Dispatch and what its errors mean](/dispatch/diagnostics).

## Next steps

- [Walkthrough](/dispatch/walkthrough)
- [Outbox](/dispatch/outbox)
