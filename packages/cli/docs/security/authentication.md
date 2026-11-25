---
title: Authentication: JWT and JWKS
description: How the framework-owned jwt guard verifies bearer tokens and how its policy is declared in configuration.
order: 1
keywords: [jwt, jwks, authentication, bearer, token, JwtGuard, "@pso/security", security.authentication, PSO_JWT_ISSUER]
related: [security/security-configuration, security/authorization, security/keys-and-pem, orchestrator/guards]
---
Authentication is owned by the `@pso/security` package. A generated orchestrator contains **no JWT code**: the `jwt` guard is provided by the framework and you only declare the policy.

```typescript title="src/.app/guards/jwt.guard.ts"
import { JwtGuard } from "@pso/security";

export default JwtGuard.create();
```

If no `jwt.guard.ts` exists, the framework registers the same guard automatically under the name `jwt`. Routes without an explicit policy inherit it (deny by default).

PSO validates tokens issued by an identity provider. It does not implement an identity provider and never stores passwords.

## What the guard verifies

| Check | Rule |
|---|---|
| Format | `Authorization: Bearer <header.payload.signature>`, at most `maxTokenBytes` (default 8 KB) |
| Signature | **asymmetric only**: `RS256/384/512`, `PS256/384/512`, `ES256/384/512`, `EdDSA`. `HS*` and `none` are refused, which also blocks algorithm-confusion attacks |
| Issuer / audience | must match `security.authentication.issuer` / `audience` |
| Time | `exp` required, `nbf` honoured, `clockToleranceSeconds` (default 5) |
| Subject | `sub` required and non-empty |
| Token type | enforced when `tokenType` is configured (for example `at+jwt`) |
| Failure | always `401` with no reason disclosed to the client; the internal reason is logged without the token |

The result of a successful verification is an immutable [`Principal`](/security/authorization) (subject, issuer, audiences, scopes, roles, permissions, expiry). It never carries the raw token.

## Declaring the policy

Everything is declared in `pso.config.json`; see [Security configuration](/security/security-configuration) for all keys.

```json title="pso.config.json"
{
  "security": {
    "authentication": {
      "provider": "jwt",
      "issuer": "https://idp.example.com",
      "audience": "my-platform-api",
      "algorithms": ["ES256"],
      "jwks": { "uri": "https://idp.example.com/.well-known/jwks.json" }
    }
  }
}
```

Exactly one key source is allowed: `jwks.uri` (remote, cached and rotated) or `publicKey.file` (a PEM public key or X.509 certificate).

