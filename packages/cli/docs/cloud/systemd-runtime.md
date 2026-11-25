---
title: Running services with systemd (no Docker)
description: How PSO keeps Node.js and Java/Spring Boot services running on a plain Linux server with the deploy user's own systemd manager, what privilege it needs (one admin command), and what it guarantees across crashes and reboots.
order: 14
status: implemented
keywords: [systemd, linger, user unit, journal, restart, reboot, non-containerized, supervisor, runtime.supervisor]
related: [cloud/deploy-a-release, cloud/rollback-and-recovery, cloud/deployment-declarations, cloud/deploy-to-a-vps]
---
> [!STATUS]
> **Implemented and verified** against a real systemd (Debian 12, systemd 252 as PID 1 of a disposable container, reached over SSH) with Node.js, Java 21 and PostgreSQL. It was also used on an external cloud virtual machine (Ubuntu 24.04, systemd 255) during the owner's [external validation](/cloud/external-validation), and only the **user-manager** scope exists (see [What is not implemented](#what-is-not-implemented)).

By default PSO keeps your services alive itself: it starts each process, remembers who it is and stops it with the grace period you declared. That works anywhere, but a process the agent started does not come back after a server reboot. When the server runs systemd you can ask for the operating system to do that job:

```ts
export default defineDeployment({
  // ...
  runtime: { supervisor: "systemd", restart: "on-failure" },
});
```

Nothing else about the deployment changes: the same plan, candidate, verification, switch, drain, rollback and recovery apply. Blue-green still starts the new release next to the old one; each instance simply becomes a **unit**.

## Why the user manager, and what an administrator does once

PSO does **not** write units under `/etc/systemd/system`, does not run as root and does not need a sudo rule for systemd. It uses the deploy user's **own** systemd manager (`systemctl --user`), so the agent can only create, start, stop and remove units *inside that user's manager*, and every service runs as that same unprivileged user.

One command, run once by an administrator, makes that manager start at boot without a login session:

```bash
loginctl enable-linger deploy
```

`pso environment:plan <environment>` prints it in the reviewed administrator script (together with the other server-preparation steps); PSO never runs it for you. Without lingering the units stop when the last session of the user ends and are not started at boot: the plan says so as a warning.

## What a unit looks like

One file per service instance and release, named `pso-<application>-<service>-<release>-<n>.service`, in `~/.config/systemd/user/`:

- The first line is the ownership marker `# Managed by PSO Web (app=..., service=..., release=...)` and the file carries a per-slot token. **PSO touches only units that have its shape, the marker and the token.** An unrelated unit of the same user, even one named `pso-...`, is never started, stopped, disabled or deleted.
- `ExecStart` is the argv array you declared, each word quoted for systemd, with an absolute program path (resolved from the agent's `PATH`). There is no shell.
- `KillMode=control-group`, `KillSignal=SIGTERM` and `TimeoutStopSec` = your `shutdownGraceSeconds` plus a margin: systemd sends SIGTERM, waits the real grace period and only then kills. `NoNewPrivileges=yes` is set.
- **Secrets are never in the unit file.** They are in an environment file (mode 600, in the agent's private directory) that the unit reads.
- Output goes to the release's log file; `pso release:logs` returns the journal of the unit when the user's journal is readable, and says which source it used when it is not. Both are sanitized.

## What you get

| Situation | Result |
|---|---|
| A service crashes (`restart: "on-failure"`) | systemd restarts it; the verified release stays healthy |
| The server restarts (lingering on) | Only the **active** release's units are enabled, so only they start; the previous release does not |
| A candidate fails to start or never becomes ready | Its unit is stopped; the active release is untouched |
| Rollback | The previous release's units are started again with the same verification |
| Independent update of one service | Other services' units are not restarted (their process ids do not change) |

## Verified behaviour

The framework's end-to-end systemd run checks, on real systemd: the plan and the administrator script; the server policy refusing `systemd` when it does not allow it; units with marker, no secret and a private environment file; independent update under traffic without restarting the other service; a failing candidate; rollback; a foreign unit left untouched; restart after `kill -9`; and the application coming back after a server restart with no agent and no operator involved.

## What is not implemented

- **System scope.** Units under `/etc/systemd/system` with a configurable `User=` need a root-owned helper and a narrow sudo rule that PSO does not ship. They are not offered, and PSO does not emulate them. To run services as a different user, install the agent for that user (one agent home per user).
- Resource limits (`MemoryMax` and friends) are not set: the user manager does not always delegate the controllers, and PSO does not claim limits it cannot verify.
- Distributions without systemd (Alpine, containers) keep using the default supervisor.

## Related

- The server decides what is allowed: the policy key `supervisors` (`pso environment:policy <environment> --set supervisors=...`) cannot be widened by a declaration.
- [Deploy a real application to a VPS](/cloud/deploy-to-a-vps) uses this driver end to end.
