---
title: The infrastructure contract and the .infra directory
description: Every member of pso.infra.json, the defaults PSO derives, the validation rules, and the layout and ownership of the managed .infra directory.
order: 2
status: implemented
keywords: [pso.infra.json, contract, environments, hosts, tls, secrets, identity, keycloak, mtls, redis, environment variables, authentication, volumes, replicas, .infra, state.json]
related: [infrastructure/overview, infrastructure/resource-lifecycle, infrastructure/hosts-and-environments, infrastructure/security-and-certificates]
---
`pso.infra.json` sits next to `pso.workspace.json`. It is optional: without it PSO uses one local development environment (`local`, domain `pso.localhost`, runtime `process`, development TLS and local secrets). `pso infra:init` writes a starting contract derived from the workspace.

## A complete example

This is the contract of the reference workspace (`fixtures/pso-reference`), validated by the tests:

```json
{
  "schemaVersion": 1,
  "defaultEnvironment": "local",
  "environments": {
    "local": { "kind": "development", "domain": "pso.localhost", "runtime": "docker", "httpsPort": 8443,
               "tls": { "source": "pso-dev-ca" }, "secrets": { "provider": "local" }, "dns": { "provider": "none" } },
    "staging": { "kind": "staging", "domain": "staging.pso.localhost", "runtime": "docker", "httpsPort": 9443,
                 "tls": { "source": "external", "dir": "./ops/staging/tls" },
                 "secrets": { "provider": "file", "dir": "/run/pso-staging-secrets" },
                 "dns": { "provider": "external" }, "deploy": { "target": "bundle" } }
  },
  "identity": { "provider": "keycloak", "realm": "pso-reference",
                "users": [ { "username": "ana", "scopes": ["catalog:read", "cart:write", "users:admin", "accounts:read"] },
                           { "username": "bob", "scopes": ["catalog:read", "cart:write"] } ] },
  "services": { "accounts": { "mtls": true } }
}
```

## Members

