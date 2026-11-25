---
title: DTOs
description: Data transfer classes for request bodies, how to generate them, and how @Body(Dto) validates them.
order: 7
status: stable
keywords: [dto, body, validation, make:dto]
related: [orchestrator/controllers, orchestrator/dto-validation]
---
:::include file="examples/users/dto/request/create-user.dto.ts" title="src/modules/users/dto/request/create-user.dto.ts"

```bash
pso make:dto users create-user --fields "name:string:min=3:max=80,email:email,age?:integer:min=18"
```

creates `src/modules/users/dto/request/create-user.dto.ts` with a `@Dto()` class like the one above. Without `--fields` the class is empty and accepts only `{}`. Field syntax: `name[?]:type[:min=N][:max=N]` with the types `string`, `integer`, `number`, `boolean`, `email`, `date`, `enum=a|b` and an optional `[]` suffix for arrays; `?` makes the field optional.

## What the runtime does with `@Body()` and `@Body(Dto)`

| Declaration | What the action receives |
|---|---|
| `@Body()` | the parsed JSON as it came (after size limit, content type and JSON parsing) |
| `@Body(CreateUserDto)` | an instance of `CreateUserDto` holding only declared, valid fields; invalid input is a `400` problem and the action is not called |

A class in the parameter type alone (`@Body() dto: CreateUserDto`) validates nothing: TypeScript types are erased at run time. The rules are the decorators. The complete guide, with nested objects, business validators, query/path parameters, limits and security notes, is [Validate request bodies with DTOs](/orchestrator/dto-validation).

## The manual alternative

For a body whose shape is genuinely free-form, accept `unknown` with `@Body()` and check what you need yourself:

```typescript title="src/modules/users/controllers/users.controller.ts"
import { Body, Controller, HttpError, Post, RestController } from "@pso/http";
import { UsersService } from "../services/users.service";

@Controller()
@RestController("/users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post("/")
  create(@Body() value: unknown) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new HttpError(400, "Expected a JSON object");
    const name = (value as Record<string, unknown>)["name"];
    if (typeof name !== "string" || name.trim().length === 0)
      throw new HttpError(400, "name is required");
    return this.usersService.create({ name: name.trim() });
  }
}
```

This action still requires a matching `POST /users` entry in `ROUTES.pso.ts` and controller registration in `MODULE.pso.ts`. Check a missing `name`, a numeric `name`, invalid JSON and an oversized body separately: the first two are your action's `400`, while parsing and size limits happen before it runs. Spring service actions use Jakarta Validation for the equivalent field checks ([CRUD tutorial](/tutorials/crud-api)).

## What generating a DTO does

Expected output (for the `orders` module, DTO `create-order`):

```text evidence="expected"
$ pso make:dto orders create-order --fields "customer:string:min=3:max=40,email:email,quantity:integer:min=1:max=100"
created    src/modules/orders/dto/request/create-order.dto.ts
```

The class it writes is shown in full on [Validate request bodies](/orchestrator/dto-validation).

## Variations

| You want | Do |
|---|---|
| an empty class to fill by hand | `pso make:dto orders create-order` (it accepts only `{}` until you add fields) |
| optional fields | `age?:integer:min=18` in `--fields` |
| a fixed set of values | `role:enum=admin|user` |
| a DTO for a route | `pso make:route orders create --method POST --path / --dto create-order` |
| a Spring DTO | `pso make:dto customer-request --service catalog` (a record with Jakarta Validation) |

## Common mistakes

- Using the DTO class as a type only (`@Body() dto: CreateUserDto`): no validation happens.
- Reusing one DTO for create and update.
- Putting secrets in a DTO that is logged elsewhere (the framework does not log bodies).

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| a request with a wrong field is accepted | the action does not use `@Body(Dto)`, so the gateway only parses JSON | the controller source | declare a `@Dto` class and use `@Body(Dto)` ([DTO validation](/orchestrator/dto-validation)) |
| `400` with `PSO_VALIDATION_FAILED` and an `errors` list | the body violates the DTO | the `errors[].field` values in the answer | fix the client, or the DTO if it is too strict |
| the gateway accepts but the service answers `400` | the gateway validates early, the service always validates for itself | the service's own record annotations | keep both in step; the service is authoritative |
| unknown properties are rejected | strict mode is the default | the `is not allowed` entries | add the field to the DTO, or stop sending it |

## Next steps

- [Validate request bodies](/orchestrator/dto-validation)
- [Controllers](/orchestrator/controllers)
