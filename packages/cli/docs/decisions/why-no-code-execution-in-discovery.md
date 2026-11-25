---
title: Why discovery does not execute application code
description: Static analysis keeps tooling safe, fast and deterministic.
order: 5
keywords: [decision, discovery, static analysis, ast, safety]
related: [concepts/structural-discovery]
---
## Context

Validating a project by importing its modules runs arbitrary top-level code: database connections, network calls, file writes. That makes tooling slow, order-dependent and unsafe on code you did not write (a pull request, a dependency).

## Decision

Discovery and validation **parse** files (names, and the TypeScript AST for modules, routes and controllers) and never import or evaluate them. Declarations are restricted to statically analyzable forms so this is possible. Only `bootstrap()` loads code, at runtime, and only what a module declares.

## Consequences

- `pso validate`, `routes:list`, Studio, `security:check` and AI context generation are safe in CI and on untrusted code. The test suite proves it with files that throw or write a marker if executed.
- Results are deterministic and fast.
- Declarations cannot be computed dynamically (no spread, no generated route tables). That is a deliberate restriction.
- Some errors that only appear when code runs (for example a provider throwing in its constructor) are not found statically.

## Alternatives considered

Importing modules to read metadata (accurate but unsafe) and a hybrid that executes in a sandbox (complex, still non-deterministic).

## What it looks like in practice

Put these three lines at the top of a controller, a file that would write a marker file and then throw if anyone executed it:

```typescript title="orchestrators/gateway/src/modules/orders/controllers/orders.controller.ts (top of the file)"
import { writeFileSync } from "node:fs";
writeFileSync("EXECUTED.marker", "executed");
throw new Error("boom: this file must never be executed by validation");
```

Then run `pso validate`:

```text evidence="verified"
$ pso validate
gateway: 4 resource(s), digest <varies per project>
catalog: 3 resource(s), digest <varies per project>
OK
```

It passes, and no marker file exists afterwards: the file was parsed, not run. This is reproduced by `docs-diagnostics.test.ts` (the test checks the result, the exit code and the absence of the marker).

## The cost

Errors that depend on running code are not found statically: a provider that throws in its constructor, a misconfigured database URL. Those are found at start-up (and the process refuses to start, so they still cannot reach traffic).

## When to revisit

The restriction on declarations (literals only) is the price of this property. If a feature needs computed declarations, the answer is to find another way to make it explicit, not to start executing project code during validation.
