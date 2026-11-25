---
title: Why the CLI manages project infrastructure
description: One tool creates, validates, runs, secures and packages.
order: 10
keywords: [decision, cli, generators, infrastructure]
related: [cli/index, devops/development-environment]
---
## Context

When creation, running, securing and packaging are separate scripts, they drift apart: the Dockerfile stops matching the layout, a route is added in one place and not another.

## Decision

The `pso` CLI owns the whole loop. Generators write code through the AST and re-validate; `pso dev` reads the same workspace the validator reads; `docker:init` generates files from the workspace; `build` and `deploy` use checksummed artifacts. Mutating commands support `--dry-run`, never overwrite your edits silently and roll back changes that would leave the project invalid. Commands that are not implemented fail with exit code 2 instead of pretending.

## Consequences

- Fewer places to keep consistent, and a single place to improve.
- The CLI is a critical component, so it has the largest test suite in the repository.
- It is also where AI assistants are pointed: [AI Context](/ai-context/overview) tells them to prefer generators over hand-editing.
- Developers can still edit everything by hand; validation catches inconsistencies.

## What it looks like in practice

One generator writes both sides of a resource and refuses to leave an inconsistent project (Expected output):

```text evidence="expected"
$ pso make:resource product --service catalog --route /products --scopes products:read
created    orchestrators/gateway/src/.app/contracts/product.contract.json
created    services/catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java
...
created    orchestrators/gateway/src/modules/product/routes/ROUTES.pso.ts
```

`--dry-run` shows the plan without writing; a conflict with your edits is reported, never overwritten silently; a change that would fail validation is rolled back ("The change would leave the module inconsistent and was rolled back").

## The cost

The CLI is a big surface. A bug in it affects every project, which is why it has the largest test suite. You also depend on it for conventions: generating code by hand is possible, but then `pso validate` is your safety net.

## When to revisit

If a task is done better by an established tool (Docker, Maven), the CLI should call it, not replace it. That is already how builds work: `mvnw` for Spring, `tsc` for the orchestrator, `docker compose` for images.
