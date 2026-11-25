# {{name}}

PSO Spring Boot microservice (Java 21, Spring Boot 3.5, Lombok). Infrastructure, security and error handling come from the PSO
starters; this project holds your code, organised in the PSO layered structure.

| | |
|---|---|
| Port | `{{port}}` (override with `PORT`) |
| Endpoint prefix | `{{prefix}}` (applied by PSO to every `@RestController`; map paths without it) |
| Base package | `{{pkg}}` |
| Health | `/actuator/health` (public); everything else requires a valid JWT |
| Configuration | `src/main/resources/application.yml` and `application-<profile>.yml` |

## Structure

```text
src/main/java/{{pkgpath}}/
├── application/              what the service does
│   ├── rest/                 @RestController classes: HTTP, validation (@Valid), authorization (@PreAuthorize)
│   ├── service/              @Service classes: business operations and @Transactional boundaries
│   ├── dto/request/          request records with Jakarta Validation
│   ├── dto/response/         response records (entities never leave the service)
│   └── mapper/               request -> entity -> response
├── infrastructure/           how it is done technically
│   ├── persistence/          Spring Data repositories
│   ├── entity/               JPA entities
│   ├── config/               @Configuration classes
│   ├── security/             security integration (the PSO security starter does the JWT validation)
│   └── filter/               servlet filters
├── shared/                   reusable, non-business code: exception/, validation/, constant/
└── Application.java
src/main/resources/db/migration/   Flyway migrations (V1__..., V2__...)
```

Packages are created when something goes in them. Generate code in the right place with `pso make:<kind> <name> --service {{name}}`
(`make:crud`, `make:controller`, `make:service`, `make:request`, `make:response`, `make:mapper`, `make:entity`, `make:repository`,
`make:migration`, `make:config`, `make:filter`, `make:exception`). The TypeScript orchestrator has providers and modules; a Java
service does not: it calls other services through `PsoHttpClient` (`infrastructure/client`, `pso make:client`).

{{crudSection}}
## Run

```bash
pso java:install                      # once: installs the PSO artifacts into your local Maven repository
pso dev --service {{name}} --with-dependencies   # PostgreSQL and the identity provider in containers, this service as a process
./mvnw test
```

## Profiles

`local`, `dev`, `test`, `staging`, `prod` and `h2`. There is no default profile: choose one. `staging` and `prod` refuse to start without
JWT settings (`PSO_JWT_JWKS_URI`, `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`) and refuse H2.

## Event dispatch (disabled by default)

`pso.dispatch.enabled: false`. Brokers are never contacted unless you install a provider: `pso dispatch:install <provider>`.
