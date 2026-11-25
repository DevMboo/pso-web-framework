/**
 * Commands from the specification that are not implemented yet. They fail loudly (exit 2) instead of pretending.
 * The documentation and the AI contexts read this list, so assistants are never told to use them.
 */
export const NOT_IMPLEMENTED: readonly string[] = [
  "dispatch:health",
];

/**
 * Capabilities that do not exist in this version. Used verbatim by the documentation and the AI contexts, so an assistant is never
 * told to rely on them. Every entry is checked against the sources by packages/cli/test/docs-parity.test.ts: a capability that was
 * implemented since must leave this list (orchestrator DTO validation, OpenTelemetry export, the Redis rate limiter, service
 * identity and the observability starter were listed here long after they existed).
 */
export const UNSUPPORTED_CAPABILITIES: readonly string[] = [
  "Exactly-once event delivery (dispatch is at-least-once), delayed redelivery, a TypeScript transactional outbox, trace context carried inside the dispatch envelope and consumer-lag display in Studio. Redis Streams, RabbitMQ and Kafka dispatch, retries, dead letters, idempotency, publisher authentication and the Spring transactional outbox ARE implemented.",
  "Inbound TLS termination in the orchestrator: it listens on plain HTTP, so put a TLS reverse proxy in front of it. OUTBOUND TLS and mutual TLS from the orchestrator to its upstream services ARE implemented, and so is TLS between Spring services (PsoHttpClient).",
  "Retries and circuit breakers for orchestrator upstream calls (Upstream.forward and UpstreamClient make one attempt; the Spring PsoHttpClient does retry idempotent requests), CORS handling in the orchestrator (the Spring services have it) and token revocation lists.",
  "Automatic distributed transactions, sagas or a workflow engine: an orchestrator action that composes several services (UpstreamClient) coordinates calls and nothing more.",
  "Applying a deployment to Kubernetes, ECS, Container Apps or Cloud Run: `pso deploy:init` and `pso deploy:validate` generate and check the descriptors; `pso deploy` itself executes the native directory target and Docker Compose only.",
  "Cloud providers other than SSH to a Linux server (AWS, Azure, Google Cloud, Kubernetes): the provider interface exists, no other provider does, and PSO provisions no cloud resources and spends no money. Cloud Lifecycle and Operations has been exercised against a disposable Linux container over real SSH, NOT against an external cloud environment.",
  "In Cloud Lifecycle and Operations: verification of release signatures (a checksum proves transfer integrity, not authorship), a Java dependency vulnerability scanner, a systemd service driver (processes are tracked by the agent's identity checks and do not restart after a server reboot), automatic TLS certificates and DNS changes, and frontend deployment.",
  "Published packages: nothing is published to npm or Maven Central. The CLI is installed from a signed .psopkg release package (`pso setup`) or a source checkout; the com.pso Java artifacts come from `pso java:install` (a source checkout), from a file repository built by scripts/release-maven.mjs, or from `pso docker:init --vendor` for image builds.",
  "A production identity provider: `pso idp:dev` is a development tool (synthetic identities, a key generated on the developer's machine) and refuses to run in production.",
];
