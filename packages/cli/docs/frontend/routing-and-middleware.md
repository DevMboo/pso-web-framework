---
title: Routing, middleware and the shared context
description: How the shell resolves and authorizes a destination before loading a microfrontend, how the navigation middleware pipeline works, and exactly what a MEI receives from usePsoContext().
order: 4
status: implemented
keywords: [routing, react router, middleware, pipeline, usePsoContext, context contract, guards, redirect, not found, access denied]
related: [frontend/declarations, frontend/authentication-and-api, frontend/security, frontend/overview]
---
> [!STATUS]
> **Implemented and verified**: pipeline and routing logic by unit tests; the behavior (redirect with `returnTo`, hidden navigation, access denied before loading, back and forward, refresh on nested routes, MEI to MEI without reloading the shell) by real-browser runs.

## One router, owned by the shell

The shell creates the only history instance. A MEI renders `<Routes>` below its mount path, so `/customers/42` is resolved by the shell (`/customers/*` belongs to `mei-customers`) and then by the MEI (`/:id`). React Router is used as is: nested routes, parameters, query parameters, lazy loading, redirects. A MEI that creates its own `BrowserRouter` would fight the shell over the URL, so `pso frontend:validate` rejects it, and the generated module refuses to render outside a router.

Routes carry `title`, `scopes` and free `meta`; the shell derives breadcrumbs from them and sets the document title. A path nothing owns shows the shell's not-found page, a missing scope shows access denied, and a MEI that cannot be loaded shows a "module unavailable" page with a retry. In each case the rest of the application keeps working.

## The navigation pipeline

Every navigation runs the shell's middlewares in the order `FEI.pso.ts` lists them, **before** the MEI is loaded:

```text evidence="illustrative"
Navigation requested
 authentication  not signed in: redirect to /login?returnTo=<this path>
 authorization   a required scope is missing: access denied (403 page)
 session         about to expire: one shared refresh, or sign out and redirect
 context         locale, tenant check, correlation id
 telemetry       measures the navigation
 microfrontend resolution: load the approved release (only if all of the above continued)
 MEI domain middleware (optional), then rendering
```

```typescript
import { defineMiddleware } from "@pso/frontend";

export default defineMiddleware({
  name: "application-context",
  async execute(context, next) {
    context.set("locale", "pt-BR");
    return next();
  },
});
```

A middleware returns the result of `next()`, or `context.redirect(path)` or `context.deny(status, reason)` to stop. It can be asynchronous and is cancelled when the user navigates again. A redirect to anything that is not an absolute path inside the application (`//host`, `https://...`, backslashes) is refused. An exception is reported as a pipeline error that names the middleware.

A MEI may add domain middleware (`middlewares` in `MEI.pso.ts`). It runs only after the shell's pipeline continued, can write only keys under `mei.<name>.`, can deny, and can redirect only inside its own mount. It cannot replace, reorder or skip the mandatory middleware.

## What a MEI receives

```typescript
const { user, permissions, hasScope, locale, tenant, theme, navigate, api, channels, notifications, get, correlationId } = usePsoContext();
```

The context is a frozen snapshot with a version (`contractVersion`, currently 1.0). It contains **no access token, no refresh function and no setter** for session, tenant or permissions. `api` is the orchestrator client (the token is attached inside it), `channels` subscribes through the shell's single connection, `navigate` accepts only paths inside the application, and `get(key)` reads what a shell middleware published. A MEI built for contract 1.x runs in a host that offers 1.y with y at least x; a different major version is refused when the release is published and again when it is loaded.

## The lifecycle, in practice

The pipeline runs when the location, the session status or the session's scopes change, never during an ordinary re-render, and it is the shell's. The order is the declared order of `middlewares` in `FEI.pso.ts`; each middleware may be asynchronous, call `next()` once (a second call is an error) or end the navigation with `redirect`, `deny` or by throwing (reported as the failing middleware's name). A new navigation aborts the signal of the previous one, so a slow earlier run can never overwrite the newer result. A microfrontend may add domain middleware, which runs only after the shell's middleware allowed the navigation and cannot write the keys the shell owns (`user`, `tenant`, `permissions` and the like) or weaken a decision: it can deny more, not allow what the shell denied. An unauthorized navigation to a microfrontend's route is decided before its code is loaded. Redirects must be paths inside the application. The browser's middleware is user experience: **the orchestrator enforces every scope and tenant rule**, whatever the interface shows (verified: a user without permissions, a read-only user and forged tokens are refused by the orchestrator directly).

```typescript evidence="illustrative"
export default defineMiddleware({
  name: "maintenance-window",
  async execute(context, next) {
    if (context.to.path.startsWith("/orders/new") && (await isFrozen())) return context.deny(503, "Orders are frozen");
    return next();
  },
});
```

Routes whose identifiers contain dots work in the browser; on the server, routes whose last segment ends in a real file extension need to be declared for nginx (see native deployment).

## Limits and common mistakes

- **Middleware is not security.** Anything it denies is reachable from the browser's developer tools. The orchestrator enforces every scope, tenant rule and business rule.
- Do not use the shared context as a global store. Each MEI keeps its own state; the context is for identity, navigation and capabilities.
- `scopes` on a route hide and block in the interface; a MEI route with `scopes: ["customers:write"]` shows "Access denied" without a request being sent, but the same endpoint called by other means is checked by the orchestrator.
- Query parameters are available in the middleware target and through React Router in the page; passing a customer to the Orders MEI works with `navigate("/orders/new?customerId=...")`.
