---
title: Migrating a 0.1 workspace to 0.2.0
description: What changes, what does not, the migration command with its inspection and its adoption of existing certificates and keys, and the behaviour changes to review.
order: 10
status: implemented
keywords: [migration, upgrade, 0.1, 0.2.0, workspace:migrate, adopt, compatibility, breaking changes]
related: [infrastructure/overview, infrastructure/contract, infrastructure/resource-lifecycle]
---
A 0.1 workspace keeps working with the 0.2.0 CLI without any change: `pso dev`, `pso validate`, `pso docker:init`, `pso docker:build` (with the root `docker-compose.yml`), `pso deploy --target native|compose` and the cloud commands behave as before. The infrastructure engine is adopted explicitly.

## Upgrading the CLI first

Download the `0.2.0-rc.6` portable ZIP ([Downloads](/downloads/index)), or update an installed distribution that trusts the same key with `pso update install --package <extracted-zip>\.pso-install\packages\0.2.0-rc.6.psopkg`. The rc.6 Windows installer is unsigned and unvalidated end to end, so it is not an upgrade path. See [Installation](/getting-started/installation) and [release integrity and Windows installation](/infrastructure/release-integrity-and-signing). Workspaces live outside the installation and are not touched by an update, rollback (`pso update rollback`) or removal of the portable folder.

## Preparing to migrate an application

Before running `--apply` on a real application workspace:

1. **Use the installed CLI**, not a framework checkout: `Get-Command pso -All` (PowerShell) or `type -a pso` (Git Bash) must resolve to the installation's `bin` ([installed and development CLI](/devops/installed-and-development-cli)), and `pso --version` must print 0.2.0.
2. **Commit or back up the workspace** (a clean `git status`), so every change the migration makes is a reviewable diff.
3. **Run the inspection** (`pso workspace:migrate`) and read every finding. `conflict`, `ambiguous`, `unmapped` and `exposed-extra` are decisions for you; only `add` is applied.
4. **Check the prerequisites of the environments you will use**: Docker Desktop running for `runtime: "docker"`, free edge port (8443 by default), and for staging or production the operator-supplied certificates and secret files on the host (`pso host:check --env <name>`).
5. **Apply**, then verify: `pso infra:plan` (no changes), `pso validate`, `pso docker:up --env local`, `pso infra:validate --probe`, and the application's own tests.
6. **Keep the backup** under `.infra/backups/migrate-<time>/` until the migrated application has been verified; reverting is restoring those files (or `git checkout`).

## The migration command

```bash
pso workspace:migrate              # inspection: nothing is written
pso workspace:migrate --apply      # migration
```

It **adds** and **adopts**; it never rewrites application code, declarations, DTOs, routes, dispatch contracts, data or the 0.1 generated files. The only edit to an existing file is the narrow, backed-up Spring security addition of step 5:

1. creates `pso.infra.json` (one local development environment; identity `keycloak` when a `keycloak/` directory exists, `pso-dev` when `pso idp:dev init` was used, otherwise `none`; `--identity` overrides it);
2. adopts a valid development TLS directory (`tls/` from `pso tls:init --dev`): the authority and every certificate it issued for a declared service are copied into `.infra/` and recorded as PSO-owned, so they are **reused, not regenerated** (`tls/` itself stays: the 0.1 compose file mounts it);
3. adopts the development identity key of `pso idp:dev` when the identity is `pso-dev`;
4. excludes `.infra/` from version control and provisions the local environment: only what is still missing is generated;
5. **Spring security**: for each Spring service, compares `pso.security.rules` in `application.yml` with the routes the orchestrator declares public. A declared public route that no rule makes public was answered with 401 by the service in 0.1 (secure by default); the migration appends only the missing `PUBLIC` rule at the end of the list, marked `# added by pso workspace:migrate (0.2.0)`, after a backup to `.infra/backups/migrate-<time>/`. Existing and custom rules are kept as they are and nothing is ever made public that no declaration asks for. Cases it cannot decide are reported, not changed:

   | Finding | Meaning | Action |
   |---|---|---|
   | `covered` | an existing rule already makes the route public | none |
   | `add` | the rule is missing | added by `--apply` |
   | `conflict` | an explicit rule gives the path another access | the developer's rule is kept; decide which side is right |
   | `ambiguous` | no `application.yml`, or a `pso.security.rules` block that cannot be read with certainty (flow style, unknown keys) | add the rule by hand (the message gives it) |
   | `exposed-extra` | a service rule makes `PUBLIC` a path the orchestrator protects | review; never removed automatically |
   | `unmapped` | no controller of the service maps the route (it may be forwarded elsewhere) | add the rule by hand if the service does serve it |

6. writes `.infra/migration-0.2.0.json` with what was reused, provisioned and added.

A workspace that already has `pso.infra.json` skips steps 1–4 and still runs step 5, so it can be re-run safely after an upgrade; a second run reports `Nothing to migrate.` Verified on the reference workspace with real HTTP: before, the declared public route answered 401; after, 200 without a token while the protected routes of the same service still required one.

It refuses to run when the frontend declarations have errors. It was verified on a copy of the 0.1 Commerce workspace: no application file changed, and the environment was complete afterwards (`pso infra:plan`: 0 changes).

## Behaviour changes to review

| Change | Why | What to do |
|---|---|---|
| A workspace may have several FEIs | independent shells | commands that act on one shell take `--fei` when there are several (`fei:register`, `fei:unregister`, `frontend:dev`, `frontend:config`) |
| `security.authentication: "none"` with microfrontends that need scopes is an error (`PSO_FEI_AUTH_CONTRADICTION`) | nobody could ever enter them | enable authentication or remove the scopes |
| A public route with scopes, or `public` contradicting `meta.public`, is an error | one route, one access decision | keep one spelling; public routes need no scopes |
| `pso fei:register --scopes` also adds the scopes to the MEI's `security.scopes` | the two lists are one decision | review the MEI declaration diff |
| `pso make:resource --public` declares the rule in the Spring service too | the service is secure by default and kept answering 401 | services generated before 0.2.0: `pso workspace:migrate --apply` adds the missing rules (step 5) |
| `pso docker:build` uses the 0.2 topology once `pso.infra.json` exists | one source of truth | the root `docker-compose.yml` keeps working with `pso deploy --target compose` |

New runtime options (all opt-in): orchestrator inbound TLS (`PSO_HTTP_TLS_CERT_FILE`, `PSO_HTTP_TLS_KEY_FILE`, `PSO_HTTP_TLS_CLIENT_CA_FILE`).

## What goes wrong
- `note: pso.infra.json exists`: the infrastructure steps were done before; only the Spring step runs.
- A Spring `conflict`: the migration never weakens or rewrites an existing rule; decide which side is right and edit it yourself.
- A `tls/` authority without its key, expired, or certificates it did not issue are not adopted: the migration says so and the local environment gets new development material.
- Frontend declarations with errors block the migration: fix them with `pso frontend:validate` first.
