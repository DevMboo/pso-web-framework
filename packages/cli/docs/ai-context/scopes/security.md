---
title: Security rules
description: Authentication, authorization, keys, secrets, rate limiting and auditing as implemented.
order: 6
scope: security
base: true
keywords: [ai, security, jwt]
---
## Authentication

- The orchestrator's `jwt` guard accepts only `Authorization: Bearer <jwt>` signed with an **asymmetric** algorithm (RS/PS/ES families, EdDSA). `HS*` and `none` are refused. It requires issuer, audience, `exp`, `sub`; honours `nbf`.
- Configuration (environment): `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, and exactly one of `PSO_JWT_JWKS_URI` (https, or loopback) or `PSO_JWT_PUBLIC_KEY_FILE` (PEM public key or X.509 certificate; one algorithm), plus `PSO_JWT_ALGORITHMS` (default `ES256,RS256`).
- Authentication lives in `@pso/security`; the generated `src/.app/guards/jwt.guard.ts` is only `export default JwtGuard.create();` and contains no JWT logic. Policy is declared in `pso.config.json` under `security.authentication.*` (`issuer`, `audience`, `algorithms`, `jwks.uri` or `publicKey.file`, `jwks.trustedHosts`, `rolesClaim`) and the `PSO_JWT_*` variables override it.
- Invalid or missing security configuration, an unreachable JWKS or a blocked/insecure JWKS endpoint **stops the application at start-up** (issue codes `PSO_SEC_*`); it never starts with a weakened guard. Never "fix" a 401 by disabling the guard. JWKS fetches are SSRF-protected (https, no redirects, private/metadata ranges blocked, host bound to the issuer or `trustedHosts`).
- Spring services validate the same variables independently. Token revocation is not implemented.
- A project `jwt.guard.ts` that is not `JwtGuard.create()` replaces the framework authentication ONLY when declared: `security.authentication.provider: custom` (+ `customProvider`). Undeclared, it stops start-up (`PSO_SEC_CUSTOM_GUARD_UNDECLARED`); in production it must use `CustomGuard.create({ provider, verify })`. Never create a custom guard to get around a 401.
- Outbound calls from the orchestrator: TLS verification can never be disabled. Use per-upstream settings (`http.upstreams.<name>.tls.caFile/certFile/keyFile/serverName`, `forward`, `audience`) for private CAs, mutual TLS and credential forwarding; a bearer token is forwarded only on guarded routes, over TLS or loopback, and only if the upstream's audience matches. Key passphrases and tokens come from the environment, never from a file. See /security/service-identity.

## Authorization

- Scopes: `security: { guard: "jwt", scopes: ["orders:read"] }` (403 when missing) and `@PreAuthorize("hasAuthority('SCOPE_orders:read')")` in services. Roles: `@RequireRoles("admin")` / `security.roles` (at least one role per level, levels combine with AND); scopes: all required. Use `@RequireScopes`, `@RequireRoles`, `@CurrentPrincipal()` from `@pso/security`. Authentication (who) is separate from authorization (what): `401` vs `403`. Check resource ownership in the owning service. `security:init|validate|inspect|doctor` do not exist yet; do not invent them.

## Routing policy

- Every route needs `public: true` or a guard (`PSO_ROUTE_007`). Generators refuse public non-GET routes. Never combine public and guarded.

## Keys and secrets

- `pso security:keys --generate [--alg ES256|RS256]`, `pso security:rotate`, `pso security:rotate --retire <kid>`: development keys only; private keys are git-ignored and never printed. Production keys belong to the identity provider.
- Configuration secrets must be references (`${env:NAME}`). `.env` and `keys/` stay out of git and images.

## Limits you must respect

- Rate limiting is token-bucket per client address, per authenticated principal and per route (`http.rateLimit.*` / `RATE_LIMIT_*`; Spring: `pso.limits.requests.*`). It is local by default; Redis (`provider: redis`, optional, never started unless selected) shares one budget between instances. `X-Forwarded-For` counts only from `trusted-proxies`. It is not DDoS protection. See /security/rate-limiting.
- Framework errors are RFC 9457 problems (`application/problem+json`, stable `PSO_*` codes) in the orchestrator and in Spring; do not hand-write error bodies or exception handlers for them. See /reference/error-standard.
- Inbound TLS termination in the orchestrator is not implemented (use a reverse proxy); outbound TLS/mTLS to upstreams is. CORS is not implemented in the orchestrator.
- An identity provider on a private network must be approved by naming its JWKS endpoint exactly, in BOTH runtimes: `PSO_JWT_JWKS_PRIVATE_HOSTS=host:port` (`security.authentication.jwks.privateHosts`, Spring `pso.security.jwt.private-hosts`), with `PSO_JWT_JWKS_CA_FILE` for a private authority. Never widen it with a wildcard and never disable verification.
- `pso security:check`, `pso security:validate` and `pso lint` evaluate ONE environment (`--env`, else `PSO_ENV`, else development) with the sources the application reads in it; production reads no `.env` file. A clean development result says nothing about production: validate production with `--env production`.
- Diagnostics: `GET /_pso/telemetry` exists only with `PSO_DIAGNOSTICS_TOKEN` (32+ chars, from the environment). OpenTelemetry export is opt-in through `OTEL_EXPORTER_OTLP_ENDPOINT`. Never log or print these values. See /devops/observability.

## Auditing

`pso security:check` (exit 1 on high/critical; `--strict` includes medium), `pso security:audit` (`npm audit` and POM scan; it does **not** scan Maven dependencies for CVEs), `pso security:policy`.

{{facts:commands:security}}
