---
title: Deployment of an environment
description: pso deploy --env, release records, verification through the edge, automatic rollback, the bundle target for remote hosts, and the prerequisites PSO cannot satisfy for you.
order: 8
status: implemented
keywords: [deploy, release, rollback, bundle, verification, health, production prerequisites]
related: [infrastructure/containers, infrastructure/hosts-and-environments, cloud/overview, devops/docker]
---
> [!STATUS]
> **Implemented and verified** against the local Docker Engine with the reference workspace: a verified release, then a failing release rolled back automatically. The `bundle` target is verified by the CLI tests. **Not done:** deploying to a remote host directly; for that, use the bundle, or the 0.1 cloud engine (`pso release:plan`, `pso release:deploy`).

`pso deploy --env <name> --dry-run` shows the plan: infrastructure changes, images to build, the target, prerequisites the operator must satisfy on the target (DNS records, supplied certificates and secrets), and blockers (a drifted file, an unpublished shell, a supplied resource that is missing). Nothing is deployed without `--yes`.

## What a release is

A release of an environment is the set of service images plus the generated configuration the containers mount (compose, nginx, realm, runtime configurations). It is recorded under `.infra/deploy/<env>/releases/<id>/`: image ids, copies of the configuration and their checksums. Key material and secrets are never copied: they stay with the environment's providers.

## Target `docker`

The default for development environments: the Docker Engine this machine talks to.

1. apply pending infrastructure changes (configuration only outside development);
2. build the service images; record the release; tag the images with the release id;
3. start in dependency order and wait for health;
4. verify through the edge with certificate verification: every shell and its runtime configuration, the API's readiness (directly and through a shell's same-origin path), the identity provider's discovery document (its issuer must equal what services expect), and that an unknown host is refused;
5. if starting or verification fails and a previous release exists: restore its configuration and images and start it again; the failed release stays recorded for inspection.

```text evidence="verified"
verification failed (containers did not become healthy (exit 1)): rolling back to 20261124092415-9040c90d ...
error: release 20261124092507-d3715585 failed verification and was rolled back to 20261124092415-9040c90d
```

`pso rollback --env <name> [--to <release>] --yes` restores a recorded release on purpose.

## Target `bundle`

The default for staging and production: a directory under `.infra/deploy/<env>/bundles/<release>/` with the configuration, `MANIFEST.json` (checksums and image list) and `DEPLOY.md` (prerequisites and the command to start it). It contains no key and no secret value. It is what an operator reviews and runs on the target host.

## Production prerequisites

PSO does not, and cannot, do these for you:

- DNS records for every public host (listed by `--dry-run`);
- certificates from a trusted authority in the PSO layout, on the host (`tls.dir`);
- secrets through the platform (`PSO_SECRET_<NAME>` variables, or files under `secrets.dir`);
- for Keycloak: a production database and administrator procedures (the generated realm is imported once; later realm changes are applied through the administration API);
- an image registry the target can pull from, or a build on the target;
- backups of the database volumes.

## What goes wrong
- A drifted generated file blocks the deployment: a release must be reproducible from the declarations (`pso infra:repair`).
- A shell without a published release blocks it: publish first (`pso frontend:publish <fei> --env <env>`).
- The first release of an environment has nothing to roll back to: a failed first release is left running for inspection.
