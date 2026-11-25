---
title: Module and route conventions
description: MODULE.pso.ts, ROUTES.pso.ts and controller contracts with exact shapes and diagnostics.
order: 4
scope: module-routes
base: true
keywords: [ai, module, routes, ROUTES.pso.ts, MODULE.pso.ts]
---
Every HTTP module is a directory `src/modules/<module>/` (MANDATORY for new code) with `MODULE.pso.ts`, `routes/ROUTES.pso.ts`, `controllers/`, `services/`, `providers/`, `contracts/`, `dto/request/`, `dto/response/` and `mappers/`. All of them are validated together. A 0.1 project (`src/routes/<module>/`, every file next to `MODULE.pso.ts`) keeps its layout; never add official-structure files to it (`PSO_STRUCTURE_MIXED`).

### src/modules/users/MODULE.pso.ts (composition)

```typescript
import { defineModule } from "@pso/core";
import { UsersController } from "./controllers/users.controller";
import { UsersService } from "./services/users.service";
import usersRoutes from "./routes/ROUTES.pso";

export default defineModule({
  name: "users",                 // must equal the directory name
  controllers: [UsersController],
  providers: [UsersService],
  routes: usersRoutes,           // must be this directory's own ROUTES.pso default export
  imports: [],
  exports: [UsersService]
});
```

### src/modules/users/routes/ROUTES.pso.ts (authoritative registry; literals and identifiers only)

```typescript
import { defineRoutes } from "@pso/http";
import { UsersController } from "../controllers/users.controller";

export default defineRoutes({
  routes: [
    { method: "GET", path: "/users", controller: UsersController, action: "findAll", security: { public: true } },
    { method: "GET", path: "/users/:id", controller: UsersController, action: "findById", security: { guard: "jwt", scopes: ["users:read"] } },
    { method: "POST", path: "/users", controller: UsersController, action: "create", security: { guard: "jwt", scopes: ["users:write"] },
      metadata: { service: "users" } }
  ]
});
```

Entry fields: `method`, `path` (full path), `controller`, `action`, `security` (`{ public: true }` or `{ guard, scopes }`), `guards`, `middleware`, `interceptors`, `filters`, `metadata.service` (a forwarding route), `metadata.services` (the services an action may call through `UpstreamClient`), `responses`, `version`.

### src/modules/users/controllers/users.controller.ts

```typescript
@Controller()
@RestController("/users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}
  @Get("/")    async findAll() { /* ... */ }
  @Get("/:id") async findById(@Param("id") id: string) { /* ... */ }
}
```

The declared `path` must equal the `@RestController` prefix plus the action path, and `method` must equal the decorator.

### Validation (all must hold)

controller declared in the module; route declared; action exists with an HTTP decorator; method and path match; dependencies resolve; security policy satisfied; no duplicate or conflicting routes (`/users/:id` equals `/users/:userId`); module consistent. Any error means **no route is activated**.

Diagnostics: `PSO_MODULE_001-008`, `PSO_ROUTE_001-010` (see the diagnostics list in the Diagnose scope). Never silence or "fix" one by weakening security.

### Generate, do not hand-write

```text
pso make:module users --service gateway
pso make:controller users --service gateway
pso make:route users findAll --method GET --path / --public --service gateway
```
