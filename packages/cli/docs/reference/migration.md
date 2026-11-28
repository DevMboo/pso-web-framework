---
title: Version migration
description: How schema versions are handled when upgrading, a procedure for upgrading a workspace safely, and a checklist of behavior that changed in recent framework work that generated projects may need to adopt.
order: 41
keywords: [migration, upgrade, schemaVersion, upgrade checklist, regenerate]
related: [concepts/configuration, orchestrator/dto-validation, devops/logging, reference/environment-variables]
---
Workspace and manifest files carry `schemaVersion` (currently `1`). A file with another version is rejected with `PSO_SCHEMA_VERSION` rather than being interpreted loosely.

Upgrading generated projects is manual: re-run generators with `--dry-run` to see differences, then use `--force` only for files you have not edited.

Only the current documentation version is published; `docs/versions.json` lists the available versions and the selector in the header navigates between them when more exist.

## An upgrade procedure

1. **Commit** your current state so the upgrade is a reviewable diff.
2. Update a portable installation with the trusted package of the new release (for rc.8: `pso update install --package <extracted-zip>\.pso-install\packages\0.2.0-rc.8.psopkg`, from the ZIP on [Downloads](/downloads/index)), or update and rebuild a framework checkout. Run `pso java:install` after changing releases if you use Spring services ([installation](/getting-started/installation)); the installed rc.8 CLI uses `com.pso:*:0.2.0-rc.8`, while this source checkout builds its own `0.1.0-SNAPSHOT` artifacts.
3. `pso validate` and `pso config:validate`: new rules show up as diagnostics, not as run-time surprises.
4. Preview changes to generated files with the generators' `--dry-run`, e.g. `pso docker:init --dry-run`. A differing file is reported as a conflict and never overwritten silently.
5. Apply what you want by hand or with `--force` for files you never edited; review the diff.
6. Run `pso test` and your own checks, then a short smoke run (`pso dev --smoke`).

An installed distribution keeps its previous verified package for `pso update rollback`. Rolling back the CLI does not automatically undo workspace migrations: back up or commit each workspace before `pso workspace:migrate --apply`, and use [structure:inspect](/architecture/structure-migration) before manually moving application files. The unsigned rc.7 installer is not an upgrade path.

## What changed that generated projects may want to adopt

Nothing below changes the behavior of existing code without you opting in, except where stated.

| Area | Change | What to do |
|---|---|---|
| Request bodies | `@Body(MyDto)` validates against a `@Dto` class; `@Body()` is unchanged | opt in per route ([DTO validation](/orchestrator/dto-validation)) |
| `pso make:dto` | now generates a `@Dto()` class and accepts `--fields`; `make:route` accepts `--dto` | regenerate only new DTOs; existing empty classes keep working with `@Body()` |
| Errors | RFC 9457 `application/problem+json` with stable `code` and `correlationId`; the legacy `error` member is kept | clients that read `error` keep working; prefer `code` |
| Spring error handling | the template's own exception handler was replaced by the starter's problem advice (the legacy `fields` member of validation errors is kept) | delete a copied handler that duplicates it |
| Logging | orchestrator output is pretty on a terminal and JSON otherwise; `PSO_LOG_LEVEL/FORMAT/COLOR`; Spring services log `[service,correlationId,traceId]` and JSON in `prod`/`staging` | if you parse logs, set `PSO_LOG_FORMAT=json` ([logging](/devops/logging)) |
| Correlation ids | a well-formed incoming `x-correlation-id` is kept (8 to 64 characters of `A-Z a-z 0-9 . _ -`), otherwise replaced | clients that sent ids now see them returned |
| Spring Dockerfile | the runtime user has a numeric uid (10001) so Kubernetes can verify non-root | regenerate with `docker:init --dry-run` and merge |
| Ports | `pso create service --port <n>` | optional |
| Configuration | `logging.level` is a schema key; `PSO_LOG_FORMAT`/`PSO_LOG_COLOR` are variables | none |
| Telemetry | OTLP export defaults to protobuf; exporter packages were updated | see [observability](/devops/observability) |

## Edge protection and Channels origins (0.2.0-rc.8)

From rc.7, after updating the CLI and running `pso java:install`:

