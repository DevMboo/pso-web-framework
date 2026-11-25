---
title: First microservice
description: Generate a Spring Boot service in the layered structure with the reference Product CRUD, secure from its first request, run its tests, start it with PostgreSQL, and read what it answers with and without a token.
order: 9
keywords: [spring boot, microservice, maven wrapper, layered, crud, jwt, tests, flyway]
prerequisites: [A workspace, JDK 21 or newer]
related: [microservices/spring-boot-integration, microservices/project-structure, spring/postgresql-crud, devops/logging]
---
## 1. Command

```pso-example
pso create workspace demo
cd demo
pso create service catalog
pso validate
```

The service is generated in the [layered structure](/architecture/java-microservice) with the reference Product CRUD and a declared
PostgreSQL database. `pso create service orders --template empty` creates the same foundations without the example (add `--db postgres`
for a database).

## 2. What was created

Expected output (abridged: the command prints every file):

```text evidence="expected"
$ pso create service catalog
created    pom.xml
created    lombok.config
created    src/main/java/com/pso/catalog/Application.java
created    src/main/java/com/pso/catalog/application/dto/request/CreateProductRequest.java
created    src/main/java/com/pso/catalog/application/dto/request/UpdateProductRequest.java
created    src/main/java/com/pso/catalog/application/dto/response/PageResponse.java
created    src/main/java/com/pso/catalog/application/dto/response/ProductResponse.java
created    src/main/java/com/pso/catalog/application/mapper/ProductMapper.java
created    src/main/java/com/pso/catalog/application/rest/ProductController.java
created    src/main/java/com/pso/catalog/application/service/ProductService.java
created    src/main/java/com/pso/catalog/infrastructure/entity/ProductEntity.java
created    src/main/java/com/pso/catalog/infrastructure/persistence/ProductRepository.java
created    src/main/java/com/pso/catalog/infrastructure/persistence/ProductSpecifications.java
created    src/main/java/com/pso/catalog/shared/exception/ConflictException.java
created    src/main/java/com/pso/catalog/shared/validation/PageRequests.java
created    src/main/resources/application.yml
created    src/main/resources/db/migration/V1__create_products.sql
created    src/test/java/com/pso/catalog/ApplicationTests.java
created    src/test/java/com/pso/catalog/DatabaseMigrationTests.java
created    src/test/java/com/pso/catalog/TestDatabaseConfig.java
created    src/test/java/com/pso/catalog/application/rest/ProductControllerTests.java
registered "catalog" in pso.workspace.json (port 8081)
```

| Path | Purpose |
|---|---|
| `pom.xml` | Spring Boot 3.5 parent, the PSO BOM and starters, JPA, Flyway, the PostgreSQL driver, `java.version` 21 |
| `mvnw`, `mvnw.cmd`, `.mvn/wrapper/` | Maven Wrapper (Maven 3.9.9, checksum pinned): no `mvn` needed |
| `Application.java` | the Spring Boot entry point |
| `application/` | `rest/` controllers, `service/` transactional services, `dto/request` and `dto/response` records, `mapper/` |
| `infrastructure/` | `entity/` JPA entities, `persistence/` repositories and filters |
| `shared/` | the RFC 9457 exceptions and the page-request validation |
| `db/migration/V1__create_products.sql` | the table, its constraints and indexes: Flyway owns the schema, Hibernate only validates it |
| `application.yml`, `application-<profile>.yml` | configuration; no default profile on purpose: choose one (`local`, `dev`, `test`, `staging`, `prod`, `h2`) |
| `src/test/...` | the API tests: real JWT validation and an embedded PostgreSQL with the real migration |

