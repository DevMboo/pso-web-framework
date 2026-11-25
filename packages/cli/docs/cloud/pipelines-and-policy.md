---
title: Pipelines, mandatory protections and approvals
description: Which checks a project may turn off, which protections no configuration can disable, how approvals bind to a plan, and how the server's policy overrides the project.
order: 7
status: implemented
keywords: [pipeline, stages, policy, approvals, mandatory, security scan, custom stage, retention]
related: [cloud/deployment-declarations, cloud/deploy-a-release, cloud/credentials-and-security, cloud/agent-and-enrollment]
---
A PSO pipeline is an ordered list of stages declared in `PIPELINE.pso.ts`. It needs no external CI system, and it can run alongside one (see [CI/CD integration](/cloud/ci-cd-integration)).

```ts
import { definePipeline } from "@pso/deploy";

export default definePipeline({
  name: "production",
  stages: [
    { type: "integrity" }, { type: "compatibility" }, { type: "security" },
    { type: "tests", enabled: false },                       // your choice, recorded in the plan and audit log
    { type: "resources" }, { type: "build", timeoutSeconds: 1800 },
    { type: "health" }, { type: "deploy" },
  ],
});
```

Stages support ordering, `dependsOn`, `timeoutSeconds`, `onFailure` (`fail` or `continue`), environment conditions (`when`), `requiresApproval`, and structured results with a status: pending, running, passed, failed, skipped, blocked, awaiting approval or cancelled. `deploy` must be last and cannot be disabled.

## Optional versus mandatory

You may disable the optional stages: tests, the security scan, compatibility checks, extended health. The plan lists **every** disabled or omitted stage and the audit log records it. An omitted stage is never read as a pass.

These protections are part of the engine, **not stages**, and no pipeline setting can switch them off: authentication and authorization, remote identity verification, credential protection, environment binding, the deployment lock, transfer integrity of the release (the commit or checksum in the plan must match what was fetched), a valid proxy configuration (`nginx -t`), candidate readiness before traffic moves, safety-critical resource checks, and process ownership. Disabling `integrity` still leaves the commit pin and checksum check in force; the validator warns you about that.

## Honest security results

The security stage runs a built-in pattern scan for committed credentials, `npm audit` for Node services and, for Java services, **OSV-Scanner** when it is installed (the executable can be named with `PSO_OSV_SCANNER`). PSO does not ship a vulnerability database or matcher: the adapter detects the tool, runs it with a timeout and a fixed argument list, counts findings by severity and reports the database source and time (OSV is queried live, so freshness is that of the request). The server policy `scanBlockSeverity` (`none`, `critical`, `high`, `medium`, `low`) decides which severity blocks; it is set per environment, and no declaration can lower it.

Every check ends in exactly one of these outcomes, never merged:

| Outcome | Meaning |
|---|---|
| `passed` | it **ran** and found nothing blocking. The only pass |
| `failed` | it ran and found a problem |
| `unavailable` | it was supposed to run and could not: scanner not installed, advisory database unreachable, timed out, unreadable output. Reported with the reason; never a pass |
| `disabled` | a pipeline setting (or an environment filter) switched it off. Recorded in the plan and the audit log |
| `skipped` | there was nothing for it to do (for example no test steps declared) |

If any scanner of the security stage is `unavailable`, the **stage** is `unavailable` and names what ran and what did not. The server policy `requireSecurityScan` turns that into a blocker. Neither scan is a malware check or a penetration test, and no vulnerability result is ever invented.

## Approvals and the server policy

```bash
pso environment:policy production --set approvalsRequired=1 --set selfApproval=false --yes
pso release:plan production
pso release:approve production --plan 3f9c1a...
pso release:deploy production --plan 3f9c1a... --yes
```

The policy lives **on the server** and wins over the project: allowed strategies, approvals, custom stages, retention, destructive migrations, session lifetimes. A team that forbids self-approval gets a second person; a solo developer keeps `selfApproval` on. An approval is bound to the plan hash, expires, and is rechecked at start: if the branch moved, the active release changed or the policy changed, the start is refused (`PLAN_STALE`) and the latest commit is **not** deployed implicitly.

## Policy compatibility and explicit migrations

The policy belongs to the server's administrator and **fails closed**: a capability the installed agent gained after the policy was written (the `static` strategy for frontends, for example) is refused until someone with authority permits it. An agent upgrade never changes the policy.

```bash
pso environment:policy production --compat
pso environment:policy production --migrate allow-static-frontends
pso environment:policy production --migrate allow-static-frontends --yes
pso environment:policy production --history
pso environment:policy production --revert <entry> --yes
```

`--compat` lists what the agent can do, what the policy permits, the policy version, the unsupported strategies and the pending migrations. `--migrate <id>` without `--yes` only previews: the permissions it would add in words and the exact difference (`allowedStrategies: ["blue-green","rolling","recreate"] -> [..., "static"]`). With `--yes` it applies exactly that difference: the request carries the digest of what was previewed, so a policy that changed in between is refused. It needs the superadministrator role and writes an audit record (`policy.migrated`) and a history entry holding the policy as it was. `--revert` restores the previous values of the keys that entry changed, only while they still hold the value the entry set (`policy.reverted`). Studio's Cloud section shows the same compatibility, read-only, with the command to run. The server also reports a policy version it does not understand and then refuses to act on it.

A static frontend also needs the web server to read its files. The plan refuses (before anything is copied) when a directory of the site root cannot be traversed by other users, which is the case below a home directory with mode 750. The administrator creates a readable directory and sets `--set staticRoot=/srv/pso-sites`.

## Custom stages

A custom stage is an argv array that the agent runs without a shell, as its unprivileged user, in the release workspace. It runs only when the server policy sets `allowCustomStages`; project code cannot weaken any mandatory check.

## What can go wrong

A stage that depends on one that failed is *blocked*, not skipped. `onFailure: continue` is refused for `integrity`, `resources` and `deploy`. Retention keeps the newest releases but **never deletes the active, previous or last known-good release**, whatever `keep` says.
