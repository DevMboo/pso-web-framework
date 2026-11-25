---
title: Request and response lifecycle
description: The exact order in which the orchestrator handles an HTTP request, which status each stage can answer, what is logged, and how to find the stage that rejected a request.
order: 10
keywords: [lifecycle, request, response, pipeline, 400, 401, 403, 404, 429, 503, correlation id, validation, problem details]
related: [orchestrator/guards, orchestrator/middleware-and-filters, orchestrator/dto-validation, security/rate-limiting, reference/error-standard, devops/logging]
---
## What this page answers

When a request does not do what you expect, the first question is *which stage said no*. The answer is always in the status code, the `code` member of the error body and one log line. This page lists the stages in the order they run, so you can read an answer backwards to its cause.

:::diagram name="lifecycle"

## The stages, in order

| # | Stage | What it checks | Outcome when it fails |
|---|---|---|---|
| 1 | Correlation | accepts an incoming `x-correlation-id` when it is 8 to 64 characters of `A-Z a-z 0-9 . _ -`; otherwise generates a UUID (so even a refused request has an id) | never fails; a malformed id is replaced, never echoed |
| 2 | Limits and rate limit | connection and concurrency limits, header size, the token bucket for the client (and route, and principal when configured) | `431`, `503 server_busy`, `429` with `Retry-After` and `RateLimit-*` headers |
| 3 | Route registry | the method and path are declared in `ROUTES.pso.ts` and the controller is registered | `404` for anything not declared, including decorated but undeclared methods |
| 4 | Authentication | a valid token for guarded routes | `401` with `WWW-Authenticate: Bearer` |
| 5 | Authorization | the scopes or roles the route requires | `403` |
| 6 | Middleware | your middleware, only for requests that passed the guards | whatever your middleware sends |
| 7 | Body and parameters | size limit, `application/json`, valid JSON, then the `@Dto` rules and any `@Param`/`@Query` descriptions | `413`, `415`, `400 invalid_json`, `400 PSO_VALIDATION_FAILED` with a field list |
| 8 | Action | your code | `200` (`201` for POST) with the returned value, the status of a thrown `HttpError`, otherwise `500` (nothing internal is returned) |
| 9 | Upstream (when the action forwards) | the service is known, reachable and answers in time | `502` unknown service or invalid answer, `503` unreachable, `504` timeout |
| 10 | Response | headers added to every answer, one log line | |

> [!NOTE]
> The order differs from some frameworks on purpose. Middleware runs **after** the guards, so it never processes an unauthenticated request on a guarded route. Validation runs after authorization, so an anonymous caller cannot probe the shape of your bodies. Rate limiting runs first because it is the cheapest way to refuse work.

## Every response

- `x-correlation-id`: the same value that appears in the error body (`correlationId`) and in the log line.
- Errors are `application/problem+json` with a stable `code` ([error standard](/reference/error-standard)). A client-supplied correlation id is used **only if it is well-formed**; a value that is not is replaced with a generated one.
- One log line per request with the method, path, status, duration and trace id (never the body, headers or tokens). On a terminal:

```text evidence="expected"
2026-11-08 14:18:19.536 INFO  request (demo-corr-0001)  traceId=d5bffcb133d75597de34f26b737428d9 method=POST path=/orders status=400 ms=1.17
```

In production the same event is one JSON line ([logging](/devops/logging)).

## Example: one request through every stage

```bash
curl -i -X POST http://127.0.0.1:3000/orders \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "x-correlation-id: trace-me-0001" -d '{"customer":"Gr","email":"nope","quantity":0}'
```

1. Correlation: `trace-me-0001` is well-formed, so it is kept.
2. Rate limit: allowed (`RateLimit-Remaining` is in the response headers).
3. Route registry: `POST /orders` is declared.
4. Authentication and authorization: the token is valid and carries `orders:write`.
5. Body: JSON object, within the size limit.
6. Validation: three fields break their rules. The action is **not** called.

```text evidence="expected"
HTTP/1.1 400 Bad Request
content-type: application/problem+json; charset=utf-8
x-correlation-id: trace-me-0001
```

```json evidence="expected"
{ "type": "urn:pso:problem:validation-failed", "status": 400, "code": "PSO_VALIDATION_FAILED",
  "correlationId": "trace-me-0001", "instance": "/orders",
  "errors": [ { "field": "customer", "message": "must have at least 3 characters" },
              { "field": "email", "message": "must be a valid e-mail address" },
              { "field": "quantity", "message": "must be at least 1" } ] }
```

## Find the stage from the answer

| You see | The stage that answered | Look at |
|---|---|---|
| `429` | rate limit | `Retry-After`; the limits in `pso.config.json` ([rate limiting](/security/rate-limiting)) |
| `404` with `PSO_HTTP_NOT_FOUND` | route registry | `pso routes:list`: the method and path must be declared |
| `401` | authentication | the token, issuer, audience and algorithms; the start-up line `security initialized` |
| `403` | authorization | the scopes the route declares versus the scopes in the token |
| `400` + `errors` | validation | the field names in `errors` |
| `400` + `invalid_json` / `415` / `413` | body parsing | content type, JSON syntax, `http.limits.maxBodyBytes` |
| `500` | your action | the response never contains the cause. In this version the log has only the `request ... status=500` line with the correlation id (verified: no message or stack is logged for an unexpected error), so reproduce it, or catch and log inside the action with `log("error", ...)` from `@pso/http` |
| `502` / `503` / `504` | upstream | whether the service is running at the address in `pso.workspace.json`; its own logs with the same correlation id |

## Anti-patterns

- Validating authentication inside an action: use a guard, so the decision happens at stage 4 and appears in the same place for every route.
- Throwing `HttpError` for conditions the framework already covers (a missing field is a validation problem, not `new HttpError(400, ...)`).
- Returning internal error text to "help" the caller. The `500` body is deliberately generic. Note that the runtime does not log the cause either, so log it yourself where you can add context (never the request body or a token).

## Troubleshooting

| What you see | Which stage answered | How to tell |
|---|---|---|
| `401`, `403` | the gateway, before any service | `instance` is the public path (`/products`), and the gateway log has a `warn` line for `403` |
| `400` `PSO_VALIDATION_FAILED` with `instance` `/catalog/...` | the **service** validated and the gateway passed the answer through | the `/catalog` prefix in `instance` |
| `404` with `instance` not starting with the prefix | the gateway has no such route | `pso routes:list` |
| `404` with the service prefix | the service answered | the id or path |
| `500` `PSO_INTERNAL_ERROR` | an unexpected error in the service, with no cause in the body | the service log under the same `correlationId` |

All five were observed in [Build a CRUD API](/tutorials/crud-api). A response's `x-correlation-id` and the `correlationId` of its error body are the same id: search the logs for it.

## Next steps

- [Guards](/orchestrator/guards) and [middleware and filters](/orchestrator/middleware-and-filters)
- [Validate request bodies](/orchestrator/dto-validation)
- [Logging](/devops/logging)
