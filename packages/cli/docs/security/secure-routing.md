---
title: Secure routing
description: The route policy model - declared, guarded, validated and enforced twice - with the real answers a request gets at each layer and the checks that keep the model honest.
order: 7
keywords: [routing, policy, deny by default, PSO_ROUTE_007, public, security:policy, SEC004]
related: [orchestrator/routes, security/authorization, decisions/why-deny-by-default, orchestrator/request-lifecycle]
---
1. **Declared.** Only routes in `ROUTES.pso.ts` of a valid module exist. Everything else is `404`.
2. **Policy required.** Each route has `security: { public: true }` or one or more guards. No policy is `PSO_ROUTE_007`.
3. **Never weakened.** A route that is public while a decorator requires a guard is rejected.
4. **Unsafe public routes refused.** The generators will not create a public non-GET route; if you declare one by hand, `pso security:check` reports it as a high finding (`SEC004`).
5. **Validated before activation.** Any validation error stops the orchestrator; nothing is activated.
6. **Enforced twice.** The orchestrator's guard checks the token and scopes; the Spring service checks them again.

## See the policy

```bash
pso security:policy      # effective policy of every route and service
pso routes:list          # declared routes and their access
pso security:check       # findings with severity and remediation
```

Expected output for a gateway with one guarded route and one public route:

```text evidence="expected"
$ pso security:policy
default: deny
GET     /products                guarded:jwt scopes=[products:read]  -> catalog
service catalog: deny by default

$ pso routes:list
GET     /products                product.findAll        -> catalog        guard:jwt
GET     /reports/summary         reports.summary                          public
```

## What a caller experiences, route by route

| Route | Request | Answer (verified) |
|---|---|---|
| `GET /customers` guarded with scope `customers:read` | no token | `401 PSO_AUTH_UNAUTHORIZED` |
| same | token without the scope | `403 PSO_AUTH_FORBIDDEN` |
| same | right scope, service down | `503 PSO_UPSTREAM_UNAVAILABLE` |
| `GET /reports/summary` public | no token | `200` |
| `DELETE /customers/1` decorated, not declared | any | `404 PSO_HTTP_NOT_FOUND` |

The reasons appear in the log, never in the response body: `authentication failed reason=missing_header` and `authorization denied missing=scope:customers:read` ([logging](/devops/logging)).

## Review checklist for a `ROUTES.pso.ts` change

1. Does every new route have a policy, and is `public: true` really intended?
2. Is a state-changing route guarded, with a scope that is specific (`orders:write`, not a shared read scope)?
3. Does `metadata.service` name the service that should receive it?
4. Does `pso security:policy` show what you expected?

## Variations

| You want | Declare |
|---|---|
| any authenticated caller | `security: { guard: "jwt" }` |
| a specific scope | `security: { guard: "jwt", scopes: ["orders:write"] }` |
| a role | `security: { guard: "jwt", roles: ["admin"] }` |
| a custom check | a named guard in `src/.app/guards/` (application-wide) or `src/modules/<module>/guards/` ([guards](/orchestrator/guards)) |
| a public read-only route | `security: { public: true }` on a `GET` |

## Common mistakes

- Making a write route public because "it is only used internally": internal is not authenticated.
- One broad scope for everything.
- Assuming a registered service is reachable by every caller (registration grants nothing).

A route declaration is **not** authentication. See [Routing](/orchestrator/routes) and [Why deny by default](/decisions/why-deny-by-default).
