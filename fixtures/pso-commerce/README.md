# pso-commerce (fixture)

**Responsibility: functional application and distributed-ecosystem validation.** It answers "does a project generated and built with PSO behave correctly as a distributed system?": authentication and authorization, DTO validation, RFC 9457 errors, composition across services, asynchronous events through the outbox and RabbitMQ, and degradation when a service is down. Anything about servers, SSH, nginx, systemd or deployment belongs to [`../pso-cloud-validation`](../pso-cloud-validation/README.md).

A standalone Commerce application created with the PSO CLI: a Node orchestrator (`gateway/`), three Spring Boot services (`customers/`, `catalog/`, `orders/`), a local identity provider (`idp/`), Docker Compose files and black-box acceptance checks (`acceptance.mjs`). It was built to prove that a generated workspace works without importing any framework source: the `@pso/*` packages come from the tarballs in `gateway/vendor/pso/`, and the workspace layout (`pso.workspace.json`, one directory per service) is exactly what `pso create` produced.

**Purpose:** local end-to-end and acceptance validation of generated projects. It is not a product and not part of any distribution.

**Run** (from this directory; needs Docker, JDK 21 and Node 24):

```bash
pso validate
docker compose -f docker-compose.yml -f docker-compose.idp.yml -f docker-compose.override.yml up --build
PSO_CLI=<path to packages/cli/bin/pso.js> node acceptance.mjs
```

`tls/` (created by `pso tls:init --dev`), `idp/keys/` and `.env` are generated or local and are never committed; `.env.example` shows the variables.

## Web playground (`web/`)

`web/` holds **PSO Commerce - Cloud Validation Playground**, a dependency-free browser client (HTML, CSS, JavaScript, native fetch and WebSocket) for the running application. It is not part of Studio or of the framework. It is deployed inside the gateway release of `../pso-cloud-validation` and served at `/playground`; see [`web/README.md`](web/README.md).

## Scenarios (`acceptance.mjs`)

Black-box checks through the gateway of the running Compose stack: 401 or 403 for a missing token, a missing scope and a broken signature; customer create, duplicate (409), invalid body (400), read, list, update and unknown (404); product and stock; placing an order (total, status, author); the outbox to RabbitMQ to catalog stock change; insufficient stock (409) and an unknown or suspended customer (422); the composed summary and its 404 and 403 problems; an undeclared route is unreachable; with the catalog stopped, the summary answers a sanitized 502, 503 or 504 problem while customers keeps answering, and products answer again after the restart. It does not touch any server.

The cloud fixture has its own, separate implementation of this domain (see its README); do not copy changes between them.

## Distributed frontend (`frontend/`)

The real Commerce frontend, generated with `pso create fei` and `pso create mei` and then written on top: `fei-commerce` (shell) and `mei-customers`, `mei-catalog`, `mei-orders`. It talks only to the gateway through `/api`. The Playground (`web/`) stays as a diagnostic client. Run it with `pso frontend:dev` (the gateway on port 3000 and a token from `pso idp:dev token --scopes ...`). The local gateway publishes listings and has no Channels; the cloud workload has no listings but has Channels, so the pages adapt to both. Results and evidence: [fei-mei-final-report.md](../../docs/implementation/fei-mei-final-report.md).

The frontend can also be deployed by the native engine into a real nginx: see [fei-mei-hardening-report.md](../../docs/implementation/fei-mei-hardening-report.md) and `docs/implementation/evidence/fei-mei/native/` (scripts and results).
