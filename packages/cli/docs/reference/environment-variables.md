---
title: Environment variables and naming rules
description: Every environment variable PSO reads, the canonical configuration key behind it, and the naming rules that keep configuration consistent.
order: 7
status: stable
keywords: [environment, variables, PSO_CFG, configuration, naming, MAX_BODY_BYTES, PSO_JWT_ISSUER, PSO_HOME]
related: [concepts/configuration, devops/environment-configuration, security/rate-limiting]
---
## Naming rules

1. **Configuration keys** are camelCase paths in `pso.config.json` (`http.limits.maxBodyBytes`). The path is the canonical name.
2. **Any key can be set from the environment** as `PSO_CFG_<path with __ between segments>`, for example `PSO_CFG_http__limits__maxBodyBytes=2097152`.
3. **Product variables** are `PSO_<AREA>_<NAME>` in UPPER_SNAKE_CASE (`PSO_JWT_ISSUER`, `PSO_OTEL_TRACES`).
4. **Standard names are kept as they are** where an ecosystem defines them: `PORT`, `HOST`, `NODE_ENV`, `OTEL_*`.
5. **Short legacy names** (`MAX_BODY_BYTES`, `UPSTREAM_TIMEOUT_MS`, ...) are still read for compatibility. Each maps to a canonical key; new documentation and generated files use the canonical key. If both are set, the precedence in [configuration](/concepts/configuration) applies.
6. Secrets are never values in files: use `${env:NAME}` references.

## Node orchestrator and CLI

