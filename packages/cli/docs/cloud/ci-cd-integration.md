---
title: Integrating with external CI/CD
description: Use PSO's deployment engine from GitHub Actions, GitLab CI or any pipeline without duplicating deployment logic, and keep credentials out of the CI configuration.
order: 12
status: implemented
keywords: [ci, cd, github actions, gitlab, automation, non-interactive, json, exit codes]
related: [devops/ci-cd, cloud/deploy-a-release, cloud/pipelines-and-policy, cloud/credentials-and-security]
---
PSO's pipeline is native, but it does not replace the CI you already use. A CI job builds and tests however it likes, then asks PSO to deploy. The deployment logic (plan, candidate, switch, rollback) stays in one place: the agent.

## The commands are automation friendly

- `--json` prints machine-readable output on every command.
- Exit codes: `0` success, `1` failure, `2` usage error (nothing changed), `3` an action needs explicit authorization (`--yes`), `4` the caller's role is not enough.
- Nothing prompts when standard input is not a terminal. Secrets come from standard input.
- `--dry-run` is available where it applies, and `release:plan` is always a dry run.

```bash
pso release:plan production --commit 9b3c1f0a5d7e2c4b6a8f0e1d3c5b7a9f2e4d6c8b --json
pso release:deploy production --commit 9b3c1f0a5d7e2c4b6a8f0e1d3c5b7a9f2e4d6c8b --yes
```

Deploying an exact `--commit` (the one the CI job just built and tested) removes any doubt about what goes live.

## A CI client is a client like any other

Create a dedicated identity instead of sharing yours:

```bash
pso environment:access production --invite deployer --minutes 15
```

Enroll the CI runner with that single-use token (`pso agent:enroll prod` with the token on standard input) on a runner that has a protected credential store, or use the `encrypted-file` provider with the passphrase held in the CI system's secret manager. The enrolled key lives in the runner's credential store; revoke it with `pso environment:access production --revoke <client-id>` when the runner is retired. Give the CI identity the `deployer` role, not `admin`.

```yaml
# GitHub Actions (illustrative)
- name: Deploy
  run: |
    printf '%s' "$ENROLLMENT_TOKEN" | pso agent:enroll prod
    pso release:deploy production --commit "$GITHUB_SHA" --yes --json
  env:
    PSO_CREDENTIAL_PROVIDER: encrypted-file
    PSO_CREDENTIAL_PASSPHRASE: (the value of a secret in your CI secret store)
    ENROLLMENT_TOKEN: (the single-use token, also from the CI secret store)
```

## Approvals still apply

If the server policy requires an approval by someone other than the proposer, the CI job plans, a person approves (`pso release:approve production --plan <hash>`, or in Studio), and the job (or a second job) deploys with `--plan <hash>`. The approval is bound to the plan hash, the commit and the policy, and expires.

## What can go wrong

- *Exit code 3*: you forgot `--yes`. Automation must say it explicitly.
- *`PLAN_STALE`*: the branch moved between planning and deploying. Pin `--commit`.
- *`LOCKED`*: another deployment of the same application is running; two pipelines must not race for one environment.
- A CI runner needs outbound SSH to the server. PSO opens no inbound path; if a bastion is required, register the connection with `--jump`.
- `--json` output contains no secrets, but it is still a record of your infrastructure; treat CI logs accordingly.
