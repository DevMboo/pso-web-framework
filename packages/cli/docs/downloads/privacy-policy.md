---
title: Privacy policy
description: What PSO Web transfers over the network and when - nothing unless you ask for it - what it changes on your machine, and the third-party services your own configuration can involve.
order: 3
keywords: [privacy, telemetry, network, data, installer, update, osv-scanner, opentelemetry]
related: [downloads/code-signing-policy, downloads/index, infrastructure/release-integrity-and-signing]
---

PSO Web consists of the `pso` command-line tool, the orchestrator and Spring Boot runtime libraries it generates projects with, Studio,
the deployment agent, the Windows installer and the portable distribution.

> This program will not transfer any information to other networked systems unless specifically requested by the user or the person
> installing or operating it.

## No telemetry

PSO Web contains no telemetry, analytics, crash reporting, usage statistics, advertising or license check. It does not contact a PSO server:
there is none. The installer and the portable distribution make no network connection.

## Connections you ask for

Every connection below happens only because you run the command or configure the destination yourself:

| What you do | Where the connection goes |
|---|---|
| `pso update check` / `pso update install --catalog <url>` | the catalog or package URL you give; without one the command refuses to run |
| building generated projects (`npm`, `./mvnw`, `pso docker:up`) | the package registries and container registries your build uses (by default the npm registry, Maven Central, Docker Hub and Quay for Keycloak) |
| running your applications (`pso dev`, `pso docker:up`) | your own services, databases, brokers and identity provider, as declared in your workspace |
| OpenTelemetry export | only the collector endpoint you configure |
| frontend applications built with PSO | the API endpoints you declare |
| the deployment agent, server connections and agents (`pso connection:add`, `pso agent:enroll` and the related commands) and deployment health checks (`--health-url`) | the servers you add and enroll, and the URLs you give |
| the Java dependency scan of the deployment agent | if you install [OSV-Scanner](https://google.github.io/osv-scanner/) on the build server, that tool sends the names and versions of the scanned Java dependencies to the OSV vulnerability database (osv.dev, operated by Google); without the tool installed nothing is sent and the scan is reported as not run |
| Studio | binds to loopback on your machine; it is not reachable from other computers unless you start it with `--remote` |

The privacy policies of those registries, identity providers, collectors and of OSV apply to what they receive.

## Changes to your machine

| Change | When, and how it is undone |
|---|---|
| a folder with the PSO installation | installer or portable ZIP; removed by the uninstaller or by deleting the folder |
| your **user** PATH entry for PSO | only if you keep the installer option *Add PSO to my PATH*; restored exactly by the uninstaller |
| the per-user uninstall entry (*Settings → Apps*) | installer only; removed by the uninstaller |
| a marked block in the system `hosts` file | only when you run `pso infra:apply` for a local environment that needs it, after `pso infra:plan` shows it; it needs administrator rights, which PSO never requests itself; a backup is kept |

PSO never disables or changes Windows security settings, never installs a trusted root certificate, and never elevates itself.

## Data in your projects

Secrets, keys and certificates that PSO generates for local development stay in your workspace (`.infra/`, git-ignored) or in your
installation; they are never transferred. Logs and Studio mask tokens, credentials and known secret values.

## This website

The documentation site is a static site hosted by GitHub Pages; it loads no third-party scripts, fonts or analytics. GitHub's own privacy
statement applies to the server logs of GitHub Pages.

## What can go wrong

- A dependency or container download fails because a registry is unreachable: PSO does not retry through any other service.
- A corporate proxy or firewall may log the registry and update connections you start; that logging is outside PSO.
- If you configure an OpenTelemetry collector or a remote identity provider, the data you send there is governed by that operator.

Questions about this policy: open an issue in the project's repository.
