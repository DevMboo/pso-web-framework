<p align="center">
  <img src="assets/branding/pso-logo.svg" alt="PSO Web Framework logo" width="90" height="90">
</p>

<h1 align="center">PSO Web Framework</h1>

<p align="center"><strong>Path Structure Working</strong></p>

<p align="center">
  A framework and CLI for structured web applications: a TypeScript orchestrator as the single public entry point,
  Spring Boot microservices that own their data, a local infrastructure engine, Studio and a deployment agent.
</p>

<p align="center">
  <a href="https://github.com/DevMboo/pso-web-framework/releases"><img alt="Release" src="https://img.shields.io/github/v/release/DevMboo/pso-web-framework?include_prereleases&amp;label=release"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&amp;logoColor=white">
  <img alt="Node.js 24 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A524-5FA04E?logo=nodedotjs&amp;logoColor=white">
  <img alt="Java 21 or newer" src="https://img.shields.io/badge/Java-21%2B-ED8B00?logo=openjdk&amp;logoColor=white">
  <img alt="Spring Boot 3.5" src="https://img.shields.io/badge/Spring_Boot-3.5-6DB33F?logo=springboot&amp;logoColor=white">
</p>

<p align="center">
  <a href="https://devmboo.github.io/pso-web-docs/">Documentation</a> ·
  <a href="https://devmboo.github.io/pso-web-docs/getting-started/quick-start.html">Getting Started</a> ·
  <a href="https://github.com/DevMboo/pso-web-framework/releases">Releases</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

**PSO Web** is a framework and command-line tool (`pso`) for building structured web applications: a TypeScript orchestrator that is the
single public entry point, Spring Boot microservices that own their data, a local infrastructure engine (certificates, identity provider,
databases, containers), Studio, and a deployment agent.

- Documentation: https://devmboo.github.io/pso-web-docs/
- License: [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE))
- Maintainer: [DevMboo](https://github.com/DevMboo)
- Current release: `0.2.0-rc.6` (release candidate; Windows x64 distribution; the CLI reports version `0.2.0`)

PSO Web Framework is free and open-source software. It contains no telemetry and transfers nothing unless you ask for it
([privacy policy](https://devmboo.github.io/pso-web-docs/downloads/privacy-policy.html)). Release executables are not Authenticode-signed
yet ([code signing policy](https://devmboo.github.io/pso-web-docs/downloads/code-signing-policy.html)).

## Repository layout

| Path | Contents |
|---|---|
| `packages/` | the TypeScript packages: `cli` (the `pso` command, templates, generators, Studio, documentation sources in `cli/docs`), `core`, `http`, `security`, `dispatch`, `channels`, `infra`, `deploy`, `frontend*` |
| `pso-java/` | the Java starters, auto-configuration, BOM and test support for Spring Boot services (Maven) |
| `scripts/` | build, release, documentation and validation scripts; `scripts/psd/` builds and signs the Windows distribution |
| `fixtures/` | validation workloads used by the test suites |
| `docs/` | maintainer documents (`docs/commercial/`, documentation authoring) and the evidence the documentation tests check |
| `.github/`, `.signpath/` | the prepared release workflow and code-signing configuration (not active yet) |

## Build from source

Requirements: Node.js 24 or newer, JDK 21 or newer (for the Java starters and generated services), and Git. Docker is optional (local
infrastructure and some integration tests).

```bash
npm ci                 # exact dependency versions from package-lock.json
npm run build          # TypeScript packages, the agent bundle and the diagnostic codes
node packages/cli/bin/pso.js --version

cd pso-java
./mvnw -B package      # Java starters (Windows: .\mvnw.cmd -B package)
./mvnw -B install      # make them available to services generated from this checkout (pso java:install does the same)
```

`tools/dev-bin` contains `pso-dev` launchers that run this checkout without shadowing an installed `pso`
([installed and development CLI](https://devmboo.github.io/pso-web-docs/devops/installed-and-development-cli.html)).

## Tests

```bash
node --test --experimental-strip-types packages/cli/test/docs-*.test.ts   # documentation checks
node --test --experimental-strip-types packages/core/test/*.test.ts      # one package's tests
```

Some suites need Docker, a JDK or local brokers (`node scripts/dispatch-brokers.mjs up`); they skip themselves with a reason when the
requirement is missing.

## Releases

Release artifacts are built by scripts, never by hand: `node scripts/release.mjs npm` (npm tarballs, SBOM, checksums),
`node scripts/release-maven.mjs` (Java artifacts) and `scripts/psd/` (Windows installer and portable ZIP; see
[scripts/psd/README.md](scripts/psd/README.md)). Unsigned builds are labelled as development builds; a production build requires an
Authenticode signing identity and passes a release gate.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution procedure and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
