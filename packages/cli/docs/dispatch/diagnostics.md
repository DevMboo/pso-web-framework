---
title: Checking Dispatch and what its errors mean
description: How to prove a broker is reachable, lock event contracts, and read the errors Dispatch gives for Redis Streams, RabbitMQ and Kafka - each one reproduced on a real workspace and real brokers.
order: 12
status: stable
keywords: [dispatch, dispatch:doctor, dispatch:validate, dispatch:lock, redis, rabbitmq, kafka, PSO_DISPATCH_004, PSO_DISPATCH_007, PSO_DISPATCH_SCHEMA_CHANGED, contract lock]
related: [dispatch/overview, dispatch/providers, dispatch/installation, dispatch/reliability, dispatch/walkthrough, dispatch/contracts]
---
Dispatch moves events between services through a broker. Three questions come up before any event flows, and PSO answers each with a command that **does not trust configuration**:

| Question | Command | What it really does |
|---|---|---|
| Is my declaration consistent? | `pso dispatch:validate` | reads sources and schemas; contacts no broker |
| Can I change a contract safely? | `pso dispatch:lock` and then `validate` | records the contract; later changes are compared with it |
| Is the broker there? | `pso dispatch:doctor` | validates, then **connects** to each configured broker |

Everything below was run on a generated workspace with one orchestrator (`gw`), against real brokers (Redis 7, RabbitMQ 3.13 and Kafka 3.8 in local containers). Output is as printed; the broker addresses are the ones of the verification run.

## Install a provider

```bash
pso dispatch:install redis --service gw
```

```text evidence="verified"
package.json: + @pso/dispatch
package.json: + ioredis
pso.config.json: dispatch.provider = redis (enabled stays false; secrets are ${env:...} references)
src/dispatch/: modules go here, each with an EVENTS.pso.ts
infra/dispatch/redis.compose.yml: a local development broker (not started by PSO)
Next: declare your events, then set pso.dispatch.enabled=true (and the broker URL) to activate. See /docs/dispatch/overview.
```

```json title="gw/pso.config.json (written by the command)"
{
  "dispatch": {
    "enabled": false,
    "provider": "redis",
    "redis": { "url": "${env:REDIS_URL}" }
  }
}
```

Dispatch stays **disabled** until you enable it; the broker address is an environment reference, never a literal. `rabbitmq` and `kafka` work the same way (`amqplib` and `kafkajs` are added instead of `ioredis`, and the address comes from `RABBITMQ_URL` or `KAFKA_BOOTSTRAP_SERVERS`). One provider is installed per service at a time: removing one is a command of its own.

```bash
pso dispatch:remove --service gw
```

```text evidence="verified"
package.json: - ioredis (@pso/dispatch stays: declarations still use it)
pso.config.json: dispatch disabled, provider none
```

Your event declarations and handlers are never deleted.

## What each provider guarantees

`pso dispatch:providers` prints the delivery contract of each adapter. Read it before you choose: the guarantees differ, and they are the contract your handlers must be written against.

```bash
pso dispatch:providers
```

```text evidence="verified"
redis
  publish ack: XADD acknowledged by Redis: in memory, durable only if the server persists (AOF) or replicates
  ordering:    per stream (single consumer per group member); not partitioned
  redelivery:  pending entries are reclaimed (XAUTOCLAIM) after pso.dispatch.redis.min-idle
  dead letter: <channel>.dlq stream
  lag:         observable
  note:        Redis Streams, never Pub/Sub. Retention is approximate MAXLEN trimming: size it above your slowest consumer.

rabbitmq
  publish ack: publisher confirm for a persistent message routed to a durable queue
  ordering:    none guaranteed with concurrency > 1
  redelivery:  unacknowledged messages are requeued on connection loss; nack requeues after a pause
  dead letter: <channel>.dlq exchange and queue
  lag:         not available
  note:        Publishing before any consumer group declared its queue is refused (unroutable), never silently dropped.

kafka
  publish ack: acks=all: acknowledged by all in-sync replicas (durability depends on min.insync.replicas)
  ordering:    per partition (events with the same key); never global
  redelivery:  offsets are committed only after processing; a failed message is redelivered from its offset
  dead letter: <channel>.dlq topic
  lag:         observable
  note:        A message being retried blocks later messages of its partition. Redpanda works the same way. Exactly-once processing is NOT provided.
```

All three give **at-least-once** delivery: a handler can receive the same event twice, so handlers must be idempotent ([reliability](/dispatch/reliability)). Choosing between them is a design decision: see [Redis, RabbitMQ or Kafka?](/decisions/redis-rabbitmq-or-kafka).

## Is the broker there? `pso dispatch:doctor`

`dispatch:doctor` has three possible answers, and it never reports a connection it did not make:

