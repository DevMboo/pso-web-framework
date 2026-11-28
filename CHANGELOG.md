# Changelog

## 0.2.0-rc.8 — The edge answers for itself (2026-11-28)

Eighth release candidate of 0.2.0 (npm packages stay `0.2.0`; PSO Java is `0.2.0-rc.8`; rc.1 to rc.7 are kept for rollback).
**The Windows installer and the portable ZIP are not Authenticode-signed.**

### Fixed
- **The edge identified its software.** A plain HTTP request sent to the HTTPS port was answered with nginx's own page ("400 Bad
  Request — The plain HTTP request was sent to HTTPS port — nginx"), and every response carried `Server: nginx` (`server_tokens off`
  only hides the version). The edge now runs the framework's own image, built locally from the installed PSO (`pso-edge:<hash>`, never
  pulled: Alpine 3.24 pinned by digest, Alpine's nginx 1.30 and headers-more packages): no `Server`, `X-Powered-By`, `X-AspNet-Version`
  or `X-AspNetMvc-Version` header on any response, and none of nginx's built-in error pages.
- **Native error responses.** Every error the edge produces itself (400, 401, 403, 404, 405, 408, 411, 413, 414, 416, 421, 429, 431, 500,
  501, 502, 503, 504, 505; nginx's 494 to 497 mapped to 431 and 400) is answered from pages and RFC 9457 documents inside the image: an
  HTML page on a shell's host, `application/problem+json` on the API host, the same-origin `/api` path, `/channels` and the identity
  provider's protocol endpoints. The status is always kept. The orchestrator's and the identity provider's responses are never intercepted
  (Problem Details, `WWW-Authenticate`, `Retry-After`, `Allow`, `X-Correlation-ID` unchanged); only the shells' static servers are. The pages
  work with every application container stopped, carry no script, font, image or technology name, and are served under
  `default-src 'none'`. Unknown hosts get a sanitized 421, malformed requests a sanitized 400.
- **PSO Channels refused browsers behind the edge on any port but 443.** The edge forwarded `Host` without the external port, so the
  orchestrator's same-origin check failed for `https://<shell>:8443`; in `production` Channels had no allowed origins at all and refused to
  start. The edge now forwards the external authority (the matched host name and the environment's public port; never a value the client
  wrote) and the engine gives the orchestrator `PSO_CHANNELS_ALLOWED_ORIGINS` = the declared shells' exact origins (unless the application
  sets its own). Other origins, including forged `X-Forwarded-Host`/`Forwarded` headers, are still refused.
- **`pso channels:enable` on the orchestrator generated code that did not compile** when Dispatch was not installed (its Dispatch consumer
  imports `@pso/dispatch`). The orchestrator's side of Channels is that consumer, so the command now refuses, before writing anything
  (also with `--dry-run`), until the orchestrator has a Dispatch provider, and names the command to run. Spring services are unchanged.
- The edge's access log no longer records query strings (an OIDC callback's `code` and `state`), and records the id returned to the
  client as `X-Correlation-ID`.

### Added
- Every `docker compose up` that starts the edge (docker:up, docker:restart --recreate, deploy --env, Studio) first ensures the edge image
  and has nginx test the configuration with the real mounts: a rejected configuration is never started. Remote deployments transfer the
  edge image and run `nginx -t` on the host before the release starts. Deployment bundles name the image as a prerequisite.
- `pso infra:validate --probe` checks that plain HTTP on the TLS port and unknown hosts are answered without disclosure.
- Distribution guards: the edge resources are in `@pso/infra`'s `files`, the installer allowlist (`dist.config.json`) and the distribution
  policy (`A-infra-edge`); a test fails when any of them is missing.

- The edge image checks itself at build time (nginx branch, `nginx -t`) and records its exact package builds.

### Compatibility
- Existing workspaces adopt it through the normal lifecycle: `pso infra:apply` (or the next `pso docker:up` in development) updates
  `edge.conf` and the compose file, `pso docker:up` re-creates the edge. FEIs and MEIs are not regenerated; nothing is written into a
  workspace except the regenerated configuration. A hand-edited `edge.conf` stays drift and is never overwritten silently.
