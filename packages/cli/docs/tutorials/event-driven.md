---
title: Publish and consume an event
description: Publish an event from an orchestrator action, consume it with a registered consumer over Redis Streams, and watch acknowledgement, retry and dead-lettering happen - with a failing handler on purpose.
order: 5
keywords: [tutorial, dispatch, producer, consumer, redis, retry, dead letter, acknowledgement]
related: [dispatch/events-and-consumers, dispatch/contracts, dispatch/installation, dispatch/reliability, dispatch/walkthrough, dispatch/diagnostics]
---

Use Dispatch when the publisher can finish its request before another service completes its work. A broker acknowledgement means the event was accepted by the transport; it does not mean a consumer completed its handler. Use synchronous HTTP when the caller needs the answer ([HTTP or Dispatch?](/decisions/http-or-dispatch)).

This tutorial builds one small flow in an orchestrator: `POST /orders` **publishes** `orders.placed`, a **consumer** handles it and publishes `orders.confirmed`. Then it makes the handler fail to show retries and the dead-letter channel. It was run end to end against a real Redis 7 (`docs-event-driven.test.ts`); the output marked *Verified* comes from that run. The orchestrator is both producer and consumer here because it is the quickest real consumer; a Spring service uses the same envelope and rules (see the end).

## Prerequisites

Node 24 or newer, Docker (for Redis) and the `pso` CLI. The tutorial runs the orchestrator alone, as a local process, so that the
broker is the only moving part; an application started with `pso infra:init` and `pso docker:up` ([Build your first
application](/tutorials/first-application)) adds Dispatch with the same commands and files.

```bash
pso create workspace lab
cd lab
pso create orchestrator gw --template empty
pso idp:dev init --issuer https://shop.local --audience shop-api
```

`create orchestrator` writes the official modular structure (`src/.app/`, `src/modules/`, `src/shared/`); `--template empty` leaves out
the Product CRUD. `idp:dev init` is the development identity provider: it generates a signing key on this machine
(`idp/keys/<kid>.private.pem`, git-ignored) and its public key, and `pso idp:dev token` signs development tokens with it. It is
refused in production.

## 1. Install the provider

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

Dispatch stays **disabled** until you enable it, and PSO never starts the broker. Run `npm install` in `gw/` to fetch the two new dependencies.

## 2. The producer: an action that publishes

A module, a controller and a guarded route, with the generators that keep the three consistent ([routes](/orchestrator/routes)):

```bash
pso make:module orders --service gw
pso make:controller orders --service gw
pso make:route orders place --method POST --path / --guard jwt --scopes orders:write --service gw
```

Replace the generated action body so it publishes. `Dispatch` is built in like `Upstream`: inject it by constructor type, without listing it in `providers`.

```typescript title="gw/src/modules/orders/controllers/orders.controller.ts"
import { Controller, RestController, Post, Body, HttpError } from "@pso/http";
import { Dispatch } from "@pso/dispatch";

@Controller()
@RestController("/orders")
export class OrdersController {
  constructor(private readonly dispatch: Dispatch) {}

  @Post("/")
  async place(@Body() body: { orderId?: string; fail?: boolean }) {
    if (typeof body?.orderId !== "string" || body.orderId === "") throw new HttpError(400, "orderId is required");
    const result = await this.dispatch.publish("orders.placed", { orderId: body.orderId, ...(body.fail === true ? { fail: true } : {}) });
    return { accepted: true, eventId: result.id };
  }
}
```

`publish` resolves when Redis acknowledged the write (`XADD`). The action answers as soon as that happens; it never waits for the consumer.

## 3. The contract and the consumer

Dispatch declarations live in `src/dispatch/<module>/` of the orchestrator, next to `.app/` and `modules/`: this is where
`pso make:dispatch-event` and `make:dispatch-handler` write. Create `gw/src/dispatch/orders/` with three files. The contract declares both events; the schema is the payload contract of `orders.placed`; the consumer is registered in `consumers`, and a class that is not listed there is never started (`PSO_DISPATCH_008`).

```tree title="What you add under gw/src/dispatch/"
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
    { name: "orders.placed", version: 1, channel: "orders.placed", schema: "schemas/order-placed.schema.ts", key: "orderId" },
    { name: "orders.confirmed", version: 1, channel: "orders.confirmed", key: "orderId" },
  ],
  consumers: [OrderPlacedConsumer],
});
```