1. Set `<pso.version>` of each Spring service to the new release.
2. `pso infra:plan --env <env>` shows two updates: the edge configuration (`nginx:edge`) and the compose file. `pso infra:apply --env <env>` applies them (a development `pso docker:up` does it itself).
3. `pso docker:up --env <env>`: the first start builds the framework's edge image once (it needs Docker Hub and Alpine's package repository), has nginx test the new configuration, then re-creates the edge and the orchestrator. FEIs and MEIs are not regenerated.
4. Remove workarounds you may have added: error pages, `server_tokens` or header rules in an application, a FEI or `.infra/`, and a hand-set `PSO_CHANNELS_ALLOWED_ORIGINS` that only repeated the shells' origins (the engine sets it now; a value you set yourself is kept).
5. `pso channels:enable --service <orchestrator>` now refuses to run until the orchestrator has a Dispatch provider (`pso dispatch:install <provider> --service <orchestrator>`); an orchestrator already connected to Channels is not affected.
6. `pso infra:validate --env <env> --probe` checks that plain HTTP and unknown hosts are answered without naming the software. To go back to rc.7, run rc.7's `pso infra:apply` and `pso docker:up`: its own edge configuration and image return.

## Native infrastructure (0.2.0-rc.7)

From rc.5 or rc.7, after updating the CLI and running `pso java:install`:

1. Set `<pso.version>` of each Spring service to the new release.
2. `pso infra:plan --env <env>` shows what the new release adds: the certificate and configuration of the pso-dev key server (`idp`), and updated compose, edge and process-environment files. `pso infra:apply --env <env>` applies it (a development `pso docker:up` does it first by itself).
3. `pso docker:up --env <env> --vendor` (or `pso docker:build --vendor`): an outdated `vendor/maven` or `vendor/pso` is refreshed in place. Do not delete it by hand.
4. Remove the workarounds rc.5 and rc.7 needed: starting the edge first (`docker:up --service edge --no-deps`), attaching a service to the edge network (`docker network connect`), Redis and broker containers in a compose file of your own, and scripts that removed `PSO_JWT_JWKS_URI` before `pso dev`. Declare what the application needs in `pso.infra.json` instead: `redis.clients`, `services.<name>.environment`, `replicas`, and `authentication: "application"` for a service that validates tokens with its own keys ([contract](/infrastructure/contract)).
5. `pso dev:env --service <name>` shows where every variable of a local process comes from.

## Workspace layout (0.2.0-rc.5)

New workspaces have a mandatory directory layout: `.infra/`, `orchestrators/`, `services/`, `frontends/`, `frontends/modules/`, `shared/`,
`docs/` and `tests/` ([first workspace](/getting-started/first-workspace)). The generators place every project there and register its path.

An existing workspace keeps working unchanged: PSO finds every project through its `path` in `pso.workspace.json`, and new projects of a
flat workspace follow the existing ones, so one workspace never mixes both layouts. PSO never moves a project directory.
`pso structure:inspect` lists the moves to the standard layout; to adopt it:

1. stop what runs (`pso dev`, `pso docker:down`) and commit;
2. move each directory as listed (for example `catalog` to `services/catalog`, `frontend/mei-orders` to `frontends/modules/mei-orders`);
3. change each `path` in `pso.workspace.json` accordingly;
4. run `pso infra:apply` (compose files and environments are generated from the paths) and `pso validate`.

## Application structure (0.2.0-rc.2)

Existing projects keep their structure and keep working: nothing is moved or rewritten by an upgrade.

| Area | Change | What to do |
|---|---|---|
| New projects | `pso create service` / `orchestrator` use the official structure with the reference CRUD | `--template empty` for no example; `--structure legacy` for the 0.1 layout |
| 0.1 projects | recognised as `legacy`; generators write in their structure | to adopt the official one: `pso structure:inspect`, then move the files yourself ([structure migration](/architecture/structure-migration)) |
| Mixed projects | refused with `PSO_STRUCTURE_MIXED` | keep one structure per project |
| `make:crud`, `make:entity`, `make:interceptor`, ... | generate the official structure only | a 0.1 project uses its own generators (`make:resource`, `make:dto`) |
| Layered services | Hibernate `validate`, unknown JSON properties refused | add `spring.jackson.deserialization.fail-on-unknown-properties: true` to an older layered service before `make:crud` relies on it |

## Changes of the developer experience release (2026-11-14)