- `docker.images.nginx` no longer applies to the edge (the shells and the pso-dev key server still use it). The first start after an update
  builds the edge image once (network access to Docker Hub and Alpine's repository).
- Not covered: TLS handshake failures, HTTP/2 protocol errors and slow request headers end without an HTTP response; an existing nginx
  managed by the PSO agent keeps its own `Server` header and error pages; anything in front of the edge.

## 0.2.0-rc.7 — The native infrastructure runs on its own (2026-11-26)

Seventh release candidate of 0.2.0 (npm packages stay `0.2.0`; PSO Java is `0.2.0-rc.7`; rc.1 to rc.6 are kept for rollback).
**The Windows installer is not Authenticode-signed.** Five defects found while moving a real consumer application to 0.2 are fixed in
the framework, so an application no longer needs scripts or hand-made configuration to work around them.

### Fixed
- **D1** `pso docker:build --vendor` and `pso docker:up --vendor` never refreshed an existing `vendor/maven` or `vendor/pso`: a workspace
  moved to a new release kept building against the artifacts of the old one (the Maven build failed with `dependencies.dependency.version
  ... is missing`, or an npm image silently kept old framework code). Vendor directories now carry a manifest (`pso-vendor.json`: the
  release and the SHA-256 of every file); every build checks it. `--vendor` replaces an outdated, corrupt or unverified copy atomically and
  leaves a current one alone; without `--vendor` the build stops with `PSO_VENDOR_OUTDATED` / `PSO_VENDOR_CORRUPT` and the reason. Other
  groups kept in `vendor/maven` are preserved. Deleting a vendor directory by hand is never needed.
- **D2** With the `pso-dev` identity the edge served the public keys but waited for the orchestrator, which needed those keys to start:
  neither came up (`PSO_SEC_INIT ... jwks_dns`). The keys are now served by their own container, `idp` (a static TLS key server with no
  dependency), that the services, the orchestrator and the edge wait for. The container graph has no cycle (checked by the tests).
- **D3** The topology had no Redis and no way to give a service the application's own settings. New in `pso.infra.json`: `redis`
  (provisioned only where declared: private network, password, persistent volume, health check; each client receives the address in the
  variables it names), `services.<name>.environment` (plain values and `secret://` references), `volumes`, `replicas`,
  `healthcheck.startPeriod`, and per environment `environments.<env>.services` and `environments.<env>.redis`. A Node service reads its
  mounted secrets through `PSO_SECRET_FILES`. A disabled Dispatch no longer refuses to start because a `${env:...}` reference it would use
  (`REDIS_URL`) is unset.
- **D4** Spring services were told to fetch the keys from `https://edge:8443` but were placed only on the internal network, where `edge`
  does not exist: every authenticated request answered 500. They now fetch them from `https://idp:8443` on that network (TLS verified, the
  key host bound explicitly through `PSO_JWT_JWKS_TRUSTED_HOSTS`).
- **D5** With `pso.infra.json`, `pso dev` filled every variable a process left unset from `.infra/env/<env>/<service>.env`, so an
  application that selects its own key source (`PSO_JWT_PUBLIC_KEY_FILE`) also received the infrastructure's `PSO_JWT_JWKS_URI` and could
  not start (`PSO_SEC_KEY_CONFLICT`). The identity settings are now applied as one group or not at all; `services.<name>.authentication:
  "application"` states it in the contract; `pso dev:env` shows the source of every variable and what was not applied and why (no value
  is shown). A conflict the application creates itself is still refused.

### Added
- `pso dev:env [--service] [--env]`.
- `pso dev --with-dependencies` also starts the pso-dev key server and Redis on loopback, so process mode works with the pso-dev identity.
- The container health check of a service probes the health path the workspace declares.

### Compatibility
- Existing workspaces keep their contracts: every new member is optional. `pso infra:apply` (or the first `pso docker:up` of a development
  environment) adds the key server's certificate and configuration and updates the compose file, the edge configuration and the process
  environments; running containers that changed are re-created by `pso docker:up`.
- A vendor directory written by an earlier PSO is reported as unverified and gets a manifest at the next `--vendor` build.
- The names `redis` (container) and `redis-password`, `redis-url` (secrets) are reserved.
- Not changed: Redis is reached over the private network with a password, not TLS.

## 0.2.0-rc.6 — Sign-in mode of a FEI per environment (2026-11-25)

Sixth release candidate of 0.2.0 (npm packages stay `0.2.0`; PSO Java is `0.2.0-rc.6`; rc.1 to rc.5 are kept for rollback).
**The Windows installer is not Authenticode-signed.**

### Fixed
- `pso frontend:config --env <name>` was rejected as an unknown option although the command recommended it. It is now accepted, takes
  `--fei` when the workspace has several shells, and records the sign-in mode as `environments.<env>.frontends.<fei>.auth` in
  `pso.infra.json`; the infrastructure engine re-renders that FEI's site configuration, so `infra:apply`, `docker:up` and
  `frontend:publish` keep it. Other FEIs and environments are unchanged. OIDC, API-path and signature options stay with `--site`.
- A shell honours a runtime `auth: none`: it opens without sign-in (before, it showed a login page that could not sign in).
- In a shell without sign-in, a page that requires scopes answers "Access denied" instead of opening.
- Generated FEI and MEI templates: an anonymous shell shows its full layout without user or sign-out, and "Signed in as" is only shown
  with a session (new projects only).

### Unchanged
- The orchestrator and the services keep enforcing every protected route (`401` without a token).

## 0.2.0-rc.5 — Mandatory workspace organization (2026-11-25)

Fifth release candidate of 0.2.0 (npm packages stay `0.2.0`; PSO Java is `0.2.0-rc.5`; rc.1 to rc.4 are kept for rollback).
**The Windows installer is not Authenticode-signed.**

### Changed
- `pso create workspace` creates the standard workspace layout: `.infra/` (only its ignore rule; nothing is provisioned before
  `pso infra:init`), `orchestrators/`, `services/`, `frontends/`, `frontends/modules/`, `shared/`, `docs/`, `tests/`,
  `pso.workspace.json` and a `README.md` that describes it.
- The generators place projects there: `pso create orchestrator` → `orchestrators/<name>`, `pso create service` → `services/<name>`,
  `pso create fei` → `frontends/fei-<name>`, `pso create mei` → `frontends/modules/mei-<name>`. The path is registered in
  `pso.workspace.json`, which every command reads. The internal structures (modular orchestrator, layered Java service) are unchanged.
- The orchestrator contract the frontends are generated from is kept in `shared/contracts/` in a standard workspace.
- One module of `@pso/core` (`layout.ts`) decides every project location.

### Compatibility
- Existing (flat) workspaces keep working unchanged: new projects follow the existing ones, a workspace never mixes both layouts, and
  PSO never moves a project directory. `pso create workspace <name> --layout flat` still creates the 0.1 layout.
- `pso structure:inspect` reports the workspace layout and, for a flat workspace, the directory moves to the standard layout
  (inspection only).

## 0.2.0-rc.4 — First public release (2026-11-25)

Fourth release candidate of 0.2.0 and the first one published publicly, built from the public source repository
(https://github.com/DevMboo/pso-web-framework) under the Apache License 2.0. npm packages stay `0.2.0`; PSO Java is `0.2.0-rc.4`.
rc.1 to rc.3 are kept unchanged for rollback. **The Windows installer is not Authenticode-signed** (see the code signing policy).

### Added
- `pso frontend:build --signer <name>` signs microfrontend release manifests with a local signer of `pso signer:generate`: the private
  key stays in the protected credential store and its use is audited. `pso frontend:config --trust-signer <name>` makes a shell trust it.

### Fixed
- Studio's Cloud → Signing tab requested an icon that does not exist (`file-signature`, renamed upstream); it now uses `file-pen-line`.
- The capability list that the documentation and the AI contexts read still called release-signature verification, the Java dependency
  scan, the systemd driver and static frontend deployment "not implemented", and the cloud pages said no external validation had been
  performed. Both are corrected, and the parity test now fails if those claims return.
- The SignPath release workflow verified the bundled `node.exe` against the wrong publisher name (it is signed by the OpenJS Foundation).

### Verified (previously implemented but never run)
- The Linux Secret Service credential provider, against a real gnome-keyring in a Linux container.
- The Java dependency scan, with the real OSV-Scanner 2.2.4 against the live osv.dev database (Log4Shell is blocked).
- Studio's Signing tab in a real browser (signer creation, trust list, typed confirmation, accessibility in both themes).

### Repository
- Dependabot version updates cover the maintained framework (root npm workspace, `pso-java`, GitHub Actions); test fixtures are left
  out. Dependabot alerts and security updates still cover every manifest.
- The SignPath workflow runs only for final version tags and only once the repository variable `PSO_SIGNPATH_ENABLED` is `true`:
  release-candidate tags never start it.

## 0.2.0-rc.3 — Structural corrections of the Java event generators (2026-11-25)

Third release candidate of the unpublished 0.2.0 (npm packages stay `0.2.0`; rc.1 and rc.2 artifacts are kept unchanged for rollback).
PSO Java is released as `0.2.0-rc.3` (same sources as rc.2) and the CLI generates services for exactly that version.

### Fixed
- In a layered Spring service, `pso make:event`, `make:listener`, `make:dispatch-event` and `make:dispatch-handler` write their classes
  to `application/event/` (package `<base>.application.event`) instead of the 0.1 package `events/`, which `pso validate` refused.
- `pso make:notifier` (the Java side of Channels) writes its event record to `application/event/` and the notifier to
  `application/service/` in a layered service.
- 0.1 services are unchanged: the same commands still write to `events/` (and `application/` for the notifier). A project that mixes
  both conventions is refused before anything is written.

### Documentation
- The known limitation of rc.2 about the event generators is removed; Dispatch, Channels, generator and project-structure pages and
  the AI guidance show the layered packages. The `spring-outbox` example is marked as 0.1 compatibility material.

## 0.2.0-rc.2 — Application structure standard and reference CRUD (2026-11-24)

Second release candidate of the unpublished 0.2.0 (rc.1 artifacts are kept unchanged). Structure guide:
`packages/cli/docs/architecture/overview.md`; 0.1 projects: `packages/cli/docs/architecture/structure-migration.md`.

### Added
- **Official application structures.** Orchestrator: `src/.app/{configs,contracts,filters,guards,middlewares,interceptors,decorators}`, `src/modules/<module>/` with `MODULE.pso.ts`, `routes/ROUTES.pso.ts`, `controllers/`, `services/`, `providers/`, `contracts/`, `dto/request|response/`, `mappers/`, and `src/shared/`. Spring service (layered): `application/{rest,service,dto/request,dto/response,mapper}`, `infrastructure/{entity,persistence,config,security,filter,client}`, `shared/{exception,validation,constant}`. Java has no providers, modules or `.app`.
- Structure detection in core, the runtime, `pso validate`, Studio and every generator (`modular` / `layered` / `legacy`, optional `structure` in `pso.workspace.json`); a project that mixes structures is refused (`PSO_STRUCTURE_MIXED`).
- **Reference Product CRUD** generated by `pso create service` and `pso create orchestrator` (`--template crud`, the default; `--template empty` without it): UUID, unique SKU, BigDecimal price, UTC timestamps; Flyway migration with constraints and indexes, Hibernate `validate`, database-level pagination / sorting / filtering, 201 + `Location`, 204, RFC 9457 problems (400/401/403/404/409, duplicate SKU also under concurrency), scopes `products:read` / `products:write`, a public `GET /products/options`; the orchestrator module calls the service by name with the caller's token; generated tests (embedded PostgreSQL, real JWTs).
- **Binding** of an orchestrator CRUD module to the service that serves its path (no name assumed): automatic at `create`, rebound when the service is created later, `pso crud:bind <module> --to <service>`, warning `PSO_CRUD_UNBOUND`, `--crud-service` when several services qualify.
- Generators: `make:crud` (complete resource in both projects, `--fields` DSL), `make:interceptor`, `make:decorator`, `make:entity`, `make:request`, `make:response`, `make:exception`, `make:client`; module forms of `make:mapper` and `make:contract`; `make:dto --response`.
- `pso structure:inspect`: read-only migration plan of a 0.1 project (moves, import / package / registration updates, decisions).
- Runtime: interceptors (`interceptors: [...]` on routes), `created()`, `noContent()`, `withStatus()`, `HttpError(status, kind, { detail, errors })`, the `conflict` problem kind (TypeScript and Java, `PsoProblemException`), a start-up warning for routes whose services are not registered.
- Studio: the orchestrator's `docs/api/*.collection.json` reference requests (no credentials; sent with the development user), orchestrator and direct-service requests told apart.
- Documentation: "Application Architecture" section (overview, orchestrator, Java service, reference CRUD, generators, structure migration), rewritten first-application and multiple-services tutorials, AI-context scopes updated.

### Changed (review when upgrading)
- `pso create service` and `pso create orchestrator` create the official structure with the reference CRUD by default; `--structure legacy` creates the 0.1 layout (with `--template empty`). Existing projects are not changed.
- A layered service gets `spring.jpa.hibernate.ddl-auto: validate`, UTC JDBC time zone, a Hikari pool size and `spring.jackson.deserialization.fail-on-unknown-properties: true`; 0.1 services keep their previous configuration byte for byte.
- `routes:inspect`, `security:policy` and `graph` show the services an action route declares (`metadata.services`) and mark routes the orchestrator answers itself.

## 0.2.0 — Cloud development ecosystem (2026-11-24)

The developer declares what the application needs; PSO resolves how resources are configured, secured, run, validated and deployed.
Migration guide: `packages/cli/docs/infrastructure/migration.md` (`pso workspace:migrate`).

### Added
- **Infrastructure engine** (`@pso/infra`, new package): declarative contract `pso.infra.json` (environments, hosts, TLS source, secret provider, identity provider, mutual TLS, container limits) and the managed `.infra/` directory. Discovery, resource graph, read-only inspection, plan, idempotent apply with atomic writes, a journal for interrupted runs, a lock, provisioning state with ownership and file hashes, drift detection and repair with backups, explicit rotation, live validation probes.
- **Security material**: development certificate authority per environment, one certificate per container with the names its clients verify, mutual-TLS client identity of the orchestrator, generated development secrets, Keycloak realm (one OIDC client per shell, redirect URIs and web origins derived from hosts, audience and scope mappers, development users), pso-dev signing key and JWKS. Production material is supplied and verified, never generated.
- **Container engine**: generated Compose topology (edge nginx, one static container per shell, orchestrator, services, one database per service, Keycloak), dependency-ordered start with health waiting, port preflight, internal/edge networks, persistent volumes, file-mounted secrets, log rotation, resource limits, selective restart and safe cleanup.
- **CLI**: `infra:init|plan|apply|repair|rotate|validate|inspect|status|hosts|token`, `docker:plan|up|down|restart|ps|logs|inspect` (and an engine-aware `docker:build`), `workspace:migrate`, `deploy --env [--dry-run]`, `deploy:plan --env`, `rollback --env`, `dev --docker|--service|--with-dependencies|--fei|--env`, `frontend:build|publish|rollback|releases --env`, `fei:register --fei|--public`, `fei:unregister --fei`, `frontend:dev --fei`, `frontend:config --fei`, `studio --ops`.
- **Multiple FEIs per workspace**, each with its own port, host, base path, authentication, OIDC client, microfrontends, runtime configuration, site and publication lifecycle; collisions (ports, hosts, base paths, MEI ownership) are errors.
- **Studio**: Infrastructure, Containers, Hosts, Certificates, Deployment and API Client areas; operations behind `--ops` with typed confirmations. The API Client sends real requests to declared targets only (no proxy), with development-user tokens, file uploads, cancellation, timeouts, masked history and collections.
- **Automatic reconciliation** after `create service|orchestrator|fei|mei`, `fei:register`, `fei:unregister`.
- **Orchestrator inbound TLS**: `PSO_HTTP_TLS_CERT_FILE`, `PSO_HTTP_TLS_KEY_FILE`, `PSO_HTTP_TLS_CLIENT_CA_FILE`.
- Documentation section "Infrastructure (0.2)" (11 pages), "Several shells" page, AI-context scope `infrastructure`.
- Reference workspace `fixtures/pso-reference` and its generator and validation scripts (`scripts/reference/`).
- **Spring security migration** in `pso workspace:migrate`: adds only the missing `PUBLIC` rules for declared public routes (dry run, backups, custom rules kept, conflicts and ambiguous patterns reported, idempotent; also runs on already-migrated workspaces).
- **Identity provider reconciliation** (`pso infra:identity`): the running Keycloak realm is compared and updated through the administration API (FEI clients, redirect URIs, web origins, roles, mappers, development users) for objects marked `pso.managed` only; sensitive changes need `--yes`, removals `--prune`; users, credentials, sessions, secrets and the realm are never reset. Routine changes are applied live after `create fei` / `fei:register` in development.
- **Remote Linux hosts over SSH**: `deploy.target: "ssh"` environments; `host:inspect`, `host:check`, `deploy:status`, `deploy:logs`, `deploy:unlock`; verified transfer (checksums on the host), image transfer by layer identity without a registry, per-environment lock, health-gated activation, automatic rollback of a failing release, `rollback --env`, volumes kept. Studio "Remote hosts" area with typed confirmations. Pinned host keys only; credentials stay in the protected credential store.
- `infra:init --users name[:scope+scope]` (default: every declared scope) and `--mtls`; `create mei --register [--public | --scopes]`; `frontend:publish --all --env`.
- Installation maintenance commands (`setup`, `integrity`, `repair`, `update`, `uninstall`) run through their own entry point and keep working when another part of the installation is damaged; an installed `pso` uses its own installation when neither `--root` nor `PSO_HOME` is given.

### Changed (review when upgrading)
- A workspace may contain several FEIs (`LoadedFrontends.feis`; `fei` remains for a single shell).
- Contradictory route security is an error: `PSO_FEI_AUTH_CONTRADICTION`, `PSO_ROUTE_PUBLIC_SCOPES`, `PSO_ROUTE_PUBLIC_AMBIGUOUS`, `PSO_ROUTE_PUBLIC_MEI` (meta spelling); warning `PSO_FEI_PUBLIC_PATH_UNROUTED`.
- `fei:register --scopes` keeps the MEI's `security.scopes` in sync.
- `make:resource --public` also declares the PUBLIC rule in the Spring service (`pso.security.rules`).
- `docker:build` uses the 0.2 topology when `pso.infra.json` exists; without it the 0.1 behaviour is unchanged.
- Shared-singleton ranges of vendored framework packages follow the installed version.

### Fixed
- False warning "controller file ignored" for kebab-case module names.
- `make:resource --public` produced a route that the service still answered with 401.
- After a FEI was added to a running environment, the edge kept serving its old certificate and nginx configuration (files replaced atomically are not seen by a running container): `docker:up` now re-creates the containers whose mounted generated configuration changed after they started (never Keycloak for a realm file change).
- Host key discovery (`connection:add`, Cloud and remote hosts) failed on Windows with OpenSSH for Windows 9.5 against OpenSSH 9.x/10.x servers (its `ssh-keyscan` proposes a key exchange it cannot perform); the candidates are now collected through `ssh` itself into a throw-away file when `ssh-keyscan` returns nothing. Nothing is pinned without the approved fingerprint.
- Kafka: publishing to a topic another instance had just created could fail with `UNKNOWN_TOPIC_OR_PARTITION`; those not-written errors are now retried briefly.
- Installed distribution: `pso` was not found in Git Bash (only `bin\pso.cmd` existed); the installer and portable ZIP now also write a POSIX launcher `bin/pso`.
- `pso repair` could not start when a file of a module the CLI loads at start (for example `@pso/infra`) was damaged.
- The Windows uninstaller removed empty entries (such as a trailing `;`) from the user's PATH; it now restores the value exactly.
- Edge forwards the public host and port, so OIDC discovery behind a non-default HTTPS port names the right endpoints.

### Compatibility
- 0.1 workspaces run unchanged; the engine is adopted with `pso workspace:migrate`, which reuses existing development certificates and keys.
- Java artifacts (`com.pso:*`) are unchanged in this release.
- Distribution: the Windows installer and portable ZIP upgrade a 0.1.x installation in place (0.1.x kept for `pso update rollback`). Neither the installer (Authenticode) nor the npm artifacts carry an official release signature in this release candidate; see `packages/cli/docs/infrastructure/release-integrity-and-signing.md`.
