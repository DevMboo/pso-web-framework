---
title: Identity provider reconciliation (Keycloak)
description: How PSO keeps an already running Keycloak realm in line with the declarations through its administration API, what it owns, what it never touches, and which changes need authorization.
order: 5
status: implemented
keywords: [keycloak, oidc, realm, clients, redirect uris, web origins, reconciliation, drift, administration api]
related: [infrastructure/security-and-certificates, infrastructure/hosts-and-environments, frontend/multiple-feis]
---
> [!STATUS]
> **Implemented and verified** against the running Keycloak of the reference workspace: drift created through the real administration API was detected, refused without authorization, corrected with it; an unmanaged client was left alone; users, credentials and the confidential client's secret survived; Keycloak was not restarted. A third FEI added after startup got its OIDC client live and a real browser signed in to it.

The generated realm file is imported only when a realm does not exist yet. After that, the realm lives in Keycloak, and PSO reconciles it through the **administration API**:

```bash
pso infra:identity                     # drift report, changes nothing
pso infra:identity --apply             # routine changes (create what is missing)
pso infra:identity --apply --yes       # also sensitive changes (change existing managed clients)
pso infra:identity --apply --prune --yes   # also remove managed clients whose frontend was removed
```

## What PSO owns

Every client and role PSO creates carries the attribute `pso.managed=true`. Only those are compared and changed:

| Resource | Desired state from |
|---|---|
| one public OIDC client per FEI | its host, base path and development server: redirect URIs, web origins, post-logout URIs, PKCE S256, audience and scope mappers |
| the development API client | development environments only (Studio API Client) |
| one realm role per scope | the scopes used by the FEI, MEI and route declarations and by development users |
| development users | `identity.users` (development only): missing users are created with the password from their secret; missing roles are added |

A client with the same clientId **without** the marker belongs to someone else: it is reported and never modified.

## Change classes

| Change | Class |
|---|---|
| create a missing client, role, protocol mapper, development user; add a missing role to a development user | routine: `--apply` |
| change redirect URIs, web origins, flows or mappers of an existing managed client | **sensitive**: `--apply --yes` (exit 3 without it) |
| remove a managed client that no declaration needs anymore | **sensitive**: `--apply --prune --yes` |

Never changed: users and their credentials, sessions, client secrets (they are never sent, so never reset), realm settings outside the managed objects, objects without the marker. The realm is never recreated.

## Automatic reconciliation in development

When `pso create fei`, `pso fei:register` or any change regenerates the realm in a development environment, PSO applies the routine changes to the **running** Keycloak at once, so a new shell can sign in without restarting Keycloak or opening its console:

```text evidence="illustrative"
reconciled "local" after creating FEI "fei-partners": cert:edge, identity:realm, nginx:edge, ...
  identity provider updated live: create-client fei-partners
```

Sensitive changes are never applied automatically; the command names the one to run.

## What goes wrong

- `the identity provider refused the administrator sign-in`: the `idp-admin` secret is not the one Keycloak was started with.
- `not reachable`: the stack is not running; the next start imports the realm file if the realm does not exist, otherwise run `pso infra:identity --apply` once it runs.
- A client owned by someone else with the FEI's clientId: rename the FEI's `clientId` in `pso.infra.json`, or add the marker in Keycloak to hand it over deliberately.
