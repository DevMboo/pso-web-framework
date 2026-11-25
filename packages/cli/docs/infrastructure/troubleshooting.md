---
title: Infrastructure troubleshooting
description: The infrastructure problems you will actually meet, what each message means and the fix.
order: 11
status: implemented
keywords: [troubleshooting, ports, drift, certificates, keycloak, jwks, docker, windows]
related: [infrastructure/overview, infrastructure/containers, infrastructure/resource-lifecycle]
---
## Troubleshooting table

| Symptom | Cause | Fix |
|---|---|---|
| `host port(s) already in use: 8443 (published by edge)` | another process (a local `pso dev`, another stack) listens there | stop it, or change `environments.<env>.httpsPort`; nothing was started |
| `drift: ... edited by hand since PSO generated it` | a generated file was changed | move the change into the declarations, then `pso infra:repair --env <env> --yes` (the edited copy is kept in `.infra/backups/`) |
| `cert:<name>: does not name <host>` | a host was added or renamed | `pso infra:apply` re-issues it (development); supply a new certificate (operator) |
| gateway restarts with `PSO_SEC_JWKS_HOST` | the JWKS host is not bound to the issuer | generated configurations declare `PSO_JWT_JWKS_TRUSTED_HOSTS`; for a hand-written one, add the key host there |
| a public endpoint answers 401 | the service is secure by default and has no PUBLIC rule | `pso make:resource --public` declares it; for older services add the `pso.security.rules` entry |
| a shell answers 404 | no release published in its site | `pso frontend:build <fei> --env <env>` then `pso frontend:publish <fei> --env <env>` |
| `the infrastructure of "<env>" is not up to date` (staging/production) | pending changes are never applied implicitly outside development | `pso infra:plan --env <env>`, then `pso infra:apply --env <env> --yes` |
| `needs resources that only the operator can supply` | a supplied certificate or secret is missing or invalid | `pso infra:validate --env <env>` names each one |
| `the identity provider refused the token request` | the stack is not running or the realm predates the last change | `pso docker:ps`; `pso docker:restart idp` re-imports the realm (development) |
| `cannot restrict access to <file>` (Windows) | `icacls` failed | check the permissions of the workspace directory; nothing was written |
| `another PSO process (pid ...) is changing this workspace's infrastructure` | two runs at once | wait; a lock of a process that no longer exists is taken over automatically |
| `an earlier provisioning was interrupted` | a run was killed mid-write | nothing to do: the next apply completes it |
| `--env, --with-dependencies ... use the infrastructure contract` | 0.1 workspace | `pso infra:init` or `pso workspace:migrate` |
