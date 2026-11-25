# PSO Java ecosystem

Spring Boot starters and auto-configuration for PSO Web microservices (group `com.pso`, version `0.1.0-SNAPSHOT`, Java 21, Spring Boot 3.5.6).

| Module | Purpose |
|---|---|
| `pso-bom` | compatible versions of every artifact |
| `pso-dispatch-api` | provider-independent event contracts |
| `pso-spring-boot-autoconfigure` | typed `pso.*` configuration, service prefix, request limits, correlation, database and dispatch selection |
| `pso-spring-boot-starter` | what services depend on: autoconfigure + web + actuator + validation |
| `pso-security-spring-boot-starter` | JWT resource server, authorization rules, CORS, headers |
| `pso-http-spring-boot-starter` | `PsoHttpClient` |
| `pso-data-spring-boot-starter` | JPA, Flyway, PostgreSQL driver |
| `pso-test` | local JWKS endpoint and token signer for tests |
| `pso-integration-tests` | real Spring Boot applications exercising the starters over HTTP (not published) |

```bash
pso java:install          # or: ./mvnw install -DskipTests   (installs into ~/.m2)
./mvnw test               # the integration tests (clean first after changing annotation processors)
```

Not implemented: broker provider starters (redis, rabbitmq, kafka), an observability starter, published artifacts. See the PSO documentation, section "Spring Boot".
