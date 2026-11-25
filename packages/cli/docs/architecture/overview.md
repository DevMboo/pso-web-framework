---
title: Application architecture
description: The official structure of a PSO application - .infra, .app, TypeScript modules, the layered Java packages and shared - what each part owns, why the orchestrator and the microservices use different conventions, and how new projects start with a working reference CRUD.
order: 1
status: implemented
keywords: [architecture, structure, .app, .infra, modules, application, infrastructure, shared, layered, modular, crud, template]
related: [architecture/typescript-orchestrator, architecture/java-microservice, architecture/reference-crud, architecture/generators, architecture/structure-migration]
---
> [!STATUS]
> **Implemented and verified.** New projects are generated in these structures by `pso create orchestrator` and `pso create service`, compile, pass their generated tests, and serve the reference CRUD end to end (orchestrator -> microservice -> PostgreSQL). 0.1 projects keep working in their own structure.

A PSO workspace has one **orchestrator** (TypeScript, the single public entry point) and any number of **microservices** (Spring Boot, each owning its data). Each technology follows the practices of its own ecosystem, so the two are structured differently on purpose; what they share is the PSO identity: declared routes, deny-by-default security, RFC 9457 errors, service discovery, generated infrastructure.

> [!IMPORTANT]
> The structures on this page are **mandatory for every new PSO application**, not suggestions: `pso create` generates them, every
> generator writes into them, `pso validate` and the runtime enforce them, and the rest of this documentation and the AI context assume
> them. The 0.1 layouts appear only in the [compatibility and migration](/architecture/structure-migration) pages.

```tree title="A PSO workspace"
workspace/
  .infra/  # operational infrastructure PSO manages: certificates, secrets, generated configuration (never edited)
  pso.workspace.json  # the projects and how they relate
  gateway/  # the orchestrator (modular structure)
    src/
      .app/  # application-wide components: guards, middlewares, interceptors, filters, configs, contracts, decorators
      modules/  # business modules (products/, orders/), each with its controllers, services, providers, DTOs, routes
      shared/  # reusable code that belongs to no single module
      main.ts
  catalog/  # a microservice (layered structure)
    src/main/java/<package>/
      application/  # rest/, service/, dto/request and dto/response, mapper/
      infrastructure/  # persistence/, entity/, config/, security/, filter/, client/
      shared/  # exception/, validation/, constant/
      Application.java
```

## What each part owns

| Part | Holds | Never holds |
|---|---|---|
| `.infra/` (workspace) | certificates, secrets, the identity provider's realm, nginx and compose files, provisioning state: generated and reconciled by PSO | application code; it is not version-controlled source |
| `.app/` (orchestrator) | version-controlled, application-wide source: guards, middlewares, interceptors, filters, configuration modules, shared contracts, decorators | business functionality, secrets, certificates |
| `modules/<module>/` (orchestrator) | one business capability: its controllers, services, providers (calls to microservices), DTOs, contracts, mappers and its `routes/ROUTES.pso.ts` | another module's internals; persistence |
| `application/` (Java) | what the service does: REST controllers, transactional services, request/response records, mappers | JPA entities in responses; infrastructure details |
| `infrastructure/` (Java) | how it is done: entities, repositories, technical configuration, security integration, filters, outbound clients | business rules |
| `shared/` (both) | genuinely reusable, non-business code: exceptions, validation helpers, constants | a collection of unrelated business logic |

## Why two conventions

The orchestrator **composes**: each feature is a module that owns its HTTP surface and its calls to microservices, and the framework
discovers and validates modules as units (MODULE.pso.ts, ROUTES.pso.ts). Grouping by module keeps a feature's files together and its
public surface explicit.

A microservice **implements** one bounded context with Spring: controllers, transactional services, JPA and Flyway. Spring's component
scanning, JPA entity scanning and Spring Data work package by package, and Java developers expect the layered packages. So a Java
service has **no `providers` package, no `modules` package and no `.app` directory**: it calls other services through
`PsoHttpClient` (`infrastructure/client`), and its layers are packages, not modules.

## Starting a project

```bash
pso create workspace shop && cd shop
pso create service catalog          # layered Spring service + reference Product CRUD + PostgreSQL (declared, provisioned by PSO)
pso create orchestrator gateway     # modular orchestrator + products module bound to catalog
```

`--template empty` creates the same foundations without the example (`pso create service billing --template empty` has no database
unless `--db postgres`). `--package com.example.catalog` chooses the Java base package. `--structure legacy` still creates the 0.1
layout for compatibility.

## Limits and what goes wrong

- The two conventions never mix inside one project: a project with files of both is refused (`PSO_STRUCTURE_MIXED`) rather than
  half-understood. A workspace may hold a 0.1 project next to official ones.
- PSO does not move application files. Migrating a 0.1 project is planned by `pso structure:inspect` and done by its owner.
- Two services created with the reference CRUD both serve `/products`: `pso create orchestrator` then asks which one with
  `--crud-service` instead of guessing. Give the second service `--template empty`, or remove its example.
- The reference CRUD is an example of the structure, not a product catalogue to extend blindly: rename or remove it before it reaches
  production ([The reference CRUD](/architecture/reference-crud#removing-it)).

## Next

- [TypeScript orchestrator](/architecture/typescript-orchestrator): modules, `.app`, routes, providers.
- [Java microservice](/architecture/java-microservice): the layered packages, transactions, persistence, errors, tests.
- [The reference CRUD](/architecture/reference-crud), file by file, with real requests and answers.
- [Generators](/architecture/generators) and [structure migration](/architecture/structure-migration).
- [Build a CRUD API](/tutorials/crud-api): one request followed through every layer.
- Compatibility: [a CRUD by hand in the 0.1 layout](/architecture/manual-crud-0-1), [the 0.1 hexagonal Java layout](/microservices/hexagonal-architecture).
