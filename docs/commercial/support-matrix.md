# Support matrix (what was actually exercised)

"Exercised" means an automated test or a recorded manual run on the date in the progress record (`docs/implementation/foundation-hardening-progress.md`). Everything else is **not supported**, even if it probably works.

| Area | Exercised | Not exercised |
|---|---|---|
| Node.js | 24.x (Windows 11) | 22 and older (the packages declare `engines.node >=24`); Linux and macOS in CI (no CI is configured here) |
| Java | 21 (Temurin) with Spring Boot 3.5.x | other JDKs and Boot lines |
| Operating system for the CLI and installer | Windows 11 x64 | Windows Server, Linux, macOS installers |
| Brokers (Dispatch) | Redis, RabbitMQ and Kafka in local Docker containers, Windows host | managed offerings (Amazon MSK, Azure Event Hubs, Confluent Cloud, ElastiCache), cluster and TLS/SASL variants other than those in tests |
| Database | PostgreSQL in a local container; H2 for the local profile | other databases, managed services |
| Containers | Hardened Spring service image run locally with Docker (non-root, read-only root, no capabilities) | the generated multi-stage Dockerfiles in a registry-backed build (PSO artifacts are not published), orchestrator image |
| Kubernetes, ECS, Container Apps, Cloud Run | descriptors generated and **statically** checked | any real cluster or cloud account |
| Windows installer | built with Inno Setup 7, silent install, repair, update and rollback verified on a temporary root | Inno uninstaller (blocked by the host's application-control policy), signed installer, SmartScreen behaviour, Windows other than 11 |
| Browsers (Studio, docs portal) | Chromium via Playwright | Firefox, Safari |
| Observability | OTLP export verified against local receivers | Grafana/Datadog/etc. vendor back ends |

Platform architecture: x64 only.
