---
title: Database selection and H2
description: pso.database.provider, database-free start-up, the opt-in H2 profile and PostgreSQL with Flyway.
order: 8
keywords: [database, h2, postgresql, flyway, jpa, pso.database.provider, database:enable, profile]
related: [spring/configuration, microservices/persistence, spring/overview]
---
```yaml
pso:
  database:
    provider: none      # none | h2 | postgresql
```

## `none` (the default)

The service starts with **no JDBC URL, driver, JPA or Flyway**, even if those libraries are on the classpath: the starter removes database auto-configuration when the provider is `none`. The generated tests assert that no `DataSource` bean exists until a provider is chosen.

## H2: available, never default

H2 is for local development and tests only.

```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=h2            # adds H2 to the run classpath
./mvnw -Ph2 spring-boot:run -Dspring-boot.run.profiles=local,h2  # together with other profiles
```

The `h2` Maven profile adds the persistence starter and H2 to the run classpath only when you ask for it. The `h2` Spring profile sets `pso.database.provider: h2`, which configures an **in-memory** database (`jdbc:h2:mem`): no file is ever created and the H2 console stays disabled. The service **refuses to start** when H2 is combined with the `prod` or `staging` profile, and `pso validate` reports H2 in the base, staging or prod files (`SPR009`).

`pso database:enable h2` makes it permanent for the **local** profile (adds the dependencies and `pso.database.provider: h2` to `application-local.yml`); the base provider stays `none`.

## PostgreSQL

```bash
pso database:enable postgresql --service users-service        # or: pso create service orders --db postgres
```

It adds `pso-data-spring-boot-starter` (JPA, Flyway, driver), sets the provider, adds `spring.datasource` settings read from `DB_URL`, `DB_USER` and `DB_PASSWORD`, creates the Flyway migration directory, records `"db": "postgres"` in the workspace and adds an embedded PostgreSQL test configuration so the service's own tests never need a server. The command is idempotent, supports `--dry-run` and edits only the files it recognizes (it stops with instructions otherwise).

Tests against the embedded PostgreSQL run real Flyway migrations. A connection to a separately running PostgreSQL server was **not** exercised in the framework's own test run.

See [Persistence](/microservices/persistence) for migrations and the outbox table.

## What you see with PostgreSQL

The real start-up of a service with PostgreSQL (Hikari, Flyway, JPA) and the resulting tables are on [PostgreSQL CRUD](/spring/postgresql-crud). The decision between ORM and SQL is [JPA or JDBC?](/decisions/jpa-or-jdbc).

## Common mistakes

- Using H2 as "production light": it is refused outside the local/h2 profiles.
- Credentials in `application.yml`: use `DB_URL`, `DB_USER`, `DB_PASSWORD`.
- Enabling the database starter without a provider and wondering why nothing connects: `pso.database.provider` says what the service uses.

## Next steps

- [PostgreSQL CRUD](/spring/postgresql-crud)
- [Persistence](/microservices/persistence)
