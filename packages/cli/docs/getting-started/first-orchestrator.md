---
title: First orchestrator
description: Generate the Node.js + TypeScript orchestrator in the modular structure, build and start it, and understand what its minimal entry point does at start-up and what its reference module answers before and after a service exists.
order: 8
keywords: [orchestrator, gateway, main.ts, bootstrap, health, modules, .app]
prerequisites: [A workspace, see First workspace]
related: [orchestrator/architecture, orchestrator/bootstrap, devops/logging, architecture/typescript-orchestrator]
---
## 1. Command

```pso-example
pso create workspace demo
cd demo
pso create orchestrator gateway
pso validate
```

## 2. What was created

Real output (verified), in a workspace that has no service yet:

```text evidence="verified"
$ pso create orchestrator gateway
created    .gitignore
created    README.md
created    docs/README.md
created    docs/api/products.collection.json
created    docs/reference-crud.md
created    package.json
created    src/.app/configs/.gitkeep
created    src/.app/contracts/.gitkeep
created    src/.app/decorators/.gitkeep
created    src/.app/filters/.gitkeep
created    src/.app/guards/jwt.guard.ts
created    src/.app/interceptors/.gitkeep
created    src/.app/middlewares/.gitkeep
created    src/main.ts
created    src/modules/.gitkeep
created    src/modules/products/MODULE.pso.ts
created    src/modules/products/contracts/product.contract.ts
created    src/modules/products/controllers/product.controller.ts
created    src/modules/products/dto/request/create-product.dto.ts
created    src/modules/products/dto/request/update-product.dto.ts
created    src/modules/products/dto/response/product-page.dto.ts
created    src/modules/products/dto/response/product.dto.ts
created    src/modules/products/mappers/product.mapper.ts
created    src/modules/products/providers/product.provider.ts
created    src/modules/products/routes/ROUTES.pso.ts
created    src/modules/products/services/product.service.ts
created    src/shared/.gitkeep
created    tests/app.test.ts
created    tests/products/product.mapper.test.ts
created    tests/tsconfig.json
created    tsconfig.json
registered "gateway" in pso.workspace.json (port 3000)
reference CRUD: module "products" bound to service "products" (no service serves /products yet: the first one created with the reference CRUD is bound automatically, or run pso crud:bind products --to <service>)
```

| Path | Purpose |
|---|---|
| `package.json` | scripts `build`, `dev` (build, then start with `.env` loaded if present), `start`, `typecheck`, `test`; dependencies `@pso/core`, `@pso/http`, `@pso/security` and `reflect-metadata`; `engines.node >=24` |
| `tsconfig.json` | decorators and metadata on, output to `dist`; includes `"src/.app/**/*"` because TypeScript skips dot-directories otherwise |
| `src/main.ts` | the whole entry point |
| `src/.app/guards/jwt.guard.ts` | `JwtGuard.create()`; the logic lives in `@pso/security` |
| `src/.app/configs/ contracts/ decorators/ filters/ interceptors/ middlewares/` | application-wide components, one directory per kind |
| `src/shared/` | reusable code that belongs to no single module |
| `src/modules/products/` | the reference CRUD module: routes, controller, service, provider, contract, DTOs, mapper ([file by file](/architecture/reference-crud)) |
| `docs/api/products.collection.json` | the module's requests for Studio, without credentials |
| `tests/` | `npm test` compiles and runs them |

`--template empty` creates the same project without the `products` module. Every directory of the structure exists from the start:
the empty ones (`src/.app/configs/`, `contracts/`, `decorators/`, `filters/`, `interceptors/`, `middlewares/`, `src/shared/`) hold a
`.gitkeep` so they survive version control, and the generators write into them (`pso make:middleware`, `make:filter`, ...).

`pso validate` passes and warns, because the module's service does not exist yet:

```text evidence="expected"
WARNING PSO_CRUD_UNBOUND orchestrators/gateway/src/modules/products/routes/ROUTES.pso.ts: Module "products" is bound to the service "products", which this workspace does not declare yet: its routes answer 502 (upstream not configured) until it exists.
        hint: Create it with `pso create service products` (the reference CRUD), or bind the module to an existing service: pso crud:bind products --to <service>
gateway: 12 resource(s), digest e010c0bcf740
OK
```

The first service created with the reference CRUD binds it (`pso create service catalog` prints `reference CRUD: orchestrator module
"products" was waiting for "products"; now bound to "catalog" (3 file(s) updated)`).

## 3. The entry point

