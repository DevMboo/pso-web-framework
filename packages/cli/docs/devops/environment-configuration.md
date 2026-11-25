---
title: Environment configuration
description: Separating development, test, staging and production - the files, the selector, a worked example with the values that really differ, and the commands that prove what each environment will use.
order: 4
keywords: [environments, PSO_ENV, env file, production, config:show, config:validate]
related: [concepts/configuration, reference/config, reference/environment-variables, decisions/dev-or-production-config]
---
Environments are `development`, `test`, `staging` and `production`. Select one with `--env` or `PSO_ENV` (default `development`).

```tree title="Configuration files by layer"
my-platform/
  pso.workspace.json  # generated: layer 2, workspace-wide "config"
  pso.config.production.json  # optional: layer 4, workspace-wide production overrides
  orchestrators/gateway/
    pso.config.json  # optional: layer 3, service settings
    pso.config.production.json  # optional: layer 4, service production overrides
```

Runtime variables (`PSO_CFG_server__port=9000`) and `--set` override files. Secrets are always references (`${env:NAME}`), supplied by the environment: `gateway/.env` locally, your secret manager in production.

## A worked example

Common settings in the service file; only what differs in the production file:

```json title="orchestrators/gateway/pso.config.json" evidence="illustrative"
{ "http": { "limits": { "maxBodyBytes": 1048576 } }, "security": { "authentication": { "algorithms": ["ES256"] } } }
```

```json title="orchestrators/gateway/pso.config.production.json" evidence="illustrative"
{ "logging": { "level": "info" }, "http": { "rateLimit": { "perMinute": 300, "provider": "redis", "redisUrl": "${env:RATE_LIMIT_REDIS_URL}" } } }
```

Now see what each environment will use, and where every value comes from:

```bash
pso config:show --service gateway --env production
pso config:validate --env production
```

Expected output of the first command for one value (from a real run, with `--set logging.level=debug`): `logging.level "debug" <- cli`, and `server.port 8081 <- workspace`; the last column names the layer that won ([Configuration resolution](/concepts/configuration)). A literal secret in a file is an error you will see in `config:validate`:

```text evidence="expected"
ERROR   PSO_CONFIG_PLAINTEXT_SECRET gateway/pso.config.json: "database.password" looks like a secret stored as plain text
        hint: Reference it instead: "${env:NAME}" or "${secret:NAME}"
FAILED
```
*(expected output)*

## What differs between environments (typical)

| Setting | Development | Production |
|---|---|---|
| log format and level | pretty, `info` or `debug` | JSON, `info` |
| JWT key source | local PEM | JWKS over https from your identity provider |
| rate limit | high | sized for traffic; shared through Redis with several instances |
| upstream transport | plaintext to loopback | TLS (required for non-loopback hosts) |
| ports and addresses | fixed local ports | `PSO_UPSTREAM_<NAME>` from the platform |

## Variations

| You want | Do |
|---|---|
| a value for every environment | `pso.config.json` |
| a production-only value | `pso.config.production.json` or an environment variable |
| a secret | an environment variable referenced as `${env:NAME}` |
| to try a value once | `--set key=value` on the command |
| the Spring equivalent | profiles (`application-prod.yml`) and environment variables ([Spring configuration](/spring/configuration)) |

## Good practice

Keep production values out of development files, run `pso config:validate --env production` and `pso security:check` in CI, and never commit `.env`. Review `pso config:show --env production` in a pull request that changes configuration, so you review the *effect*, not just the diff.

## One environment per service in development

`pso dev` starts every project of the workspace with its own environment. Lowest to highest priority:

| # | Source | Reaches |
|---|---|---|
| 1 | `<workspace>/.env.<environment>` (for example `.env.development`) | every project |
| 2 | `<project>/.env` | that project only |
| 3 | `<project>/.env.<environment>` | that project, that environment |
| 4 | the environment `pso dev` runs in | every project; explicit, so it wins over files |
| 5 | `PORT`, `HOST`, `PSO_WORKSPACE`, `PSO_SERVICE` | set from `pso.workspace.json`; a file cannot change them |

`<environment>` is `PSO_ENV`, `development` when it is not set.

```ini title="customers/.env"
DB_URL=jdbc:postgresql://localhost:5432/customers
DB_USER=customers_app
DB_PASSWORD=customers-dev
PSO_LOG_LEVEL=debug
```

```ini title="services/orders/.env"
DB_URL=jdbc:postgresql://localhost:5432/orders
DB_USER=orders_app
DB_PASSWORD=orders-dev
REDIS_URL=redis://127.0.0.1:6379
```

```ini title=".env.development (shared by every project)"
PSO_JWT_ISSUER=http://localhost:9443
PSO_JWT_AUDIENCE=pso-api
PSO_JWT_JWKS_URI=http://127.0.0.1:9443/.well-known/jwks.json
```

- A project's files reach that project only: `orders` never sees the database password of `customers`.
- `<workspace>/.env` is **not** read by `pso dev`: that name belongs to Docker Compose (the variables of the containers of the generated deployment).
- When a variable is both in a file and in the shell, the shell wins and `pso dev` says so (`DB_URL comes from the environment of pso dev`). Only names are printed, never values.
- The files are a development mechanism. Never commit them (`.env` and `.env.*` are in the generated `.dockerignore`; add them to `.gitignore`).
- Running the orchestrator alone with `npm run dev` reads `<orchestrator>/.env` only.

Verify: `pso dev` prints one line per service such as `[pso] orders: environment: the process environment, .env.development (3 variables), orders/.env (4 variables)`.

## Static checks read what the application reads

`pso security:check`, `pso security:validate` and `pso lint` evaluate **one environment** (`--env`, else `PSO_ENV`, else `development`) with the sources above, and print which they used:

```text evidence="expected"
$ pso security:check
environment: development (default; choose another with --env or PSO_ENV)
  gateway: configuration from the process environment, gateway/.env (3 variables)
  catalog: configuration from the process environment
OK
This result is about "development". It says nothing about production: run `pso security:check --env production` where the production variables are set (a pipeline, the platform).
```

For `production` no environment file is read, so a developer's `.env` can never make a production check pass. Checks that read files (keys, hard-coded secrets, route policies, Spring configuration, every `pso.config.<environment>.json` that exists) run whatever environment was chosen: a mistake in `pso.config.production.json` is a finding of a development check too. Earlier versions of `pso security:check` evaluated `production` by default and did not read the gateway's `.env`, so a project set up as documented was reported as not configured; a pipeline that relied on that default now passes `--env production` (or sets `PSO_ENV=production`).

## Common mistakes

- Putting a production URL in the base file "for now".
- Forgetting that an environment variable beats the file, and wondering why the file edit has no effect (`config:show` shows the origin).
- Misspelling a key: the warning `Unknown configuration key` lists the valid keys.

## Next steps

- [Configuration resolution](/concepts/configuration)
- [Development or production configuration?](/decisions/dev-or-production-config)
