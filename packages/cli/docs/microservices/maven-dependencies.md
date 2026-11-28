---
title: Maven dependencies and SNAPSHOTs
description: The Maven Wrapper, the PSO BOM, reproducible builds, the release script that produces a file repository and an SBOM, and what PSO does about SNAPSHOT dependencies.
order: 8
status: partial
keywords: [maven, snapshot, wrapper, reproducible, sbom, bom, release, file repository]
related: [spring/maven-bom, devops/build-and-deploy, security/auditing, devops/distribution-and-installation]
---
## Supported

For the installed `0.2.0-rc.8` distribution, generated services request `com.pso:*:0.2.0-rc.8` through the BOM; its portable package carries matching Maven artifacts for `pso java:install`. A CLI run from this framework checkout instead reads `pso-java/pom.xml` and uses `0.1.0-SNAPSHOT`. See [Maven BOM and Java versions](/spring/maven-bom). The `0.1.0` release run below is an illustrative older fixed-version example, not the installed rc.8 artifact set.

- **Maven Wrapper.** Every service has `mvnw`, `mvnw.cmd` and `.mvn/wrapper/maven-wrapper.properties` pinned to Maven 3.9.9 with `distributionSha256Sum`. Builds do not depend on a global Maven.
- **One BOM.** Generated POMs import `com.pso:pso-bom`, so every PSO starter shares one version (`pso.version`) and Spring Boot's versions stay managed by the parent. See [Maven BOM and SNAPSHOTs](/spring/maven-bom).
- **A local development workflow.** `pso java:install` builds the PSO artifacts and installs them into `~/.m2`; nothing is copied by hand.
- **A guard against mutable artifacts.** `pso security:audit` reports `SNAPSHOT` and version-range dependencies in POMs, and `pso deploy` **refuses to deploy a SNAPSHOT build**. Production releases must be immutable.
- **A release preparation script.** `node scripts/release-maven.mjs` (in the framework repository) sets a fixed version on a temporary copy, deploys every module with sources to a **local file repository**, writes SHA-256 sums and a CycloneDX SBOM, and builds a freshly generated service against that repository with an isolated local Maven repository. It never publishes. See [Distribution](/devops/distribution-and-installation).

## What a release run looks like

Expected output of the stages (abridged):

```text evidence="expected"
PASSED   set release version      - 0.1.0 in every module (temporary copy; the repository is unchanged)
PASSED   deploy to file repository - N jars (+ sources jars and poms), no SNAPSHOT
PASSED   no SNAPSHOT artifacts    - none
PASSED   checksums                - SHA-256 of 54 files
PASSED   SBOM (CycloneDX)         - 156 components; licences: Apache-2.0=121, EPL-2.0=10, BSD-3-Clause=10, MIT=5, ...
NOT RUN  signing                  - no key supplied; artifacts are UNSIGNED (also no GPG signatures)
PASSED   consumer build           - generated service built against the release repository with an isolated local repository
```

## Not implemented

- Publishing the PSO artifacts to a public repository (the `com.pso` group is local until a namespace is owned and registered). Docker builds that resolve them need a repository the build can reach: point the service at your own repository (file, internal Nexus/Artifactory) or vendor the artifacts.
- GPG signing of Maven artifacts (needs your key) and CVE scanning of Maven dependencies (`security:audit` states that Maven CVE scanning is **not** performed). The SBOM inventories the dependencies; it does not assess them.
- Dependency locking beyond what Maven provides.

## Variations

| You want | Do |
|---|---|
| to build a service on your machine | `pso java:install` once, then `mvnw package` |
| to build in CI or a container | publish the BOM and starters to a repository your build reaches, set it in the project's `pom.xml` or `settings.xml` |
| a fixed version for a release | `pso.version` set to a release version; never `-SNAPSHOT` for production |
| to check for mutable versions | `pso security:audit` |

## Common mistakes

- Building a Docker image whose Maven cannot resolve `com.pso` artifacts (they are not on Central).
- Leaving `-SNAPSHOT` in `pso.version` for a deployment (the deploy command refuses it).
- Treating the SBOM as a vulnerability report.

## Next steps

- [Maven BOM](/spring/maven-bom)
- [Build and deploy](/devops/build-and-deploy)
