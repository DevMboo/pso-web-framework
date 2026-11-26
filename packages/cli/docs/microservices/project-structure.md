---
title: Java project structure
description: The mandatory layered structure of a PSO Spring Boot service - application, infrastructure and shared packages - where each kind of class goes, what the generators write, and how 0.1 services are kept.
order: 2
keywords: [java, package, layout, layered, application, infrastructure, shared, naming, conventions, make:request, make:entity, make:crud]
related: [architecture/java-microservice, architecture/generators, architecture/reference-crud, spring/postgresql-crud, architecture/structure-migration]
---
Every new PSO Spring Boot service uses the **layered** structure. It is the standard, not a suggestion: the generators write into it,
`pso validate` checks it, and the documentation, examples and AI context assume it. `pso create service <name>` creates it with the
reference Product CRUD, PostgreSQL and Flyway; `--template empty` creates the same packages without the example.

```tree title="A new service (pso create service catalog)"
catalog/
  pom.xml  # generated: Spring Boot 3.5, the PSO BOM 0.2.0-rc.7 and starters
  mvnw  # generated: Maven Wrapper, with mvnw.cmd and .mvn/wrapper/maven-wrapper.properties
  src/
    main/
      java/com/pso/catalog/
        Application.java  # generated
        application/
          rest/  # generated: @RestController classes
          service/  # generated: @Service classes, the transaction boundaries
          dto/
            request/  # generated: request records with Jakarta Validation
            response/  # generated: response records
          mapper/  # generated: request to entity to response
        infrastructure/
          entity/  # generated: JPA entities
          persistence/  # generated: Spring Data repositories and specifications
          config/  # generated: @Configuration classes
          security/  # generated: security integration beyond the starter
          filter/  # generated: servlet filters
        shared/
          exception/  # generated: RFC 9457 problems (PsoProblemException subclasses)
          constant/  # generated: constants
          validation/  # generated: reusable validation helpers
      resources/
        application.yml  # generated, plus application-<profile>.yml
        db/migration/  # generated: Flyway migrations V<n>__<name>.sql
    test/java/com/pso/catalog/  # generated: tests with real JWTs and an embedded PostgreSQL
```

Empty packages hold a `.gitkeep`. `infrastructure/client/` appears when `pso make:client` writes the first outbound client. The
package prefix (`com.pso.catalog`, or `--package com.example.catalog` at creation) is free; the layer is the package path below it.

A Java service has **no `providers`, `modules`, `.app` or `app` package**: those are orchestrator conventions. A Java service calls
other services through `PsoHttpClient` (`infrastructure/client/`); its layers are packages, not modules.

## Where each class goes

| Kind | Directory | File |
|---|---|---|
| controller | `<package>/application/rest/` | `*Controller.java` |
| service | `<package>/application/service/` | `*Service.java` |
| request | `<package>/application/dto/request/` | `*Request.java` |
| response | `<package>/application/dto/response/` | `*Response.java` |
| mapper | `<package>/application/mapper/` | `*Mapper.java` |
| repository | `<package>/infrastructure/persistence/` | `*Repository.java` |
| entity | `<package>/infrastructure/entity/` | `*Entity.java` |
| config | `<package>/infrastructure/config/`, `<package>/infrastructure/security/` | `*Config.java` |
| filter | `<package>/infrastructure/filter/` | `*Filter.java` |
| client | `<package>/infrastructure/client/` | `*Client.java` |
| exception | `<package>/shared/exception/` | `*Exception.java` |
| event | `<package>/application/event/` | `*Event.java` |
| listener | `<package>/application/event/` | `*Listener.java` |

`make:event`, `make:listener`, `make:dispatch-event` and `make:dispatch-handler` write their classes to `application/event/`.

Plain helper classes without one of these suffixes are allowed in any package of the service and are ignored by discovery. A class with
a known suffix in the wrong package is `PSO_MISPLACED_RESOURCE`; a badly named one is `PSO_BAD_NAME`.

## The generators

