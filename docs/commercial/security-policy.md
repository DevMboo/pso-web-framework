# Security policy

## Reporting a vulnerability

The reporting channel is GitHub's private vulnerability reporting of the repository, described in [SECURITY.md](../../SECURITY.md). A target
acknowledgement time and a disclosure window are still to be set by the maintainer. Do not open public issues for vulnerabilities.

## What the project does today

- Secure defaults: bounded request sizes and time limits, rate limiting with trusted-proxy handling, RFC 9457 error bodies without internals, JWT validation with pinned algorithms, service-to-service TLS/mTLS options, correlation ids.
- Release hygiene (scripted, see `release-policy.md`): SHA-256 checksums, CycloneDX SBOM, licence inventory, secret scan of every tarball, `npm audit` for the production tree, optional Ed25519 signatures with a key kept outside the repository.
- Distribution packages (`.psopkg`) are signed with Ed25519, optionally encrypted per recipient (AES-256-GCM), verified before extraction, and extracted with path, size and link defences.

## What it does not promise

- No third-party penetration test, certification (SOC 2, ISO 27001) or SLSA-attested build exists.
- `npm audit --omit=dev` reports 0 vulnerabilities after upgrading the OpenTelemetry exporters to 0.223.0 (core 2.12.0). Before the upgrade, 11 moderate advisories all came from one issue, GHSA-8988-4f7v-96qf (unbounded allocation in W3C Baggage propagation, `@opentelemetry/core` below 2.8.0); PSO propagates only `traceparent`, so it did not use the vulnerable path, but the dependency was still upgraded. Maven dependencies have no automated vulnerability scan yet.
- Encrypting a package does not stop a legitimate recipient from reverse engineering it.
- The Windows installer in a development build is **unsigned**; users will see an unknown-publisher warning.
