---
title: First HTTP endpoint
description: Declare, implement and secure GET /customers across the orchestrator and a Spring service, then call it and read every answer - 200, 401, 403, 404 and 503 - with the logs they produce.
order: 10
keywords: [make:resource, endpoint, route, ROUTES.pso.ts, 401, 403, 503]
prerequisites: [An orchestrator and a Spring Boot service in one workspace]
related: [orchestrator/routes, orchestrator/controllers, microservices/service-contracts, orchestrator/request-lifecycle]
---
## 1. Command

```pso-example
pso create workspace demo
cd demo
pso create orchestrator gateway
pso create service catalog
pso make:resource customer --service catalog --route /customers --scopes customers:read
pso validate
pso routes:list
```

## 2. What was created

```text evidence="expected"
$ pso make:resource customer --service catalog --route /customers --scopes customers:read
created    gateway/src/.app/contracts/customer.contract.json
created    catalog/src/main/java/com/pso/catalog/application/dto/response/CustomerResponse.java
created    catalog/src/main/java/com/pso/catalog/application/rest/CustomerController.java
created    catalog/src/main/resources/contracts/customer.contract.json
created    catalog/src/test/java/com/pso/catalog/application/rest/CustomerControllerTests.java
created    docs/api/customer.md
created    gateway/src/modules/customer/MODULE.pso.ts
created    gateway/src/modules/customer/controllers/customer.controller.ts
created    gateway/src/modules/customer/routes/ROUTES.pso.ts

$ pso routes:list
GET     /customers               customer.findAll        -> catalog        guard:jwt
```

`routes:list` also shows the six routes of the reference `products` module the two projects were created with. `make:resource` is the
smallest way to expose a service endpoint: a **forwarding** route, a Spring controller and a mirrored contract (both copies are
checked for drift). For a complete, database-backed resource use `pso make:crud` ([Generators](/architecture/generators)).

## 3. The generated code

```typescript title="gateway/src/modules/customer/routes/ROUTES.pso.ts"
import { defineRoutes } from "@pso/http";
import { CustomerController } from "../controllers/customer.controller";

export default defineRoutes({
  routes: [
    {
      method: "GET",
      path: "/customers",
      controller: CustomerController,
      action: "findAll",
      security: { guard: "jwt", scopes: ["customers:read"] },
      metadata: { service: "catalog" }
    }
  ]
});
```

```typescript title="gateway/src/modules/customer/controllers/customer.controller.ts"
import { Controller, RestController, Get, Req, Res, Upstream } from "@pso/http";
import { IncomingMessage, ServerResponse } from "node:http";

@Controller()
@RestController("/customers")
export class CustomerController {
  constructor(private readonly upstream: Upstream) {}

  @Get("/")
  async findAll(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "catalog");
  }
}
```

```java title="catalog/.../application/rest/CustomerController.java"
@RestController
@RequestMapping("/customers")
public class CustomerController {

    @PreAuthorize("hasAuthority('SCOPE_customers:read')")
    @GetMapping
    public List<CustomerResponse> list() {
        return List.of();
    }
}
```

The three orchestrator files cooperate: the controller implements, `ROUTES.pso.ts` exposes, `MODULE.pso.ts` composes. The action forwards to the `catalog` service through the injected `Upstream` provider, and `metadata.service` must match the service it forwards to. The Spring controller enforces the same scope again, so bypassing the orchestrator gains nothing.

## 4. Call it, and read every answer

The orchestrator was started with a JWT configuration for the issuer `https://shop.local` and audience `shop-api` ([Running the environment](/getting-started/running)), and the `catalog` service was **not** running. The tokens below were signed with a throwaway key for the run.

All responses in this section are **verified output** from a real run of a workspace generated with these commands (the resource there was named `customer`).

**No token**

```bash
curl -i http://127.0.0.1:3000/customers -H "x-correlation-id: doc-corr-0002"
```

```text evidence="expected"
HTTP 401 application/problem+json; charset=utf-8
{"type":"urn:pso:problem:auth-unauthorized","title":"Authentication required","status":401,"detail":"Valid credentials are required to access this resource.","code":"PSO_AUTH_UNAUTHORIZED","error":"unauthorized","instance":"/customers","correlationId":"doc-corr-0002"}
```

**A valid token without the required scope**

```text evidence="expected"
HTTP 403 application/problem+json; charset=utf-8
{"type":"urn:pso:problem:auth-forbidden","title":"Access denied","status":403,"detail":"The authenticated caller is not allowed to perform this operation.","code":"PSO_AUTH_FORBIDDEN","error":"forbidden","instance":"/customers","correlationId":"doc-corr-0003"}
```

**The right scope, but the service is down**

```text evidence="expected"
HTTP 503 application/problem+json; charset=utf-8
{"type":"urn:pso:problem:upstream-unavailable","title":"Upstream unavailable","status":503,"detail":"An upstream service could not be reached.","code":"PSO_UPSTREAM_UNAVAILABLE","error":"upstream_unavailable","instance":"/customers","correlationId":"doc-corr-0004"}
```

