---
title: Redis Streams, RabbitMQ and Kafka
description: The three independent provider adapters, their capabilities, and how to migrate between them.
order: 4
status: implemented
keywords: [redis streams, rabbitmq, kafka, redpanda, providers, adapter, capabilities, migration]
related: [dispatch/overview, dispatch/installation, dispatch/reliability, dispatch/local-and-production]
---
Each provider is a separate adapter implementing one stable contract (`DispatchAdapter`) that also reports **capabilities**, so documentation, `pso dispatch:providers` and Studio state what each transport really guarantees. A service installs one provider (`pso dispatch:install`). The core packages contain no broker client.

| | Redis Streams | RabbitMQ | Kafka / Redpanda |
|---|---|---|---|
| TypeScript library | `ioredis` | `amqplib` | `kafkajs` |
| Java dependency | `pso-dispatch-redis-starter` | `pso-dispatch-rabbitmq-starter` | `pso-dispatch-kafka-starter` |
| Channel maps to | stream | durable topic exchange + queue per group | topic |
| Publish acknowledgement | `XADD` answered (in memory unless the server persists) | persistent + mandatory publish with confirms; unroutable is refused | `acks=all`, idempotent producer |
| Ordering | per key (single stream) | per queue | per key within a partition |
| Consumer groups | yes | queue per group | yes |
| Acknowledge | `XACK` after the handler | manual ack after the handler | manual offset commit after the handler |
| Crashed consumer | `XAUTOCLAIM` of stale pending entries | broker requeues unacked | uncommitted offset is re-read |
| Topology creation | `streamCreation: auto \| require` | exchanges and queues created on subscribe | `topicCreation: auto \| require` |

Run `pso dispatch:providers` for the capability metadata of each adapter.

## Provider notes

- **Redis Streams** (never Pub/Sub): `XADD MAXLEN ~` retention, groups created from the start (`0`), a dedicated reader connection, stale entries reclaimed after `min-idle`.
- **RabbitMQ**: publishing to a channel that has no bound queue yet is refused rather than silently dropped. Create the consumer first or use a channel with an existing group.
- **Kafka**: SASL requires TLS; the adapter refuses SASL over plaintext. `partitions` and `replication-factor` apply only when topics are auto-created.

## Configuration

Spring `application.yml` (`pso.dispatch.<provider>.*`) and the orchestrator's `pso.config.json` (`dispatch.<provider>.*`) use the same keys. Secrets are environment references, for example `${env:REDIS_URL}` or `${REDIS_URL:}`; the CLI never writes a credential into a file and never prints one.

## Migrating between providers

Event declarations, handlers and the envelope do not change. Plan the cut-over as a data migration: drain or dual-publish, because streams, queues and topics do not share offsets.

1. `pso dispatch:remove --service <name>` (declarations and handlers are kept).
2. `pso dispatch:install <new-provider> --service <name>` and set the new broker's environment variables.
3. Run `pso dispatch:doctor` against the new broker.
4. Enable. Consumers of the old transport must be drained first; messages already in the old broker are not copied.

## What the CLI says about each provider

`pso dispatch:providers` prints the capability metadata the adapters themselves report. Expected output (abridged):

```text evidence="expected"
redis
  publish ack: XADD acknowledged by Redis: in memory, durable only if the server persists (AOF) or replicates
  ordering:    per stream (single consumer per group member); not partitioned
  redelivery:  pending entries are reclaimed (XAUTOCLAIM) after pso.dispatch.redis.min-idle
  dead letter: <channel>.dlq stream
  lag:         observable
rabbitmq
  publish ack: publisher confirm for a persistent message routed to a durable queue
  ordering:    none guaranteed with concurrency > 1
  dead letter: <channel>.dlq exchange and queue
  lag:         not available
kafka
  publish ack: acks=all: acknowledged by all in-sync replicas (durability depends on min.insync.replicas)
  ordering:    per partition (events with the same key); never global
  note:        A message being retried blocks later messages of its partition. Exactly-once processing is NOT provided.
```

Choosing between them: [Redis Streams, RabbitMQ or Kafka?](/decisions/redis-rabbitmq-or-kafka).

## Common mistakes

- Choosing by name recognition rather than operations capacity.
- Assuming RabbitMQ publishes to a channel that has no consumer yet (it is refused).
- Running Kafka without pre-creating topics in production.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `NOT-CONFIGURED` | dispatch is disabled or the broker variable is unset (`REDIS_URL`, `RABBITMQ_URL`, `KAFKA_BOOTSTRAP_SERVERS`) | `pso dispatch:inspect` | enable it and set the variable |
| `DOWN` | nothing answers at that address; Kafka reports a timeout after 8 s | the address and the broker | start the broker |
| RabbitMQ refuses to publish | no consumer group has declared the queue yet (unroutable) | the provider's note in `pso dispatch:providers` | start a consumer first |
| a Kafka partition stops advancing | the message being retried blocks later ones of its partition | the dead-letter topic `<channel>.dlq` | fix the handler |

Verified outputs for the connection checks of all three providers are in [Checking Dispatch and what its errors mean](/dispatch/diagnostics).

## Next steps

- [Reliability](/dispatch/reliability)
- [Local and production](/dispatch/local-and-production)
