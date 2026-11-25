---
title: Attack prevention
description: Which attacks each mechanism addresses, the honest limits, and where to see each defence working.
order: 8
status: partial
keywords: [injection, ssrf, path traversal, smuggling, owasp, jwt, cors, validation, rate limit]
related: [security/secure-routing, security/auditing, orchestrator/dto-validation, security/rate-limiting]
---
| Threat | What PSO does | Limit |
|---|---|---|
| Authentication bypass | guards fail closed; deny-by-default routes; services validate tokens themselves | the identity provider is trusted |
| JWT attacks (`alg: none`, HS256 key confusion, wrong issuer/audience, expired, unsigned) | asymmetric allow-list, strict claims, generic `401` | no revocation list |
| Authorization bypass / privilege escalation | scopes enforced in orchestrator and service | ownership checks are the service's job |
| SSRF | upstream hosts come only from the workspace file or `PSO_UPSTREAM_*`, never from request data; `host:port` is validated; Spring `PsoHttpClient` only calls declared services and never follows redirects | operators control the environment |
| Header spoofing / identity forgery | client `x-pso-*`, `x-forwarded-for`, `x-correlation-id` dropped; `Authorization` forwarded only on guarded routes (and only per the upstream's policy) | |
| Request smuggling via the proxy | hop-by-hop headers removed, `content-length` recomputed, Node's parser used | keep Node updated |
| Oversized bodies / slow clients | body limit, header and request timeouts, connection limit, upstream timeout | |
| Brute force / abusive clients | token-bucket rate limits per address, principal and route, optionally shared through Redis | not DDoS protection |
| Mass assignment | DTO validation rejects unknown properties by default; Spring DTOs are separate records, not entities | the Spring side relies on you not binding entities |
| Prototype pollution | `__proto__`, `constructor`, `prototype` cannot be DTO fields and are never copied | free-form `@Body()` JSON is yours to handle |
| Path traversal | generators validate every name and path; workspace paths must stay inside; the docs and Studio servers contain file paths; archive extraction refuses `..`, absolute paths and links | |
| Sensitive error disclosure | generic `500`; RFC 9457 bodies with constant messages; Spring `include-message: never` | application-raised `HttpError` messages are exposed on purpose |
| Secret leakage | references, redaction in config output and logs, scrubbed AI contexts | a log line you write yourself is yours |
| Injection (SQL, command) | the orchestrator has no database; the CLI builds commands from fixed argument lists, never from user-controlled shell strings; Spring services should use parameterised queries ([PostgreSQL CRUD](/spring/postgresql-crud)) | application code is yours |
| CORS, cookies, CSRF | no cookies or sessions; stateless bearer tokens. Spring services have CORS **off** by default with explicit origins when enabled ([security and CORS](/spring/security-and-cors)); the orchestrator has no CORS handling | enable CORS only for browsers that need it |
| Unsafe deserialization / file upload | JSON bodies are parsed; multipart is off by default in Spring services and is accepted only where a DTO declares file fields or a service enables storage. Uploads are bounded while streaming, verified against file signatures, stored under generated keys (never client names), served as attachments with `nosniff` and `sandbox` ([file uploads](/orchestrator/file-uploads), [storage](/spring/storage)) | no malware scanning engine is included: the `ContentScanner` hook is yours to implement |
| DDoS | basic rate and connection limits | not DDoS protection |

## Seeing a defence work

Real outputs (verified):

| Attack | Request | Result |
|---|---|---|
| unauthenticated call | `GET /customers` without a token | `401 PSO_AUTH_UNAUTHORIZED` |
| privilege escalation | valid token without the scope | `403 PSO_AUTH_FORBIDDEN` |
| exposing an undeclared method | `DELETE /customers/1` (decorated, not declared) | `404 PSO_HTTP_NOT_FOUND` |
| mass assignment | body `{"name":"gr","email":"nope","quantity":0,"admin":true}` against a DTO | `400 PSO_VALIDATION_FAILED` with `{"field":"admin","message":"is not allowed"}` |
| prototype pollution | body with `__proto__` and `constructor` keys | both reported as `is not allowed`; `Object.prototype` untouched (unit-tested) |
| oversized body | a body over `maxBodyBytes` | `413`, then the connection is closed (tested) |

## How to use this page

Treat it as a map of **where each threat is handled**, not as a guarantee. For each deployment, walk the [production checklist](/security/checklist) and add protections at the edge (WAF, DDoS service, network policy) that PSO does not provide.

Findings are verified by `pso security:check`; dependencies by `pso security:audit` (see [Security auditing](/security/auditing)).

## Next steps

- [Secure routing](/security/secure-routing)
- [Rate limiting](/security/rate-limiting)
- [Validate request bodies](/orchestrator/dto-validation)

## Common mistakes

- Treating this table as a guarantee instead of a map of where each threat is handled.
- Enabling permissive CORS or plain-text upstreams to get past an error.
- Assuming the orchestrator's limits replace edge protection (WAF, DDoS service, network policy).
