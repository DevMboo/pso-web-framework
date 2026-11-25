---
title: Task: create a REST module
description: Exact steps to add a module with controller, service and declared routes.
order: 22
scope: create-rest-module
base: false
requires: [orchestrator, module-routes]
keywords: [ai, task, module, rest]
---
0. A complete resource backed by a Spring service (database, both projects, tests): prefer `pso make:crud <resource> --service <spring-service> --orchestrator [--fields ...]` and stop here.
1. `pso make:module <name> --service <orchestrator>` creates `src/modules/<name>/MODULE.pso.ts` and an empty `src/modules/<name>/routes/ROUTES.pso.ts`. Nothing is exposed yet.
2. `pso make:controller <name> --service <orchestrator>` creates `src/modules/<name>/controllers/<name>.controller.ts` and lists it in `MODULE.pso.ts`.
3. Optional: `pso make:service <name> --service <orchestrator> --export` (`services/`), `pso make:provider <provider> --module <name>` (`providers/`, the call to a microservice), `pso make:dto <name> <dto-name> --service <orchestrator>` (`dto/request/`, `--response` for `dto/response/`), `pso make:mapper <name> <mapper>` (`mappers/`), `pso make:contract <name> <contract>` (`contracts/`).
4. For each endpoint run `pso make:route <name> <action> --method GET --path / --public --service <orchestrator>` (or `--guard jwt --scopes x:read` for protected routes). This writes the decorated action and the `ROUTES.pso.ts` entry together.
5. If the endpoint belongs to a Spring service, use `pso make:resource` instead (see the protected-route task).
6. `pso validate` then `pso routes:list`. Only routes listed there exist.

Do not hand-write routes in `ROUTES.pso.ts` unless the generator cannot express them. If you must, keep literals only and re-run `pso validate`.
