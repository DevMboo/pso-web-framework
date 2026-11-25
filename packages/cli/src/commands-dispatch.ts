import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceDecl } from "@pso/core";
import { describeDispatchConfig, loadDispatchConfig, type DispatchConfig } from "@pso/dispatch";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command, type Ctx } from "./commands.ts";
import { addPomDependency } from "./commands-java.ts";
import { buildLock, discoverDispatch, lockFindings, LOCK_FILE, PROVIDERS, readLock, type Finding, type Provider, type ServiceDispatch } from "./dispatch-static.ts";
import { frameworkSpecs } from "./specs.ts";
import { parseYaml, get } from "./yaml-lite.ts";

const CAPS: Record<Provider, { publishAck: string; ordering: string; redelivery: string; deadLetter: string; lag: boolean; notes: string }> = {
  redis: { publishAck: "XADD acknowledged by Redis: in memory, durable only if the server persists (AOF) or replicates", ordering: "per stream (single consumer per group member); not partitioned", redelivery: "pending entries are reclaimed (XAUTOCLAIM) after pso.dispatch.redis.min-idle", deadLetter: "<channel>.dlq stream", lag: true, notes: "Redis Streams, never Pub/Sub. Retention is approximate MAXLEN trimming: size it above your slowest consumer." },
  rabbitmq: { publishAck: "publisher confirm for a persistent message routed to a durable queue", ordering: "none guaranteed with concurrency > 1", redelivery: "unacknowledged messages are requeued on connection loss; nack requeues after a pause", deadLetter: "<channel>.dlq exchange and queue", lag: false, notes: "Publishing before any consumer group declared its queue is refused (unroutable), never silently dropped." },
  kafka: { publishAck: "acks=all: acknowledged by all in-sync replicas (durability depends on min.insync.replicas)", ordering: "per partition (events with the same key); never global", redelivery: "offsets are committed only after processing; a failed message is redelivered from its offset", deadLetter: "<channel>.dlq topic", lag: true, notes: "A message being retried blocks later messages of its partition. Redpanda works the same way. Exactly-once processing is NOT provided." },
};

const COMPOSE: Record<Provider, string> = {
  redis: `# Local development broker for PSO Dispatch (Redis Streams). Start it with: docker compose -f infra/dispatch/redis.compose.yml up -d
# Then: REDIS_URL=redis://127.0.0.1:6379
services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["127.0.0.1:6379:6379"]
`,
  rabbitmq: `# Local development broker for PSO Dispatch (RabbitMQ). Start it with: docker compose -f infra/dispatch/rabbitmq.compose.yml up -d
# Then: RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672   (the guest account only works from localhost; use real credentials elsewhere)
services:
  rabbitmq:
    image: rabbitmq:3.13-alpine
    ports: ["127.0.0.1:5672:5672"]
`,
  kafka: `# Local development broker for PSO Dispatch (Apache Kafka, single node KRaft). Start it with: docker compose -f infra/dispatch/kafka.compose.yml up -d
# Then: KAFKA_BOOTSTRAP_SERVERS=127.0.0.1:9092   (Redpanda is protocol compatible and can replace this service)
services:
  kafka:
    image: apache/kafka:3.8.0
    ports: ["127.0.0.1:9092:9092"]
    environment:
      KAFKA_NODE_ID: "1"
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://127.0.0.1:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1"
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1"
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1"
`,
};

const YML_BLOCK: Record<Provider, string> = {
  redis: "    redis:\n      url: ${REDIS_URL:}\n      max-length: 100000\n      min-idle: 60s\n      block: 2s\n      stream-creation: auto\n",
  rabbitmq: "    rabbitmq:\n      url: ${RABBITMQ_URL:}\n      exchange-prefix: pso.\n",
  kafka: "    kafka:\n      bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS:}\n      client-id: ${spring.application.name}\n      topic-creation: auto\n      partitions: 1\n      replication-factor: 1\n      ssl: false\n",
};
const NODE_DEPS: Record<Provider, [string, string]> = { redis: ["ioredis", "^5.4.1"], rabbitmq: ["amqplib", "^0.10.4"], kafka: ["kafkajs", "^2.2.4"] };
const TEST_ADAPTER_DEP = "    <dependency>\n      <groupId>com.pso</groupId>\n      <artifactId>pso-dispatch-test</artifactId>\n      <scope>test</scope>\n    </dependency>\n";
const starterDep = (p: Provider) => `    <dependency>\n      <groupId>com.pso</groupId>\n      <artifactId>pso-dispatch-${p}-starter</artifactId>\n    </dependency>\n`;

