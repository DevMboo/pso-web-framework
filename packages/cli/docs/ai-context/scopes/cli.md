---
title: CLI commands
description: Every implemented command, generated from the installed CLI, with conventions for using them.
order: 7
scope: cli
base: true
keywords: [ai, cli, commands]
---
Use only the commands below; they are generated from the installed CLI (`pso` {{version}}). Anything else does not exist.

{{facts:commands}}

## Using commands safely

- `--help` shows usage. Most commands accept `--json`. Mutating commands accept `--dry-run`: run it first.
- Exit codes: `0` success, `1` failure (validation, conflict, refusal), `2` unknown or not-implemented command, `3` explicit authorization (`--yes`) required for `deploy`/`rollback`.
- `--force` overwrites differing files: never add it without the user's explicit consent.
- `--yes` authorizes a deployment: never add it on your own. Deployment must be requested by the user.
- On Windows use PowerShell. Git Bash rewrites arguments that start with `/`.
- Typical loop: `pso make:*` then `pso validate` then `pso security:check` then `pso test`.

{{facts:unsupported}}
