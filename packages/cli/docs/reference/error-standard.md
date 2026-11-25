---
title: Error standard (RFC 9457)
description: One error format for the TypeScript orchestrator and every Spring service: Problem Details with stable PSO codes.
order: 12
status: implemented
keywords: [problem details, rfc 9457, application/problem+json, error codes, PSO_, correlationId]
related: [orchestrator/upstream-clients, security/authentication, spring/security-and-cors, spring/overview]
---
Every error the framework itself produces (not your application's domain errors) is `application/problem+json` with the same members in TypeScript and Java. The catalog is a language-neutral contract; both runtimes have tests that fail when their catalog differs from it.

```json
{
  "type": "urn:pso:problem:payload-too-large",
  "title": "Request body too large",
  "status": 413,
  "detail": "The request body exceeds the configured limit.",
  "instance": "/customers/upload",
  "code": "PSO_HTTP_PAYLOAD_TOO_LARGE",
  "correlationId": "5b0c…",
  "error": "payload_too_large"
}
```

| Member | Meaning |
|---|---|
| `type` | stable URI reference of the problem kind (`urn:pso:problem:<slug>`); it is an identifier, not a URL to fetch |
| `title`, `detail` | fixed, safe text. **Never** an exception message, a stack, a host path, a URL with credentials or user input |
| `status` | the HTTP status |
| `instance` | the request path of this occurrence, without the query string |
| `code` | the stable PSO code programs should switch on |
| `correlationId` | the request correlation id; also the `X-Correlation-ID` header |
| `errors` | validation problems: a list of `{ field?, message }` |
| `error` | **deprecated** legacy short code, kept so existing clients keep working |
| `fields` | **deprecated**, Java validation only: `{ field: message }` map of the former template handler |

## Codes

| Code | Status | When |
|---|---|---|
| `PSO_HTTP_BAD_REQUEST` | 400 | the request cannot be understood (also type mismatches) |
| `PSO_VALIDATION_FAILED` | 400 | bean validation failed; see `errors` |
| `PSO_HTTP_INVALID_JSON` | 400 | the body is not valid JSON |
| `PSO_HTTP_REQUEST_ABORTED` | 400 | the client closed the request early |
| `PSO_HTTP_MALFORMED_MULTIPART` | 400 | a `multipart/form-data` body that is not well formed (no boundary, truncated, bad part headers) |
| `PSO_AUTH_UNAUTHORIZED` | 401 | missing or invalid credentials; `WWW-Authenticate: Bearer` (`error="invalid_token"` when a token was presented) |
| `PSO_AUTH_FORBIDDEN` | 403 | authenticated but not allowed (scopes, roles, method security) |
| `PSO_HTTP_NOT_FOUND` | 404 | no such route (undeclared routes do not exist) |
| `PSO_HTTP_METHOD_NOT_ALLOWED` | 405 | Spring services; the `Allow` header is kept |
| `PSO_HTTP_PAYLOAD_TOO_LARGE` | 413 | body over the limit |
| `PSO_FILE_TOO_LARGE` | 413 | an uploaded file over its declared `maxSize` (orchestrator) or the service upload limit ([file uploads](/orchestrator/file-uploads), [storage](/spring/storage)) |
| `PSO_HTTP_UNSUPPORTED_MEDIA_TYPE` / `PSO_HTTP_MULTIPART_DISABLED` | 415 | wrong content type / multipart not enabled |
| `PSO_RATE_LIMITED` | 429 | rate limit; see `Retry-After` |
| `PSO_HTTP_HEADERS_TOO_LARGE` | 431 | request headers over the limit |
| `PSO_INTERNAL_ERROR` | 500 | anything unexpected; nothing about the failure is returned |
| `PSO_UPSTREAM_POLICY` | 500 | an outbound call was refused by the destination policy |
| `PSO_UPSTREAM_BAD_GATEWAY`, `PSO_UPSTREAM_RESPONSE_TOO_LARGE`, `PSO_UPSTREAM_UNKNOWN_SERVICE` | 502 | invalid upstream response / response over the limit / route names an unconfigured service |
| `PSO_UPSTREAM_TLS` | 502 | the TLS connection to an upstream could not be verified (untrusted, expired or wrong-name certificate, or the upstream rejected the client certificate); see [Service identity](/security/service-identity) |
| `PSO_UPSTREAM_UNAVAILABLE`, `PSO_SERVER_BUSY`, `PSO_RATE_LIMIT_UNAVAILABLE`, `PSO_STORAGE_UNAVAILABLE` | 503 | upstream unreachable / concurrency limit (also `MAX_CONCURRENT_UPLOADS`) / shared limiter down with a fail-closed policy / the file storage backend failed (provider detail stays in the server log) |
| `PSO_UPSTREAM_TIMEOUT` | 504 | upstream did not answer in time |

An error raised deliberately by application code with `HttpError(status, message)` keeps its status and its message as `detail`; its code is `PSO_HTTP_ERROR_<status>`. Custom guards and filters can still write their own responses.

## Where it comes from

- **TypeScript orchestrator** (`@pso/http`): every framework failure path, including request-size, upstream, rate-limit, guard and routing errors, header overflow (431) and concurrency shedding.
- **Spring services**: `PsoProblemAdvice` (all MVC failures, bean validation, unexpected exceptions), `PsoSecurityProblemAdvice` plus the entry point and access-denied handler of the security starter (401/403 from the filter chain and from `@PreAuthorize`), `PsoHttpProblemAdvice` (`PsoHttpClient` failures; the remote's message and body are never echoed), and the request-limit filters. Define your own bean of the same type to replace one, or add an `@ExceptionHandler` for your domain exceptions.

## Migration

The generated Spring template no longer contains an `ApiExceptionHandler`; existing services can delete theirs once they accept the standard body (the legacy `error` member and the Java `fields` map are still present). `Content-Type` changes from `application/json` to `application/problem+json`; clients that read `error` keep working.

## Real examples (expected)

```text evidence="expected"
401  {"type":"urn:pso:problem:auth-unauthorized","title":"Authentication required","status":401,"code":"PSO_AUTH_UNAUTHORIZED","error":"unauthorized","instance":"/customers","correlationId":"doc-corr-0002"}
403  {"type":"urn:pso:problem:auth-forbidden","title":"Access denied","status":403,"code":"PSO_AUTH_FORBIDDEN","error":"forbidden", ...}
404  {"type":"urn:pso:problem:http-not-found","title":"Resource not found","status":404,"code":"PSO_HTTP_NOT_FOUND","error":"not_found", ...}
418  {"type":"urn:pso:problem:http-418","title":"HTTP 418","status":418,"detail":"I am a teapot","code":"PSO_HTTP_ERROR_418","error":"I am a teapot", ...}     (an application HttpError)
429  {"type":"urn:pso:problem:rate-limited","title":"Too many requests","status":429,"code":"PSO_RATE_LIMITED","error":"too_many_requests", ...}      (with Retry-After)
500  {"type":"urn:pso:problem:internal-error","title":"Internal error","status":500,"code":"PSO_INTERNAL_ERROR","error":"internal_error", ...}
503  {"type":"urn:pso:problem:upstream-unavailable","title":"Upstream unavailable","status":503,"code":"PSO_UPSTREAM_UNAVAILABLE","error":"upstream_unavailable", ...}
```

and a validation failure with its field list (`400 PSO_VALIDATION_FAILED`):

```json
{ "type": "urn:pso:problem:validation-failed", "status": 400, "code": "PSO_VALIDATION_FAILED", "instance": "/orders", "correlationId": "demo-corr-0001",
  "errors": [ { "field": "admin", "message": "is not allowed" }, { "field": "customer", "message": "must have at least 3 characters" } ] }
```

## Reading a problem

| Member | Use it to |
|---|---|
| `code` | branch in code (stable; the legacy `error` member is kept for older clients) |
| `status` | the HTTP status (also in the response line) |
| `correlationId` | find the server log lines; also in the `x-correlation-id` header |
| `errors` | show field messages to a user (validation) |
| `detail` | a human sentence; constant for framework errors, the application's own text for `HttpError` |

## Answers of upstream services

When the orchestrator (`UpstreamClient`) or a Spring service (`PsoHttpClient`) calls another service and the application does not handle the outcome, the answer is one of these, identical in both runtimes. The upstream's own body is never forwarded.

| Legacy code | Status | Code | When |
|---|---|---|---|
| `upstream_not_found` | 404 | `PSO_UPSTREAM_NOT_FOUND` | the upstream answered 404: something the request depends on does not exist |
| `upstream_conflict` | 409 | `PSO_UPSTREAM_CONFLICT` | the upstream answered 409 |
| `upstream_rejected` | 502 | `PSO_UPSTREAM_REJECTED` | the upstream answered another 4xx (or a redirect): it refused a request this service made |
| `bad_gateway` | 502 | `PSO_UPSTREAM_BAD_GATEWAY` | the upstream answered 5xx or something that could not be read |

`Upstream.forward` is different by design: it relays the upstream's status and body to the client unchanged. To give a downstream outcome a meaning of your own, catch `UpstreamCallError` ([upstream clients](/orchestrator/upstream-clients)) or `PsoHttpException` ([HTTP client](/spring/http-client)) and raise your own error.

## Common mistakes

- Branching on `detail` text.
- Showing `detail` of a `500` as if it explained the cause: it is deliberately generic.
- Ignoring `correlationId` when reporting a problem.

## Next steps

- [Troubleshooting by symptom](/reference/troubleshooting)
- [Validate request bodies](/orchestrator/dto-validation)
