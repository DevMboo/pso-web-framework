---
title: Convention over configuration
description: The directory and naming rules PSO enforces for each runtime, why they are enforced and not suggested, what the diagnostics look like, and where explicit configuration begins.
order: 2
keywords: [conventions, directories, naming, suffix, PSO_MISPLACED_RESOURCE, PSO_BAD_NAME]
related: [concepts/path-structure-working, decisions/why-directory-conventions, concepts/structural-discovery]
---
Conventions are enforced, not suggested: a file with a known suffix in the wrong place is `PSO_MISPLACED_RESOURCE`, a badly named file is `PSO_BAD_NAME`.

## Why enforce

If a convention is only advice, tools must handle every variation, and each variation is a place for the structure to stop meaning anything. If it is enforced, every PSO project looks the same, `pso validate` can answer "is this wired correctly?" without running anything, and a new developer finds `guards` in `guards`.

The cost is real: you cannot invent your own layout. The trade is described in [Why directory conventions](/decisions/why-directory-conventions).

## Node.js orchestrator

HTTP code lives in modules, `src/modules/<module>/`. Every module needs both `MODULE.pso.ts` and `routes/ROUTES.pso.ts`; application-wide components live in `src/.app/`. Names are `kebab-case`.

| Kind | Directory | File |
|---|---|---|
| module | `src/modules/<module>/` | `MODULE.pso.ts` |
| route-registry | `src/modules/<module>/routes/` | `ROUTES.pso.ts` |
| controller | `src/modules/<module>/controllers/` | `*.controller.ts` |
| service | `src/modules/<module>/services/`, `src/shared/`, `src/shared/.../` | `*.service.ts` |
| provider | `src/modules/<module>/providers/` | `*.provider.ts` |
| dto | `src/modules/<module>/dto/`, `src/modules/<module>/dto/request/`, `src/modules/<module>/dto/response/`, `src/shared/`, `src/shared/.../` | `*.dto.ts` |
| mapper | `src/modules/<module>/mappers/` | `*.mapper.ts` |
| type-contract | `src/modules/<module>/contracts/`, `src/.app/contracts/` | `*.contract.ts` |
| contract | `src/.app/contracts/` | `*.contract.json` |
| guard | `src/.app/guards/`, `src/modules/<module>/guards/` | `*.guard.ts` |
| middleware | `src/.app/middlewares/`, `src/modules/<module>/middlewares/` | `*.middleware.ts` |
| filter | `src/.app/filters/`, `src/modules/<module>/filters/` | `*.filter.ts` |
| interceptor | `src/.app/interceptors/`, `src/modules/<module>/interceptors/` | `*.interceptor.ts` |
| decorator | `src/.app/decorators/` | `*.decorator.ts` |
| config | `src/.app/configs/` | `*.config.ts` |
| hook | `src/modules/<module>/hooks/`, `src/.app/hooks/` | `*.hook.ts` |
| dispatch | `src/dispatch/`, `src/dispatch/.../` | `*.dispatch.ts` |

Mandatory for new orchestrators (`pso create orchestrator`). `src/main.ts` only calls `bootstrap()`; `src/shared/` holds code of no single module. A 0.1 orchestrator (`src/routes/<module>/`) keeps its layout: see the structure migration guide.

A generated orchestrator already has every directory of the structure (`pso create orchestrator gateway --template empty`; the
default template adds the `products` module):

```text evidence="expected"
src/.app/configs/  src/.app/contracts/  src/.app/decorators/  src/.app/filters/  src/.app/interceptors/  src/.app/middlewares/
src/.app/guards/jwt.guard.ts
src/modules/  src/shared/
src/main.ts
```

## Spring Boot service

Classes are PascalCase and the layer is the package path below the base package, so `com/acme/users/application/rest/CustomerController.java` is a controller.

| Kind | Directory | File |
|---|---|---|
| controller | `<package>/application/rest/` | `*Controller.java` |
| service | `<package>/application/service/` | `*Service.java` |
| request | `<package>/application/dto/request/` | `*Request.java` |
| response | `<package>/application/dto/response/` | `*Response.java` |
| mapper | `<package>/application/mapper/` | `*Mapper.java` |
| repository | `<package>/infrastructure/persistence/` | `*Repository.java` |
| entity | `<package>/infrastructure/entity/` | `*Entity.java` |
| config | `<package>/infrastructure/config/`, `<package>/infrastructure/security/` | `*Config.java` |
| filter | `<package>/infrastructure/filter/` | `*Filter.java` |
| client | `<package>/infrastructure/client/` | `*Client.java` |
| exception | `<package>/shared/exception/` | `*Exception.java` |
| event | `<package>/application/event/` | `*Event.java` |
| listener | `<package>/application/event/` | `*Listener.java` |

Mandatory for new services (`pso create service`), relative to the base package under `src/main/java`. Flyway migrations: `src/main/resources/db/migration/V<n>__<name>.sql`. A Java service has NO `providers`, `modules`, `.app` or `app` package. A 0.1 service (`routes/`, `contracts/`, `ports/`, `adapters/`, `persistence/`) keeps its layout: see the structure migration guide.

Plain helper files without a recognised suffix are allowed anywhere and are ignored by discovery.

## What a violation looks like

Create a module folder with a controller but no `MODULE.pso.ts` and run `pso validate` (Expected output):

```text evidence="expected"
ERROR   PSO_MODULE_001 gateway: Module declaration missing.

Module: ghost

The directory routes/ghost/ contains HTTP code but no MODULE.pso.ts. There is no fallback discovery.

No route of this directory is activated.
FAILED
```

The message names the module directory `routes/ghost/` in every structure; in the official structure that directory is
`src/modules/ghost/`.

The message names the code, the project, the module and the consequence, and `validate` exits with code 1. The orchestrator would also refuse to start, so the problem cannot reach a running system.

## Working with the conventions

| You want | Do |
|---|---|
| a new HTTP module | `pso make:module <name>`; it creates the two required files |
| a controller, service, DTO, guard | `pso make:controller`, `make:service`, `make:dto`, `make:guard`; they place the file correctly and register it |
| a helper that is not a framework resource | name it without a known suffix (`format-date.ts`); discovery ignores it |
| to know what the tools think exists | `pso inspect --service <name>` lists the discovered resources with their files |

## Common mistakes

- Putting `users.controller.ts` directly in `src/` instead of `src/modules/users/`.
- Naming a module in camelCase or with underscores (names are kebab-case).
- Moving files by hand and forgetting to update `MODULE.pso.ts`; use the generators, or run `pso validate` immediately after.

## Explicit configuration

When convention is not enough (ports, limits, upstream addresses, secrets) there is explicit configuration, with documented precedence and a typed schema: see [Configuration resolution](/concepts/configuration).

## Next steps

- [Structural discovery](/concepts/structural-discovery)
- [Module composition](/concepts/module-composition)
