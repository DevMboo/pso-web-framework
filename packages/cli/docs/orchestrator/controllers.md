---
title: Controllers
description: Decorated classes that implement endpoints - the decorators, what an action may return or throw, the real answers for each case, and how a controller relates to the registry and to services.
order: 5
keywords: [controller, decorators, HttpError, Param, Query, Body, return value, status codes]
related: [orchestrator/routes, orchestrator/dto-validation, orchestrator/services-and-providers, decisions/controller-or-service, reference/error-standard]
---
:::include file="examples/users/controllers/users.controller.ts" title="src/modules/users/controllers/users.controller.ts"

| Decorator | Where | Meaning |
|---|---|---|
| `@Controller()` | class | marks the class as a controller; **exposes nothing** |
| `@RestController("/users")` | class | path prefix of every action |
| `@Get("/")`, `@Post("/")`, `@Put`, `@Patch`, `@Delete` | method | HTTP method and path relative to the prefix |
| `@Param("id")`, `@Query("page")` | parameter | path / query value (a string; add a second argument such as `{ type: "integer", min: 1 }` to convert and check it) |
| `@Body()` | parameter | JSON body as parsed (size-limited, no schema validation) |
| `@Body(CreateUserDto)` | parameter | JSON body validated against a `@Dto` class before the action runs ([guide](/orchestrator/dto-validation)) |
| `@Req()`, `@Res()` | parameter | Node request / response (used with `Upstream.forward`) |

A controller **describes** actions. Whether one is reachable is decided by `ROUTES.pso.ts` ([why](/decisions/why-routes-pso-mandatory)).

## What an action returns, and what the client gets

The runtime serializes the return value as JSON: `201` for `POST`, `200` otherwise. An action can also throw. Verified answers from a real run (a controller with these actions, called with a valid token):

| The action does | The client gets |
|---|---|
| `return [{ id: "1", total: 10 }, ...]` | `200`, `[{"id":"1","total":10},{"id":"2","total":25}]` |
| `return { id, found: true }` for `GET /orders/42` | `200`, `{"id":"42","found":true}` (a path parameter arrives as the string `"42"`) |
| `return { created: true }` from a `@Post` | `201`, `{"created":true}` |
| `return undefined` | `200`, the body `null` |
| `throw new HttpError(404, "not_found")` | `404 application/problem+json`, `"code":"PSO_HTTP_NOT_FOUND"`, the standard detail |
| `throw new HttpError(418, "I am a teapot")` | `418 application/problem+json`, `"code":"PSO_HTTP_ERROR_418"`, `"detail":"I am a teapot"` |
| `throw new Error("database password is hunter2")` | `500 application/problem+json`, `"code":"PSO_INTERNAL_ERROR"`, a generic detail: **the message is never returned** |

```text evidence="expected"
GET /orders/teapot/now
HTTP 418 application/problem+json; charset=utf-8
{"type":"urn:pso:problem:http-418","title":"HTTP 418","status":418,"detail":"I am a teapot","code":"PSO_HTTP_ERROR_418","error":"I am a teapot","instance":"/orders/teapot/now","correlationId":"doc-ctl-0001"}
```

Two rules follow. **The text of an `HttpError` is returned to the client**, so write it for them and never put internal information in it. **An unexpected error is hidden from the client** (the `500` above), and in this version it is **not logged with its message or stack either**: the log has the `request ... status=500` line only. Log the cause yourself where you can add context.

## Body errors

| Problem | Status |
|---|---|
| invalid JSON | `400` |
| body larger than `MAX_BODY_BYTES` | `413` |
| body without `Content-Type: application/json` | `415` |
| a `@Body(Dto)` that breaks its rules | `400 PSO_VALIDATION_FAILED` with field errors |

## The unexposed method

`remove()` carries `@Delete("/:id")` but is absent from `ROUTES.pso.ts`: it is dead code until you declare it. This is intentional and tested; a request to it answers `404 PSO_HTTP_NOT_FOUND` (verified). A controller may contain such methods.

## Forwarding to a service

Inject `Upstream` and forward; the service must equal the route's `metadata.service`. The action does not consume the body when it forwards. See [Remote service clients](/orchestrator/upstream-clients).

## Variations

| You want | Write |
|---|---|
| an action that forwards | `this.upstream.forward(req, res, "catalog")` with `@Req()`/`@Res()` |
| an action that answers by itself with a validated body | `@Body(CreateOrderDto) body: CreateOrderDto` |
| typed query parameters | `@Query("page", { type: "integer", min: 1, default: 1 }) page: number` |
| the verified caller | `@CurrentPrincipal()` from `@pso/security` |
| a specific error status | `throw new HttpError(409, "duplicate")` (or let a [filter](/orchestrator/middleware-and-filters) shape it) |

The method decorators `@Put`, `@Patch` and `@Delete` use the same registration rule as `@Get` and `@Post`. A write action must be listed in `ROUTES.pso.ts` with its full path, method, action name and security policy. To activate the example `remove()` above, add its route with `pso make:route users remove --method DELETE --path /:id` (guarded by default).

## Diagnosis

If an action answers `404`, run `pso routes:list` before debugging its body. If start-up reports a method or path mismatch, compare the registry with the controller prefix and decorator, including the leading slash. An exception you did not convert to `HttpError` becomes the generic `500` above; reproduce it and log it yourself.

## Common mistakes

- Putting business logic in the controller ([controller or service?](/decisions/controller-or-service)).
- Throwing `HttpError` with an internal message.
- Expecting `@Body() dto: CreateUserDto` to validate: pass the class to the decorator.
- Adding `@Get` and expecting the endpoint to exist.

## Generate

```bash
pso make:controller users
pso make:route users findAll --method GET --path / --public
```

## Next steps

- [Routing](/orchestrator/routes)
- [Validate request bodies](/orchestrator/dto-validation)
- [Services and providers](/orchestrator/services-and-providers)
