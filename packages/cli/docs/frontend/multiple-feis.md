---
title: Several shells (FEIs) in one workspace
description: How 0.2.0 runs several independent application shells side by side, what each one owns, how collisions are detected, and how public and authenticated routes are declared per shell.
order: 12
status: implemented
keywords: [multiple fei, several shells, public routes, authenticated routes, oidc, isolation, publication]
related: [frontend/overview, frontend/security, frontend/releases, infrastructure/hosts-and-environments]
---
> [!STATUS]
> **Implemented and verified** in real Chrome with the reference workspace: `fei-shop` (public home and catalog, protected cart) and `fei-admin` (fully authenticated, permission-protected users) on their own hosts, their own OIDC clients, their own runtime configurations and sites.

0.1 allowed one FEI per workspace. In 0.2.0 a workspace may have several, each an **independent application** with its own:

| | per shell |
|---|---|
| identity and port | `fei-shop` on 4200, `fei-admin` on 4201 (collisions are errors) |
| host and base path | `shop.<domain>/`, `admin.<domain>/` (or one host with distinct, non-nested base paths) |
| authentication | `security.authentication` in its own `FEI.pso.ts` |
| OIDC client and redirect URIs | one client per shell in the generated realm |
| microfrontends | each MEI belongs to one shell (`host` in its `MEI.pso.ts`) |
| runtime configuration, build output, version | its own site under `.infra/sites/<env>/<fei>` |
| publication lifecycle | `pso frontend:publish <fei|mei> --env <env>` targets the right site |

```bash
pso create fei shop
pso create fei admin
pso create mei catalog --host shop
pso create mei users --host admin
pso fei:register catalog --public
pso fei:register users --scopes users:admin   # also added to mei-users' security.scopes
```

With several shells, a command that acts on one of them is told which one (`--host`, `--fei`), or infers it from the MEI's own `host`; it never guesses. A MEI registered in a shell it is not built for is an error (`PSO_MEI_HOST_MISMATCH`), as is a MEI whose `host` is not a FEI of the workspace (`PSO_MEI_HOST_UNKNOWN`). Route conflicts are checked inside each application: two shells may both have a public `/`.

## Public and authenticated routes per shell

Public pages are declared by the shell that owns them, never by a microfrontend:

```ts
// fei-shop/ROUTES.pso.ts: the home page is public
{ path: "/", page: "./src/pages/Home.tsx", title: "Home", public: true }

// fei-shop/FEI.pso.ts
microfrontends: [
  { name: "mei-catalog", path: "/catalog", public: true },          // every catalog route is public
  { name: "mei-cart", path: "/cart", scopes: ["cart:write"] },     // needs a session and the scope
]
```

`fei-admin` declares no public route: every page asks for a session. Contradictions are refused at validation time: a public route with scopes (`PSO_ROUTE_PUBLIC_SCOPES`), `public` and `meta.public` disagreeing (`PSO_ROUTE_PUBLIC_AMBIGUOUS`), a microfrontend making its own route public (`PSO_ROUTE_PUBLIC_MEI`), scopes in a shell without authentication (`PSO_FEI_AUTH_CONTRADICTION`), a public path the microfrontend does not route (warning `PSO_FEI_PUBLIC_PATH_UNROUTED`). Sign-in redirects stay inside the origin (`returnTo` is a same-origin path), and `/auth/callback` is served by the shell itself.

A public page does not make any backend endpoint public: the orchestrator and each service keep authenticating every request. An endpoint is public only when its route says so (`security: { public: true }`) and the service that serves it declares the same rule (`pso make:resource --public` writes both). In the reference workspace the shop's public catalog reads `GET /catalog/products` (declared public on both tiers), while `/api/accounts/users` still answers 401 to a visitor on the shop's own origin.

## What goes wrong
- `This workspace has 2 FEIs: pass --fei <name>`: commands never guess the shell.
- A MEI built for one shell and registered in another: `PSO_MEI_HOST_MISMATCH`.
- A public page that calls a protected endpoint gets 401 for visitors: declare the endpoint public on both tiers, or show the data only after sign-in.
