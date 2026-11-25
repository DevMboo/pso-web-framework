---
title: Task: configure Docker
description: Generate and validate the declared 0.2 container environment, preserving 0.1 compatibility.
order: 28
scope: configure-docker
base: false
requires: [devops]
keywords: [ai, task, docker, compose, infrastructure]
---

1. Identify the workspace structure. For a 0.2 infrastructure workspace, update the declarations in `pso.workspace.json` and `pso.infra.json`; never hand-edit generated `.infra/` files. For a 0.1 workspace, keep its existing `pso docker:init` workflow unless the owner asks to adopt the engine (`pso workspace:migrate` previews first).
2. Run `pso infra:plan`, review the proposed hosts, certificates, identity clients, databases and service connections, then `pso infra:apply` for the authorized development environment. Production changes require the appropriate environment and explicit authorization.
3. Use `pso docker:plan --env <env>` to inspect the generated topology without starting Docker. `pso docker:build --env <env> --vendor` builds images with matching local Node and Java artifacts; `pso docker:up --env <env>` provisions missing development infrastructure, starts containers and waits for health. Do not claim a run succeeded without checking its output.
4. Preserve the generated hardening: only the HTTPS edge is published by default, private services remain on internal networks, secrets stay outside images and source control, and containers use the declared users, read-only mounts and capability limits.
5. For a single service use `pso docker:up --service <name> --env <env>`; `pso docker:ps` and `docker:logs <name>` report health and redacted logs. `pso docker:down` keeps data volumes; deleting volumes is a separate, explicit operation.
6. In a 0.1 workspace, `pso docker:init --dry-run` previews its root Compose and Dockerfiles. Generate with `pso docker:init --vendor` when unpublished `@pso/*` and `com.pso` dependencies must be available inside image builds. Do not overwrite a developer's edited Dockerfile.
