---
title: Redis Streams, RabbitMQ or Kafka?
description: How to choose a Dispatch provider - ordering, retention, operations, throughput, replay and what each adapter in PSO actually guarantees - and how to migrate if you chose wrong.
order: 33
keywords: [decision, redis, rabbitmq, kafka, redpanda, broker, provider, ordering, retention]
related: [dispatch/providers, dispatch/reliability, dispatch/local-and-production, decisions/http-or-dispatch]
---
## The question

A service uses exactly one Dispatch provider. Which?

## What PSO gives you on all three

The same envelope, event contracts, idempotency, retry with backoff, dead-letter channel and acknowledgement-after-handler. Application code never mentions a broker. What differs is the transport underneath ([provider table](/dispatch/providers)).

## How they differ

| | Redis Streams | RabbitMQ | Kafka / Redpanda |
|---|---|---|---|
| Model | an append-only stream per channel; consumer groups | exchange plus a durable queue per consumer group | a replicated log (topic) with partitions |
| Retention | by length (`MAXLEN ~`, default 100000 entries); not a long-term log | until consumed; queues are durable | by time/size; **replayable**: consumers can re-read |
| Ordering | one stream: in order; per key where you shard | per queue | per key within a partition |
| Replay old events | limited to what is still in the stream | no (consumed is gone) | yes, by moving the offset |
| Scale model | vertical, simple | competing consumers, flexible routing | horizontal by partitions; highest throughput |
| Operations | tiny; you probably run Redis already | moderate; clustering needs care | heaviest (brokers, controllers, partitions, retention tuning) |
| Durability caveat | depends on the server's persistence (AOF/replicas); `XADD` is acknowledged from memory unless persistence is configured | persistent messages with publisher confirms | `acks=all` with an idempotent producer; set replication factor above 1 in production |
| PSO publish refusal | none | publishing to a channel with no bound queue is refused (create the consumer first) | none |

## Decision flow

1. **Do you already run one of them reliably?** That is a strong default: operating a new broker is a real cost.
2. **Do you need to replay history** (rebuild a read model, add a consumer that must see old events)? Kafka.
3. **Do you need rich routing or per-message TTL/priority features outside PSO's scope?** RabbitMQ (note PSO uses a topic exchange and a queue per group; other broker features are not exposed).
4. **Is the event volume modest and the team small?** Redis Streams is the simplest thing that satisfies at-least-once with groups.
5. **Is throughput in the many thousands per second per topic, with ordered partitions?** Kafka.

## Consequences by choice

- **Redis Streams.** One more thing Redis must be trusted with. Monitor memory (streams are capped, not unlimited) and persistence settings. Pub/Sub is never used because it loses messages.
- **RabbitMQ.** Think about the first message: a publish before any consumer group exists is refused rather than silently dropped. Make consumers start first, or accept the explicit error.
- **Kafka.** Topic creation (`topicCreation: auto | require`) and partition count are decisions: in production pre-create topics and use `require`. SASL requires TLS; PSO refuses SASL over plaintext.

## Migrating later

Declarations, handlers and the envelope do not change, so switching is a data-migration plan: drain or dual-publish, because streams, queues and topics do not share offsets. Steps and the commands are in [Providers: migrating](/dispatch/providers). Plan it as an operation with a window, not a config flip.

## Verified, and not

PSO's adapters were exercised against real Redis, RabbitMQ and Kafka in containers on a Windows host, TypeScript to Java on all three. That says nothing about managed offerings (cloud-hosted Kafka, clustered RabbitMQ with mirrored queues, Redis with replicas): test those before depending on them ([support matrix](/dispatch/local-and-production)).

## Anti-patterns

- Choosing Kafka for five events a minute because "it scales".
- Using Redis Streams as a permanent event store.
- Running several providers in one service (a service installs one).
- Ignoring the dead-letter channel: alert on non-empty `.dlq` channels whatever the provider.

## Related

[Providers](/dispatch/providers) · [Reliability](/dispatch/reliability) · [Local and production](/dispatch/local-and-production)
