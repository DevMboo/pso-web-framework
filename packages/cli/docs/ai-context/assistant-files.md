---
title: Assistant files and the CLI
description: pso ai:context and pso ai:init: generate AGENTS.md, CLAUDE.md, Copilot instructions or generic Markdown.
order: 3
keywords: [ai:context, ai:init, AGENTS.md, CLAUDE.md, copilot-instructions.md]
related: [cli/ai-context, cli/ai-init, ai-context/accuracy-and-security]
---
## `pso ai:context`

```bash
pso ai:context --list                                   # available scopes
pso ai:context                                          # complete context, Markdown to stdout
pso ai:context --scope security,module-routes
pso ai:context --format json
pso ai:context --format agents --output ./AGENTS.md
pso ai:context --format markdown --output ./PSO_CONTEXT.md --dry-run
```

| Format | Output |
|---|---|
| `markdown` | plain Markdown |
| `json` | `{ name, version, scopes, estimatedTokens, sha256, text }` |
| `agents` | `AGENTS.md` layout |
| `claude` | `CLAUDE.md` layout |
| `copilot` | `.github/copilot-instructions.md` layout |

Inside a workspace the output also contains a **Project facts** section (services, modules, declared routes, installed features). Use `--no-project` to leave it out.

## `pso ai:init`

```bash
pso ai:init --dry-run
pso ai:init                       # AGENTS.md, CLAUDE.md and .github/copilot-instructions.md
pso ai:init --target agents,claude
```

It inspects the workspace first, then writes the chosen files at the workspace root.

## Never overwrites your instructions

- The generated text sits between `<!-- pso:ai-context:start ... -->` and `<!-- pso:ai-context:end -->`. When the markers exist, **only that block** is replaced, so reruns are safe and update the version.
- An existing file **without** the markers is skipped, with an explanation. `--force` appends a managed block at the end and never deletes your text.
- `ai:context --output` refuses to overwrite a different existing file without `--force`.
- `--dry-run` shows what would happen and writes nothing.

## Never exposes secrets

Only names, ports, methods and paths are extracted. `.env` files, keys, configuration values, comments and free text are never read into the context.
