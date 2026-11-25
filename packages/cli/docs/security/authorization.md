---
title: Authorization: scopes, roles and principal
description: Declarative scope and role requirements, how levels combine, and how to read the current principal.
order: 2
status: partial
keywords: [authorization, scopes, roles, RequireScopes, RequireRoles, CurrentPrincipal, Principal, 401, 403, ownership]
related: [security/authentication, security/security-configuration, orchestrator/guards, microservices/security-integration]
---
Authentication answers **who is calling** (a guard establishes a `Principal`). Authorization answers **what that caller may do** and is evaluated centrally by the framework after authentication.

| Outcome | Status |
|---|---|
| No valid identity | `401` |
| Valid identity, requirement not met | `403` |
| Requirement declared but no guard established an identity | `403` (fail closed) |

## Declaring requirements

```typescript
import { RequireScopes, RequireRoles, CurrentPrincipal } from "@pso/security";
import type { Principal } from "@pso/security";

@Controller() @RestController("/customers")
@RequireScopes("customers:read")
export class CustomerController {
  @Get("/") findAll() { /* ... */ }

  @Delete("/:id")
  @RequireScopes("customers:delete")
  @RequireRoles("admin", "support")
  remove(@Param("id") id: string, @CurrentPrincipal() who: Principal) { /* who.subject */ }
}
```

The same requirements can be declared in `ROUTES.pso.ts` (`security: { guard: "jwt", scopes: [...], roles: [...] }`) and on the module (`defineModule({ security: { scopes: [...], roles: [...] } })`). The decorators expose nothing by themselves: the route must still be declared in `ROUTES.pso.ts`.

## Combination rules (deterministic)

Policy levels, from the weakest to the most specific: framework default (authenticated `jwt`), module, controller, action, route declaration. Levels **only add**:

- **Scopes:** the caller needs **every** scope declared at any level.
- **Roles:** each level that declares roles is a set of alternatives, and the caller needs **at least one role from every such level** (AND of ORs). A lower level can only restrict further.
- **Permissions:** all required permissions.
- A `public` route combined with any guard, scope or role is a validation error (`PSO_ROUTE_007`).

Where claims come from is configurable: scopes from `scope` (space separated) or `scp`, roles from `security.authentication.rolesClaim` (default `roles`, dotted paths such as `realm_access.roles` allowed), permissions from `permissionsClaim`.

## The principal

`Principal` is immutable and has `subject`, `issuer`, `audiences`, `scopes`, `roles`, `permissions`, `expiresAt`, and `hasScope()`, `hasRole()`, `hasPermission()`. It does not contain the raw token and its `toJSON()` is safe to log. Each request runs in its own security context, so concurrent requests never see each other's identity. `@CurrentPrincipal()` injects it into a controller parameter; on a public route it is `undefined`.

## Spring services

Services enforce the same scopes with method security, so a request that bypasses the orchestrator is still checked (`403`):

```java
@PreAuthorize("hasAuthority('SCOPE_customers:read')")
```

Spring's `hasRole` is not wired.

## Resource ownership

Insecure direct object references are prevented by **checking ownership in the service that owns the data** (compare the principal's `subject` with the resource owner). The framework does not do this for you; the orchestrator holds no domain data.

## Service-to-service

A calling service presents a token like any other client; the orchestrator can forward the caller's bearer token (`security.propagation.forward`). Token exchange and client-credentials flows are **not implemented**; the orchestrator forwards the user's token or nothing. Service identity through mutual TLS **is** implemented for calls from the orchestrator and from Spring's `PsoHttpClient` ([Service identity](/security/service-identity), [Service-to-service communication](/microservices/service-to-service)).

## What you see (expected)

```text evidence="expected"
valid token without the scope  -> 403 {"code":"PSO_AUTH_FORBIDDEN", ...}
log:  WARN [security] authorization denied (doc-corr-0003)  missing=scope:customers:read route="GET /customers"
```

The log line names exactly what was missing, so a `403` is diagnosable without exposing the policy to the caller.

## Variations

| You want | Declare |
|---|---|
| one scope | `scopes: ["orders:read"]` |
| several scopes (all required) | `scopes: ["orders:read", "orders:export"]` |
| a role | `roles: ["admin"]` |
| an extra rule on top of the token | a `policy` function on the JWT guard |

## Common mistakes

- One scope for the whole API.
- Treating scopes as ownership: "may this user see this order?" is the service's job.
- Relying on the gateway only: the Spring service enforces its own scopes (`@PreAuthorize`).

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `403` `PSO_AUTH_FORBIDDEN` from the gateway | the token is valid but lacks a scope the route lists | the gateway log: a `warn` "authorization denied" with `missing: scope:<name>` | issue the scope or correct the route's `scopes` |
| `403` from the service, with `instance` starting with the service prefix | `@PreAuthorize` on the controller method requires an authority the token does not carry | the token's `scope` claim; Spring authorities are `SCOPE_<scope>` | issue the scope |
| `401` instead of `403` | the token itself is rejected: signature, issuer, audience or expiry | `pso security:validate` and the service's JWT settings | fix the token or the settings |
| a read-only token creates data | write routes and methods share a scope with read | `pso security:policy` | give writes their own scope (`products:write`) |

The first three rows are reproduced end to end in [Build a CRUD API](/tutorials/crud-api) (`403` for a token with only `products:read`, from the gateway and from the service).

## Next steps

- [Secure routing](/security/secure-routing)
- [Security integration in services](/microservices/security-integration)
