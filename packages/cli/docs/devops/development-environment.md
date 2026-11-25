---
title: Development environment
description: pso dev, the runtime registry, logs and Studio - what each does, a day-to-day workflow, and how to debug the environment itself.
order: 1
keywords: [pso dev, registry, health monitoring, studio, logs, smoke]
related: [concepts/runtime-lifecycle, getting-started/running, devops/studio, tutorials/local-debugging]
---
```bash
pso dev                      # everything
pso dev --only gateway       # a subset
pso dev --install            # run npm install where dependencies are missing
pso dev --smoke              # start, report, stop (useful in CI)
```

`pso dev`:

1. validates the workspace (refuses to start on errors);
2. checks that every port is free;
3. starts services **dependency-first**: Node services with `npm run dev` (compile + run), Spring services with `mvnw spring-boot:run`;
4. waits for each health endpoint, with `--timeout` seconds;
5. writes `.pso/registry.json` and mirrors service output to `.pso/logs/<service>.log`;
6. checks health every 5 seconds and logs `UP` / `DOWN` transitions (`[pso] <name> is now DOWN`);
7. on Ctrl+C stops everything in reverse order and kills the whole process tree.

A service may override its command in `pso.workspace.json`: `"dev": { "command": ["node", "server.js"] }` (an argument list, never a shell string).

Expected terminal output when everything is healthy (the layout is the command's; addresses are those of your workspace):

```text evidence="expected"
Starting 2 service(s)...

Ready:
  catalog            http://127.0.0.1:8081      READY/UP
  gateway            http://127.0.0.1:3000      READY/UP

Press Ctrl+C to stop.
```

## A day-to-day workflow

1. Start everything once: `pso dev` in one terminal.
2. Change a controller in the orchestrator: stop only the gateway and restart it (`Ctrl+C`, then `pso dev --only gateway`; the compile step runs again). The Spring service keeps running if you start it separately.
3. Change a Spring class: Spring needs a restart too (`spring-boot:run`); use your IDE's run configuration for fast cycles and keep `pso dev` for integration.
4. Before committing: `pso validate`, `pso security:check`, `pso test`.

Logs of each service are in `.pso/logs/<service>.log`; the orchestrator's are readable text on a terminal (colour only when attached to one) and JSON when redirected, so the file contains JSON lines. Read them with `Get-Content .pso\logs\gateway.log -Tail 20 -Wait`.

## Studio

```bash
pso studio
```

A read-only control center on the loopback interface, protected by a one-time token and a Host check: overview with verified health and service topology, services, routes with policy, module explorer, security, observability (scrubbed logs), diagnostics and environment settings. It reads real files and probes real endpoints. See [PSO Studio](/devops/studio).

## Other inspection commands

`pso services:health`, `pso services:graph`, `pso graph`, `pso routes:inspect <route id or path>`, `pso inspect --service <name>`. Verified examples are on [Service registration](/microservices/service-registration) and [Structural discovery](/concepts/structural-discovery).

## When the environment misbehaves

| Symptom | Check |
|---|---|
| `pso dev` exits immediately | the first line says why: validation failure, port in use, missing dependencies |
| one service never becomes ready | `.pso/logs/<service>.log`; for Spring the active profile and `PSO_JWT_*` |
| a service is `DOWN` after being `UP` | it crashed or its health path stopped answering: the log tells; `pso dev` reports, it does not restart |
| orphan processes after a crash | `pso dev` kills process trees on exit; if the terminal was force-closed, find leftover `java`/`node` processes by their port before starting again (do not kill processes you do not recognise) |
| the registry file is stale | it is rewritten every 5 seconds while `pso dev` runs; delete `.pso/` if it is left over |

## Common mistakes

- Running `pso dev` from outside the workspace (it looks upward for `pso.workspace.json`).
- Expecting hot reload: restart the affected service.
- Committing `.pso/`.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `pso dev` refuses to start | a port is already used, or two services share one | the message before anything starts | free the port or change it in `pso.workspace.json` |
| a Spring service starts and exits | JWT settings are missing | its log: `pso.security.jwt.jwks-uri is required` | set `PSO_JWT_JWKS_URI` for Spring services |
| logs are not coloured | output is redirected, `NO_COLOR` is set, or `CI` is set | `echo $NO_COLOR` | unset them, or set `PSO_LOG_COLOR=always` |
| a service shows `DOWN` in `pso services:health` | it is not running or its health path is wrong | the URL printed | start it or fix `health` |

See [Logging](/devops/logging) for colour and format controls.

## Next steps

- [Running the environment](/getting-started/running)
- [Diagnose a local workspace](/tutorials/local-debugging)
