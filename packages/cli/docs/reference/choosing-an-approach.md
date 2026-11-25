---
title: Choose an integration approach
description: Decide where code belongs and when to use HTTP, Dispatch, an outbox or a broker provider.
order: 5
keywords: [decision guide, http versus events, redis versus rabbitmq versus kafka, outbox, gateway]
related: [orchestrator/architecture, spring/http-client, dispatch/providers, dispatch/outbox]
---

PSO offers several ways to connect capabilities. Choose from the dependency the caller actually has, then account for failure and operations.

## HTTP or Dispatch?

| Need | Prefer | Why | Failure to plan for |
|---|---|---|---|
| Caller needs a result now | HTTP through the orchestrator, or a named `PsoHttpClient` service | The response can carry the result or error | Timeout, upstream unavailability, bounded retries |
| Work may finish later and several consumers may react | Dispatch | Publisher and consumer run independently | Duplicate delivery, broker outage, dead letters |
| A database change must always produce an event | Spring transactional outbox plus Dispatch | Order row and event row share a transaction | Relay delay, duplicate publish after crash |

HTTP is easier to reason about for reads and immediate decisions. Events are useful for notifications, projections and independent follow-up work. Do not use an event when the HTTP caller must know whether a downstream write committed before responding. [PsoHttpClient](/spring/http-client) requires named destinations and rejects arbitrary URLs; [Dispatch](/dispatch/reliability) is at least once.

## Where should logic live?

The orchestrator owns public route activation, authentication, forwarding and request-level policy. A Spring service owns its domain rules, persistence and service-local API. Keep a shared event or HTTP contract in a shared location when two services must agree on its shape, but keep service-specific business rules with the service that owns the data. A decorated gateway method still needs `MODULE.pso.ts` and `ROUTES.pso.ts` registration ([Routing](/orchestrator/routes)).

## Which broker?

| Provider | Good fit | Operational question |
|---|---|---|
| Redis Streams | A compact stream setup in an environment already operating Redis | Is stream retention and persistence adequate for recovery? |
| RabbitMQ | Explicit queues and consumer groups with routing and publisher confirms | Is a queue bound before the producer publishes? |
| Kafka | Partitioned event streams with replay and higher throughput needs | Are topics, replication and partition keys managed? |

All three use the same PSO envelope and event declaration, but their retention, ordering and acknowledgement differ. Switching providers does not copy outstanding messages or offsets. Read the [provider comparison](/dispatch/providers) before choosing and run `pso dispatch:providers` for the installed version's capabilities.

## Local or distributed rate limits?

The TypeScript HTTP package provides local and Redis-backed limiters ([Rate limiting](/security/rate-limiting)). A local limiter is appropriate for one gateway process or a best-effort per-instance cap. Use a shared store when multiple gateway instances must enforce one budget. Spring's starter exposes a `RateLimiter` extension point, but a distributed Spring implementation is not provided ([Spring limits](/spring/limits)).

## When to use a custom guard

Use the framework JWT guard for an identity provider that signs supported asymmetric JWTs and publishes a JWKS or public key. Use `CustomGuard.create` only when your application must verify a different credential. Declare `security.authentication.provider: custom` and identify the provider; custom verification still needs a principal for scope and role checks ([Authentication](/security/authentication#custom-guards)).

## Where to go for each decision

This page compares approaches at a high level. For individual decisions with consequences and examples use the decision guides: [controller or service](/decisions/controller-or-service), [gateway or service validation](/decisions/gateway-or-service-validation), [HTTP or Dispatch](/decisions/http-or-dispatch), [Redis, RabbitMQ or Kafka](/decisions/redis-rabbitmq-or-kafka), [outbox or direct publish](/decisions/outbox-or-direct-publish), [JPA or JDBC](/decisions/jpa-or-jdbc), [synchronous or asynchronous](/decisions/sync-or-async), [local or distributed rate limiting](/decisions/local-or-distributed-rate-limit), [pretty or JSON logs](/decisions/pretty-or-json-logs) and [development or production configuration](/decisions/dev-or-production-config).

## Common mistakes

- Choosing a heavier mechanism (events, a distributed limiter, a broker) before the need exists.
- Choosing by what is familiar when the operational cost differs.

## Next steps

- [Why PSO exists](/getting-started/why-pso)
- [Decision guides](/decisions/controller-or-service)