| Answer | Meaning |
|---|---|
| `UP` | it connected and the broker answered |
| `DOWN` | it tried and failed (exit code 1) |
| `NOT-CONFIGURED` | dispatch is disabled or the broker address is missing: nothing was attempted |

With nothing set, it says so:

```bash
pso dispatch:doctor
```

```text evidence="verified"
static validation: no findings

NOT-CONFIGURED gw (redis): invalid dispatch configuration:
```

Turn dispatch on and give the address through the environment, then ask again. One run per provider, against its real broker:

```bash
REDIS_URL=redis://127.0.0.1:56379 PSO_DISPATCH_ENABLED=true pso dispatch:doctor
```

```text evidence="verified"
static validation: no findings

UP             gw (redis): PING answered [42 ms]
```

```bash
RABBITMQ_URL=amqp://guest:guest@127.0.0.1:56672 PSO_DISPATCH_ENABLED=true pso dispatch:doctor
```

```text evidence="verified"
static validation: no findings

UP             gw (rabbitmq): connection open [107 ms]
```

```bash
KAFKA_BOOTSTRAP_SERVERS=127.0.0.1:59092 PSO_DISPATCH_ENABLED=true pso dispatch:doctor
```

```text evidence="verified"
static validation: no findings

UP             gw (kafka): metadata request answered [193 ms]
```

Each `UP` line says what was actually proven: `PING answered`, `connection open`, `metadata request answered`. That is **reachability**, not delivery. A broker can be up while a topic, queue or permission is wrong; only publishing and consuming prove that ([walkthrough](/dispatch/walkthrough)).

Now point each at a port where nothing listens:

```text evidence="verified"
DOWN           gw (redis): cannot connect to Redis (Error)
DOWN           gw (rabbitmq): cannot connect to RabbitMQ (Error)
DOWN           gw (kafka): connection timed out after 8 s
```

Kafka takes 8 seconds to give up, the others fail at once: do not set a CI timeout below 10 s for `dispatch:doctor`. All three exit with code 1.

## Declare events, then validate

An event is declared in an `EVENTS.pso.ts`, with a JSON schema file and a consumer class:

```tree title="What the walkthrough below creates (workspace root: lab/)"
lab/
  pso.dispatch.lock.json  # generated: written by pso dispatch:lock at the workspace root, commit it
  gw/src/dispatch/orders/
    EVENTS.pso.ts  # manual: declares the events and lists the consumers
    schemas/order-placed.schema.ts  # manual: the payload contract of orders.placed
    orders.consumer.ts  # manual: the handler of orders.placed
```

```typescript title="gw/src/dispatch/orders/EVENTS.pso.ts"
import { defineEvents } from "@pso/dispatch";
import { OrderPlacedConsumer } from "./orders.consumer";
export default defineEvents({
  events: [
    { name: "orders.placed", version: 1, channel: "orders.events", schema: "schemas/order-placed.schema.ts", publish: false },
  ],
  consumers: [OrderPlacedConsumer],
});
```

```typescript title="gw/src/dispatch/orders/schemas/order-placed.schema.ts"
export default { type: "object", required: ["orderId"], properties: { orderId: { type: "string" } } };
```

```typescript title="gw/src/dispatch/orders/orders.consumer.ts"
import { Dispatch, DispatchConsumer } from "@pso/dispatch";

@DispatchConsumer("orders.placed")
export class OrderPlacedConsumer {
  constructor(private readonly dispatch: Dispatch) {}
  async handle(payload: { orderId: string }) { void payload; }
}
```

`publish: false` means this service consumes the event but does not own it: it never publishes it. Validate:

```bash
pso dispatch:validate
```

```text evidence="verified"
INFO    PSO_DISPATCH_UNLOCKED gw (src/dispatch/orders/EVENTS.pso.ts)
        orders.placed v1 is not locked yet
        fix: Run `pso dispatch:lock` to record its contract
valid. Static validation only: event delivery is verified by running the service against a broker.
```

`INFO` does not fail validation; it tells you the contract is not protected yet. See what PSO understood:

```bash
pso dispatch:events
pso dispatch:consumers
```

```text evidence="verified"
orders.placed@1  channel orders.events  gw consumes  schema yes  consumers: gw
```

```text evidence="verified"
orders.placed                gw  OrderPlacedConsumer  group gw  (src/dispatch/orders/orders.consumer.ts)
```

## Lock the contract

```bash
pso dispatch:lock
pso dispatch:validate
```

```text evidence="verified"
locked: orders.placed@1
```

```text evidence="verified"
no findings
valid. Static validation only: event delivery is verified by running the service against a broker.
```

The lock file records each event version's schema. From now on a change to that schema is compared with the record. This is what protects consumers you do not control: a producer cannot quietly add a required field to a version that is already in the wild.