Names are given in kebab-case and become PascalCase classes with the right suffix, in the right layer. Real output (verified):

```text evidence="verified"
$ pso make:request create-customer --service catalog
created    src/main/java/com/pso/catalog/application/dto/request/CreateCustomerRequest.java
$ pso make:response customer --service catalog
created    src/main/java/com/pso/catalog/application/dto/response/CustomerResponse.java
$ pso make:service pricing --service catalog
created    src/main/java/com/pso/catalog/application/service/PricingService.java
$ pso make:mapper customer --service catalog
created    src/main/java/com/pso/catalog/application/mapper/CustomerMapper.java
$ pso make:entity customer --service catalog
created    src/main/java/com/pso/catalog/infrastructure/entity/CustomerEntity.java
$ pso make:repository customer --service catalog
created    src/main/java/com/pso/catalog/infrastructure/persistence/CustomerRepository.java
```

The generated request is a record with a validation starting point; make it yours:

```java title="src/main/java/com/pso/catalog/application/dto/request/CreateCustomerRequest.java"
package com.pso.catalog.application.dto.request;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateCustomerRequest(@NotBlank @Size(max = 120) String name) {
}
```

For a complete resource (entity, the next Flyway migration, repository, records, mapper, transactional service, controller, tests, and
optionally the orchestrator module) use one command: `pso make:crud <resource> --service <svc> [--orchestrator]`
([Generators](/architecture/generators)). An entity or a repository needs a database: in a service without one the generators refuse
and name `pso database:enable postgresql --service <svc>`.

## Where does this code go?

| You are writing | Put it in | Why |
|---|---|---|
| an HTTP endpoint | `application/rest/` (`@RestController`) | translates HTTP to a call; validates and authorizes |
| the rule behind it | `application/service/` (`@Service`, `@Transactional`) | the transaction boundary, reusable |
| a request or response shape | `application/dto/request/`, `application/dto/response/` (records) | the public contract; never an entity |
| converting between shapes | `application/mapper/` | one visible place for field mapping |
| a table | `infrastructure/entity/` and a Flyway migration | Flyway owns the schema; Hibernate only validates it |
| queries | `infrastructure/persistence/` (Spring Data, `Specification`) | filters, sorting and pagination run in the database |
| a call to another service | `infrastructure/client/` (`PsoHttpClient`) | named services, never URLs |
| technical configuration, security integration, servlet filters | `infrastructure/config/`, `security/`, `filter/` | how it is done, not what |
| an application error, a constant, a validation helper | `shared/exception/`, `shared/constant/`, `shared/validation/` | genuinely reusable, no business logic |
| an event | `application/event/` (local) or [Dispatch](/dispatch/events-and-consumers) (distributed) | |

## Common mistakes

- Returning a JPA entity from a controller: map it to a response record.
- Business logic in a controller or a repository: it belongs in `application/service/`.
- A `providers` or `modules` package "to match the orchestrator": the two runtimes follow their own ecosystems on purpose.
- An entity without its migration: the service refuses to start (`Schema-validation: missing table`).
- Configuration classes that duplicate what the PSO starters already configure (security, problems, correlation ids).

## 0.1 services (compatibility)

Services created before 0.2 use a simplified hexagonal layout (`routes/`, `application/`, `ports/`, `adapters/`, `persistence/`,
`events/`, `contracts/`, `configs/`, `security/`). They keep working, and the generators write into their layout (`make:port` and
`make:adapter` exist only there). Never add layered packages to such a service: a service with both is refused
(`PSO_STRUCTURE_MIXED`). [Structure migration](/architecture/structure-migration) plans the move with `pso structure:inspect`;
[Hexagonal architecture](/microservices/hexagonal-architecture) describes the 0.1 layout.

## Next steps

- [Java microservice structure](/architecture/java-microservice): the layers, persistence, validation, errors, tests.
- [The reference CRUD](/architecture/reference-crud), file by file.
- [PostgreSQL CRUD](/spring/postgresql-crud)
