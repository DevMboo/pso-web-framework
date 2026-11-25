---
title: First workspace
description: Create the pso.workspace.json that declares your services - fields, validation rules, how to adopt existing projects, and what to do when it is wrong.
order: 7
keywords: [workspace, pso.workspace.json, init, ports, dependsOn]
related: [concepts/path-structure-working, getting-started/first-orchestrator, microservices/service-registration]
---
A workspace is a folder with a `pso.workspace.json`. It is the registry of your system in development: which services exist, which port each uses and what depends on what. Services are **declared** here; PSO never discovers them by scanning directories.

## 1. Command

```pso-example
pso create workspace my-platform
cd my-platform
pso validate
```

## 2. What happened

Real output (verified):

```text evidence="verified"
$ pso create workspace my-platform
created    .gitignore
created    README.md
created    pso.workspace.json

$ pso validate
OK
```

```tree title="After pso create workspace my-platform"
my-platform/
  pso.workspace.json  # generated: the map of your services, empty for now
  README.md  # generated
  .gitignore  # generated: node_modules, dist, target, .pso/ and keys/*.private.pem
```

An empty workspace is valid. Every other command (`create`, `make:*`, `routes:list`, `dev`) finds the workspace by looking for `pso.workspace.json` in the current folder and its parents.

## 3. The file after adding an orchestrator and a service

:::include file="examples/workspace/pso.workspace.json" title="pso.workspace.json (after adding an orchestrator and a service)"

You never have to write it by hand: `pso create orchestrator gateway` and `pso create service catalog` add their entries and print `registered "<name>" in pso.workspace.json (port N)`.

## 4. The fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Currently `1`. Another version is rejected (`PSO_SCHEMA_VERSION`) instead of being guessed. |
| `services[].name` | kebab-case, unique. |
| `services[].path` | folder of the project, relative to the workspace; it cannot leave it (`PSO_SERVICE_PATH`). |
| `services[].runtime` | `node` or `spring-boot`. |
| `services[].role` | `orchestrator` is the single public entry point (exactly one per workspace); everything else is a `service`. |
| `services[].port` | Unique, 1024 to 65535. Duplicates fail validation (`PSO_PORT_CONFLICT`). |
| `services[].prefix` | endpoint prefix of a Spring service (`/catalog`), applied once by PSO ([service prefix](/spring/service-prefix)). |
| `services[].dependsOn` | Start-up order. Cycles and unknown names fail validation. |
| `services[].health` | Path probed by `pso dev` and `pso services:health`. |
| `services[].db` | `postgres` when the service owns a database. |

## 5. Variations

**You already have projects.** Run `pso init` in the folder that contains them. It builds the file from the Node and Spring projects it finds (it is the one command that looks around, once, and writes what it found so that nothing scans afterwards):

```bash
cd existing-system
pso init
pso services:list
```

**You want another port.** Pass `--port` when you create a service, or edit the file and run `pso validate`:

```bash
pso create service orders --port 8090
```

**A service depends on another** (it should start second). Declare an existing project with its dependencies, or edit `dependsOn`:

```bash
pso services:register billing --port 8090 --runtime spring-boot --depends-on catalog
```

See the order with `pso services:graph`:

```text evidence="expected"
$ pso services:graph
startup order: catalog -> gateway
```
*(expected output)*

## 6. What can go wrong

| Message | Cause | Fix |
|---|---|---|
| `No pso.workspace.json found in ... or any parent` | you are outside a workspace | `cd` into it, or create one |
| `PSO_PORT_CONFLICT` | two services share a port | change one |
| `PSO_SERVICE_PATH` | a path leaves the workspace (`../x`) | keep projects inside it |
| `PSO_SCHEMA_VERSION` | `schemaVersion` is not `1` | set it to `1`; another version was written by a different tool |
| a BOM at the start of the file | edited with a tool that adds one | PSO tolerates it; keep UTF-8 anyway |

Recovery is always the same: fix the file, run `pso validate`, read the first diagnostic, repeat.

## 7. Good practice

- Commit `pso.workspace.json`. It is the shared definition of the system.
- Keep ports stable: other files (Docker Compose, docs) refer to them.
- Do not put secrets in it. It is for structure.

## Next steps

- [First orchestrator](/getting-started/first-orchestrator)
- [First microservice](/getting-started/first-microservice)
- [Service registration](/microservices/service-registration)
