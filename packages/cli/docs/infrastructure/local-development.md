---
title: Local development
description: The ways to run a workspace locally in 0.2.0, local processes with or without containerized dependencies, the full container stack, one service or one shell, and how secrets reach local processes.
order: 7
status: implemented
keywords: [pso dev, local development, with-dependencies, docker, process, frontend dev, secrets]
related: [infrastructure/containers, infrastructure/hosts-and-environments, devops/development-environment]
---
| You want | Command |
|---|---|
| every service as a local process (0.1 behaviour) | `pso dev` |
| one service and what it depends on, with its database and the identity provider in containers | `pso dev --service catalog --with-dependencies` |
| the same plus the development servers of one shell | `pso dev --service gateway --with-dependencies --fei shop` |
| the whole environment in containers, followed until Ctrl+C | `pso dev --docker` |
| one environment other than the default | `pso dev --env <name> ...` |

`--with-dependencies` uses `.infra/docker/<env>/compose.deps.yml`: databases published on `127.0.0.1:5432`, `5433`, ... and Keycloak on the environment's HTTPS port, so the issuer is identical to the one the container stack uses. The services start as processes with their usual environment plus what the engine prepared in `.infra/env/<env>/<service>.env` (identity provider, database address); `secret://` references are resolved into the child process only. Verified in the reference workspace:

```text evidence="verified"
starting infrastructure dependencies: catalog-db, idp ...
[pso] catalog: infrastructure environment "local" (.infra/env/local/catalog.env): 12 variable(s), secrets resolved for DB_PASSWORD (values not shown)
Ready:
  catalog            http://127.0.0.1:8091      READY/UP
```

`pso dev --docker` is `pso docker:up` followed by waiting for Ctrl+C, which stops the containers and keeps the data volumes. `--service` and `--with-dependencies` without a contract are refused with the hint to run `pso infra:init`: a 0.1 workspace keeps behaving as before.

The development servers of shells (`pso frontend:dev`, or `--fei` above) use `dev-token` sign-in by default; the container stack uses real OpenID Connect through the environment's identity provider. `pso frontend:dev --fei <name>` starts one shell and the microfrontends it mounts.

## What goes wrong
- `--with-dependencies` publishes the identity provider on the environment's HTTPS port: a running container stack holds the same port. Stop it first (`pso docker:down`); the conflict is reported before anything starts.
- A service port held by another program: `pso dev` refuses to start that service and names the port.
- A secret that was never provisioned: the service is not started and the message names it (`pso infra:apply`).
