# Contributing to PSO Web Framework

Thank you for helping. PSO Web Framework is licensed under the [Apache License 2.0](LICENSE).

## License of contributions

By submitting a contribution (a pull request, a patch or a suggested change) you agree that it is licensed under the Apache License 2.0,
as described in section 5 of the license ("Submission of Contributions"), and that you have the right to submit it. Do not submit code you
cannot license this way, and do not copy code from projects under incompatible licenses.

Third-party code is never relicensed: a new dependency keeps its own license, must be compatible with redistribution under Apache-2.0, and
appears in the release SBOM and third-party notices produced by the release scripts.

## Before you start

- Open an issue for anything larger than a small fix, so the approach can be agreed first.
- Never commit credentials, private keys, tokens, `.env` files, generated infrastructure (`.infra/`), local logs or release artifacts;
  `.gitignore` excludes them, and reviews reject them.

## Development

```bash
npm ci
npm run build
```

Run the tests of the area you changed (`node --test --experimental-strip-types packages/<package>/test/*.test.ts`), and the documentation
checks when you change `packages/cli/docs/` (`node --test --experimental-strip-types packages/cli/test/docs-*.test.ts`). Java changes:
`cd pso-java && ./mvnw -B verify`.

Keep changes focused: one concern per pull request, with tests for new behaviour and documentation for anything users see.

## Reproducible builds

Builds use the exact dependency versions of `package-lock.json` (`npm ci`) and the Maven wrapper's pinned Maven version. The release
workflow (`.github/workflows/signpath-release.yml`) pins the Node.js runtime, Inno Setup and JDK versions and builds on GitHub-hosted
runners from a tagged commit. Generated files (`dist/`, `target/`, the agent bundle, `diagnostic-codes.json`) are produced by the build and
not edited by hand.

## Review and roles

| Role | Responsibility |
|---|---|
| Committers | may merge their own changes; review every pull request from other contributors |
| Reviewers | review every change proposed by a non-committer before it is merged; build scripts, workflows, `.signpath/` and `scripts/psd/` get particular care, because they decide what is built and signed |
| Signing approvers | decide whether a release may be signed and approve each signing request ([code signing policy](https://devmboo.github.io/pso-web-docs/downloads/code-signing-policy.html)) |

Today all roles are held by the maintainer, [DevMboo](https://github.com/DevMboo). Team members use multi-factor authentication on
GitHub.

## Reporting security problems

Do not open a public issue for a vulnerability: see [SECURITY.md](SECURITY.md).
