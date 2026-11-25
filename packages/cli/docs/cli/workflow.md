---
title: From a command to a running request
description: Use the CLI in a deliberate sequence, see what each command changes and verify declarations separately from live behavior.
order: 1
keywords: [cli, workflow, create, validate, routes, health, dev, output]
related: [getting-started/quick-start, tutorials/first-application, concepts/path-structure-working, reference/diagnostics]
---

The CLI does three different jobs: it **writes project files**, **checks declarations**, and **interacts with running processes**. A successful result in one job does not prove the next one. For example, `pso validate` can pass while PostgreSQL is down, and `services:health` can pass while a protected route rejects the wrong token.

| Question | Command | What success proves | What it does not prove |
|---|---|---|---|
| What did PSO create? | `pso create`, `pso make:resource` | files and registrations were written | the application started |
| Do the declarations agree? | `pso validate`, `pso routes:list` | the static structure and route registry are valid | the target service is reachable |
| Are processes reachable? | `pso dev`, `pso services:health` | declared health endpoints answer | a business request succeeds |
| Does the request work? | `curl` or your API client | authentication, routing, service logic and response worked for this request | every other path and failure mode works |

## 1. Create a small workspace

Install the CLI from [Installation](/getting-started/installation) and run `pso java:install` from the framework checkout before building generated Spring services. Use Node 24 and Java 21 or newer. From the directory where you want `shop/`:

```bash
pso create workspace shop
cd shop
pso create service catalog --template empty
pso create orchestrator gateway --template empty
pso make:resource product --service catalog --route /products --scopes products:read
```

`create workspace` writes `pso.workspace.json`. The next two commands create projects in the official structure and register them there; `--template empty` leaves out the generated Product CRUD, so this page can build its own `/products` route step by step (without it, the projects already serve a complete Product API: [Build a CRUD API](/tutorials/crud-api)). `make:resource` writes the gateway route, forwarding controller, Spring controller and DTO, matching contract files, a test and an API page. It generates a **stub** handler that returns an empty list; it does not create a products table. The [CRUD tutorial](/tutorials/crud-api) shows how to add persistence.

```tree title="The files to inspect after generation"
shop/
  pso.workspace.json  # generated: service names, roles, ports and paths
  gateway/
    src/
      .app/
        contracts/product.contract.json  # generated: gateway contract copy
        guards/jwt.guard.ts  # generated: authentication
      modules/
        product/
          MODULE.pso.ts  # generated: controller composition
          routes/ROUTES.pso.ts  # generated: GET /products and products:read
          controllers/product.controller.ts  # generated: forwards to catalog
  catalog/
    src/
      main/
        java/com/pso/catalog/application/rest/ProductController.java  # generated: stub response
        resources/contracts/product.contract.json  # generated: service contract copy
```

Open the files before running anything. The route is public **only if** its registry entry says `security: { public: true }`; this example requires a JWT scope. The controller decorator by itself cannot expose it.

## 2. Check the declaration

```bash
pso validate
pso routes:list
pso routes:inspect product
```

Expected shape, with digests and paths specific to your workspace:

```text evidence="expected"
$ pso validate
gateway: 5 resource(s), digest <your digest>
catalog: 5 resource(s), digest <your digest>
OK

$ pso routes:list
GET     /products                product.findAll        -> catalog        guard:jwt

$ pso routes:inspect product
GET /products  ->  catalog:8081
access:   guard jwt, scopes products:read
defined:  gateway/src/modules/product/routes/ROUTES.pso.ts
```

