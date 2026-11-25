---
title: Secrets
description: Keep secrets out of source, configuration, images and output - how PSO enforces each rule, what the failures look like, and how to supply secrets in development and production.
order: 5
keywords: [secrets, env, redaction, dockerignore, references, PSO_CONFIG_PLAINTEXT_SECRET, SEC010]
related: [concepts/configuration, security/auditing, devops/logging, decisions/dev-or-production-config]
---
| Rule | How PSO enforces it |
|---|---|
| No secrets in configuration files | Secret-looking keys must be references (`${env:NAME}`, `${secret:NAME}`, `${file:path}`); a literal is `PSO_CONFIG_PLAINTEXT_SECRET` |
| No secrets in output | `pso config:show` prints `***REDACTED***`; Studio and AI contexts scrub tokens, JWTs, private keys and `password=` style assignments; the orchestrator and Spring JSON logs redact them too |
| No secrets in Spring YAML | `pso security:check` reports hard-coded credentials (`SEC010`); generated YAML uses `${DB_PASSWORD}` |
| No secrets in images | the generated `.dockerignore` excludes `keys`, `*.pem`, `.env` |
| No secrets in git | `pso security:keys --generate` adds `keys/*.private.pem` to the workspace `.gitignore`; the orchestrator's `.gitignore` lists `.env` |
| Required secrets are required | the generated Compose file uses `${PSO_JWT_ISSUER:?...}` so a missing value stops start-up instead of starting insecurely |

## What a violation looks like

A literal password in the orchestrator's configuration, then `pso config:validate` (Expected output):

```text evidence="expected"
ERROR   PSO_CONFIG_PLAINTEXT_SECRET gateway/pso.config.json: "database.password" looks like a secret stored as plain text
        hint: Reference it instead: "${env:NAME}" or "${secret:NAME}"
FAILED
```

and a reference is accepted and shown as a reference, not resolved:

```text evidence="expected"
$ pso config:show --service gateway
security.jwt.publicKeyFile         "${env:PSO_PUBKEY}"  <- service
```

The same `database.password` key also produced an `Unknown configuration key` warning in that run, because `database.*` is not an orchestrator key: the check for secrets looks at key *names*, whether or not the key is known.

If you remove the `keys/*.private.pem` line from `.gitignore` and run `pso security:check` (expected):

```text evidence="expected"
CRITICAL SEC001 keys/k-20261108-21b1a884.private.pem
         private key material is stored in a file that is not git-ignored
         fix: Remove it from the repository history, rotate the key (pso security:rotate) and ignore the keys directory
FAILED
```

## Where secrets come from

| Environment | Source |
|---|---|
| local development | `gateway/.env` (git-ignored; loaded by `npm run dev` through Node's `--env-file-if-exists`); for Spring, environment variables |
| CI | the CI system's secret store, injected as environment variables |
| production | your platform's secret manager injected as environment variables or files; Kubernetes `Secret` references, ECS `valueFrom`, Key Vault, Secret Manager (see [cloud descriptors](/devops/cloud-descriptors)) |

A secret that must be a file (a private key, a trust store password file) is referenced by path: `${file:path}`; PSO never copies it.

## If a secret leaks

1. Treat it as compromised: rotate it at its source (for signing keys `pso security:rotate`; for passwords, the database or provider).
2. Remove it from history if it was committed, and invalidate anything it protected.
3. Search logs for it (`pso` redacts known patterns, but custom formats can slip through).

## Common mistakes

- Putting a secret in `application.yml` "for the demo".
- Printing configuration in a bug report without checking it (`config:show` redacts, but your own output may not).
- Baking `.env` into an image (the generated `.dockerignore` excludes it; keep that line).
- Assuming redaction makes it safe to log request bodies. It is a safety net, not permission.

## What is not provided

A secret store, rotation of application secrets and encryption of payloads at rest. For encrypted payloads use authenticated encryption from a vetted library with explicit key management; PSO does not ship one.

## Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `PSO_SEC_PEM_PATH`: "public key file not found or not a regular file" | the path is wrong, or relative to a different working directory than you assumed | the path printed in `detail` | use an absolute path in deployments; keep it in one `.env` |
| a typo in a setting name changes nothing | unknown keys are ignored at run time | `pso config:validate` prints `PSO_CONFIG_UNKNOWN_KEY` as a warning (exit 0) | fix the spelling; fail CI on `WARNING` lines |
| a secret appears in `pso config:show` output | it is under a key name the redaction does not recognise | the output | store secrets as `${env:NAME}` references |
| a private key is committed | `keys/*.private.pem` is ignored by the generated `.gitignore`, other paths are not | `git status` | remove it from history, rotate the key (`pso security:rotate`) |

The first two rows were reproduced: [Why the orchestrator refuses to start](/reference/startup-failures).

## Next steps

- [Configuration resolution](/concepts/configuration)
- [Security auditing](/security/auditing)
