---
title: Why the bootstrap is minimal
description: main.ts is one call; the framework does the rest.
order: 9
keywords: [decision, bootstrap, main.ts, minimal]
related: [orchestrator/bootstrap]
---
## Context

When the entry point wires modules, routes and middleware by hand, it becomes the place where exposure is decided and where mistakes hide.

## Decision

`main.ts` calls `bootstrap()` and nothing else that matters. Discovery, validation, dependency injection and route activation live in `@pso/http` and `@pso/core`, and are driven by the declared structure.

## Consequences

- There is no list of routes to forget to update in `main.ts`; the registry is `ROUTES.pso.ts`.
- All projects start the same way, so tooling and upgrades are uniform.
- Customization happens through named guards, middleware and filters and through configuration, not by editing the bootstrap.
- A project that needs something the framework does not offer has to extend the framework or add a provider; the entry point is not an escape hatch.

## What it looks like in practice

The whole generated entry point is one call plus shutdown handling ([First orchestrator](/getting-started/first-orchestrator)). At start-up the framework logs what it did, which replaces reading a wiring file:

```text evidence="expected"
INFO  [startup] starting orchestrator  service=gateway environment=development ...
INFO  [security] security initialized (pem, ES256)
INFO  [http] orchestrator listening  host=127.0.0.1 port=3000 routes=4 modules=2
```
*(expected output)*

If a registry is invalid, the process exits with one `startup failed ... diagnostics=[...]` line and nothing is listening.

## The cost

You cannot register a route in `main.ts`, add ad-hoc middleware globally or reorder the pipeline there. Cross-cutting behavior goes in guards, middleware and filters ([middleware and filters](/orchestrator/middleware-and-filters)); settings go in configuration.

## When to revisit

If a real need cannot be met by guards, middleware, filters, providers and configuration, the right change is a new extension point in the framework, reviewed and tested, not editing every project's `main.ts`.