![The CLI workflow's expected output in the documentation portal, showing validation, the route list and route inspection](@/assets/screenshots/cli-workflow-output.png)

*The output block as rendered in the portal. It is labelled Expected because the digests vary; use the copyable text above to compare each line with your workspace.*

`OK` means static validation passed. `routes:list` answers whether the URL is declared. `routes:inspect` explains the target and access policy. None of these commands calls `catalog`; a stopped service can still have a valid route.

If validation fails, read the first diagnostic code and its file path. [Diagnostics](/reference/diagnostics) explains the code; changing the HTTP client before fixing a registry error cannot help.

## 3. Start, probe and call it

Install the gateway dependencies and configure a shared JWT issuer, audience and JWKS for **both** processes as shown in [Running the environment](/getting-started/running). In a terminal at the workspace root:

```bash
pso dev
```

In another terminal:

```bash
pso services:health
curl -i http://127.0.0.1:3000/products
curl -i http://127.0.0.1:3000/products -H "authorization: Bearer $TOKEN"
```

The health command probes the declared health URLs. The first request has no token and should answer `401` at the gateway. For the second, `$TOKEN` must be signed by the configured issuer, have the configured audience and carry `products:read`; with both processes running, the generated handler answers `200` and `[]`. [First HTTP endpoint](/getting-started/first-endpoint) includes the full error bodies and log correlation flow.

| What you observe | Next check |
|---|---|
| `pso validate` fails | Read the diagnostic and fix the named file before starting |
| `services:health` says DOWN | Read `.pso/logs/<service>.log`; check the declared port and health path |
| `401` | Compare token signature, issuer, audience, expiry and key source |
| `403` | Compare token scopes with `ROUTES.pso.ts` and Spring's method policy |
| `503` | The gateway accepted the request but could not reach the service; probe `catalog` |
| `200 []` | The generated path works. Replace the stub with the [database-backed CRUD flow](/tutorials/crud-api) when you need data |

## Common mistakes and limits of this workflow

- **Treating a green static check as a running system.** `pso validate` and `routes:list` read files only. They pass with every process stopped, with PostgreSQL down and with a wrong JWKS URL. Only `services:health` and a real request touch a process.
- **Treating a healthy process as a working request.** `services:health` calls the declared health endpoint and nothing else. A service can be UP while the route answers `401`, `403` or `503`; the table above says which check comes next for each status.
- **Changing the client before reading the diagnostic.** When `pso validate` fails, nothing later in the sequence is meaningful. Fix the file named by the first diagnostic, then repeat from step 2.
- **Expecting data from the generated handler.** `make:resource` writes a stub that returns `[]` and creates no table. An empty list is the correct result of this page, not a failure.
- **Using one terminal.** `pso dev` stays in the foreground until Ctrl+C. Run the probes from a second terminal; if `pso dev` reports a service that did not become ready, read `.pso/logs/<service>.log` before retrying.
- **A token from another issuer.** The gateway and the Spring service must be configured with the same issuer, audience and key source. A token that one accepts and the other refuses produces `401` from the second check, which looks like a gateway problem and is not.

What this page does not cover: building artifacts, deployment, messaging and persistence. The commands in the next table lead to the pages that do.

## Choose the next command by the evidence you need

| Task | Command | Result to inspect |
|---|---|---|
| Change a route | [`make:route`](/cli/make-route) | `ROUTES.pso.ts`, controller action, then `routes:list` |
| Inspect effective configuration | [`config:show`](/cli/config-show) | value source and redacted secrets; then `config:validate` |
| Check security declarations | [`security:check`](/cli/security-check) | severity, resource and remediation; then try a request |
| Build artifacts | [`build`](/cli/build) | `.pso/artifacts/manifest.json` and checksums |
| Inspect a release | [`deploy:plan`](/cli/deploy-plan) | proposed steps; no activation occurs |
| Add messaging | [`dispatch:install`](/cli/dispatch-install) | provider declaration, then event contract and `dispatch:validate` |

The individual command pages give the accepted syntax and flags. Follow the linked task guide when you need all source files and runtime effects; command output alone is not a complete application.

## Arguments are checked before anything runs

Every command accepts exactly the options its usage line shows (`pso <command> --help` lists them). An unknown option, a missing value, a value given to a switch and an extra argument are usage errors: exit code 2, nothing written, and the option that was probably meant is suggested.

```text evidence="expected"
$ pso make:route reports findAll --method GET --path / --scope reports:read
error: Unknown option "--scope" for `pso make:route`. Did you mean --scopes? Accepted: --compose, --controller, --download, --dry-run, --dto, --guard, --json, --max-download, --method, --path, --public, --scopes, --service, --upstream
usage: pso make:route <module> <action> --method GET --path / ...
hint: nothing was changed. Run `pso make:route --help` for the options of this command
```

Earlier versions ignored an option they did not know, so that command created the route **without** its authorization policy. Scripts that passed an option a command never used (for example `--guard` to `pso make:middleware`) now fail and must drop it.

| Exit code | Meaning |
|---|---|
| 0 | done |
| 1 | the command ran and reports a failure (validation errors, a conflict, findings) |
| 2 | usage error or a command that is not implemented: nothing was changed |
| 3 | a destructive action needs `--yes` |

