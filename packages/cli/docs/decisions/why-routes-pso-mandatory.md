---
title: Why ROUTES.pso.ts is mandatory
description: Exposure is a security decision made in one reviewable place.
order: 3
keywords: [decision, routes, exposure, security]
related: [orchestrator/routes, security/secure-routing]
---
## Context

In annotation-driven frameworks, adding `@Delete` to a method exposes an endpoint. A forgotten decorator, a copy-paste or an AI-generated edit can publish something nobody reviewed.

## Decision

Decorators **describe** actions; `ROUTES.pso.ts` **decides** what is reachable. The route, its method, path, security policy and upstream are declared there, and the runtime activates a route only if the declaration, the module and the decorated action all agree. With no `ROUTES.pso.ts` nothing from the module is exposed, and there is no fallback discovery.

## Consequences

- A security review reads one file per module to know the whole public surface.
- A decorated but undeclared method answers `404`, proven by tests.
- Mismatches (`PSO_ROUTE_004`, `PSO_ROUTE_005`) are caught before deployment and again at start-up.
- Some duplication: method and path appear in the decorator and in the registry. That is the point: they must agree, and `pso make:route` writes both.

## Alternatives considered

Decorator-only exposure (implicit) and registry-only routing without controller metadata (loses the type-checked link between route and implementation). PSO keeps both and validates the pair.

## What it looks like in practice

A method that is decorated but not declared answers `404` (Expected output):

```text evidence="expected"
DELETE /customers/1   (decorated @Delete in the controller, absent from ROUTES.pso.ts)
HTTP 404 application/problem+json
{"code":"PSO_HTTP_NOT_FOUND", ...}
```

and the public surface of the system is one command:

```text evidence="expected"
$ pso routes:list
GET     /products                product.findAll        -> catalog        guard:jwt
GET     /reports/summary         reports.summary                          public
```

## What validation says about it

The consistency checks are real and each one was reproduced on a generated workspace ([Validation errors, one by one](/reference/diagnostics-catalog)): a registry entry whose method or path differs from the decorator is `PSO_ROUTE_004` or `PSO_ROUTE_005`; an action that does not exist is `PSO_ROUTE_002`; a deleted registry is `PSO_MODULE_002`. And the opposite case, which is the point of this decision: a controller whose actions are decorated but whose registry is empty **validates `OK` and exposes nothing**. Consistent declarations are valid; an endpoint that is not declared does not exist.

## The cost

Two edits for one endpoint (decorator and registry). `pso make:route` writes both, in one all-or-nothing step, and rolls back if validation fails.

## When to revisit

Not as a security trade-off: exposure stays explicit. If the duplication of method and path annoys, improve the generators or the editor tooling, not the rule.
