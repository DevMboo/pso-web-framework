---
title: Pretty logs or structured JSON?
description: Which log format to use where - a person reading a terminal, a machine reading a stream, or both - and the rules PSO applies by default.
order: 38
keywords: [decision, logging, json, pretty, structured, ecs, color, ci, production]
related: [devops/logging, devops/observability, decisions/dev-or-production-config]
---
## The question

Should the service print readable lines or JSON objects?

## The short answer

| | Pretty | Structured JSON |
|---|---|---|
| Reader | a developer at a terminal | a log shipper, a search system, an alert |
| Strength | scannable at a glance, coloured by level | exact fields, queryable, no parsing guesses |
| Weakness | brittle to parse; colour codes are noise in files | hard to read raw |
| PSO default | when stdout **is a terminal** | when stdout is a pipe, a file or CI |

You rarely need to choose by hand: the orchestrator picks `pretty` on a terminal and `json` otherwise. Spring services use the console pattern locally and Spring Boot's ECS JSON in the `prod` and `staging` profiles.

## Decision flow

1. **Developing locally in a terminal?** Pretty. Add `PSO_LOG_LEVEL=debug` for detail.
2. **Running in a container, a VM service or CI?** JSON. Set `PSO_LOG_FORMAT=json` explicitly in the orchestrator's environment so the choice does not depend on whether a terminal is attached.
3. **Pasting logs into an issue or documentation?** Pretty with `NO_COLOR=1` or `PSO_LOG_COLOR=never`, so no escape codes get copied.
4. **Investigating one instance in production?** Raise the level on that instance for a short time; do not switch the whole fleet to pretty.

## Consequences

- **Colour.** JSON never contains colour codes. Pretty colours only a real terminal that is not CI and not `TERM=dumb`; `NO_COLOR` turns it off and `FORCE_COLOR` forces it.
- **Secrets.** Both formats go through the same redaction (tokens, credentials, secrets in text and keys). Redaction is a safety net, not a licence to log them.
- **Correlation.** The correlation id is a field in JSON and a `(id)` marker in pretty lines; `grep` for it either way.
- **Volume.** Format does not change volume; the level does. The per-request `INFO` line is the main source: use `warn` plus metrics when traffic is high.

## What `pso dev` does for you

`pso dev` pipes each service's output (so it can also write `.pso/logs/<service>.log`), which would normally make every service print plain text. When `pso dev` itself runs in a terminal it therefore asks Spring services for colour, re-formats the orchestrator's JSON lines into the pretty form with a coloured level, gives each `[service]` prefix its own colour, and writes the **log files without colour codes and with the orchestrator's JSON intact**. So the choice above applies to the files too: they stay machine-readable while the terminal stays readable. `NO_COLOR=1` or `PSO_LOG_COLOR=never` turns the colour off. The behaviour is covered by `dev-color.test.ts`; see [Logging](/devops/logging).

## Anti-patterns

- Parsing pretty output with regular expressions in a pipeline.
- Leaving production on `debug`.
- Logging bodies or tokens "temporarily".
- Mixed formats in one stream (one service pretty, another JSON) when you search across them.

## Related

[Logging](/devops/logging) · [Observability](/devops/observability) · [Environment variables](/reference/environment-variables)
