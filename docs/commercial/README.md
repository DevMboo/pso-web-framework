# PSO Web: commercial readiness

Status of this folder: **factual inventory, not a certification.** Anything that needs a decision or an external party is marked `OWNER DECISION` or `EXTERNAL`. Nothing here claims a compliance certification, a support contract or a licence that does not exist. There is no payment or licensing server and none is implied.

| Document | Purpose |
|---|---|
| [support-matrix.md](support-matrix.md) | Platforms, runtimes and broker versions that were actually exercised |
| [security-policy.md](security-policy.md) | How to report a vulnerability, what is promised, what is not |
| [release-policy.md](release-policy.md) | Versioning, channels, signing, what a release contains |
| [licensing-status.md](licensing-status.md) | Current licence state of PSO and its dependencies |
| [release-notes-0.1.0.md](release-notes-0.1.0.md) | What 0.1.0 contains and its known limitations |

Release evidence is produced by scripts, not written by hand: `node scripts/release.mjs npm`, `node scripts/release-maven.mjs`, and `pso dist ...` (see `packages/cli/docs/devops/distribution-and-installation.md`). Their outputs include SHA-256 checksums, a CycloneDX SBOM, a licence inventory and a secret scan.
