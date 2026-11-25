---
title: Middleware and filters
description: Named per-route middleware that runs after the guards and exception filters that turn errors into answers - generated, wired, run and verified end to end.
order: 9
keywords: [middleware, filter, exception, make:middleware, make:filter, PSO_ROUTE_008, HttpError]
related: [orchestrator/request-lifecycle, orchestrator/guards, reference/error-standard]
---
Both are **named** files that a route opts into. Nothing runs globally from `main.ts` ([why](/decisions/why-minimal-bootstrap)). The examples on this page are run by the framework's test suite (`docs-middleware.test.ts`): the behavior described here is verified, not assumed.

## Middleware

A function exported by `src/.app/middlewares/<name>.middleware.ts`. Routes opt in by name (`middleware: ["audit"]` in `ROUTES.pso.ts`). It runs **after the guards**, so it only sees authenticated requests (public routes excepted). It may end the response; if it does, the action is not run.

```bash
pso make:middleware audit
```

```typescript title="src/.app/middlewares/audit.middleware.ts"
import type { Middleware } from "@pso/http";

const middleware: Middleware = (req, _res, route) => {
  console.log(JSON.stringify({ msg: "audited", method: req.method, path: route.path }));
};
export default middleware;
```

Wire it in the route:

```typescript title="src/modules/orders/routes/ROUTES.pso.ts"
{
  method: "POST", path: "/orders", controller: OrdersController, action: "create",
  security: { guard: "jwt", scopes: ["customers:read"] },
  middleware: ["audit"],
  filters: ["conflict"]
}
```

### What happens (expected)

1. A `POST /orders` **without a token** answers `401`. The middleware did not run: the log contains no `audited` line.
2. The same request **with a valid token** answers `201` with the action's result, and the log shows:

```text evidence="expected"
{"msg":"audited","method":"POST","path":"/orders"}
```

The middleware sees the route (`route.path`) and the request; use it for audit trails, request enrichment or early refusal. For authentication and authorization use [guards](/orchestrator/guards), so the decision is made in the same place for every route.

## Filters

A filter handles errors thrown by the action. Return `true` once the response has been written:

```bash
pso make:filter conflict
```

```typescript title="src/.app/filters/conflict.filter.ts"
import { HttpError, type Filter } from "@pso/http";

const filter: Filter = (err, _req, res) => {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  res.writeHead(409, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "conflict" }));
  return true;
};
export default filter;
```

Use it with `filters: ["conflict"]`. If the action throws `new HttpError(409, "duplicate")`, the answer is (expected):

```text evidence="expected"
HTTP 409 application/json
{"error":"conflict"}
```

and **not** the framework's default `application/problem+json` body. That is the point and the risk: a filter replaces the standard error contract for that route. Prefer keeping the standard ([error standard](/reference/error-standard)) unless a client truly needs another shape. A filter that returns `false` leaves the error to the next filter and then to the framework; unhandled errors produce a generic `500` that never leaks internals.

## Failure: an unknown name

A route that names a middleware or filter that does not exist is `PSO_ROUTE_008`, caught by `pso validate` and again at start-up (verified: the process refuses to start and names the code).

## When to use which

| You want | Use |
|---|---|
| to check who may call | a guard |
| to record, enrich or rate-shape every request of some routes | middleware |
| to translate one kind of error into a specific answer | a filter |
| a rule about the body's shape | a DTO ([validation](/orchestrator/dto-validation)) |
| to apply something to every route | a global guard or the framework's own limits, not a middleware list copied everywhere |

## Common mistakes

- Expecting a middleware to run for a request the guard refused.
- Logging tokens or bodies in a middleware.
- Writing a filter that swallows errors it does not understand (return `false` for those).

## Next steps

- [Request and response lifecycle](/orchestrator/request-lifecycle)
- [Guards](/orchestrator/guards)
