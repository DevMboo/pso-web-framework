---
title: Local development, production and verification
description: Running a local broker, production checklist, what was verified against real brokers and what remains unverified.
order: 10
status: implemented
keywords: [local development, docker compose, production, testing, integration tests, limits]
related: [dispatch/providers, dispatch/reliability, dispatch/security-and-observability]
---
## Local development

`pso dispatch:install` writes `infra/dispatch/<provider>.compose.yml` (Redis, RabbitMQ, or Redpanda-compatible Kafka). PSO never starts it; run it with `docker compose -f infra/dispatch/redis.compose.yml up -d`, export the environment variable it documents, set `enabled: true`, and run `pso dispatch:doctor`. For unit tests use the in-memory adapter (`@pso/dispatch/testing`, `pso-dispatch-test`), which implements the same contract without a broker.

## Production checklist

- TLS and authentication on the broker connection; credentials from a secret store, not files.
- Persistence on the broker (Redis AOF or replicas, RabbitMQ durable queues are used, Kafka replication factor greater than 1).
- Monitor the `.dlq` channels and alert on non-empty ones.
- A durable idempotency store or idempotent handlers.
- `retry.max-attempts` and delays sized so backoff does not stall a partition longer than you can afford.
- Pre-create topics/streams and use `require` topology mode where the service account may not create them.
- Run `pso dispatch:validate` and `pso dispatch:lock` in CI.

## What was verified

Against real brokers (Docker: Redis, RabbitMQ, Kafka) and a real PostgreSQL:

- TypeScript core runtime and provider suites; Java runtime and Spring Boot integration suites.
- TypeScript to Java and Java to TypeScript event exchange on all three providers.
- Retry, dead-letter, poison handling, duplicate suppression, consumer crash recovery (a killed consumer process), broker outage and recovery.
- CLI install/remove/outbox on generated Spring and orchestrator projects, built with real Maven and run against the brokers.
- The outbox: commit/rollback atomicity, relay, broker failure and recovery, max attempts, concurrent relays, retention, Spring auto-configuration.

Tests that need a broker skip with an explicit reason when none is available (`node scripts/dispatch-brokers.mjs up` starts them); a skipped run is not a verified run.

## Known limits

In-process retries and no delayed redelivery; no exactly-once; no TypeScript outbox; no OpenTelemetry or lag in Studio; numeric values such as `1.0` may serialize differently between TypeScript and Java (use integers or strings for identifiers); RabbitMQ refuses publishing to a channel without a bound queue; the Redis group starts at the beginning of the stream; Docker builds of Spring services need the `com.pso` artifacts to be published or installed.

## A local session, end to end

```bash
pso dispatch:install redis --service gw
docker compose -f infra/dispatch/redis.compose.yml up -d
export REDIS_URL=redis://127.0.0.1:6379            # PowerShell: $env:REDIS_URL = "redis://127.0.0.1:6379"
pso dispatch:doctor --service gw                   # UP gw (redis): PING answered
# set enabled: true, start the service, publish, watch the log
```

The outputs of each step are on [Installation](/dispatch/installation) and in the [walkthrough](/dispatch/walkthrough).

## Common mistakes

- Treating the local compose file as a production broker.
- Skipping the production checklist items on TLS, persistence and `.dlq` alerts.
- Running broker tests without a broker and reading the skipped result as a pass.

## Next steps

- [Providers](/dispatch/providers)
- [Observability and security](/dispatch/security-and-observability)
