---
title: Why PSO exists
description: The problems PSO targets, the design bets it makes, a concrete before and after, and when another approach is the better choice.
order: 2
keywords: [motivation, boilerplate, conventions, trade-offs, when not to use]
related: [getting-started/philosophy, decisions/why-directory-conventions, reference/choosing-an-approach]
---
Distributed applications repeat the same work in every project: the same folder layout, the same wiring between a gateway and its services, the same security setup, the same Dockerfiles and the same "does it still hang together?" question after every change. PSO turns that repetition into conventions and validation.

| Repetitive work | What PSO does instead |
|---|---|
| Project layout decisions | Fixed directory conventions per runtime ([Conventions](/concepts/convention-over-configuration)) |
| Wiring gateway routes to services | `pso make:resource` generates the route, module, controller, contract and the Spring controller together |
| Remembering to secure endpoints | Deny by default; unsecured routes fail validation |
| Local multi-service startup | `pso dev` with dependency order, port checks and health waiting |
| Dockerfile / Compose / CI boilerplate | `pso docker:init` generates hardened files |
| Configuration sprawl | Documented layers, typed schema, secrets only as references |

## A concrete before and after

**Before.** You add `GET /products` to a system with a gateway and a Spring service. You write a Spring controller; a gateway route and handler; a proxy rule; a scope check on both sides; a test; a line in an API document. Nothing checks that the five agree. Six weeks later someone changes the shape of the response on one side only. You find out in production.

**With PSO.** One command writes all of it, consistently (here in projects created with `--template empty`; by default new projects
already serve a complete, database-backed Product API):

```bash
pso make:resource product --service catalog --route /products --scopes products:read
```

Expected output:

```text evidence="expected"
created    gateway/src/.app/contracts/product.contract.json
created    catalog/src/main/java/com/pso/catalog/application/dto/response/ProductResponse.java
created    catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java
created    catalog/src/main/resources/contracts/product.contract.json
created    catalog/src/test/java/com/pso/catalog/application/rest/ProductControllerTests.java
created    docs/api/product.md
created    gateway/src/modules/product/MODULE.pso.ts
created    gateway/src/modules/product/controllers/product.controller.ts
created    gateway/src/modules/product/routes/ROUTES.pso.ts
```

The contract is written twice (gateway and service) on purpose. If someone later edits only one copy, `pso validate` fails with `PSO_CONTRACT_DRIFT` before anything runs: the drift is caught by a command, not by an outage. Likewise a route that is not in `ROUTES.pso.ts` simply does not exist, so a forgotten registration is a visible `404`, not a half-exposed endpoint.

## The bets

1. **Structure is a better registry than code.** What exists can be discovered from names and places and checked without running anything.
2. **Exposure must be explicit.** An annotation on a method describes it; a registry file decides whether it is reachable.
3. **Services stay independent.** The orchestrator routes and protects; business logic and data stay in the services.
4. **Tooling owns infrastructure.** One CLI creates, validates, runs and packages, so the pieces cannot drift apart.

PSO does not claim to be faster or better than other frameworks. It makes a specific trade: more convention and validation in exchange for less hand-written wiring.

## When PSO is a good fit

- A public gateway in front of several services that are owned by one team or a few teams who agree on conventions.
- You want deny-by-default security and the same token verified at the edge and again in every service.
- You value being able to answer "what is reachable, by whom?" by reading one registry.

## When it is probably not

| Situation | Why another approach fits better |
|---|---|
| a single application (one deployable) | a gateway, contracts and a registry add ceremony with no benefit; use Spring Boot or Node directly |
| the gateway must be a generic reverse proxy for dozens of unrelated backends | use a purpose-built proxy; PSO routes are declared one by one on purpose |
| your team needs runtimes other than Node for the gateway and Spring for services | the generators and validators target exactly these two |
| you need published, versioned packages today | PSO packages are prepared by scripts but not published; you install from a checkout |

Read [Choosing an approach](/reference/choosing-an-approach) for the comparison, and [Architectural philosophy](/getting-started/philosophy) for the principles behind these bets.

## Next steps

- [Quick start](/getting-started/quick-start)
- [Architectural philosophy](/getting-started/philosophy)
- [Declarative architecture](/concepts/declarative-architecture)

## Common mistakes

- Adopting PSO for a single deployable application, where the gateway and the registry add ceremony without benefit.
- Expecting it to proxy arbitrary backends: routes are declared one by one on purpose.
- Assuming published packages exist: today you install from a checkout.