The classic `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, `PSO_JWT_JWKS_URI`, `PSO_JWT_PUBLIC_KEY_FILE` and `PSO_JWT_ALGORITHMS` environment variables still work and override the file.

## Remote JWKS safety

- The URI must use **https**. `http` to loopback is a development-only exception and is rejected when the environment is `production`.
- Outside development the JWKS host must equal the issuer's host or be listed in `jwks.trustedHosts`.
- The host is resolved once, **every** address is checked against private, loopback, link-local and cloud-metadata ranges, and the connection is pinned to the validated address (no second DNS lookup).
- Redirects are not followed; responses are size- and time-limited and must be JSON containing **public** keys only.
- Keys are cached (`cacheTtlSeconds`, default 10 minutes). An unknown `kid` triggers at most one refresh per cool-down; concurrent requests share one fetch. If the provider is briefly unavailable, previously fetched keys keep serving for a bounded time.
- A host with several addresses is tried address by address, IPv4 first; each address is validated before any connection.

### Loading the keys at start-up

The orchestrator loads the keys before it listens, and does not start without them. A network that needs a moment must not decide that, so the load is retried, within bounds:

| Setting (`security.authentication.jwks.*`) | Variable | Default | Meaning |
|---|---|---|---|
| `connectTimeoutMs` | `PSO_JWT_JWKS_CONNECT_TIMEOUT_MS` | `2000` | time to establish one connection (TCP and TLS) |
| `timeoutMs` | `PSO_JWT_JWKS_TIMEOUT_MS` | `3000` | time for one whole request |
| `initDeadlineMs` | `PSO_JWT_JWKS_INIT_DEADLINE_MS` | `20000` | overall time the start-up load may take, retries included (`0`: one attempt) |

| Failure | Retried at start-up |
|---|---|
| DNS failure, refused or timed-out connection, timed-out request, HTTP 5xx or 429 | yes: exponential backoff from 250 ms to 5 s with jitter, until the deadline or 12 attempts |
| TLS verification failure, blocked address, redirect, wrong content type, invalid or oversized key set, private key material | no: the first failure ends start-up |

While the load is running nothing is listening: `/health/ready` cannot answer 200 and no request is accepted, so no token is ever checked without keys. When the load fails, the log line says how many attempts were made and how long they took (`could not load the signing keys from idp:8443: jwks_status: ... (7 attempts in 20004 ms)`) and the process exits 1.

### An identity provider on a private network

A JWKS address that resolves to a private address is refused unless that exact endpoint was approved:

```bash
PSO_JWT_ISSUER=https://idp:8443
PSO_JWT_JWKS_URI=https://idp:8443/.well-known/jwks.json
PSO_JWT_JWKS_PRIVATE_HOSTS=idp:8443          # security.authentication.jwks.privateHosts
PSO_JWT_JWKS_CA_FILE=/run/pso/tls/ca.crt     # security.authentication.jwks.caFile, for a private certificate authority
```

| Rule | Detail |
|---|---|
| what is approved | the JWKS URI itself, when its `host:port` equals an entry. The port is required; wildcards, schemes and paths are refused (`PSO_SEC_JWKS_PRIVATE_HOST`) |
| which addresses | 10/8, 172.16/12, 192.168/16 and fc00::/7. Loopback, link-local, the metadata address, CGNAT and multicast stay refused even for an approved endpoint |
| what does not change | HTTPS only; the JWKS host must still be the issuer's host (or in `trustedHosts`); every DNS answer is validated on every fetch and the connection is pinned to it; redirects are refused; the issuer in the token is still compared exactly |
| what it never does | it does not open other private destinations, and no URL is ever taken from a token |
| the certificate | verified against `caFile` when set, otherwise against the system authorities. There is no option to skip verification; the file must contain certificates only |

Spring services read the same authority from `pso.security.jwt.ca-file` (`PSO_SECURITY_JWT_CA_FILE`).

## Fail closed at start-up

Security configuration is validated and key providers are initialised **before the server listens**. A missing issuer or audience, a missing or conflicting key source, an unsupported algorithm, a private key in the PEM file, an insecure or blocked JWKS endpoint or an unreachable JWKS after the controlled retries stops start-up with issue codes (`PSO_SEC_MISSING`, `PSO_SEC_ALGORITHM`, `PSO_SEC_KEY_CONFLICT`, `PSO_SEC_PEM_PATH`, `PSO_SEC_JWKS_URI`, `PSO_SEC_JWKS_INSECURE`, `PSO_SEC_JWKS_HOST`, `PSO_SEC_INIT`, ...). The process exits non-zero and nothing is served. Messages never contain tokens, keys or claims.

## Custom guards

The framework `jwt` guard is the default and cannot be replaced by accident: **a `jwt.guard.ts` that exists but is not `JwtGuard.create()` stops start-up** (`PSO_SEC_CUSTOM_GUARD_UNDECLARED`). To use your own authentication, declare it:

```json title="pso.config.json"
{ "security": { "authentication": { "provider": "custom", "customProvider": "corporate-sso" } } }
```

```typescript title="src/.app/guards/jwt.guard.ts"
import { CustomGuard } from "@pso/security";

