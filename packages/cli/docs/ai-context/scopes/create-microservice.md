---
title: Task: create a microservice
description: Exact steps to add a Spring Boot service, optionally with PostgreSQL.
order: 21
scope: create-microservice
base: false
requires: [microservices]
keywords: [ai, task, spring boot, microservice]
---
1. In the workspace root: `pso create service <name>` (kebab-case). It creates the layered structure with the reference Product CRUD and PostgreSQL (declared; `pso docker:up` provisions it). Use `--template empty` for a service without the example (add `--db postgres` only if it owns a database), `--package com.example.x` for the base package. A second service with the CRUD template would also serve `/products`: prefer `--template empty` for it.
2. Install the PSO Java artifacts once with `pso java:install` (the create command prints a note when they are missing). Check the service: `pso validate`, `pso security:validate`, then `.\mvnw.cmd test` inside the service folder (`./mvnw test` on macOS/Linux). The generated tests must pass. The endpoint prefix is derived from the name (`--prefix /x` overrides it).
3. The service is deny-by-default (security starter) and returns `401` for everything except `/actuator/health`. That is correct; do not add `permitAll()`. A database (`pso database:enable`) and dispatch are off until chosen.
4. Set `PSO_JWT_JWKS_URI`, `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` for the service (ask the user for the values; never invent them).
5. Add a complete resource with `pso make:crud <name> --service <svc> --orchestrator [--fields ...]` (entity, migration, repository, records, mapper, service, controller, tests, and the orchestrator module). Single pieces: `pso make:entity`, `make:repository`, `make:request`, `make:response`, `make:mapper`, `make:exception`, `make:client` with `--service <svc>`; each writes into its layer. `pso make:resource` (a forwarding route plus a Spring controller and contract) works in both structures. Never create `providers`, `modules` or `.app` in Java.
6. With PostgreSQL: `pso make:migration <name> --service <svc>`; never edit an applied migration.
7. Declare dependencies in `pso.workspace.json` (`dependsOn`) or with `pso services:register`.
