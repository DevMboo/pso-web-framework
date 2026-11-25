---
title: Validate request bodies with DTOs
description: Declare the shape of a request once with @Dto fields, bind it with @Body(Dto), and let the orchestrator reject invalid input before your action runs. Basic to production, with real output.
order: 8
status: stable
keywords: [dto, validation, "@Body", "@Dto", Required, Optional, StringField, Email, Validate, problem details, 400, make:dto, unknown properties]
related: [orchestrator/dtos, orchestrator/controllers, reference/error-standard, spring/postgresql-crud, devops/logging]
---
## What it is

`@Body(CreateOrderDto)` makes the orchestrator check the request body against a class you declared, field by field, **before your action is called**. If anything is wrong, the client gets a `400` `application/problem+json` response that lists every wrong field, and your code never runs.

```typescript
@Post("/")
create(@Body(CreateOrderDto) body: CreateOrderDto) { /* body is valid here */ }
```

`@Body()` without a class is unchanged: it passes the parsed JSON as it is. Nothing is inferred from TypeScript types, because types do not exist at run time. The rules are the decorators on the fields.

## Why it exists

Without it, every action starts with the same lines: is this an object, is `name` a string, is it long enough, did the client send fields I do not expect. Those lines get forgotten, written differently in each action, or written wrong. A declaration is shorter, is read by the framework, and produces the same error shape everywhere.

## When to use it, and when not to

| Use `@Body(Dto)` when | Do not use it when |
|---|---|
| the orchestrator itself handles the request | the action only forwards to a Spring service with `forward(...)`; the service validates (Jakarta Validation) and the body must reach it untouched |
| the body has a fixed, known shape | the body is free-form JSON on purpose (use `@Body()` and validate what you need) |
| you want one consistent 400 contract | the rule needs a database or another service (use a business validator, below, not a field rule) |

Forwarded routes keep working exactly as before. Validating in both places is allowed and harmless, but the Spring service stays the authority for its own data.

## Prerequisites

A workspace with an orchestrator and a module. If you have none yet, follow [your first orchestrator](/getting-started/first-orchestrator).

## 1. Minimal example

```bash
pso make:module orders
pso make:controller orders --prefix /orders
pso make:dto orders create-order --fields "customer:string:min=3:max=40,email:email,quantity:integer:min=1:max=100"
pso make:route orders create --method POST --path / --scopes orders:write --dto create-order
```

What each command created:

| File | Purpose |
|---|---|
| `src/modules/orders/MODULE.pso.ts` | the module: which controller and providers exist |
| `src/modules/orders/routes/ROUTES.pso.ts` | the authoritative route list: `POST /orders`, guarded, scope `orders:write` |
| `src/modules/orders/controllers/orders.controller.ts` | the action `create`, already using `@Body(CreateOrderDto)` |
| `src/modules/orders/dto/request/create-order.dto.ts` | the validated shape |

The generated DTO:

```typescript title="src/modules/orders/dto/request/create-order.dto.ts"
import { Dto, Required, StringField, IntegerField, Email, MinLength, MaxLength, Min, Max } from "@pso/http";

@Dto()
export class CreateOrderDto {
  @Required() @StringField() @MinLength(3) @MaxLength(40)
  customer!: string;

  @Required() @Email()
  email!: string;

  @Required() @IntegerField() @Min(1) @Max(100)
  quantity!: number;
}
```

The generated controller (the action body is yours to write; here it returns what it received):

```typescript title="src/modules/orders/controllers/orders.controller.ts"
import { Controller, RestController, Post, Body } from "@pso/http";
import { CreateOrderDto } from "../dto/request/create-order.dto";

@Controller()
@RestController("/orders")
export class OrdersController {

  @Post("/")
  async create(@Body(CreateOrderDto) body: CreateOrderDto) {
    return { accepted: true, customer: body.customer, quantity: body.quantity };
  }
}
```

### How to read it