export default CustomGuard.create({
  provider: "corporate-sso",
  verify: async (req) => /* verify the credential; return true/false or { allow: true, principal } */ false,
});
```

Rules enforced at start-up (nothing listens and no route is active when one fails):

| Code | Condition |
|---|---|
| `PSO_SEC_CUSTOM_GUARD_UNDECLARED` | a custom `jwt` guard exists but `provider` is not `custom` |
| `PSO_SEC_CUSTOM_GUARD_MISSING` | `provider` is `custom` but the guard is missing or is the framework guard (no silent fallback) |
| `PSO_SEC_CUSTOM_GUARD_UNIDENTIFIED` | production (`PSO_ENV` or `NODE_ENV` = `production`) and the guard was not created with `CustomGuard.create` |
| `PSO_SEC_CUSTOM_GUARD_MISMATCH` | the identity passed to `CustomGuard.create` differs from `customProvider` |
| `PSO_SEC_PROVIDER` | `provider` is neither `jwt` nor `custom` |

An active custom guard is logged at start-up (`custom authentication is active`, with the provider and environment) and reported by `pso security:check` as `SEC012`. You own token verification: the framework JWT configuration is not required for it. A custom guard can still hand over an identity with `{ allow: true, principal }` so scopes and roles are enforced centrally ([Guards](/orchestrator/guards)); authentication (who) and authorization (what) stay separate. **Migration:** applications that already replaced `jwt.guard.ts` must add the declaration above (and should switch to `CustomGuard.create`); this is a deliberate security correction.

## Services validate again

Spring services read the same `PSO_JWT_*` variables and verify the forwarded token themselves ([Security integration](/microservices/security-integration)). The orchestrator forwards the bearer token to upstream services on guarded routes when `security.propagation.forward` is `bearer` (default) and never on public routes; set it to `none` to forward nothing.

## Not implemented

Token revocation lists and introspection, token issuing, token exchange and expected service identities. Use short-lived tokens and your provider's revocation features.

## What you see (expected)

With the verifier configured, a request without a token and one with a token lacking the scope (the reasons are in the log, not in the body):

```text evidence="expected"
GET /customers (no token)           -> 401 PSO_AUTH_UNAUTHORIZED   WARN [security] authentication failed  reason=missing_header route="GET /customers"
GET /customers (wrong scope)        -> 403 PSO_AUTH_FORBIDDEN      WARN [security] authorization denied  missing=scope:customers:read route="GET /customers"
```

and at start-up the verifier reports itself: `INFO [security] security initialized (pem, ES256)` (a PEM public key with ES256). Without configuration `pso security:check` reports `SEC005` before anything runs.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| every token is `401` | issuer, audience or algorithm differ; key source missing or wrong | the `reason=` in the log; the token's `iss`, `aud`, `alg` |
| `401` only after a while | tokens expire; clock skew | `exp`; `clockToleranceSeconds` (default 5) |
| `401` after rotating keys | the verifier cached the old JWKS | wait for `jwks.cacheTtlSeconds` (default 600) or reduce it |
| start-up refuses with `PSO_SEC_*` | configuration invalid or an undeclared custom guard | the message names the setting |
| JWKS fetch fails | plain http, blocked host, timeout | https only (loopback excepted); `jwks.trustedHosts`; `jwks.timeoutMs` |

## A development identity provider: `pso idp:dev`

To exercise authentication on your own machine without an account at a real provider, the CLI creates a development issuer for the workspace. Its signing key is generated on your machine, is git-ignored and is used nowhere else.

```bash
pso idp:dev init
pso idp:dev token --scopes orders:read,orders:write
pso idp:dev token --sub alice --roles admin --ttl 300 --json
```

`init` writes `idp/` (the public key set `jwks.json`, a small JWKS server `dev-idp.cjs`, the private key under `idp/keys/`) and `docker-compose.idp.yml`, and prints the `PSO_JWT_*` values. `token` prints a signed JWT and nothing else, so it can be used directly:

```bash
curl -H "Authorization: Bearer $(pso idp:dev token --scopes orders:read)" http://127.0.0.1:3000/orders
```

| You run | Keys reach the applications through | Settings |
|---|---|---|
| `pso dev` | `pso idp:dev serve` (loopback, plain HTTP, public keys only) | in the orchestrator's and each service's `.env`: `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, `PSO_JWT_JWKS_URI=http://127.0.0.1:9443/.well-known/jwks.json`, `PSO_JWT_ALGORITHMS=ES256` |
| the generated Compose deployment | the `idp` container of `docker-compose.idp.yml` (HTTPS with the certificate from `pso tls:init --dev --hosts idp`) | in `.env`: the six lines `init` prints, including `PSO_JWT_JWKS_PRIVATE_HOSTS=idp:8443` and `PSO_JWT_JWKS_CA_FILE=/run/pso/tls/ca.crt` |

The JWKS server holds public keys only: the private key never enters a container or an image. It is a development tool and is kept out of production in three ways: the commands refuse to run with `PSO_ENV=production`; `pso security:check --env production` reports a configuration that names this issuer (`SEC013`, critical); and the overlay is a separate file that a production deployment does not include. It has no users, no login and no revocation.

## Spring services apply the same private-network rule

A Spring service fetches the signing keys itself, under the rule the orchestrator applies: a JWKS endpoint that is, or resolves to, a private, link-local (including the cloud metadata address), shared or reserved address is refused unless it is approved by naming it exactly.

```yaml title="application.yml (generated)"
pso:
  security:
    jwt:
      jwks-uri: ${PSO_JWT_JWKS_URI:}
      private-hosts: ${PSO_JWT_JWKS_PRIVATE_HOSTS:}   # host:port of the JWKS URI, e.g. idp:8443
      ca-file: ${PSO_JWT_JWKS_CA_FILE:}               # PEM authority of the identity provider, when it is not a public one
```

The approval covers that one endpoint, over https, on exactly that host and port; there are no wildcards. Loopback stays allowed for development, redirects are never followed and the request has a connect and a read timeout. A service generated by an earlier version reads the same value from `PSO_SECURITY_JWT_PRIVATE_HOSTS` (Spring's own binding of the property), which the generated `docker-compose.yml` also sets. Limit: the address is checked at start-up and before every key request, but the connection is not pinned to the checked address as it is in the orchestrator.

## Common mistakes

- Using HS256 shared secrets (symmetric algorithms are not accepted).
- Disabling verification in development and forgetting it.
- Verifying in the gateway only: the service verifies too.

## Next steps

- [Keys, PEM and rotation](/security/keys-and-pem)
- [Protect an API with JWT scopes](/tutorials/authentication)
