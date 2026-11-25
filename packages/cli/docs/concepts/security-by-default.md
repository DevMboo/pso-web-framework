---
title: Security by default
description: What is protected before you write any security code, shown with real requests and refusals, and what remains your responsibility.
order: 11
keywords: [security, deny by default, defaults, 401, 403, jwt, fail closed]
related: [security/secure-routing, decisions/why-deny-by-default, security/checklist, security/authentication]
---
Defaults are the security model. Out of the box:

| Layer | Default |
|---|---|
| Routes | Denied unless `public: true` is explicit or a guard is named (`PSO_ROUTE_007`) |
| `jwt` guard | Fails closed without issuer, audience and a key source; asymmetric algorithms only; `alg: none` and HS256 key confusion rejected |
| Public state-changing routes | Refused by the generators |
| Proxy | Client `x-pso-*`, `x-forwarded-for` and `x-correlation-id` are not forwarded (the gateway sends its own correlation id, which is the client's only if it is well-formed); `Authorization` forwarded only on guarded routes; body, timeout and rate limits |
| Spring services | Only health is public; they validate the JWT themselves and enforce scopes |
| Errors | Never leak internals (RFC 9457 with stable codes) |
| Configuration | Secrets only as references, always redacted |
| Keys | `security:keys --generate` adds `keys/*.private.pem` to `.gitignore`; private keys are never printed |
| Deployment | Never without `--yes`; SNAPSHOT builds refused |

Security is checked, not assumed: `pso security:check` inspects real files and configuration.

## What "denied by default" looks like

A guarded route, called three ways (Expected output, from a real run):

```text evidence="expected"
GET /customers  (no token)                                  -> 401  PSO_AUTH_UNAUTHORIZED
GET /customers  (valid token, missing scope customers:read) -> 403  PSO_AUTH_FORBIDDEN
GET /customers  (valid token with the scope)                -> routed to the service
```

And the framework tells you in the log *why*:

```text evidence="expected"
WARN  [security] authentication failed  reason=missing_header route="GET /customers"
WARN  [security] authorization denied (doc-corr-0003)  missing=scope:customers:read route="GET /customers"
```

Nothing in your code produced those lines. The route declared `security: { guard: "jwt", scopes: ["customers:read"] }`; the rest is the framework.

## A configuration that does not exist yet fails safe

On a fresh orchestrator with a guarded route and no JWT settings, `pso security:check` reports `HIGH SEC005` before you run anything, and the orchestrator itself exits at start-up rather than serving unprotected routes. Both outputs, and the other refusals (a symmetric algorithm, a missing key file, a plain-http JWKS URL), are reproduced in [Validation errors, one by one](/reference/diagnostics-catalog) and [Why the orchestrator refuses to start](/reference/startup-failures).

## Two layers, on purpose

The orchestrator validates the token, and every Spring service validates it again and enforces its own scopes. A request that reaches a service directly, bypassing the gateway, gains nothing. The cost is a second verification per hop; the benefit is that the network boundary is not the only boundary.

## What remains yours

| Responsibility | Why the framework cannot do it |
|---|---|
| choosing scopes that mean something | it enforces the names you declare |
| keeping the identity provider and its keys safe | it verifies tokens, it does not issue them |
| not weakening the defaults | `public: true`, relaxed CORS or `allowPlaintext` are explicit, reviewable decisions |
| business authorization ("may this user see this order?") | scopes say what an API may be used for, not whose data it is |
| transport security between services in production | configure TLS/mTLS ([service identity](/security/service-identity)) |

## Common mistakes

- Treating a green `pso validate` as a security review. It checks wiring; `pso security:check` and review check posture.
- Making a route public "temporarily".
- Disabling verification to get past a `401` instead of reading the log line that says why.

## Next steps

- [Secure routing](/security/secure-routing)
- [Production checklist](/security/checklist)
- [Why deny by default](/decisions/why-deny-by-default)
