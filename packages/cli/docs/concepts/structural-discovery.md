---
title: Structural discovery
description: How PSO finds and classifies resources without executing your code - what it reads, what it reports, how to prove it never runs anything, and the limits of reading syntax.
order: 4
keywords: [discovery, static, ast, classification, inspect, PSO_MISPLACED_RESOURCE]
related: [concepts/deterministic-manifests, decisions/why-no-code-execution-in-discovery, concepts/convention-over-configuration]
---
:::diagram name="discovery"

## What discovery does

1. Walks the source root in **byte-wise sorted** order, skipping `node_modules`, `dist`, `target`, `.git` and `.pso`, and not following symbolic links by default.
2. Classifies each file by suffix and checks that it lives in the directory that owns its kind.
3. Reports problems as diagnostics with stable codes (for example `PSO_MISPLACED_RESOURCE`, `PSO_DUPLICATE_ID`).

For HTTP modules the CLI additionally parses `MODULE.pso.ts`, `ROUTES.pso.ts` and controller classes with the TypeScript compiler API. It reads syntax only: it never imports, evaluates or runs a file.

## See what it found

```bash
pso inspect --service catalog
```

```text evidence="verified"
exception   ConflictException            src/main/java/com/pso/catalog/shared/exception/ConflictException.java
exception   InvalidRequestException      src/main/java/com/pso/catalog/shared/exception/InvalidRequestException.java
exception   ResourceNotFoundException    src/main/java/com/pso/catalog/shared/exception/ResourceNotFoundException.java
```

(A service created with `--template empty`: its shared exceptions. The reference CRUD of a default service adds its controller, service, records, mapper, entity and repository to the list, each in its layer.)

The same model feeds `pso routes:list`, `pso security:check`, Studio and `pso ai:context`, so they cannot disagree about what exists.

## Why that matters

- It is safe on untrusted code and in CI, before dependencies are installed.
- Results are identical on every machine because ordering is byte-wise ([deterministic manifests](/concepts/deterministic-manifests)).
- Other tools reuse it instead of each implementing its own scan.

## Prove it to yourself

Add a line at the top of a controller that would kill any process that ran it:

```typescript
throw new Error("boom");
```

Run `pso validate`: it still works, because the file was parsed, not run. The reproduction, with a file that would also write a marker if executed, is on [Why discovery never executes code](/decisions/why-no-code-execution-in-discovery). Now add a file that discovery must object to:

```text evidence="expected"
ERROR   PSO_MODULE_001 gateway: Module declaration missing.
Module: ghost
The directory routes/ghost/ contains HTTP code but no MODULE.pso.ts. There is no fallback discovery.
```

The message names the module directory `routes/ghost/` in every structure; in the official structure that directory is
`src/modules/ghost/`.
*(expected output)*

## What reading syntax cannot see

| Construct | Effect |
|---|---|
| a route built in a loop or from a variable | invisible, so not allowed in registries ([declarative architecture](/concepts/declarative-architecture)) |
| a class generated at run time | not a resource |

If something is invisible to discovery, the right response is to make it explicit, not to teach discovery to run code.

## Runtime composition

At start-up `bootstrap()` loads the compiled `MODULE.pso.js` and `ROUTES.pso.js`, builds the same neutral model from decorator metadata and runs the same validator. Controller files not reachable from a module declaration are never loaded. That is why a "ghost" controller that exists on disk but is not in `MODULE.pso.ts` is never even imported, and why `pso validate` and the running application cannot disagree.

## Common mistakes

- Expecting discovery to find a service you did not declare: services come only from `pso.workspace.json`.
- Hiding a route behind a computed expression and then wondering why `routes:list` does not show it.

## Next steps

- [Why discovery never executes code](/decisions/why-no-code-execution-in-discovery)
- [Convention over configuration](/concepts/convention-over-configuration)
