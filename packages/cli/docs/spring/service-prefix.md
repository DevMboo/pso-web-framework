---
title: Service prefix
description: The one authoritative prefixing strategy between the orchestrator and Spring services, and how duplicates are prevented.
order: 4
keywords: [prefix, pso.service.prefix, context-path, routing, gateway, users-service]
related: [spring/configuration, orchestrator/routes, concepts/contracts]
---
A request to `GET /customers` on the orchestrator reaches the service as `GET /users/customers`. The prefix is added in exactly **one place on each side** and nowhere else:

| Layer | What happens |
|---|---|
| Orchestrator | the route is declared as `/customers` in `ROUTES.pso.ts`; `Upstream` prepends the service's prefix from `pso.workspace.json` when forwarding |
| Spring service | the starter adds `pso.service.prefix` to every `@RestController`; controllers map `/customers`, **without** the prefix |

## Derivation

`pso create service <name>` derives the prefix and writes it to both `pso.workspace.json` (`"prefix": "/users"`) and `application.yml`:

| Service name | Prefix |
|---|---|
| `users-service` | `/users` |
| `orders-service` | `/orders` |
| `notification-service` | `/notification` |
| `billing` | `/billing` |

Override it with `pso create service orders-service --prefix /purchases`; `--prefix /` means no prefix. Values are normalized (`api//v1/` becomes `/api/v1`) and rejected when they contain upper case, spaces, dot segments or other unsafe characters.

## Duplicate prevention

The service refuses to start when the prefix would be applied twice:

- `server.servlet.context-path` is set together with a prefix (keep the context path empty).
- a controller mapping already starts with the prefix (it would be served at `/users/users/...`).

`pso validate` reports `SPR013` when `pso.service.prefix` and `pso.workspace.json` disagree, because the orchestrator would then forward to the wrong path. Health and other actuator endpoints are **not** prefixed. A controller annotated `@Unprefixed` opts out.

## Migrating an existing service

A service created before prefixes existed serves its paths at the root. Declare `"prefix": "/"` for it in `pso.workspace.json` and set `pso.service.prefix: /` to keep the old behavior.

## Seeing it (verified)

A `catalog` service's workspace entry carries `"prefix": "/catalog"`, and its controllers map paths **without** it; a call goes to `/catalog/ping`. The unprefixed path does not exist (the generated tests assert `404` for `/ping`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| the gateway forwards but the service answers `404` | `pso.service.prefix` and `pso.workspace.json` disagree (`SPR013` in `pso validate`) |
| `/users/users/...` | a controller mapping already starts with the prefix; remove it or annotate `@Unprefixed` |
| the service refuses to start | a context path is configured together with a prefix |

## A controller named like the service: `@RepeatsServicePrefix`

The prefix is applied once, by PSO, so a controller mapped to `/orders` in the service whose prefix is `/orders` is served at `/orders/orders`. That path is legitimate (the resource is simply named like the service), but a mapping that begins with the prefix is far more often a mistake: a controller that wrote the prefix by hand and would be served at `/orders/orders/...` by accident. The starter therefore **refuses to start** when a mapping begins with the service prefix, unless the controller says the repetition is intended:

```java title="src/main/java/com/pso/orders/application/rest/OrdersController.java"
package com.pso.orders.application.rest;

import com.pso.spring.autoconfigure.RepeatsServicePrefix;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// Served at /orders/orders: the service prefix /orders plus this mapping.
@RestController
@RepeatsServicePrefix
@RequestMapping("/orders")
public class OrdersController {

    @GetMapping
    public List<String> list() {
        return List.of();
    }
}
```

The generators write it for you, with the same rule: `pso make:controller orders --service orders` and `pso make:resource orders --service orders` add the annotation (and a comment that says why), and so does an explicit path below the prefix such as `--route /orders/archive`. A path that merely looks similar (`/orders-export`) is another segment and is not annotated. Nothing is ever removed from a path.

| Annotation | Import | Use it when |
|---|---|---|
| `@RepeatsServicePrefix` | `com.pso.spring.autoconfigure.RepeatsServicePrefix` | the controller's path starts with the service prefix **on purpose**; the prefix is still applied, so the public path contains it twice |
| `@Unprefixed` | `com.pso.spring.autoconfigure.Unprefixed` | the controller must be served **without** the service prefix, at exactly its own mapping (an endpoint that is not part of the service's API surface behind the orchestrator, such as a callback path dictated by a third party) |

They are opposites: `@RepeatsServicePrefix` keeps the prefix and accepts the repetition; `@Unprefixed` removes the prefix for that controller. Reach for `@Unprefixed` rarely: the orchestrator forwards to `<prefix><path>`, so an unprefixed controller is not reachable through an ordinary forwarded route.

## Common mistakes

- Writing the prefix inside controller mappings.
- Changing the prefix in one place only.

## Next steps

- [Spring configuration](/spring/configuration)
- [Routing](/orchestrator/routes)
