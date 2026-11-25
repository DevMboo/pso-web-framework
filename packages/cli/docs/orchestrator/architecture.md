---
title: Orchestrator architecture
description: Node.js + TypeScript, compiled, declarative modules, one public entry point - what the orchestrator does, what it deliberately does not, how a request travels through it, and how to deploy and scale it.
order: 1
keywords: [orchestrator, node, typescript, gateway, architecture, upstream, stateless]
related: [orchestrator/bootstrap, orchestrator/module, orchestrator/request-lifecycle, decisions/controller-or-service]
---
The orchestrator is the single public entry point of a workspace. It validates tokens, applies route policy and forwards to services. It holds **no domain logic**; that belongs in the microservices.

New projects use the [official modular structure](/architecture/typescript-orchestrator). Existing 0.1 projects keep their `src/routes/` layout; [structure inspection](/architecture/structure-migration) plans a migration without moving files.

```tree title="The orchestrator source layout"
gateway/
  src/
    .app/
      guards/jwt.guard.ts  # generated: application-wide JWT guard
      middlewares/
      filters/
      interceptors/
      configs/
      contracts/
      decorators/
    modules/
      products/  # generated reference CRUD; --template empty omits it
        MODULE.pso.ts
        routes/ROUTES.pso.ts
        controllers/
        services/
        providers/
        dto/
        contracts/
        mappers/
    shared/  # code reused by more than one module
    main.ts  # generated: minimal bootstrap only
  dist/  # generated: compiled output, what actually runs
```

## What it is responsible for

| Responsibility | How |
|---|---|
| deciding what is reachable | the `ROUTES.pso.ts` registries; anything else is `404` |
| authenticating and authorising | JWT guard, scopes and roles per route |
| protecting itself and the services | body, header and connection limits, rate limiting, request timeouts |
| forwarding | `Upstream.forward` or `UpstreamClient` to a declared service, with header hygiene and caller credentials only when requested |
| answering consistently | RFC 9457 problems with stable codes and a correlation id |
| being observable | logs, metrics, traces ([logging](/devops/logging), [observability](/devops/observability)) |
| validating the bodies it owns | `@Body(Dto)` ([DTO validation](/orchestrator/dto-validation)) |

## What it is not responsible for

Business rules, persistence, and anything that must survive a restart. If you find yourself adding a database to the orchestrator, the logic probably belongs in a service ([controller or service?](/decisions/controller-or-service)). This is also why it has no transactional outbox ([why](/decisions/why-no-typescript-outbox)).

## Key properties

- **Compiled TypeScript.** Decorators and constructor metadata cannot run directly in Node, so the orchestrator is built with `tsc` (CommonJS, `experimentalDecorators`, `emitDecoratorMetadata`). `npm run dev` and `pso dev` compile and then start `dist/main.js`.
- **Declared exposure.** Only routes declared in `ROUTES.pso.ts` of a valid module exist ([Routing](/orchestrator/routes)).
- **Framework-owned runtime.** `@pso/http` provides decorators, `defineRoutes`, dependency injection, the HTTP server, the proxy, rate limiting and logging. `@pso/core` provides `defineModule`, validation and discovery.
- **Declared upstreams.** Services come from `pso.workspace.json` in development and from `PSO_UPSTREAM_<NAME>=host:port` in production; there is no port scanning.
- **Secure service connections.** The infrastructure engine configures TLS and optional mutual TLS from declarations; the orchestrator and Spring services check identity and access independently ([security and certificates](/infrastructure/security-and-certificates)).
- **Stateless.** Any instance can serve any request, which is what lets you run several behind a load balancer.

:::diagram name="lifecycle"

## How a request travels

```flow title="Request pipeline of the orchestrator"
[request] client -> limits and rate limit -> route registry -> JWT and scopes -> middleware -> DTO validation -> controller action
[forward] controller action -> Spring service | token checked again
```

Every stage that can refuse a request has its own status and code; see [Request and response lifecycle](/orchestrator/request-lifecycle) for the table, with real examples of `401`, `403`, `404` and `503`.

## Deploying and scaling

| Concern | Guidance |
|---|---|
| instances | run as many as you need; no sticky sessions are required |
| rate limiting | the default budget is per instance; use the Redis provider when instances must share one ([decision](/decisions/local-or-distributed-rate-limit)) |
| upstream addresses | `PSO_UPSTREAM_<NAME>=host:port`; in production a remote upstream needs TLS unless explicitly marked `allowPlaintext` ([service identity](/security/service-identity)) |
| configuration | environment variables and `pso.config.<env>.json` ([configuration](/concepts/configuration)) |
| health | `GET /health/live` and `GET /health/ready` (public) |
| shutdown | on `SIGTERM` it stops background work and closes connections; take it out of rotation first ([lifecycle](/concepts/runtime-lifecycle)) |

## Common mistakes

- Running `ts-node`/`node` on the sources: always run the compiled `dist/main.js`.
- Putting domain logic in controllers "because the gateway is right there".
- Letting the orchestrator reach services through addresses that are not declared.

## Next steps

- [Minimal main.ts](/orchestrator/bootstrap)
- [Module](/orchestrator/module) and [Routing](/orchestrator/routes)
