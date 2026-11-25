---
title: The container engine
description: The container topology PSO generates (edge, shells, orchestrator, services, databases, identity provider), dependency order, health checks, networks, volumes, secrets, limits, selective operations and safe cleanup.
order: 6
status: implemented
keywords: [docker, compose, containers, edge, nginx, keycloak, postgres, health checks, dependency order, volumes, secrets, resource limits, logs]
related: [infrastructure/overview, infrastructure/local-development, infrastructure/deployment, devops/docker]
---
PSO runs containers with **Docker Engine and Compose v2**; it does not reimplement a runtime. What PSO owns is the topology (generated from the declarations into `.infra/docker/<env>/compose.yml`), dependency resolution, the order of operations, health verification and safe defaults.

## The generated topology

| Container | Image | Role |
|---|---|---|
| `edge` | `nginx:1.27-alpine`, user 101, read-only | TLS termination, one server per public host, `/api` and `/channels` to the orchestrator, `/` to the shell, identity host to Keycloak; the only published port |
| `fei-<name>` | `nginx:1.27-alpine`, user 101, read-only | one static server per shell; its site root (`.infra/sites/<env>/<fei>`) is mounted read-only and the active release follows `fei/current.json` |
| orchestrator | built from `./<path>` | inbound TLS, upstream TLS (and mutual TLS), JWT configuration |
| each service | built from `./<path>` | TLS with its own certificate; mutual TLS when declared |
| `<service>-db` | `postgres:17-alpine` | one database per service that owns one; data in the named volume `<service>-db-data` |
| `idp` | `quay.io/keycloak/keycloak:26.0` | the realm generated from the declarations |

Every container gets a health check, `restart: unless-stopped`, `no-new-privileges`, all capabilities dropped (except where an image needs its own user switch), log rotation (`json-file`, `max-size`/`max-file` from the contract) and resource limits (defaults per kind, overridable per service). Two networks: `edge` (gateway, shells, orchestrator, identity provider) and `internal` (orchestrator, services, databases, identity provider; isolated from the host outside development).

Publishing a new shell or microfrontend release (`pso frontend:publish <project> --env <env>`) changes what is served without restarting any container: the release engine writes immutable versions and one pointer, and the shell container follows the pointer. On Windows hosts, where the release engine cannot create its POSIX `fei/current` symlink, the container maintains that view itself, so behaviour is identical on every host.

## Commands

| Command | What it does |
|---|---|
| `pso docker:plan --env <env>` | startup order, images (built or pulled), published ports, networks, volumes, secrets (names), limits; pending infrastructure changes. Needs no Docker |
| `pso docker:build --env <env> [--service <name>] [--vendor]` | creates missing Dockerfiles (never overwrites one), vendors the framework packages with `--vendor`, builds the service images |
| `pso docker:up --env <env> [--service a,b] [--no-deps] [--build]` | development: provisions missing infrastructure and builds missing images first; checks every published host port; starts in dependency order and waits until every container is healthy |
| `pso docker:restart <name...> --env <env> [--recreate]` | restarts only those containers; `--recreate` picks up changed environment, mounts or images |
| `pso docker:ps`, `docker:logs <name>`, `docker:inspect [<name>]` | state and health, redacted logs, the effective definition as Compose resolves it |
| `pso docker:down --env <env>` | stops and removes containers and networks; **keeps volumes**. `--volumes` deletes the data too and needs `--yes` |

`--service catalog` starts `catalog` and everything it depends on (its database, the identity provider, the services it depends on); `--no-deps` starts only that container. In the reference workspace a rebuild of one service is `pso docker:up --service catalog --no-deps --build`: one image is rebuilt, one container recreated, the rest keeps running.

A running container whose mounted generated configuration changed after it started (for example the edge's nginx configuration and certificate after `pso create fei` added a host) is re-created by the next `pso docker:up`, which names it and the changed files. The identity provider is not re-created for a changed realm file: the running realm is updated through its administration API (see [identity reconciliation](/infrastructure/identity-reconciliation)).

## Ports

In Docker mode only the edge is published (`127.0.0.1:8443` in development). Service containers are not published unless `publishServices: true`, so a container stack and local `pso dev` processes (or other applications) do not fight over ports. Before anything starts, `pso docker:up` checks that every port it will publish is free and names the container and the declaration to change; it does not discover the conflict halfway through.

## Dockerfiles and portability

Service images are built from each service's directory. A missing `Dockerfile` is generated once (marked as generated) and is yours afterwards. Framework packages that resolve to a path on this machine cannot be installed inside an image build: `pso docker:build --vendor` copies the `@pso/*` tarballs (Node) and the `com.pso` artifacts (Maven) into the service, as `pso docker:init --vendor` did in 0.1.

## Limits and what goes wrong
- A port held by another process is reported before anything starts; PSO never stops a process it did not start.
- `pso docker:down --volumes` deletes database data and needs `--yes`; Studio does not offer it.
- Images are built on this machine; a registry for remote hosts is a production prerequisite.
- Keycloak in development is re-imported on every start (realm changes apply after `pso docker:restart idp`); its users and sessions do not survive a restart.
