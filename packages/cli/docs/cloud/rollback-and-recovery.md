---
title: Rollback, interruption and recovery
description: How a deployment survives a closed laptop, what INTERRUPTED means, how recovery decides without replaying steps, and what rollback does and does not undo.
order: 8
status: implemented
keywords: [rollback, recovery, interrupted, lock, durable state, cancel, history, known-good]
related: [cloud/deploy-a-release, cloud/pipelines-and-policy, cloud/troubleshooting, cloud/credentials-and-security]
---
The authoritative state of a deployment is a file on the **server**, written by a worker process that is detached from your session. Close Studio, lose Wi-Fi, shut the laptop: the deployment continues, and reconnecting shows where it really is.

```bash
pso release:deploy production --no-follow --yes
pso release:status production
pso release:history production --limit 10
```

## States

`REQUESTED, PLANNING, VALIDATING, PREPARING, BUILDING, STARTING_CANDIDATE, VERIFYING_CANDIDATE, SWITCHING_TRAFFIC, VERIFYING_ACTIVE_RELEASE, DRAINING_PREVIOUS_RELEASE, COMPLETED`, plus the outcomes `FAILED`, `CANCELLED`, `ROLLED_BACK`, `INTERRUPTED` and `RECOVERING`. Each transition is a checkpoint in the deployment file and an audit entry.

## Manual rollback

```bash
pso release:rollback production --yes
```

The previous release (or one named with `--to`) is brought back with the same sequence: start it in a new slot, verify readiness, switch nginx, verify through the proxy, then drain the one being replaced. It needs no build, because the release directory is kept. The plan told you before the deployment whether rollback was possible. If a deployment fails after traffic moved, PSO restores the earlier proxy configuration automatically while the earlier release is still running (`autoRollback`, on by default).

## Interrupted deployments

If the worker dies (a crash, a reboot, `kill -9`), the deployment is reported as `INTERRUPTED` and its lock is *stale*. PSO **never takes a stale lock silently**, and a new deployment is refused until you decide:

```bash
pso release:recover production --yes
```

Recovery inspects what really exists instead of replaying steps: which release nginx is serving (a marker in the managed file), which candidate processes are alive and healthy, what the recorded active release is.

| What it finds | What it does |
|---|---|
| Traffic never moved | stops the candidate; the active release was never touched (`interrupted-before-switch`) |
| Traffic moved and the candidate is healthy | completes forward: drains the previous release, records the new one |
| Traffic moved and the candidate is unhealthy | restores the previous proxy configuration, stops the candidate |
| Anything else | changes nothing and reports `needs-operator` |

```text evidence="expected"
interrupted-before-switch: interrupted before traffic moved: the active release was never touched; the candidate was stopped
```

## Cancel

`pso release:cancel production --deployment <id> --yes` stops at the next safe point. After traffic moved, cancelling is refused because it would leave a mixed state; use rollback.

## What can go wrong

- **Rollback does not undo database changes.** The plan states this when migrations are involved, and you should design migrations as expand-then-contract so the previous release still works.
- A rollback target must still be kept: retention never removes the active, previous or last known-good release, but older ones go.
- `needs-operator` means two views of the world disagree (for example nginx serves a release neither the state nor the deployment explains). PSO stops rather than guess.
- Connection loss during a *change* is never retried automatically: the CLI says the result is uncertain and tells you to read the status. Reads reconnect a bounded number of times.
