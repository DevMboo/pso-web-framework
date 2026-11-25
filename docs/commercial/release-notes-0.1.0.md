# PSO Web 0.1.0: release notes (development release)

## Included

- TypeScript orchestrator and Spring Boot starters (security, HTTP client with mTLS options, data, observability, rate limiting with Redis), Dispatch (Redis, RabbitMQ, Kafka) with an optional transactional outbox for Spring + PostgreSQL.
- RFC 9457 error responses with stable `PSO_*` codes, token-bucket rate limiting, official OpenTelemetry export, Studio telemetry view.
- Cross-runtime conformance fixtures (errors, rate limiting, JWT, authorization, correlation id, Dispatch) shared by Node and Spring tests.
- CLI: `pso dist` (signed, optionally encrypted `.psopkg`), `setup`, `integrity`, `repair`, `update`, `uninstall`, `deploy:init`, `deploy:validate`.
- Release scripts for npm and Maven with checksums, SBOM and licence inventory.

## Known limitations

- Unsigned Windows installer; Node.js 24+ must be on PATH; the Inno uninstaller was not run in the verification environment.
- Nothing has been published to npm or Maven Central, so the generated Dockerfiles (which resolve `com.pso:*` and `@pso/*` from registries) need those packages published or vendored before an image build.
- Cloud descriptors were never applied to a cluster or account.
- Maven dependencies are inventoried (SBOM) but not scanned for vulnerabilities.
- No licence selected (`licensing-status.md`); no security contact defined (`security-policy.md`).
- The transactional outbox is Spring only by design (see the decision record `decisions/why-no-typescript-outbox`).