## What goes wrong, and what you see

### A schema file that does not exist (`PSO_DISPATCH_004`)

```text evidence="verified"
ERROR   PSO_DISPATCH_004 gw (src/dispatch/orders/EVENTS.pso.ts)
        schema file schemas/missing.schema.ts of "orders.placed" does not exist
ERROR   PSO_DISPATCH_SCHEMA_CHANGED gw (src/dispatch/orders/schemas/missing.schema.ts)
        the schema of orders.placed v1 changed after it was locked: published events of that version would no longer match
        fix: Declare version 2 (with a compatible schema or compatibility: "none"), then run `pso dispatch:lock`
2 error(s). Static validation only: event delivery is verified by running the service against a broker.
```

Two errors come from one cause: the locked schema is no longer found. Correct the path.

### A breaking change to a locked version (`PSO_DISPATCH_SCHEMA_CHANGED`)

The schema gained a new required field (`total`) while still declared as version 1:

```text evidence="verified"
ERROR   PSO_DISPATCH_SCHEMA_CHANGED gw (src/dispatch/orders/schemas/order-placed.schema.ts)
        the schema of orders.placed v1 changed after it was locked: published events of that version would no longer match
        fix: Declare version 2 (with a compatible schema or compatibility: "none"), then run `pso dispatch:lock`
1 error(s). Static validation only: event delivery is verified by running the service against a broker.
```

The error names its own fix: a changed contract is a **new version**. Declare `version: 2`, keep serving version 1 while consumers migrate, then lock. See [contracts](/dispatch/contracts) for compatibility modes.

### A consumer of an event nobody declares (`PSO_DISPATCH_007`)

```text evidence="verified"
ERROR   PSO_DISPATCH_007 gw (src/dispatch/orders/orders.consumer.ts)
        consumer OrderPlacedConsumer handles "orders.shipped", which src/dispatch/orders/EVENTS.pso.ts does not declare
1 error(s). Static validation only: event delivery is verified by running the service against a broker.
```

A typo in an event name would otherwise create a consumer that never receives anything and fails silently. Validation turns it into an error.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `NOT-CONFIGURED` from `dispatch:doctor` | dispatch is disabled or the broker variable is unset | `pso dispatch:inspect` shows `disabled`; the environment | set `PSO_DISPATCH_ENABLED=true` and `REDIS_URL`, `RABBITMQ_URL` or `KAFKA_BOOTSTRAP_SERVERS` |
| `DOWN` | nothing answers at that address | the address; a firewall; the container | start the broker; `docker ps` for a local one |
| `UP` but no event arrives | reachability is not delivery: the channel, queue or topic differs, or the consumer group is new | `pso dispatch:events` for the channel; the broker's own tooling | align the channel name on both sides; see the [walkthrough](/dispatch/walkthrough) |
| `PSO_DISPATCH_SCHEMA_CHANGED` | a locked schema changed | `git diff` of the schema file | add a version, then `pso dispatch:lock` |
| `PSO_DISPATCH_007` | the consumer's event name is not declared | the name in `@DispatchConsumer` and in `EVENTS.pso.ts` | make them identical |
| publishing to RabbitMQ before any consumer started is refused | the queue is declared by the consumer group, and an unroutable message is refused, not dropped | the provider's `note` | start (or deploy) a consumer first, or declare the queue ahead |
| a Kafka consumer stops advancing | a failing message blocks its partition while it is retried | the consumer logs and the `<channel>.dlq` topic | fix the handler or let the retry budget end in the dead-letter topic |
| duplicates in your data | at-least-once delivery | whether the handler is idempotent | deduplicate on the event `id` |

## Production considerations

- Make `dispatch:validate` and `dispatch:doctor` part of your pipeline: `validate` before the build (no broker needed), `doctor` after deploy against the real broker.
- Commit `pso.dispatch.lock.json`: it is the memory of what consumers rely on.
- Size retention above your slowest consumer (Redis trims approximately, Kafka and RabbitMQ per their own policies).
- Watch dead-letter channels (`<channel>.dlq`): messages there are failures that need a person.
- Secrets stay `${env:...}` references. `dispatch:inspect` redacts them in its output.

## Common mistakes

- Treating `UP` as proof that events flow.
- Changing a locked schema in place instead of declaring a new version.
- Assuming exactly-once: none of the three providers offers it.
- Publishing from a service that does not own the event (`publish: false` consumers).
- Installing a second provider and expecting both to work in one service.

## Next steps

- [Dispatch walkthrough](/dispatch/walkthrough): publish and consume against real Redis
- [Providers](/dispatch/providers)
- [Contracts](/dispatch/contracts)
- [Reliability](/dispatch/reliability)
