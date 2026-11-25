---
title: Structure compatibility and migration
description: How PSO recognises the 0.1 and the official structures, refuses projects that mix them, keeps 0.1 projects working, and plans (read-only) the migration of a project to the official structure with pso structure:inspect.
order: 6
status: implemented
keywords: [migration, legacy, 0.1, structure, compatibility, structure:inspect, mixed, PSO_STRUCTURE_MIXED, routes, modules]
related: [architecture/overview, infrastructure/migration, architecture/generators]
---
> [!STATUS]
> **Implemented and verified**: 0.1 projects validate, generate and run as before; mixed projects are refused by `pso validate`, the generators and the runtime; `pso structure:inspect` produces the migration plan of a 0.1 project. Moving the files is deliberately left to the project's owner: PSO never restructures application code on its own.

## How the structure is decided

| Project | Official structure | 0.1 structure |
|---|---|---|
| orchestrator | `src/.app/` or `src/modules/<m>/` with module files | `src/routes/<m>/` with module files, or component files in `src/guards/`, `src/middlewares/`, ... |
| Spring service | `application/rest`, `application/service`, `application/dto`, `application/mapper`, `infrastructure/`, `shared/` | `routes/`, `contracts/`, `ports/`, `adapters/`, `persistence/`, `events/`, `configs/`, `security/`, or classes directly in `application/` |

The files decide. A project may also state it (`"structure": "modular" | "layered" | "legacy"` for the project in `pso.workspace.json`);
files that contradict the statement are an error. A new project with no file yet follows the official structure. Empty `.gitkeep`
placeholders are not evidence.

A project with files of both structures is **refused** (`PSO_STRUCTURE_MIXED`) by `pso validate`, by every generator and, for the
orchestrator, by the runtime: conventions are never mixed silently.

## Planning a migration

```bash
pso structure:inspect                     # every project
pso structure:inspect --service gateway   # one project, --json for tools
```

For a 0.1 project it lists every file to move and where, the files whose relative imports, route declarations, module registrations or
Java package declarations change with it, and what needs a decision (a hexagonal port has no layered equivalent). Nothing is moved.

The report starts at the workspace level. A workspace whose projects are not in `orchestrators/`, `services/`, `frontends/` and
`frontends/modules/` (the 0.1 flat layout, still supported) gets the list of directory moves to the standard layout; PSO never moves a
project directory itself.

For a 0.1 orchestrator in a flat workspace (`pso create workspace shop --layout flat`) with one resource (`pso create orchestrator gateway --structure legacy`, then `pso make:resource product`):

```text evidence="verified"
$ pso structure:inspect --service gateway
workspace layout: flat (0.1: projects outside the standard directories; still supported)
  plan to the standard layout (inspection only: nothing is moved):
    move    gateway  ->  orchestrators/gateway   (orchestrator)
    move    catalog  ->  services/catalog   (service)
    update  pso.workspace.json: the "path" of 2 project(s)
    then    pso infra:apply (regenerates the compose files and environments from the new paths), pso validate
  Stop running processes first (pso dev, pso docker:down), commit, move the directories, edit the paths, then validate.
  note: .infra/ does not exist yet; pso infra:init creates it
gateway (node): legacy
  migration plan to the modular structure (inspection only: nothing is moved):
    move    src/contracts/product.contract.json  ->  src/.app/contracts/product.contract.json
    move    src/guards/jwt.guard.ts  ->  src/.app/guards/jwt.guard.ts
    move    src/routes/product/MODULE.pso.ts  ->  src/modules/product/MODULE.pso.ts
    move    src/routes/product/ROUTES.pso.ts  ->  src/modules/product/routes/ROUTES.pso.ts
    move    src/routes/product/product.controller.ts  ->  src/modules/product/controllers/product.controller.ts
    update  src/routes/product/MODULE.pso.ts: 2 relative import(s) re-pointed; module registration (controllers/providers imports)
    update  src/routes/product/ROUTES.pso.ts: 1 relative import(s) re-pointed; 1 route declaration(s)
    update  tsconfig.json: add "src/.app/**/*" to "include" (TypeScript skips dot-directories otherwise)
  5 file(s) to move, 3 file(s) whose imports, package declarations or registrations change. Back up first (commit), move, then pso validate and the project's tests.
```

To migrate: commit (or back up) the project, move the files as listed, fix the imports and package declarations it names, then
`pso validate` and the project's own tests. Endpoints, security and behaviour do not change: routes and rules are paths, not files.

## Limits

- `structure:inspect` plans; it never moves, rewrites or deletes a file.
- A hexagonal port (`ports/`) has no layered equivalent: the plan lists it as a decision, not a move.
- Imports written with path aliases or computed at runtime are not followed; `pso validate` and the compiler report what remains after
  the move.
