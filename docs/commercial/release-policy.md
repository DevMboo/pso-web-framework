# Release policy

## Versioning and channels

- Semantic Versioning for every artifact (npm packages, Maven artifacts, `.psopkg`, installer). One version for the whole release.
- Release versions are fixed: `-SNAPSHOT` and mutable tags such as `latest` are refused by the release scripts and by `pso deploy:init`.
- Update channels in the signed update catalog: `stable`, `beta`, `dev`. A catalog has an expiry and a rising `sequence` (replay protection).
- Deprecations are announced in release notes one minor version before removal (`OWNER DECISION`: confirm this window).

## What a release contains

| Artifact | Produced by | Evidence |
|---|---|---|
| npm tarballs (`@pso/core`, `security`, `dispatch`, `http`, `cli`) | `node scripts/release.mjs npm` | `SHA256SUMS`, reproducible-pack check, content policy, secret scan, CycloneDX SBOM, licence inventory, audit, provenance (self-asserted), clean install from tarballs outside the monorepo |
| Maven artifacts (BOM and starters, with sources) | `node scripts/release-maven.mjs` | file repository, `SHA256SUMS`, CycloneDX SBOM, no SNAPSHOT check, a generated Spring service built against it with an isolated local repository |
| Signed distribution package | `pso dist build / pack` | Ed25519 signature, per-file SHA-256 in the header |
| Windows installer | `pso dist installer --platform windows` | SHA-256 in a manifest; **unsigned** unless you sign it with your own certificate |

## Release test gate

A release is approved only on a run of `node scripts/release-gate.mjs --release` that ends with `RELEASE APPROVAL: GRANTED`. That run is the whole regression (every Node suite and the Maven suites) plus the validation of a generated deployment: images built from generated Dockerfiles, a Compose stack started and used with authenticated requests (`scripts/validate-generated-deployment.mjs`; needs Docker; several minutes). There are three levels on purpose: `npm test` (fast, may skip), `node scripts/release-gate.mjs --suite all --java` (the complete regression: it ends with `RELEASE GATE: PASSED` and says `RELEASE APPROVAL: NOT GRANTED`, because no deployment was validated) and `--release`. A deployment check that failed, a part of the validation that was not reached, or a validation that could not run (no Docker engine) blocks the approval; `--release` cannot be combined with `--files`, `--suite fast` or `--allow-skip`. The gate writes its result with `--report <file>` and the deployment report next to it (`<file>.deployment.json`: build, start-up, health, readiness, authentication, authorization, TLS, routing, recovery, shutdown, cleanup).

The regression part works as before: a run of `node scripts/release-gate.mjs --java` ends with `RELEASE GATE: PASSED`. The gate runs every Node suite (and, with `--java`, the Maven suites) and fails when a test failed **or was skipped** for any reason other than "does not apply to this operating system". Day-to-day `npm test` may skip the tests that need Redis, RabbitMQ, Kafka, PostgreSQL, a JDK or a browser; a release may not. Start the infrastructure first (`node scripts/dispatch-brokers.mjs up`); the gate starts nothing itself. An exception needs an explicit `--allow-skip "<reason>"`, which stays listed in the gate's output and report (`--report <file>`).

## Signing

Signing keys are never stored in the repository; the scripts refuse a key located inside it. Pass a key with `--sign-key <file>` or `PSO_RELEASE_SIGNING_KEY_FILE`. Without a key the output is explicitly reported as **UNSIGNED**. GPG signatures for Maven Central and Authenticode signatures for Windows need keys and certificates that only the owner can provide (`EXTERNAL`).

## Publication

Releases are prepared locally; **nothing is published by any script**. Publishing to npm or Maven Central is a deliberate manual step after reviewing the manifest and the stage report.
