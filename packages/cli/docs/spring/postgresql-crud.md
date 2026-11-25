---
title: PostgreSQL CRUD in a Spring service
description: How the generated layered service persists its data - datasource and pool, the Flyway migration, the JPA entity, the repository and database-level filters, transactions and the 409 for duplicates, pagination limits, the tests against a real PostgreSQL - and how to add a table or a resource.
order: 9
status: stable
keywords: [postgresql, spring data jpa, flyway, hikari, crud, repository, entity, specification, transaction, pagination, migration, outbox, database:enable, make:crud]
related: [architecture/java-microservice, architecture/reference-crud, tutorials/crud-api, spring/database-and-h2, dispatch/outbox, reference/error-standard]
---
`pso create service catalog` generates a service whose Product CRUD persists in PostgreSQL. This page reads its persistence layer
file by file, with the code exactly as generated. The same pattern is what `pso make:crud` writes for every new resource.

| Layer | File | Responsibility |
|---|---|---|
| configuration | `src/main/resources/application.yml` | datasource, pool, Flyway, Hibernate validation, UTC |
| schema | `src/main/resources/db/migration/V1__create_products.sql` | the table, its constraints and indexes; Flyway is the only writer of DDL |
| entity | `infrastructure/entity/ProductEntity.java` | the JPA mapping (`@Version`, UTC timestamps, `BigDecimal`) |
| repository | `infrastructure/persistence/ProductRepository.java`, `ProductSpecifications.java` | Spring Data queries; filters in the database |
| service | `application/service/ProductService.java` | transactions, the duplicate check, the constraint turned into a `409` |
| page requests | `shared/validation/PageRequests.java` | page, size and the allowed sort fields |

## 1. Configuration

The datasource reads the environment; credentials are never in a file. Hibernate validates the mapping against the schema Flyway
created and never changes it:

```yaml title="services/catalog/src/main/resources/application.yml (excerpt, generated)"
  jackson:
    deserialization:
      fail-on-unknown-properties: true   # a request with a property the contract does not have is a 400, never silently ignored
  datasource:
    url: ${DB_URL:jdbc:postgresql://localhost:5432/catalog}
    username: ${DB_USER:}
    password: ${DB_PASSWORD:}
    hikari:
      maximum-pool-size: ${DB_POOL_SIZE:10}
  flyway:
    enabled: true
  jpa:
    open-in-view: false            # no database access while a response is rendered
    hibernate:
      ddl-auto: validate           # Flyway owns the schema (db/migration); Hibernate only checks the entities match it
    properties:
      hibernate:
        jdbc:
          time_zone: UTC
```

| Setting | Why |
|---|---|
| `ddl-auto: validate` | Hibernate checks entities against the schema and **never changes it**; a mismatch stops the start-up |
| `open-in-view: false` | no queries while the response is rendered; a lazy-loading mistake fails in the service instead of leaking a connection |
| `maximum-pool-size` | the database has a connection limit: size it as `limit / number of instances`, minus a margin for tools |
| `time_zone: UTC` | timestamps are written and read in UTC, whatever the server's zone |
| `fail-on-unknown-properties` | the request records are the contract: an extra property is a `400`, not ignored data |

`pso docker:up` provides `DB_URL`, `DB_USER` and `DB_PASSWORD` to the container (the password generated into `.infra/`, mounted as a
file secret). To run the service from the IDE, point the three variables at a PostgreSQL of your own.

## 2. The migration

```sql title="services/catalog/src/main/resources/db/migration/V1__create_products.sql"
CREATE TABLE products (
    id           UUID             PRIMARY KEY,
    sku          VARCHAR(64)      NOT NULL CHECK (char_length(sku) >= 3),
    name         VARCHAR(120)     NOT NULL CHECK (char_length(name) >= 1),
    description  VARCHAR(2000),
    price        NUMERIC(12, 2)   NOT NULL CHECK (price >= 0.00 AND price <= 9999999999.99),
    active       BOOLEAN          NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ      NOT NULL,
    updated_at   TIMESTAMPTZ      NOT NULL,
    version      BIGINT           NOT NULL DEFAULT 0,
    CONSTRAINT uk_products_sku UNIQUE (sku)
);
```

Uniqueness is a **database constraint**: it holds even when two requests race. Money is an exact `NUMERIC`, never a float. The
migration also indexes what the list endpoint sorts by. Migrations are append-only: `pso make:migration <name> --service catalog`
writes the next version (`V2__<name>.sql`).

## 3. The entity and the repository

```java title="services/catalog/src/main/java/com/pso/catalog/infrastructure/entity/ProductEntity.java (excerpt)"
    @Setter
    @Column(name = "price", nullable = false, precision = 12, scale = 2)
    private BigDecimal price;

    /** optimistic locking: a concurrent update of the same row fails instead of silently overwriting the other one */
    @Version
    @Column(name = "version", nullable = false)
    private long version;
```

```java title="services/catalog/src/main/java/com/pso/catalog/infrastructure/persistence/ProductRepository.java"
public interface ProductRepository extends JpaRepository<ProductEntity, UUID>, JpaSpecificationExecutor<ProductEntity> {

    boolean existsBySku(String sku);

    boolean existsBySkuAndIdNot(String sku, UUID id);
}
```

Filters are a `Specification`, executed by the database, never a list filtered in memory. The `name` filter is a case-insensitive
contains whose `%` and `_` are escaped:

