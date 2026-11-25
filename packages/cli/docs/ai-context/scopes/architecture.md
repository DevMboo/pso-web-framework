---
title: Architecture rules
description: Principles, runtimes, workspace, discovery, manifests and lifecycle.
order: 2
scope: architecture
base: true
keywords: [ai, architecture]
---
## Principles

1. Convention over configuration, with explicit configuration when needed.
2. Static discovery: validation parses files, it does not execute them.
3. Deny by default for routes, guards and services.
4. Explicit versioned contracts between services; no shared domain entities.
5. Services are declared, never found by scanning; discovery is not authorization.
6. Deterministic output: sorted discovery, manifests with a sha256 digest and no timestamps.
7. Declared exposure: decorators never expose endpoints.

## Shape of a system

- One **Node.js + TypeScript orchestrator** (single public entry point, no domain logic) and any number of **Spring Boot microservices** (Java 21, own database, independent build).
- `pso.workspace.json` declares each service: `name`, `path`, `runtime` (`node` | `spring-boot`), `role` (`orchestrator` | `service`), `port`, `dependsOn`, `health`, optional `db`, optional `dev.command`.
- The orchestrator forwards guarded requests to services with a verified bearer token; services validate it again.

## Application structure (official, 0.2)

- Orchestrator: `src/.app/{configs,contracts,filters,guards,middlewares,interceptors,decorators}` for application-wide components; `src/modules/<module>/` with `MODULE.pso.ts`, `routes/ROUTES.pso.ts`, `controllers/`, `services/`, `providers/`, `contracts/`, `dto/request|response/`, `mappers/`; `src/shared/`; `src/main.ts` (bootstrap only). `tsconfig.json` must include `"src/.app/**/*"` (TypeScript skips dot-directories).
- Spring service (layered): `application/{rest,service,dto/request,dto/response,mapper}`, `infrastructure/{entity,persistence,config,security,filter,client}`, `shared/{exception,validation,constant}`; Flyway migrations in `src/main/resources/db/migration`; Hibernate `ddl-auto: validate`, never `update`. No providers, modules or `.app` in Java.
- `.infra/` (workspace) is operational infrastructure PSO generates and reconciles: never put application code there, never edit it by hand. It exists from `pso create workspace` on (holding only its ignore rule); `pso infra:init` and `pso infra:apply` fill it.
- Workspace layout: orchestrators in `orchestrators/`, microservices in `services/`, FEIs in `frontends/`, MEIs in `frontends/modules/`, workspace-level shared material (the frontends' orchestrator contract) in `shared/`, workspace documentation in `docs/`, cross-project tests in `tests/`. The generators decide the path and register it in `pso.workspace.json`; every command reads that `path`.
- New projects include a reference Product CRUD (`--template empty` omits it); the orchestrator's CRUD module is bound to the service that serves its path (`PRODUCT_SERVICE` + `metadata.services`), rebind with `pso crud:bind`.
- 0.1 projects (`src/routes/<module>/`, `routes/`, `ports/`, `adapters/` in Java) keep working; never mix the two in one project.

## Discovery, manifest, lifecycle

- Files are classified by suffix and directory in byte-wise sorted order. Kinds are listed in the orchestrator and microservice conventions.
- `pso validate --write-manifest` writes `.pso/manifest.json`.
- Resource lifecycle: DISCOVERED, VALIDATED, REGISTERED, INITIALIZED, READY, STOPPING, STOPPED, plus FAILED. Start is dependency-first, stop is reverse, failures roll back.

## Configuration precedence (low to high)

framework defaults, workspace, service, environment file, environment variables (`PSO_CFG_a__b`), `--set`. Secrets are references, never literals.

{{facts:config}}

## Repository convention for validation projects

- Keep sample applications, generated projects and external validation workloads in their own directories with a README (purpose, prerequisites, how to run); they are separate from the framework packages. Cross-language contract data shared by the TypeScript and Java tests is kept next to those tests.
- Unit-test-only data stays beside its tests and is not part of a release.
- The framework (`packages/`, `pso-java/`, `scripts/`) never imports or builds code from `fixtures/`. A fixture reaches PSO only through `@pso/*` packages (`file:` path or vendored tarball) and the `pso` CLI, and keeps the workspace layout `pso create` produced.
- Fixtures are never part of a distribution or a published package, and generated artifacts, dependencies, credentials, private keys and `.env` files are never committed. `packages/cli/test/fixtures-isolation.test.ts` enforces this.
- Do not create validation projects as siblings of the repository or in a temporary directory that is later forgotten.
- Keep functional sample applications and deployment validation workloads separate and independent: a functional sample validates application behaviour (acceptance checks, Docker Compose, no server); a deployment workload validates deployment, infrastructure, operational security and remote management on a real server (declarations in `deploy/`, scenario scripts in `scenarios/`). Never copy application code between them; put a test in the one whose responsibility it belongs to. Scenario scripts read the target from environment variables such as `ECV_HOST`, `ECV_SSH_USER`, `ECV_SSH_KEY`, never from literals.
