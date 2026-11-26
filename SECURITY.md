# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting for this repository (**Security → Report a
vulnerability**). Do not open a public issue, pull request or discussion for a vulnerability.

Please include the affected version (`pso --version` and the release label), the component, steps to reproduce and the impact you
observed. Do not include real credentials, tokens or personal data.

The maintainer acknowledges reports and coordinates a fix and a disclosure date with the reporter.

## Supported versions

| Version | Supported |
|---|---|
| `0.2.0-rc.7` (current release candidate) | yes |
| earlier `0.2.0` release candidates and `0.1.0` alphas | no: update to the current release |

## What the project does

- Secure defaults: deny-by-default routes, bounded request sizes and time limits, rate limiting, RFC 9457 error bodies without
  internals, JWT validation with pinned asymmetric algorithms, TLS and mTLS between services, masked secrets in logs and Studio.
- Release hygiene, by script: SHA-256 checksums, CycloneDX SBOMs, license inventories, secret and deny-list scans of every release,
  `npm audit` of the production dependency tree, Ed25519-signed packages and checksums with the key kept outside the repository.
- The Windows release executables are not Authenticode-signed yet; see the
  [code signing policy](https://devmboo.github.io/pso-web-docs/downloads/code-signing-policy.html).

## What it does not promise

There has been no third-party penetration test and there is no certification (for example SOC 2 or ISO 27001) or attested build
provenance. PSO Web Framework is provided under the Apache License 2.0, without warranty.
