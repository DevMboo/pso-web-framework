---
title: PSO AI Context
description: Give coding assistants accurate, version-matched knowledge of PSO instead of letting them guess.
order: 1
keywords: [ai, llm, codex, claude code, copilot, assistant, context]
related: [ai-context/builder, ai-context/assistant-files, ai-context/accuracy-and-security]
---
**PSO AI Context** is a set of generated instructions that tell an AI coding assistant how PSO works: the architecture, directory conventions, the module and route contracts, decorator semantics, the CLI commands that really exist, the security model and the rules for generating code.

PSO Web Framework is free and open-source software under the Apache License 2.0. For the current `0.2.0-rc.6` distribution the official structures are **mandatory for all new code**: the modular TypeScript orchestrator (`src/.app/`, `src/modules/`, `src/shared/`) and the layered Java service (`application/`, `infrastructure/`, `shared/`; never `providers`, `modules` or `.app` in Java). Only an existing 0.1 project keeps its own layout, and the two are never mixed in one project. New projects include the functional Product CRUD by default; `--template empty` omits it. The [structure migration guide](/architecture/structure-migration) explains how to inspect an older project without moving its files.

## Why it exists

An assistant that knows only how other frameworks work will do what they do: expose a controller because it has `@Get`, disable a guard to get past a `401`, or invent a `pso` command. PSO's whole point is that exposure is explicit and security is deny-by-default, so the assistant has to know the rules *before* it edits your project.

## What it is made of

| Piece | Content |
|---|---|
| **Core rules** (always included) | identity and version, the exposure invariant, the working procedure, security rules, generation rules, validation, common mistakes, what does not exist |
| **Framework contexts** | official and legacy structures, orchestrator modules and routes, layered Spring Boot services, security, CLI generators, infrastructure, multiple FEIs, dispatch status, DevOps, documentation references |
| **Task contexts** | create an orchestrator / microservice / REST module, add a protected route or DTO, configure JWT, connect services, install dispatch, configure Docker, diagnose an error |
| **Project facts** (CLI only) | workspace services, modules, declared routes, installed features, extracted mechanically and treated as untrusted data |

Everything comes from the same sources as this portal: the CLI command registry, the diagnostic codes, the configuration schema and the list of what is **not** implemented are generated; the directory tables of the official structures are checked by a test against the conventions `@pso/core` enforces. So the context cannot describe a command that does not exist or a directory the validator refuses.

## How to use it

1. **Copy and paste.** Open the [context builder](/ai-context/builder), choose the scopes you need and copy the text into your assistant.
2. **Put it in the repository.** Run `pso ai:init`; it writes the files the common tools read ([Assistant files](/ai-context/assistant-files)) and fills them with project-specific facts.
3. **Point tools at files.** Use `llms.txt` and `llms-full.txt` ([LLM files](/ai-context/llms-files)) for tools that read those.

## Using it with common assistants

The instructions are vendor-neutral Markdown. Each tool has its own place for repository instructions:

| Tool | How |
|---|---|
| OpenAI Codex (and other agents that read `AGENTS.md`) | `pso ai:init --target agents` writes `AGENTS.md` at the workspace root |
| Claude Code | `pso ai:init --target claude` writes `CLAUDE.md` |
| GitHub Copilot | `pso ai:init --target copilot` writes `.github/copilot-instructions.md` |
| Anything else | copy the generic Markdown from the builder, or `pso ai:context --format markdown --output PSO_CONTEXT.md` |

Check each tool's documentation for how it loads these files; PSO only generates the content and does not assume every tool uses the same format.

## What it does for code generation

It makes the assistant prefer `pso make:*` generators, declare routes in `ROUTES.pso.ts`, keep guards and scopes, run `pso validate` and `pso security:check`, and refuse the shortcuts that would weaken security. It also distinguishes implemented Dispatch from unsupported features such as a TypeScript transactional outbox and delayed redelivery, so it does not invent an API. The [tutorials](/tutorials/first-application) and [integration decision guide](/reference/choosing-an-approach) give the assistant and developer concrete patterns to review together.

> [!NOTE]
> A context improves an assistant's odds; it does not replace review. Always run `pso validate` and the tests on generated changes.
