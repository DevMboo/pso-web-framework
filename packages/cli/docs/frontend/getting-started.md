---
title: Create a shell and microfrontends
description: The developer workflow end to end: generate the FEI and three MEIs with the CLI, register them, develop one MEI alone, run the whole ecosystem, validate, build and publish independently.
order: 2
status: implemented
keywords: [create fei, create mei, register, frontend dev, standalone, build, publish, workflow]
related: [frontend/overview, frontend/declarations, frontend/releases, frontend/troubleshooting]
---
> [!STATUS]
> **Implemented and verified.** This exact sequence was run with the public CLI against a scratch workspace (install, typecheck, tests, builds all passing) and against the Commerce fixture. Timings on a development machine: `npm install` about 10 to 20 s per project, a production build 2 to 5 s per project.

You need a workspace with an orchestrator, because a frontend talks only to it.

```bash
pso create workspace shop
cd shop
pso create orchestrator shop-gateway
pso create fei shop --install
pso create mei customers --register --install
pso create mei catalog --register --install
pso frontend:graph
```

`create fei` and `create mei` generate a complete project under `frontend/`, register it in `pso.workspace.json` (name, kind, path, development port), vendor the framework packages next to it (so it builds without access to the framework checkout) and, with `--install`, run `npm install`. Ports are 4200 for the shell and 9000, 9001, ... for microfrontends; `--port` overrides.

`--register` also lists the new MEI in the FEI. Without it, `pso frontend:validate` reports `PSO_MEI_NOT_REGISTERED` with the exact command to run (`pso fei:register customers`). Registration adds an entry to `FEI.pso.ts` (mount path `/customers`, entry scopes `customers:read`) and checks the relationship in both directions.

## Develop one microfrontend alone

```bash
pso frontend:dev --standalone customers
```

The MEI starts on its own port with the **development host adapter**: a stand-in for the shell that provides the same context contract (user, scopes, `api`, `channels`, `notifications`, `navigate`) and a form to paste a development token (`pso idp:dev token --scopes customers:read`). The adapter exists only in the standalone entry and refuses to run in a production build. Requests go to your orchestrator through a dev-server proxy at `/api`.

## Run everything together

```bash
pso frontend:dev
```

Starts the shell and every registered MEI on their declared ports, wires the shell's development runtime configuration to the MEI dev servers, and proxies `/api` to the orchestrator (`PSO_ORCHESTRATOR_URL`, default the workspace orchestrator's port). A port that is already in use stops the start with the name of the project and the port.

## The loop

1. Change `src/pages` in one MEI. Hot updates apply without touching the others.
2. `pso frontend:validate` checks declarations, relationships, route ownership, conflicts, contract compatibility and the architecture rules (no router in a MEI, no absolute URL in `fetch`).
3. `npm test` inside the project runs its own tests.
4. `pso frontend:build customers --base-path /app/` builds that one project; a MEI also gets its release manifest.
5. `pso frontend:publish customers --site <dir>` publishes it without rebuilding the shell (see Releases).

## Common mistakes

- Running `npm install` before the vendored packages exist. Generate projects with the CLI; do not copy a project by hand.
- Updating the framework and rebuilding only some projects. The vendored copy is part of each build: after a framework update run `pso frontend:install` and rebuild.
- Expecting `/api` to exist in `pso frontend:dev --standalone` without a running orchestrator. The page shows a gateway-timeout error with a correlation id, which is the intended failure mode.
- On Git Bash for Windows, arguments such as `/shop/` are rewritten to Windows paths. Set `MSYS_NO_PATHCONV=1` for the command.