This is the gateway doing its job: the request was authorised and routed, and the failure is honestly reported as unavailable, not as `404` or `500`. Start `catalog` and the same request returns its body with status `200`.

**A method you decorated but never declared, and a path that does not exist**

```text evidence="expected"
$ DELETE /customers/1        (token with the scope)
HTTP 404 application/problem+json; charset=utf-8
{"type":"urn:pso:problem:http-not-found","title":"Resource not found","status":404,"detail":"No resource matches the request.","code":"PSO_HTTP_NOT_FOUND","error":"not_found","instance":"/customers/1","correlationId":"doc-corr-0005"}

$ GET /nothing-here
HTTP 404 ... "code":"PSO_HTTP_NOT_FOUND" ...
```

**A public route (added with `make:route ... --public`)**

```text evidence="expected"
$ GET /reports/summary
HTTP 200 application/json; charset=utf-8
{}
```

**Health**

```text evidence="expected"
$ GET /health/ready
HTTP 200 application/json; charset=utf-8
{"status":"UP","upstreams":1}
```

## 5. What the orchestrator logged

Expected output, with the correlation ids used above:

```text evidence="expected"
2026-11-08 14:54:30.537 INFO  [http] orchestrator listening  host=127.0.0.1 port=39477 routes=4 modules=2
2026-11-08 14:54:30.643 WARN  [security] authentication failed  reason=missing_header route="GET /customers"
2026-11-08 14:54:30.643 INFO  request (doc-corr-0002)  traceId=32cb26798409241e0470edcce3127bf9 method=GET path=/customers status=401 ms=0.5592
2026-11-08 14:54:30.652 WARN  [security] authorization denied (doc-corr-0003)  missing=scope:customers:read route="GET /customers"
2026-11-08 14:54:30.652 INFO  request (doc-corr-0003)  traceId=5e5d71b0da4a655608e5de22a11b685e method=GET path=/customers status=403 ms=4.191
2026-11-08 14:54:30.669 INFO  request (doc-corr-0004)  traceId=62a96dc4232c812f0ed3990ead806f8c method=GET path=/customers status=503 ms=4.2331
2026-11-08 14:54:30.680 INFO  request (doc-corr-0005)  traceId=e066c8721bdb940176e92370b552843d method=DELETE path=/customers/1 status=404 ms=0.3095
```

Read it from the top: a `WARN` line says **why** a request was refused (`reason=missing_header`, `missing=scope:customers:read`), and the `request` line that follows gives the final status. The correlation id in the parentheses is the one in the response body, so a client report ("my id was doc-corr-0003") finds the exact lines. Tokens and bodies are never in the log.

## 6. What happened inside, for the 503 case

1. The route registry matched `GET /customers`.
2. The JWT was verified and the scope `customers:read` found.
3. `CustomerController.findAll` ran and called `Upstream.forward(req, res, "catalog")`.
4. `catalog` is declared in the workspace at its declared port, but nothing answered: the connection was refused, so the framework answered `503` with the stable code `PSO_UPSTREAM_UNAVAILABLE`.

For the full order of stages see [Request and response lifecycle](/orchestrator/request-lifecycle).

## 7. Variations

| You want | Do |
|---|---|
| a public read endpoint | `pso make:route reports summary --method GET --path /summary --public --service gateway` (public is allowed for `GET` only) |
| a write endpoint | add `--method POST` and a separate scope such as `customers:write`; never reuse a read scope |
| the gateway to answer by itself | use a route without `--upstream`; add [DTO validation](/orchestrator/dto-validation) for the body |
| to call a different service | change `--service`/`metadata.service`; it must be a declared service |

## 8. Common mistakes

- Adding `@Get("/x")` to a controller and expecting `GET /customers/x`: nothing is exposed until you add the route with `pso make:route`.
- Declaring `security: { public: true }` on a route whose action carries `@UseGuards`: rejected with `PSO_ROUTE_007`.
- Editing only one of the two contract copies: `pso validate` reports `PSO_CONTRACT_DRIFT`.
- Reading a `503` as a gateway bug: it means the upstream did not answer. Check `pso services:health`.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `404` for the route you just made | it is not in `ROUTES.pso.ts`, or the orchestrator was not restarted | `pso routes:list` | declare it and restart (`npm run dev` compiles first) |
| `PSO_ROUTE_004` or `PSO_ROUTE_005` | the registry disagrees with the decorator | `pso validate` | copy method and path from `Expected:` |
| `401` | no token, or issuer, audience or key source not configured | `pso security:validate` | configure `PSO_JWT_*` ([running](/getting-started/running)) |
| `403` | the token lacks the scope | the `authorization denied` log line | issue the scope |
| `503` | the service behind the route is not running | `pso services:health` | start it |
| `pso make:route` says `Invalid path "C:/Program Files/Git/..."` | Git Bash rewrote `/` | `export MSYS_NO_PATHCONV=1` | rerun |

The validation rows are reproduced in [Validation errors, one by one](/reference/diagnostics-catalog).

## Next steps

- [Validate request bodies](/orchestrator/dto-validation)
- [Request and response lifecycle](/orchestrator/request-lifecycle)
- [Build a CRUD API](/tutorials/crud-api)
