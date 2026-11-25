# catalog

PSO Spring Boot service (Java 21, Spring Boot 3.5, Lombok). Infrastructure comes from the PSO starters; this project only holds your code.

| | |
|---|---|
| Port | `8202` (override with `PORT`) |
| Endpoint prefix | `/catalog` (applied by PSO to every `@RestController`; map paths without it) |
| Health | `/actuator/health` (public); everything else requires a valid JWT |
| Configuration | `src/main/resources/application.yml` and `application-<profile>.yml` |

## Run

```bash
pso java:install                      # once: installs the PSO artifacts into your local Maven repository
./mvnw spring-boot:run -Dspring-boot.run.profiles=local
./mvnw test
```

`pso dev` does the first two for you for every service of the workspace.

## Profiles

`local`, `dev`, `test`, `staging`, `prod` and `h2`. There is no default profile: choose one. `staging` and `prod` refuse to start without
JWT settings (`PSO_JWT_JWKS_URI`, `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`) and refuse H2.

## Database (disabled by default)

`pso.database.provider: none` means no JDBC URL, no JPA and no Flyway are started. Choose one on purpose:

```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=h2           # temporary in-memory H2 (adds H2 to the run classpath only)
./mvnw -Ph2 spring-boot:run -Dspring-boot.run.profiles=local,h2  # the same, together with the local conveniences
pso database:enable postgresql                                # PostgreSQL with Flyway
```

## Event dispatch (disabled by default)

`pso.dispatch.enabled: false`. Brokers are never contacted unless you install a provider: `pso dispatch:install <provider>`.

## Conventions

- Constructor injection with Lombok `@RequiredArgsConstructor`; immutable DTOs as records; `@Getter @Setter @Builder` for bound request beans.
- Never `@Data` on a JPA entity, and never `@ToString` on a type that holds secrets or entity relationships.
- Outbound calls go through `PsoHttpClient` with services declared under `pso.http.client.services`.
