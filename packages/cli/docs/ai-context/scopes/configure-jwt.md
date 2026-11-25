---
title: Task: configure JWT
description: Exact steps to configure token validation without exposing secrets.
order: 25
scope: configure-jwt
base: false
requires: [security]
keywords: [ai, task, jwt, jwks, pem]
---
0. A workspace managed by the infrastructure engine (`pso.infra.json`) does not need steps 1 to 4: `pso infra:init --identity keycloak --runtime docker [--users "ana,bob:products:read"]` declares the identity provider, `pso docker:up` generates the issuer, audience and key source of every project into `.infra/`, and `pso infra:token --user <name>` returns a development token. Use `identity.provider: "external"` for an existing provider. Never write these values into source. Steps 1 to 4 apply to a project run as a process without `pso.infra.json`.
1. Ask the user which identity provider issues tokens: you need its **issuer**, the **audience** for this API and its **JWKS URI** (https). Do not invent them.
2. Orchestrator: set `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, `PSO_JWT_JWKS_URI`, optionally `PSO_JWT_ALGORITHMS` (for example `ES256`) in `<orchestrator>/.env` (git-ignored) or the process environment.
3. Spring services: provide the same four variables to every service.
4. Local development of a process without a provider: `pso idp:dev init` and `pso idp:dev token --scopes <scopes>`, or `pso security:keys --generate --alg ES256`; then use `PSO_JWT_PUBLIC_KEY_FILE=../idp/keys/<kid>.public.pem` (idp:dev) or `../keys/<kid>.public.pem` (security:keys) with `PSO_JWT_ALGORITHMS=ES256`. These keys are for development only. Never read, print or commit `*.private.pem`.
4b. The same values may be declared in `pso.config.json` under `security.authentication.*` (the variables override it). Do not add JWT verification code to the project: it belongs to `@pso/security`.
5. `pso config:validate` and `pso security:check` must pass (SEC005 means security is not configured and the orchestrator will refuse to start). A bad configuration stops start-up with `PSO_SEC_*` codes.
6. Verify behavior: no token `401`; expired, wrong issuer, wrong audience or wrong signature `401`; missing scope `403`.
7. Never switch to a symmetric algorithm (`HS256`), never accept `alg: none`, never put a plain-http JWKS in production.
