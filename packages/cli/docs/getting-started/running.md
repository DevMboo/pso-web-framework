---
title: Running the environment
description: Start, monitor and stop the whole workspace with pso dev, including JWT configuration, what each log line means, how to check health, and how to recover from the failures you will meet first.
order: 11
keywords: [pso dev, jwt, env, run, services:health, logs, smoke]
prerequisites: [A workspace with at least an orchestrator]
related: [devops/development-environment, security/authentication, devops/logging, tutorials/local-debugging]
---
## 1. Configure the orchestrator's guard

The `jwt` guard denies everything until it knows whom to trust. Generate a key pair and point the guard at the public key:

```powershell
pso security:keys --generate --alg ES256
```

Real output (verified; the key id is specific to the run):

```text evidence="verified"
generated k-20261108-21b1a884 (ES256); private key: keys\k-20261108-21b1a884.private.pem (owner-only ACL applied); public JWKS: keys\jwks.json
active    k-20261108-21b1a884  ES256  2026-11-08T14:56:58.368Z
```

> [!NOTE]
> The command appends `keys/*.private.pem` to the workspace `.gitignore` for you (expected), and the orchestrator's own `.gitignore` already lists `.env`. Check `git status` before your first commit anyway: a private signing key in version control must be treated as compromised.

Create `gateway/.env` (git-ignored by the orchestrator's own `.gitignore`; loaded automatically by `npm run dev`):

```text evidence="expected"
PSO_JWT_ISSUER=https://my-platform.local
PSO_JWT_AUDIENCE=my-platform-api
PSO_JWT_PUBLIC_KEY_FILE=../keys/<kid>.public.pem
PSO_JWT_ALGORITHMS=ES256
```

Use `PSO_JWT_JWKS_URI` instead of `PSO_JWT_PUBLIC_KEY_FILE` when an identity provider publishes a JWKS. Spring services read `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` and `PSO_JWT_ALGORITHMS` too, but **not** `PSO_JWT_PUBLIC_KEY_FILE`: a Spring service needs `PSO_JWT_JWKS_URI` (plain `http` is accepted only for loopback, so in development serve `keys/jwks.json` on `127.0.0.1`; see [Build a CRUD API](/tutorials/crud-api) for a ten-line script). For the orchestrator alone, the variables above are the whole development configuration; in production see [security configuration](/security/security-configuration).

## 2. Start

```powershell
pso dev
```

Expected output (the layout comes from the command; the addresses are those of your workspace):

```text evidence="expected"
Starting 2 service(s)...

Ready:
  catalog            http://127.0.0.1:8081      READY/UP
  gateway            http://127.0.0.1:3000      READY/UP

Press Ctrl+C to stop.
```

What `pso dev` does, in order:

1. validates the workspace (`pso validate`) and stops if it fails;
2. checks that every port is free;
3. starts services in dependency order (a service listed in another's `dependsOn` starts first);
4. waits until each service's health path answers;
5. monitors them every 5 seconds;
6. writes each service's output to `.pso/logs/<service>.log`;
7. on Ctrl+C stops everything in reverse order.

Options (verified from `pso dev --help`): `--only a,b` starts just those services, `--install` runs `npm install` where needed, `--timeout 120` sets the seconds to wait for readiness, `--smoke` starts everything, checks it and stops (useful in CI).

## 3. Look around

```powershell
pso services:health
pso routes:list
pso studio
```

`services:health` probes every declared service and exits with code 1 if any is down. `pso studio` opens the local dashboard (loopback only, with a one-time token in the URL).

Read a service's log:

```powershell
Get-Content .pso\logs\gateway.log -Tail 20 -Wait
```

The orchestrator's lines look like this (Expected output; `PSO_LOG_FORMAT=json` gives one JSON object per line instead; see [Logging](/devops/logging)):

```text evidence="expected"
2026-11-08 14:54:30.537 INFO  [http] orchestrator listening  host=127.0.0.1 port=3000 routes=4 modules=2
2026-11-08 14:54:30.643 WARN  [security] authentication failed  reason=missing_header route="GET /customers"
```

## 4. Make a first authenticated request

Mint a token with the private key from step 1 using your usual JWT tool (claims: `iss` and `aud` as configured, a `scope` claim such as `customers:read`, a short `exp`). Then:

```bash
curl -i http://127.0.0.1:3000/customers -H "authorization: Bearer $TOKEN"
```

Without the token, or with a wrong one, the answers are exactly those shown in [First endpoint](/getting-started/first-endpoint): `401`, `403`, and `503` when the service behind is down.

## 5. Troubleshooting: when it does not start

| What you see | Cause | Fix and verification |
|---|---|---|
| `port N is already in use` | another process owns the port | change the port in `pso.workspace.json` (to find the process on Windows run `netstat -ano` and look for the port), then run `pso dev` again |
| `dependencies are not installed` | `npm install` was not run in the orchestrator | pass `--install` or run `npm install` in `gateway/` |
| a service is `DOWN` after the timeout | it started but its health path does not answer | read `.pso/logs/<service>.log`; for Spring check the active profile and the `PSO_JWT_*` settings |
| every guarded request is `401` | the guard has no key source, or issuer/audience differ from the token | read the orchestrator's `security initialized` line and the `authentication failed reason=...` warnings; compare with the token's claims |
| `startup failed ... diagnostics=["PSO_..."]` | the route registry or security configuration is invalid | run `pso validate`; fix the first diagnostic |
| the Spring service stops with a missing configuration message in prod | production requires JWT settings | set `PSO_JWT_JWKS_URI`, `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` |

After any fix the check is the same: `pso services:health` exits 0 and `GET /health/ready` answers `200`.

## 6. Good practice

- Keep one terminal for `pso dev` and use `pso services:health` from another.
- Use `PSO_LOG_LEVEL=debug` on one service while you investigate, not everywhere.
- Do not commit `.env`, `.pso/` or private keys (`keys/*.private.pem`).
- Use `--only` to work on one service without starting the rest.

## Next steps

- [Development environment](/devops/development-environment)
- [Diagnose a local workspace](/tutorials/local-debugging)
- [Authentication](/security/authentication)