/** Must stay identical to Outbox.TABLE_SQL in pso-spring-boot-autoconfigure (a test compares them). */
const OUTBOX_SQL = `CREATE TABLE IF NOT EXISTS pso_outbox (
    id              VARCHAR(128) PRIMARY KEY,
    channel         VARCHAR(100)  NOT NULL,
    event_key       VARCHAR(256),
    envelope        TEXT          NOT NULL,
    created_at      TIMESTAMP     NOT NULL,
    attempts        INTEGER       NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP     NOT NULL,
    last_error      VARCHAR(200),
    published_at    TIMESTAMP,
    failed_at       TIMESTAMP
);
CREATE INDEX IF NOT EXISTS pso_outbox_pending ON pso_outbox (next_attempt_at) WHERE published_at IS NULL AND failed_at IS NULL;
`;

function target(ctx: Ctx): { root: string; svc: ServiceDecl; dir: string } {
  const { root, config } = requireWorkspace(ctx);
  const candidates = config.services.filter((s) => (s.runtime === "spring-boot") || s.role === "orchestrator");
  const name = str(ctx.flags["service"]);
  const svc = name ? candidates.find((s) => s.name === name) : candidates.length === 1 ? candidates[0] : undefined;
  if (!svc) throw new CliError(name ? `"${name}" is not a Spring service or the orchestrator` : "Name the service with --service", `Candidates: ${candidates.map((s) => s.name).join(", ") || "(none)"}`);
  return { root, svc, dir: join(root, ...svc.path.split("/")) };
}

const sev = (f: Finding) => (f.severity === "error" ? 2 : f.severity === "warning" ? 1 : 0);

function printFindings(all: Array<{ service: string; findings: Finding[] }>): string {
  const lines: string[] = [];
  for (const d of all) for (const f of d.findings) lines.push(`${f.severity.toUpperCase().padEnd(7)} ${f.code} ${d.service}${f.file ? ` (${f.file})` : ""}\n        ${f.message}${f.hint ? `\n        fix: ${f.hint}` : ""}`);
  return lines.join("\n");
}

import { dispatchFindings } from "./dispatch-static.ts";
export { dispatchFindings };

/** env-aware value of a Spring placeholder: ${NAME:default} -> process.env.NAME ?? default */
const fromEnv = (v: unknown): string => (typeof v === "string" ? v.replace(/\$\{([A-Za-z0-9_.]+)(?::([^}]*))?\}/g, (_m, n: string, d?: string) => process.env[n] ?? d ?? "") : v === null || v === undefined ? "" : String(v));

