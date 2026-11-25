---
title: Task: create an orchestrator
description: Exact steps to add the Node.js orchestrator to a workspace.
order: 20
scope: create-orchestrator
base: false
requires: [orchestrator]
keywords: [ai, task, orchestrator]
---
1. Work in the workspace root (the folder with `pso.workspace.json`). If there is none: `pso create workspace <name>` then `cd <name>`.
2. `pso create orchestrator <name>` (kebab-case). A workspace has exactly one orchestrator; if one exists, stop and tell the user. It creates the official modular structure with the reference `products` module, bound to the service that serves `/products` (`--crud-service <svc>` when several do; `--template empty` for no example; `--structure legacy` only if the user asks for the 0.1 layout).
3. In the new folder: `npm install`.
4. `pso validate` must print `OK`.
5. Configure the guard before expecting any guarded route to work: create `<name>/.env` (git-ignored) with `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` and `PSO_JWT_JWKS_URI` or `PSO_JWT_PUBLIC_KEY_FILE`. Never commit it and never invent values; ask the user for the issuer and audience.
6. Start with `pso dev`, or the whole workspace in Docker: `pso infra:init --identity keycloak --runtime docker` once, then `pso docker:up --vendor` (`--vendor` is needed for image builds with an installed CLI). `GET /products/options` is public; the other `products` routes need a token with `products:read` / `products:write`. If no service serves `/products` yet, `pso validate` warns `PSO_CRUD_UNBOUND` and those routes answer `502` until `pso create service` binds them: that is expected, not a bug to work around.

Do not edit `src/main.ts` to add routes. Add modules with `pso make:module`, or a complete resource with `pso make:crud <name> --service <svc> --orchestrator`. Application-wide guards, middlewares, interceptors and filters live in `src/.app/`; never put them in a module unless only that module uses them.
