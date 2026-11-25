---
title: Quick start
description: From an empty folder to a secured two-tier application with a working Product CRUD in a few commands, with the real output of each step and what to do next.
order: 6
keywords: [tutorial, quickstart, crud, make:module, make:route, validate, routes:list]
prerequisites: [The pso command is installed, "Node.js 24 and a JDK 21+", "Docker to run it"]
related: [getting-started/first-workspace, getting-started/first-endpoint, getting-started/running, tutorials/first-application, architecture/overview]
---
These commands are executed by the documentation test suite, so they are known to work with PSO Web {{version}}.

This quick start has two checkpoints. **First, declare and inspect the application** with the commands below; this works without starting
anything. **Then, run and call it.** Keeping those checkpoints separate makes a failed declaration easier to tell apart from a process,
database or token problem.

The workspace gets the reference **Product CRUD** (a Spring service with PostgreSQL and the orchestrator module that calls it) and one
public route of your own, `GET /reports/summary`.

```pso-example
pso create workspace shop
cd shop
pso create service catalog
pso create orchestrator gateway
pso make:module reports --service gateway
pso make:controller reports --service gateway
pso make:route reports summary --method GET --path /summary --public --service gateway
pso validate
pso routes:list
pso security:policy
pso security:keys --generate
pso config:validate
pso docker:init
pso deploy:plan --target compose
```

![The quick-start commands rendered as a terminal block, with each command visually separated and a copy button](@/assets/screenshots/quick-start-commands.png)

*The screenshot shows how commands appear in the portal. Copy the text block above to run them; the screenshot is a visual aid, not a separate instruction.*

## What each step printed

The blocks below distinguish captured **Verified output** from **Expected output** of a real run of the same commands. File lists are
abridged, and digests and key ids vary between workspaces; read each block's badge before comparing it with your terminal.

**Workspace**

```text evidence="verified"
$ pso create workspace shop
created    .gitignore
created    .infra/.gitignore
created    README.md
created    docs/README.md
created    frontends/modules/.gitkeep
created    orchestrators/.gitkeep
created    pso.workspace.json
created    services/.gitkeep
created    shared/README.md
created    tests/README.md
```

**Service and orchestrator**

```text evidence="expected"
$ pso create service catalog
created    pom.xml
created    src/main/java/com/pso/catalog/Application.java
created    src/main/java/com/pso/catalog/application/rest/ProductController.java
created    src/main/java/com/pso/catalog/application/service/ProductService.java
created    src/main/java/com/pso/catalog/infrastructure/entity/ProductEntity.java
created    src/main/resources/db/migration/V1__create_products.sql
created    src/test/java/com/pso/catalog/application/rest/ProductControllerTests.java
...
registered "catalog" in pso.workspace.json (port 8081)

$ pso create orchestrator gateway
created    docs/api/products.collection.json
created    src/.app/guards/jwt.guard.ts
created    src/main.ts
created    src/modules/products/MODULE.pso.ts
created    src/modules/products/providers/product.provider.ts
created    src/modules/products/routes/ROUTES.pso.ts
...
registered "gateway" in pso.workspace.json (port 3000)
reference CRUD: module "products" bound to service "catalog" (the service of this workspace that serves /products)
```

**A module of your own**

```text evidence="expected"
$ pso make:module reports --service gateway
created  src/modules/reports/MODULE.pso.ts
created  src/modules/reports/routes/ROUTES.pso.ts

$ pso make:controller reports --service gateway
updated  src/modules/reports/MODULE.pso.ts
created  src/modules/reports/controllers/reports.controller.ts

$ pso make:route reports summary --method GET --path /summary --public --service gateway
updated  src/modules/reports/controllers/reports.controller.ts
updated  src/modules/reports/routes/ROUTES.pso.ts
```

**Validation, the route table and the policy**

```text evidence="expected"
$ pso validate
catalog: 12 resource(s), digest f4307ea2aac8
gateway: 15 resource(s), digest 2b3fafdc5596
OK

$ pso routes:list
GET     /products                products.list           -> catalog        guard:jwt
POST    /products                products.create         -> catalog        guard:jwt
DELETE  /products/:id            products.remove         -> catalog        guard:jwt
GET     /products/:id            products.find           -> catalog        guard:jwt
PUT     /products/:id            products.update         -> catalog        guard:jwt
GET     /products/options        products.options                          public
GET     /reports/summary         reports.summary                          public

$ pso security:policy
default: deny
GET     /products                guarded:jwt scopes=[products:read]  -> catalog
POST    /products                guarded:jwt scopes=[products:write]  -> catalog
GET     /products/options        public  -> (orchestrator)
GET     /reports/summary         public  -> (orchestrator)
service catalog: deny by default
```

Note the path of your route: the controller prefix is `/reports`, so the action `@Get("/summary")` is reachable at `/reports/summary`.
Reading is `products:read`, every write is `products:write`; only `/products/options` and your summary are public.

## What happened, step by step