| Member | Meaning | Default |
|---|---|---|
| `schemaVersion` | always `1` | required |
| `defaultEnvironment` | the environment used when `--env` and `PSO_INFRA_ENV` are absent | the only one declared |
| `environments.<name>.kind` | `development`, `staging` or `production`: decides what PSO may generate | required |
| `environments.<name>.domain` | DNS suffix: a host label `shop` becomes `shop.<domain>` | required |
| `environments.<name>.runtime` | `process` (`pso dev`) or `docker` | `process` |
| `environments.<name>.hosts` | explicit fully-qualified names for a FEI (by its name), `api` or `identity` | derived |
| `environments.<name>.httpsPort` | public HTTPS port of the edge gateway | `8443` (development), `443` |
| `environments.<name>.publishServices` | development only: also publish every service container on `127.0.0.1:<port>` | `false` |
| `environments.<name>.tls` | `{ "source": "pso-dev-ca" }` or `{ "source": "external", "dir": "<directory in the PSO layout>" }` | development: `pso-dev-ca`; otherwise `external` |
| `environments.<name>.secrets` | `{ "provider": "local" \| "env" \| "file", "dir": "/run/secrets" }` | development: `local`; otherwise `env` |
| `environments.<name>.dns` | `{ "provider": "none" \| "hosts-file" \| "external" }`: PSO never creates DNS records | `none` |
| `environments.<name>.identity` | for an external provider: `issuer`, `jwksUri`, `authorizationEndpoint`, `tokenEndpoint`, `logoutEndpoint` (https) | - |
| `environments.<name>.deploy` | `{ "target": "docker" \| "bundle", "dockerContext": "<context>" }` | development: `docker`; otherwise `bundle` |
| `identity.provider` | `keycloak` (a container PSO configures), `pso-dev` (offline development tokens), `external`, `none` | `none` |
| `identity.realm`, `.host`, `.audience` | realm name, host label, the audience every token carries | workspace name, `auth`, `pso-api` |
| `identity.users` | development users (`username`, `scopes`): their passwords are generated secrets, never written here | - |
| `api.host` | host label of the API (the orchestrator through the edge) | `api` |
| `frontends.<fei>` | `host` label, `basePath` (`/admin/`), runtime sign-in `auth` (`oidc`, `dev-token`, `none`), OIDC `clientId` | `<fei without fei->`, `/`, `oidc` when an identity provider exists, the FEI name |
| `services.<name>` | `mtls: true` (the orchestrator must present a client certificate), `resources` (`memory`, `cpus`), `secrets` (declared secret names mounted as files) | - |
| `services.<name>.environment` | the application's own variables for that service: a plain value, or `secret://<declared secret>` (mounted as a file in a container, resolved by `pso dev` for a process; never written in a generated file) | - |
| `services.<name>.authentication` | `infrastructure` (the service validates tokens of the environment's identity provider, configured by PSO) or `application` (the application configures token validation itself; PSO gives this service no `PSO_JWT_*` setting) | `infrastructure` |
| `services.<name>.volumes` | persistent named volumes: `{ "uploads": "/var/lib/app/uploads" }` becomes the volume `<service>-uploads`, kept by `pso docker:down` | - |
| `services.<name>.replicas` | containers of the service in the docker runtime; the edge balances the orchestrator's instances | `1` |
| `services.<name>.healthcheck.startPeriod` | how long a slow start is tolerated before failed health checks count (`"90s"`) | `60s` Spring, `15s` Node |
| `environments.<name>.services.<service>` | what one environment changes for one service: `authentication`, `environment` (merged over the workspace-wide variables), `replicas` | - |
| `redis.clients` | the services that use Redis, as a list (each gets `REDIS_URL`) or `{ "<service>": ["REDIS_URL", "PSO_CHANNELS_REDIS_URL"] }` | no Redis |
| `redis.persistence`, `redis.resources` | append-only persistence in the volume `redis-data`; container limits | `true`; `256m`, `0.5` |
| `environments.<name>.redis` | `provider`: `container` (PSO runs it), `external` (the address is the supplied secret `redis-url`) or `none`; `port`: loopback port of the dependencies stack for `pso dev` | `container`, `6379` |
| `secrets.<name>` | declared application secrets: `description`, `generate: "random"` (development only) | - |
| `docker` | Compose `project` name, `logs` (`maxSize`, `maxFile`), default `resources`, `images` (`nginx` for the shells and the pso-dev key server, `postgres`, `keycloak`, `redis`; the edge always runs the framework's own image) | `<workspace>-<env>`, `10m`/3 |

### Redis, application settings and authentication

Redis is provisioned only where the workspace declares it. A minimal declaration for an orchestrator that uses PSO Dispatch and the Redis bus of PSO Channels, and a Spring service that publishes through the transactional outbox:

```json
{
  "redis": { "clients": { "gateway": ["REDIS_URL", "PSO_CHANNELS_REDIS_URL"], "catalog": ["REDIS_URL"] } },
  "secrets": { "channels-bus-secret": { "generate": "random" } },
  "services": {
    "gateway": { "environment": { "PSO_DISPATCH_ENABLED": "true", "PSO_CHANNELS_BUS": "redis", "PSO_CHANNELS_BUS_SECRET": "secret://channels-bus-secret" } },
    "catalog": { "environment": { "PSO_DISPATCH_ENABLED": "true" } }
  },
  "environments": { "local": { "kind": "development", "domain": "pso.localhost", "runtime": "docker", "services": { "gateway": { "replicas": 2 } } } }
}
```

The Redis container runs on the private network only, requires the password `redis-password` (generated in development, supplied elsewhere), keeps its data in the volume `redis-data` and is health-checked; every client waits for it. Each client receives the address with its credentials, the secret `redis-url`, in the variables it names. In a container that is a mounted file (`/run/secrets/<VARIABLE>`): a Spring service reads it as the property of that name (`${REDIS_URL}`), a Node service reads the files listed in `PSO_SECRET_FILES` into its variables when it starts. For a local process, `pso dev` resolves the address against the Redis of `pso dev --with-dependencies`.

`authentication: "application"` is for a service that validates tokens with keys of its own (for example a product that issues its own tokens): PSO then gives that service no identity setting, in containers and in processes, so the infrastructure's key source can never meet the application's. The application sets its own `PSO_JWT_*` variables, in `environment` or in the environment of `pso dev`.

## Rules the contract enforces

They are errors, not warnings, because each one would produce an environment that is insecure or cannot work:

- `PSO_INFRA_TLS_PRODUCTION`: production cannot use the development authority. `PSO_INFRA_SECRETS_LOCAL`: staging and production cannot keep secrets in PSO's local store.
- `PSO_INFRA_SECRET_IN_CONTRACT`: a member named like a value (`value`, `password`, `secret`, `key`) under `secrets`, or a credential on a development user. The contract is committed; values are not.
- `PSO_INFRA_IDENTITY_DEV`: the `pso-dev` identity cannot serve a production environment. `PSO_INFRA_DEV_TOKEN_PRODUCTION`: `dev-token` sign-in is refused in production.
- `PSO_INFRA_HOST_CONFLICT`: two shells on one host with overlapping base paths (a shell at `/` would swallow `/admin/`), or a shell on the API's or the identity provider's host.
- `PSO_INFRA_UNKNOWN_SERVICE`, `PSO_INFRA_UNKNOWN_FRONTEND`, `PSO_INFRA_UNKNOWN_SECRET`: the contract names something the workspace does not declare.
- `PSO_INFRA_RESERVED_NAME`: a service named `edge`, `idp`, `redis`, `*-db` or `*-client` would collide with the generated topology.
- `PSO_INFRA_ENV_RESERVED`: `environment` (or `redis.clients`) names a variable PSO manages (`PORT`, `HOST`, `PSO_UPSTREAM_*`, `PSO_HTTP_TLS_*`, `SERVER_SSL_*`, `DB_URL`, `SPRING_CONFIG_IMPORT`, `PSO_SECRET_FILES`, ...), or an identity setting (`PSO_JWT_*`) of a service whose authentication is the infrastructure's. A typo in the contract can never switch TLS off or replace the identity provider.
- `PSO_INFRA_SECRET_IN_CONTRACT` also covers `environment`: a variable named like a credential (`*_PASSWORD`, `*_SECRET`, `*_TOKEN`, `*_API_KEY`, ...) with a plain value, a private key, a JWT or a URL with credentials. Declare a secret and write `secret://<name>`.
- `PSO_INFRA_REPLICAS`: several replicas in an environment that publishes every service on its own host port.

## The `.infra` directory

`.infra/` is managed by PSO and excluded from version control (`pso infra:apply` adds `.infra/` to `.gitignore` and writes `.infra/.gitignore`). Everything in it can be regenerated from the declarations, except development key material and secrets, which are reused on purpose.

| Path | Content | Sensitive |
|---|---|---|
| `ca/<env>/ca.crt`, `ca.key` | development certificate authority | key: yes |
| `certs/<env>/<name>/tls.crt`, `tls.key`, `ca.crt` | one certificate per container (`edge`, the orchestrator and its `-client` identity, each service, `idp`) | key: yes |
| `secrets/<env>/<name>` | development secrets (database passwords, Keycloak administrator, development users, API client) | yes |
| `identity/<env>/realm.json`, `signing-key.pem`, `jwks.json` | Keycloak realm (passwords are placeholders) or the pso-dev signing key and public keys | key: yes |
| `nginx/<env>/edge.conf`, `<fei>.conf` | edge gateway and shell static servers | no |
| `sites/<env>/<fei>/` | each shell's site root: published shell and microfrontend releases, `pso-runtime-config.json` | no |
| `docker/<env>/compose.yml`, `compose.deps.yml` | container topology; dependencies for local processes | no |
| `hosts/<env>.hosts` | proposed hosts entries | no |
| `env/<env>/<service>.env` | environment of a service as a local process (`secret://` references) | no |
| `state.json` | ownership, file hashes, facts (fingerprints, expiry), last provisioning | no secret |
| `journal/`, `state.lock` | interrupted-write records, the provisioning lock | no |
| `logs/infra.log` | operational log (redacted) | no secret |
| `backups/<tx>/` | hand-edited files replaced by `pso infra:repair` | as the original |
| `deploy/<env>/` | release records and bundles (configuration only) | no |

Key and secret files are readable by their owner only: mode `0600` on POSIX; on Windows the inherited access list is removed and only the current user and SYSTEM keep access. Docker Desktop reads such files through its file sharing (verified with the real nginx reading a restricted key).

## What goes wrong most often
- Putting a value in `secrets` or a password on a development user: refused (`PSO_INFRA_SECRET_IN_CONTRACT`). Values belong to the environment's provider.
- Declaring a staging environment with `tls.source: "external"` but a `tls.dir` that does not exist on the deployment host: the resources stay `external-unverified` locally and are listed as prerequisites by `pso deploy --env staging --dry-run`.
- Naming a service in `services` that the workspace does not declare (`PSO_INFRA_UNKNOWN_SERVICE`): the contract never creates a service.
