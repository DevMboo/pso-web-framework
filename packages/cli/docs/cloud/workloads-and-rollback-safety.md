---
title: Workloads, messaging and rollback safety
description: What PSO checks when an old and a new release run side by side - scheduled jobs, self-migrating services, message consumers, outbox relays and WebSocket connections - and what an application rollback can and cannot undo.
order: 18
status: implemented
keywords: [workload, flyway, migration, expand-contract, scheduled jobs, kafka, rabbitmq, outbox, websocket, at-least-once, rollback, forward-only]
related: [cloud/deploy-a-release, cloud/rollback-and-recovery, cloud/pipelines-and-policy, dispatch/outbox]
---
> [!STATUS]
> **Implemented and verified** as planning rules (`workload-safety.test.ts`) and, for the Flyway case, in the real-application run (an additive migration applied while the previous release served; an application rollback with the schema one version ahead). PSO **cannot see inside your application**: these checks act on what the declaration says. A declaration that omits a workload is not protected against it.

Blue-green and rolling deliberately run two releases at once. That is what keeps the service available, and it is also what makes some workloads unsafe. Say what each service does in `workload`:

```ts
service: {
  name: "orders", runtime: "java", start: ["java", "-jar", "app.jar"],
  workload: {
    scheduledJobs: "leader-elected",     // "none" | "leader-elected" | "singleton"
    selfMigrates: true,                  // Flyway (or similar) runs when the application starts
    consumers: ["kafka"],                // "dispatch" | "kafka" | "rabbitmq" | "redis"
    orderedConsumption: false,
    outbox: true,
    channels: false,
  },
}
```

## What the plan refuses

| You declared | With blue-green or rolling | Why |
|---|---|---|
| `scheduledJobs: "singleton"` | **blocked** | every instance runs the jobs, so they would run twice during the overlap. Make them leader-elected, or use `recreate` with `downtimeAcknowledged` |
| `orderedConsumption: true` | **blocked** | ordering needs one active consumer; two releases consume at once |
| `selfMigrates: true` without `migrations.mode: "expand-contract"` | **blocked** | the migration runs when the candidate starts, *while the previous release still serves*: it must be additive |
| `selfMigrates: true` with a destructive migration | **blocked**, even when approved | it would break the release that is still serving |
| a destructive migration (any strategy) | blocked until `approvedDestructive` **and** the server policy allows it | irreversible changes need explicit authorization |

`recreate` never overlaps, so none of the overlap rules apply to it. PSO does not silently turn a blocked blue-green into a recreate: you choose, and you acknowledge the downtime.

## What the plan states (and does not promise)

- **Messaging stays at-least-once.** While two releases overlap they consume from the same subscription and the broker rebalances; handlers must be idempotent. PSO does not provide exactly-once delivery and does not promise zero downtime for consumer rebalancing.
- **Outbox**: the outbox guarantees no loss, not no repetition; two relays may publish the same row during an overlap.
- **Channels/WebSocket**: connections to the previous release are closed when it stops after the drain; clients must reconnect.
- **Migrations**: concurrent starts are serialized by the migration tool's own database lock, not by PSO. PSO's `migrations` block (a command run once, by one owner service, before the candidate starts) is the alternative when you do not want the application to migrate itself.

## What a rollback can and cannot undo

Every plan carries `rollback.dataSafety`:

| Value | Meaning |
|---|---|
| `code-only` | this release changed no database structure; rolling back restores the previous code completely |
| `schema-ahead` | an additive migration was applied; rolling back restores the previous code on a database that stays at the newer schema. Safe only because expand-contract promises the previous release tolerates it. The contract step (removing the old column) belongs in a **later** release |
| `forward-only` | a destructive migration is included; rolling back restores the code but **not the data it removed**. Treat the release as forward-only and keep a backup |

In the real-application run, after an additive Flyway migration, rolling the catalog back to the previous jar left the database at version 2, the service started and answered, and the plan had said so before the deployment.

## What can go wrong

A declaration that leaves out a workload is not protected against it: PSO checks what you say, not what the code does. A forgotten `scheduledJobs: "singleton"` runs the jobs twice during a blue-green; a migration that is not really additive breaks the release that is still serving. Treat the `workload` block as part of the review of every release that changes how a service starts, consumes or schedules.

## Graceful draining

The old release keeps its connections for `drainSeconds` after traffic moves; its process then receives SIGTERM and has `shutdownGraceSeconds` (plus a margin) to finish running requests before it is killed. Declare the grace from the application's real shutdown time. The framework's HTTP server closes its listener, finishes accepted requests and only then releases its dependencies; a connection accepted but not yet carrying its request is given a short bounded window instead of being cut.
