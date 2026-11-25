---
title: Protect an API with JWT scopes
description: How the generated Product API is protected - Keycloak declared by pso infra:init, the jwt guard in .app, public and guarded routes in ROUTES.pso.ts, the same scopes checked again by Spring - and how to tell 401 from 403 with real answers.
order: 3
keywords: [tutorial, jwt, keycloak, scopes, public routes, authorization, 401, 403, infra:token]
related: [security/authentication, security/authorization, security/secure-routing, tutorials/first-application, architecture/reference-crud, infrastructure/identity-reconciliation]
---

Every route of a PSO orchestrator is denied unless `ROUTES.pso.ts` declares who may call it, and every microservice checks the
token again: the service does not trust the orchestrator's network position as proof of identity. This tutorial uses the generated
Product API, so nothing is written by hand: you read the declarations, start the workspace with its identity provider, and send
requests as two development users with different scopes.

## 1. The workspace

```bash
pso create workspace shop
cd shop
pso create service catalog
pso create orchestrator gateway
pso infra:init --identity keycloak --runtime docker --users "ana,bob:products:read"
```

`infra:init` writes `pso.infra.json`: a local environment on Docker with a Keycloak realm that PSO generates and reconciles. The
development users are declared there, not in code: `ana` receives every scope the routes declare (`products:read`, `products:write`),
`bob` only `products:read`. The issuer, the audience and the key source of each project are generated into `.infra/` when the
environment is applied (`pso infra:plan` lists them as `env:gateway` and `env:catalog`); you never write them into source.

## 2. Read the declarations

The orchestrator's application-wide guard is generated in `src/.app/guards/`:

```ts title="gateway/src/.app/guards/jwt.guard.ts"
import { JwtGuard } from "@pso/security";

// Authentication policy for every route that uses the "jwt" guard.
// Keys, issuer, audience and algorithms are declared in pso.config.json (security.authentication.*)
// and validated before the application starts. Run `pso security:validate` to check that configuration and `pso security:policy` to see the effective policy of every route.
export default JwtGuard.create();
```

The module's routes decide which URL exists and who may call it. One route is intentionally public; the others name the guard and
the scope:

```ts title="gateway/src/modules/products/routes/ROUTES.pso.ts"
    { method: "GET", path: "/products/options", controller: ProductController, action: "options", security: { public: true } },
    { method: "GET", path: "/products", controller: ProductController, action: "list", security: { guard: "jwt", scopes: ["products:read"] }, metadata: { services: ["catalog"] }, responses: { 200: "ProductPageResponse", 400: "problem", 401: "problem", 403: "problem" } },
    { method: "POST", path: "/products", controller: ProductController, action: "create", security: { guard: "jwt", scopes: ["products:write"] }, metadata: { services: ["catalog"] }, responses: { 201: "ProductResponse", 400: "problem", 409: "problem" } },
```

A decorator on the controller cannot weaken this policy, a route that is both public and guarded is an error, and a route that is
not listed does not exist. The microservice repeats the check on its own controller:

```java title="catalog/src/main/java/com/pso/catalog/application/rest/ProductController.java"
    @PostMapping
    @PreAuthorize("hasAuthority('SCOPE_products:write')")
```

`pso security:policy` prints the effective policy without starting anything:

```text evidence="verified"
default: deny
GET     /products                guarded:jwt scopes=[products:read]  -> catalog
POST    /products                guarded:jwt scopes=[products:write]  -> catalog
DELETE  /products/:id            guarded:jwt scopes=[products:write]  -> catalog
GET     /products/:id            guarded:jwt scopes=[products:read]  -> catalog
PUT     /products/:id            guarded:jwt scopes=[products:write]  -> catalog
GET     /products/options        public  -> (orchestrator)
service catalog: deny by default
```

## 3. Start it and send requests

```bash
pso docker:up --vendor
```

`docker:up` applies the environment (certificate authority, certificates, the realm with the two users, the database password, the
environment of each project), builds the images and starts PostgreSQL, Keycloak, `catalog`, `gateway` and the edge. Then, in
PowerShell:

```powershell
$ANA = pso infra:token --user ana
$BOB = pso infra:token --user bob
$API = "https://api.pso.localhost:8443"
curl --cacert .infra/ca/local/ca.crt "$API/products/options"
curl --cacert .infra/ca/local/ca.crt "$API/products"
curl --cacert .infra/ca/local/ca.crt -H "authorization: Bearer $BOB" -H "content-type: application/json" `
  -d '{"sku":"KB-100","name":"Keyboard KB-100","price":"49.90","active":true}' "$API/products"
