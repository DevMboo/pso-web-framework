---
title: Task: add a DTO
description: Exact steps to add a DTO and validate its input.
order: 24
scope: add-dto
base: false
requires: [orchestrator]
keywords: [ai, task, dto]
---
- Official modular orchestrator DTO: `pso make:dto <module> <name> --service <orchestrator> [--fields "name:string:min=3,email:email,age?:integer:min=18"]` creates a decorated request class in `src/modules/<module>/dto/request/` (`--response` writes to `dto/response/`). A 0.1 orchestrator keeps its `src/routes/<module>/dto/` layout. Add or edit fields, then use the request DTO in an action with `@Body(<Name>Dto)`.
- **`@Body(MyDto)` validates; `@Body()` does not.** The class must be decorated `@Dto()` and each field needs a type decorator (`@StringField()`, `@IntegerField()`, `@Email()`, ...) plus `@Required()`/`@Optional()`; TypeScript types and `?` are erased and are never read. Unknown properties are rejected by default. Invalid input is a `400` `PSO_VALIDATION_FAILED` problem and the action does not run. Use `pso make:route <module> <action> --method POST --path / --dto <name>` to generate `@Body(<Name>Dto)`. Rules that need a service are `@Validate(Class)` providers listed in `MODULE.pso.ts`. When the action only forwards to a Spring service, keep `@Body()` and let the service validate.
- Layered Spring DTO: `pso make:request <name> --service <spring-service>` (or `pso make:dto <name> --service <spring-service>`) creates a request record in `application/dto/request/`; `make:response` or `make:dto --response` writes to `application/dto/response/`. Use `@Valid @RequestBody` in `application/rest/` controllers; invalid input answers `400`. The old `contracts` package belongs to a 0.1 service.
- Do not share a DTO class between services. If both sides need the shape, keep a service contract (`*.contract.json`) and mirror the structure in each language.
- Run `pso validate` afterwards.
