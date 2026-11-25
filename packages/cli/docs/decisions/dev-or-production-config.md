---
title: Development or production configuration?
description: What changes between a developer's machine and production in PSO - profiles, layers, secrets, security requirements, logging and limits - and how to make the difference explicit instead of accidental.
order: 39
keywords: [decision, configuration, profiles, production, development, secrets, environment, PSO_ENV]
related: [concepts/configuration, spring/configuration, devops/environment-configuration, security/security-configuration, decisions/pretty-or-json-logs]
---
## The question

Which settings should differ between development and production, and how do you keep them from leaking into each other?

## What differs by design

| Concern | Development | Production |
|---|---|---|
| Spring profile | `local` (`pso dev` activates it); there is **no implicit default profile** | `prod` (Docker images set `SPRING_PROFILES_ACTIVE=prod`) |
| JWT settings | convenient local key (`PSO_JWT_PUBLIC_KEY_FILE`) | required: issuer, audience and a JWKS from your identity provider; Spring `staging`/`prod` refuse to start without them |
| Database | H2 allowed only in the local profile; or a local container | PostgreSQL; **H2 is refused** in base, staging and prod |
| CORS | enabled for `localhost:3000` | off unless you list explicit origins (never `*`) |
| Rate limit | high (6000/min local) | sensible (300/min by default in prod), distributed if several instances |
| Logging | pretty / console pattern, `com.pso` at DEBUG | JSON, INFO, secrets removed |
| Upstream TLS | plaintext to loopback is fine | a remote upstream must use TLS (orchestrator, `PSO_ENV=production`) unless explicitly marked `allowPlaintext` |
| Secrets | `.env` that is git-ignored | environment or a secret manager; never in files |

## The layers (orchestrator)

From lowest to highest: framework defaults, workspace, service `pso.config.json`, the environment file `pso.config.<env>.json`, `PSO_CFG_*` environment variables, `--set`. Put what is the same everywhere in `pso.config.json`; put what differs in the environment file or the environment. See [configuration](/concepts/configuration) and the [variables reference](/reference/environment-variables).

## Decision flow

1. **Does the value differ per environment?** Environment file or variable. **Is it a secret?** Variable or secret manager, referenced as `${env:NAME}`.
2. **Is it a safety setting** (authentication, TLS, limits)? Make production the *strict* case and development the explicit relaxation, never the reverse.
3. **Will a wrong value cause damage** (a database URL, a broker URL)? Do not give it a default that points anywhere real; fail at start-up when missing.

## Making it explicit

- Choose the profile every time. A missing profile is not "development".
- Run `pso config:validate` and `pso security:check` in CI for the production configuration; `security:check` reports literal secrets and a missing authentication configuration before anything starts.
- Keep a documented list of the variables production needs (the `.env.example` that `pso docker:init` writes is the template).

## Consequences

- A setting that only exists in `local` cannot protect production, so keep security defaults in the base configuration.
- Strictness has a price: a missing production variable stops the service at start-up. That is the intended failure: a loud stop before traffic, not a quiet misconfiguration after.

## Anti-patterns

- Copying `application-local.yml` values into production "to make it start".
- Real credentials in `.env.example` or in a committed file.
- Different code paths per environment. Differences should be configuration only.
- Disabling authentication in a shared development environment: it becomes the production behavior eventually.

## Related

[Configuration](/concepts/configuration) · [Spring configuration](/spring/configuration) · [Security configuration](/security/security-configuration) · [Pretty or JSON logs](/decisions/pretty-or-json-logs)
