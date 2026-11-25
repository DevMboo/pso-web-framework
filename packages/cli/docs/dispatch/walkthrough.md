---
title: "Walkthrough: publish, consume, retry, dead-letter"
description: A real run of Dispatch over Redis Streams - install, declare, validate, start, a successful event, a handler that fails three times, a poison message - with the commands, the broker's contents, the logs and the metrics, and what each means.
order: 2
keywords: [dispatch, walkthrough, redis, consumer, retry, dead letter, poison, acknowledgement, metrics, telemetry]
related: [dispatch/overview, dispatch/reliability, dispatch/events-and-consumers, tutorials/event-driven, decisions/redis-rabbitmq-or-kafka]
---
Everything below was captured from one run on a Windows machine against a real Redis 7 container, with a generated orchestrator as the consumer. The consumer reacts to `orders.placed` and publishes `orders.confirmed`. Event ids, channel names (they contain a per-run suffix) and timings belong to that run.

> [!NOTE]
> The orchestrator acts as the consumer here because it is the quickest way to run a real consumer without a Java build. The same envelope, retry and dead-letter behavior applies to Spring services.

## 1. Install and declare

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

Dispatch stays **disabled** until you enable it, and PSO never starts the broker: `infra/dispatch/redis.compose.yml` is a file for you to run (`docker compose -f infra/dispatch/redis.compose.yml up -d`).

The contract and the consumer, in `src/dispatch/orders/`:

```typescript title="EVENTS.pso.ts"
export default defineEvents({
  events: [
    { name: "orders.placed",    version: 1, channel: "orders.demo62984",           schema: "schemas/order-placed.schema.ts", publish: false },
    { name: "orders.confirmed", version: 1, channel: "orders.confirmed.demo62984", key: "orderId" },
  ],
  consumers: [OrderPlacedConsumer],
});
```

```typescript title="orders.consumer.ts"
@DispatchConsumer("orders.placed")
export class OrderPlacedConsumer {
  constructor(private readonly dispatch: Dispatch) {}
  async handle(payload: { orderId: string; fail?: boolean }) {
    if (payload.fail) throw new Error("payment provider unavailable");
    await this.dispatch.publish("orders.confirmed", { orderId: payload.orderId });
  }
}
```

`publish: false` says this service only consumes `orders.placed`; `key` makes events with the same `orderId` ordered together.

## 2. Check what you declared (no broker, no code run)

```text evidence="expected"
$ pso dispatch:validate
INFO    PSO_DISPATCH_UNLOCKED gw (src/dispatch/orders/EVENTS.pso.ts)
        orders.placed v1 is not locked yet
        fix: Run `pso dispatch:lock` to record its contract
...
valid. Static validation only: event delivery is verified by running the service against a broker.

$ pso dispatch:events
orders.placed@1  channel orders.demo62984  gw consumes  schema yes  consumers: gw
orders.confirmed@1  channel orders.confirmed.demo62984  gw publishes  schema none  consumers: -

$ pso dispatch:consumers
orders.placed                gw  OrderPlacedConsumer  group gw  (src/dispatch/orders/orders.consumer.ts)

$ pso dispatch:graph
gw --orders.confirmed--> channel:orders.confirmed.demo62984
channel:orders.demo62984 --orders.placed--> gw
```

The `INFO ... not locked yet` lines are not errors: `pso dispatch:lock` records the contracts so later schema changes are checked for compatibility. Run it once the contracts are agreed.

## 3. Start with Dispatch enabled

The service was started with `PSO_DISPATCH_ENABLED=true`, the broker URL in the environment, and short retry delays so the demo is quick:

```text evidence="expected"
dispatch.retry.maxAttempts = 3, initialDelay = 200ms, maxDelay = 400ms   (defaults: 3, 1s, 30s)
```

## 4. A successful event

Another service publishes `orders.placed` (here written directly to the stream with the canonical envelope). The consumer runs, publishes `orders.confirmed` and the message is acknowledged.

What `orders.confirmed` contains afterwards (the stream entry, decoded):

```json evidence="expected"
{"id":"0ad97c56-f9e6-4959-b7c3-230ba8e740a1","type":"orders.confirmed","source":"gw","correlationId":"6d5c6049-83e9-403f-a6d0-0f8bf41ef200","payload":{"orderId":"o-100"}}
```

> [!NOTE]
> In this run the incoming event carried `correlationId: "corr-evt-ok-1"`, but the event the handler published got a **new** correlation id and no `causationId`. If you need a chain from one event to the next, set those fields yourself when you publish (the TypeScript `publish(type, payload, { correlationId, causationId })` accepts them); do not assume they are copied.

