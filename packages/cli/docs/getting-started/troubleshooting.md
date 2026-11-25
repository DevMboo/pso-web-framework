---
title: Troubleshooting
description: The problems developers meet first - each with symptoms, likely causes, the command that tells them apart, the fix, how to verify it and how to prevent it.
order: 12
keywords: [errors, fix, problems, 401, 404, 503, PSO_ROUTE, PSO_MODULE, port, git bash]
related: [reference/diagnostics, reference/troubleshooting, orchestrator/routes, tutorials/local-debugging]
---
Start every investigation the same way, from the workspace root:

```bash
pso validate          # structure, routes, contracts: static, never runs your code
pso services:health   # which services answer right now
pso security:check    # configuration and policy findings
```

Then match the symptom below. For broker, outbox, Spring and upstream failures use the broader [troubleshooting by symptom](/reference/troubleshooting).

## A decorated method answers 404

- **Symptom.** `DELETE /customers/1` (or any method you wrote in a controller) returns `404 PSO_HTTP_NOT_FOUND`.
- **Cause.** Decorators never expose an endpoint. The route must be declared in `ROUTES.pso.ts`.
- **Diagnose.** `pso routes:list`: the route is missing from the table.
- **Fix.** `pso make:route <module> <action> --method DELETE --path /:id --service <orchestrator>` (it edits the controller and the registry together).
- **Verify.** `pso routes:list` shows it; the request no longer answers 404 (it answers 401 until you send a token).
- **Prevent.** Add routes with the generator; review `ROUTES.pso.ts` in code review, it is the exposure list.

Verified: a decorated `@Delete` that is absent from the registry answers `404` with `"code":"PSO_HTTP_NOT_FOUND"`.

## Every guarded request returns 401

- **Symptom.** Valid-looking tokens are refused.
- **Likely causes.** No key source configured; issuer or audience differ from the token; the algorithm is not allowed; the token expired.
- **Diagnose.** The orchestrator logs why: `WARN [security] authentication failed reason=...` (for example `missing_header`). Compare the token's `iss`, `aud`, `alg` and `exp` with `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE`, `PSO_JWT_ALGORITHMS`.
- **Fix.** Correct the verifier configuration or obtain a token that matches. Never disable verification to clear a `401`.
- **Verify.** The same request returns `200` or the service's answer.
- **Prevent.** `pso security:check` reports a missing configuration before you start (`SEC005`).

## 403 with a valid token

- **Cause.** The token lacks the scope or role the route declares.
- **Diagnose.** The log line names it: `authorization denied  missing=scope:customers:read route="GET /customers"`.
- **Fix.** Grant the scope at the identity provider, or correct the route's `scopes`. Do not make a protected route public.

## 503, 502 or 504 from the orchestrator

- **Meaning.** `503` the upstream could not be reached; `504` it did not answer in time; `502` unknown service or an invalid answer.
- **Diagnose.** `pso services:health`; the service's own log (`.pso/logs/<service>.log`) with the same correlation id; the `metadata.service` of the route versus the services in `pso.workspace.json`.
- **Fix.** Start or repair the service, correct its port or health path, or raise a justified timeout (`http.limits.upstreamTimeoutMs`).
- **Verify.** `pso services:health` exits 0; repeat the request.

## The orchestrator refuses to start

- **Symptom.** `ERROR startup failed ... diagnostics=["PSO_ROUTE_004"]` and exit code 1. Nothing is listening.
- **Diagnose.** `pso validate` prints the full message with Expected and Found.
- **Common codes.**

| Code | Meaning | Fix |
|---|---|---|
| `PSO_MODULE_001` / `002` | a module folder lacks `MODULE.pso.ts` or `ROUTES.pso.ts` | create it; there is no fallback discovery |
| `PSO_MODULE_003` | a controller file exists but is missing from `controllers` | add it to `MODULE.pso.ts` |
| `PSO_MODULE_006` / `007` | a provider dependency cannot be resolved / a cycle | add the provider or import the module; break the cycle |
| `PSO_ROUTE_004` / `005` | the declared method or path does not match the decorators | make them agree (the message shows both) |
| `PSO_ROUTE_007` | no security policy, or both public and guarded | give the route exactly one |
| `PSO_DTO_INVALID` / `PSO_DTO_VALIDATOR_UNREGISTERED` | a DTO is undecorated or a validator is not a provider | see [DTO validation](/orchestrator/dto-validation) |

- **Prevent.** Run `pso validate` in CI; it is fast and needs no dependencies.

## Port already in use

- **Symptom.** `pso dev` stops with `port N is already in use`.
- **Diagnose.** Windows: `netstat -ano | findstr :N`; macOS/Linux: `lsof -i :N`. A language server or another project may hold it.
- **Fix.** Stop that process if it is yours, or choose another port in `pso.workspace.json` (new services: `--port`). Do not stop a process you do not recognise.
- **Verify.** `pso dev` starts.

## `/customers` becomes `C:/Program Files/Git/customers`

- **Cause.** Git Bash rewrites arguments that begin with `/`.
- **Fix.** Use PowerShell, or `MSYS_NO_PATHCONV=1 pso ...`.

## PSO_CONTRACT_DRIFT

- **Cause.** The gateway contract and its mirror inside the service differ.
- **Fix.** Regenerate with `pso make:resource <name> --force` (review the diff first) or update both copies.
- **Prevent.** Change contracts only through one side and re-run `pso validate`.

## Docker or Maven cannot build

- `docker:build` says the daemon is not running: start Docker Desktop. Nothing was built.
- Maven cannot resolve `com.pso` artifacts: run `pso java:install` for local development. Container builds need those artifacts in a repository the build can reach ([Docker](/devops/docker)).
- Cannot find module `@pso/http` after moving the repository: generated projects reference the checkout by absolute path; fix the `file:` paths in `package.json` and run `npm install`.

All diagnostic codes are listed in the [diagnostics reference](/reference/diagnostics). The [local debugging tutorial](/tutorials/local-debugging) walks through the checks in the order that narrows a failure fastest.

## Common mistakes while troubleshooting

- Changing three things at once: change one, re-run `pso validate`, then look at the log.
- Disabling a security check to "see if that is it".
- Debugging the network before reading the first diagnostic of `pso validate`.
