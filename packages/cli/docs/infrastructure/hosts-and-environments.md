---
title: Hosts and environments
description: How PSO resolves host names, origins, OIDC redirect URIs, web origins and the addresses each component uses, in development, staging and production, and what it never does with DNS.
order: 5
status: implemented
keywords: [hosts, environments, dns, redirect uri, cors, web origins, localhost, staging, production, addresses]
related: [infrastructure/contract, infrastructure/containers, infrastructure/deployment, frontend/multiple-feis]
---
## Host names

Each environment has a `domain`. A shell `fei-shop` is served on `shop.<domain>` (its host label is the name without `fei-`, overridable with `frontends.<fei>.host`), the API on `api.<domain>`, the identity provider on `auth.<domain>`. `environments.<env>.hosts` can name any of them explicitly. Every name derived here is used consistently in the edge configuration, the edge certificate, the realm's redirect URIs and web origins, each shell's runtime configuration and the hosts entries; there is no second place to edit.

The development default domain is `pso.localhost`: Chrome, Edge and Firefox resolve every `*.localhost` name to this machine, so no hosts file is needed for a browser. Other clients (curl, Node) need either the hosts block (`pso infra:hosts --apply --yes`, which needs administrator rights for the system file and only changes PSO's marked block) or an explicit mapping; PSO's own probes and the Studio API Client map the environment's hosts to loopback themselves.

## Origins and OIDC addresses

For a shell at `https://shop.pso.localhost:8443/` PSO derives:

| Value | Example | Used by |
|---|---|---|
| origin | `https://shop.pso.localhost:8443` | edge server, realm web origins (CORS of the token endpoint) |
| redirect URIs | `https://shop.pso.localhost:8443/auth/callback`, plus `http://localhost:4200/auth/callback` in development | realm client |
| post-logout URIs | `https://shop.pso.localhost:8443/`, plus the development server | realm client |
| runtime configuration | issuer, endpoints, client id `fei-shop` | `/pso-runtime-config.json` of that shell |

The API is same-origin for every shell (`/api` on the shell's host goes to the orchestrator), so no CORS is needed between a shell and the API.

## Addresses: host versus container

A container never reaches another one through `localhost`: inside a container, `localhost` is the container itself. PSO resolves every address for the place it is used from:

| Caller | Reaches `catalog` at | Reaches the identity provider's keys at |
|---|---|---|
| a container | `https://catalog:8081` | `https://idp:8443/...` |
| a local process (`pso dev`) | `http://127.0.0.1:8081` | `https://127.0.0.1:8443/...` |
| a browser | through the edge only | through `https://auth.<domain>:<port>` |

`pso infra:inspect` prints both columns; Studio's Hosts page shows them.

## Development, staging and production

| | development | staging | production |
|---|---|---|---|
| TLS | PSO development authority | operator's (development authority allowed with a warning) | operator's only |
| secrets | `local` (generated) | `env` or `file` | `env` or `file` |
| edge port | loopback only | all interfaces | all interfaces |
| internal network | reachable for debugging | isolated from the host | isolated from the host |
| sign-in | OIDC, dev-token allowed | OIDC | OIDC only |
| Keycloak (when used) | `start-dev`, realm re-imported on each start | `start`; production database is a prerequisite | `start`; production database is a prerequisite |
| deployment target | `docker` (this machine) | `bundle` | `bundle` |

## DNS

PSO never pretends to have created a record. `dns.provider: "external"` means the records are yours to create; `pso deploy --env <name> --dry-run` lists every host that must resolve to the deployment host as a prerequisite. `hosts-file` is a development tool and is refused for staging and production.

## What goes wrong
- A non-browser client cannot resolve `*.pso.localhost`: add the hosts block (`pso infra:hosts --apply --yes`) or map the names yourself.
- Two shells on one host with base paths `/` and `/admin/`: refused, the shell at `/` would receive every request. Use two hosts or two distinct base paths.
- Calling another container through `localhost` in hand-written configuration: it reaches the caller itself. Use the service name.
