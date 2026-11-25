---
title: Security configuration
description: Every security.* key, its default, the environment overrides and the start-up validation.
order: 2
keywords: [security configuration, pso.config.json, security.authentication, PSO_JWT, PSO_CFG, trustedHosts, rolesClaim]
related: [security/authentication, security/authorization, concepts/configuration]
---
Security is configured declaratively under `security.*` in `pso.config.json` and validated **before the application starts**. All problems are reported together; no value (token, key, secret) is ever included in a message.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `security.authentication.provider` | `jwt` | only `jwt` exists |
| `security.authentication.issuer` | required | expected `iss` |
| `security.authentication.audience` | required | expected `aud` (string or list) |
| `security.authentication.algorithms` | `["ES256","RS256"]` | asymmetric algorithms only |
| `security.authentication.clockToleranceSeconds` | `5` | 0 to 60 |
| `security.authentication.maxTokenBytes` | `8192` | 256 to 16384 |
| `security.authentication.tokenType` | none | required `typ` header (for example `at+jwt`) |
| `security.authentication.rolesClaim` | `roles` | claim path for roles |
| `security.authentication.permissionsClaim` | `permissions` | claim path for permissions |
| `security.authentication.jwks.uri` | one key source required | remote JWKS |
| `security.authentication.jwks.timeoutMs` | `3000` | 200 to 15000 |
| `security.authentication.jwks.cacheTtlSeconds` | `600` | 30 to 86400 |
| `security.authentication.jwks.trustedHosts` | `[]` | extra hosts allowed besides the issuer's |
| `security.authentication.jwks.connectTimeoutMs` | `2000` | 100 to 15000; one connection attempt |
| `security.authentication.jwks.initDeadlineMs` | `20000` | 0 to 300000; the start-up key load with its retries ([authentication](/security/authentication#loading-the-keys-at-start-up)) |
| `security.authentication.jwks.privateHosts` | `[]` | exact `host:port` of a JWKS endpoint on a private network ([authentication](/security/authentication#an-identity-provider-on-a-private-network)) |
| `security.authentication.jwks.caFile` | none | PEM certificate authority for the JWKS endpoint |
| `security.authentication.publicKey.file` | one key source required | PEM public key or X.509 certificate |
| `security.authorization.defaultPolicy` | `authenticated` | applied to routes without their own policy |
| `security.propagation.forward` | `bearer` | `bearer` or `none` for upstream calls |

## Precedence (lowest to highest)

built-in defaults, `pso.config.json`, `pso.config.<environment>.json`, `PSO_CFG_*` variables, `PSO_JWT_*` variables. Values may reference the environment with `${env:NAME}`; other reference kinds are refused for security settings.

| Variable | Overrides |
|---|---|
| `PSO_JWT_ISSUER` | `security.authentication.issuer` |
| `PSO_JWT_AUDIENCE` | `security.authentication.audience` |
| `PSO_JWT_JWKS_URI` | `security.authentication.jwks.uri` |
| `PSO_JWT_PUBLIC_KEY_FILE` | `security.authentication.publicKey.file` |
| `PSO_JWT_ALGORITHMS` | `security.authentication.algorithms` |
| `PSO_JWT_JWKS_PRIVATE_HOSTS` | `security.authentication.jwks.privateHosts` |
| `PSO_JWT_JWKS_CA_FILE` | `security.authentication.jwks.caFile` |
| `PSO_JWT_JWKS_TRUSTED_HOSTS` | `security.authentication.jwks.trustedHosts` |
| `PSO_JWT_JWKS_TIMEOUT_MS`, `PSO_JWT_JWKS_CONNECT_TIMEOUT_MS`, `PSO_JWT_JWKS_INIT_DEADLINE_MS` | `security.authentication.jwks.timeoutMs`, `.connectTimeoutMs`, `.initDeadlineMs` |

The legacy `security.jwt.*` keys are still read and are superseded by `security.authentication.*`.

## Start-up validation

Missing issuer or audience, no key source or two key sources, a symmetric or unknown algorithm, a missing or unreadable PEM file, a private key in the PEM file, an expired certificate, a non-https or blocked JWKS endpoint, an unlisted JWKS host and an unreachable JWKS stop the application before it listens. See [Authentication](/security/authentication).

## Commands

`pso security:check` (static audit) and `pso security:validate` (validates the orchestrator's `security.authentication.*` and every PSO Spring service's `pso.security.*`) are implemented. Dedicated `security:init`, `security:inspect` and `security:doctor` commands are **planned and not implemented yet**; validation also happens at start-up.

## See the effective security settings

```bash
pso security:validate
pso config:show --service gateway
```

`config:show` lists every `security.authentication.*` key with its origin. Verified defaults for a new service: `security.authentication.algorithms ["ES256","RS256"]`, `clockToleranceSeconds 5`, `jwks.cacheTtlSeconds 600`, `jwks.timeoutMs 3000`, `provider "jwt"`, `rolesClaim "roles"`, `security.authorization.defaultPolicy "authenticated"`, `security.propagation.forward "bearer"`. (The value of `maxTokenBytes` prints as `***REDACTED***` because its key contains the word *token*; see [configuration](/concepts/configuration).)

## Common mistakes

- Setting only some of issuer, audience and key source (the application refuses to start).
- Putting a secret literal in `pso.config.json` (`PSO_CONFIG_PLAINTEXT_SECRET`).
- Expecting a security `init` or `doctor` command: they are not implemented.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `PSO_SEC_MISSING: issuer is required` | no `PSO_JWT_ISSUER` | `pso security:validate` | set it |
| `PSO_SEC_MISSING: a key source is required` | neither `PSO_JWT_JWKS_URI` nor `PSO_JWT_PUBLIC_KEY_FILE` | `pso security:validate` | set one. The Spring starter accepts only the JWKS URL |
| validation is `OK` but tokens are rejected at run time | validation is static: an unreachable or wrong JWKS URL is found at start-up | the service's start-up log | fix the URL; check the key id in the token header against `keys/jwks.json` |
| `SEC005` from `security:check` | a guard is used with incomplete settings for production | `pso security:check` | configure `security.authentication.*` |

Captured output for the first, second and fourth rows is in [Validation errors, one by one](/reference/diagnostics-catalog).

## Next steps

- [Authentication](/security/authentication)
- [Production checklist](/security/checklist)