export async function probe(root: string, d: ServiceDispatch, svc: ServiceDecl): Promise<{ service: string; provider: string; status: "up" | "down" | "not-configured" | "no-provider"; detail: string; ms?: number; topology?: string }> {
  const provider = (d.installed ?? (d.provider !== "none" ? d.provider : null)) as Provider | null;
  if (!provider) return { service: d.service, provider: "none", status: "no-provider", detail: "no provider installed: nothing to probe" };
  let cfg: DispatchConfig | undefined;
  try {
    if (svc.runtime === "node") cfg = loadDispatchConfig({ projectDir: join(root, ...svc.path.split("/")), source: d.service, env: { ...process.env, PSO_DISPATCH_PROVIDER: provider } });
    else {
      const y = parseYaml(readFileSync(join(root, ...svc.path.split("/"), "src/main/resources/application.yml"), "utf8"));
      const g = (p: string) => fromEnv(get(y, `pso.dispatch.${p}`));
      const settings = { source: d.service } as DispatchConfig["settings"];
      cfg = {
        enabled: true, provider, settings, observability: true,
        redis: { url: g("redis.url"), maxLength: Number(g("redis.max-length") || 100000), minIdleMs: 60_000, blockMs: 500, streamCreation: g("redis.stream-creation") === "require" ? "require" : "auto" },
        rabbitmq: { url: g("rabbitmq.url"), exchangePrefix: g("rabbitmq.exchange-prefix") || "pso." },
        kafka: { brokers: g("kafka.bootstrap-servers").split(",").map((x) => x.trim()).filter(Boolean), clientId: `${d.service}-doctor`, topicCreation: "require", partitions: 1, replicationFactor: 1, ssl: g("kafka.ssl") === "true" },
      };
    }
  } catch (e) { return { service: d.service, provider, status: "not-configured", detail: (e as Error).message.split("\n")[0]! }; }
  const endpoint = provider === "redis" ? cfg.redis.url : provider === "rabbitmq" ? cfg.rabbitmq.url : cfg.kafka.brokers.join(",");
  if (!endpoint) return { service: d.service, provider, status: "not-configured", detail: `no ${provider === "kafka" ? "bootstrap servers" : "URL"} resolves from the environment (${provider === "redis" ? "REDIS_URL" : provider === "rabbitmq" ? "RABBITMQ_URL" : "KAFKA_BOOTSTRAP_SERVERS"} is not set)` };
  const { createAdapter } = await import("@pso/dispatch");
  const adapter = await createAdapter(cfg);
  const t0 = Date.now();
  try {
    await Promise.race([adapter.connect(), new Promise((_r, rej) => setTimeout(() => rej(new Error("connection timed out after 8 s")), 8000))]);
    const h = await adapter.health();
    return { service: d.service, provider, status: h.status, detail: h.detail, ms: Date.now() - t0 };
  } catch (e) { return { service: d.service, provider, status: "down", detail: (e as Error).message.split("\n")[0]!.replace(/\/\/[^@\s]*@/g, "//***@") }; }
  finally { await adapter.close().catch(() => undefined); }
}