## 5. A handler that fails

A second event asks the handler to fail. The consumer retries in-process with backoff while the message stays **unacknowledged**, then gives up and moves the message to the dead-letter channel. The orchestrator terminal (verified):

```text evidence="verified"
2026-11-08 15:26:07.488 WARN  consumer failed  event=orders.placed id=evt-bad-1 attempt=1 error=Error
2026-11-08 15:26:07.701 WARN  consumer failed  event=orders.placed id=evt-bad-1 attempt=2 error=Error
2026-11-08 15:26:08.102 WARN  consumer failed  event=orders.placed id=evt-bad-1 attempt=3 error=Error
```

Notice the gaps (about 213 ms, then 401 ms): the backoff doubles from `initialDelay` up to `maxDelay`. The log names the event type, the event id and the attempt; the error is the class name, not the message (messages can contain secrets).

## 6. The dead-letter channel

After the third attempt the original bytes were published to `<channel>.dlq` with headers that say why, and only then acknowledged (expected):

```json evidence="expected"
{"envelope":"{\"envelopeVersion\":1,\"id\":\"evt-bad-1\",\"type\":\"orders.placed\", ...","h:x-pso-reason":"handler-failed:Error","h:x-pso-attempts":"3","h:x-pso-group":"gw","h:x-pso-original-channel":"orders.demo62984","h:x-pso-dead-letter-id":"8a0378a8-4798-4469-b1d2-2c02e1b52f55"}
```

## 7. A poison message

A third entry was invalid (its payload does not match the schema). Poison messages are not retried (`attempts` is `0`) and go straight to the dead-letter channel:

```json evidence="expected"
{"envelope":"{...\"id\":\"evt-poison-1\"...","h:x-pso-reason":"PSO_DISPATCH_ENVELOPE_INVALID","h:x-pso-attempts":"0","h:x-pso-group":"gw","h:x-pso-original-channel":"orders.demo62984","h:x-pso-dead-letter-id":"8034eb48-8968-4773-a797-64acdff257a4"}
```

## 8. What the broker and the metrics say afterwards

The consumer group had nothing pending and no lag: every message, including the failed ones, was acknowledged after being handled or dead-lettered (expected):

```text evidence="expected"
name gw  consumers 1  pending 0  last-delivered-id 1794151571002-0  entries-read 3  lag 0
```

The diagnostics endpoint (`/_pso/telemetry`, enabled with `PSO_DIAGNOSTICS_TOKEN`) reports what really happened, and the adapter's own health probe:

```json evidence="expected"
{"metrics":{"published":1,"publishFailed":0,"consumed":1,"failed":3,"retried":2,"deadLettered":2,"dropped":0,"duplicates":0,"poison":1,
 "byType":{"orders.placed":{"published":0,"consumed":1,"failed":3},"orders.confirmed":{"published":1,"consumed":0,"failed":0}}},
 "health":{"status":"up","detail":"PING answered"}}
```

Read it: one event published (`orders.confirmed`), one successfully consumed, three handler failures (the three attempts), two retries, two dead letters (the failing event and the poison one), one poison message.

## What this does not show

- Exactly-once delivery: not provided. A crash between the handler and the acknowledgement redelivers the message (tested separately with a killed consumer process); consumers must be idempotent.
- Replaying dead letters: there is no automatic replay. Inspect the `.dlq` channel with broker tooling and republish deliberately.
- Lag and dead-letter *depth* in Studio: the counters above are exported; depth and lag are not.

## Try it yourself

1. Start Redis (`docker compose -f infra/dispatch/redis.compose.yml up -d`).
2. Declare events as above, `pso dispatch:validate`.
3. Run the orchestrator with `PSO_DISPATCH_ENABLED=true`, `REDIS_URL=redis://127.0.0.1:6379` (your URL, kept in the environment) and a diagnostics token.
4. Add entries with `redis-cli XADD <channel> '*' envelope '<json>'`, watch the terminal, then inspect `<channel>.dlq` and `/_pso/telemetry`.

## Next steps

- [Reliability](/dispatch/reliability)
- [Events and consumers](/dispatch/events-and-consumers)
- [Redis Streams, RabbitMQ or Kafka?](/decisions/redis-rabbitmq-or-kafka)

## Common mistakes

- Reading `published: 1` as "the work is done": it counts accepted publishes.
- Looking for the failed message in the original stream: after exhausted retries it is acknowledged and lives in `<channel>.dlq`.
- Setting a very large `maxAttempts` with long delays on an ordered channel: the retried message holds back the ones behind it.
