---
title: Path Structure Working
description: The central idea - where a file lives and what it is called defines what it does - with a walkthrough from a file name to a running endpoint, and the limits of the approach.
order: 1
keywords: [pso, path, structure, convention, workspace, module]
related: [concepts/convention-over-configuration, concepts/structural-discovery, decisions/why-directory-conventions, getting-started/philosophy]
---
In PSO the **path** of a file and its **name** are part of the program. `src/modules/users/MODULE.pso.ts` is a module because of where it is and what it is called, not because some other file registered it.

| Level | What the structure says |
|---|---|
| Workspace | `pso.workspace.json` lists services, ports, dependencies |
| Project | A Node orchestrator has `src/`; a Spring service has `src/main/java/<pkg>/` |
| Module | `src/modules/<module>/` holds `MODULE.pso.ts`, `routes/ROUTES.pso.ts`, and `controllers/`, `services/`, `providers/`, `dto/` |
| File | A suffix names the kind: `.controller.ts`, `.guard.ts`, `.contract.json`, `Controller.java` |

The framework reads the structure, validates it and composes the application from it. Because reading the structure does not run code, tools such as `pso validate`, `pso routes:list`, Studio and the AI context can all use it safely.

```tree title="A module inside an orchestrator"
src/
  .app/
    guards/jwt.guard.ts  # generated: the application-wide "jwt" guard
    contracts/users.contract.json  # optional: a machine-readable description of the API
  modules/
    users/
      MODULE.pso.ts  # manual: composition - which controllers and providers belong together
      routes/ROUTES.pso.ts  # manual: declaration - which endpoints are exposed
      controllers/users.controller.ts  # manual: implementation
      services/users.service.ts  # manual
      dto/request/create-user.dto.ts  # manual
      guards/users-key.guard.ts  # manual: a guard only this module uses
  shared/  # reusable code that belongs to no single module
```

## A walkthrough: from a file name to an endpoint

Take `src/modules/product/controllers/product.controller.ts` (a real generated file).

1. **Its path says it is part of the module `product`.** The directory under `modules/` is the module.
2. **Its suffix says it is a controller.** `.controller.ts` is classified as a controller; the same name with `.guard.ts` would be a guard.
3. **`MODULE.pso.ts` of that module directory says it belongs to the module.** If it is missing from `controllers`, discovery reports `PSO_MODULE_003`.
4. **`routes/ROUTES.pso.ts` says which of its actions are endpoints.** Only listed ones are reachable.
5. **`pso.workspace.json` says the module forwards to the service `catalog`** (through `metadata.service`).
6. **The runtime activates it** only if every earlier statement holds.

You can watch the model: `pso routes:inspect product.findAll` prints the whole chain :

```text evidence="verified"
GET /products  ->  catalog:8081
access:   guard jwt, scopes products:read
defined:  orchestrators/gateway/src/modules/product/routes/ROUTES.pso.ts
contract: present
handlers: services/catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java
```

One command shows the route, its policy, where it is declared, whether a contract exists and which class handles it on the service side. That is the payoff of making structure meaningful.

## Try the three layers separately

Use a workspace with the generated `product` resource from [the first application](/tutorials/first-application). These commands answer different questions:

```bash
pso inspect --service gateway
pso routes:list
pso routes:inspect product.findAll
pso services:health
```

| Check | Reads | Meaning of success |
|---|---|---|
| `inspect` | source paths and classified files | PSO can see the module, controller and other resources in their expected places |
| `routes:list` | route and module declarations | `GET /products` is exposed by a valid registry |
| `routes:inspect` | the matching route, policy and target | the route requires `products:read` and points to `catalog` |
| `services:health` | live health endpoints | processes answer now; this can be DOWN while all three static checks above pass |

This order helps when a request fails: a missing route is a declaration problem; a DOWN service is a runtime problem; a `401` or `403` is a credential or policy problem. [The CLI workflow](/cli/workflow) takes the same example through an actual request.

## Where the flexibility lives

The fixed paths give tools a reliable map; they do not force one business design. A module may have several controllers, may share a provider through explicit `imports` and `exports`, and may expose only some decorated actions. A Spring service can use JPA or JDBC, and a workspace can add independent services or Dispatch when a synchronous call is the wrong fit. The choices are explicit in the [module model](/concepts/module-composition), [JPA or JDBC decision](/decisions/jpa-or-jdbc) and [HTTP or Dispatch decision](/decisions/http-or-dispatch).

The boundary is also explicit: a dynamic route assembled from a loop cannot be checked statically. Make the route literal in `ROUTES.pso.ts`, then put flexible behavior inside the controller or service where normal code can express it.

## What the approach costs

| Cost | Why you pay it |
|---|---|
| files must have the right names and places | so tools do not need configuration to understand them |
| renaming means moving carefully | the generators and `pso validate` catch mistakes |
| some flexibility is gone (dynamic route tables, arbitrary layouts) | what is flexible cannot be validated without running |

## When structure alone is not enough

Structure says what a file *is*. It never grants trust: routes still need an explicit declaration and a security policy, and services are declared in the workspace rather than inferred. Behavior that depends on the environment (ports, limits, secrets) is configuration, not structure ([configuration](/concepts/configuration)).

## Common mistakes

- Putting a controller where the module does not list it.
- Naming a file without the suffix and wondering why it is ignored (a plain helper is ignored on purpose).
- Treating the directory layout as a suggestion and fighting `PSO_MISPLACED_RESOURCE`.

## Next steps

- [Convention over configuration](/concepts/convention-over-configuration)
- [Structural discovery](/concepts/structural-discovery)
- [Quick start](/getting-started/quick-start)
