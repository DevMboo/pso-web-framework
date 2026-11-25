---
title: Why dispatch is optional
description: Simple systems should not need a message broker.
order: 7
keywords: [decision, dispatch, broker, optional]
related: [dispatch/overview]
---
## Context

Many projects never need asynchronous messaging, and a broker is operational weight: infrastructure to run, secure and monitor.

## Decision

Event dispatch is a separate, installable subsystem. It is never added to generated projects by default and never required for local development. See [Dispatch architecture](/dispatch/overview) and [Installation](/dispatch/installation).

## Consequences

- The default workspace runs with Node and a JDK only, and needs no Docker.
- Projects can start synchronous and adopt events later without restructuring, because dispatch and the optional [outbox](/dispatch/outbox) are added later with `pso dispatch:install` and `pso dispatch:outbox`.
- Documentation and AI contexts must state clearly when a capability is optional or absent, which they do.

## What it looks like in practice

A new service has dispatch configured but off:

```text evidence="expected"
dispatch.enabled   false    <- defaults
dispatch.provider  "none"   <- defaults
```
*(expected output of `pso config:show` for a new service)*

No adapter dependency, no broker connection, no topology. Turning it on is three explicit steps: `pso dispatch:install redis --service catalog`, set the broker URL in the environment, set `enabled: true` ([installation](/dispatch/installation)).

## The cost

When you do need events, you have a small migration: declare the events, add the consumers, adopt the outbox where atomicity matters. That cost is smaller than operating a broker you never needed.

## When to revisit

If most projects end up installing dispatch, the default could change. The decision to keep it optional is about not forcing operations work on projects that do not need it; see [HTTP call or Dispatch event?](/decisions/http-or-dispatch) to decide for a specific interaction.
