---
title: "Persistence: PostgreSQL and Flyway"
description: A service that owns its database, migrations tested against a real PostgreSQL, and the template's outbox table - what --db postgres adds, what you run, what you see, and where to go for a full CRUD example.
order: 7
keywords: [postgresql, flyway, migration, outbox, database, make:migration, database:enable]
related: [spring/postgresql-crud, microservices/hexagonal-architecture, dispatch/outbox, decisions/jpa-or-jdbc]
---
```bash
pso create service orders --db postgres
pso make:migration add-orders-table --service orders
```

For a complete, tested example with entity, repository, DTOs, transactions and tests, read [PostgreSQL CRUD in a Spring service](/spring/postgresql-crud). This page covers what the generator adds and the rules around ownership and migrations.

## What `--db postgres` adds

| Addition | Detail |
|---|---|
| Dependencies | `pso-data-spring-boot-starter` (JPA, `flyway-core`, `flyway-database-postgresql`, `postgresql` runtime) and the embedded PostgreSQL for tests |
| `application.yml` | `pso.database.provider: postgresql`; `DB_URL`, `DB_USER`, `DB_PASSWORD` read from the environment; no credentials in the file |
| Migrations | an empty `src/main/resources/db/migration/`: the service ships no table of its own. Add the first one with `pso make:migration` |
| Tests | `TestDatabaseConfig` starts an **embedded native PostgreSQL** (no Docker); `DatabaseMigrationTests` checks that the data source answers and that every migration was applied |
| Workspace | `"db": "postgres"` on the service |

Verified file list for `pso create service catalog --db postgres` (database-related files): `src/main/resources/db/migration/.gitkeep`, `src/test/java/com/pso/catalog/DatabaseMigrationTests.java`, `src/test/java/com/pso/catalog/TestDatabaseConfig.java`.

Each service owns its data. **Databases are never shared between services by default.** An existing service can opt in later with `pso database:enable postgresql`; without a chosen provider no database starts ([Database selection and H2](/spring/database-and-h2)).

## Migrations

`pso make:migration add-orders-table --service orders` creates the next `V<n>__add_orders_table.sql` in `src/main/resources/db/migration/`. Migrations are immutable once applied: add a new version instead of editing one (Flyway refuses to start if an applied migration changed).

When the service starts against a database, Flyway applies the pending versions in order (Expected output from the CRUD example against PostgreSQL 16):

```text evidence="expected"
INFO ... org.flywaydb.core.FlywayExecutor         : Database: jdbc:postgresql://127.0.0.1:55432/docs_catalog (PostgreSQL 16.15)
INFO ... o.f.core.internal.command.DbMigrate      : Migrating schema "public" to version "1 - create products"
INFO ... o.f.core.internal.command.DbMigrate      : Successfully applied 1 migration to schema "public", now at version v1
```

and the history is queryable (`SELECT version, description, success FROM flyway_schema_history`): `1 create products t`.

## Services created before 2026-11-14: the `outbox_event` table

Earlier versions of the PostgreSQL service template shipped a first migration, `V1__outbox.sql`, that created a table named `outbox_event`. Nothing in PSO reads or writes it: the transactional outbox of PSO Dispatch is the `pso_outbox` table that `pso dispatch:outbox` adds ([Outbox](/dispatch/outbox)). New services no longer get that migration, so a generated service contains only tables you or a PSO command asked for.

In a service that already has it:

- **Keep the file.** It was applied, and Flyway refuses to start when an applied migration is changed or removed.
- **PSO never drops a table.** `pso migrate` only reports that the table is there.
- If your own code does not use it, remove it with a migration of your own:

```bash
pso make:migration drop-outbox-event --service orders
```

```sql title="the new migration"
DROP TABLE outbox_event;
```

## Variations

| You want | Do |
|---|---|
| a database in an existing service | `pso database:enable postgresql --service orders` |
| H2 for quick local work | `pso database:enable h2` (local profile only; refused in staging/prod) |
| run against a real PostgreSQL locally | start one (the CRUD page shows a Docker command), set `DB_URL`, `DB_USER`, `DB_PASSWORD` |
| events with your data in one transaction | `pso dispatch:outbox` ([decision](/decisions/outbox-or-direct-publish)) |

## Common mistakes

- Editing an applied migration (`FlywayValidateException`, checksum mismatch).
- Sharing one database between services "just for now".
- Putting credentials in `application.yml`.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| every request fails with `500` `PSO_INTERNAL_ERROR` while the database is down | nothing can open a transaction | the service log under the response's `correlationId`: `CannotCreateTransactionException`, "Connection ... refused" | restore the database; the client never sees the cause (verified) |
| a client that loses a concurrent update sees `500` | `ObjectOptimisticLockingFailureException` is not mapped by PSO | the service log | add a `@RestControllerAdvice` that answers `409` (not part of the example) |
| `409` on create with a sku that "does not exist" | a row exists that you did not expect (a failed earlier test, another environment) | `select sku from products` | remove it, or use another sku |
| Hibernate validation error at start (†) | an entity and the schema disagree: ddl-auto is `validate` | the start-up log | add a migration; never edit an applied one |
| Flyway refuses to start with a checksum error (†) | an applied migration was edited | `flyway_schema_history` | restore the file, add `V<next>__...` |

(†) marks a standard message of the underlying library, or documented behaviour, that was not reproduced for this page. The first two rows are reproduced with their exact responses in [Build a CRUD API](/tutorials/crud-api) ("When the database is down", "Optimistic locking").

## Next steps

- [PostgreSQL CRUD](/spring/postgresql-crud)
- [JPA or JDBC?](/decisions/jpa-or-jdbc)
- [Database selection and H2](/spring/database-and-h2)