| Area | Change | What to do |
|---|---|---|
| CLI arguments | unknown options, missing values and extra arguments are usage errors (exit 2) instead of being ignored | fix the invocation the message names; a script that passed an unused option (for example `--guard` to `pso make:middleware`) drops it |
| `pso migrate` | previews and, with `--apply`, updates files PSO generated earlier (the fixed 10 s shutdown timer of older `main.ts` files becomes `shutdownOnSignals(app)`); it also reports the unused `outbox_event` table of older PostgreSQL services and changes nothing about it | run `pso migrate`, read the preview, then `pso migrate --apply` |
| TLS by default | `pso docker:init` generates HTTPS between the orchestrator and the Spring services; plain HTTP only with `--transport plaintext` | `pso tls:init --dev` (development) or your own certificates in `./tls`, then `pso tls:check` |
| Upstream prefix | in containers the orchestrator needs `PSO_UPSTREAM_<NAME>_PREFIX` next to `PSO_UPSTREAM_<NAME>` | regenerate with `pso docker:init --dry-run` and merge, or add the variable by hand |
| JWKS at start-up | the orchestrator loads the keys within `jwks.initDeadlineMs` (20 s, with backoff) instead of failing on the first error; a private identity provider needs `jwks.privateHosts` and, with a private authority, `jwks.caFile` | set `PSO_JWT_JWKS_PRIVATE_HOSTS` / `PSO_JWT_JWKS_CA_FILE` where the provider is on a private network |
| Spring JWKS | Spring services apply the same private-network rule (`pso.security.jwt.private-hosts`) and never follow a redirect of the JWKS endpoint | **required** when the identity provider is on a private network: set `PSO_JWT_JWKS_PRIVATE_HOSTS=host:port` (the generated compose file passes it); a public provider needs nothing |
| Remote errors | an unhandled remote 404 / 409 from `PsoHttpClient` answers 404 / 409 (`PSO_UPSTREAM_NOT_FOUND`, `PSO_UPSTREAM_CONFLICT`), another 4xx `502 PSO_UPSTREAM_REJECTED`; they used to be `502 PSO_UPSTREAM_BAD_GATEWAY` | clients that matched on that 502 for a remote 4xx adjust; services may translate with `PsoHttpException.isStatus` |
| `pso security:check`, `pso lint` | evaluate `PSO_ENV` or `development` by default (it was `production`), reading the project's `.env` files for non-production environments | pipelines that validate production pass `--env production` |
| `pso deploy` | the SNAPSHOT rule reads the service version and `<pso.version>` (it read the Spring Boot parent) | a development deployment passes `--allow-snapshot`; a release uses fixed versions |
| `pso dev` | every service gets its own environment files; `<workspace>/.env` is no longer part of a development session by accident | move per-service settings to `<service>/.env`, shared ones to `.env.development` |
| PostgreSQL template | new services have no `V1__outbox.sql`; their first migration is `V1` | nothing for existing services (keep the applied migration) |
| Development keys | `tls/<service>/tls.key` is mode `0600`; the compose file runs containers as `PSO_CONTAINER_USER` | Linux: `PSO_CONTAINER_USER=$(id -u):$(id -g)` in `.env` |
| Generators | `make:provider` and `make:hook` write injectable classes and take `--module`; `make:event` / `make:listener` are local Spring events; `make:dispatch-event` / `make:dispatch-handler` are new | files generated earlier are untouched |
| Dispatch tests | `pso dispatch:install` sets `pso.dispatch.provider: memory` in `application-test.yml` | a test that must use the broker sets `pso.dispatch.provider` itself |

New and additive, nothing to do unless you want them: `UpstreamClient` and `metadata.services`, lifecycle hooks, `pso types`, `pso idp:dev`, PEM files for `PsoHttpClient` TLS, `logging.errorDetails`. Existing `ROUTES.pso.ts`, `MODULE.pso.ts`, controllers, DTOs, guards and `Upstream.forward` calls need no change.

## When you must regenerate

Rarely. If a generated file diverged from a template (a Dockerfile, a Compose file, a CI workflow) and you want the new template, generate with `--dry-run`, compare, and merge by hand; keep your edits. Never use `--force` on a file you changed unless you have committed first.

## Common mistakes

- Using `--force` across the whole project.
- Upgrading the CLI and not rebuilding it (the global command runs the old compiled code).
- Skipping `pso validate` after upgrading: new diagnostics are the upgrade's report.

## Next steps

- [Installation](/getting-started/installation)
- [Troubleshooting](/reference/troubleshooting)