```typescript title="orchestrators/gateway/src/main.ts"
import "reflect-metadata";
import { resolve } from "node:path";
import { bootstrap, log, shutdownOnSignals, StartupError } from "@pso/http";

bootstrap({ appDir: __dirname, workspaceFile: process.env["PSO_WORKSPACE"] ?? resolve(__dirname, "..", "..", "pso.workspace.json"), port: Number(process.env["PORT"] ?? 3000) })
  // SIGINT / SIGTERM: stop accepting, let running requests finish within http.shutdown.graceMs, release the dependents, exit 0.
  // The process is ended with exit code 1 only after app.shutdown.deadlineMs (grace period + cleanup time), never earlier.
  .then((app) => { shutdownOnSignals(app); })
  .catch((e: Error) => {
    log("error", "startup failed", { error: e.message, diagnostics: e instanceof StartupError ? e.diagnostics.map((d) => d.code) : undefined });
    process.exit(1);
  });
```

Line by line: `bootstrap()` does everything; the `.then` installs the shutdown handlers (on `SIGINT` or `SIGTERM`: stop accepting connections, let running requests finish within the grace period, release background work, exit 0; if that has not finished after the grace period plus the cleanup time, the process is ended with exit code 1: see [Runtime lifecycle](/concepts/runtime-lifecycle)); the `.catch` turns a start-up failure into one log line and a non-zero exit, so a process manager sees it.

## 4. What `bootstrap()` does

1. Reads the logging, limits and security configuration; an invalid value stops the start.
2. Detects the structure of the build (`dist/.app` and `dist/modules`; a build that mixes it with the 0.1 `dist/routes` is refused), discovers the modules and validates them with the same rules as `pso validate`.
3. Resolves providers and controllers and activates **only** the routes that the modules' `ROUTES.pso.ts` declare. Routes that call a service the workspace does not declare are activated and logged as a warning: they answer `502` until the service exists.
4. Opens the listener; the framework health endpoints are always served.

Details: [Bootstrap](/orchestrator/bootstrap).

## 5. Build and start

```powershell
cd orchestrators/gateway
npm install
npm run dev
```

The orchestrator is **compiled** (`tsc`) because decorators cannot run directly in Node. `npm run dev` builds and starts; `pso dev` does the same for the whole workspace, and `pso docker:up` runs it in a container with the rest of the workspace.

On a terminal you see lines like these (verified output from a real run of an orchestrator **without modules**, `--template empty`; with
the `products` module `routes=` and `modules=` count its six routes and one module; the logger is described in [Logging](/devops/logging)):

```text evidence="verified"
2026-11-08 14:54:30.517 INFO  [startup] starting orchestrator  service=gateway environment=development logLevel=info logFormat=pretty node=v24.18.0
2026-11-08 14:54:30.531 INFO  [security] security initialized (pem, ES256)
2026-11-08 14:54:30.537 INFO  [http] orchestrator listening  host=127.0.0.1 port=3000 routes=2 modules=0
```

When the output is not a terminal (a pipe, a file, CI) the same events are one JSON object per line.

## 6. Verify

```bash
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/products/options
curl -i http://127.0.0.1:3000/products
```

```text evidence="expected"
HTTP 200 application/json; charset=utf-8
{"status":"UP","upstreams":1}
```
*(expected shape; `upstreams` is the number of upstream services declared in the workspace)*

`/products/options` is public and answered by the orchestrator itself. `/products` without a token is `401` with
`application/problem+json`: the route exists, and the guard stopped the request before any service was called. An undeclared path is
`404` with `"code":"PSO_HTTP_NOT_FOUND"`.

## 7. Variations

| You want | Do |
|---|---|
| no example module | `pso create orchestrator gateway --template empty` |
| the module bound to a specific service | `--crud-service <service>`, or later `pso crud:bind products --to <service>` |
| another port | `PORT=4000 npm run dev` (and update `pso.workspace.json` so other tools agree) |
| more detail while developing | `PSO_LOG_LEVEL=debug npm run dev` |
| plain text without colour | `NO_COLOR=1 npm run dev` |
| the 0.1 layout (`src/routes/`) | `--structure legacy --template empty` |

## 8. Common mistakes

- Running `node src/main.ts`: it is not valid; use `npm run dev` or `pso dev`.
- Creating a second orchestrator: a workspace has exactly one public entry point.
- Forgetting `npm install`: `pso dev` reports `dependencies are not installed`; pass `--install` to let it run `npm install`.
- Removing `"src/.app/**/*"` from `tsconfig.json`: the guard is not compiled and start-up fails with an unknown guard.
- `startup failed ... diagnostics=["PSO_..."]`: the registry or security configuration is invalid. Run `pso validate` for the full message.

## Next steps

- [First microservice](/getting-started/first-microservice)
- [First endpoint](/getting-started/first-endpoint)
- [TypeScript orchestrator structure](/architecture/typescript-orchestrator)
