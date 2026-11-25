---
title: Java microservice structure
description: The official layered structure of a PSO Spring Boot microservice - application/rest, service, dto, mapper; infrastructure/persistence, entity, config, security, filter; shared - with transactions, Jakarta Validation, PostgreSQL and Flyway, Spring Security, RFC 9457 errors and tests.
order: 3
status: implemented
keywords: [spring boot, java, layered, application, infrastructure, shared, controller, service, repository, entity, flyway, jpa, transactions, validation, records, lombok]
related: [architecture/overview, architecture/reference-crud, spring/postgresql-crud, spring/security-and-cors, spring/database-and-h2, architecture/generators]
---
> [!STATUS]
> **Implemented and verified.** `pso create service <name>` generates this structure with the reference Product CRUD; its generated tests pass against a real (embedded) PostgreSQL with the real Flyway migration, real JWT validation and the real HTTP layer (16 tests; 24 after `pso make:crud order`).

```tree title="The layered Spring service"
catalog/
  src/
    main/
      java/com/pso/catalog/
        application/
          rest/
            ProductController.java  # generated: @RestController: HTTP, @Valid, @PreAuthorize, status codes, Location
          service/
            ProductService.java  # generated: @Service: business operations, @Transactional boundaries
          dto/
            request/
              CreateProductRequest.java  # generated: a record with Jakarta Validation
              UpdateProductRequest.java  # generated
            response/
              ProductResponse.java  # generated: a record (the entity never leaves the service)
              PageResponse.java  # generated: the stable paginated contract
          mapper/
            ProductMapper.java  # generated: request to entity to response
        infrastructure/
          entity/
            ProductEntity.java  # generated: the JPA entity
          persistence/
            ProductRepository.java  # generated: Spring Data JPA (+ JpaSpecificationExecutor)
            ProductSpecifications.java  # generated: database-level filters
          config/  # @Configuration classes (pso make:config)
          security/  # security integration beyond the starter
          filter/  # servlet filters (pso make:filter)
        shared/
          exception/
            ResourceNotFoundException.java  # generated: RFC 9457 problems with a safe detail
            ConflictException.java  # generated
            InvalidRequestException.java  # generated
          constant/  # constants
          validation/
            PageRequests.java  # generated: page, size and sort validation
        Application.java  # generated
      resources/db/migration/
        V1__create_products.sql  # generated: the table, constraints and indexes
    test/java/com/pso/catalog/application/rest/
      ProductControllerTests.java  # generated: the API tests
```

Every package above exists in a new service, also with `--template empty`: an empty one holds a `.gitkeep`. `infrastructure/client/`
is added by `pso make:client` when the service calls another one.

The base package comes from the project (`--package com.example.catalog` at creation; generators read it from the
`@SpringBootApplication` class). There is **no providers package, no modules package and no `.app` directory** in a Java service: those
are orchestrator concepts.

## Layers

**application** - what the service does. Controllers stay small: they validate (`@Valid @RequestBody`), authorize
(`@PreAuthorize("hasAuthority('SCOPE_products:write')")`) and delegate. Services hold the business operations; each public method is a
transaction (`@Transactional`, reads `@Transactional(readOnly = true)`), and they coordinate repositories directly. Request and response
DTOs are records; mappers convert between them and entities.

**infrastructure** - how it is done technically: JPA entities, Spring Data repositories, `@Configuration` classes, security integration,
servlet filters and outbound clients (`PsoHttpClient`). No custom abstraction duplicates Spring.

**shared** - genuinely reusable code: the exceptions, `PageRequests`, constants.

## Persistence

Flyway owns the schema; Hibernate only validates the mapping (`spring.jpa.hibernate.ddl-auto: validate`, set by the template, never
`update`); timestamps are `TIMESTAMPTZ` and `hibernate.jdbc.time_zone: UTC`; money is `NUMERIC(p, s)` and `BigDecimal`. Uniqueness is a
database constraint, and the service turns its violation into a 409 even when two requests race past the first check:

```java
// application/service/ProductService.java (excerpt, generated)
@Transactional
public ProductResponse create(CreateProductRequest request) {
    if (repository.existsBySku(request.sku().strip())) {
        throw duplicateSku();
    }
    ProductEntity entity = mapper.toEntity(request);
    return mapper.toResponse(saveAndFlush(entity));       // writes now, so a constraint violation is reported here, as a 409
}
```

Lists are paginated, sorted and filtered **by the database** (`Specification` + `Pageable`); the sort field must be one the endpoint allows
and the page size has a maximum. A service with PostgreSQL runs against PostgreSQL, also locally (`pso docker:up` provisions it) and in
its tests (an embedded PostgreSQL): the generated `h2` profile is for services without a database of their own, and the migrations use
PostgreSQL features (expression indexes, `TIMESTAMPTZ`) that H2 does not reproduce.

## Validation and errors

Jakarta Validation on the request records (`@NotBlank`, `@Size`, `@Pattern`, `@Digits`, `@DecimalMin`); unknown JSON properties are
refused (`spring.jackson.deserialization.fail-on-unknown-properties: true` in the template). Every failure is an RFC 9457 problem with
the same shape as the orchestrator's: `validation_failed` (400, with the fields), `not_found` (404), `conflict` (409, with a detail),
`unauthorized` / `forbidden` (401 / 403). An application error is a `PsoProblemException` subclass (`shared/exception`): its detail is a
sentence you wrote, never an exception message or caller input. Unexpected exceptions are a generic 500 that reveals nothing.

## Security

The PSO security starter validates the JWT (issuer, audience, JWKS) before any controller runs; everything is denied unless a valid token
is present (`/actuator/health` is public). Scopes become `SCOPE_*` authorities for `@PreAuthorize`. The orchestrator forwards the
caller's token, and the service authorizes the same user again.

## Tests

Generated tests start the real application context: MockMvc for HTTP, `PsoTestJwt` (a local JWKS and real signed tokens), an embedded
PostgreSQL with the real migrations (`TestDatabaseConfig`). They cover the round trip, validation, duplicates (sequential and
concurrent), 404, 401/403, pagination, sorting and filtering. `./mvnw test` runs them.

## What goes wrong

- `Schema-validation: missing table [...]` at start-up: an entity without its migration. Hibernate validates, it never creates tables;
  add the table with `pso make:migration <name> --service <svc>`.
- `Validate failed: Migration checksum mismatch`: an applied migration was edited. Restore it and add a new `V<next>__` migration.
- `400 validation_failed` with `unknown property`: the client sent a field the record does not declare. Unknown properties are refused
  on purpose; add the field to the record if it belongs there.
- A `403` from the service after the orchestrator accepted the request: the token lacks the scope the service checks. The scopes of both
  sides are the same names (`products:read`, `products:write`); compare the route with the `@PreAuthorize`.
