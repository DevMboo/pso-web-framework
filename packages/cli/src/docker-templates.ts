import { servicePrefix, type ServiceDecl, type WorkspaceConfig } from "@pso/core";

const lines = (...l: string[]): string => l.join("\n") + "\n";

/** @param vendored the service carries its framework packages in vendor/pso (`pso docker:init --vendor`): they are copied before the install */
export const nodeDockerfile = (vendored = false): string => lines(
  "# syntax=docker/dockerfile:1",
  ...(vendored
    ? ["# The @pso/* framework packages are vendored in vendor/pso (pso docker:init --vendor): this build needs no access to a PSO checkout."]
    : ["# NOTE: @pso/core and @pso/http must be installable from a registry (or vendored) inside the build context."]),
  "FROM node:24-alpine AS build",
  "WORKDIR /app",
  "COPY package*.json ./",
  ...(vendored ? ["COPY vendor ./vendor"] : []),
  "RUN npm install",
  "COPY tsconfig.json ./",
  "COPY src ./src",
  "RUN npm run build && npm prune --omit=dev",
  "",
  "FROM node:24-alpine",
  "ENV NODE_ENV=production",
  "WORKDIR /app",
  "COPY --from=build --chown=node:node /app/node_modules ./node_modules",
  "COPY --from=build --chown=node:node /app/dist ./dist",
  "# pso.config*.json (when the project has one) holds the settings the runtime reads next to package.json (credentials are never written in it)",
  "COPY --chown=node:node package.json pso.config*.json ./",
  "USER node",
  "EXPOSE 3000",
  'HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/ready" >/dev/null || exit 1',
  'CMD ["node", "dist/main.js"]',
);

/** `vendored`: the com.pso artifacts are in vendor/maven (`pso docker:init --vendor`) and seed the build's local Maven repository. */
export const springDockerfile = (vendored = false): string => lines(
  "# syntax=docker/dockerfile:1",
  ...(vendored
    ? ["# The com.pso:* artifacts (BOM and starters) travel with the service in vendor/maven (written by `pso docker:init --vendor`) and seed",
      "# the local Maven repository of this build; everything else is downloaded from the Maven repositories the build can reach."]
    : ["# The com.pso:* artifacts (BOM and starters) must be resolvable from a Maven repository inside this build: publish them to your",
      "# registry (the local ~/.m2 of the machine is not visible here). `pso java:install` only installs them locally."]),
  "FROM eclipse-temurin:21-jdk AS build",
  "# the Maven Wrapper verifies the SHA-256 of the .zip distribution; without unzip it downloads the .tar.gz, whose checksum differs",
  "RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*",
  "WORKDIR /build",
  "COPY .mvn .mvn",
  "COPY mvnw pom.xml ./",
  ...(vendored ? ["COPY vendor/maven /root/.m2/repository"] : []),
  "RUN chmod +x mvnw && ./mvnw -B -ntp dependency:go-offline",
  "COPY src src",
  "RUN ./mvnw -B -ntp -DskipTests package",
  "",
  "FROM eclipse-temurin:21-jre",
  "RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \\",
  " && groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app",
  "WORKDIR /app",
  "COPY --from=build /build/target/*.jar app.jar",
  "USER 10001",
  "ENV JAVA_TOOL_OPTIONS=-XX:MaxRAMPercentage=75 SPRING_PROFILES_ACTIVE=prod",
  "EXPOSE 8081",
  'HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 CMD curl -fsS "http://127.0.0.1:${PORT:-8081}/actuator/health" >/dev/null || exit 1',
  'ENTRYPOINT ["java", "-jar", "/app/app.jar"]',
);

export const dockerignore = (): string => lines("node_modules", "target", "dist", ".git", ".pso", "keys", "*.pem", ".env", ".env.*", "*.log");

const upper = (n: string) => n.toUpperCase().replace(/-/g, "_");

/** How the orchestrator reaches one upstream: "tls" when the project configures TLS for it (pso.config.json http.upstreams.<name>.tls), else plain HTTP. */
export type UpstreamTransport = "tls" | "plaintext" | "configured";
/** Where the TLS material is inside every container, and where the compose file takes it from on the host. */
export const TLS_MOUNT = "/run/pso/tls";
const TLS_SOURCE = "${PSO_TLS_DIR:-./tls}";

