---
title: Docker and Docker Compose
description: Generated hardened Dockerfiles and a Compose file - what each contains, how to use them, what was verified by running containers and what was not, and the one publishing prerequisite that blocks image builds today.
order: 3
status: partial
keywords: [docker, compose, dockerfile, container, docker:init, hardening, healthcheck]
related: [devops/ci-cd, security/checklist, devops/cloud-descriptors, decisions/dev-or-production-config]
---
```bash
pso docker:init --dry-run
pso docker:init
pso docker:build        # needs a running Docker daemon
```

## What `docker:init` creates

Verified output for a workspace with an orchestrator:

```text evidence="verified"
$ pso docker:init
created    .env.example
created    .github/workflows/ci.yml
created    docker-compose.yml
created    gateway/.dockerignore
created    gateway/Dockerfile
```

| File | Highlights |
|---|---|
| `<service>/Dockerfile` | multi-stage; Node: install, compile, prune, run `dist/main.js` as user `node`; Spring: wrapper build, JRE image as a non-root user (uid 10001); `HEALTHCHECK` on the service's health path |
| `<service>/.dockerignore` | excludes `node_modules`, `target`, `dist`, `.env`, `keys`, `*.pem` |
| `docker-compose.yml` | one published port (the orchestrator, bound to `127.0.0.1`); internal network; `read_only`, `cap_drop: ALL`, `no-new-privileges`; `depends_on` with `service_healthy`; for the orchestrator, per upstream: its address (`PSO_UPSTREAM_<NAME>`), its endpoint prefix (`_PREFIX`) and its transport, TLS by default (`_TLS`, `_TLS_CA_FILE`) or, with `--transport plaintext`, an explicit `_ALLOW_PLAINTEXT`; for a Spring service with TLS its certificate, key and a health check that verifies them; `stop_grace_period` |
| `.env.example` | the required `PSO_JWT_*` variables, without values you should keep; commented out: shutdown, the private identity provider (`PSO_JWT_JWKS_PRIVATE_HOSTS`, `PSO_JWT_JWKS_CA_FILE`) and `PSO_TLS_DIR` |
| `.github/workflows/ci.yml` | see [CI/CD](/devops/ci-cd) |

The generated Compose file (verified; one-service workspace):

```yaml
x-pso-env: &pso-env
  PSO_JWT_ISSUER: ${PSO_JWT_ISSUER:?set PSO_JWT_ISSUER}
  PSO_JWT_AUDIENCE: ${PSO_JWT_AUDIENCE:?set PSO_JWT_AUDIENCE}
  PSO_JWT_JWKS_URI: ${PSO_JWT_JWKS_URI:?set PSO_JWT_JWKS_URI}
  PSO_JWT_ALGORITHMS: ${PSO_JWT_ALGORITHMS:-ES256}
  # an identity provider on a private network or with a private certificate authority (empty = not used; see .env.example)
  PSO_JWT_JWKS_PRIVATE_HOSTS: ${PSO_JWT_JWKS_PRIVATE_HOSTS:-}
  PSO_JWT_JWKS_CA_FILE: ${PSO_JWT_JWKS_CA_FILE:-}
  PSO_SECURITY_JWT_CA_FILE: ${PSO_JWT_JWKS_CA_FILE:-}

services:
  gateway:
    build: ./gateway
    restart: unless-stopped
    environment:
      <<: *pso-env
      PORT: "3000"
      HOST: "0.0.0.0"
      PSO_SHUTDOWN_GRACE_MS: "${PSO_SHUTDOWN_GRACE_MS:-5000}"
    stop_grace_period: "${PSO_STOP_GRACE_PERIOD:-40s}"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    networks:
      - internal
    ports:
      - "127.0.0.1:3000:3000"

networks:
  internal:
    driver: bridge
```

Required variables use `${VAR:?message}`: a missing value stops Compose instead of starting an unsecured stack. Verified: with the variables unset, `docker compose config` fails with `required variable PSO_JWT_AUDIENCE is missing a value: set PSO_JWT_AUDIENCE`; with them set, `docker compose config --quiet` exits 0.

## Use it

