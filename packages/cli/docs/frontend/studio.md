---
title: The Frontend view in PSO Studio
description: What the Frontend section of PSO Studio shows for the FEI and MEIs of a workspace (read-only by default) and the opt-in operations (validate, build, development servers, local publish and rollback) behind pso studio --frontend-ops.
order: 9
status: partial
keywords: [studio, frontend, fei, mei, graph, route ownership, contract, ports, read-only]
related: [frontend/overview, frontend/declarations, frontend/releases]
---
> [!STATUS]
> **Implemented and verified in a real browser**: the read-only view (14 of 14 checks including an axe scan with no WCAG 2 A/AA violations) and the opt-in operations of `pso studio --frontend-ops` (12 of 12: validate, build, development servers, local publish and rollback, the table of active releases on the local site root). **Not exercised:** Studio's Cloud section with a deployed static resource; remote frontend deployments are listed by `pso release:status` and `pso release:history`.

Open Studio from the workspace (`pso studio`) and choose **Frontend**. Studio keeps its existing boundaries: it listens on loopback only, requires its access token, and the local workspace is read-only. The Frontend view uses the same analysis as `pso validate` and `pso frontend:validate`, so it cannot disagree with them, and it does not contain a second implementation of any command.

## What it shows

- **Relationships**: the FEI, each registered MEI with its mount path, development port and entry scopes, and the orchestrator they all reach through. A MEI that names a host but is not registered is marked.
- **Development servers**: whether something answers on each declared port right now (a short TCP probe; it says nothing about the health of what answers).
- **Status**: validation result, number of microfrontends and effective routes, the middleware order, the authentication mode, and whether each project's generated orchestrator contract matches the orchestrator.
- **Route ownership**: every effective browser route, which project owns it, its page or redirect and the scopes it needs.
- **Diagnostics**: the findings of `pso frontend:validate` with the exact file and a fix.
- **Operate from the CLI**: the commands for dev, build, publish, rollback and releases.

**Re-validate** re-reads the declarations and shows the new result; it changes nothing.

## Why there are no start and stop buttons

## Operations (opt-in)

By default the view is read-only, like the rest of local Studio. Start Studio with `pso studio --frontend-ops` and the view gains an **Operations** panel: **Validate**, **Build** (one project or all, with a base path), **Start dev servers**, **Stop**, **Restart**, **Publish to local site** and **Roll back on local site**, with the output of the last operation, the development-server log and a table of the releases that are active on the local site root.

Nothing in Studio implements these actions. Each one runs the same command a developer would type (`pso frontend:validate`, `pso frontend:build`, `pso frontend:dev`, `pso frontend:publish`, `pso frontend:rollback`) in the workspace, so the same validation, build, signature, compatibility and rollback code applies, and the same output is shown.

Boundaries that stay in force:

- Studio listens on loopback only and needs the access cookie from the URL it printed. A state-changing request must also come from the same origin with the `x-pso-studio` header and a JSON body, exactly like the Cloud operations.
- A project argument can only be a project of this workspace. Base paths are checked against the same grammar as the CLI. Nothing the browser sends is used as a command line or a path.
- **Publish** and **Roll back** write only into `.pso/studio-site` inside the workspace and require a typed confirmation (`publish mei-customers`, `rollback mei-customers`): the action and the project. A wrong or missing confirmation changes nothing.
- One operation runs at a time (a second request gets a 409). Output is bounded and scrubbed of anything that looks like a secret. Development servers started from Studio are stopped when Studio closes.
- Deploying to a server and rolling back there are not done from this panel: a frontend declared with `pso frontend:declare` is an ordinary deployment, so its plan, approval, deploy, active release and history are in the **Cloud** section (and `pso release:status`, `pso release:history`, `pso release:rollback`), with that section's roles and confirmations. Studio keeps no credentials of its own.

## Limits and troubleshooting

- A port shown as "not running" may be a different tool's port: the probe checks reachability only.
- Contract state is "orchestrator not analyzable" when the orchestrator's own routes do not validate; fix `pso validate` first.
- The view reads project files; after changing a declaration press **Re-validate**.
- Release versions per environment appear in `pso frontend:releases --site <dir>`, not in Studio.