/**
 * @param transports per upstream service name; a service that is not listed is "plaintext". Nothing here is a wildcard: every upstream
 *        gets its own address and its own, explicit transport decision.
 */
export function compose(ws: WorkspaceConfig, transports: Readonly<Record<string, UpstreamTransport>> = {}, opts: { containerUser?: string } = {}): string {
  const orch = ws.services.find((s) => s.role === "orchestrator");
  const upstreams = ws.services.filter((x) => x.role !== "orchestrator");
  const transport = (n: string): UpstreamTransport => transports[n] ?? "tls";
  const plain = upstreams.filter((u) => transport(u.name) === "plaintext");
  const tls = upstreams.filter((u) => transport(u.name) === "tls");
  const svc = (s: ServiceDecl): string[] => {
    const isOrch = s.role === "orchestrator";
    const out = [
      `  ${s.name}:`,
      `    build: ./${s.path}`,
      "    restart: unless-stopped",
      // the user the container runs as: the image's own unprivileged user unless PSO_CONTAINER_USER names another one (on Linux, the
      // owner of the mounted TLS keys, which are readable by their owner only)
      `    user: "\${PSO_CONTAINER_USER:-${opts.containerUser ?? (isOrch || s.runtime === "node" ? "node" : "10001")}}"`,
      "    environment:",
      "      <<: *pso-env",
      `      PORT: "${s.port}"`,
      '      HOST: "0.0.0.0"',
    ];
    if (isOrch) {
      out.push('      PSO_SHUTDOWN_GRACE_MS: "${PSO_SHUTDOWN_GRACE_MS:-5000}"');
      for (const o of upstreams) {
        out.push(`      PSO_UPSTREAM_${upper(o.name)}: "${o.name}:${o.port}"`);
        // the workspace file is not in the image: the service's endpoint prefix travels with its address, or every forwarded path would miss it
        if (servicePrefix(o)) out.push(`      PSO_UPSTREAM_${upper(o.name)}_PREFIX: "${servicePrefix(o)}"`);
        if (transport(o.name) === "configured") out.push(`      # ${o.name}: TLS is configured for this upstream in pso.config.json (http.upstreams.${o.name}.tls); nothing is generated for it here`);
        else if (transport(o.name) === "tls") out.push(`      PSO_UPSTREAM_${upper(o.name)}_TLS: "true"`, `      PSO_UPSTREAM_${upper(o.name)}_TLS_CA_FILE: ${TLS_MOUNT}/ca.crt`);
        else out.push(`      PSO_UPSTREAM_${upper(o.name)}_ALLOW_PLAINTEXT: "\${PSO_UPSTREAM_${upper(o.name)}_ALLOW_PLAINTEXT:-true}"`);
      }
    } else if (transport(s.name) === "tls") {
      // the service terminates TLS itself with its own certificate (Spring Boot reads PEM files); nothing is accepted in clear text
      out.push(`      SERVER_SSL_CERTIFICATE: file:${TLS_MOUNT}/tls.crt`, `      SERVER_SSL_CERTIFICATE_PRIVATE_KEY: file:${TLS_MOUNT}/tls.key`);
    }
    if (isOrch ? tls.length > 0 : transport(s.name) === "tls") {
      out.push("    volumes:", isOrch ? `      - ${TLS_SOURCE}/ca.crt:${TLS_MOUNT}/ca.crt:ro` : `      - ${TLS_SOURCE}/${s.name}:${TLS_MOUNT}:ro`);
      // the image's own health check speaks plain HTTP; with TLS it verifies the service's certificate against the same authority
      if (!isOrch) out.push("    healthcheck:", `      test: ["CMD-SHELL", "curl -fsS --cacert ${TLS_MOUNT}/ca.crt https://localhost:${s.port}/actuator/health >/dev/null || exit 1"]`, "      interval: 10s", "      timeout: 3s", "      start_period: 40s", "      retries: 6");
    }
    // Docker kills a container this long after SIGTERM: it must outlast the application's own shutdown deadline
    out.push('    stop_grace_period: "${PSO_STOP_GRACE_PERIOD:-40s}"');
    out.push("    read_only: true", "    tmpfs:", "      - /tmp", "    cap_drop:", "      - ALL", "    security_opt:", "      - no-new-privileges:true");
    out.push("    networks:", "      - internal");
    if (isOrch) out.push("    ports:", `      - "127.0.0.1:${s.port}:${s.port}"`); // the only published port, bound to loopback; put a TLS reverse proxy in front for real traffic
    const deps = isOrch ? ws.services.filter((x) => x.role !== "orchestrator").map((x) => x.name) : (s.dependsOn ?? []);
    if (deps.length) out.push("    depends_on:", ...deps.flatMap((d) => [`      ${d}:`, "        condition: service_healthy"]));
    return out;
  };
  return lines(
    "# Generated by `pso docker:init`. Secrets are never stored here: values come from the environment / .env (see .env.example).",
    ...(orch && tls.length ? [
      "#",
      `# Upstream transport: TLS. The orchestrator reaches ${tls.map((p) => p.name).join(", ")} over HTTPS and verifies each certificate (issuing`,
      "# authority and host name; verification cannot be switched off). The certificates are read from PSO_TLS_DIR (default ./tls):",
      "#   ca.crt   <service>/tls.crt   <service>/tls.key   <service>/ca.crt",
      "# Development: `pso tls:init --dev` creates them. Production: put the certificates of your own certificate authority there",
      "# (each service certificate must name the service, e.g. \"catalog\", and \"localhost\" for the container health check), then",
      "# `pso tls:check`. Mutual TLS: add PSO_UPSTREAM_<NAME>_TLS_CERT_FILE / _TLS_KEY_FILE in docker-compose.override.yml.",
    ] : []),
    ...(orch && plain.length ? [
      "#",
      "# Upstream transport. The orchestrator runs in production mode, where an upstream on another host must use TLS. On the private",
      `# network "internal" of this file it reaches ${plain.map((p) => p.name).join(", ")} over plain HTTP, and says so explicitly, one upstream at a time`,
      "# (PSO_UPSTREAM_<NAME>_ALLOW_PLAINTEXT). That is a deployment choice, not encryption: the traffic can be read by anything that can",
      "# observe this network, and the orchestrator does not forward the caller's bearer token over a plaintext hop. To use TLS for an",
      "# upstream, set PSO_UPSTREAM_<NAME>_ALLOW_PLAINTEXT=false in .env and give the orchestrator PSO_UPSTREAM_<NAME>_TLS=true (plus",
      "# _TLS_CA_FILE and, for mutual TLS, _TLS_CERT_FILE/_TLS_KEY_FILE, mounted from docker-compose.override.yml); without TLS it then",
      "# refuses to start. There is no switch that allows plaintext to every upstream at once.",
      "#",
      "# Shutdown. PSO_STOP_GRACE_PERIOD (how long Docker waits after SIGTERM) must be longer than PSO_SHUTDOWN_GRACE_MS + 11 s.",
    ] : []),
    "x-pso-env: &pso-env",
    "  PSO_JWT_ISSUER: ${PSO_JWT_ISSUER:?set PSO_JWT_ISSUER}",
    "  PSO_JWT_AUDIENCE: ${PSO_JWT_AUDIENCE:?set PSO_JWT_AUDIENCE}",
    "  PSO_JWT_JWKS_URI: ${PSO_JWT_JWKS_URI:?set PSO_JWT_JWKS_URI}",
    "  PSO_JWT_ALGORITHMS: ${PSO_JWT_ALGORITHMS:-ES256}",
    "  # an identity provider on a private network or with a private certificate authority (empty = not used; see .env.example)",
    "  PSO_JWT_JWKS_PRIVATE_HOSTS: ${PSO_JWT_JWKS_PRIVATE_HOSTS:-}",
    "  PSO_JWT_JWKS_CA_FILE: ${PSO_JWT_JWKS_CA_FILE:-}",
    "  # the same two settings under the names the Spring services bind (pso.security.jwt.ca-file, pso.security.jwt.private-hosts)",
    "  PSO_SECURITY_JWT_CA_FILE: ${PSO_JWT_JWKS_CA_FILE:-}",
    "  PSO_SECURITY_JWT_PRIVATE_HOSTS: ${PSO_JWT_JWKS_PRIVATE_HOSTS:-}",
    "",
    "services:",
    ...[...ws.services].sort((a, b) => (a.role === "orchestrator" ? 1 : 0) - (b.role === "orchestrator" ? 1 : 0)).flatMap((s) => [...svc(s), ""]),
    "networks:",
    "  internal:",
    "    driver: bridge",
  );
}