| Variable | Canonical key / purpose |
|---|---|
| `PORT`, `HOST` | listen port and address (the generated container descriptors set `HOST=0.0.0.0`) |
| `NODE_ENV`, `PSO_ENV` | environment name; `production` refuses unsafe settings |
| `PSO_WORKSPACE` | path of `pso.workspace.json` for a service started outside the workspace |
| `PSO_SERVICE` | name of the service this process is (set by `pso dev`) |
| `PSO_HTTP_TLS_CERT_FILE`, `PSO_HTTP_TLS_KEY_FILE` | 0.2.0: the orchestrator terminates TLS itself with these PEM files (set together; the generated container topology uses them behind the edge) ([security model](/infrastructure/security-and-certificates)) |
| `PSO_HTTP_TLS_CLIENT_CA_FILE` | 0.2.0: with inbound TLS, also require a client certificate issued by this authority (mutual TLS) |
| `PSO_JWT_JWKS_TRUSTED_HOSTS` | a JWKS host that differs from the issuer's host, bound to it explicitly (the generated topology fetches keys from the identity provider's internal name) |
| `PSO_INFRA_ENV` | the infrastructure environment the `infra:*`, `docker:*` and `dev` commands use when `--env` is absent ([contract](/infrastructure/contract)) |
| `PSO_SECRET_<NAME>` | the value of the declared secret `<name>` for an environment whose secret provider is `env` (never written by PSO) |
| `PSO_HOME` | installation root for `setup`, `integrity`, `repair`, `update`, `uninstall` (when not given, an installed `pso` uses the installation it runs from) |
| `PSO_LAUNCHED_FROM` | set by the launcher of an installed distribution (`bin/pso-launch.mjs`) to its own installation root; used by the maintenance commands after `--root` and `PSO_HOME`. Not meant to be set by hand |
| `PSO_RECIPIENT_HOME` | directory of your recipient identity (the key that opens encrypted releases). Default `%LOCALAPPDATA%\PSO\recipient` on Windows, `~/.pso/recipient` elsewhere. It holds your public key, the pinned signer fingerprints and your private key **protected** (Windows DPAPI for your account, or a passphrase); see [Recipient keys](/devops/distribution-and-installation) |
| `PSO_RECIPIENT_PASSPHRASE` | the passphrase of a passphrase-protected recipient identity, for non-interactive use (never put it in a file you keep) |
| `PSO_ORCHESTRATOR_URL` | frontend development: where the dev servers proxy `/api` (default `http://localhost:<orchestrator port of the workspace>`); read by `pso frontend:dev` and the generated rspack configuration; never used by a production build ([frontend](/frontend/getting-started)) |
| `PSO_BASE_PATH`, `PSO_FRONTEND_MODE`, `PSO_ALLOW_DEV_TOKEN` | frontend build: the base path the shell is served under, `production` for a production build, and `1` to build a validation shell that accepts a pasted development token (shows a warning banner); set by `pso frontend:build` ([releases](/frontend/releases)) |
| `PSO_MEI_STANDALONE`, `PSO_FEI_PORT` | frontend development: `1` starts a microfrontend with the development host adapter; the shell's port, used to allow only that origin in a microfrontend dev server; set by `pso frontend:dev` |
| `PSO_CLOUD_HOME` | local state of Cloud Lifecycle and Operations on the machine running the CLI or Studio: connections, pinned SSH host keys, local audit (default `~/.pso-cloud`; `PSO_HOME` is the installation root and is not used for this) ([credentials](/cloud/credentials-and-security)) |
| `PSO_CREDENTIAL_PROVIDER`, `PSO_CREDENTIAL_PASSPHRASE`, `PSO_CREDENTIAL_KEYFILE` | choose the credential store explicitly (`encrypted-file`) and give it its key. Without a native store and without these, PSO refuses to store secrets: there is no plain-text fallback ([credentials](/cloud/credentials-and-security)) |
| `PSO_AGENT_HOME`, `PSO_AGENT_ENTRY` | on the server: where the runtime agent keeps its identity, state and releases (default `~/.pso-agent`), and the agent file its detached deployment workers run again ([the agent](/cloud/agent-and-enrollment)) |
| `PSO_OSV_SCANNER` | on the server or build host: the OSV-Scanner executable for the optional Java dependency scan, when it is not on `PATH` ([security](/cloud/release-signing)) |
| `PSO_NGINX_BIN` | on the server: the nginx binary, when it is not in a standard location ([nginx](/cloud/nginx-and-existing-infrastructure)) |
| `PSO_SSH_SECRET` | internal: set only in the environment of the one `ssh` child process PSO starts for a password or key passphrase, and read by its one-process askpass helper. Never set it yourself, and never put a secret in a command line ([credentials](/cloud/credentials-and-security)) |
| `PSO_ENVIRONMENT`, `PSO_APP`, `PSO_RELEASE`, `PSO_SLOT`, `PSO_SLOT_TOKEN`, `PSO_SERVICE_<NAME>_URL` | set by the agent on services it deploys: the environment and application, the release and slot, the random identity token that proves a process is the one PSO started, and the stable loopback address of each service of the deployment ([deploy a release](/cloud/deploy-a-release)) |
| `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, `PSO_JWT_JWKS_URI`, `PSO_JWT_PUBLIC_KEY_FILE`, `PSO_JWT_ALGORITHMS` | `security.authentication.issuer`, `.audience`, `.jwks.uri`, `.publicKey.file`, `.algorithms` ([authentication](/security/authentication)) |
| `PSO_JWT_JWKS_PRIVATE_HOSTS`, `PSO_JWT_JWKS_CA_FILE` | an identity provider on a private network or with a private certificate authority ([authentication](/security/authentication#an-identity-provider-on-a-private-network)) |
| `PSO_JWT_JWKS_TIMEOUT_MS`, `PSO_JWT_JWKS_CONNECT_TIMEOUT_MS`, `PSO_JWT_JWKS_INIT_DEADLINE_MS` | the bounds of the start-up key load ([authentication](/security/authentication#loading-the-keys-at-start-up)) |
| `PSO_TLS_DIR` | read by the generated `docker-compose.yml`: the directory with the TLS material of the stack, default `./tls` ([Docker](/devops/docker)) |
| `PSO_FORWARD_CREDENTIALS` | `none` stops forwarding bearer tokens to upstreams (`security.propagation.forward`) |
| `PSO_DIAGNOSTICS_TOKEN` | enables `/_pso/telemetry` (at least 32 characters) |
| `PSO_OTEL_TRACES`, `PSO_OTEL_EXPORT_INTERVAL_MS`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME` | OpenTelemetry export; off unless an endpoint is set |
| `PSO_LOG_LEVEL`, `PSO_LOG_FORMAT`, `PSO_LOG_COLOR`, `NO_COLOR`, `FORCE_COLOR` | `logging.level`, `logging.format`, `logging.color`; see [logging](/devops/logging) |
| `PSO_LOG_ERROR_DETAILS` | `logging.errorDetails`: `true` logs the message and the stack of an unexpected error (development diagnostics). Off by default, set by `pso dev`, never honoured in production ([logging](/devops/logging#unexpected-errors)) |
| `PSO_UPSTREAM_<NAME>` | `host:port` of the upstream service `<name>` when the orchestrator runs without the workspace file (containers). `<NAME>` is the service name in upper case with `-` written as `_` |
| `PSO_UPSTREAM_<NAME>_PREFIX` | the endpoint prefix of that service (its `pso.service.prefix`, for example `/users`). **Required with `PSO_UPSTREAM_<NAME>` whenever the service has a prefix**: the workspace file is not there to supply it, and without it every forwarded path misses the prefix and the service answers 404. `pso docker:init` writes it |
| `PSO_UPSTREAM_<NAME>_TLS`, `_TLS_CA_FILE`, `_TLS_CERT_FILE`, `_TLS_KEY_FILE`, `_TLS_KEY_PASSPHRASE`, `_TLS_SERVER_NAME` | TLS and mutual TLS to that upstream (`http.upstreams.<name>.tls.*`; the passphrase is environment only) ([TLS and mTLS](/security/tls-and-mtls)) |
| `PSO_UPSTREAM_<NAME>_FORWARD`, `_AUDIENCE`, `_ALLOW_PLAINTEXT` | whether the caller's bearer token is forwarded to that upstream, the audience it must carry, and the explicit permission to reach it over plain HTTP in production ([upstream clients](/orchestrator/upstream-clients)) |
| `PSO_CONFIG_STRICT` | `true` makes an unknown configuration key an error (CI); `false` keeps warnings even in production; unset: strict exactly in `production` ([configuration](/concepts/configuration)) |
| `PSO_READINESS_OPTIONAL`, `PSO_READINESS_INTERVAL_MS`, `PSO_READINESS_TIMEOUT_MS` | `http.readiness.optional` (dependencies that do not fail readiness: `dispatch`, `channels`, `rateLimit`), `http.readiness.intervalMs`, `http.readiness.timeoutMs` ([health](/devops/health-and-observability)) |
| `PSO_SHUTDOWN_GRACE_MS` | `http.shutdown.graceMs`: how long requests already running may take to finish after shutdown starts (default 5000, 0 to 300000; [runtime lifecycle](/concepts/runtime-lifecycle)) |
| `PSO_SHUTDOWN_CLEANUP_MS` | `http.shutdown.cleanupMs`: how long releasing Channels, Dispatch and the other dependents may take after that (default 10000, 1000 to 120000). The generated `main.ts` ends the process with exit code 1 once grace + cleanup + 1 s have passed |
| `PSO_DISPATCH_ENABLED` | `dispatch.enabled` |
| `PSO_DISPATCH_TRUST_MODE` | `dispatch.trust.mode`: `off`, `permissive` or `required` ([publisher authentication](/dispatch/security-and-observability)) |
| `PSO_DISPATCH_ALLOW_UNAUTHENTICATED` | **insecure, legacy migration only.** Exactly `true` lets a production service start with `dispatch.trust.mode` `off`; reported at every start; grants nothing to consumers that require a verified publisher (Spring: `pso.dispatch.allow-unauthenticated`) |
| `PSO_DISPATCH_SIGNING_KEY` | this service's Dispatch signing key (at least 32 characters; environment only) |
| `PSO_DISPATCH_TRUST_KEY_<SERVICE>` | the key of a publisher this service verifies (`users-service` is `PSO_DISPATCH_TRUST_KEY_USERS_SERVICE`; comma separated while rotating; environment only) |
| `PSO_DISPATCH_IDEMPOTENCY_STORE`, `PSO_DISPATCH_IDEMPOTENCY_REDIS_URL` | `dispatch.idempotency.store` (`auto`, `memory`, `redis`) and `dispatch.idempotency.redisUrl` ([reliability](/dispatch/reliability)) |
| `PSO_DIST_SIGNING_KEY_FILE` | path to the Ed25519 private key `pso dist pack` signs with (never the key itself) |
| `PSO_DIST_TRUST` | comma separated public keys trusted by `pso dist verify` |
| `PSO_NO_BROWSER` | any value stops `pso studio` from opening a browser |

## Channels

| Variable | Key | Meaning |
|---|---|---|
| `PSO_CHANNELS_ENABLED`, `PSO_CHANNELS_PATH`, `PSO_CHANNELS_ALLOWED_ORIGINS`, `PSO_CHANNELS_ALLOW_ANONYMOUS` | `channels.*` | endpoint and origin policy ([Channels](/orchestrator/channels)) |
| `PSO_CHANNELS_AUTH_TIMEOUT_MS`, `PSO_CHANNELS_HEARTBEAT_MS`, `PSO_CHANNELS_IDLE_TIMEOUT_MS` | `channels.*` | authentication deadline and liveness |
| `PSO_CHANNELS_MAX_CONNECTIONS`, `PSO_CHANNELS_MAX_SUBSCRIPTIONS`, `PSO_CHANNELS_MAX_MESSAGE_BYTES`, `PSO_CHANNELS_RATE_PER_SECOND`, `PSO_CHANNELS_BURST`, `PSO_CHANNELS_MAX_BUFFERED_BYTES` | `channels.*` | limits |
| `PSO_CHANNELS_BUS`, `PSO_CHANNELS_REDIS_URL`, `PSO_CHANNELS_REDIS_PREFIX`, `PSO_CHANNELS_ACK_SINGLE_INSTANCE` | `channels.bus`, `channels.redisUrl`, `channels.redisPrefix` | local or Redis fan-out; the acknowledgement lets production run the local bus with exactly one instance |
| `PSO_CHANNELS_BUS_SECRET`, `PSO_CHANNELS_BUS_SECRET_PREVIOUS` | environment only | shared secret of the orchestrator instances (at least 32 characters): bus messages are signed and an instance delivers only messages with a valid signature; the previous secret(s) are still accepted while rotating |
| `PSO_CHANNELS_BUS_ACCEPT_UNSIGNED` | `channels.busAcceptUnsigned` | **migration only**, needs the secret: this instance signs but still delivers unsigned bus messages (each one counted and logged) while other instances get the secret. The bus is not authenticated until it is removed |
| `PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED` | environment only | **insecure, legacy only.** Exactly `true` lets production start a Redis bus without `PSO_CHANNELS_BUS_SECRET`; reported at every start |
| `PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED` | environment only | **insecure, legacy only.** Exactly `true` lets the Dispatch bridge authorize a channel publication on the envelope's claimed `source` in production (without it an unverified publisher is refused) |
| `PSO_CHANNELS_TRUSTED_SOURCES` | `channels.trustedSources` | extra service names accepted as the source of a bus event, besides this service and each channel's publishers |

## HTTP limits (legacy name, canonical key)

| Variable | Key |
|---|---|
| `MAX_BODY_BYTES` | `http.limits.maxBodyBytes` |
| `MAX_HEADER_BYTES` | `http.limits.maxHeaderBytes` |
| `MAX_UPSTREAM_RESPONSE_BYTES` | `http.limits.maxUpstreamResponseBytes` |
| `MAX_CONCURRENT_REQUESTS` | `http.limits.maxConcurrentRequests` |
| `MAX_UPLOAD_BYTES` | `http.limits.maxUploadBytes` |
| `MAX_MULTIPART_PARTS` | `http.limits.maxMultipartParts` |
| `MAX_CONCURRENT_UPLOADS` | `http.limits.maxConcurrentUploads` |
| `MAX_CONNECTIONS` | `http.limits.maxConnections` |
| `REQUEST_TIMEOUT_MS` | `http.limits.requestTimeoutMs` |
| `HEADERS_TIMEOUT_MS` | `http.limits.headersTimeoutMs` |
| `KEEP_ALIVE_TIMEOUT_MS` | `http.limits.keepAliveTimeoutMs` |
| `UPSTREAM_TIMEOUT_MS` | `http.limits.upstreamTimeoutMs` |
| `UPSTREAM_RESPONSE_TIMEOUT_MS` | `http.limits.upstreamResponseTimeoutMs` |

## Spring Boot services

Spring settings are `pso.*` properties; these placeholders in the generated `application.yml` read the environment:

| Variable | Property |
|---|---|
| `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, `PSO_JWT_JWKS_URI`, `PSO_JWT_ALGORITHMS` | `pso.security.jwt.*` |
| `PSO_RATE_LIMIT_PER_MINUTE` | `pso.limits.requests.per-minute` |
| `PSO_JWT_JWKS_PRIVATE_HOSTS`, `PSO_JWT_JWKS_CA_FILE` | `pso.security.jwt.private-hosts`, `pso.security.jwt.ca-file`: an identity provider on a private network, or with a private certificate authority. The same two variables configure the orchestrator ([Spring security](/spring/security-and-cors)) |
| `PSO_CORS_ENABLED`, `PSO_CORS_ORIGINS` | `pso.security.cors.enabled`, `pso.security.cors.allowed-origins` |
| `PSO_SERVICE_PREFIX` | `pso.service.prefix` |
| `PSO_LOG_LEVEL`, `PSO_LOG_COLOR` | root log level; `spring.output.ansi.enabled` (`detect`, `always`, `never`) |
| `PSO_LOG_ERROR_DETAILS` | `pso.observability.error-details`: `true` logs the message and the stack trace of an unexpected exception. Off by default, set by `pso dev`, ignored with a production profile |
| `LOGGING_STRUCTURED_FORMAT_CONSOLE` | structured log format of the prod/staging profiles (`ecs`, `logstash`, `gelf`) |
| `DB_URL`, `DB_USER`, `DB_PASSWORD`, `DB_POOL_SIZE`, `DB_POOL_MIN_IDLE` | PostgreSQL connection and pool; see [PostgreSQL CRUD](/spring/postgresql-crud) |
| `PSO_TRACING_SAMPLING`, `PSO_OTEL_EXPORT_INTERVAL_MS` | `management.tracing.sampling.probability`, metric export interval |

## Docker Compose (generated deployment)

Read by the generated `docker-compose.yml`, from `.env` next to it (not by the applications):

| Variable | Purpose |
|---|---|
| `PSO_TLS_DIR` | the directory with the TLS material of the stack (default `./tls`) |
| `PSO_CONTAINER_USER` | the user the containers run as (`uid:gid`). Linux: the keys in `./tls` are readable by their owner only, so set it to that owner: `PSO_CONTAINER_USER=$(id -u):$(id -g)`. Windows and macOS (Docker Desktop): leave it unset |
| `PSO_STOP_GRACE_PERIOD` | how long Docker waits after SIGTERM; keep it longer than `PSO_SHUTDOWN_GRACE_MS` + 11 s |

## Development environment files

`pso dev` starts every project with its own environment, and the static commands (`pso security:check`, `pso security:validate`, `pso lint`) read the same sources. Lowest to highest priority:

| Source | Scope |
|---|---|
| `<workspace>/.env.<environment>` (for example `.env.development`) | every project of the workspace |
| `<project>/.env` | that project only |
| `<project>/.env.<environment>` | that project, that environment |
| the environment `pso dev` runs in | explicit: it always wins over files |
| `PORT`, `HOST`, `PSO_WORKSPACE`, `PSO_SERVICE` | set by `pso dev` from `pso.workspace.json`; a file cannot change them |

`<environment>` is `PSO_ENV` (default `development`). `<workspace>/.env` is **not** read: that file belongs to Docker Compose. For `production` no file is read at all. Details and examples: [environment configuration](/devops/environment-configuration).

## Preferred names and compatibility aliases

Names that changed keep working. New files and documentation use the preferred name; when both are set the preferred one wins.

| Preferred | Still accepted | Notes |
|---|---|---|
| `security.authentication.issuer`, `.audience`, `.jwks.uri`, `.publicKey.file`, `.algorithms` | `security.jwt.issuer`, `.audience`, `.jwksUri`, `.publicKeyFile`, `.algorithms` | the `PSO_JWT_*` variables set the preferred keys |
| `http.limits.maxBodyBytes`, `http.limits.upstreamTimeoutMs` | `server.maxBodyBytes`, `server.upstreamTimeoutMs` | file keys of early versions |
| `http.limits.*` and `http.rateLimit.*` in `pso.config.json`, or `PSO_CFG_http__limits__...` | `MAX_BODY_BYTES`, `UPSTREAM_TIMEOUT_MS`, `RATE_LIMIT_PER_MINUTE` and the other short names in the table above | the short names stay the highest-priority source |
| `PSO_JWT_JWKS_CA_FILE`, `PSO_JWT_JWKS_PRIVATE_HOSTS` (both runtimes) | `PSO_SECURITY_JWT_CA_FILE`, `PSO_SECURITY_JWT_PRIVATE_HOSTS` (Spring Boot's own binding of `pso.security.jwt.*`) | the generated `docker-compose.yml` sets both, so services generated by earlier versions keep working |
| `pso.http.client.services.<name>.tls.ca-file`, `cert-file`, `key-file` (PEM) | `tls.trust-store`, `tls.key-store` (PKCS12 or JKS) | either form; not both for the same purpose |
