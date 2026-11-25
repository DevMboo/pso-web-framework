---
title: Prepare a native deployment
description: Validate, build, inspect a release plan and activate a version with health checks.
order: 8
status: partial
keywords: [tutorial, deployment, build, release, rollback, production]
related: [devops/build-and-deploy, devops/ci-cd, security/checklist]
---

PSO can build artifacts and activate a native release directory. Your process manager is responsible for starting and supervising those artifacts. Use an immutable PSO Java release version; deployment rejects SNAPSHOT builds.

## Prepare

```bash
pso validate
pso config:validate
pso security:check
pso test
pso build
```

`pso security:check` fails (`SEC005`, exit 1) until the production issuer, audience and a key source are set, in `pso.config.json` or in the environment of the shell that runs it; set them before this step. Without `pso build`, `pso deploy:plan --target native` stops with "No build artifacts found".

Inspect `.pso/artifacts/manifest.json`: it lists artifacts and SHA-256 checksums. `pso test` runs service tests; a service without tests is reported as `no-tests`, not verified. Confirm production issuer, audience, key source, broker secrets and database settings before activation ([security checklist](/security/checklist)).

## Plan and activate

```bash
pso deploy:plan --target native --dir D:\apps\shop --release 1.0.0
pso deploy --target native --dir D:\apps\shop --release 1.0.0 --yes --health-url http://127.0.0.1:3000/health/ready
```

The plan is read only. `deploy` requires `--yes`, verifies artifact checksums and switches `current.json` to the new release. A failed health URL causes an automatic rollback. Check the service manager and readiness endpoint after activation; a successful file switch alone is not evidence that a process was launched. `pso rollback --dir D:\apps\shop --yes` switches back to the previous release when needed.

The Compose target requires a Docker daemon. Spring container builds must also resolve the local `com.pso` Maven artifacts from a repository accessible inside the build. Kubernetes deployment is not implemented. See [Native builds and deployment](/devops/build-and-deploy) for exact limits.

## What you will see

The Compose target's plan, verified (nothing is changed by `deploy:plan`):

```text evidence="verified"
$ pso deploy:plan --target compose
target:   compose
steps:
  1. docker compose build
  2. docker compose up -d --wait

Nothing has been changed. Run `pso deploy` with the same options and --yes to apply.
```

and a release that is not safe is refused: `pso deploy` without `--yes` exits with code 3, and a SNAPSHOT build is refused. For the native target, a successful activation leaves `current.json` pointing at `releases/<version>+<hash>/` with the previous release recorded (the layout is described on [Native builds and deployment](/devops/build-and-deploy); that exact transcript was not captured here).

## A checklist for the day

1. CI is green: `pso validate`, `pso security:check --strict`, `pso test`, `pso build`.
2. You read `pso deploy:plan` output and the release number is the one you intend.
3. Production values are in the environment, not in files ([environment configuration](/devops/environment-configuration)).
4. You know the rollback command and who runs it: `pso rollback --dir <dir> --yes`.
5. After activation you checked readiness and a real request, not just the file switch.

## Managed platforms

PSO can generate hardened descriptors for Kubernetes, ECS, Container Apps and Cloud Run and check them statically, but it never applies them ([cloud descriptors](/devops/cloud-descriptors)). Production decisions that need your judgment: [development or production configuration?](/decisions/dev-or-production-config).

## Common mistakes

- Treating the activation of a release directory as a process restart.
- Deploying without `--health-url` and learning about a broken release from users.
- Reusing a development key or open CORS in production.
