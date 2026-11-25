---
title: Task: connect two microservices
description: Exact steps to let one service use another safely.
order: 26
scope: connect-services
base: false
requires: [orchestrator, microservices, security]
keywords: [ai, task, connect, service to service]
---
1. Declare the dependency so start-up order is right: add `"dependsOn": ["<other>"]` to the service in `pso.workspace.json` (or `pso services:register ... --depends-on <other>`). Then `pso services:graph`.
2. If the call starts from a user request, route it through the orchestrator: `pso make:resource <name> --service <other> --route /path --scopes x:read`. The orchestrator forwards a verified token with `this.upstream.forward(req, res, "<other>")`. In the official structure the call to a microservice belongs in a provider of the module (`src/modules/<module>/providers/<name>.provider.ts`, as in the generated Product CRUD): it injects `UpstreamClient`, calls the service by NAME (`this.client.get<T>(PRODUCT_SERVICE, "/products/:id", { params: { id }, credentials: "caller" })`) and translates `UpstreamCallError`; the routes that use it declare `metadata: { services: ["<service>"] }`. When one request needs data from SEVERAL services, generate a composing action instead: `pso make:route <module> <action> --method GET --path /x --compose customers,orders --scopes x:read`. It injects `UpstreamClient` and declares `metadata: { services: [...] }` on the route; call only the declared services (`this.services.get<T>("customers", "/customers/:id", { params: { id } })`), pass `credentials: "caller"` only where the service must see the user's token, and catch `UpstreamCallError` to translate a downstream outcome (`e.is(404)`). Never build a URL, never use `fetch` for a service call.
3. A direct call from one Spring service to another uses the injected `PsoHttpClient` with a service named under `pso.http.client.services` (relative paths only, redirects never followed, bearer forwarding opt-in per service, TLS with `tls.ca-file` and mutual TLS with `tls.cert-file` + `tls.key-file`, PEM, or the key-store properties). Never build `RestTemplate`/`WebClient` calls to arbitrary URLs and never rely on network location for trust. An unhandled remote 404/409 answers 404/409, another 4xx answers 502 `PSO_UPSTREAM_REJECTED`; translate on purpose with `catch (PsoHttpException e) { if (e.isStatus(404)) ... }`.
4. Describe the operation in a service contract and keep both copies identical (`PSO_CONTRACT_DRIFT` otherwise).
5. Never share a database or domain classes between the services.
6. Run `pso validate`, `pso security:policy` and `pso services:health`.
