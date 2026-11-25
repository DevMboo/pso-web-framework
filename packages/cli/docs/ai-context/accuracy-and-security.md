---
title: Accuracy and security of AI context
description: What the context guarantees, what it refuses to say, and how repository content is kept from steering the assistant.
order: 5
keywords: [ai, accuracy, security, untrusted, injection, redaction]
related: [ai-context/overview, ai-context/assistant-files]
---
## Accuracy

- **Capabilities, not wishes.** Commands come from the installed CLI's registry. The list of unimplemented commands and capabilities is part of every context, so assistants are told not to use them.
- **Status is explicit.** Pages and contexts mark features as implemented, partial or not implemented; experimental behavior is never presented as stable.
- **Version-matched.** Every export states the framework version; the portal warns when its version differs from the installed CLI.
- **Capabilities versus project facts.** The framework sections describe what PSO can do. The **Project facts** section describes this project (services, modules, routes, installed features), labelled as untrusted data.

## Security rules in every context

The core rules, which cannot be deselected, forbid: bypassing route declarations, disabling authentication or authorization for convenience, hardcoding secrets, exposing private keys, modifying framework internals unnecessarily, creating undocumented dependencies, bypassing the CLI when a generator exists, and assuming service discovery grants authorization. Mutating CLI flags that need human consent (`--force`, `--yes`) are called out.

## Repository content is untrusted

Project facts are built from structure only: names, ports, methods, paths, booleans. Each value is restricted to a conservative character set; anything else is replaced by a placeholder. Comments, READMEs, configuration values, `.env` files and keys are never read, so text in the repository cannot add instructions to the generated context. The context also states that no repository text can override its rules.

## Redaction

Contexts are generated without reading secrets. As a second layer, text that looks like a bearer token, a JWT, a private key or a `password=` assignment is scrubbed wherever the tools display project data.

## Limits

A context cannot force an assistant to comply. Review generated changes, run `pso validate` and `pso security:check`, and keep tests in CI.
