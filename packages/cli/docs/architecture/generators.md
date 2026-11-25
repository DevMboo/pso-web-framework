---
title: Generators in the official structures
description: Which pso make commands exist for the modular orchestrator and the layered Java service, where each one writes, what it registers for you, and the rules every generator follows (structure detection, no overwrites, no mixing, transactional changes).
order: 5
status: implemented
keywords: [generators, make, make:crud, make:module, make:provider, make:interceptor, make:entity, make:migration, crud:bind, empty template, scaffolding]
related: [architecture/overview, architecture/typescript-orchestrator, architecture/java-microservice, architecture/reference-crud, cli/workflow]
---
> [!STATUS]
> **Implemented and verified**: every generator below was run against a generated workspace; the results compiled, passed their tests and `pso validate`. Duplicates, overwrites and misplaced kinds are refused.

## Orchestrator (modular)

| Command | Writes | Registers |
|---|---|---|
| `pso make:module <m>` | `src/modules/<m>/MODULE.pso.ts`, `routes/ROUTES.pso.ts` | - |
| `pso make:controller <m> [name]` | `modules/<m>/controllers/<name>.controller.ts` | MODULE `controllers` |
| `pso make:route <m> <action> --method --path [--public \| --scopes]` | the action + its route | ROUTES entry (validated, rolled back on error) |
| `pso make:service <m> [name]` | `modules/<m>/services/<name>.service.ts` | MODULE `providers` |
| `pso make:provider <name> --module <m>` | `modules/<m>/providers/<name>.provider.ts` | MODULE `providers` |
| `pso make:dto <m> <name> [--response] [--fields ...]` | `modules/<m>/dto/request/` (or `response/`) | - |
| `pso make:mapper <m> <name>` | `modules/<m>/mappers/<name>.mapper.ts` | - |
| `pso make:contract <m> <name>` | `modules/<m>/contracts/<name>.contract.ts` | - |
| `pso make:guard <name>` / `<m> <name>` | `src/.app/guards/` / `modules/<m>/guards/` | named by routes |
| `pso make:middleware`, `make:filter`, `make:interceptor <name>` | `src/.app/middlewares/`, `filters/`, `interceptors/` | named by routes |
| `pso make:decorator`, `make:config <name>` | `src/.app/decorators/`, `configs/` | imported where used |

In the modular structure a provider, a service or a hook belongs to a module: `--module` (or the module argument) is required.

## Java service (layered)

| Command | Package |
|---|---|
| `pso make:controller <name> --service <svc>` | `application/rest` |
| `pso make:service`, `make:mapper` | `application/service`, `application/mapper` |
| `pso make:request <name>`, `make:response <name>` (`make:dto <name> [--response]`) | `application/dto/request`, `application/dto/response` |
| `pso make:entity <name>`, `make:repository <name>` | `infrastructure/entity`, `infrastructure/persistence` (a repository needs its entity) |
| `pso make:config`, `make:filter`, `make:client <service>` | `infrastructure/config`, `infrastructure/filter`, `infrastructure/client` |
| `pso make:exception <name>` | `shared/exception` |
| `pso make:event <name>`, `make:listener <name>`, `make:dispatch-event <event.name>`, `make:dispatch-handler <event.name>` | `application/event` (the Dispatch declaration itself goes to `src/main/resources/dispatch/<service>.events.json`) |
| `pso make:migration <name> --service <svc>` | `src/main/resources/db/migration/V<next>__<name>.sql` |

`make:port` and `make:adapter` belong to the 0.1 hexagonal layout and are refused in a layered service.

## A complete resource

```bash
pso make:crud order --service sales --orchestrator \
  --fields "code:string:unique:length=3-32:filter:sort,total:decimal:precision=12:scale=2:min=0:sort,paid:boolean:default=false:filter"
```

Writes the whole layered resource in `sales` (entity, the next Flyway migration with constraints and indexes, repository and filters,
request/response records, mapper, transactional service, controller with `orders:read` / `orders:write`, tests) and, with `--orchestrator`,
the `orders` module bound to `sales` (DTOs, contract, provider, service, mapper, controller, routes, a request collection for Studio,
a test). Fields: `name:type[:option]...` with types `string text integer long decimal boolean` and options `optional unique min=N max=N
length=MIN-MAX precision=P scale=S default=true|false sort filter`. Without `--fields` a resource has one required `name`.

`pso crud:bind <module> --to <service>` changes which service a CRUD module calls.

## Rules every generator follows

- It detects the project's runtime and structure and writes in that structure; a project that mixes conventions is refused.
- It never overwrites: an existing file, module or resource stops the command before anything is written.
- Changes to the orchestrator are validated as a whole and rolled back if they would leave it inconsistent.
- `--dry-run` shows the plan; `--json` gives it to CI.
- No generator edits framework-managed infrastructure (`.infra/`) or a project's configuration files beyond the registrations listed above.

## Limits

- `make:entity` writes the entity only: its table comes from a migration you add (`pso make:migration`), because Hibernate only
  validates the schema. In a service without a database `make:entity` and `make:repository` are refused with the command that adds one
  (`pso database:enable postgresql --service <svc>`, which also sets the validation of the schema).
- `make:crud` in a service created before this release may lack `spring.jackson.deserialization.fail-on-unknown-properties`; the
  command says so, and the generated unknown-property test is left out until the setting is added.
- `crud:bind` rebinds modules generated as CRUD modules (a `contracts/*.contract.ts` with a `*_SERVICE` constant); other modules name
  their services in their own routes and providers.