1. `create workspace` made `shop/pso.workspace.json`, the registry of the system.
2. `create service` generated a Spring Boot service in the layered structure on port 8081: the Product API, its Flyway migration, tests
   with an embedded PostgreSQL, deny-by-default security and a JWT resource server. It declares that it needs PostgreSQL; PSO provisions
   the database when you start it.
3. `create orchestrator` generated the modular orchestrator on port 3000 with the `products` module and bound it to `catalog`, the
   service of this workspace that serves `/products`.
4. `make:module`, `make:controller` and `make:route` created your `reports` module; its files stay consistent with each other.
5. `validate` checked the structure, the modules, the routes and their security without running any code.
6. `security:keys --generate` created a signing key pair (verified output: `generated k-20261108-21b1a884 (ES256); private key: keys\k-20261108-21b1a884.private.pem (owner-only ACL applied); public JWKS: keys\jwks.json`). Its ids are specific to the run.
7. `docker:init` wrote Docker files for a plain Compose deployment; `deploy:plan` showed the steps without applying them. For local
   development `pso docker:up` uses the infrastructure engine instead (below).

A product request has four explicit hand-offs:

| Hand-off | File or command that proves it | What a failure looks like |
|---|---|---|
| Public URL and policy | `orchestrators/gateway/src/modules/products/routes/ROUTES.pso.ts`; `pso routes:list` | an undeclared path is `404`; a missing token is `401` |
| Validation and the call | `controllers/product.controller.ts`, `providers/product.provider.ts`; `pso routes:inspect /products` | an invalid body is `400` before anything is called; a stopped service is `503` |
| Spring handler and policy | `catalog/.../application/rest/ProductController.java` | Spring checks the token again and can return `401` or `403` independently |
| Data | `ProductService`, PostgreSQL | a duplicate SKU is `409`; an unknown id `404` |

Your reports route stops at the orchestrator: it is public because `ROUTES.pso.ts` says so, not merely because the controller has a
`@Get` decorator.

## Directory structure you now have

```tree title="The workspace at the end of the quick start"
shop/
  pso.workspace.json  # generated: updated by every create command
  orchestrators/gateway/
    src/.app/guards/jwt.guard.ts  # generated
    src/modules/products/  # generated: the reference CRUD module
    src/modules/reports/
      MODULE.pso.ts  # generated
      routes/ROUTES.pso.ts  # generated
      controllers/reports.controller.ts  # generated
    docs/api/products.collection.json  # generated: the Studio requests
  services/catalog/
    src/main/java/com/pso/catalog/
      application/  # generated: rest, service, dto, mapper
      infrastructure/  # generated: entity, persistence
      shared/  # generated: exception, validation
    src/main/resources/db/migration/V1__create_products.sql  # generated
  keys/  # generated by security:keys: index.json, jwks.json and a key pair
  docker-compose.yml  # optional: written by docker:init
  .env.example  # optional: written by docker:init
```

> [!NOTE]
> The generated workspace `.gitignore` starts with `node_modules`, `dist`, `target` and `.pso/`. The first `pso security:keys --generate` appends `keys/*.private.pem` to it (verified), so the private key is not committed by accident. The public files (`jwks.json`, `*.public.pem`, `index.json`) are meant to be committed.

## Run it

```powershell
pso infra:init --identity keycloak --runtime docker --users "ana,bob:products:read"
pso docker:up --vendor
pso studio
```

`infra:init` declares the local environment in `pso.infra.json`: Docker, Keycloak and two development users (`ana` holds every
scope the routes declare, `bob` only `products:read`); without it the local environment runs processes and has no identity provider.
`--vendor` copies the PSO packages and Java artifacts the images need into the projects (an installed CLI references them on this
machine, which an image build cannot reach); later starts without a rebuild do not need it. `docker:up` provisions PostgreSQL (its password generated into `.infra/`, never into source),
Keycloak, `catalog`, `gateway` and the edge (`https://api.pso.localhost:8443`), and waits until each is healthy. In Studio's API client the **reference requests** of the `products`
module create, list, update and delete products through the orchestrator with the development user. Without a token every products
request except `/options` is `401`. The [reference CRUD page](/architecture/reference-crud) shows the real requests and answers, and
[Running the environment](/getting-started/running) the other ways to start (including `pso dev` without Docker).

## If something goes wrong

| What you see | Meaning | Fix |
|---|---|---|
| `error: Invalid route "C:/Program Files/Git/summary"` | Git Bash rewrote `/summary` | use PowerShell, or `MSYS_NO_PATHCONV=1` |
| `pso validate` prints diagnostics and `FAILED` | a structural rule broke | read the code (`PSO_ROUTE_*`, `PSO_MODULE_*`) in [diagnostics](/reference/diagnostics) |
| `port 8081 is already in use` | another process holds it | change the port in `pso.workspace.json` or at creation with `--port` |
| `docker:up` stops before starting anything: Docker is not reachable | the engine is stopped | start Docker Desktop (or the daemon) and retry |

## Next steps

- [First endpoint](/getting-started/first-endpoint): requests, responses and logs.
- [Application architecture](/architecture/overview): why the orchestrator and the service are structured differently.
- [Your first application](/tutorials/first-application)
