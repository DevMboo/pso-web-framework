---
title: TypeScript and Java conformance
description: Which behaviors are proven identical in the Node orchestrator and the Spring starters by shared fixtures, and which are not.
order: 13
status: partial
keywords: [conformance, fixtures, parity, jwt, problem details, rate limiting, dispatch envelope]
related: [reference/error-standard, security/rate-limiting, dispatch/contracts, security/authentication]
---
A claim of "the same behavior in both runtimes" is only made where a language-neutral fixture is executed by **both**. Each fixture is a plain JSON file in the repository root; each runtime has a test that fails when it disagrees with the file. Where a runtime does not implement something, the fixture does not pretend it does.

| Contract | Fixture | TypeScript test | Java test | What is proven |
|---|---|---|---|---|
| Error standard (RFC 9457) | the shared problem catalog | `problem.test.ts` | `ProblemsTests`, `ProblemTests` | 23 problem kinds: status, code, `type`, title, detail, in the same order; the Spring application produces them on the wire |
| Rate limiting | the shared rate-limit contract | `ratelimit.test.ts` (conformance) | `RateLimitContractTests` | token-bucket decisions (remaining, Retry-After), client address resolution with trusted proxies, key shapes |
| JWT claims | the shared JWT cases | `packages/security/test/conformance.test.ts` | `JwtConformanceTests` | 18 pre-signed tokens (valid, audience list, expired, `nbf`, wrong/missing issuer, wrong/missing audience, missing and empty `sub`, foreign signature, unknown `kid`, `alg: none`, HS256, malformed) get the same accept/reject verdict from the Node verifier and from a real Spring application against a real JWKS endpoint |
| Authorization, correlation id, liveness | the shared HTTP conformance cases | `conformance-http.test.ts` | `AuthorizationConformanceTests`, `ConformanceHttpTests` | 12 scope/role decisions (all scopes, any role, both required together); 8 correlation-id cases (a well-formed incoming id is propagated, a malformed one is replaced); liveness answers 200 with `status: UP` |
| Dispatch envelope and schemas | the shared dispatch contract data | `packages/dispatch/test/core.test.ts` | `pso-dispatch-test` | byte-identical canonical JSON, schema validation and compatibility results |

## Not covered, so not claimed

- **Configuration semantics.** Both runtimes validate their settings and refuse invalid ones, but the key names differ (`pso.limits.requests.*` in Spring, `http.rateLimit.*` / environment variables in the orchestrator) and there is no shared fixture of effective values.
- **Clock boundaries.** Expiry and `nbf` edges depend on the moment of the test, so the shared fixture only has tokens far in the past or future; the tolerance boundary is tested separately in each runtime.
- **Health bodies beyond `status`.** The orchestrator serves `/health/live` and `/health/ready`; Spring serves `/actuator/health` (with its own details). Only the liveness status and HTTP code are shared.
- **Authorization through HTTP.** The shared fixture covers the decision itself; each runtime also tests its enforcement (guards, method security) separately.
- **Service identity / mTLS.** Both runtimes implement and test TLS, mutual TLS, rotation and audience-aware forwarding, but each with its own tests and one deliberate difference: the Spring `tls.server-name` is an extra pin on top of the host name check, the Node `serverName` replaces the name used for verification ([Service identity](/security/service-identity)). No shared fixture.

## Regenerating a fixture

The shared problem catalog is generated from the TypeScript catalog and the Java catalog is edited to match (the Java test shows the first difference). The shared JWT cases are produced with throwaway keys; only the public JWK and the finished tokens are written, so no private key is ever stored.

## What this means for you

If you run both a Node orchestrator and Spring services, the observable behavior in these areas is the same on both sides, and the same fixture files are executed by each side's tests: the error bodies (RFC 9457, stable codes), rate-limiting behavior, JWT validation cases (18 pre-signed tokens), authorization decisions, the correlation-id rule (`^[A-Za-z0-9._-]{8,64}$`) and the Dispatch envelope. The verified examples elsewhere in this portal (a `403` with `PSO_AUTH_FORBIDDEN`, a `429` with `Retry-After`, a `400 PSO_VALIDATION_FAILED`) have the same shape from either runtime; wording of validation messages follows each library.

## Common mistakes

- Assuming identical validation messages between Node DTOs and Jakarta Validation.
- Parsing the legacy `error` member instead of `code`.

## Next steps

- [Error standard](/reference/error-standard)
- [Gateway or service validation?](/decisions/gateway-or-service-validation)