export const DISPATCH_COMMANDS: Record<string, Command> = {
  "dispatch:providers": {
    usage: "pso dispatch:providers [--json]",
    summary: "List the supported dispatch providers, their guarantees and which service has which adapter installed",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const found = discoverDispatch(root, config);
      const rows = PROVIDERS.map((p) => ({ provider: p, ...CAPS[p], installedIn: found.filter((d) => d.installed === p).map((d) => d.service) }));
      emit(ctx, rows, rows.map((r) => `${r.provider}\n  publish ack: ${r.publishAck}\n  ordering:    ${r.ordering}\n  redelivery:  ${r.redelivery}\n  dead letter: ${r.deadLetter}\n  lag:         ${r.lag ? "observable" : "not available"}\n  note:        ${r.notes}\n  installed in: ${r.installedIn.join(", ") || "-"}`).join("\n\n"));
      return 0;
    },
  },

  "dispatch:install": {
    usage: "pso dispatch:install <redis|rabbitmq|kafka> [--service <name>] [--dry-run] [--json]",
    summary: "Install a dispatch provider into a Spring service or the orchestrator (dependency, configuration, local broker file). Dispatch stays disabled until you enable it",
    run(ctx) {
      const provider = ctx.positionals[0] as Provider | undefined;
      if (!provider || !PROVIDERS.includes(provider)) throw new CliError(`Unknown provider "${provider ?? ""}"`, `Supported: ${PROVIDERS.join(", ")}`);
      const { root, svc, dir } = target(ctx);
      const dry = ctx.flags["dry-run"] === true;
      const changes: string[] = [];
      const writes: Array<[string, string]> = [];
      const existing = discoverDispatch(root, requireWorkspace(ctx).config).find((d) => d.service === svc.name);
      if (existing?.installed && existing.installed !== provider) throw new CliError(`${svc.name} already has the ${existing.installed} adapter`, `A service uses one provider. Run \`pso dispatch:remove --service ${svc.name}\` first, or migrate deliberately (see the provider migration guide)`);

      if (svc.runtime === "spring-boot") {
        const pomFile = join(dir, "pom.xml");
        const pom = readFileSync(pomFile, "utf8");
        const dep = addPomDependency(pom, `pso-dispatch-${provider}-starter`, starterDep(provider));
        if (!dep) throw new CliError("pom.xml has an unexpected shape: add the starter yourself", `com.pso:pso-dispatch-${provider}-starter`);
        if (dep.changed) { changes.push(`pom.xml: + pso-dispatch-${provider}-starter`); writes.push([pomFile, dep.text]); }
        const ymlFile = join(dir, "src/main/resources/application.yml");
        let yml = readFileSync(ymlFile, "utf8");
        const m = /^(  dispatch:[^\n]*\n    enabled: [^\n]*\n    provider: )([A-Za-z]+)/m.exec(yml);
        if (!m) throw new CliError("application.yml has no pso.dispatch section in the standard place", "Add `provider: " + provider + "` and the provider block manually");
        const before = yml;
        if (m[2] !== provider) { yml = yml.replace(/^(  dispatch:[^\n]*\n    enabled: [^\n]*\n    provider: )[A-Za-z]+/m, `$1${provider}`); changes.push(`application.yml: pso.dispatch.provider = ${provider} (enabled stays false)`); }
        if (!new RegExp(`^    ${provider}:`, "m").test(yml)) {
          const idx = yml.search(/^  database:/m);
          if (idx < 0) throw new CliError("application.yml has no database: section to anchor the provider settings");
          yml = yml.slice(0, idx) + YML_BLOCK[provider] + yml.slice(idx);
          changes.push(`application.yml: + pso.dispatch.${provider} (values come from environment variables)`);
        }
        if (yml !== before) writes.push([ymlFile, yml]);
        // The service's own tests must not need a broker once Dispatch is enabled: the test profile uses the in-process adapter of
        // com.pso:pso-dispatch-test (test scope, never part of the application). What the broker guarantees is tested against it.
        const pomNow = writes.find(([f]) => f === pomFile)?.[1] ?? pom;
        const testDep = addPomDependency(pomNow, "pso-dispatch-test", TEST_ADAPTER_DEP);
        if (testDep?.changed) {
          const at = writes.findIndex(([f]) => f === pomFile);
          if (at >= 0) writes[at] = [pomFile, testDep.text]; else writes.push([pomFile, testDep.text]);
          changes.push("pom.xml: + pso-dispatch-test (test scope: the in-process adapter for this service's tests)");
        }
        const testYml = join(dir, "src/main/resources/application-test.yml");
        if (existsSync(testYml)) {
          const t = readFileSync(testYml, "utf8");
          if (!/^  dispatch:/m.test(t) && /^pso:[ \t]*\r?$/m.test(t)) {
            const eol = t.includes("\r\n") ? "\r\n" : "\n";
            writes.push([testYml, t.replace(/^pso:[ \t]*\r?$/m, (m) => `${m.replace(/\r$/, "")}${eol}  dispatch:${eol}    provider: memory   # tests publish and consume in process (com.pso:pso-dispatch-test): no broker is needed`)]);
            changes.push("application-test.yml: pso.dispatch.provider = memory (the tests of this service run without a broker)");
          } else if (!/^  dispatch:/m.test(t)) changes.push("application-test.yml: not changed (no top-level pso: block): add pso.dispatch.provider: memory yourself so the tests need no broker");
        }
        const evDir = join(dir, "src/main/resources/dispatch");
        const evFile = join(evDir, `${svc.name}.events.json`);
        if (!existsSync(evDir) || !readdirSafe(evDir).some((f) => f.endsWith(".events.json"))) { writes.push([evFile, JSON.stringify({ events: [] }, null, 2) + "\n"]); changes.push(`src/main/resources/dispatch/${svc.name}.events.json: the (empty) event declarations`); }
      } else {
        const pkgFile = join(dir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { dependencies?: Record<string, string> };
        pkg.dependencies ??= {};
        const [lib, ver] = NODE_DEPS[provider];
        if (!pkg.dependencies["@pso/dispatch"]) { pkg.dependencies["@pso/dispatch"] = frameworkSpecs().dispatchSpec; changes.push("package.json: + @pso/dispatch"); }
        if (!pkg.dependencies[lib]) { pkg.dependencies[lib] = ver; changes.push(`package.json: + ${lib}`); }
        if (changes.length) writes.push([pkgFile, JSON.stringify(pkg, null, 2) + "\n"]);
        const cfgFile = join(dir, "pso.config.json");
        let cfg: Record<string, any> = {};
        try { cfg = JSON.parse(readFileSync(cfgFile, "utf8")); } catch { /* new file */ }
        cfg["dispatch"] ??= {};
        const before = JSON.stringify(cfg);
        cfg["dispatch"]["enabled"] ??= false;
        cfg["dispatch"]["provider"] = provider;
        cfg["dispatch"][provider] ??= provider === "redis" ? { url: "${env:REDIS_URL}" } : provider === "rabbitmq" ? { url: "${env:RABBITMQ_URL}" } : { brokers: "${env:KAFKA_BOOTSTRAP_SERVERS}" };
        if (JSON.stringify(cfg) !== before) { writes.push([cfgFile, JSON.stringify(cfg, null, 2) + "\n"]); changes.push(`pso.config.json: dispatch.provider = ${provider} (enabled stays false; secrets are \${env:...} references)`); }
        const dd = join(dir, "src", "dispatch");
        if (!existsSync(dd)) { writes.push([join(dd, ".gitkeep"), ""]); changes.push("src/dispatch/: modules go here, each with an EVENTS.pso.ts"); }
      }
      const composeFile = join(root, "infra", "dispatch", `${provider}.compose.yml`);
      if (!existsSync(composeFile)) { writes.push([composeFile, COMPOSE[provider]]); changes.push(`infra/dispatch/${provider}.compose.yml: a local development broker (not started by PSO)`); }
      if (!dry) for (const [f, c] of writes) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, c); }
      const next = changes.length ? `\nNext: declare your events, then set pso.dispatch.enabled=true (and the broker URL) to activate. See /docs/dispatch/overview.` : "";
      emit(ctx, { service: svc.name, provider, dryRun: dry, changes }, changes.length ? `${dry ? "[dry-run] " : ""}${changes.join(`\n${dry ? "[dry-run] " : ""}`)}${next}` : `${svc.name} already has ${provider} installed: nothing to change`);
      return 0;
    },
  },

  "dispatch:remove": {
    usage: "pso dispatch:remove [--service <name>] [--dry-run] [--json]",
    summary: "Remove the installed dispatch provider from a service and disable dispatch (event declarations and handlers are never deleted)",
    run(ctx) {
      const { root, svc, dir } = target(ctx);
      const dry = ctx.flags["dry-run"] === true;
      const d = discoverDispatch(root, requireWorkspace(ctx).config).find((x) => x.service === svc.name);
      if (!d?.installed && d?.provider === "none") { emit(ctx, { service: svc.name, changes: [] }, `${svc.name} has no dispatch provider: nothing to remove`); return 0; }
      const changes: string[] = [];
      const writes: Array<[string, string]> = [];
      const p = (d?.installed ?? d?.provider) as Provider;
      if (svc.runtime === "spring-boot") {
        const pomFile = join(dir, "pom.xml");
        const pom = readFileSync(pomFile, "utf8");
        const re = new RegExp(`\\n?[ \\t]*<dependency>\\s*<groupId>com\\.pso</groupId>\\s*<artifactId>pso-dispatch-${p}-starter</artifactId>\\s*</dependency>`, "");
        if (re.test(pom)) { writes.push([pomFile, pom.replace(re, "")]); changes.push(`pom.xml: - pso-dispatch-${p}-starter`); }
        const ymlFile = join(dir, "src/main/resources/application.yml");
        let yml = readFileSync(ymlFile, "utf8");
        const before = yml;
        yml = yml.replace(/^(  dispatch:[^\n]*\n    enabled: )[^\n]*(\n    provider: )[A-Za-z]+/m, "$1false$2none").replace(new RegExp(`^    ${p}:\\n(?:      [^\\n]*\\n)+`, "m"), "");
        if (yml !== before) { writes.push([ymlFile, yml]); changes.push("application.yml: dispatch disabled, provider none, provider block removed"); }
      } else {
        const pkgFile = join(dir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { dependencies?: Record<string, string> };
        const lib = NODE_DEPS[p][0];
        if (pkg.dependencies?.[lib]) { delete pkg.dependencies[lib]; writes.push([pkgFile, JSON.stringify(pkg, null, 2) + "\n"]); changes.push(`package.json: - ${lib} (@pso/dispatch stays: declarations still use it)`); }
        const cfgFile = join(dir, "pso.config.json");
        try {
          const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<string, any>;
          if (cfg["dispatch"]) { cfg["dispatch"]["enabled"] = false; cfg["dispatch"]["provider"] = "none"; delete cfg["dispatch"][p]; writes.push([cfgFile, JSON.stringify(cfg, null, 2) + "\n"]); changes.push("pso.config.json: dispatch disabled, provider none"); }
        } catch { /* no config */ }
      }
      if (d && d.events.length) changes.push(`kept: ${d.events.length} event declaration(s) and ${d.consumers.length} consumer(s) (they stay valid and are inactive)`);
      if (!dry) for (const [f, c] of writes) writeFileSync(f, c);
      emit(ctx, { service: svc.name, provider: p, dryRun: dry, changes }, changes.map((c) => `${dry ? "[dry-run] " : ""}${c}`).join("\n"));
      return 0;
    },
  },

  "dispatch:outbox": {
    usage: "pso dispatch:outbox [--service <name>] [--dry-run] [--json]",
    summary: "Enable the transactional outbox in a Spring service with PostgreSQL: adds the pso_outbox Flyway migration and sets pso.dispatch.outbox.enabled (idempotent)",
    run(ctx) {
      const { svc, dir } = target(ctx);
      const dry = ctx.flags["dry-run"] === true;
      if (svc.runtime !== "spring-boot") throw new CliError("The transactional outbox is implemented for Spring Boot services only", "Node services publish directly; there is no TypeScript outbox in this version");
      const ymlFile = join(dir, "src/main/resources/application.yml");
      let yml = readFileSync(ymlFile, "utf8");
      if (!/^  database:[^\n]*\n\s+provider: postgresql\b/m.test(yml)) throw new CliError(`${svc.name} has no PostgreSQL database`, "The outbox needs the business data and the events in the same database. Run `pso database:enable postgresql --service " + svc.name + "` first");
      const d = discoverDispatch(requireWorkspace(ctx).root, requireWorkspace(ctx).config).find((x) => x.service === svc.name);
      if (!d?.installed) throw new CliError(`${svc.name} has no dispatch provider`, `Run \`pso dispatch:install <redis|rabbitmq|kafka> --service ${svc.name}\` first: the outbox relays to a broker`);
      const changes: string[] = [];
      const writes: Array<[string, string]> = [];
      const migDir = join(dir, "src/main/resources/db/migration");
      const existing = existsSync(migDir) ? readdirSafe(migDir) : [];
      const hasTable = existing.some((f) => f.endsWith(".sql") && readFileSync(join(migDir, f), "utf8").includes("pso_outbox"));
      if (!hasTable) {
        const next = Math.max(0, ...existing.map((f) => Number(/^V(\d+)__/.exec(f)?.[1] ?? 0))) + 1;
        const file = `V${next}__pso_outbox.sql`;
        writes.push([join(migDir, file), "-- PSO Dispatch transactional outbox. Migrations are immutable once applied: add a new version instead of editing this one.\n" + OUTBOX_SQL]);
        changes.push(`src/main/resources/db/migration/${file}: the pso_outbox table`);
      }
      const m = /^(    outbox:[^\n]*\n      enabled: )(true|false)/m.exec(yml);
      if (!m) throw new CliError("application.yml has no pso.dispatch.outbox section in the standard place", "Add `outbox: { enabled: true }` under pso.dispatch");
      if (m[2] !== "true") { yml = yml.replace(/^(    outbox:[^\n]*\n      enabled: )false/m, "$1true"); writes.push([ymlFile, yml]); changes.push("application.yml: pso.dispatch.outbox.enabled = true"); }
      if (!dry) for (const [f, c] of writes) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, c); }
      const next = changes.length ? "\nUse com.pso.spring.autoconfigure.dispatch.Outbox#publish inside your @Transactional method; the relay publishes after commit. Delivery stays at-least-once: consumers deduplicate on the event id." : "";
      emit(ctx, { service: svc.name, dryRun: dry, changes }, changes.length ? `${dry ? "[dry-run] " : ""}${changes.join(`\n${dry ? "[dry-run] " : ""}`)}${next}` : `${svc.name} already has the outbox enabled: nothing to change`);
      return 0;
    },
  },

  "dispatch:inspect": {
    usage: "pso dispatch:inspect [--service <name>] [--json]",
    summary: "Show the declared dispatch setup of each service: provider, enabled state, events, consumers and settings (secrets redacted; no broker is contacted)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const only = str(ctx.flags["service"]);
      const all = discoverDispatch(root, config).filter((d) => !only || d.service === only);
      const rows = all.map((d) => {
        let settings: unknown = null;
        const svc = config.services.find((s) => s.name === d.service)!;
        try { settings = svc.runtime === "node" ? describeDispatchConfig(loadDispatchConfig({ projectDir: join(root, ...svc.path.split("/")), source: d.service })) : redactYaml(svc, root); } catch (e) { settings = { invalid: (e as Error).message.split("\n").slice(0, 3) }; }
        return { service: d.service, runtime: d.runtime, provider: d.provider, installedAdapter: d.installed, enabled: d.enabled, events: d.events.map((e) => ({ name: e.name, version: e.version, channel: e.channel, publish: e.publish, compatibility: e.compatibility })), consumers: d.consumers.map((c) => ({ event: c.event, handler: c.target, group: c.group ?? null })), settings };
      });
      emit(ctx, rows, rows.map((r) => `${r.service} (${r.runtime})  provider: ${r.provider}  adapter: ${r.installedAdapter ?? "none"}  ${r.enabled ? "ENABLED" : "disabled"}\n  events:    ${r.events.map((e) => `${e.name}@${e.version} -> ${e.channel}${e.publish ? "" : " (consume-only)"}`).join(", ") || "-"}\n  consumers: ${r.consumers.map((c) => `${c.event} <- ${c.handler}`).join(", ") || "-"}`).join("\n\n") + "\n\nDeclared configuration only: use `pso dispatch:doctor` to test the broker connection.");
      return 0;
    },
  },

  "dispatch:validate": {
    usage: "pso dispatch:validate [--json]",
    summary: "Statically validate event declarations, schemas, consumers, providers and the contract lock (exit 1 on errors)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const found = dispatchFindings(root, config);
      const errors = found.flatMap((d) => d.findings).filter((f) => f.severity === "error");
      emit(ctx, { ok: errors.length === 0, services: found }, `${printFindings(found) || "no findings"}\n\n${errors.length ? `${errors.length} error(s)` : "valid"}. Static validation only: event delivery is verified by running the service against a broker.`);
      return errors.length ? 1 : 0;
    },
  },

  "dispatch:lock": {
    usage: "pso dispatch:lock [--dry-run] [--json]",
    summary: `Record the current event contracts in ${LOCK_FILE} so later schema changes are checked for compatibility`,
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const all = discoverDispatch(root, config);
      const bad = all.flatMap((d) => d.findings).filter((f) => f.severity === "error");
      if (bad.length) throw new CliError("Fix the declaration errors first (see `pso dispatch:validate`); nothing was locked");
      const prev = readLock(root);
      const blocking = lockFindings(all, prev).filter((f) => f.severity === "error");
      if (blocking.length) throw new CliError(`The contracts violate the lock; nothing was changed:\n${blocking.map((f) => `${f.code}: ${f.message}`).join("\n")}`);
      const next = buildLock(all, prev);
      const added = Object.entries(next.contracts).flatMap(([n, v]) => Object.keys(v).filter((ver) => !prev.contracts[n]?.[ver]).map((ver) => `${n}@${ver}`));
      if (ctx.flags["dry-run"] !== true && added.length) writeFileSync(join(root, LOCK_FILE), JSON.stringify(next, null, 2) + "\n");
      emit(ctx, { dryRun: ctx.flags["dry-run"] === true, added }, added.length ? `${ctx.flags["dry-run"] === true ? "[dry-run] " : ""}locked: ${added.join(", ")}` : "the lock is up to date");
      return 0;
    },
  },

  "dispatch:doctor": {
    usage: "pso dispatch:doctor [--service <name>] [--json]",
    summary: "Validate and then really connect to each configured broker; reports up, down or not configured (never claims a connection from configuration alone)",
    async run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const only = str(ctx.flags["service"]);
      const found = dispatchFindings(root, config).filter((d) => !only || d.service === only);
      const errors = found.flatMap((d) => d.findings).filter((f) => f.severity === "error");
      const probes = [];
      for (const d of discoverDispatch(root, config).filter((x) => !only || x.service === only)) probes.push(await probe(root, d, config.services.find((s) => s.name === d.service)!));
      const text = [printFindings(found) || "static validation: no findings", "", ...probes.map((p) => `${p.status.toUpperCase().padEnd(14)} ${p.service} (${p.provider}): ${p.detail}${p.ms !== undefined ? ` [${p.ms} ms]` : ""}`)].join("\n");
      emit(ctx, { validation: found, connections: probes }, text);
      return errors.length || probes.some((p) => p.status === "down") ? 1 : 0;
    },
  },

  "dispatch:events": {
    usage: "pso dispatch:events [--json]",
    summary: "List every declared event with its version, channel, owner service, publishers and consumers",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const all = discoverDispatch(root, config);
      const rows = all.flatMap((d) => d.events.map((e) => ({ event: e.name, version: e.version, channel: e.channel, service: d.service, publishes: e.publish, compatibility: e.compatibility, schema: e.schema ? "yes" : "none", consumers: all.filter((x) => x.consumers.some((c) => c.event === e.name)).map((x) => x.service) })));
      emit(ctx, rows, rows.map((r) => `${r.event}@${r.version}  channel ${r.channel}  ${r.service}${r.publishes ? " publishes" : " consumes"}  schema ${r.schema}  consumers: ${r.consumers.join(", ") || "-"}`).join("\n") || "no events declared");
      return 0;
    },
  },

  "dispatch:consumers": {
    usage: "pso dispatch:consumers [--json]",
    summary: "List every declared consumer (event, handler, service, group)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const rows = discoverDispatch(root, config).flatMap((d) => d.consumers.map((c) => ({ service: d.service, event: c.event, handler: c.target, group: c.group ?? d.service, file: c.file })));
      emit(ctx, rows, rows.map((r) => `${r.event.padEnd(28)} ${r.service}  ${r.handler}  group ${r.group}  (${r.file})`).join("\n") || "no consumers declared");
      return 0;
    },
  },

  "dispatch:graph": {
    usage: "pso dispatch:graph [--mermaid] [--json]",
    summary: "Show the declared event topology: publishers -> channels -> consumers (declarations, not live broker state)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const all = discoverDispatch(root, config);
      const edges: Array<{ from: string; to: string; kind: "publishes" | "consumes"; event: string }> = [];
      for (const d of all) {
        for (const e of d.events) if (e.publish) edges.push({ from: d.service, to: `channel:${e.channel}`, kind: "publishes", event: e.name });
        for (const c of d.consumers) { const ev = d.events.find((e) => e.name === c.event); if (ev) edges.push({ from: `channel:${ev.channel}`, to: d.service, kind: "consumes", event: c.event }); }
      }
      if (ctx.flags["mermaid"] === true) {
        const id = (n: string) => n.replace(/[^A-Za-z0-9]/g, "_");
        ctx.print(["graph LR", ...edges.map((e) => `  ${id(e.from)}["${e.from}"] -->|${e.event}| ${id(e.to)}["${e.to}"]`)].join("\n"));
      } else emit(ctx, { edges, channels: [...new Set(edges.flatMap((e) => [e.from, e.to]).filter((n) => n.startsWith("channel:")))] }, edges.map((e) => `${e.from} --${e.event}--> ${e.to}`).join("\n") || "no events declared");
      return 0;
    },
  },
};

import { readdirSync } from "node:fs";
function readdirSafe(d: string): string[] { try { return readdirSync(d); } catch { return []; } }

/** The pso.dispatch settings of a Spring service with secret-looking and URL values reduced to what is safe to print. */
function redactYaml(svc: ServiceDecl, root: string): unknown {
  const y = parseYaml(readFileSync(join(root, ...svc.path.split("/"), "src/main/resources/application.yml"), "utf8"));
  const walk = (v: unknown, k = ""): unknown => {
    if (typeof v === "string") return /password|secret|token|credential/i.test(k) ? "***" : /\/\/[^/\s]*@/.test(v) ? v.replace(/\/\/[^@\s/]*@/g, "//***@") : v;
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, walk(x, kk)]));
    return v;
  };
  return walk(get(y, "pso.dispatch"));
}
