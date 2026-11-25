---
title: PSO Web as a Cloud Ecosystem Framework
description: How PSO Web covers development, integration, security, infrastructure, deployment and operations, what Cloud Lifecycle and Operations adds, and what is and is not implemented yet.
order: 1
status: partial
keywords: [cloud, ecosystem, deployment, operations, ssh, agent, blue-green, studio, cloud lifecycle]
related: [cloud/systemd-runtime, cloud/release-signing, cloud/deploy-to-a-vps, cloud/workloads-and-rollback-safety, cloud/external-validation, cloud/connect-a-server, cloud/deploy-a-release, cloud/credentials-and-security, devops/build-and-deploy, devops/studio]
---
> [!STATUS]
> Cloud Lifecycle and Operations (CLO) is **implemented and exercised against a disposable Linux server** (a container reached over real SSH) from this repository. It has **not** been validated on an external cloud environment. Treat that as the next acceptance step, not as a finished fact.

**PSO Web is a declarative, cloud-oriented ecosystem framework** designed to simplify the entire lifecycle of distributed web applications. It provides one structural foundation for development, integration, security, infrastructure, deployment and operations, so independent teams can work autonomously while the architecture stays consistent. *Build independently. Integrate seamlessly. Operate securely.*

## The six pillars

| Pillar | What PSO provides | Where it is documented |
|---|---|---|
| Development | Structure by convention, modules, routes, generators | Core Concepts, Orchestrator |
| Integration | Service discovery, contracts, event dispatch | Microservices, Event Dispatch |
| Security | Deny by default, JWT, rate limits, mTLS | Security |
| Infrastructure | Servers, reverse proxy, runtimes, private management plane | this section |
| Deployment | Plans, pipelines, blue-green, rolling, recreate, rollback | this section |
| Operations | Durable state, audit, recovery, logs, service control | this section |

These are one product with one security model, not separate tools. The same declarative idea applies everywhere: you describe the result in a file, PSO validates it, shows you the plan and then makes it so.

## The operational architecture

Four responsibilities, deliberately not four separate products:

- **PSO Studio** is the graphical interface (the *Cloud* section; start it with `pso studio --remote`).
- **PSO Deploy Engine** is the single implementation of planning, validation, preparation, activation, recovery and rollback. It runs **on the target server**, so a deployment survives the end of your SSH session.
- **PSO Runtime Agent** is one bundled file that the engine runs in. It opens **no network port**: you reach it through an authenticated SSH connection, and it offers a fixed list of operations, never a shell.
- **PSO Security Engine** is identity (Ed25519 keys), roles, per-request signatures, rate limiting, secrets and a hash-chained audit log, shared by all of the above.

The CLI and Studio are thin clients of the same calls (`Cloud` in `@pso/deploy`), so they enforce identical policy. There are not two deployment implementations.

```bash
pso connection:add prod --host 203.0.113.10 --user deploy --auth key --key ~/.ssh/id_ed25519
pso agent:install prod --mode protected --environment production --yes
pso environment:add production --connection prod --repo https://git.example.com/shop.git --domain shop.example.com
pso release:plan production
pso release:deploy production --yes
```

## What is implemented

SSH connections with strict host-key and agent-identity pinning; protected credential storage; environments and static declarations (`DEPLOYMENT.pso.ts`, `PIPELINE.pso.ts`); git and artifact releases pinned to an immutable commit or checksum; blue-green, rolling and recreate strategies; nginx management with ownership markers, validation and graceful reload; Node and Java processes identified by token, not by port; durable deployment state, locks, recovery, rollback; approvals; audit.

Also implemented since: the **systemd** runtime ([systemd runtime](/cloud/systemd-runtime)), **signed releases and trusted signers** ([release signing](/cloud/release-signing)), workload and rollback-safety rules ([workloads](/cloud/workloads-and-rollback-safety)), optional Java dependency scanning, distinct `disabled`/`skipped`/`unavailable`/`failed` check outcomes, and host-administrator recovery ([agent and enrollment](/cloud/agent-and-enrollment)). A practical guide: [deploy a real application to a VPS](/cloud/deploy-to-a-vps).

## What is not implemented (read this before relying on it)

- Only **SSH to Linux** is a connection provider. AWS, Azure, Google Cloud and Kubernetes providers do not exist; the provider interface is where they would attach, and PSO provisions no cloud resources and spends no money.
- No **system-scope** systemd units (only the deploy user's own manager: see [systemd runtime](/cloud/systemd-runtime)), no automatic TLS certificates or DNS or hosts-file changes, and no resource limits on services.
- The macOS Keychain provider is written but has **not been run** on macOS. The Windows Credential Manager, the Linux Secret Service (a real gnome-keyring in a container) and the encrypted file were exercised.
- The Java dependency scan needs OSV-Scanner on the server or build host and network access to the OSV database; it was exercised with the real OSV-Scanner 2.2.4 against the live database (a known-vulnerable Log4j is blocked, a patched one passes). Without the tool or the network the result is `unavailable`, never a pass.
- The external validation was performed once, by the project owner, on one cloud virtual machine; public HTTPS access through the provider's firewall was not verified: see the [external validation guide](/cloud/external-validation).
- Frontends (FEI and MEI) are deployed as static resources of the same engine: see [native frontend deployment](/frontend/native-deployment).
- Zero downtime is an objective with stated conditions, not a guarantee: see [Deploy a release](/cloud/deploy-a-release).

## What can go wrong

Most failures are refusals by design: a plan with blockers, a host key that changed, a stale plan, a policy that disallows a strategy. Each refusal names its reason. The [troubleshooting page](/cloud/troubleshooting) lists them with their fixes.
