---
title: Spring Data JPA or JDBC?
description: Choosing between an ORM and plain SQL in a PSO Spring service - what each costs, where each fits, and how to use both in the same service.
order: 35
keywords: [decision, jpa, jdbc, jdbctemplate, hibernate, sql, flyway, repository]
related: [spring/postgresql-crud, spring/database-and-h2, microservices/persistence, dispatch/outbox]
---
## The question

Your service stores data in PostgreSQL. Do you map objects to tables (Spring Data JPA) or write SQL (`JdbcTemplate`)?

## What PSO provides

`pso database:enable postgresql` adds `pso-data-spring-boot-starter`: JPA (Hibernate), Flyway and the PostgreSQL driver. PSO does not require JPA: it needs `pso.database.provider` to say what the service uses. `JdbcTemplate` is available in the same service, and the transactional outbox itself uses it. Flyway owns the schema either way.

## The short answer

| | JPA | JDBC (`JdbcTemplate`) |
|---|---|---|
| You write | entities and repository interfaces | SQL and row mappers |
| Best for | CRUD on aggregates; many small reads and writes by key | reports, bulk operations, joins and aggregations, performance-critical queries |
| Strength | little code for the common case; dirty checking turns "change the object" into an `UPDATE`; optimistic locking via `@Version` | you see exactly what runs; no hidden queries; full SQL (CTEs, window functions, `ON CONFLICT`) |
| Risk | lazy loading and N+1 queries; accidental flushes; surprising generated SQL; entities leaking into the API | more code; mapping by hand; SQL is not checked at compile time |
| Testing | needs a database; the embedded PostgreSQL in generated tests works | same |
| Schema | `ddl-auto: validate`; Flyway changes it | Flyway changes it |

## Decision flow

1. **Is the operation "load an aggregate, change it, save it"?** JPA.
2. **Is it a read that joins several tables into a shape no entity has?** JDBC (or a JPA projection) returning a record.
3. **Is it bulk (update a million rows, copy data)?** JDBC. An ORM loads objects you do not need.
4. **Do you need database-specific features?** JDBC, or a native query.
5. **Is the team more comfortable with SQL than with ORM behavior?** That is a legitimate reason for JDBC; a service that is mostly queries gains little from entities.

Most services end up with **JPA for writes and simple reads, JDBC for reports**. Mixing in one service is fine because both join the same Spring transaction.

## Consequences

- With JPA, set `open-in-view: false` and `ddl-auto: validate` (the CRUD guide explains why), and never return entities from controllers.
- With JDBC, always use `?` parameters (or named parameters), never string concatenation: that is how SQL injection happens.
- Either way, transaction boundaries are on **service** methods, not controllers or repositories.

## Anti-patterns

- Letting Hibernate create the schema (`ddl-auto: update`).
- Using JPA entities as request or response bodies.
- Writing JDBC in controllers.
- Choosing by fashion: measure the queries that matter, then choose per operation.

## Related

[PostgreSQL CRUD (JPA)](/spring/postgresql-crud) · [Database selection](/spring/database-and-h2) · [Persistence](/microservices/persistence)
