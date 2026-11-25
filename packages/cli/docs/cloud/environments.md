---
title: Environments
description: How local, development, testing, staging, production and custom environments stay isolated from each other, and how one project deploys to several of them without copying its source.
order: 4
status: implemented
keywords: [environment, production, staging, isolation, connection, declaration, multi-environment]
related: [cloud/deployment-declarations, cloud/credentials-and-security, cloud/deploy-a-release, devops/environment-configuration]
---
An *environment* is one server (or one named slot on it) plus everything decided about it: its identity, connection, deployment policy, runtime requirements, proxy configuration, secrets, history, access and pipeline. PSO treats environments as first-class so that **production never inherits development's credentials, debug settings or insecure defaults**.

```bash
pso environment:add production --connection prod --repo https://git.example.com/shop.git --domain shop.example.com
pso environment:add staging --connection stg --repo https://git.example.com/shop.git --branch develop
pso environment:list
```

This writes `deploy/production.deployment.pso.ts` and `deploy/production.pipeline.pso.ts` (and the staging pair). The same repository is deployed to both: the **source is referenced, not copied**. Each file declares its own `environment`, `connection`, strategy and pipeline.

## What keeps them apart

| Concern | Isolation |
|---|---|
| Identity | each server's agent has its own environment id and a label chosen at install (`--environment production`) |
| Credentials | a connection holds its own SSH secrets and its own client key; nothing is shared between connections |
| Declarations | a declaration for `staging` is **refused** by the production server: the plan reports *"this server is the production environment but the declaration targets staging"* |
| Secrets | named secrets live on the server that uses them (`pso environment:secret`) and are injected only into that server's services |
| Policy | approvals, strategies and retention are set per server and override the project's wishes |
| History and audit | stored on each server, correlated by environment, deployment and release ids |
| Access | enrolled clients and their roles are per environment |

## Reading an environment

```bash
pso environment:inspect production
pso environment:plan production
```

`inspect` is read-only: operating system and architecture, CPU, memory and disk, listening ports, Java, Node.js, git, nginx and Docker availability, existing virtual hosts and PSO applications. `plan` lists what provisioning would do and who must do it (see [nginx and existing infrastructure](/cloud/nginx-and-existing-infrastructure)).

```text evidence="expected"
Alpine Linux v3.24 x64, 8 CPU, 3010/3920 MB memory free, 18000 MB disk free; agent runs as pso
tools: node 24.18.0, java 21.0.1, git 2.49, nginx 1.30, docker no, systemd no
nginx vhosts: [external] /etc/nginx/http.d/unrelated.conf; [PSO] /etc/nginx/pso.d/pso-shop.conf
no blockers
```

## Several services and repositories

A deployment declares one service (`service`) or several (`services`) and each has its own build, start command, health policy and shutdown grace. Teams that keep one repository per service create one declaration per service (an *application* each) on the same server: they deploy, roll back and restart independently, and find each other through a stable loopback address (`internalPort`), described in [Deploy a release](/cloud/deploy-a-release).

## What can go wrong

- Two declarations targeting the same environment and name are *ambiguous*: `release:plan` lists the files.
- A **custom** environment name gets no built-in policy defaults; the validator warns.
- The environment label is set once, at `agent:install`. Reinstalling with another label on a provisioned server is refused; remove and reinstall deliberately.
- `local` is a label like the others: it does not turn on a local execution mode. For local development keep using `pso dev`.
