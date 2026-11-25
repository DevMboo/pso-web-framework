# PSO Web Framework: implementation status

Current release: **`0.2.0-rc.5`** ([GitHub release](https://github.com/DevMboo/pso-web-framework/releases/tag/v0.2.0-rc.5); release candidate, Authenticode-unsigned; the CLI reports `0.2.0`). The user documentation is
https://devmboo.github.io/pso-web-docs/; this page summarises what exists, what does not, and how it is verified. The authoritative lists
of unimplemented commands and capabilities are in `packages/cli/src/unimplemented.ts`, which the documentation and the AI contexts read and
which `packages/cli/test/docs-parity.test.ts` checks against the sources.

## Implemented

| Area | What exists |
|---|---|
| Structure and validation | static discovery that never executes application code; the official structures (modular TypeScript orchestrator, layered Java services) and the 0.1 layouts; `pso validate`, `pso structure:inspect`; deterministic manifests; stable diagnostic codes |
| Orchestrator (`@pso/http`, `@pso/security`) | mandatory declarative route registry (`MODULE.pso.ts`, `routes/ROUTES.pso.ts`), deny-by-default security, JWT/JWKS validation, scopes and roles, DTO validation, interceptors, RFC 9457 problems, rate limiting (local and Redis), outbound TLS and mTLS, OpenTelemetry export, service discovery by name |
| Spring Boot (`pso-java`) | starters for security, HTTP client (`PsoHttpClient`), data (JPA, Flyway, PostgreSQL), storage, channels, dispatch providers, rate limiting, observability and tests; strict typed `pso.*` configuration; the reference Product CRUD |
| Dispatch and Channels | events over Redis Streams, RabbitMQ or Kafka with contracts, retries, dead letters, idempotency and publisher authentication; the Spring transactional outbox; server-to-browser channels |
| Infrastructure engine | `pso infra:init`, `pso infra:plan`, `pso infra:apply`, `pso docker:up` and the related commands: certificates, secrets, identity provider (Keycloak or `pso-dev`), databases and containers for local environments, reconciled from `pso.infra.json` |
| Generators | `pso create`, `pso make:*` (including `make:crud`), generators for the layered Java packages and the modular orchestrator |
| Developer tools | Studio, the documentation portal and AI contexts (`pso docs`, `pso ai:context`, `pso ai:init`) |
| Deployment and distribution | native and Docker Compose deployment with health-checked activation and rollback; the deployment agent over SSH; signed `.psopkg` packages with integrity, repair, update and rollback; the Windows installer and portable ZIP |

## Not implemented

Commands that exit with code 2: `pso dispatch:health` (use `pso dispatch:doctor`).

Capabilities that do not exist in this version (from `UNSUPPORTED_CAPABILITIES`):

- Exactly-once event delivery (dispatch is at-least-once), delayed redelivery, a TypeScript transactional outbox, trace context inside
  the dispatch envelope and consumer-lag display in Studio.
- Inbound TLS termination in the orchestrator (put a TLS reverse proxy in front of it).
- Retries and circuit breakers for orchestrator upstream calls, CORS handling in the orchestrator, token revocation lists.
- Distributed transactions, sagas or a workflow engine.
- Applying deployments to Kubernetes, ECS, Container Apps or Cloud Run (descriptors are generated and checked only).
- Cloud providers other than SSH to a Linux server; PSO provisions no cloud resources.
- In Cloud Lifecycle and Operations: system-scope systemd units, resource limits on services, automatic TLS certificates and DNS or
  hosts-file changes, and a vulnerability database of its own (the Java dependency scan runs OSV-Scanner when it is installed).
  Release-signature verification, the systemd driver and static frontend deployment are implemented.
- Published packages on npm or Maven Central.
- A production identity provider (`pso idp:dev` is for development only).

Release executables are not Authenticode-signed yet, including `0.2.0-rc.5`
([code signing policy](https://devmboo.github.io/pso-web-docs/downloads/code-signing-policy.html)).

## Verified only in part

| Area | Verified | Not verified |
|---|---|---|
| Credential stores | Windows Credential Manager, encrypted file, Linux Secret Service (real gnome-keyring in a container) | macOS Keychain (no macOS test machine) |
| Cloud deployment | disposable Linux containers over SSH in the test suites; one owner-run validation on a cloud VM | public HTTPS through that provider's firewall; frontend deployment on that VM |
| Windows distribution | portable ZIP (21 checks), upgrade and rollback, the real installer and uninstaller once | Authenticode signing (no certificate); Smart App Control acceptance in general |
| Studio | every section in Chrome, including Cloud → Signing and Frontend operations | the Cloud section with a deployed static frontend |

## How it is verified

Every package has automated tests under `packages/*/test` and `pso-java/*/src/test`; the documentation is checked against the code
(commands, flags, decorators, generated files and recorded outputs). Suites that need Docker, a JDK, a browser or local brokers
(`node scripts/dispatch-brokers.mjs up`) skip themselves with a stated reason when the requirement is missing.

## Known gotchas

- Git Bash on Windows rewrites arguments such as `/customers` into `C:/Program Files/Git/customers`; the CLI rejects that. Use
  PowerShell or `MSYS_NO_PATHCONV=1`.
