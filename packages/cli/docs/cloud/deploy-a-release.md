---
title: Deploy a release
description: Plan, approve and run a blue-green deployment of Node orchestrators and Java services, update one service on its own, and understand the conditions zero downtime depends on.
order: 6
status: implemented
keywords: [deploy, blue-green, rolling, recreate, release, git, orchestrator, java, zero downtime, plan]
related: [cloud/deployment-declarations, cloud/pipelines-and-policy, cloud/rollback-and-recovery, cloud/nginx-and-existing-infrastructure]
---
Every deployment starts with a plan you can read. The plan names the server, the services, the commit, the strategy, the expected availability impact, resource needs, configuration changes, which checks are on and off, the permissions needed and whether rollback is possible.

```bash
pso release:plan production
pso release:deploy production --yes
```

## What happens, in order

1. **Plan.** The server inspects itself and resolves `branch: main` to an immutable commit. The commit, not the name, is recorded and deployed. The plan has a hash; approvals bind to it.
2. **Validate.** Environment binding, the deployment lock (one deployment per application), nginx baseline, secrets and resources are checked. These are mandatory and are not pipeline stages.
3. **Prepare.** A new, isolated release directory is created and exactly that commit is fetched into it (never `git pull` in a running release). A manifest with a tree hash is written.
4. **Pipeline stages.** Integrity, compatibility, security, tests and build run as configured, **while the active release keeps serving**.
5. **Start the candidate** in its own slot: its own process identity, port and log.
6. **Verify the candidate.** Readiness must pass (consecutive probes). A candidate that is not ready never receives traffic.
7. **Switch traffic.** The new nginx configuration is validated with `nginx -t`, written, and applied with one graceful reload.
8. **Verify the active release** through the proxy: responses must carry the new release id.
9. **Drain and stop the previous release**, honoring each service's declared shutdown grace plus a margin, then keep it as the rollback target.

```text evidence="expected"
deployment dmz4k1x2 started on the server (release r20261114223601-ce58a814)
  VALIDATING  [integrity:passed compatibility:passed security:passed tests:skipped resources:passed build:running]
  VERIFYING_CANDIDATE
  SWITCHING_TRAFFIC
  VERIFYING_ACTIVE_RELEASE
  COMPLETED
```

If anything fails before step 7 the candidate is stopped and the active release was never touched. If step 8 fails, the previous nginx configuration is restored while the previous release is still running.

## A Node orchestrator and a Java service, independently

Give the Java service a stable loopback address with `internalPort`, and the orchestrator finds it there while releases are swapped behind it:

```ts
// deploy/production.deployment.pso.ts for the catalog repository
service: { name: "catalog", runtime: "java", build: [["mvn", "-B", "-DskipTests", "package"]],
  start: ["java", "-jar", "target/catalog.jar", "--server.port={port}"],
  health: { readyPath: "/actuator/health", timeoutSeconds: 120 }, shutdownGraceSeconds: 30, internalPort: 21001 }
```

The orchestrator's declaration sets `env: { CATALOG_URL: "http://127.0.0.1:21001" }`. Deploying a new catalog changes nothing in the orchestrator, and the orchestrator is neither rebuilt nor restarted. `pso release:service production restart catalog --yes` restarts one service; PSO signals only processes it started and can prove it started.

## Choosing a strategy

| Strategy | Use when | Honest limits |
|---|---|---|
| `blue-green` | HTTP applications behind nginx | needs memory and ports for two releases; old and new versions overlap briefly |
| `rolling` | 2 or more instances of every service | mixed versions serve together while it runs |
| `recreate` | constrained servers or incompatible workloads | **downtime**, stated in the plan before you confirm |

## What can go wrong

Zero downtime needs: schema changes that both versions tolerate (expand, then contract later), consumers and schedulers that tolerate two versions running briefly, enough resources, and a working `nginx -t`. Long-lived WebSocket connections end on the old release when it stops and must reconnect. Rolling back the application does not roll back the database. PSO never runs destructive migrations without an explicit approval in the declaration **and** a server policy that allows them, and it does not claim exactly-once delivery for any broker: coexisting consumers are your design problem, flagged in the plan.
