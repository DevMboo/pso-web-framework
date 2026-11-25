---
title: Spring Boot starters
description: The first-party Maven artifacts behind every generated Spring Boot service, what each one provides and what is not implemented yet.
order: 1
status: partial
keywords: [starter, pso-spring-boot-starter, autoconfigure, bom, maven, spring boot, lombok]
related: [spring/maven-bom, spring/configuration, spring/security-and-cors, spring/http-client, microservices/spring-boot-integration]
---
A generated service contains your code and a short `application.yml`. Security, request limits, correlation, the outbound HTTP client and database selection come from reusable artifacts in the `pso-java/` project of the framework (group `com.pso`).

| Artifact | Purpose | Status |
|---|---|---|
| `pso-channels-spring-boot-starter` | `PsoChannelPublisher` and `@ChannelPublish`: typed real-time events to browsers over Dispatch ([Channels](/orchestrator/channels)) | implemented; tested with Dispatch's in-memory adapter, not a broker |
| `pso-storage-spring-boot-starter` | provider-independent file storage (local, S3, Azure Blob): [Storage](/spring/storage) | implemented; cloud adapters verified against mocks only |
| `pso-bom` | compatible versions of every artifact below | implemented |
| `pso-spring-boot-autoconfigure` | typed and validated `pso.*` configuration, [service prefix](/spring/service-prefix), [request limits](/spring/limits), correlation id, database and dispatch selection | implemented |
| `pso-spring-boot-starter` | the artifact services depend on: autoconfigure + web + actuator + validation | implemented |
| `pso-security-spring-boot-starter` | [JWT resource server, authorization rules, CORS, security headers](/spring/security-and-cors) | implemented |
| `pso-http-spring-boot-starter` | [`PsoHttpClient`](/spring/http-client): secure outbound HTTP to named services | implemented |
| `pso-data-spring-boot-starter` | [persistence](/spring/database-and-h2): JPA, Flyway, PostgreSQL driver (never H2) | implemented |
| `pso-dispatch-api` | provider-independent event contracts, runtime and `@PsoEventHandler` ([dispatch](/spring/dispatch)) | implemented |
| `pso-test` | a local JWKS endpoint and token signer so tests run real JWT validation | implemented |
| `pso-dispatch-redis-starter`, `-rabbitmq-starter`, `-kafka-starter` | independent broker providers, installed with `pso dispatch:install` | implemented (verified against real brokers) |
| `pso-observability-starter` | Micrometer tracing and OTLP metrics/traces export, a Dispatch metrics binder, an observed `PsoHttpClient`; off unless an OTLP endpoint is set ([observability](/devops/observability)) | implemented (verified against a local OTLP receiver) |
| `pso-ratelimit-redis-starter` | a Redis-backed shared rate limiter for several instances ([rate limiting](/security/rate-limiting)) | implemented (verified against a real Redis) |

## What the starters do for you

- **Typed configuration:** everything is under `pso.*` and bound to validated classes. An unknown key is a start-up error: a misspelled security property is never silently ignored.
- **One endpoint prefix**, applied once, derived from the service name (`users-service` becomes `/users`).
- **Deny by default:** only `/actuator/health` is public; everything else needs a valid token.
- **Back-off rules:** every bean is `@ConditionalOnMissingBean`. Define your own `SecurityFilterChain`, `JwtDecoder`, `RateLimiter` or `PsoHttpClient` and the starter steps aside. Nothing scans your packages.
- **No unused infrastructure:** no database, broker or consumer starts unless you choose it.

## Lombok and conventions

Generated services include Lombok with explicit annotation processing. See [Lombok conventions](/spring/lombok).

## Development workflow

The artifacts are not published to Maven Central. Install them once into your local Maven repository with `pso java:install`: the installed rc.3 distribution copies its bundled `com.pso:*:0.2.0-rc.3` repository, a framework checkout builds `com.pso:*:0.1.0-SNAPSHOT` (see [Maven BOM and Java versions](/spring/maven-bom)).

## Not implemented

- Delayed redelivery and exactly-once delivery ([limits](/dispatch/local-and-production)).
- Service discovery beyond the named services you declare in YAML.
- Service-to-service identities (token exchange, client credentials) and mutual TLS **to** the service. The HTTP client supports mTLS **from** the service to a remote.
- A rate limiter other than the in-memory and Redis ones (the `RateLimiter` interface is the extension point).
- Published artifacts: the group id `com.pso` is local to this repository until an owned namespace is chosen.

## Common mistakes

- Replacing a starter bean without keeping what it provided (for example a hand-written security chain that ends in `permitAll()`; `pso security:check` flags it).
- Expecting a starter to start infrastructure you did not choose.
- Adding the observability starter and expecting data without an OTLP endpoint (it is off unless one is configured).

## Next steps

- [Spring Boot integration](/microservices/spring-boot-integration)
- [Configuration](/spring/configuration)