```java title="services/catalog/src/main/java/com/pso/catalog/infrastructure/persistence/ProductSpecifications.java (excerpt)"
        if (sku != null && !sku.isBlank()) {
            spec = spec.and((root, query, cb) -> cb.equal(root.get("sku"), sku.strip()));
        }
```

## 4. The service: transactions and conflicts

Every public method is a transaction (`readOnly` for reads). A write is flushed at once, so a constraint violation is reported inside
the transaction, by name, as a `409` with a sentence that does not echo the caller's input:

```java title="services/catalog/src/main/java/com/pso/catalog/application/service/ProductService.java (excerpt)"
    /** writes now (not at commit) so a constraint violation is reported here, as a 409, inside this transaction */
    private ProductEntity saveAndFlush(ProductEntity entity) {
        try {
            return repository.saveAndFlush(entity);
        } catch (DataIntegrityViolationException e) {
            throw translate(e);
        } catch (ObjectOptimisticLockingFailureException e) {
            throw new ConflictException("the product was changed by another request; read it again and retry");
        }
    }
```

The list method builds the page request with `PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT, MAX_PAGE_SIZE)`: a sort field
the endpoint does not allow, or a size above 100, is a `400` before any query runs, and ties are broken by `id` so a page never repeats
or skips a row.

## 5. The tests

```bash
./mvnw test
```

The generated tests start the real application context with an **embedded PostgreSQL** (no Docker needed), the real Flyway
migrations and real signed JWTs. `ProductControllerTests` covers the round trip, validation, a duplicate SKU (sequential and ten
concurrent creations: exactly one row), 404 and malformed ids, 401/403, and pagination, sorting and filtering in the database;
`DatabaseMigrationTests` proves the data source is PostgreSQL and every migration ran. A new service runs 16 tests.

## 6. Another table or resource

| You want | Do |
|---|---|
| a complete resource like products | `pso make:crud order --service catalog [--orchestrator] --fields "..."` ([Generators](/architecture/generators)) |
| one entity and its repository | `pso make:entity invoice --service catalog`, `pso make:repository invoice --service catalog`, then the table with `pso make:migration create-invoices --service catalog` |
| a database in a service created with `--template empty` | `pso database:enable postgresql --service billing` (adds the driver, the datasource, Flyway and the schema validation) |
| JDBC instead of JPA | inject `JdbcTemplate` in the service and keep the same transaction structure; write SQL with `?` parameters |

`make:entity` and `make:repository` refuse in a service without a database, naming the command that adds one.

## 7. Publishing an event in the same transaction (outbox)

If other services must learn about a new product, do not publish after the save and hope. Store the event in the same transaction:

```bash
pso dispatch:install redis --service catalog
pso dispatch:outbox --service catalog
```

```java
@Transactional
public ProductResponse create(CreateProductRequest request) {
    ...
    ProductEntity saved = repository.saveAndFlush(mapper.toEntity(request));
    outbox.publish("catalog.product-created", Map.of("productId", saved.getId().toString()));   // rolls back with the product
    return mapper.toResponse(saved);
}
```

Delivery is at-least-once, so consumers must tolerate a repeated event. Details: [transactional outbox](/dispatch/outbox).

## Production considerations

- **Credentials**: environment variables or your secret manager only. The `prod` profile refuses H2.
- **Pool**: set `DB_POOL_SIZE` from the database limit and the instance count; watch pool wait time in [metrics](/devops/observability).
- **Migrations**: run on start-up for a single instance; for many instances prefer a one-off migration job before the rollout. Never use `ddl-auto: update`.
- **Backups and restore tests** are yours; PSO provisions the development database, it does not operate production databases.
- **Timeouts**: a slow query holds a pooled connection. Add statement timeouts at the database role (`ALTER ROLE catalog_app SET statement_timeout = '5s'`).
- **Least privilege**: the application role needs DML on its tables; use a separate, more privileged role for migrations if your policy requires it.

## Anti-patterns

| Do not | Do instead |
|---|---|
| return the entity from a controller | return a response record (`application/dto/response`) |
| concatenate request data into SQL | derived queries, `Specification`, `@Query` with named parameters, `JdbcTemplate` with `?` |
| `ddl-auto: update` or `create` | Flyway migrations and `validate` |
| edit an applied migration | add a new version |
| put `@Transactional` on controllers or repositories | on service methods |
| check uniqueness only in code | a database constraint, translated into a `409` |
| read `DB_PASSWORD` into a file or image | inject it at run time |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `FlywayValidateException: Validate failed ... checksum mismatch` | an applied migration was edited; restore it and add a new version |
| `Schema-validation: missing table [...]` | an entity without its migration, or the migration did not run (`flyway.enabled`, wrong `DB_URL`) |
| `Connection to ... refused` at start | the database is not reachable at `DB_URL`; with `pso docker:up`, check `pso docker:ps` |
| `HikariPool-1 - Connection is not available, request timed out` | the pool is exhausted: slow queries, a transaction left open, or too small a pool |
| `403` on a call that worked yesterday | the token no longer carries `products:write`; check scopes, not the database |
| `PSO_VALIDATION_FAILED` | read the `errors` list; each entry names the field |

## Next steps

- [The reference CRUD](/architecture/reference-crud) and [Build a CRUD API](/tutorials/crud-api)
- [Database selection and H2](/spring/database-and-h2)
- [Transactional outbox](/dispatch/outbox)
- Projects that keep the 0.1 layout: [a CRUD by hand in the 0.1 layout](/architecture/manual-crud-0-1)