```typescript title="gw/src/dispatch/orders/schemas/order-placed.schema.ts"
export default { type: "object", required: ["orderId"], properties: { orderId: { type: "string" }, fail: { type: "boolean" } } };
```

```typescript title="gw/src/dispatch/orders/orders.consumer.ts"
import { Dispatch, DispatchConsumer } from "@pso/dispatch";

@DispatchConsumer("orders.placed")
export class OrderPlacedConsumer {
  constructor(private readonly dispatch: Dispatch) {}

  async handle(payload: { orderId: string; fail?: boolean }) {
    if (payload.fail) throw new Error("payment provider unavailable");
    await this.dispatch.publish("orders.confirmed", { orderId: payload.orderId });
  }
}
```

`key: "orderId"` keeps events of one order together (ordering is per stream and the key identifies the entity). The `fail` flag exists only so that you can make the handler fail on demand.

## 4. Validate and lock the contract

```bash
pso dispatch:validate
pso dispatch:lock
pso validate
```

```text evidence="verified"
INFO    PSO_DISPATCH_UNLOCKED gw (src/dispatch/orders/EVENTS.pso.ts)
        orders.placed v1 is not locked yet
        fix: Run `pso dispatch:lock` to record its contract
```

The first command prints that `INFO` line (it does not fail validation) followed by `valid. Static validation only: event delivery is verified by running the service against a broker.` The lock records the contract in `pso.dispatch.lock.json`; commit it, because from now on a changed schema under the same name and version is rejected ([checking Dispatch](/dispatch/diagnostics)).

## 5. Start Redis and the orchestrator

```bash
docker compose -f infra/dispatch/redis.compose.yml up -d
```

Add to `gw/.env` (the key file name is the one `pso idp:dev init` printed):

```ini title="gw/.env"
PSO_JWT_ISSUER=https://shop.local
PSO_JWT_AUDIENCE=shop-api
PSO_JWT_PUBLIC_KEY_FILE=../idp/keys/<kid>.public.pem
PSO_JWT_ALGORITHMS=ES256
PSO_WORKSPACE=../pso.workspace.json
PSO_DISPATCH_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379
```

```bash
cd gw
npm run dev
```

Check the connection without starting anything else: `pso dispatch:doctor` answers `UP` when Redis answers ([what the answers mean](/dispatch/diagnostics)).

## 6. Publish an event

```bash
TOKEN=$(pso idp:dev token --scopes orders:write --audience shop-api)
curl -i -X POST http://127.0.0.1:3000/orders -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"orderId":"o-100"}'
```

```json evidence="verified"
{"accepted":true,"eventId":"c6568cf7-2d50-41ab-89e5-dc3d70f1b664"}
```

The status is `201` and the body carries the id of the published event (yours differs). What happened, in order:

1. the orchestrator verified the token and the `orders:write` scope, and ran `place`;
2. `Dispatch.publish` wrote the event, wrapped in the standard envelope, to the Redis stream `orders.placed`;
3. the consumer group `gw` read it, called `handle`, which published `orders.confirmed`;
4. only then the message was **acknowledged**.

Look at what the consumer produced:

```bash
docker compose -f infra/dispatch/redis.compose.yml exec redis redis-cli XRANGE orders.confirmed - +
```

```json evidence="verified"
{"envelopeVersion":1,"id":"b77e95fe-b89d-44e2-ba95-829fb883ec31","type":"orders.confirmed","version":1,"source":"gw","occurredAt":"2026-11-25T05:18:33.326Z","correlationId":"b42a1458-c146-4841-a57b-b91c50a107e6","contentType":"application/json","payload":{"orderId":"o-100"}}
```

This is the value of the `envelope` field of the stream entry. And the consumer group has nothing left to do:

```bash
docker compose -f infra/dispatch/redis.compose.yml exec redis redis-cli XINFO GROUPS orders.placed
```

```json evidence="verified"
{"name":"gw","consumers":1,"pending":0,"last-delivered-id":"1795583913322-0","entries-read":1,"lag":0}
```

(Shown as JSON for readability; `redis-cli` prints the same pairs as a list.) `pending 0` and `lag 0` mean the message was acknowledged: the consumer finished before the broker was told so.

