---
title: Deployment and pipeline declarations
description: The DEPLOYMENT.pso.ts and PIPELINE.pso.ts files, what each field means and why they are read as data and never executed.
order: 5
status: implemented
keywords: [defineDeployment, definePipeline, DEPLOYMENT.pso.ts, PIPELINE.pso.ts, declarative, strategy, health, secrets, trust]
related: [cloud/environments, cloud/deploy-a-release, cloud/pipelines-and-policy, concepts/declarative-architecture]
---
Deployment follows PSO's declarative idea: you describe the intended result in a typed file, PSO validates and explains it, then applies it. Declarations live in `deploy/<environment>.deployment.pso.ts` and `deploy/<name>.pipeline.pso.ts` (or `DEPLOYMENT.pso.ts` / `PIPELINE.pso.ts` at the workspace root).

```ts
import { defineDeployment } from "@pso/deploy";

export default defineDeployment({
  name: "shop",
  environment: "production",
  connection: { provider: "ssh", credentials: "prod" },          // the NAME of a connection, never a secret
  source: { provider: "git", url: "https://git.example.com/shop.git", branch: "main" },
  service: {
    name: "web", runtime: "node",
    build: [["npm", "ci"], ["npm", "run", "build"]],               // argv arrays: no shell strings
    start: ["node", "dist/main.js"],
    health: { readyPath: "/health/ready", timeoutSeconds: 60 },
    shutdownGraceSeconds: 30,                                       // the application's real shutdown time
    route: { path: "/" },
    secrets: { DB_PASSWORD: "shop-db-password" },                   // env var -> NAME of a server secret
  },
  strategy: { type: "blue-green", proxy: "nginx", rollback: true, drainSeconds: 10 },
  proxy: { nginx: { domains: ["shop.example.com"], listen: { http: 80 } } },
  pipeline: "production",
});
```

## Why they are read as data

Importing a TypeScript file runs it. If merely *inspecting* a project executed its code, cloning an untrusted repository and opening Studio would run that repository's code. So PSO parses the file and evaluates **literal data only**: objects, arrays, strings, numbers, booleans, `null`. A function call, a variable, `process.env` or a spread is an error (`PSO-DEC-STATIC`). Secrets are therefore referenced by name and cannot be computed; a value that looks like a credential is rejected (`PSO-DEC-SECRET`).

## The pieces

| Field | Purpose |
|---|---|
| `source` | `git` (url plus exactly one of `branch`, `tag`, 40-character `commit`; `credentials` names a server secret) or `artifact` (a path, optional `sha256`) |
| `service` / `services` | `runtime` (`node`, `java`, `command`), `dir` inside the source, `build`, `start`, `port`, `internalPort`, `health`, `env`, `secrets`, `shutdownGraceSeconds`, `instances`, `resources`, `requires`, `dependsOn`, `consumes`/`contract` |
| `strategy` | `blue-green`, `rolling` or `recreate`; proxy, rollback, drain, retention |
| `proxy.nginx` | domains, layout, listen ports, TLS file paths, WebSocket |
| `migrations` | `none` or `expand-contract` with an owner service, a command, and an explicit destructive flag |
| `pipeline` | the name of a pipeline declaration |

`{port}` and `{release}` in `start` and `build` are substituted. `{service:catalog.url}` inside `env` values resolves to the loopback address of that service in the same deployment.

```bash
pso pipeline:validate production
```

Validation is static: no server is contacted and no project code runs. Hooks and custom pipeline stages are the one place project-controlled commands can run, and only when the server policy allows them (see [Pipelines and policy](/cloud/pipelines-and-policy)).

## What can go wrong

- *`blue-green needs a reverse proxy`*: PSO will not quietly turn a zero-downtime request into `recreate`. Declare `proxy: "nginx"`, or choose `recreate` with `downtimeAcknowledged: true`.
- *`rolling needs at least 2 instances`*: one instance cannot stay available while it is replaced.
- *`credentials must not be embedded in the repository URL`*: use `credentials: "<secret name>"`; the token reaches git through its environment, never an argument or URL.
- A branch is resolved to a commit when you **plan**; the plan records the commit. Writing `commit` pins it in the declaration itself.