curl --cacert .infra/ca/local/ca.crt -H "authorization: Bearer $ANA" -H "content-type: application/json" `
  -d '{"sku":"KB-100","name":"Keyboard KB-100","price":"49.90","active":true}' "$API/products"
```

`infra:token` obtains a real token for a declared development user from the environment's Keycloak; it is refused for a production
environment. The answers of a real run of the generated workspace ([all recorded answers](/architecture/reference-crud#requests-and-answers)):

```text evidence="verified"
GET /products/options                         (no token)
200 {"sort":["sku","name","price","createdAt","updatedAt"],"directions":["asc","desc"],"filters":["sku","name","active"],"maxPageSize":100,"defaultPageSize":20}

GET /products                                 (no token)
401 {"type":"urn:pso:problem:auth-unauthorized","title":"Authentication required","status":401,"detail":"Valid credentials are required to access this resource.","code":"PSO_AUTH_UNAUTHORIZED","error":"unauthorized","instance":"/products","correlationId":"07ecab4f-cb24-4c42-bfe6-603eb9e49478"}

POST /products  (token with products:read only)
403 {"type":"urn:pso:problem:auth-forbidden","title":"Access denied","status":403,"detail":"The authenticated caller is not allowed to perform this operation.","code":"PSO_AUTH_FORBIDDEN","error":"forbidden","instance":"/products","correlationId":"6e486629-9a7e-413a-a87b-75393fc7e087"}
```

With `ana`'s token the same `POST` answers `201` with a `Location` header. The `401` and the `403` are decided by the orchestrator
before any module code runs and before `catalog` is called. The body never says which check failed; the orchestrator's log does,
with the same `correlationId` (`pso docker:logs gateway`):

```text evidence="expected"
WARN  [security] authentication failed  reason=missing_header route="GET /products"
WARN  [security] authorization denied  missing=scope:products:write route="POST /products"
```

In Studio (`pso studio`, API Client, **Reference requests**) the same requests are sent with a development user; the token is
obtained by Studio's server and never shown.

## 401 or 403: a quick guide

| Check | 401 | 403 |
|---|---|---|
| is a token present and well-formed? | no | yes |
| is it signed by a key you trust, with the right issuer and audience, unexpired? | no | yes |
| does it carry the scope or role the route needs? | not evaluated | **no** |

## Variations

| You want | Do |
|---|---|
| another scope for a route | change `scopes` in `ROUTES.pso.ts` and the `@PreAuthorize` of the Spring action; the next reconciliation (`pso docker:up`) gives `ana`, the user declared without explicit scopes, the new scope in Keycloak; a user declared with scopes keeps exactly those |
| another development user | `pso infra:init --users "ana,bob:products:read,carol:products:write" --force`, then `pso docker:up` |
| a role instead of a scope | `security: { guard: "jwt", roles: ["admin"] }` |
| a route without a token | `security: { public: true }`; `pso security:check` reports every public route (`SEC004`) so it stays a decision |
| your own identity provider | `identity.provider: "external"` in `pso.infra.json` ([the infrastructure contract](/infrastructure/contract)) |
| a custom verifier | a custom guard with an explicit `custom` provider declaration ([authentication](/security/authentication)) |
| an orchestrator run as a process, without the infrastructure engine | the `PSO_JWT_*` variables in its `.env` and `pso idp:dev` for tokens ([authentication](/security/authentication), [keys and PEM](/security/keys-and-pem)) |

## Common mistakes

- Making a route public to get past a `401`.
- Using one broad scope for every route.
- Changing a scope in `ROUTES.pso.ts` and not in the Spring controller: the orchestrator lets the call through, the service answers
  `403`. Both check, on purpose.
- Pasting a real token into a ticket or into documentation.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `pso security:check` reports `SEC005` for `gateway` | it reads `pso.config.json` and the shell's environment; with the infrastructure engine the verifier settings are generated into the environment of each project when it is applied | `pso infra:plan` (`env:gateway`) | `pso docker:up`; or set `PSO_JWT_*` for a process run |
| every request is `401`, even with a token | the token comes from another issuer or audience | decode the token's `iss` / `aud`; `pso infra:token --user <name>` | use a token of this environment's identity provider |
| `403` with `ana` after adding a scope | the realm was not reconciled yet | `pso infra:plan` (identity) | `pso docker:up` again |
| `infra:token` refuses the user | the user is not declared in `pso.infra.json` | the `users` of the identity | `pso infra:init --users ... --force` |
| the orchestrator will not start: `PSO_SEC_MISSING`, `PSO_SEC_ALGORITHM` or `PSO_SEC_JWKS_INSECURE` | incomplete or unsafe JWT settings | the log's `code` | [Why the orchestrator refuses to start](/reference/startup-failures) has each one reproduced |
