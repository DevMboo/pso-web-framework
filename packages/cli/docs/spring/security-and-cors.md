---
title: Spring security and CORS
description: YAML-driven JWT validation, authorization rules, CORS and security headers, all deny-by-default.
order: 5
status: partial
keywords: [spring security, jwt, jwks, cors, rules, pso.security, resource server, headers, preauthorize]
related: [spring/configuration, security/authentication, security/authorization, microservices/security-integration]
---
`pso-security-spring-boot-starter` configures Spring Security from `pso.security.*`. It uses Spring Security and Nimbus for all token handling: **no custom cryptography**.

## JWT

```yaml
pso:
  security:
    jwt:
      jwks-uri: ${PSO_JWT_JWKS_URI:}
      issuer: ${PSO_JWT_ISSUER:}
      audience: ${PSO_JWT_AUDIENCE:}
      algorithms: ${PSO_JWT_ALGORITHMS:ES256,RS256}
```

Validated: signature (asymmetric algorithms only), issuer, audience, expiry and not-before with the configured clock skew, and a non-empty `sub`. `alg: none` and symmetric tokens are rejected. Scopes (`scope` or `scp`) become `SCOPE_*` authorities and the roles claim becomes `ROLE_*`.

- All three settings missing: every token is rejected (a warning is logged). That keeps a fresh service safe in development.
- Some missing, or an invalid value (symmetric algorithm, plain-http non-loopback JWKS, credentials in the URL): the service **does not start**.
- In the `staging` and `prod` profiles missing JWT settings are a start-up error.

## Authorization

Only `/actuator/health` (and its probes) is public. Everything else needs a valid token. Add requirements with method security, or declaratively; paths are relative to the [service prefix](/spring/service-prefix):

```yaml
pso:
  security:
    rules:
      - path: /customers/**
        methods: [GET]
        access: SCOPES        # PUBLIC | AUTHENTICATED | SCOPES
        scopes: [customers:read]
      - path: /customers/**
        methods: [POST]
        access: SCOPES
        scopes: [customers:write]
        roles: [editor, admin]   # at least one role, and all scopes
```

Rules apply in order; an invalid rule stops start-up. A `PUBLIC` rule is explicit and reported by `pso security:check` for review. Missing identity is `401`; an authenticated caller without the scope or role is `403`.

## CORS

```yaml
pso:
  security:
    cors:
      enabled: true
      allowed-origins: [http://localhost:3000, http://127.0.0.1:3000]
      allowed-methods: [GET, POST, PUT, PATCH, DELETE, OPTIONS]
      allowed-headers: [Authorization, Content-Type, X-Correlation-ID]
      allow-credentials: false
      max-age: 30m
```

It becomes a real Spring Security CORS policy, applied before authentication so preflight requests need no token. The rules are strict:

- origins are exact (`scheme://host[:port]`, no path, no trailing slash); `*` is rejected;
- `allowed-origin-patterns` accepts only a wildcard subdomain such as `https://*.example.com`, and never together with credentials;
- enabling CORS without any origin is an error: it never defaults to allowing everything;
- headers and methods are listed explicitly.

CORS is a browser rule. It is **not** authentication, and two services on the same host are not trusted because of it. Local origins are in the `local` profile; configure production origins intentionally through `PSO_CORS_ENABLED` and `PSO_CORS_ORIGINS`.

## Headers, errors and replacing the chain

Responses carry the Spring Security defaults (`X-Content-Type-Options`, `X-Frame-Options`, `Cache-Control: no-store`) plus `Referrer-Policy: no-referrer`. Error pages for permitted paths stay reachable (a `404` on a public path is not turned into `401`). CSRF protection is disabled because the API is stateless and uses bearer tokens only.

To take full control, define your own `SecurityFilterChain` bean (the starter backs off) or set `pso.security.enabled: false`. `pso security:check` flags a service that has neither the starter nor a chain.

## Not implemented

Service-to-service authentication (token exchange, client credentials), token revocation and introspection.

## What you see (expected)

A generated service with no JWT settings on the local profile warns at start-up, and answers `401` to a request without a token:

```text evidence="expected"
WARN [orders,,] ... c.p.s.s.PsoSecurityAutoConfiguration : JWT validation is not configured (pso.security.jwt.*): every bearer token ...
HTTP/1.1 401   WWW-Authenticate: Bearer   X-Correlation-ID: bfb268c4-8017-4269-bda7-d083bc332384
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| a browser call fails with a CORS error | CORS is off by default: enable it with explicit origins (`PSO_CORS_ENABLED`, `PSO_CORS_ORIGINS`); never `*` |
| `401` from a valid token | issuer/audience/algorithm mismatch ([security integration](/microservices/security-integration)) |
| `403` | the scope is not in the token |

## Common mistakes

- Enabling CORS for every origin to make a demo work.
- Treating CORS as authentication (it is a browser rule).
- Adding `permitAll()` for debugging.

## Next steps

- [Security integration](/microservices/security-integration)
- [Authentication](/security/authentication)
