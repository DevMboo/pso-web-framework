---
title: Connect multiple services
description: Two Spring services with their own databases, an orchestrator module for each, calls by service name, and the topology PSO derives from the declarations.
order: 4
keywords: [tutorial, microservices, gateway, service registration, forwarding]
related: [microservices/service-registration, orchestrator/upstream-clients, tutorials/first-application]
---

Create a second service only when it owns a separate responsibility or data boundary. In this example, `catalog` owns products and `orders` owns orders; neither service shares the other's database.

```pso-example
pso create workspace shop
cd shop
pso create service catalog
pso create service orders --template empty --db postgres
pso create orchestrator gateway
pso make:crud order --service orders --orchestrator
pso validate
pso graph
pso routes:list
```

`catalog` starts with the reference Product CRUD; `orders` starts empty, with its own PostgreSQL database, and `make:crud` gives it the
`Order` resource and the orchestrator's `orders` module. Each module calls its service **by name** (`UpstreamClient` and the
`metadata.services` of its routes), never by URL; `pso routes:inspect /orders` shows the target, the scopes and the Spring handler. See
the [Upstream contract](/orchestrator/upstream-clients) before changing how a module calls its service.

Why `--template empty` for `orders`: two services with the reference CRUD would both serve `/products`, and `pso create orchestrator`
would ask which one its `products` module calls (`--crud-service`) instead of guessing.

Start everything with `pso infra:init --identity keycloak --runtime docker` and `pso docker:up --vendor` (each service gets its own
database; neither can read the other's). `pso services:health`
distinguishes a registered service from a live one.

If `orders` is down, its routes fail while `/products` keeps working. The orchestrator maps upstream failures to documented HTTP errors;
check `pso docker:logs orders`, the service health endpoint and [the request lifecycle](/orchestrator/request-lifecycle). For
service-to-service calls originating inside Spring, use [PsoHttpClient](/spring/http-client) with a named destination and explicit
timeouts.

## What you will see

Output of a real run of the commands above (the route lists abridged to the collection routes and their `/options`):

```text evidence="expected"
$ pso validate
catalog: 12 resource(s), digest f4307ea2aac8
orders: 12 resource(s), digest 6e3559152f70
gateway: 23 resource(s), digest 1b6e753db958
OK

$ pso services:list
catalog              service       spring-boot  :8081  deps=[]
gateway              orchestrator  node         :3000  deps=[]
orders               service       spring-boot  :8082  deps=[]

$ pso graph
startup order: catalog -> gateway -> orders
gateway routes GET /orders -> orders
gateway routes GET /orders/options -> (answered by the orchestrator)
gateway routes GET /products -> catalog
gateway routes GET /products/options -> (answered by the orchestrator)

$ pso routes:list
GET     /orders                  orders.list           -> orders         guard:jwt
GET     /orders/options          orders.options                          public
GET     /products                products.list           -> catalog        guard:jwt
GET     /products/options        products.options                          public

$ pso security:policy
default: deny
GET     /orders                  guarded:jwt scopes=[orders:read]  -> orders
GET     /orders/options          public  -> (orchestrator)
GET     /products                guarded:jwt scopes=[products:read]  -> catalog
GET     /products/options        public  -> (orchestrator)
service catalog: deny by default
service orders: deny by default
```

Two things to notice. Each service got its own port (8081, 8082) automatically. And the start-up order puts the gateway **before**
`orders`, because nothing declares that the gateway depends on it: independent services start in name order. The gateway still works
(a request to `/orders` before `orders` is up is a `503`), but readiness is reported earlier than the system is truly usable. Declare
the dependency when it matters: edit `dependsOn` of `gateway` in `pso.workspace.json` (or register with `--depends-on`), then
`pso graph` shows `orders` first.

## Failure behavior to test

1. Start everything, then stop `orders`. A request to `/orders` answers `503 PSO_UPSTREAM_UNAVAILABLE`; `/products` still works.
2. `pso services:health` exits 1 and names `orders` as `DOWN`.
3. Start `orders` again: the next request succeeds with no restart of the gateway.

## Variations

| You want | Do |
|---|---|
| `orders` to call `catalog` itself | `PsoHttpClient` with a declared destination ([service-to-service](/microservices/service-to-service)) |
| `orders` to be told when a product changes | an event ([HTTP or Dispatch?](/decisions/http-or-dispatch)) |
| a second resource in the same service | `pso make:crud <name> --service orders --orchestrator` |

## Common mistakes

- Sharing a database between `catalog` and `orders` "to save time".
- Forgetting `dependsOn` and then reading start-up order as a dependency order.
- Putting both resources' routes in one module: keep one module per resource.
- Creating every service with the reference CRUD: only one service should own `/products`.
