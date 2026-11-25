---
title: Service registration
description: How services are declared, registered and found, in development and production - the commands, their real output, the validation that runs before anything is saved, and what registration does not grant.
order: 5
keywords: [registry, discovery, services:register, pso.workspace.json, health, services:inspect]
related: [orchestrator/upstream-clients, devops/development-environment, getting-started/first-workspace]
---
Services are **declared**, never discovered by scanning ports.

| Task | Command |
|---|---|
| Declare an existing project | `pso services:register billing --port 8083 --runtime spring-boot --depends-on catalog` |
| Remove a declaration | `pso services:unregister billing` (refused while others depend on it; files are never deleted) |
| List | `pso services:list` |
| Inspect one | `pso services:inspect catalog` (declaration, resources, live health) |
| Probe live | `pso services:health` |
| Dependency graph and order | `pso services:graph`, `pso graph` |

## What the commands print

Expected output from a workspace with a gateway and a service that is **not running**:

```text evidence="expected"
$ pso services:list
catalog              service       spring-boot  :8081  deps=[]
gateway              orchestrator  node         :3000  deps=[]

$ pso services:inspect catalog
catalog (service, spring-boot) :8081  health: DOWN
depends on: -   used by: -
  controller  ProductController          src/main/java/com/pso/catalog/application/rest/ProductController.java
  entity      ProductEntity              src/main/java/com/pso/catalog/infrastructure/entity/ProductEntity.java
  ...

$ pso services:health
DOWN  catalog            http://127.0.0.1:8081/actuator/health
DOWN  gateway            http://127.0.0.1:3000/health/ready
[exit 1]

$ pso graph
startup order: catalog -> gateway
gateway routes GET /products -> catalog
```

`services:health` exits 1 if any service is down, which makes it usable as a CI gate after starting the stack.

## Validation before saving

Registration is validated before it is saved: unique name and port, an existing path inside the workspace, known dependencies, no cycles. Verified refusals:

```text evidence="expected"
$ pso services:register billing --port 8083 --runtime spring-boot --depends-on catalog
error: Path "billing" does not exist in the workspace

$ pso services:unregister catalog        (while gateway declares dependsOn: ["catalog"])
error: Cannot unregister "catalog": required by gateway
hint: Remove those dependencies first
[exit 1]
```

The first refusal is because the folder `billing` had not been created: register an *existing* project, and use `pso create service` to make a new one. Without a dependent, `pso services:unregister catalog` prints `unregistered catalog (project files untouched)`.

## Runtime registry in development

`pso dev` writes `.pso/registry.json` with each service's lifecycle state, process id and last health result, updates it every 5 seconds and mirrors logs to `.pso/logs/`. Studio and `pso services:health` show the same facts.

## Production

The orchestrator reads `PSO_UPSTREAM_<NAME>=host:port`, which is what `pso docker:init` sets in the generated Compose file. DNS-based resolution comes from your platform; PSO does not implement other registries. The service name becomes the variable name (`users-service` becomes `PSO_UPSTREAM_USERS_SERVICE`).

## Variations

| Situation | Do |
|---|---|
| adopt several existing projects at once | `pso init` in the folder that contains them |
| change a port | edit `pso.workspace.json` and `pso validate`; update Compose/ingress too |
| a service that is not a Spring/Node project PSO can start | not supported by `pso dev`; declare it for routing only if the orchestrator forwards to it |

Registration grants **no authorization**: a registered service is only reachable through routes whose guards pass, and it validates tokens itself.

## Common mistakes

- Registering a service and expecting its routes to appear: routes come from `ROUTES.pso.ts`.
- Forgetting `--depends-on`, so `pso dev` starts the gateway before the service it forwards to (it still works, but readiness is reported late).

## Next steps

- [Upstream clients](/orchestrator/upstream-clients)
- [Development environment](/devops/development-environment)
