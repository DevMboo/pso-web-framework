---
title: TypeScript orchestrator structure
description: The official modular structure of a PSO orchestrator - src/.app for application-wide components, src/modules for business modules with MODULE.pso.ts and routes/ROUTES.pso.ts, controllers, services, providers, DTOs, contracts, mappers - and how PSO discovers, validates, compiles and serves it.
order: 2
status: implemented
keywords: [orchestrator, modules, .app, MODULE.pso.ts, ROUTES.pso.ts, controller, service, provider, dto, mapper, contract, interceptor, guard, middleware, filter, discovery]
related: [architecture/overview, architecture/reference-crud, orchestrator/routes, orchestrator/dto-validation, orchestrator/upstream-clients, architecture/generators]
---
> [!STATUS]
> **Implemented and verified.** The runtime, `pso validate`, Studio and the generators read this structure; a real build serves it (interceptors, `created()`/`noContent()`, module routes), and a build that mixes it with the 0.1 structure refuses to start (`PSO_STRUCTURE_MIXED`).

```tree title="The modular orchestrator"
gateway/
  src/
    .app/
      configs/  # app.config.ts: plain configuration modules, imported where needed
      contracts/  # *.contract.ts|json: contracts used by several modules
      decorators/  # *.decorator.ts: reusable metadata decorators
      filters/  # *.filter.ts: error filters named by routes
      guards/
        jwt.guard.ts  # generated: authentication / authorization
      interceptors/  # *.interceptor.ts: run around the actions of the routes that name them
      middlewares/  # *.middleware.ts: run before the actions of the routes that name them
    modules/
      products/
        MODULE.pso.ts  # generated: the module's controllers and providers
        routes/
          ROUTES.pso.ts  # generated: its endpoints and their access policy
        controllers/
          product.controller.ts  # generated
        services/
          product.service.ts  # generated
        providers/
          product.provider.ts  # generated: the call to the microservice
        contracts/
          product.contract.ts  # generated: the microservice API it depends on
        dto/
          request/
            create-product.dto.ts  # generated: validated bodies
          response/
            product.dto.ts  # generated: response contracts
        mappers/
          product.mapper.ts  # generated
    shared/  # reusable code of no single module
    main.ts  # generated: bootstrap() only
  tests/
  docs/
  package.json
  tsconfig.json
  README.md
```

Every directory above exists in a new project, with or without the reference CRUD (`--template empty`): an empty one holds a `.gitkeep`
so it survives version control. Placeholders are not evidence for structure detection. The container image's Dockerfile is written by
the first `pso docker:build`.

## Discovery and registration

The runtime and `pso validate` find modules as **directories** of `src/modules/` (the build's `dist/modules/`). A module counts only
through its `MODULE.pso.ts`, and an endpoint exists only if its `routes/ROUTES.pso.ts` declares it with a security policy: a decorated
controller method that no route names is never reachable. Nothing is discovered by scanning for decorators.

```ts
// src/modules/products/MODULE.pso.ts (generated)
export default defineModule({
  name: "products",
  controllers: [ProductController],
  providers: [ProductService, ProductProvider],
  routes: productsRoutes,
  imports: [],
  exports: [],
});
```

```ts
// src/modules/products/routes/ROUTES.pso.ts (excerpt)
{ method: "GET", path: "/products/options", controller: ProductController, action: "options", security: { public: true } },
{ method: "POST", path: "/products", controller: ProductController, action: "create",
  security: { guard: "jwt", scopes: ["products:write"] }, metadata: { services: ["catalog"] }, responses: { 201: "ProductResponse", 400: "problem", 409: "problem" } },
```

Application-wide components are found by kind in `.app/` (and module-local ones in `modules/<m>/guards|middlewares|filters|interceptors/`):
a route names them (`guards`, `middleware`, `interceptors`, `filters`), and an unknown name is a validation error before anything listens.

**Compilation.** TypeScript skips directories whose name starts with a dot even when they are listed, so `tsconfig.json` includes
`"src/.app/**/*"` explicitly (the template does; `pso structure:inspect` reports a project that does not). Docker builds copy `src/` whole,
`.app/` included.

## The components

| Component | Responsibility | Rules |
|---|---|---|
| controller | receive the request, delegate, choose the answer | parameters are validated by their decorators (`@Param("id", spec)`, `@Query(...)`, `@Body(Dto)`); no business logic |
| service | coordinate the operation | no persistence; no copy of rules the microservice owns |
| provider | call a microservice | `UpstreamClient` with the service NAME (discovery), `credentials: "caller"` to forward the user; translate 404/409/400 |
| DTO | the request/response contract | `@Dto()` with field decorators; unknown properties are rejected |
| contract | the microservice API the module depends on + its binding (`PRODUCT_SERVICE`) | types only |
| mapper | microservice record -> public response | copy only contract fields |
| routes | what is exposed and to whom | `public: true` or a guard; `metadata.services` names what the actions may call |

Answers: a returned value is JSON (200; 201 for POST). `created(body, location)` answers 201 with a `Location` header, `noContent()`
204, `withStatus(status, body, headers)` any 2xx/3xx. Errors are thrown: `new HttpError(409, "conflict", { detail })` becomes an RFC 9457
problem whose `detail` is that sentence; an `UpstreamCallError` left unhandled becomes a stable 502/503/504 problem.

## Secure microservice communication

```ts
// src/modules/products/providers/product.provider.ts (excerpt)
find(id: string): Promise<ProductRecord> {
  return translate(this.client.get<ProductRecord>(PRODUCT_SERVICE, "/products/:id", { params: { id }, credentials: "caller" }));
}
```

The destination is a workspace service name, never a URL: the client resolves it through PSO service discovery, applies the service's
endpoint prefix, uses its TLS and mutual TLS material (with the 0.2 infrastructure engine), propagates the correlation id and the trace,
and sends the caller's token only because the call asks for it and the route declared the service. The microservice validates the token
again: the orchestrator never replaces the service's own authorization.

## Interceptors

```ts
// src/.app/interceptors/timing.interceptor.ts (pso make:interceptor timing)
const interceptor: Interceptor = async (call, next) => {
  const started = performance.now();
  try { return await next(); }
  finally { log("info", "action timed", { route: `${call.route.method} ${call.route.path}`, ms: Math.round(performance.now() - started) }); }
};
```

A route opts in with `interceptors: ["timing"]`; interceptors run after guards and middleware, around the action, in the declared order,
and may return a different result.

## What goes wrong

- `PSO_STRUCTURE_MIXED`: the project has `src/routes/` (0.1) and `src/modules/` or `src/.app/`. Keep one: `pso structure:inspect`.
- `PSO_MISPLACED_RESOURCE`: a file is not where its kind lives (a controller next to MODULE.pso.ts, a service in `.app/`). Generate it with `pso make:<kind>`.
- `PSO_CRUD_UNBOUND` (warning): a CRUD module is bound to a service the workspace does not have yet; its routes answer 502 until it exists.
