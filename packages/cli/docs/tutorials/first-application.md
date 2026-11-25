---
title: Build your first application
description: Create a workspace, a Java microservice and a TypeScript orchestrator with the reference Product CRUD, start them with PostgreSQL and the identity provider, call the API, then generate a second resource the same way.
order: 1
keywords: [tutorial, first application, workspace, gateway, service, crud, products, make:crud]
related: [getting-started/requirements, getting-started/running, architecture/overview, architecture/reference-crud, orchestrator/routes]
---

A PSO workspace contains one public orchestrator and any number of microservices. The orchestrator owns the public API; each
microservice owns its data. New projects start with a **working Product CRUD** in both, so the first thing you run is a complete,
secured, database-backed API, not an empty skeleton.

| Checkpoint | What you should know before moving on |
|---|---|
| After generation | `pso.workspace.json` names both projects; the orchestrator's `products` module is bound to `catalog` |
| After `pso validate` | PSO accepts the structure, the routes and their security, without running any code |
| After `pso docker:up --vendor` | PostgreSQL, the identity provider, `catalog` and `gateway` are running and healthy |
| After the requests | a token with `products:write` creates a product; without one the orchestrator answers 401 before calling anything |

## Prerequisites

Install the requirements in [Requirements](/getting-started/requirements): Node.js 24, Java 21 and Docker for the database and the
identity provider. Run these commands from a directory where you want a new `shop` folder.

```pso-example
pso create workspace shop
cd shop
pso create service catalog
pso create orchestrator gateway
pso validate
pso routes:list
pso routes:inspect /products
```

`create service` writes a layered Spring Boot service with the Product API, its Flyway migration and its tests, and declares that it
needs PostgreSQL. `create orchestrator` writes the modular orchestrator with the `products` module and binds it to `catalog`, the
service of this workspace that serves `/products`. The [reference CRUD page](/architecture/reference-crud) lists every file.

```tree title="What was generated (main files)"
shop/
  pso.workspace.json  # generated: the projects, their ports and roles
  services/catalog/
    src/main/java/com/pso/catalog/
      application/rest/ProductController.java  # generated: HTTP, validation, scopes
      application/service/ProductService.java  # generated: transactional operations
      infrastructure/entity/ProductEntity.java  # generated: the JPA entity
    src/main/resources/db/migration/V1__create_products.sql  # generated: the table, its constraints and indexes
  orchestrators/gateway/
    src/.app/guards/jwt.guard.ts  # generated: application-wide authentication
    src/modules/products/
      MODULE.pso.ts  # generated: the module's controllers and providers
      routes/ROUTES.pso.ts  # generated: the endpoints and who may call them
      providers/product.provider.ts  # generated: the call to catalog, by name
```

Read the path from top to bottom: the route decides whether the URL exists and who may call it; the controller validates; the provider
calls `catalog` by its workspace name with the caller's token; Spring checks the token and the scope again, and PostgreSQL enforces
the unique SKU.

## Start it

```bash
pso infra:init --identity keycloak --runtime docker --users "ana,bob:products:read"
pso docker:up --vendor
```

`infra:init` declares the local environment in `pso.infra.json`: Docker, Keycloak and two development users (`ana` holds every
scope the routes declare, `bob` only `products:read`); without it the local environment runs processes and has no identity provider.
`--vendor` copies the PSO packages and Java artifacts the images need into the projects (an installed CLI references them on this
machine, which an image build cannot reach); later starts without a rebuild do not need it. PSO then provisions PostgreSQL (with a generated password in `.infra/`, never in the source),
Keycloak, the service, the orchestrator and the edge, and waits until each is healthy. Then:

```bash
pso studio
```

opens Studio; its API client lists the module's **reference requests** (create, list, find, update, delete and the expected errors) and
sends them through the orchestrator with the development user. The public `GET /products/options` needs no token; every other request
without one stops at the orchestrator with `401`. The [reference CRUD page](/architecture/reference-crud#requests-and-answers) shows
the real requests and answers.

## A second resource

```bash
pso make:crud order --service catalog --orchestrator
pso validate
```

writes the same set of files for `order` in both projects: the next migration (`V2__create_orders.sql`), its scopes
(`orders:read`, `orders:write`), tests and a request collection. Use `--fields` to describe its columns
([Generators](/architecture/generators)).

## If it fails

If Maven cannot resolve `com.pso` artifacts, run `pso java:install`. If `docker:up` reports a port in use, another process owns it:
`pso docker:ps` and the message name it. If a request returns `404`, compare its path with `pso routes:list`. See
[first-run troubleshooting](/getting-started/troubleshooting).

## What each command printed

Output of a real run of exactly these commands:

```text evidence="verified"
$ pso validate
catalog: 12 resource(s), digest f4307ea2aac8
gateway: 12 resource(s), digest e010c0bcf740
OK

$ pso routes:list
GET     /products                products.list           -> catalog        guard:jwt
POST    /products                products.create         -> catalog        guard:jwt
DELETE  /products/:id            products.remove         -> catalog        guard:jwt
GET     /products/:id            products.find           -> catalog        guard:jwt
PUT     /products/:id            products.update         -> catalog        guard:jwt
GET     /products/options        products.options                          public

$ pso routes:inspect /products
GET /products  ->  catalog:8081
access:   guard jwt, scopes products:read
defined:  orchestrators/gateway/src/modules/products/routes/ROUTES.pso.ts
contract: typed (orchestrators/gateway/src/modules/products/contracts/product.contract.ts)
handlers: services/catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java
```

`routes:inspect` accepts a module name (`products`), a route id (`products.find`) or an exact path (`/products`; a path shared by
several methods shows its `GET`).

## Variations

- `pso create service catalog --template empty` and `pso create orchestrator gateway --template empty`: the same foundations without
  the example.
- Create the orchestrator first: its `products` module still starts, `pso validate` warns `PSO_CRUD_UNBOUND`, and `pso create service`
  binds it when the service exists.
- Projects created before 0.2 keep their 0.1 layout; [structure compatibility](/architecture/structure-migration) explains how to inspect and migrate them.

## Recovering from mistakes

| Mistake | What you see | Fix |
|---|---|---|
| `make:crud` for a resource that exists | `exists`; nothing written | choose another name, or remove the old files first |
| used Git Bash for a `--route /x` flag | `error: Invalid route "C:/Program Files/Git/x"` | PowerShell, or `MSYS_NO_PATHCONV=1` |
| edited `V1__create_products.sql` after it ran | Flyway refuses to start: checksum mismatch | restore it; add a `V<next>__...` migration instead |