export const envExample = (ws?: WorkspaceConfig, transports: Readonly<Record<string, UpstreamTransport>> = {}): string => lines(
  "# Copy to .env and fill in. Never commit .env.",
  "PSO_JWT_ISSUER=https://idp.example.com",
  "PSO_JWT_AUDIENCE=pso-api",
  "PSO_JWT_JWKS_URI=https://idp.example.com/.well-known/jwks.json",
  "PSO_JWT_ALGORITHMS=ES256",
  "",
  "# Shutdown: how long running requests may take to finish (ms), and how long Docker waits after SIGTERM before it kills a",
  "# container. Keep PSO_STOP_GRACE_PERIOD longer than PSO_SHUTDOWN_GRACE_MS + 11 s.",
  "# PSO_SHUTDOWN_GRACE_MS=5000",
  "# PSO_STOP_GRACE_PERIOD=40s",
  "",
  "# The user the containers run as (uid:gid). Linux: the TLS keys in ./tls are readable by their owner only, so the containers must run",
  "# as that owner: PSO_CONTAINER_USER=$(id -u):$(id -g). Windows and macOS (Docker Desktop): leave it unset.",
  "# PSO_CONTAINER_USER=1000:1000",
  "",
  "# Identity provider on a private network (for example a container of this stack). Its JWKS address is refused, by the orchestrator",
  "# and by every Spring service, unless the exact host:port of PSO_JWT_JWKS_URI is listed here; nothing else on a private network",
  "# becomes reachable through it.",
  "# PSO_JWT_JWKS_PRIVATE_HOSTS=idp:8443",
  "# Certificate authority (PEM, a path inside the containers) that signed the identity provider's certificate, when it is not a public one.",
  `# PSO_JWT_JWKS_CA_FILE=${TLS_MOUNT}/ca.crt`,
  ...(ws && ws.services.some((s) => s.role !== "orchestrator" && (transports[s.name] ?? "tls") === "tls") ? ["", "# TLS between the orchestrator and the services: the directory with ca.crt and <service>/tls.crt, tls.key, ca.crt (see docker-compose.yml).", "# PSO_TLS_DIR=./tls"] : []),
  ...(ws && ws.services.some((s) => s.role === "orchestrator") ? ws.services.filter((s) => s.role !== "orchestrator" && (transports[s.name] ?? "tls") === "plaintext").flatMap((s, i) => [
    ...(i === 0 ? ["", "# Upstream transport, one decision per upstream (this file was generated with --transport plaintext). true: plain HTTP inside the", "# private compose network, not encrypted, and the caller's token is not forwarded. false: the orchestrator requires TLS for that", "# upstream and refuses to start without it (see docker-compose.yml)."] : []),
    `# PSO_UPSTREAM_${upper(s.name)}_ALLOW_PLAINTEXT=true`,
  ]) : []),
);

export function ciWorkflow(ws: WorkspaceConfig): string {
  const spring = ws.services.filter((s) => s.runtime === "spring-boot");
  const orch = ws.services.find((s) => s.role === "orchestrator");
  return lines(
    "# Generated by `pso docker:init`.",
    "name: ci",
    "on:",
    "  push:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
    ...(orch ? [
      "  orchestrator:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      '          node-version: "24"',
      `      - run: npm install --prefix ${orch.path}`,
      `      - run: npx --prefix ${orch.path} tsc --noEmit -p ${orch.path}`,
      `      - run: npm audit --omit=dev --audit-level=high --prefix ${orch.path}`,
    ] : []),
    ...(spring.length ? [
      "  spring:",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      `        service: [${spring.map((s) => s.path).join(", ")}]`,
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-java@v4",
      "        with:",
      "          distribution: temurin",
      '          java-version: "21"',
      "          cache: maven",
      "      - run: ./mvnw -B -ntp verify",
      "        working-directory: ${{ matrix.service }}",
    ] : []),
    "  compose:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: cp .env.example .env",
    "      - run: docker compose config --quiet",
  );
}