- `@Dto()` marks the class as a validation contract. A class without it cannot be used in `@Body(...)`; the orchestrator refuses to start.
- Each field has a **type decorator** (`@StringField`, `@IntegerField`, `@Email`, ...) and any number of constraints (`@MinLength`, `@Min`, ...). A field with no type decorator is a start-up error, never a silent pass.
- Fields are required unless you say `@Optional()`. `@Required()` is the explicit way to say the default.
- `!` after the name is plain TypeScript ("assigned by the framework"): the framework creates the object, not a constructor.

## 2. Run it and see what happens

```bash
pso validate          # static checks, no code runs
npm run build         # compile the orchestrator
pso dev               # or: node dist/main.js
```

A valid request:

```bash
curl -i -X POST http://127.0.0.1:3000/orders \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"customer":"Grace","email":"grace@example.com","quantity":3}'
```

```text evidence="illustrative"
HTTP/1.1 201 Created
content-type: application/json; charset=utf-8
x-correlation-id: 5b0d6f0e-4b1c-4a8e-9c0e-5e3d3f6a1c11

{"accepted":true,"customer":"Grace","quantity":3}
```

An invalid one (name too short, malformed e-mail, quantity below 1, and a property the DTO does not declare):

```bash
curl -i -X POST http://127.0.0.1:3000/orders -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "x-correlation-id: demo-corr-0001" \
  -d '{"customer":"Gr","email":"nope","quantity":0,"admin":true}'
```

```text evidence="expected"
HTTP/1.1 400 Bad Request
content-type: application/problem+json; charset=utf-8
```

```json evidence="verified"
{
  "type": "urn:pso:problem:validation-failed",
  "title": "Validation failed",
  "status": 400,
  "detail": "The request is not valid; see the errors member.",
  "code": "PSO_VALIDATION_FAILED",
  "error": "validation_failed",
  "instance": "/orders",
  "correlationId": "demo-corr-0001",
  "errors": [
    { "field": "admin",    "message": "is not allowed" },
    { "field": "customer", "message": "must have at least 3 characters" },
    { "field": "email",    "message": "must be a valid e-mail address" },
    { "field": "quantity", "message": "must be at least 1" }
  ]
}
```

What you see in the orchestrator terminal (default `pretty` format on a terminal; see [logging](/devops/logging)):

```text evidence="expected"
2026-11-08 14:18:19.530 INFO  request (demo-corr-0001)  traceId=82b1e39923a376ea73ba19a092fca833 method=POST path=/orders status=201 ms=6.56
2026-11-08 14:18:19.536 INFO  request (demo-corr-0001)  traceId=d5bffcb133d75597de34f26b737428d9 method=POST path=/orders status=400 ms=1.17
```

The log line carries the method, path, status and correlation id. It does **not** carry the body: submitted values are never logged or echoed.

## 3. What happens internally

1. The request arrives. Authentication and authorization run first: an unauthenticated caller gets `401` and the body is never examined.
2. The body is read up to the configured size limit (`http.limits.maxBodyBytes`), and the content type must be `application/json` (`415` otherwise; invalid JSON is `400 invalid_json`).
3. The top level must be a JSON object.
4. For every declared field the framework checks presence, type, then constraints. Types are strict: `"3"` is not an integer. `null` is not "absent" (see `@Nullable`).
5. Properties that are not declared are reported (default) or dropped (`@Dto({ unknown: "strip" })`).
6. Only if the whole structure is valid do business validators (`@Validate`) run.
7. If anything failed, one `400` problem lists up to 50 errors and your action is not called. Otherwise the action receives an instance of your DTO class containing only the declared, valid fields. The class constructor is **not** run.

## 4. Choosing constraints

| Decorator | Meaning |
|---|---|
| `@Required()` / `@Optional()` / `@Nullable()` | presence; `@Nullable` also accepts an explicit JSON `null` |
| `@StringField()` `@IntegerField()` `@NumberField()` `@BooleanField()` | exact JSON type (no coercion) |
| `@Email()` `@IsoDate()` | strings with a format: RFC-style e-mail up to 254 characters; ISO 8601 date or date-time with zone (the value stays a string) |
| `@MinLength(n)` `@MaxLength(n)` | string length in characters |
| `@Min(n)` `@Max(n)` | numeric range (inclusive) |
| `@Pattern(/re/)` | string must match; the expression must not use the `g` or `y` flag |
| `@OneOf("a", "b")` | the value must be one of these |
| `@ArrayOf("string")`, `@ArrayOf(ItemDto)` + `@MinItems` `@MaxItems` | arrays of scalars or of DTOs; up to 1000 items unless you lower or raise (max 10 000) with `@MaxItems` |
| `@Nested(AddressDto)` | an object validated by another `@Dto` class (up to 8 levels) |
| `@Message("text")` | replaces the messages of that field with a constant of yours |
| `@Validate(Rules)` | a business validator, see below |

