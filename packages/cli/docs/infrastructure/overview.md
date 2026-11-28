---
title: The infrastructure engine (0.2.0)
description: Why PSO 0.2.0 resolves infrastructure from declarations, what the engine does in each step, and where its responsibilities stop.
order: 1
status: implemented
keywords: [infrastructure, pso.infra.json, .infra, provisioning, reconciliation, environments, tls, secrets, identity provider, nginx, docker]
related: [infrastructure/contract, infrastructure/resource-lifecycle, infrastructure/security-and-certificates, infrastructure/containers, infrastructure/migration]
---
> [!STATUS]
> **Implemented and verified (0.2.0).** Unit and CLI tests with real files, the real Docker Compose parser and the real nginx; a reference workspace (`fixtures/pso-reference`: one orchestrator, two Spring services, two shells, three microfrontends, Keycloak, TLS and mutual TLS) provisioned, started in containers, validated through the edge, used in real Chrome and deployed with an automatic rollback. **Not done:** a deployment to a remote production host (PSO produces a reviewable bundle for it), DNS record creation at a provider.

In 0.1 a developer described the application declaratively (services, routes, contracts, frontends) but still wrote the infrastructure by hand: certificates, the identity provider's clients and redirect URIs, nginx server blocks, compose files, environment variables in each service, and the same host names repeated in all of them. Every new frontend or service meant editing five files consistently. 0.2.0 removes that work: **the developer declares what the application needs, PSO resolves how it is configured and run.**

## What you declare, and what PSO derives

| Source of truth | Declares |
|---|---|
| `pso.workspace.json` | services, ports, roles, dependencies, databases, frontends |
| `ROUTES.pso.ts`, `FEI.pso.ts`, `MEI.pso.ts` | routes, public and protected pages, scopes, microfrontend mounts |
| `pso.infra.json` (new, optional) | environments (local, staging, production), host names, where TLS material and secrets come from, the identity provider, which hops use mutual TLS, container limits |

Nothing in `pso.infra.json` repeats the workspace: it only says what the application code cannot know. Without it, PSO derives a single local development environment. `pso infra:init` writes a starting contract.

From these three sources the engine derives every resource of an environment: a development certificate authority and one certificate per container (with exactly the names its clients verify), the mutual-TLS client identity of the orchestrator, generated development secrets, the Keycloak realm (one OIDC client per shell, its redirect URIs and web origins computed from the hosts), the edge gateway's nginx configuration (one server per host; the edge itself runs the framework's own image, which carries its native error responses and sends no server identification), the static server of each shell, each shell's runtime configuration, the container topology, the proposed hosts entries and the environment of each service when it runs as a local process.

## The pipeline

1. **Discover.** The workspace file, the frontend declarations and the contract are read as data.
2. **Build a dependency graph.** Resources depend on each other (a certificate on its authority, a runtime configuration on its site directory); the graph also gives the container startup order.
3. **Identify missing or invalid resources.** Each resource is inspected against the disk without changing anything: `pso infra:plan`.
4. **Generate what is authorized.** In a development environment PSO generates development material. In staging and production it never generates certificates, keys or secrets: those are supplied by the operator, and PSO only verifies them.
5. **Configure references.** Generated configuration refers to certificates by mount path and to secrets by name (`secret://db-catalog`), never by value.
6. **Validate connectivity and security.** `pso infra:validate --probe` checks the running environment for real, through the edge, with certificate verification.
7. **Reconcile.** When a service, a shell or a microfrontend registration changes, the affected resources are updated automatically (development) or reported (other environments).
8. **Report actionable errors.** Every refusal names the declaration responsible and the command that fixes it.

## Why it is built this way

- **Idempotency is the safety property.** Running `pso infra:apply` twice changes nothing the second time; a valid certificate, key or secret is never regenerated because a command ran again. Regeneration happens only when something is missing, invalid (wrong authority, missing host name, mismatching key, expired) or when you ask for it (`pso infra:rotate`).
- **Ownership is explicit.** A resource is either PSO's (`owner: pso`) or the operator's (`owner: external`). PSO writes only its own resources, and only files whose content it can prove it wrote (their hash is in `.infra/state.json`). A hand edit is *drift*: reported, never overwritten silently.
- **The engine composes existing PSO pieces.** The edge and shell servers use the same nginx renderer as `pso frontend:nginx` and the runtime agent; shells are published with the same release engine as `pso frontend:publish`; containers run on Docker Engine and Compose. PSO owns the topology, the order of operations and the verification, not the container runtime.
- **Production never runs on untrusted material.** A production environment that names the development authority is a contract error, local secret storage is refused outside development, and `dev-token` sign-in is refused in production.

## Where to go next

- [The infrastructure contract and the `.infra` directory](/infrastructure/contract)
- [Resource lifecycle: ownership, drift, repair, recovery](/infrastructure/resource-lifecycle)
- [Security model, certificates and secrets](/infrastructure/security-and-certificates)
- [Hosts and environments](/infrastructure/hosts-and-environments)
- [The container engine](/infrastructure/containers)
- [Local development](/infrastructure/local-development)
- [Deployment](/infrastructure/deployment)
- [Studio infrastructure console and API Client](/infrastructure/studio-api-client)
- [Migrating a 0.1 workspace](/infrastructure/migration)
- [Troubleshooting](/infrastructure/troubleshooting)

## Limits of 0.2.0
- Remote deployment is a reviewable bundle (or the 0.1 cloud engine); `pso deploy --env` starts containers only on a Docker Engine this machine reaches.
- DNS records are never created; certificates for staging and production are never generated; system trust stores are never changed.
- Keycloak changes after the first import of a staging or production realm are applied through its administration API, not by PSO.
- The engine reads FEIs statically: a FEI declaration with errors is skipped until `pso frontend:validate` passes.
