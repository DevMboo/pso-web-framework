---
title: FEI.pso.ts, MEI.pso.ts and ROUTES.pso.ts
description: The declarative contracts of the frontend ecosystem: what each field means, how they are read without being executed, and which validation errors name which configuration.
order: 3
status: implemented
keywords: [defineFEI, defineMEI, defineFrontendRoutes, defineMiddleware, declaration, validation, route ownership, scopes, ports]
related: [frontend/overview, frontend/routing-and-middleware, frontend/releases, concepts/declarative-architecture]
---
> [!STATUS]
> **Implemented and verified** (`contracts.test.ts`, `workspace-frontends.test.ts`, and the generated projects' own tests).

Like every PSO declaration, these files are **data**. `defineFEI`, `defineMEI`, `defineFrontendRoutes` and `defineMiddleware` only give the editor types. The CLI and Studio read the files without executing them: an object literal with literals only. A function call, a variable or `process.env` inside a declaration is reported as an error, because importing project code would run it before trust exists.

## FEI.pso.ts

```typescript
import { defineFEI } from "@pso/frontend";

export default defineFEI({
  name: "fei-commerce",                              // fei-<name>, kebab-case
  server: { port: 4200 },
  orchestrator: { service: "gateway", basePath: "/api" },
  security: { authentication: "jwt", session: "centralized", loginPath: "/login" },
  middlewares: ["authentication", "authorization", "session", "context", "telemetry"],
  locale: { default: "en", supported: ["en"] },
  microfrontends: [
    { name: "mei-customers", path: "/customers", scopes: ["customers:read"], loading: "lazy", title: "Customers", icon: "customers" },
  ],
});
```

- `orchestrator.service` must be the workspace's orchestrator. `basePath` is a same-origin path; the API client never accepts an absolute URL.
- `middlewares` is the navigation pipeline in order. `authentication` and `authorization` are mandatory while authentication is `jwt`, `authentication` must run before `authorization`, and nothing may run before `authentication` (a custom middleware must not see an unauthenticated navigation).
- Each microfrontend has a **mount path** it owns exclusively. Paths cannot be parameterized, nested inside another mount, or start with `/api`, `/_mei`, `/_pso`, `/_fei`, `/health` or `/channels`: those belong to the API, the remote artifacts and PSO itself.
- `scopes` are what the user needs to **enter** the MEI. They hide navigation and block loading the MEI; they are a user-experience mechanism.

## MEI.pso.ts

```typescript
export default defineMEI({
  name: "mei-customers", host: "fei-commerce", server: { port: 9000 },
  orchestrator: { service: "gateway" },
  expose: { module: "./src/module.tsx" },
  security: { inheritFromHost: true, scopes: ["customers:read", "customers:write"] },
});
```

`inheritFromHost: false` is refused: a MEI never has its own authentication lifecycle. `middlewares` may list domain middleware but never a mandatory FEI middleware. `contract.context` is the shared-context version the MEI was built for (default `1.0`).

## ROUTES.pso.ts

```typescript
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Customers.tsx", title: "Customers" },
    { path: "/new", page: "./src/pages/CreateCustomer.tsx", scopes: ["customers:write"] },
    { path: "/:id", page: "./src/pages/CustomerDetails.tsx" },
  ],
});
```

Paths are relative to the mount, so these become `/customers`, `/customers/new` and `/customers/:id`. A route has a `page`, a `redirect` or `children`, never both a page and a redirect. Files are project-relative and cannot contain `..`. PSO generates the lazy route table from this file (`.pso/generated/`, never edited).

## What `pso frontend:validate` checks

| Code | Meaning |
|---|---|
| `PSO_FEI_ROUTE_CONFLICT` | two mounts overlap; names both entries by index |
| `PSO_FEI_ROUTE_RESERVED` | a mount under `/api`, `/_mei` and the like |
| `PSO_MEI_NOT_REGISTERED` / `PSO_MEI_HOST_MISMATCH` | the MEI names a host that does not list it |
| `PSO_MEI_SCOPE_MISMATCH` | the FEI requires a scope the MEI does not declare |
| `PSO_MEI_CONTRACT_INCOMPATIBLE` | the MEI needs a newer or different major shared-context version |
| `PSO_ROUTE_CONFLICT` | the same effective path is declared twice (parameter names do not make routes different) |
| `PSO_MEI_OWN_ROUTER` | a MEI source uses `BrowserRouter`, `HashRouter` and the like |
| `PSO_MEI_DIRECT_URL` | a MEI calls `fetch("https://...")` |
| `PSO_FRONTEND_CONTRACT_STALE` | generated orchestrator types are older than the orchestrator |

## Limits and common mistakes

- A computed declaration (`name: process.env.NAME`) is rejected; use a literal and configure the environment through the runtime configuration.
- Route precedence is deterministic: static segments beat `:param` beats `*`. Two routes of the same shape are an error, not a coin flip.
- Declaring a scope in the FEI does not secure anything on the server. Every scope the MEI needs must also be enforced by the orchestrator.
