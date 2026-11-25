---
title: CI/CD
description: The generated GitHub Actions workflow, the checks worth running in any CI in the order that fails fastest, and a release pipeline that produces checksummed, signed artifacts.
order: 5
status: partial
keywords: [ci, github actions, pipeline, continuous integration, release, checksums, sbom]
related: [devops/docker, security/auditing, devops/distribution-and-installation, devops/build-and-deploy]
---
`pso docker:init` writes `.github/workflows/ci.yml` with three jobs:

| Job | Steps |
|---|---|
| `orchestrator` | Node 24, `npm install`, TypeScript check, `npm audit --omit=dev --audit-level=high` |
| `spring` (matrix over services) | Temurin 21 with Maven cache, `./mvnw -B -ntp verify` |
| `compose` | `cp .env.example .env`, `docker compose config --quiet` |

The workflow is generated and statically checked; it has **not been executed on GitHub** here. It also assumes the PSO artifacts are installable in the runner (see the Docker page's warning).

## Checks to add, in order of cost

If the `pso` CLI is available in your pipeline, run the cheap, dependency-free checks first so a broken change fails in seconds:

| Step | Needs | Catches |
|---|---|---|
| `pso validate` | nothing installed | structure, routes, contracts, module wiring |
| `pso config:validate --env production` | nothing installed | unknown keys (errors in production and with `--strict`), wrong types, plaintext secrets |
| `pso security:check --strict` | nothing installed | missing JWT config, unignored keys, hard-coded credentials, risky public routes |
| `pso lint` | npm dependencies | the three above plus TypeScript type-check |
| `pso test` | npm and Maven | each service's own tests |
| `pso security:audit` | network | npm advisories; SNAPSHOT/range scan of POMs |
| `pso build` | npm and Maven | artifacts with SHA-256 manifest |

then `pso deploy:plan` for review and `pso deploy --yes` from a protected, manually approved job. Deployment never happens implicitly.

```yaml
# an extra job in your own workflow
pso-checks:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: "24" }
    - run: node path/to/pso/packages/cli/bin/pso.js validate
    - run: node path/to/pso/packages/cli/bin/pso.js security:check --strict
```

(Illustrative: how you obtain the CLI in CI depends on how you install it; the packages are not published, see [installation](/getting-started/installation).)

## A release pipeline

To produce publishable evidence for each release, run the release scripts from the framework repository in a protected job:

```bash
node scripts/release.mjs npm  --out release-out/npm   --sign-key "$SIGNING_KEY_FILE"
node scripts/release-maven.mjs --out release-out/maven --sign-key "$SIGNING_KEY_FILE"
node scripts/verify-release.mjs release-out/npm --trust release-public.pem
```

They pack the artifacts, write SHA-256 sums, a CycloneDX SBOM, a licence inventory and a secret scan, and (with a key supplied from the CI secret store, never from the repository) sign the checksums and a provenance statement. Nothing is published by the scripts. See [Distribution](/devops/distribution-and-installation) for what each stage proves and what it does not (the provenance is self-asserted, not an attested SLSA build; there is no GPG or Authenticode signing).

## Pipeline hygiene

- Keep secrets in the CI secret store; the scripts refuse a signing key located inside the repository.
- Run the cheap checks on every pull request; the expensive ones on merge.
- Archive `manifest.json`, `SHA256SUMS` and the SBOM with the release.
- Never let a pull request from a fork access deployment credentials.

## Common mistakes

- Deploying from the same job that runs untrusted code.
- Caching `node_modules` across Node major versions.
- Treating `npm audit` as complete: Maven dependencies are not scanned by PSO.

## Next steps

- [Docker](/devops/docker)
- [Build and deploy](/devops/build-and-deploy)
