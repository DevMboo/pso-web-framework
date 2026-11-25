---
title: Spring Boot integration
description: How PSO generates and manages Spring Boot services, which starters each generated service includes, and what stays plain Spring.
order: 1
keywords: [spring boot, java, template, mvnw, starter, lombok, observability]
related: [spring/overview, microservices/project-structure, microservices/security-integration, devops/logging]
---
PSO generates standard Spring Boot 3.5 services (Java 21 target) and keeps them plain Spring: no custom container, and a developer who knows Spring Boot can read the result. Common infrastructure comes from the first-party [PSO starters](/spring/overview) instead of copied classes.

| Included by `pso create service` | Notes |
|---|---|
| `pso-spring-boot-starter` | web, validation, actuator, typed `pso.*` configuration, [service prefix](/spring/service-prefix), [request limits](/spring/limits), correlation id |
| `pso-security-spring-boot-starter` | deny-by-default JWT resource server, authorization rules, [CORS](/spring/security-and-cors) |
| `pso-http-spring-boot-starter` | [`PsoHttpClient`](/spring/http-client) for secure outbound calls |
| Lombok | [conventions](/spring/lombok), explicit annotation processing |
| `pso-test`, `spring-boot-starter-test`, `spring-security-test` | generated tests use real JWT validation |
| Project-local Maven Wrapper | Maven 3.9.9, SHA-256 pinned, no global Maven needed |
| Profiles | `local`, `dev`, `test`, `staging`, `prod`, `h2` ([configuration](/spring/configuration)) |
| Database and dispatch | present but **off**: `pso.database.provider: none`, `pso.dispatch.enabled: false` |

Optional starters you add on demand: the persistence starter (`pso database:enable`), a Dispatch provider (`pso dispatch:install`), the Redis-backed rate limiter and the OpenTelemetry observability starter (`pso-observability-starter`, off unless an OTLP endpoint is configured; see [observability](/devops/observability)).

PSO adds three things around Spring: the **workspace declaration** (port, prefix, dependencies, health path), the **generators** (`make:resource`, `make:controller`, `make:migration`, `database:enable`, ...) and **validation** (`pso validate`, `pso security:validate`).

## What "plain Spring" means in practice

```java
@SpringBootApplication
public class Application { public static void main(String[] args) { SpringApplication.run(Application.class, args); } }
```

The starters are ordinary auto-configuration: every bean backs off when you define your own, and nothing scans your packages. You can read the effective `pso.*` settings in any IDE (the autoconfigure artifact ships configuration metadata) and override anything with Spring's own mechanisms.

## Build and test

```powershell
pso java:install      # once: the PSO artifacts into your local Maven repository
cd services/catalog
.\mvnw.cmd test       # ./mvnw test on macOS and Linux
.\mvnw.cmd package
```

or from the workspace: `pso test --service catalog`, `pso build --service catalog`. A fresh generated service passes its tests (verified: 16 tests including a `product` resource, `BUILD SUCCESS`, about 11 s on a warm Maven cache). The artifacts are not published ([Maven BOM and SNAPSHOTs](/spring/maven-bom)).

## Variations

| You want | Do |
|---|---|
| to start with a database | `pso create service orders --db postgres` |
| a different port | `pso create service orders --port 8090` |
| to run it | `./mvnw spring-boot:run -Dspring-boot.run.profiles=local` ([First microservice](/getting-started/first-microservice)) |
| structured JSON logs | the `prod`/`staging` profiles ([Logging](/devops/logging)) |

## Common mistakes

- Running without a profile and expecting local conveniences.
- Overriding a PSO bean without reading what it provided (for example replacing the security chain without keeping the deny-by-default rules): `pso security:check` flags a hand-written chain that ends in `permitAll()`.
- Calling the service on the wrong path: PSO adds the service prefix once, so `/catalog/ping`, not `/ping`.

## Next steps

- [Spring Boot starters](/spring/overview)
- [Project structure](/microservices/project-structure)
- [Security integration](/microservices/security-integration)
