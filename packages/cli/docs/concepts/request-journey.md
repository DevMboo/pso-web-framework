---
title: Follow a request through PSO
description: A guided map of the core concepts, from a path on disk to a secured route, service response and diagnostic.
order: 1
keywords: [concepts, request, path structure working, module, route, security, service]
related: [concepts/path-structure-working, concepts/module-composition, concepts/security-by-default, concepts/contracts, cli/workflow]
---

Consider `GET /products` in a workspace with a TypeScript gateway and a Spring `catalog` service. PSO gives each part a separate question to answer. Follow them in order when learning the framework or diagnosing a request.

| Layer | The question it answers | Where to look | How to check |
|---|---|---|---|
| Workspace | Which projects and ports exist? | `pso.workspace.json` | `pso inspect`, `pso services:graph` |
| Structure | Is this file in a recognized place? | `orchestrators/gateway/src/modules/product/` | `pso inspect --service gateway` |
| Module | Which controller and providers belong together? | `MODULE.pso.ts` | `pso validate` |
| Route | Is this exact method and path exposed? | `ROUTES.pso.ts` | `pso routes:list`, `pso routes:inspect product` |
| Security | Who may call it? | the route security declaration and the service policy | `pso security:check`, then an HTTP request |
| Service | Can the target answer? | the `catalog` process and its controller | `pso services:health`, then an HTTP request |

## From a file to an HTTP response

1. The workspace declares `gateway` and `catalog`. A directory alone does not register a service. [Workspace and service registration](/microservices/service-registration) explains the declaration.
2. PSO discovers the gateway route directory by its path and reads its literal declarations. Discovery does not run arbitrary application code. [Path Structure Working](/concepts/path-structure-working) explains what the path means.
3. `MODULE.pso.ts` makes the controller and its dependencies available. A class existing on disk does not automatically become a provider. [Module composition](/concepts/module-composition) and [dependency injection](/concepts/dependency-injection) show the boundary.
4. `ROUTES.pso.ts` names the controller action, HTTP method, path, target and access policy. A decorator on a controller is insufficient by itself. [Declarative architecture](/concepts/declarative-architecture) explains why the registry is explicit.
5. A request without a valid token is refused before the service call when the route requires authentication. The Spring service also checks its own policy. [Security by default](/concepts/security-by-default) covers both checks.
6. A permitted request reaches `catalog`. The service contract records the offered operation; runtime DTO validation and service logic determine the actual response. [Contracts](/concepts/contracts) explains what the JSON contract does and does not guarantee.

The resulting path is:

```flow title="The request path of GET /products"
client | GET /products -> gateway route declaration -> gateway authentication and authorization -> product controller and provider -> catalog HTTP endpoint and service policy -> response to client
```

This is a conceptual trace, not a claim that every PSO request calls a Spring service. A gateway action can run local logic; a workspace can also add Dispatch for asynchronous work. The explicit route and security rules still apply to HTTP exposure.

## See each boundary in practice

Use the [CLI workflow](/cli/workflow) for the full setup and copyable commands. Once the workspace exists, run these checks in sequence:

```bash
pso validate
pso routes:list
pso routes:inspect product
pso security:check
pso services:health
curl -i http://127.0.0.1:3000/products
```

| Observation | What you have learned | What to do next |
|---|---|---|
| `validate` succeeds | declarations agree statically | inspect the route and start the processes |
| route is absent from `routes:list` | the URL is not exposed | inspect `ROUTES.pso.ts` and the module declaration |
| health is DOWN | a process or health endpoint is unavailable | inspect the service log, port and configuration |
| HTTP `401` or `403` | the request reached an access check | inspect token claims and the declared policy |
| HTTP `503` | the gateway cannot complete the upstream call | probe the target service and inspect its log |
| HTTP `200` | this specific request completed | inspect the body and add a test for its business behavior |

These checks deliberately answer different questions. A green static check cannot prove that the database is reachable; a healthy process cannot prove that a caller has permission.

## What can go wrong at each boundary

Each layer fails in its own way, and the failure tells you which layer to inspect. Start from the first one that fails; later layers cannot be judged until it is fixed.

| Boundary | Typical failure | What you will see | Where the cause is |
|---|---|---|---|
| Workspace | a project exists on disk but is not declared | the service is missing from `pso inspect` and from `pso dev` | `pso.workspace.json` |
| Structure | a file is outside a recognized path | it is not discovered; nothing reports it as an error | the directory layout, see [Path Structure Working](/concepts/path-structure-working) |
| Module | a controller or provider is not listed | `pso validate` reports the module; at run time the dependency cannot be resolved | `MODULE.pso.ts` |
| Route | the method and path are not in the registry | `404` from the gateway although the controller exists | `ROUTES.pso.ts` |
| Security | missing, expired or insufficient token | `401` or `403` before the service is called | the route's security declaration and the token's claims |
| Service | the target is stopped, slow or refuses the call | `503` or `504` from the gateway, or the service's own `401`/`403` | the target process, its log and its own policy |

Limits of this map: it describes one synchronous HTTP request. It says nothing about events published through Dispatch, WebSocket Channels or scheduled work, which have their own delivery rules, and a request that completes with `200` proves that one path only. The static commands never contact a process, so they cannot detect a wrong database URL, an unreachable broker or an expired signing key.

## Where to go deeper

- To understand how a setting wins over another, use [configuration resolution](/concepts/configuration) and `pso config:show`.
- To see how services start and stop, use [runtime lifecycle](/concepts/runtime-lifecycle).
- To see what changes when files change, use [structural discovery](/concepts/structural-discovery) and [deterministic manifests](/concepts/deterministic-manifests).
- To build the complete example, follow [the first application tutorial](/tutorials/first-application).
