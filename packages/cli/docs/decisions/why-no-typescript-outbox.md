---
title: Why there is no TypeScript transactional outbox
description: The outbox lives where the business data lives (Spring services with a database); the TypeScript orchestrator is stateless by design.
order: 20
keywords: [decision, outbox, dispatch, orchestrator, transactions]
related: [dispatch/outbox, dispatch/overview, decisions/why-dispatch-optional]
---
## Context

A transactional outbox solves one problem: a business change and the event announcing it must commit or roll back **together**. That needs one transaction spanning both rows, so the outbox table has to live in the same database as the business data.

## Decision

The outbox is provided for **Spring Boot services with a JDBC database** (`pso dispatch:outbox`). It is **not** provided for the TypeScript orchestrator, and this is a deliberate decision, not a gap awaiting implementation.

## Why

- The orchestrator is the public entry point and keeps no business data. It has no database, so there is no transaction an outbox row could join. A table added only for the outbox would give at-least-once publication of events whose cause was **not** committed atomically with them, which is the guarantee people expect the outbox name to carry.
- Giving the orchestrator a database would change its role (state, migrations, backups, a second place to secure) for a benefit the Spring services already provide.
- Orchestrator code that publishes events does so after handling a request or consuming an event. It gets at-least-once delivery from the broker, retries, dead letters and consumer-side idempotency, which are implemented and tested.

## Consequences

- If an orchestrator handler must not lose an event across a crash, make the originating change in a Spring service and publish from there with the outbox, or rely on the consumer's idempotent processing and the broker's redelivery.
- `pso dispatch:outbox` refuses services that are not Spring with PostgreSQL and says why.
- Revisit this decision only if the orchestrator is ever given its own persistent store; the design would then follow the Spring implementation (same table, relay and retention semantics).

## Common mistakes

- Building a local database in the orchestrator to get an outbox: it recreates the problem it was meant to solve (no atomicity with the business data).
- Publishing an event from the orchestrator and treating it as atomic with a Spring write that happened earlier.
- Assuming the Spring outbox gives exactly-once delivery: it narrows the failure window; consumers still deduplicate.