Anything else is deliberately missing: the model is small so that every decorator means the same thing in every DTO.

## 5. Intermediate: nested objects and arrays

```typescript
@Dto()
export class AddressDto {
  @Required() @StringField() @MinLength(1) street!: string;
  @Required() @StringField() @MaxLength(40) city!: string;
}

@Dto()
export class CreateCustomerDto {
  @Required() @StringField() @MinLength(3) name!: string;
  @Optional() @Nested(AddressDto) address?: AddressDto;
  @Optional() @ArrayOf("string") @MaxItems(5) tags?: string[];
}
```

Errors carry the path: `address.city`, `tags[2]`. For DTOs that refer to each other, pass a function: `@Nested(() => CategoryDto)`.

## 6. Advanced: business validators that use services

A field rule is **structural** and pure: it needs nothing but the value. A rule such as "this SKU exists" needs a service. Keep it separate:

```typescript title="src/modules/orders/services/sku-rules.service.ts"
import { Injectable, type FieldValidator } from "@pso/http";
import { SkuCatalog } from "./sku-catalog.service";

@Injectable()
export class SkuRules implements FieldValidator {
  constructor(private readonly catalog: SkuCatalog) {}
  async validate(value: unknown): Promise<string | undefined> {
    return (await this.catalog.exists(String(value))) ? undefined : "is not a known SKU";
  }
}
```

```typescript
@Dto()
export class CreateOrderDto {
  @Required() @StringField() @Validate(SkuRules)
  sku!: string;
}
```

```typescript title="MODULE.pso.ts"
providers: [SkuCatalog, SkuRules],   // registration is explicit: a validator that is not listed stops the start-up
```

Properties of this design:

- Validators are **providers**, resolved by the same container as services, with the same constructor injection.
- They run **only after the structure is valid**, so garbage input never causes a query.
- They may be `async`. They return a message to reject or nothing to accept, and receive `{ object, path }` for cross-field rules (`ctx.object["startDate"]`).
- The framework never queries anything because a DTO exists. If a validator is not registered, the application refuses to start with the route and the class name:

```text evidence="expected"
2026-11-08 14:21:07.101 ERROR startup failed  error="POST /orders: validator SkuRules must be listed in the providers of module \"orders\"\nnothing was started" diagnostics=["PSO_DTO_VALIDATOR_UNREGISTERED"]
```

## 7. Path and query parameters

`@Param` and `@Query` accept an optional description. Conversion is explicit and strict (`"12abc"` is an error, never 12; `"012"` is rejected):

```typescript
@Get("/")
list(
  @Query("page", { type: "integer", min: 1, default: 1 }) page: number,
  @Query("sort", { oneOf: ["asc", "desc"], default: "asc" }) sort: string,
) { /* page is a number, sort is "asc" or "desc" */ }

@Get("/:id")
get(@Param("id", { type: "integer", min: 1 }) id: number) { /* ... */ }
```

A violation is the same `400` problem with the field named `query.page` or `path.id`. Without a second argument both decorators behave as before (a raw string).

## 8. Create, update and partial update

There is one DTO per intent. Reuse by composition, not by flags:

```typescript
@Dto() export class CreateUserDto { @Required() @StringField() name!: string; @Required() @Email() email!: string; }
@Dto() export class UpdateUserDto { @Required() @StringField() name!: string; }                 // PUT: replace what can change
@Dto() export class PatchUserDto  { @Optional() @StringField() name?: string; }                 // PATCH: only what was sent
```

`email` is missing from `UpdateUserDto`, so a client that sends it gets `"email": "is not allowed"`: the rule that "email cannot change" is the shape of the class. Validation groups and conditional "required if" rules are intentionally not part of this model; express them as separate DTOs or as a business validator.

