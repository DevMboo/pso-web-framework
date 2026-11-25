---
title: Task: configure a Spring service
description: Change security, CORS, limits, HTTP client, database or prefix of a PSO Spring service through application.yml.
order: 22
scope: spring-starters
base: false
requires: [microservices]
keywords: [ai, task, application.yml, pso.security, cors, limits, http client, h2, postgresql]
---
1. Edit `src/main/resources/application.yml` (or `application-<profile>.yml`). Keys are `pso.service`, `pso.security`, `pso.security.cors`, `pso.http`, `pso.limits`, `pso.dispatch`, `pso.database`, `pso.observability`. Unknown keys stop start-up, so spell them exactly as in the reference.
2. Validate before running: `pso validate` and `pso security:validate`. Fix every SPR* finding; do not silence them.
3. CORS: `pso.security.cors.enabled: true` with exact `allowed-origins` (`http://localhost:3000`). Never `*`, never a wildcard pattern with credentials, never a trailing slash.
4. Authorization: method security (`@PreAuthorize("hasAuthority('SCOPE_x:read')")`) or `pso.security.rules` (paths relative to the service prefix). Do not add public rules unless the user asks.
5. Calling another service: declare it under `pso.http.client.services.<name>.base-url` (https), inject `PsoHttpClient` and call `http.get("<name>", "/path/{id}", Dto.class, id)`. Enable `forward-bearer` only for services that must act on behalf of the caller.
6. Database: `pso database:enable postgresql --service <svc>` (or `h2` for local use). For a temporary H2 run: `./mvnw spring-boot:run -Dspring-boot.run.profiles=h2`.
7. Never: put credentials in YAML, set `server.servlet.context-path`, repeat the service prefix in a controller mapping, enable dispatch yourself (the user sets `pso.dispatch.enabled`), or add Spring AMQP/Kafka/Redis messaging libraries (use `pso dispatch:install` and `@PsoEventHandler`).
