---
title: Spring Boot conventions
description: Java layout, naming, security and persistence rules for microservices.
order: 5
scope: microservices
base: true
keywords: [ai, spring boot, java]
---
## Layout and naming

Spring Boot 3.5, Java 21, Maven Wrapper (`./mvnw` or `.\mvnw.cmd`; no global Maven). Classes are PascalCase; the owning directory is the last package segment. The layered structure below is MANDATORY for new services.

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

Mandatory for new services (`pso create service`), relative to the base package under `src/main/java`. Flyway migrations: `src/main/resources/db/migration/V<n>__<name>.sql`. A Java service has NO `providers`, `modules`, `.app` or `app` package. A 0.1 service (`routes/`, `contracts/`, `ports/`, `adapters/`, `persistence/`) keeps its layout: see the structure migration guide.

## Rules

- Each service is an independent Spring Boot application with its own database. Never share a database between services and never share domain entities; share versioned contracts and DTOs.
- Security is deny by default and comes from `pso-security-spring-boot-starter` (there is no SecurityConfig or JwtConfig in the project): only `/actuator/health` is public. Do not add `permitAll()` for business routes. Declare exceptions explicitly under `pso.security.rules` and review them.
- JWT settings (`pso.security.jwt.*` / `PSO_JWT_JWKS_URI`, `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, `PSO_JWT_ALGORITHMS`) are validated at start-up; asymmetric algorithms only. Never invent their values.
- Configuration is typed and strict: every setting lives under `pso.*` in `application.yml` and an unknown key stops start-up. Check with `pso validate` and `pso security:validate`. Do not put credentials in YAML.
- Scopes are enforced with `@PreAuthorize("hasAuthority('SCOPE_orders:read')")`.
- Bean Validation on DTOs (`@NotBlank`, `@Valid`). Use parameterized queries.
- Persistence (`pso create service <name> --db postgres`): Flyway migrations in `src/main/resources/db/migration/` (`pso make:migration <name> --service <svc>`); migrations are immutable once applied; credentials come from `DB_URL`, `DB_USER`, `DB_PASSWORD`; tests run against an embedded PostgreSQL.
- Controllers map paths WITHOUT the service prefix (`pso.service.prefix`, derived from the name: `users-service` becomes `/users`); PSO adds it once. Never set `server.servlet.context-path`. A mapping that begins with the prefix is refused at start-up unless the repetition is intended and declared with `@RepeatsServicePrefix` (`com.pso.spring.autoconfigure.RepeatsServicePrefix`): the generators add it when the controller is named like the service (`pso make:controller orders --service orders`). `@Unprefixed` serves a controller without the prefix; use it rarely. The prefix must equal the `prefix` of the service in `pso.workspace.json` (`SPR013`).
- Lombok is available: `@RequiredArgsConstructor` for constructor injection, `@Getter @Setter @Builder @NoArgsConstructor @AllArgsConstructor` for bound request beans, records for immutable DTOs. Never `@Data` on a JPA entity; avoid `@ToString`/`@EqualsAndHashCode` on entities and on types holding secrets.
- Outbound HTTP: inject `PsoHttpClient` and call named services declared under `pso.http.client.services` (relative paths only; bearer forwarding is opt-in per service). Do not build raw `RestTemplate`/`WebClient` calls to arbitrary URLs.
- CORS: `pso.security.cors` with exact origins (never `*`); request limits under `pso.limits.*`.
- `pso create service <name>` creates the reference Product CRUD with PostgreSQL (Flyway, Hibernate `ddl-auto: validate`, UTC). With `--template empty` the database is off (`pso.database.provider: none`) until `pso database:enable postgresql --service <svc>` (which also sets the schema validation). H2 is local-only, refused with the prod or staging profile, and does not apply to a service with PostgreSQL migrations.
- Dispatch is off by default (`pso.dispatch.enabled: false`). The transactional outbox (`pso dispatch:outbox`, `Outbox.publish` inside the `@Transactional` method of an `application/service/` class) stores events only while Dispatch is enabled, also in the test profile; otherwise the transaction fails with `PSO_DISPATCH_DISABLED`. Install a provider with `pso dispatch:install <redis|rabbitmq|kafka> --service <name>`; the user enables it. Delivery is at-least-once (see the dispatch scope). Never add broker clients by hand. The service's tests use the in-process adapter (`pso.dispatch.provider: memory` in `application-test.yml`, from the test-scoped `pso-dispatch-test`): never set `memory` outside the test profile (`SPR015`, refused in production).
- Profiles: local, dev, test, staging, prod, h2 (no default profile). Install the PSO artifacts first with `pso java:install`.
- Generate with `pso make:crud <resource> --service <svc> [--orchestrator] [--fields ...]` for a complete resource, or per layer: `pso make:controller|service|mapper|request|response` (application/), `make:entity|repository|config|filter|client` (infrastructure/; entity and repository need a database), `make:exception` (shared/exception), `make:migration`; `pso make:event|listener` (local application events), `pso make:dispatch-event|dispatch-handler` (distributed events; all four write to `application/event/`), `pso make:notifier` (Channels publisher: record in `application/event/`, notifier in `application/service/`), `pso make:resource` for a forwarding endpoint across orchestrator and service. `make:port` and `make:adapter` exist only for 0.1 hexagonal services. Unknown options are refused: use only the options `pso <command> --help` lists.
- Build and test: `.\mvnw.cmd test`, `pso test --service <svc>`.
