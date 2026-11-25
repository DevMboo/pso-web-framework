---
title: Why PSO uses directory conventions
description: Context, decision, consequences and alternatives.
order: 1
keywords: [decision, conventions, directories, structure]
related: [concepts/path-structure-working, concepts/convention-over-configuration]
---
## Context

Distributed projects accumulate hand-maintained registries: lists of routes, of modules, of services. They drift from the code, and nothing but a running application tells you whether they still agree.

## Decision

Make **location and name part of the declaration**. A file's directory and suffix state what it is; the framework discovers and validates them. Where convention cannot express something (which routes are exposed, which services exist) there is a small explicit file (`ROUTES.pso.ts`, `pso.workspace.json`).

## Consequences

- Tools (CLI, Studio, AI context) can reason about a project without running it.
- A misplaced or misnamed file is an error, not a silent no-op.
- Generators know exactly where to put things, so generated code is predictable and reviewable.
- You give up some freedom of layout. In return, every PSO project looks the same.

## Alternatives considered

A central registry file for everything (drifts, merge conflicts) and annotation scanning (implicit, needs execution). PSO uses conventions for *kinds* and explicit files for *exposure*.

## What it looks like in practice

A misplaced resource is a diagnostic, not a silent no-op (Expected output):

```text evidence="expected"
ERROR   PSO_MODULE_001 gateway: Module declaration missing.
The directory routes/ghost/ contains HTTP code but no MODULE.pso.ts. There is no fallback discovery.
FAILED
```

The message names the module directory `routes/ghost/` in every structure; in the official structure that directory is
`src/modules/ghost/`.

and the same tree gives the same answer on every machine: `pso validate --write-manifest` produced identical manifests on repeated runs ([deterministic manifests](/concepts/deterministic-manifests)).

## The cost

You cannot choose another layout. Teams used to organising by feature across layers, or by their own scheme, feel it first. The mitigation is that the generators place everything for you, and that the conventions are few ([list](/concepts/convention-over-configuration)).

## When to revisit

If a convention keeps being worked around, it is probably wrong for real projects; raise it with evidence (a layout that cannot express what teams need), not as a preference.