## Files in a DTO

A DTO can also describe files. `@FileField` (one file) and `@FilesField` (several) read `multipart/form-data`; declaring one switches `@Body(Dto)` from JSON to multipart for that route. Ordinary fields in the same form are converted strictly to the type you declared (`"3"` becomes `3` for an `@IntegerField`, `"3x"` stays a string and fails). Limits are enforced while the body streams, and the declared content type is checked against the file's signature, not trusted.

```typescript
@Dto()
export class UploadDocumentDto {
  @FileField({ required: true, maxSize: "10MB", mimeTypes: ["application/pdf"], extensions: [".pdf"] })
  document!: PsoUploadedFile;

  @Required() @StringField() @MaxLength(80)
  title!: string;
}
```

Everything about it (options, errors, forwarding to a service, the CLI generators) is on [File uploads and downloads](/orchestrator/file-uploads).

## 9. Production considerations

- **Unknown properties are rejected by default.** This prevents mass assignment ("I sent `isAdmin`") and surfaces client bugs. Use `@Dto({ unknown: "strip" })` only for DTOs that must tolerate newer clients, and know that the extra data is dropped silently.
- **Bounded work.** Up to 8 nesting levels, 1000 items per array by default, 50 errors per response (a `more errors were found` entry is added), and the body size limit applies before parsing.
- **Prototype pollution.** Fields named `__proto__`, `constructor` and `prototype` cannot be declared; such keys in a request are reported as unknown properties and never copied; the result object has the DTO prototype and own properties only.
- **No data in errors.** Messages are constants. Only property **names** from the request are echoed, truncated to 64 printable characters.
- **Order is part of security.** Authentication, then authorization, then validation. An anonymous caller cannot probe your DTO.
- **Compatibility.** Routes that use `@Body()` do not change behavior.

## 10. Anti-patterns

| Do not | Do instead |
|---|---|
| annotate the parameter with a class and expect validation (`@Body() dto: CreateUserDto`) | pass the class to the decorator: `@Body(CreateUserDto)` |
| write `age?: number` and expect the question mark to make it optional | add `@Optional()`; TypeScript syntax is erased and is not read |
| query a database from a field rule | write a `@Validate` provider; keep structure pure |
| put request data into `@Message` text | use constants; the message is returned to the client |
| use one DTO for create and update with many `@Optional()` | one DTO per intent |
| validate in the orchestrator **and** assume the service no longer needs to | the service validates its own input (Jakarta Validation) |

## 11. Errors you may meet

| What you see | Meaning and fix |
|---|---|
| start-up: `... is used as a DTO but is not decorated with @Dto()` | add `@Dto()` to the class used in `@Body`, `@Nested` or `@ArrayOf` |
| start-up: `... has no type decorator` | add `@StringField()`, `@IntegerField()`, `@Email()`, ... |
| start-up: `field "x" already has the type string` | a field has two type decorators; keep one |
| start-up: `validator X must be listed in the providers of module "m"` | add the class to `providers` in `MODULE.pso.ts` |
| `400` with `"message": "is not allowed"` | the client sent a property the DTO does not declare |
| `400` with `"a JSON request body is required"` | the body was empty |
| `415` | the request was not `application/json` |
| `400 invalid_json` | the body is not valid JSON (before any DTO check) |

## 12. Spring Boot services: the equivalent

Spring services use **Jakarta Validation** (`@NotBlank`, `@Size`, `@Email`, `@Valid`), which the starter activates, and the same Problem Details contract. The two mechanisms are different implementations with a deliberately similar result: a `400` `application/problem+json` with `code: PSO_VALIDATION_FAILED`, a `correlationId`, and an `errors` list of `{ field, message }`. Message wording follows each library. See [PostgreSQL CRUD in Spring](/spring/postgresql-crud) for a complete example with validation, persistence and tests.

## Next steps

- [DTO classes and `make:dto`](/orchestrator/dtos)
- [The error standard (RFC 9457)](/reference/error-standard)
- [Logging and correlation](/devops/logging)
