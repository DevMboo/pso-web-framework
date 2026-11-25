---
title: Requirements
description: The tools PSO needs on your machine, which are optional, what the check command really verifies, and how to fix what it reports.
order: 4
keywords: [node, java, maven, docker, windows, pso doctor, engines]
related: [getting-started/installation, getting-started/troubleshooting]
---
| Tool | Version | Needed for |
|---|---|---|
| Node.js | developed and tested on **24**; the framework packages declare `engines.node >=24` | a source checkout and a separately run orchestrator; the Windows portable distribution bundles its own private runtime |
| npm | bundled with Node | installing dependencies |
| JDK | 21 or newer (tested with 25 compiling for release 21) | Spring Boot services |
| Maven | **not required** | each service carries a project-local Maven Wrapper (Maven 3.9.9, SHA-256 pinned) that downloads Maven from Maven Central on first use |
| Docker | optional | `pso docker:build`, the generated Compose stack, and running real brokers or PostgreSQL locally |

Windows, macOS and Linux are supported by the CLI from a checkout of the source. The current release, PSO Web V2 `0.2.0-rc.3`, is distributed for Windows 10/11 x64 as a portable ZIP (recommended) and an experimental, unsigned installer that is not validated end to end ([Downloads](/downloads/index)).

> [!NOTE]
> **Which Node version?** Node 24 or newer. The framework packages and the generated orchestrator declare `engines.node >=24`, `pso doctor` requires 24 (it prints `>=24`), and every test of this framework ran on Node 24.

On Windows use PowerShell. Git Bash rewrites arguments that start with `/` (for example `--route /customers` becomes `C:/Program Files/Git/customers`), which the CLI then rejects. Prefix the command with `MSYS_NO_PATHCONV=1` if you must use Git Bash.

## Check your machine

```bash
pso doctor
```

Real output (verified):

```text evidence="verified"
ok      node    v24.18.0  (>=24)
ok      java    java version "25.0.3" 2026-04-21 LTS  (>=21 for Spring Boot services)
missing mvn     not found  (optional (or use Docker))
ok      docker  Docker version 29.6.1, build 8900f1d  (optional)
```

`mvn` being `missing` is fine: services use their `mvnw` wrapper. `doctor` checks that each tool is present and its version, not that your project builds.

## Fixing what `doctor` reports

| Report | Meaning | Fix |
|---|---|---|
| `missing node` or a version below the target | Node is absent or too old | install Node 24 (nodejs.org or your version manager) and open a new terminal |
| `missing java` | no JDK on the PATH | install a JDK 21 or newer; set `JAVA_HOME`; check with `java -version` |
| `java ... (>=21 ...)` marked not ok | JDK older than 21 | Spring Boot 3.5 needs 17+ and PSO generates Java 21 code: upgrade |
| `missing docker` | not installed or not on the PATH | optional; only the Docker commands and local brokers need it |
| `docker` present but commands fail | the daemon is not running | start Docker Desktop (or the Docker service) |

## What else matters in practice

- **Disk and network on the first Spring build.** The wrapper downloads Maven, and Maven downloads the dependencies. The first build of a service takes minutes; later ones are fast.
- **Ports.** `pso dev` uses 3000 for the orchestrator and 8081 upward for services. If something else holds one of them, change the port in `pso.workspace.json` (`pso create service --port <n>` sets it at creation).
- **Corporate proxies.** If Maven or npm cannot reach their registries, configure the proxy for those tools; PSO does not add its own.

## Troubleshooting

`pso doctor` checks the toolchain. Real output from a machine that has everything except a standalone Maven:

```text evidence="verified"
ok      node    v24.18.0  (>=24)
ok      java    java version "25.0.3" 2026-04-21 LTS  (>=21 for Spring Boot services)
missing mvn     not found  (optional (or use Docker))
ok      docker  Docker version 29.6.1, build 8900f1d  (optional)
```

| Symptom | Cause | Fix |
|---|---|---|
| `missing mvn` | no standalone Maven | ignore it: generated services carry `./mvnw` |
| `java` below 21 | Spring Boot 3.5 needs 21 or newer | install a newer JDK |
| `node` below the printed minimum | older Node | install the version shown in parentheses |
| `docker` missing | it is optional | install it only for the database, brokers and `docker:init` |

## Next steps

- [Installation](/getting-started/installation)
- [Quick start](/getting-started/quick-start)