```bash
pso tls:init --dev            # development only: a local certificate authority and one certificate per service, in ./tls
pso docker:init --vendor      # Dockerfiles and docker-compose.yml (TLS between the orchestrator and the services)
cp .env.example .env          # then edit the values; never commit .env
docker compose config --quiet # validates the file and the variables
docker compose up -d --wait   # builds if needed, starts, waits for health
```

Service-to-service addresses inside Compose are service names (`catalog:8081`). The orchestrator receives each one as `PSO_UPSTREAM_CATALOG=catalog:8081` together with the service's endpoint prefix (`PSO_UPSTREAM_CATALOG_PREFIX=/catalog`): the workspace file is not in the image, so the prefix travels with the address.

The values in `.env.example` are placeholders. An orchestrator with at least one guarded route loads the issuer's keys when it starts and does not start without them (`PSO_SEC_INIT`): `PSO_JWT_JWKS_URI` must be the HTTPS address of your identity provider's key set. For an identity provider on a private network, see [the section below](#an-identity-provider-inside-the-stack).

## Transport between the orchestrator and the services

The orchestrator image runs in production mode, where an upstream on another host must use TLS ([service identity](/security/service-identity)). `docker:init` generates one of two transports; nothing is chosen silently and there is no switch for "all upstreams".

| | `pso docker:init` (default: `--transport tls`) | `pso docker:init --transport plaintext` |
|---|---|---|
| orchestrator to service | HTTPS; the certificate's authority and host name are verified, always | plain HTTP on the private network `internal` |
| generated per upstream | `PSO_UPSTREAM_<NAME>_TLS: "true"`, `_TLS_CA_FILE: /run/pso/tls/ca.crt` | `PSO_UPSTREAM_<NAME>_ALLOW_PLAINTEXT: "${...:-true}"` |
| Spring service | serves HTTPS only (`SERVER_SSL_CERTIFICATE`, `SERVER_SSL_CERTIFICATE_PRIVATE_KEY`); its health check verifies the certificate | serves plain HTTP |
| the caller's bearer token | forwarded to the service, which verifies it again | **not forwarded** (the orchestrator never sends a token over a plaintext hop to another host): a route the service must authenticate answers 401 |
| use it for | production and anything that carries credentials | a local stack without authenticated routes, or an existing deployment while it migrates |

### TLS (the default)

The compose file reads the certificates from `PSO_TLS_DIR` (default `./tls`) and mounts them read-only: each service gets its own directory, the orchestrator gets the authority only.

```text evidence="illustrative"
tls/ca.crt                 the certificate authority the orchestrator trusts for its upstreams
tls/<service>/tls.crt      the service's certificate: it must name the service ("catalog") and "localhost" (the container health check)
tls/<service>/tls.key      the service's private key
tls/<service>/ca.crt       the same authority, next to the service
```

| Where the certificates come from | Do |
|---|---|
| development, tests | `pso tls:init --dev` creates them (ECDSA P-256, 365 days, `--days` to change; `--hosts idp` adds certificates for other containers). The flag is required: without `--dev` nothing is created. The keys are generated on your machine, unprotected, and `tls/` is added to `.gitignore` |
| production | certificates and keys from your own certificate authority, in the same layout, or `PSO_TLS_DIR` pointing at them. PSO does not generate, ship or reuse production keys |
| either | `pso tls:check` verifies the directory: issuing authority, validity dates (a warning under 30 days, an error when expired), that each key belongs to its certificate and that each certificate names its service. No key material is printed |

`docker:init` runs the same check and reports the result when it generates the files. Mutual TLS (the service authenticates the orchestrator by a client certificate) is configured with `PSO_UPSTREAM_<NAME>_TLS_CERT_FILE` and `_TLS_KEY_FILE` ([service identity](/security/service-identity)); the generated file does not set it up.

### Plain HTTP (explicit)

```bash
pso docker:init --transport plaintext --force
```

```yaml
      PSO_UPSTREAM_CATALOG: "catalog:8081"
      PSO_UPSTREAM_CATALOG_PREFIX: "/catalog"
      PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT: "${PSO_UPSTREAM_CATALOG_ALLOW_PLAINTEXT:-true}"
```

The authorization is per upstream: an upstream you add by hand is still refused without TLS, and `PSO_UPSTREAM_<NAME>_ALLOW_PLAINTEXT=false` in `.env` makes the orchestrator refuse to start until that upstream has TLS. Plain HTTP on a private network is not encryption. Each time a token is withheld the orchestrator logs `bearer token not forwarded to upstream` with the reason and the service; at start-up it logs one warning per plaintext upstream.

An upstream whose TLS is already configured in the orchestrator's `pso.config.json` (`http.upstreams.<name>.tls`) keeps that configuration in both modes: nothing is generated for it, and the file is copied into the image.

### Migrating an existing deployment

A `docker-compose.yml` generated earlier is never replaced silently (`docker:init` reports a conflict). To keep plain HTTP, regenerate with `--transport plaintext --force`: the result is what you had, plus the prefix variables. To move to TLS: `pso tls:init --dev` (or your own certificates), `pso tls:check`, `pso docker:init --force`, then start the stack again.

## An identity provider inside the stack

A JWKS address that resolves to a private address is refused: that is the protection against a configuration (or a DNS answer) pointing the orchestrator at internal systems. An identity provider that really is on a private network is approved by naming it, exactly, in `.env`:

```bash title=".env"
PSO_JWT_ISSUER=https://idp:8443
PSO_JWT_JWKS_URI=https://idp:8443/.well-known/jwks.json
PSO_JWT_JWKS_PRIVATE_HOSTS=idp:8443
PSO_JWT_JWKS_CA_FILE=/run/pso/tls/ca.crt
```

| Setting | Meaning |
|---|---|
| `PSO_JWT_JWKS_PRIVATE_HOSTS` | exact `host:port` entries. Only the JWKS URI itself, and only when its host and port match an entry, may resolve to a private-network address (10/8, 172.16/12, 192.168/16, fc00::/7). Loopback, link-local and metadata addresses stay refused, HTTPS stays required, redirects stay refused, and no other private destination becomes reachable |
| `PSO_JWT_JWKS_CA_FILE` | PEM file, inside the containers, with the authority that signed the identity provider's certificate. Verification is never disabled; without the file a private certificate is refused (`jwks_tls`) |

The compose file passes both to the orchestrator and to the Spring services (`pso.security.jwt.ca-file`). The path above is where the TLS mode mounts the authority; an identity provider with another authority needs its own mount in `docker-compose.override.yml`. Infrastructure (the identity provider, PostgreSQL, Redis, a broker) and the variables that point the services at it go in that override file: see [the next section](#infrastructure-postgresql-redis-rabbitmq).

## Infrastructure: PostgreSQL, Redis, RabbitMQ

`pso docker:init` generates the containers of **your services** and nothing else. It never adds a database or a broker, and a generated service has no address for one: every service reads its infrastructure from environment variables, and the deployment supplies them. There are two supported ways, and they use the same variables.

| The service uses | Variables it reads (already in its generated configuration) | Enabled by |
|---|---|---|
| PostgreSQL (`pso create service <name> --db postgres`) | `DB_URL` (a JDBC URL), `DB_USER`, `DB_PASSWORD` | always; Flyway migrates when the service starts |
| Dispatch over RabbitMQ (`pso dispatch:install rabbitmq`) | `RABBITMQ_URL` | `PSO_DISPATCH_ENABLED=true` |
| Dispatch over Redis (`pso dispatch:install redis`) | `REDIS_URL` | `PSO_DISPATCH_ENABLED=true` |
| the distributed rate limit of the orchestrator | the variable its `pso.config.json` names in `http.rateLimit.redisUrl` ([rate limiting](/security/rate-limiting)) | `http.rateLimit.provider: "redis"` |
| another PSO service, called with `PsoHttpClient` | the variable you put in `pso.http.client.services.<name>.base-url`, and `tls.ca-file` ([service to service](/microservices/service-to-service)) | always |

Three rules apply in the generated images, because they run in production mode (`SPRING_PROFILES_ACTIVE=prod` for a Spring service):

- **Dispatch must be authenticated.** A service with Dispatch enabled does not start without `PSO_DISPATCH_TRUST_MODE=required`, its own `PSO_DISPATCH_SIGNING_KEY`, and on a consumer the key of each publisher it accepts, `PSO_DISPATCH_TRUST_KEY_<SERVICE>` ([publisher authentication](/dispatch/security-and-observability)).
- **Secrets come from the environment**, never from the image and never from a committed file: `.env` next to the Compose files (git-ignored) or the secret store of your platform.
- **A service owns its database.** One PostgreSQL server may hold several databases, but each service gets its own `DB_URL`.

### In the same Compose project: `docker-compose.override.yml`

`docker-compose.yml` belongs to the generator (`pso docker:init --force` rewrites it). Everything the deployment adds goes in `docker-compose.override.yml`, which you write and PSO never touches. Docker Compose merges the two files by itself; with the development identity provider, name all three (`-f docker-compose.yml -f docker-compose.idp.yml -f docker-compose.override.yml`).

The example is a workspace where `orders` and `catalog` each have a PostgreSQL database, `orders` publishes Dispatch events through RabbitMQ and `catalog` consumes them:

```yaml title="docker-compose.override.yml" evidence="illustrative"
# Infrastructure of this deployment (not generated by PSO). Secrets come from .env.
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: "${DB_PASSWORD:?set DB_PASSWORD}" }
    volumes:
      - ./infra/init-databases.sql:/docker-entrypoint-initdb.d/init.sql:ro   # CREATE DATABASE orders; CREATE DATABASE catalog;
      - pgdata:/var/lib/postgresql/data
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U app -d orders"], interval: 5s, timeout: 3s, retries: 20 }
    networks: [internal]
  rabbitmq:
    image: rabbitmq:3.13-alpine
    environment: { RABBITMQ_DEFAULT_USER: app, RABBITMQ_DEFAULT_PASS: "${RABBITMQ_PASSWORD:?set RABBITMQ_PASSWORD}" }
    healthcheck: { test: ["CMD-SHELL", "rabbitmq-diagnostics -q check_port_connectivity"], interval: 5s, timeout: 5s, retries: 40, start_period: 20s }
    networks: [internal]
  orders:
    environment:
      DB_URL: "jdbc:postgresql://postgres:5432/orders"
      DB_USER: app
      DB_PASSWORD: "${DB_PASSWORD:?}"
      PSO_DISPATCH_ENABLED: "true"
      RABBITMQ_URL: "amqp://app:${RABBITMQ_PASSWORD:?}@rabbitmq:5672"
      PSO_DISPATCH_TRUST_MODE: required
      PSO_DISPATCH_SIGNING_KEY: "${ORDERS_DISPATCH_KEY:?}"
    depends_on: { postgres: { condition: service_healthy }, rabbitmq: { condition: service_healthy } }
  catalog:
    environment:
      DB_URL: "jdbc:postgresql://postgres:5432/catalog"
      DB_USER: app
      DB_PASSWORD: "${DB_PASSWORD:?}"
      PSO_DISPATCH_ENABLED: "true"
      RABBITMQ_URL: "amqp://app:${RABBITMQ_PASSWORD:?}@rabbitmq:5672"
      PSO_DISPATCH_TRUST_MODE: required
      PSO_DISPATCH_SIGNING_KEY: "${CATALOG_DISPATCH_KEY:?}"
      # a consumer also names the key of each publisher it verifies: PSO_DISPATCH_TRUST_KEY_<SERVICE>, with the publisher's
      # name in upper case ("orders" here), set to "${ORDERS_DISPATCH_KEY:?}"
    depends_on: { postgres: { condition: service_healthy }, rabbitmq: { condition: service_healthy } }
volumes:
  pgdata:
```

What to keep when you adapt it:

- **`networks: [internal]`** puts the container on the network of the generated services; it is reachable by its service name (`postgres:5432`) and has **no published port**. Publish one only on `127.0.0.1`, and only to inspect it from your machine.
- **A health check and `depends_on` with `service_healthy`**: a Spring service that starts before its database fails its migration and is restarted by `restart: unless-stopped`; with the dependency it starts once, in order.
- **`${VAR:?}`** for every secret, with the value in `.env`. The signing keys are at least 32 characters (for example `openssl rand -hex 32`).
- Redis is added the same way: `image: redis:7-alpine`, a health check with `redis-cli ping`, and `REDIS_URL: "redis://redis:6379"` on the services that use it.
- A Spring service that calls another one receives its address here as well, over TLS with the mounted authority: for a service declared with `base-url: ${CATALOG_URL:...}` and `tls.ca-file: ${SERVICES_CA_FILE:}` (names you choose), set `CATALOG_URL: "https://catalog:8082/catalog"` and `SERVICES_CA_FILE: /run/pso/tls/ca.crt`.
- The generated containers have a read-only root file system; that does not apply to the infrastructure containers you add, which need their data volume.

Then `docker compose config --quiet` and `docker compose up -d --wait` as above.

### External infrastructure (production)

A production deployment normally uses a database and a broker that already exist outside the Compose project: a managed PostgreSQL, a Redis or RabbitMQ service, or servers your organisation operates. Nothing changes in the application or in the generated files: **do not add the containers, set the same variables** to the external addresses.

```yaml title="docker-compose.override.yml" evidence="illustrative"
services:
  orders:
    environment:
      DB_URL: "${ORDERS_DB_URL:?}"          # jdbc:postgresql://db.example.internal:5432/orders?sslmode=verify-full
      DB_USER: "${ORDERS_DB_USER:?}"
      DB_PASSWORD: "${ORDERS_DB_PASSWORD:?}"
      PSO_DISPATCH_ENABLED: "true"
      RABBITMQ_URL: "${RABBITMQ_URL:?}"     # amqps://user:password@broker.example.internal:5671
      PSO_DISPATCH_TRUST_MODE: required
      PSO_DISPATCH_SIGNING_KEY: "${ORDERS_DISPATCH_KEY:?}"
```

| Point | Rule |
|---|---|
| transport | encrypted, with verification: `sslmode=verify-full` in the JDBC URL, `amqps://`, `rediss://`. Certificate verification is never switched off |
| credentials | one account per service with the rights that service needs, delivered by the platform's secret store or `.env`; never in the image, in `application.yml` or in the repository |
| network | the containers must be able to reach the address: the generated network `internal` is an ordinary bridge with outbound access. No inbound port is needed for infrastructure |
| migrations | Flyway runs the service's `db/migration` files when it starts, with the account in `DB_USER`; PSO never drops tables or data ([migrations](/microservices/persistence)) |
| start order | there is no `depends_on` for something outside the project: a service that cannot reach its database fails its health check and is restarted until it can |
| other targets | the same variables apply to the descriptors of `pso deploy:init` and to a native deployment: only the place where they are set changes ([environment configuration](/devops/environment-configuration)) |

Verified on 2026-11-14 with a consumer application outside the framework (three Spring services with PostgreSQL, RabbitMQ with the transactional outbox, service-to-service HTTPS, the development identity provider): the first form above with that application's names, started with `docker compose up -d --wait`. The external form was not run against a managed service; it differs only in the values of the variables.

## Stopping containers

`docker compose stop` sends `SIGTERM`. The orchestrator stops accepting connections, lets running requests finish within `PSO_SHUTDOWN_GRACE_MS` (default 5000), releases Channels and Dispatch and exits 0 ([runtime lifecycle](/concepts/runtime-lifecycle)). Docker kills a container that is still running after `stop_grace_period`; the generated file sets it from `PSO_STOP_GRACE_PERIOD` (default `40s`). Keep it longer than `PSO_SHUTDOWN_GRACE_MS` + 11 s, or Docker ends the process before its own deadline. A Spring service ends through Spring's graceful shutdown and reports exit code 143 (the JVM's answer to `SIGTERM`).

## What was verified by running containers

| Item | Evidence |
|---|---|
| Spring runtime image options: non-root uid 10001, read-only root file system with a tmpfs `/tmp`, all capabilities dropped, `no-new-privileges` | a service jar was run in `eclipse-temurin:21-jre` with exactly those options; `/actuator/health` answered `200` from the host (the service must listen on `0.0.0.0` inside a container: `HOST=0.0.0.0`, which the Compose file sets) |
| Compose file syntax and required variables | `docker compose config` (above) |
| The generated stack as a whole, authenticated end to end (2026-11-14, `node scripts/validate-generated-deployment.mjs`, also run by `node scripts/release-gate.mjs --release`) | a fresh workspace (one orchestrator, the Spring services catalog and orders, generated resources, `tls:init --dev`, `docker:init --vendor`) plus a test identity provider, PostgreSQL, Redis and RabbitMQ from an override file. Images built, stack started with `docker compose up -d --wait`, every service healthy on its first start. A JWT from the identity provider is verified by the orchestrator, forwarded over verified HTTPS, verified again by the Spring service, and the request reads and writes PostgreSQL with the caller as author. Refused: no token, expired, wrong issuer, wrong audience, invalid signature (401 at the gateway), missing scope (403 at the gateway), missing role (403 at the service). TLS: a certificate from another authority, a wrong name, or no configured authority give 502; without TLS the orchestrator exits 1. Recovery of Redis and of the identity provider, key rotation, restart of single services, a 12 s request completing under a 15 s grace period with exit 0, stop and start of the whole stack |

## What was not verified

- The stack validation is part of the release approval run (`--release`), not of `npm test` or of the regression gate without `--release`: it builds images and takes several minutes. Without `--vendor` the builds cannot succeed from a clean checkout, because they must download the PSO artifacts (`com.pso:*` for Spring, `@pso/*` for Node) from a registry and those are not published.
- Mutual TLS inside Compose (it is verified outside Compose: [service identity](/security/service-identity)), an expired service certificate inside Compose (verified outside it), a public identity provider, and Kafka as the broker of the stack.
- Any registry push, multi-architecture build or vulnerability scan of the images.

> [!WARNING]
> Until the PSO artifacts are published, build the orchestrator image with the packages vendored or from a private registry (the tarballs from `node scripts/release.mjs npm` can be installed from a file or registry), and build Spring images against a repository your build can reach (the file repository from `node scripts/release-maven.mjs`, or your own). The Dockerfile comments say the same.

## Variations

| Need | Do |
|---|---|
| to inspect without writing files | `pso docker:init --dry-run` |
| an image build that does not need this machine's PSO packages | `pso docker:init --vendor --force`: packs the `@pso/*` packages the service uses into `<service>/vendor/pso/*.tgz`, points `package.json` at them with relative paths and makes the Dockerfile copy `vendor/` before `npm install`. Commit `vendor/`. Without it, `docker:init` prints a `WARNING` naming the dependencies that resolve to a path on this machine |
| the same for a Spring service | the same command copies the `com.pso:*` artifacts of the service's `<pso.version>` from the local Maven repository (`pso java:install` puts them there; `--maven-repo <dir>` names another one) into `<service>/vendor/maven`, and the Dockerfile seeds the build's local repository with them (`COPY vendor/maven /root/.m2/repository`). Third-party dependencies still come from Maven Central or your mirror. Commit `vendor/`. Outside Docker (CI, another checkout) copy `vendor/maven/.` into the local repository before building. Without it, `docker:init` prints a `WARNING` for each Spring service |
| to overwrite after editing | `--force` (a differing file is otherwise a conflict, never overwritten silently) |
| a different registry/tag for deployment | generate cloud descriptors with [deploy:init](/devops/cloud-descriptors) |
| to expose the orchestrator beyond loopback | put a TLS-terminating proxy in front rather than changing the bind ([TLS](/security/tls-and-mtls)) |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `required variable ... is missing a value` | copy `.env.example` to `.env` and fill it in |
| `pso docker:build`: the daemon is not running | start Docker Desktop; nothing was built |
| image build fails resolving `com.pso:pso-bom` or `@pso/http` | the artifacts are not published: run `pso docker:init --vendor --force` so the service carries them, or see the warning above |
| `The PSO Java artifacts <version> were not found` from `--vendor` | run `pso java:install` first, or pass `--maven-repo` |
| the vendored version is a `-SNAPSHOT` | fine for development images; for a release build fixed-version artifacts with `node scripts/release-maven.mjs`, set `<pso.version>` to that version and vendor again |
| a Spring service cannot reach `localhost:5432`, or its container restarts with a connection error | no `DB_URL` was given to the container: see [Infrastructure](#infrastructure-postgresql-redis-rabbitmq) |
| a Spring container with Dispatch enabled exits at start in the `prod` profile | production refuses an unauthenticated Dispatch: configure the keys and `pso.dispatch.trust.mode`, see [publisher authentication](/dispatch/security-and-observability) |
| the container is `unhealthy` | check `docker logs <container>`; the Spring service needs `HOST=0.0.0.0` and the `PSO_JWT_*` variables in `prod` |
| the service cannot write a file | `read_only: true`; write only to `/tmp` or a declared volume |

## Next steps

- [CI/CD](/devops/ci-cd)
- [Cloud descriptors](/devops/cloud-descriptors)
- [Production checklist](/security/checklist)
