---
title: Task: add a protected route
description: Exact steps to add a guarded, scope-checked route.
order: 23
scope: add-protected-route
base: false
requires: [module-routes, security]
keywords: [ai, task, protected, guard, scopes]
---
1. Choose the scope names with the user (for example `orders:read`). Do not invent an authorization model.
2. Route to an existing module:
   `pso make:route <module> <action> --method GET --path /<path> --guard jwt --scopes orders:read --service <orchestrator>`
   Add `--upstream <service>` to forward to a Spring service.
3. New resource backed by a Spring service, with persistence: `pso make:crud <name> --service <spring-service> --orchestrator` (scopes `<plural>:read` / `<plural>:write`, a public `/<plural>/options`). A forwarding endpoint only:
   `pso make:resource <name> --service <spring-service> --route /<path> --scopes orders:read`
   (GET collection or `--method POST`). It generates the orchestrator module, the Spring controller with `@PreAuthorize`, tests, a contract and documentation, all-or-nothing.
4. `pso validate`, `pso security:policy` (the route must show `guarded` with the scopes) and `pso security:check`.
5. Never use `--public` for a route that returns or changes private data. A route cannot be both public and guarded (`PSO_ROUTE_007`).
6. Test the three outcomes: no token `401`, token without the scope `403`, token with the scope `200`.
