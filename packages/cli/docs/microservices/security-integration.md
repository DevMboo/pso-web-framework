---
title: Security integration in services
description: How each Spring Boot service validates tokens and scopes on its own, through the PSO security starter - the settings, what a missing setting does, the generated checks, and how to test and troubleshoot it.
order: 6
keywords: [spring security, jwt, resource server, scopes, PreAuthorize, pso-security-spring-boot-starter, 401, 403]
related: [spring/security-and-cors, security/authentication, security/authorization, concepts/security-by-default]
---
Every generated service is its own security boundary. It does not trust the orchestrator to have checked anything. The enforcement lives in `pso-security-spring-boot-starter`; the service only declares settings ([details](/spring/security-and-cors)).

| Setting | Environment variable | Meaning |
|---|---|---|
| `pso.security.jwt.jwks-uri` | `PSO_JWT_JWKS_URI` | where signing keys are fetched |
| `pso.security.jwt.issuer` | `PSO_JWT_ISSUER` | required `iss` |
| `pso.security.jwt.audience` | `PSO_JWT_AUDIENCE` | required `aud` |
| `pso.security.jwt.algorithms` | `PSO_JWT_ALGORITHMS` | allow-list, default `ES256,RS256`; only RS/PS/ES families accepted |

The starter builds a Nimbus decoder with the algorithm allow-list and validators for issuer, audience, timestamps and subject. **If jwks-uri, issuer and audience are all missing, every token is rejected; if only some are missing the service refuses to start; in `staging` and `prod` missing settings are a start-up error.**

On the `local` profile with nothing configured, the service says so when it starts (Expected output):

```text evidence="expected"
WARN [orders,,] ... c.p.s.s.PsoSecurityAutoConfiguration : JWT validation is not configured (pso.security.jwt.*): every bearer token ...
```

and a request without a token is `401` with `WWW-Authenticate: Bearer` (expected).

## Scopes

Scopes in the token become `SCOPE_*` authorities. `make:resource` generates controllers annotated like:

```java
@PreAuthorize("hasAuthority('SCOPE_customers:read')")
@GetMapping
public List<CustomerDto> list() { return List.of(); }
```

and tests for authorized, forbidden and anonymous callers. Only `/actuator/health` is public. `pso security:check` flags explicit `PUBLIC` rules for review, `pso.security.enabled: false` without a chain of your own as critical, and a legacy hand-written chain that ends in `permitAll()`.

The service sees the same `Authorization` header the orchestrator forwarded (guarded routes only). Spoofed `x-pso-*` identity headers are ignored; the service trusts the verified token, nothing else.

## How it is tested

The generated tests sign real tokens with a throwaway key and verify them against a real loopback JWKS endpoint (class `PsoTestJwt`). In a new service (verified from the generated test classes) `ApplicationTests` asserts that health is public, that everything else is denied without a token, that a forged bearer token is rejected and that the service prefix matches the workspace declaration; `ProductControllerTests` asserts, for the generated Product API, that a token with the scope succeeds, a token without it is `403`, no token is `401`, and invalid bodies are `400` with the fields at fault. Add the same shape of test to every controller you write.

## Variations

| You want | Do |
|---|---|
| a route open to any authenticated caller | `@PreAuthorize("isAuthenticated()")`, or an `AUTHENTICATED` rule in `pso.security.rules` |
| a role instead of a scope | map the roles claim (`roles-claim`) and use `hasRole` |
| a public route (rarely) | an explicit `PUBLIC` rule in `pso.security.rules`; `pso security:check` will flag it for review |
| service-to-service calls | give the caller its own credentials ([service identity](/security/service-identity)) |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401` for every token in local | JWT settings are empty: set `PSO_JWT_*` (the warning above is printed at start-up) |
| service refuses to start in `prod` | a required `PSO_JWT_*` setting is missing; the message names it |
| `401` only for tokens from one issuer | issuer or audience differ: compare the token's `iss`/`aud` with the settings |
| `403` for a valid token | the scope is not in the token (`scope` or `scp` claim): check the identity provider's grant |
| unauthenticated health works, everything else `401` | that is the default: only `/actuator/health` is public |

## Common mistakes

- Copying a development key into a production configuration.
- Adding `permitAll()` to a custom chain to "debug" and leaving it.
- Testing a controller without a test for the anonymous and the forbidden cases.

## Next steps

- [Spring security and CORS](/spring/security-and-cors)
- [Authorization](/security/authorization)