There is no `providers`, `modules` or `.app` directory: those are orchestrator conventions ([why](/architecture/overview#why-two-conventions)).

## 3. The generated controller

An excerpt of the generated controller:

```java title="catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java" {1-3}
@PostMapping
@PreAuthorize("hasAuthority('SCOPE_products:write')")
public ResponseEntity<ProductResponse> create(@Valid @RequestBody CreateProductRequest request) {
    ProductResponse created = service.create(request);
    URI location = ServletUriComponentsBuilder.fromCurrentRequestUri().path("/{id}").buildAndExpand(created.id()).toUri();
    return ResponseEntity.created(location).body(created);
}
```

There is no security code in the project: the [security starter](/spring/security-and-cors) provides a deny-by-default chain. Only the health endpoints are public; every other route needs a valid JWT, and scopes become `SCOPE_*` authorities for `@PreAuthorize`. The controller maps `/products` and PSO serves it under the [service prefix](/spring/service-prefix) (`/catalog/products`). Without `PSO_JWT_*` settings every token is rejected.

> [!NOTE]
> The service resolves the PSO Java artifacts (`com.pso:*`) from your local Maven repository. If you have not done it on this machine yet, run `pso java:install` once before the next step ([installation](/getting-started/installation)); otherwise Maven stops with `Non-resolvable import POM: com.pso:pso-bom`.

## 4. Run the tests

```powershell tab="PowerShell" group="run"
cd catalog
.\mvnw.cmd test
```

```bash tab="macOS / Linux" group="run"
cd catalog
./mvnw test
```

A fresh service runs 16 tests and needs neither Docker nor a running database (the tests start an embedded PostgreSQL). What they
prove: health is public, everything else answers `401` without a token and `403` without the scope; a product is created (`201` with
`Location`), read, listed with pagination, sorting and filters, replaced and deleted (`204`); invalid bodies and unknown properties are
`400` with field errors; a duplicate SKU is `409`, also when two requests race; an unknown id is `404`; and the migration produces the
schema the entities expect.

## 5. Start it and call it

```powershell
pso infra:init --identity keycloak --runtime docker --users "ana,bob:products:read"
pso docker:up --vendor
```

starts the service with its PostgreSQL database (and the rest of the workspace) in containers. `infra:init` declares the local environment in `pso.infra.json`: Docker, Keycloak and two development users (`ana` holds every scope the routes declare, `bob` only `products:read`); without it the local environment runs processes and has no identity provider. `--vendor` copies the PSO packages and Java artifacts the images need into the projects (an installed CLI references them on this machine, which an image build cannot reach); later starts without a rebuild do not need it. To run it from the IDE or Maven instead,
point it at a PostgreSQL database with `DB_URL`, `DB_USER` and `DB_PASSWORD`. The `h2` profile does not apply to a service with
PostgreSQL: its migrations use PostgreSQL features, and it would still try to reach PostgreSQL.

Without a token the service answers `401` and sets `WWW-Authenticate: Bearer`; the `X-Correlation-ID` header is the id that appears in its logs ([logging](/devops/logging)). With a token carrying `products:write`:

```bash
curl -i -X POST http://127.0.0.1:8081/catalog/products -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"sku":"KB-100","name":"Keyboard","price":"12.50"}'
```

*(expected: `201` with a `Location` header and the product with its `id`; clients normally call the orchestrator's `/products` instead,
see [the reference CRUD](/architecture/reference-crud))*

## 6. Variations

| You want | Do |
|---|---|
| no example | `pso create service orders --template empty` (add `--db postgres` for a database) |
| another resource | `pso make:crud order --service catalog --orchestrator` ([Generators](/architecture/generators)) |
| to run on another port | `pso create service orders --port 8090` |
| JSON logs | the `prod` and `staging` profiles write structured JSON; see [Logging](/devops/logging) |
| messaging | `pso dispatch:install redis --service catalog` ([Dispatch](/dispatch/installation)) |
| a resource exposed through the gateway | `pso make:resource` ([First endpoint](/getting-started/first-endpoint)) |

## 7. Common mistakes

- Expecting `mvn` on the PATH: use the wrapper (`mvnw`).
- Calling the service with `curl` and no token: `401` is correct, not a bug.
- Putting business routes in `permitAll()`: `pso security:check` flags anything beyond health as a finding.
- Running without choosing a profile and wondering why the prod-only rules are absent: pick one explicitly.
- Forgetting that the service prefix is applied by PSO: map `/products`, not `/catalog/products`.
- Editing `V1__create_products.sql` after it ran: Flyway refuses to start; add a new migration instead.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| the service stops with `pso.security.jwt.jwks-uri is required` | Spring needs `PSO_JWT_JWKS_URI`; a key file is read by the orchestrator only | the first lines of the start-up log | set `PSO_JWT_JWKS_URI` (https, or http on loopback in development) |
| `Port 8081 was already in use` | another process holds the port | the OS's port listing | stop it or change `port` in `pso.workspace.json` |
| `PSO_MISPLACED_RESOURCE` after adding a class | the class is outside the directory its kind requires | `pso validate` | move it |
| `401` from the service | no token, or issuer or audience differ | `pso security:validate` | align the values with the token |

The first row was reproduced while writing [Build a CRUD API](/tutorials/crud-api).

## Next steps

- [First endpoint](/getting-started/first-endpoint)
- [PostgreSQL CRUD](/spring/postgresql-crud)
- [Project structure](/microservices/project-structure)
