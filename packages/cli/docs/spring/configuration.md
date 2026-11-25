---
title: Spring configuration reference
description: Every pso.* key with defaults and environment overrides, the profiles and how misspelled keys are handled.
order: 3
status: partial
keywords: [application.yml, pso.service, pso.security, pso.limits, pso.http, pso.database, pso.dispatch, profiles, configuration properties]
related: [spring/service-prefix, spring/security-and-cors, spring/limits, spring/http-client, spring/database-and-h2, spring/dispatch]
---
Every generated service has a complete `application.yml`. The values below are the defaults; `${VAR:default}` shows which environment variable overrides them. Binding uses `@ConfigurationProperties` with Jakarta Bean Validation, and **unknown `pso.*` keys stop start-up**. Environment variables are free-form, so `PSO_JWT_ISSUER` works without being a property.

```bash
pso validate               # includes the typed pso.* checks as PSO_SPRING_SPR* errors
pso security:validate      # focuses on JWT, CORS, rules, prefix, database and dispatch
```

## Groups

| Key | Default | Notes |
|---|---|---|
| `pso.service.name` | service name | kebab-case |
| `pso.service.prefix` | `${PSO_SERVICE_PREFIX:/<name>}` | [authoritative prefix](/spring/service-prefix); `/` disables it |
| `pso.security.enabled` | `true` | `false` removes the starter's chain (you must provide your own) |
| `pso.security.jwt.jwks-uri` / `issuer` / `audience` | `${PSO_JWT_*}` | all three or none |
| `pso.security.jwt.algorithms` | `ES256,RS256` | asymmetric only |
| `pso.security.jwt.clock-skew` | `30s` | 0 to 5 minutes |
| `pso.security.jwt.roles-claim` | `roles` | dotted path allowed |
| `pso.security.cors.*` | disabled | [CORS](/spring/security-and-cors) |
| `pso.security.rules[]` | empty | explicit authorization rules |
| `pso.security.headers.*`, `pso.security.actuator.health-public` | on, `true` | |
| `pso.http.client.services.<name>.*` | none | [HTTP client](/spring/http-client) |
| `pso.limits.requests.enabled` / `per-minute` | `true` / `${PSO_RATE_LIMIT_PER_MINUTE:600}` | [limits](/spring/limits) |
| `pso.limits.body.max-size` | `2MB` | |
| `pso.limits.multipart.enabled` / `max-file-size` / `max-request-size` | `false` / `5MB` / `10MB` | |
| `pso.limits.header.max-size` | `16KB` | |
| `pso.limits.timeouts.connection` / `async-request` | `10s` / `30s` | |
| `pso.limits.concurrency.max-requests` | `0` (unlimited) | |
| `pso.dispatch.enabled` / `provider` | `false` / `none` | [dispatch](/spring/dispatch) |
| `pso.database.provider` | `none` | `none`, `h2`, `postgresql` ([database](/spring/database-and-h2)) |
| `pso.channels.enabled` / `dispatch-event` / `max-payload` | `false` / `channels.publish` / `32KB` | publishing to [Channels](/orchestrator/channels) over Dispatch |
| `pso.storage.provider` | unset (storage off) | `local`, `s3`, `azure`; the whole `pso.storage.*` group is on [Storage](/spring/storage) |
| `pso.observability.correlation.enabled` / `header` | `true` / `X-Correlation-ID` | |

## Profiles

`local`, `dev`, `test`, `staging`, `prod` and `h2`. **There is no default profile**: the `local` profile is never an implicit fallback. `pso dev` activates `local` for the services it starts; Docker images set `SPRING_PROFILES_ACTIVE=prod`.

| Profile | What it changes |
|---|---|
| `local` | debug logging, CORS for `http://localhost:3000` and `http://127.0.0.1:3000`, a high rate limit |
| `dev` | shared development environment; values come from the environment |
| `test` | no rate limiting, quiet logs (generated tests use it) |
| `staging`, `prod` | JWT settings are **required** (start-up fails without them) and H2 is refused |
| `h2` | `pso.database.provider: h2` |

Credentials never belong in YAML: use environment variables (`DB_URL`, `DB_USER`, `DB_PASSWORD`, `PSO_JWT_*`). `pso security:check` reports literal secrets (`SEC010`, `SPR011`).

## IDE metadata

The autoconfigure artifact runs Spring Boot's configuration processor, so IDEs offer completion and documentation for every `pso.*` key.

## Validation codes

| Code | Meaning |
|---|---|
| SPR001 | a YAML file cannot be read |
| SPR002 | unknown `pso.*` key |
| SPR003 | non-asymmetric JWT algorithm |
| SPR004 | JWKS over plain http for a non-loopback host |
| SPR005 | CORS: missing, wildcard or malformed origins, credentials with patterns |
| SPR006 | a `PUBLIC` rule (medium: confirm it is intended) |
| SPR007 | dispatch enabled without a provider |
| SPR008 | unknown database provider |
| SPR009 | H2 in the base, staging or prod configuration |
| SPR010 / SPR011 | HTTP client: plain http, literal TLS password |
| SPR013 | `pso.service.prefix` differs from `pso.workspace.json` |

## What a misspelled key looks like (expected)

Starting a generated service with `--pso.securty.enabled=true` (a typo for `security`) refuses to start:

```text evidence="expected"
APPLICATION FAILED TO START
Description:
Binding to target [... PsoProperties ...] failed:
    Property: pso.securty.enabled
    Origin: "pso.securty.enabled" from property source "commandLineArgs"
    Reason: The elements [pso.securty.enabled] were left unbound.
```

An unknown `pso.*` key is a start-up error, so a security setting cannot be silently ignored. The same goes for a few combinations that are checked at start-up: for instance a `server.servlet.context-path` together with a service prefix stops the service (the prefix would be applied twice).

## Variations

| You want | Do |
|---|---|
| a value for one environment | `application-<profile>.yml` and activate the profile explicitly |
| an override from the platform | the documented `PSO_*` placeholder in `application.yml` (for example `PSO_RATE_LIMIT_PER_MINUTE`), or Spring's relaxed binding of the property name (dots become underscores, dashes are removed: `pso.limits.requests.per-minute` is `PSO_LIMITS_REQUESTS_PERMINUTE`) |
| to see what is configured | your IDE's completion (configuration metadata ships with the starter) and `pso config:show --service <name>` for the PSO-level view |
| to run with a profile | `./mvnw spring-boot:run -Dspring-boot.run.profiles=local` |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `APPLICATION FAILED TO START ... left unbound` | a misspelled `pso.*` key: fix the spelling (the Property line names it) |
| staging/prod refuses to start | required `PSO_JWT_*` settings are missing |
| H2 refused | H2 is allowed in the `local` and `h2` profiles only (`SPR009` in `pso security:check`) |
| the service uses defaults you did not expect | no profile is active (there is no default profile): choose one |

## Common mistakes

- Relying on an implicit profile.
- Copying `application-local.yml` values into `prod`.
- Writing credentials in YAML (`SEC010`, `SPR011`).

## Next steps

- [Development or production configuration?](/decisions/dev-or-production-config)
- [Environment variables](/reference/environment-variables)
