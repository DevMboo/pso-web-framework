---
title: Native builds and deployment
description: Package artifacts with checksums, plan a release, deploy it with health verification and roll back - the native target, the Compose target, and how the cloud descriptors relate.
order: 2
status: partial
keywords: [build, deploy, rollback, release, native, artifacts, checksum, deploy:plan]
related: [devops/docker, devops/cloud-descriptors, devops/ci-cd, devops/distribution-and-installation]
---
## Build

```bash
pso build [--service name]
```

Type-checks and **compiles** Node services (`npm run build`), packs them with `npm pack`, builds Spring services with `mvnw package`, and writes `.pso/artifacts/manifest.json` with each artifact's SHA-256. Validation errors stop the build.

## Test and lint

`pso test` runs each service's own tests (`npm test` / `mvnw test`); services without tests are reported as `no-tests`. `pso lint` runs workspace validation, the security check and the TypeScript check, and reports missing dependencies instead of skipping them.

## Plan, deploy, roll back (native target)

```bash
pso deploy:plan --target native --dir D:\apps\shop --release 1.0.0
pso deploy      --target native --dir D:\apps\shop --release 1.0.0 --yes --health-url http://127.0.0.1:3000/health/ready
pso rollback    --dir D:\apps\shop --yes
```

- `deploy:plan` changes nothing and shows exactly what would happen.
- `deploy` **requires `--yes`** (exit code 3 otherwise).
- Artifacts are checksum-verified before and after copying into `<dir>/releases/<version>+<hash>/`. The release is activated by an atomic switch of `<dir>/current.json`.
- A failing `--health-url` (repeatable) rolls back automatically.
- SNAPSHOT builds are refused.

The result on disk (expected; the layout follows from the command):

```text evidence="expected"
D:\apps\shop\
  current.json                         { "release": "1.0.0+3f9a1c2e", "previous": "0.9.0+ab12cd34" }
  releases\1.0.0+3f9a1c2e\gateway\gateway-0.1.0.tgz
  releases\1.0.0+3f9a1c2e\catalog\catalog-0.1.0.jar
```

The Compose target plans the same way (expected output):

```text evidence="verified"
$ pso deploy:plan --target compose
target:   compose
steps:
  1. docker compose build
  2. docker compose up -d --wait

Nothing has been changed. Run `pso deploy` with the same options and --yes to apply.
```

## A release, step by step (native)

1. `pso validate` and `pso security:check --strict` (CI).
2. `pso build`; archive `.pso/artifacts/manifest.json`.
3. `pso deploy:plan ...` and review it (a person reads it).
4. `pso deploy ... --yes --health-url <url>` from a protected job.
5. Verify: `GET <health-url>` answers; `current.json` names the new release.
6. If something is wrong later: `pso rollback --dir ... --yes` re-activates the previous release atomically.

## Limits

PSO places artifacts and switches the active release; **starting the processes from a release is up to you** (service manager, scripts). The `compose` target runs `docker compose build` and `up -d --wait`; building the images needs the PSO artifacts to be reachable (see [Docker](/devops/docker)). **Cloud and cluster platforms** are covered by generated, statically validated descriptors only (`pso deploy:init`, `pso deploy:validate`: Kubernetes, ECS, Container Apps, Cloud Run); PSO never applies them ([cloud descriptors](/devops/cloud-descriptors)).

## Variations

| You want | Use |
|---|---|
| a release directory with rollback on a VM | the native target |
| the local stack in containers | `pso docker:init` then the compose target |
| managed platforms | `pso deploy:init --target <platform>` (kubernetes, ecs, container-apps or cloud-run), then your platform's tooling |
| signed, installable packages for other machines | [signed packages and the installer](/devops/distribution-and-installation) |

## Releases and SNAPSHOT versions

`pso deploy` and `pso deploy:plan` (native target) refuse a Spring service that is not built from fixed versions. Two versions of its `pom.xml` decide that, plus any dependency pinned to a SNAPSHOT:

| Version | Where | Why it matters |
|---|---|---|
| the service's own | `<project><version>` | the artifact you deploy |
| the PSO artifacts | `<pso.version>` | every `com.pso` dependency; `0.1.0-SNAPSHOT` is a local development build from `pso java:install` |

The version of the Spring Boot parent is not part of the rule. (Earlier versions read exactly that one, so a service on PSO SNAPSHOT artifacts was accepted as a release.)

```text evidence="expected"
$ pso deploy:plan --target native --dir /srv/shop --release 1.0.0
error: Refusing to deploy a SNAPSHOT build:
 - orders: the PSO artifacts are 0.1.0-SNAPSHOT (<pso.version>): a local development build of com.pso:*
hint: A release uses fixed versions: build the PSO artifacts with a release version (node scripts/release-maven.mjs) and set <pso.version> and the service <version> to fixed versions. For a development deployment pass --allow-snapshot
```

| Policy | Command | Result |
|---|---|---|
| Release | `pso deploy --target native --dir <path> --release 1.0.0 --yes` | refused while any of the versions above is a SNAPSHOT |
| Development deployment | add `--allow-snapshot` | accepted; the plan is marked `DEVELOPMENT DEPLOYMENT` and lists the SNAPSHOT versions |
| Production | `PSO_ENV=production` | `--allow-snapshot` itself is refused |

## Common mistakes

- Deploying a SNAPSHOT (refused) or a build whose checksums do not match the manifest (refused).
- Assuming `deploy` starts the processes.
- Skipping `--health-url`: without it a broken release is not detected automatically.

## Next steps

- [CI/CD](/devops/ci-cd)
- [Production security checklist](/security/checklist)