An invalid request never reaches the broker: `{}` answers `400` (`orderId is required`) and the stream `orders.placed` still has one entry (verified by the test).

## 7. Make the handler fail

```bash
curl -s -X POST http://127.0.0.1:3000/orders -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"orderId":"o-fail","fail":true}'
```

The publish succeeds (`201`) because publishing and handling are independent. The orchestrator terminal shows the handler failing and being retried in-process while the message stays **unacknowledged**:

```text evidence="verified"
2026-11-25 05:18:34.846 WARN  consumer failed  event=orders.placed id=fcbc689d-1641-4e38-ab23-a25d2b7dde1f attempt=1 error=Error
2026-11-25 05:18:35.059 WARN  consumer failed  event=orders.placed id=fcbc689d-1641-4e38-ab23-a25d2b7dde1f attempt=2 error=Error
2026-11-25 05:18:35.466 WARN  consumer failed  event=orders.placed id=fcbc689d-1641-4e38-ab23-a25d2b7dde1f attempt=3 error=Error
```

(The run used `PSO_CFG_dispatch__retry__initialDelay=200ms` and `maxDelay=400ms` to keep the gaps short; the defaults are 3 attempts, 1 s initial delay, 30 s maximum.) The log names the event type, the id and the attempt; the error is the class, not the message, because messages can contain secrets.

After the third attempt the original message is moved to `orders.placed.dlq`, with headers that say why, and only then acknowledged:

```bash
docker compose -f infra/dispatch/redis.compose.yml exec redis redis-cli XRANGE orders.placed.dlq - +
```

The entry's fields include `h:x-pso-reason` = `handler-failed:Error` and `h:x-pso-attempts` = `3` (verified). `orders.confirmed` still has one entry: a failed handler publishes nothing.

## What you should take from it

| Question | Answer, from the run above |
|---|---|
| when does `publish` resolve? | when Redis accepted the write, not when the consumer finished |
| when is a message acknowledged? | after the handler succeeded, or after it was moved to the dead-letter channel |
| what if the handler keeps failing? | retries with backoff, then `<channel>.dlq`; nothing is lost and nothing is replayed automatically |
| what if the process dies mid-handler? | the message is not acknowledged and is delivered again: delivery is **at least once**, so make handlers idempotent (store the event id, or enforce a unique business key) |
| what does `pso dispatch:validate` prove? | the declarations are consistent; it does not touch the broker |

## In a Spring service

A Spring service declares the same events in `src/main/resources/dispatch/<service>.events.json` and generates its classes in the
layered package `application/event/`:

```bash
pso dispatch:install redis --service orders
pso make:dispatch-event orders.placed --service orders --fields "orderId:string,total:number" --key orderId
pso make:dispatch-handler orders.placed --service orders
pso dispatch:validate
```

```text evidence="expected"
created    src/main/resources/dispatch/orders.events.json
created    src/main/java/com/pso/orders/application/event/OrdersPlacedEvent.java
created    src/main/java/com/pso/orders/application/event/OrdersPlacedHandler.java
```

The record `OrdersPlacedEvent` (package `com.pso.orders.application.event`) is the payload; `OrdersPlacedHandler` has an
`@PsoEventHandler("orders.placed")` method that receives it with a `ConsumeContext`; an `application/service/` class publishes it with
the injected `PsoDispatch`. These generators were run with the installed CLI (the service validates and compiles); the broker
delivery shown above was run with the orchestrator only. See [Events and consumers](/dispatch/events-and-consumers) and
[Dispatch and Spring](/spring/dispatch). To avoid losing an event between a database commit and the publish, use the
[transactional outbox](/tutorials/transactional-outbox).

## Variations

| You want | Do |
|---|---|
| another broker | `pso dispatch:remove --service gw`, then `pso dispatch:install rabbitmq` or `kafka` ([choosing](/decisions/redis-rabbitmq-or-kafka)); only connectivity was checked for those two |
| durable deduplication | the Redis idempotency store, or a unique constraint in your handler |
| to see the full set of counters and the poison-message case | [the walkthrough](/dispatch/walkthrough) |

## Common mistakes

- Assuming a successful publish means the work was done.
- No monitoring of `.dlq` channels.
- A handler with side effects that is not idempotent.
- Forgetting to list the consumer in `consumers`: it is never started.
