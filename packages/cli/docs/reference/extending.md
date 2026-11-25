---
title: Extending PSO
description: Where to add resource kinds, commands, guards, checks and documentation pages - with a worked example of a new command and the tests that will tell you what you forgot.
order: 40
keywords: [extend, plugin, custom command, guard, KindSpec, registry, CLI_NOTES]
related: [orchestrator/guards, orchestrator/middleware-and-filters, concepts/convention-over-configuration]
---
This page is for people changing the framework itself. Application code extends PSO through guards, middleware, filters, providers and DTO validators ([guards](/orchestrator/guards), [middleware and filters](/orchestrator/middleware-and-filters), [DTO validation](/orchestrator/dto-validation)); those need no framework change.

- **New resource kinds:** add a `KindSpec` to `packages/core/src/conventions.ts`; discovery, validation and manifests pick it up.
- **New commands:** add a module exporting `Record<string, Command>` and spread it into `packages/cli/src/registry.ts`. The CLI reference, AI contexts and search index include it automatically.
- **Guards:** `src/.app/guards/*.guard.ts` (global) or `src/modules/<module>/guards/*.guard.ts` (module-local) exporting `Guard`.
- **Documentation pages:** add a Markdown file with front matter under `packages/cli/docs/<section>/`.
- **Plugin registration and incremental discovery are not implemented.**

## Worked example: a new command

A command is an object with a `usage`, a `summary` and a `run` function that returns an exit code:

```typescript title="packages/cli/src/commands-hello.ts"
import { emit, type Command } from "./commands.ts";

export const HELLO_COMMANDS: Record<string, Command> = {
  "hello:world": {
    usage: "pso hello:world [--shout] [--json]",
    summary: "Print a greeting (an example command)",
    run(ctx) {
      const text = ctx.flags["shout"] === true ? "HELLO" : "hello";
      emit(ctx, { greeting: text }, text);   // prints text, or the object with --json
      return 0;                              // the exit code
    },
  },
};
```

Register it:

```typescript title="packages/cli/src/registry.ts"
import { HELLO_COMMANDS } from "./commands-hello.ts";
export const ALL_COMMANDS = { /* ... */ ...HELLO_COMMANDS };
```

Then add the practical notes the reference page requires:

```typescript title="packages/cli/src/portal/cli-notes.ts"
"hello:world": { examples: ["pso hello:world", "pso hello:world --shout"], failures: ["Prints nothing else; there is nothing to fail."] },
```

## What will tell you what you forgot

The documentation tests are the checklist. For a new command they verify (all existing, targeted tests):

| Test | Fails when |
|---|---|
| every implemented command has its own reference page with usage | the command is not in the registry, or its `usage` is missing |
| every registered command has practical reference notes | `CLI_NOTES` has no examples or no failure guidance |
| documented commands exist, and every flag used with them is accepted | a documentation page uses a flag that is not in the command's `usage` |
| docs drift | a page mentions a command that does not exist |

Rules the real commands follow, and that you should too:

- **Destructive operations** need an explicit confirmation flag (`--yes`) and a `--dry-run` where it makes sense.
- **Never overwrite** a user's file silently: report a conflict; `--force` is the explicit override.
- **Exit codes:** `0` success, `1` problems found or a refusal (for example `pso uninstall` without `--yes`), `2` not implemented or blocked by a missing toolchain (the installer without Inno Setup), `3` is used by `pso deploy` when `--yes` is missing.
- **Secrets** never appear in output.
- **Do not execute project code** from a command that discovers or validates.

## Adding a resource kind

A `KindSpec` says which suffix identifies a kind, which directory owns it and how it is named. After adding one, `pso validate`, `pso inspect` and the manifest recognise it, and a misplaced file of that kind becomes `PSO_MISPLACED_RESOURCE` (see [Convention over configuration](/concepts/convention-over-configuration)).

## Common mistakes

- Adding a command without `CLI_NOTES` (the tests fail by design).
- Documenting a flag in a page without adding it to `usage`.
- Making a command that runs project code during validation.

## Next steps

- [Guards](/orchestrator/guards)
- [Architecture decisions](/decisions/why-cli-manages-infrastructure)
