---
title: Security auditing
description: What pso security:check, security:audit and security:policy examine, every finding id, real findings with their fixes, and how to run them in CI.
order: 9
keywords: [audit, security:check, security:audit, findings, SEC001, SEC005, ci]
related: [security/checklist, security/secrets, devops/ci-cd, security/secure-routing]
---
Audits examine **real files and configuration**, never assumptions, and print findings with severity, resource and remediation. They never print secrets.

## `pso security:check`

Exit code `1` on high or critical findings (`--strict` also fails on medium).

| Id | Severity | Finding |
|---|---|---|
| SEC001 | critical | private key material in a file that is not git-ignored |
| SEC003 | medium | private key file readable by group or others (POSIX) |
| SEC004 | high / info | public state-changing route / list of public routes |
| SEC005 | high | `jwt` guard used but issuer, audience or key source not configured |
| SEC006 | high / critical / medium | Spring chain without `anyRequest().authenticated()`, `anyRequest().permitAll()`, or `permitAll()` beyond health |
| SEC007 | high | JWKS fetched over plain http |
| SEC008 | high | secret stored as plain text in configuration |
| SEC009 | medium | `server.host` binds all interfaces |
| SEC010 | high | hard-coded credential in service configuration |
| SEC011 | high | route registry invalid (`PSO_ROUTE_*` / `PSO_MODULE_*`) |

### Real findings, and what to do

A fresh orchestrator with a guarded route and no JWT settings (expected):

```text evidence="expected"
HIGH     SEC005 gateway
         jwt guard is used but security.authentication.issuer, security.authentication.audience, a key source (security.authentication.jwks.uri or security.authentication.publicKey.file) is not configured for "production"; the orchestrator will refuse to start
         fix: Declare security.authentication.* in pso.config.json (or set the PSO_JWT_* environment variables); the legacy security.jwt.* keys are still read
FAILED
```

Fix: set `PSO_JWT_ISSUER`, `PSO_JWT_AUDIENCE` and a key source ([running the environment](/getting-started/running)). Re-run: with them in place a clean workspace prints `OK` (expected).

A private key that is not ignored (expected):

```text evidence="expected"
CRITICAL SEC001 keys/k-20261108-21b1a884.private.pem
         private key material is stored in a file that is not git-ignored
         fix: Remove it from the repository history, rotate the key (pso security:rotate) and ignore the keys directory
FAILED
```

Fix: add `keys/*.private.pem` to `.gitignore`; if it was ever committed, treat the key as compromised and rotate ([keys](/security/keys-and-pem)).

## `pso security:audit`

Runs `npm audit` for Node services (needs a lockfile and network) and scans POMs for SNAPSHOT and version-range dependencies. It reports `skipped` when it cannot run and **does not scan Maven dependencies for CVEs**; the command says so in its output.

## `pso security:policy`

Prints the effective authorization policy: every route's access, guards and scopes, and whether each Spring service is deny-by-default (verified output on [Secure routing](/security/secure-routing)).

## Running them in CI

```yaml
- run: pso validate
- run: pso security:check --strict
- run: pso security:audit
- run: pso config:validate
```

`security:check` and `validate` need no dependencies installed and no running services, so they are cheap to run on every pull request ([CI/CD](/devops/ci-cd)). `security:audit` needs the network.

## What an audit cannot tell you

A clean result means the checked rules hold. It does not prove the identity provider is configured well, that scopes are the right ones, or that business authorization is correct. Pair it with review ([checklist](/security/checklist)).

## Common mistakes

- Treating `OK` as a security review.
- Running `security:check` only locally.
- Ignoring `info` findings: the list of public routes is the thing a reviewer should read.

## Next steps

- [Production checklist](/security/checklist)
- [Secure routing](/security/secure-routing)
