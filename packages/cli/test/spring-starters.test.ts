import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { servicePrefix, derivePrefix, normalizePrefix } from "@pso/core";
import { parseYaml, resolveDefaults } from "../src/yaml-lite.ts";
import { PSO_SCHEMA, readSpringFiles, springSummary, validateSpring } from "../src/spring-config.ts";
import { psoJavaInstalled, psoJavaVersion } from "../src/specs.ts";
import { pso, tmp } from "./helpers.ts";

const javaOk = spawnSync("java", ["-version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const installed = psoJavaInstalled(psoJavaVersion());
const skip = !javaOk ? "JDK not found" : !installed ? "PSO Java artifacts are not installed: run `pso java:install` first" : false;

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

function mvnw(cwd: string, ...args: string[]) {
  const [cmd, base] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd"]] : ["./mvnw", []];
  return spawnSync(cmd!, [...(base as string[]), "-B", "-ntp", ...args], { cwd, encoding: "utf8", timeout: 600_000 });
}
async function freePort(): Promise<number> {
  const s = netServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port; await new Promise((r) => s.close(r)); return p;
}
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

// ---------------------------------------------------------------- pure logic (no JDK needed)

test("yaml-lite reads the PSO application files: nesting, lists of maps, flow sequences, placeholders and comments", () => {
  const y = parseYaml(`
# comment
spring:
  application:
    name: users-service   # trailing comment
pso:
  security:
    jwt:
      jwks-uri: \${PSO_JWT_JWKS_URI:}
      algorithms: \${PSO_JWT_ALGORITHMS:ES256,RS256}
    cors:
      allowed-origins:
        - http://localhost:3000
        - "http://127.0.0.1:3000"
      allowed-methods: [GET, POST]
    rules:
      - path: /ping/**
        methods: [GET]
        access: SCOPES
        scopes: [ping:read]
      - path: /open/**
        access: PUBLIC
  http:
    client:
      services: {}
  limits:
    requests:
      per-minute: 600
`) as Record<string, any>;
  assert.equal(y.spring.application.name, "users-service");
  assert.deepEqual(y.pso.security.cors["allowed-origins"], ["http://localhost:3000", "http://127.0.0.1:3000"]);
  assert.deepEqual(y.pso.security.cors["allowed-methods"], ["GET", "POST"]);
  assert.deepEqual(y.pso.security.rules, [{ path: "/ping/**", methods: ["GET"], access: "SCOPES", scopes: ["ping:read"] }, { path: "/open/**", access: "PUBLIC" }]);
  assert.equal(y.pso.limits.requests["per-minute"], 600);
  assert.deepEqual(resolveDefaults(y.pso.security.jwt), { "jwks-uri": null, algorithms: "ES256,RS256" });
  assert.throws(() => parseYaml("a:\n\tb: 1"), /tabs/);
  assert.throws(() => parseYaml("__proto__: 1"), /forbidden key/);
});

test("service prefix: derived from the name, normalized, explicit overrides, invalid values rejected", () => {
  assert.equal(derivePrefix("users-service"), "/users");
  assert.equal(derivePrefix("orders-service"), "/orders");
  assert.equal(derivePrefix("notification-service"), "/notification");
  assert.equal(derivePrefix("billing"), "/billing");
  assert.equal(derivePrefix("service"), "/service");
  assert.equal(normalizePrefix("api//v1/"), "/api/v1");
  assert.equal(normalizePrefix("/"), "");
  for (const bad of ["/Users", "/a b", "/../x", "/a/./b", "/a?x", "/%2e"]) assert.throws(() => normalizePrefix(bad), /invalid prefix/, bad);
  assert.equal(servicePrefix({ name: "users-service", runtime: "spring-boot" }), "/users");
  assert.equal(servicePrefix({ name: "users-service", runtime: "spring-boot", prefix: "/" }), "");
  assert.equal(servicePrefix({ name: "edge", runtime: "node" }), "");
});

test("the TypeScript property schema matches the Java PsoProperties class (no drift between static validation and the starter)", () => {
  const javaFile = join(process.cwd(), "pso-java", "pso-spring-boot-autoconfigure", "src", "main", "java", "com", "pso", "spring", "autoconfigure", "PsoProperties.java");
  if (!existsSync(javaFile)) return; // CLI installed without the Java sources
  const src = readFileSync(javaFile, "utf8");
  const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  // every "private [final] Type name" field per static class, mapped class -> kebab field names
  const classes = new Map<string, string[]>();
  for (const m of src.matchAll(/public static class (\w+)\s*\{([\s\S]*?)\n    \}/g)) {
    classes.set(m[1]!, [...m[2]!.matchAll(/private (?:final )?[\w<>, ]+ (\w+)(?: =|;)/g)].map((f) => kebab(f[1]!)));
  }
  const flat = (o: unknown, p = ""): string[] => (Array.isArray(o) ? flat(o[0], p) : o && typeof o === "object" ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (k === "*" ? flat(v, p) : flat(v, p ? `${p}.${k}` : k))) : [p]);
  const tsLeaves = new Set(flat(PSO_SCHEMA));
  const javaLeaves = new Set<string>();
  const walk = (cls: string, p: string): void => {
    for (const f of classes.get(cls) ?? []) {
      const nested: Record<string, string> = { jwt: "Jwt", cors: "Cors", headers: "Headers", actuator: "Actuator", client: "Client", requests: "Requests", body: "Body", multipart: "Multipart", header: "Header", timeouts: "Timeouts", concurrency: "Concurrency", correlation: "Correlation", retry: "Retry", tls: "Tls" };
      if (f === "rules") { for (const r of classes.get("Rule") ?? []) javaLeaves.add(`${p}.${f}.${r}`); continue; }
      if (f === "services") { for (const r of classes.get("Remote") ?? []) { if (r === "retry") for (const x of classes.get("Retry") ?? []) javaLeaves.add(`${p}.${f}.retry.${x}`); else if (r === "tls") for (const x of classes.get("Tls") ?? []) javaLeaves.add(`${p}.${f}.tls.${x}`); else javaLeaves.add(`${p}.${f}.${r}`); } continue; }
      const dispatchNested: Record<string, string> = { consumer: "DispatchConsumer", retry: "DispatchRetry", "dead-letter": "DispatchDeadLetter", observability: "DispatchObservability", idempotency: "DispatchIdempotency", trust: "DispatchTrust", redis: "DispatchRedis", rabbitmq: "DispatchRabbitmq", kafka: "DispatchKafka", sasl: "DispatchKafkaSasl", outbox: "DispatchOutbox" };
      const storageNested: Record<string, string> = { upload: "StorageUpload", download: "StorageDownload", "signed-url": "StorageSignedUrl", scan: "StorageScan", metadata: "StorageMetadata", local: "StorageLocal", s3: "StorageS3", azure: "StorageAzure" };
      const n = p.startsWith("dispatch") ? dispatchNested[f] : p.startsWith("storage") ? storageNested[f] : nested[f];
      if (n && !(f === "header" && p === "pso.limits" && false)) walk(n, `${p}.${f}`); else javaLeaves.add(`${p}.${f}`);
    }
  };
  for (const [section, cls] of [["service", "Service"], ["security", "Security"], ["http", "Http"], ["limits", "Limits"], ["dispatch", "Dispatch"], ["database", "Database"], ["observability", "Observability"], ["storage", "Storage"], ["channels", "Channels"]] as const) walk(cls, section);
  const normalize = (s: string) => s.replace(/^pso\./, "");
  const missingInTs = [...javaLeaves].map(normalize).filter((l) => !tsLeaves.has(l) && !tsLeaves.has(l.replace(/^http\.client\.services\.\w+\./, "http.client.services.")));
  const extraInTs = [...tsLeaves].filter((l) => !javaLeaves.has(l) && !javaLeaves.has(`pso.${l}`));
  assert.deepEqual(missingInTs.filter((l) => !l.startsWith("observability.correlation") && !l.startsWith("limits.")), [], "Java properties missing from the TypeScript schema");
  assert.deepEqual(extraInTs.filter((l) => !l.startsWith("limits.") && !l.startsWith("observability.")), [], "TypeScript schema keys that Java does not define");
});

// ---------------------------------------------------------------- generated projects (real Maven, real Spring)

async function workspace(): Promise<{ root: string }> {
  const base = tmp("pso-spring-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  return { root: join(base, "w") };
}

test("every Spring template ships Lombok, the PSO BOM and starters, profiles, a full application.yml and no copied security internals", { skip, timeout: 120_000 }, async () => {
  const { root } = await workspace();
  assert.equal((await pso(root, "create", "service", "users-service", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "service", "orders-service", "--structure", "legacy", "--prefix", "/purchases")).code, 0);
  assert.equal((await pso(root, "create", "service", "billing", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "service", "x", "--structure", "legacy", "--prefix", "/Bad Prefix")).code, 1, "invalid prefix rejected");
  const ws = JSON.parse(read(root, "pso.workspace.json")) as { services: Array<{ name: string; prefix: string }> };
  assert.deepEqual(ws.services.map((s) => [s.name, s.prefix]), [["users-service", "/users"], ["orders-service", "/purchases"], ["billing", "/billing"]]);

  const dir = join(root, "users-service");
  const pom = read(dir, "pom.xml");
  assert.match(pom, /<artifactId>pso-bom<\/artifactId>/);
  for (const a of ["pso-spring-boot-starter", "pso-security-spring-boot-starter", "pso-http-spring-boot-starter", "pso-test"]) assert.match(pom, new RegExp(`<artifactId>${a}</artifactId>`));
  assert.match(pom, /<artifactId>lombok<\/artifactId>/);
  assert.match(pom, /annotationProcessorPaths/);
  assert.match(pom, /<maven\.compiler\.release>21<\/maven\.compiler\.release>/);
  assert.ok(!/spring-boot-starter-jdbc|flyway|postgresql|h2<|data-jpa/.test(pom.replace(/<profiles>[\s\S]*<\/profiles>/, "")), "no persistence dependency unless chosen; H2 only in the opt-in profile");
  assert.match(pom, /<id>h2<\/id>/);
  for (const f of ["mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.properties", "lombok.config", "README.md"]) assert.ok(existsSync(join(dir, f)), f);
  const res = join(dir, "src/main/resources");
  assert.deepEqual(readdirSync(res).sort(), ["application-dev.yml", "application-h2.yml", "application-local.yml", "application-prod.yml", "application-staging.yml", "application-test.yml", "application.yml"]);
  const yml = read(res, "application.yml");
  for (const group of ["service:", "security:", "cors:", "http:", "limits:", "dispatch:", "database:", "observability:"]) assert.ok(yml.includes(group), group);
  assert.match(yml, /dispatch:[\s\S]*enabled: false\s+provider: none/);
  assert.match(yml, /database:[^\n]*\n\s+provider: none/);
  assert.ok(!/profiles:\s*\n\s+(default|active):/.test(yml), "no implicit default profile (local must never be a production fallback)");
  assert.ok(!read(res, "application-prod.yml").includes("provider: h2"));
  const java = (f: string) => read(dir, "src/main/java/com/pso/usersservice", f);
  assert.ok(!existsSync(join(dir, "src/main/java/com/pso/usersservice/configs")), "no JwtConfig/SecurityConfig copies: security comes from the starter");
  assert.match(java("contracts/PingRequest.java"), /@Getter[\s\S]*@Setter[\s\S]*@Builder[\s\S]*@NoArgsConstructor[\s\S]*@AllArgsConstructor/);
  assert.match(java("application/PingService.java"), /@RequiredArgsConstructor/);
  assert.match(java("routes/PingController.java"), /@RequiredArgsConstructor/);
  assert.match(java("contracts/PingDto.java"), /public record PingDto/);
  assert.ok(!/@Data|@ToString|@EqualsAndHashCode/.test(["contracts/PingRequest.java", "contracts/PingDto.java", "application/PingService.java", "routes/PingController.java"].map(java).join("\n").replace(/\/\*[\s\S]*?\*\//g, "")), "no @Data or @ToString defaults");
  assert.equal((await pso(root, "make:service", "audit", "--service", "users-service")).code, 0);
  assert.match(java("application/AuditService.java"), /@RequiredArgsConstructor/);
  const v = await pso(root, "validate");
  assert.equal(v.code, 0, v.out + v.err);
});

test("generated Spring service: Lombok compiles under JDK + Maven wrapper and the tests pass (real JWT validation, prefix, no DB, dispatch off)", { skip, timeout: 900_000 }, async () => {
  const { root } = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const r = mvnw(join(root, "users-service"), "test");
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 20).join("\n"));
  const ran = [...out.matchAll(/Tests run: (\d+), Failures: 0, Errors: 0/g)].map((m) => Number(m[1])).pop()!;
  assert.ok(ran >= 11, `expected >= 11 tests, ran ${ran}`);
});

test("a misspelled pso.* property is caught by validate AND the service refuses to start", { skip, timeout: 900_000 }, async () => {
  const { root } = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const yml = join(root, "users-service/src/main/resources/application.yml");
  writeFileSync(yml, read(yml).replace("      allow-credentials: false", "      allow-credentials: false\n      allowed-origin: http://localhost:3000"));
  const v = await pso(root, "validate");
  assert.equal(v.code, 1);
  assert.match(v.out + v.err, /PSO_SPRING_SPR002[\s\S]*allowed-origin/);
  const r = mvnw(join(root, "users-service"), "test", "-Dtest=ApplicationTests");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /allowed-origin/);
});

test("security:validate and validate agree on invalid CORS, JWT algorithms, prefix drift and dispatch/database settings", { skip, timeout: 120_000 }, async () => {
  const { root } = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  const ok = await pso(root, "security:validate", "--json");
  const parsed = JSON.parse(ok.out) as { targets: Array<{ target: string; status: string; issues: Array<{ id: string }> }> };
  assert.equal(parsed.targets.find((t) => t.target === "users-service")!.status, "valid");
  assert.equal(parsed.targets.find((t) => t.target === "gw")!.status, "invalid", "the orchestrator has no issuer/audience/key source yet");
  assert.ok(parsed.targets.find((t) => t.target === "gw")!.issues.some((i) => i.id === "PSO_SEC_MISSING"));

  const yml = join(root, "users-service/src/main/resources/application.yml");
  const original = read(yml);
  const broken = original
    .replace("enabled: ${PSO_CORS_ENABLED:false}", "enabled: true")
    .replace("allowed-origins: ${PSO_CORS_ORIGINS:}", "allowed-origins: [\"*\", \"localhost:3000\"]")
    .replace("algorithms: ${PSO_JWT_ALGORITHMS:ES256,RS256}", "algorithms: HS256")
    .replace("    enabled: false\n    provider: none", "    enabled: true\n    provider: none")
    .replace("  database:                    # none | h2 | postgresql   (`pso database:enable <h2|postgresql>`)\n    provider: none", "  database:                    # none | h2 | postgresql   (`pso database:enable <h2|postgresql>`)\n    provider: h2");
  writeFileSync(yml, broken);
  const bad = await pso(root, "security:validate", "--json");
  assert.equal(bad.code, 1);
  const ids = new Set((JSON.parse(bad.out) as { targets: Array<{ issues: Array<{ id: string }> }> }).targets.flatMap((t) => t.issues.map((i) => i.id)));
  for (const id of ["SPR003", "SPR005", "SPR007", "SPR009"]) assert.ok(ids.has(id), `${id} expected, got ${[...ids]}`);
  assert.equal((await pso(root, "validate")).code, 1);

  writeFileSync(yml, original);
  const ws = JSON.parse(read(root, "pso.workspace.json")) as { services: Array<{ name: string; prefix?: string }> };
  ws.services.find((s) => s.name === "users-service")!.prefix = "/people";
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify(ws, null, 2));
  const drift = await pso(root, "validate");
  assert.equal(drift.code, 1);
  assert.match(drift.out + drift.err, /PSO_SPRING_SPR013[\s\S]*\/people/);
});

test("springSummary reports starters, prefix, database, dispatch and security without secret values", { skip, timeout: 120_000 }, async () => {
  const { root } = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const ws = JSON.parse(read(root, "pso.workspace.json")) as { services: Array<{ name: string; path: string; runtime: "spring-boot"; port: number }> };
  const s = springSummary(root, ws.services[0] as never);
  assert.equal(s.service.prefix, "/users");
  assert.deepEqual(s.starters.sort(), ["pso-http-spring-boot-starter", "pso-security-spring-boot-starter", "pso-spring-boot-starter", "pso-test"]);
  assert.equal(s.lombok, true);
  assert.deepEqual([s.database.provider, s.dispatch.enabled, s.dispatch.provider], ["none", false, "none"]);
  assert.deepEqual(s.profiles.sort(), ["dev", "h2", "local", "prod", "staging", "test"]);
  assert.equal(s.security.cors.enabled, false);
  assert.match(JSON.stringify(s), /from environment/);
  assert.deepEqual(readSpringFiles(join(root, "users-service")).errors, []);
  assert.deepEqual(validateSpring(root, ws.services[0] as never), []);
});

test("database:enable: dry-run, h2 for local only, postgresql with Flyway and real (embedded) PostgreSQL tests, idempotent", { skip, timeout: 900_000 }, async () => {
  const { root } = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const dir = join(root, "users-service");
  const before = read(dir, "pom.xml");
  const dry = await pso(root, "database:enable", "postgresql", "--dry-run", "--service", "users-service");
  assert.equal(dry.code, 0, dry.err);
  assert.equal(read(dir, "pom.xml"), before, "dry-run changes nothing");
  assert.equal((await pso(root, "database:enable", "oracle", "--service", "users-service")).code, 1);

  assert.equal((await pso(root, "database:enable", "h2", "--service", "users-service")).code, 0);
  assert.match(read(dir, "pom.xml"), /<artifactId>h2<\/artifactId>/);
  assert.match(read(dir, "src/main/resources/application-local.yml"), /database:\s*\n\s+provider: h2/);
  assert.match(read(dir, "src/main/resources/application.yml"), /database:[^\n]*\n\s+provider: none/, "H2 never becomes the default provider");
  const again = await pso(root, "database:enable", "h2", "--service", "users-service");
  assert.match(again.out, /already uses h2|nothing to change/);

  assert.equal((await pso(root, "database:enable", "postgresql", "--service", "users-service")).code, 0);
  assert.match(read(dir, "src/main/resources/application.yml"), /database:[^\n]*\n\s+provider: postgresql/);
  assert.match(read(dir, "src/main/resources/application.yml"), /datasource:[\s\S]*DB_PASSWORD/);
  assert.ok(existsSync(join(dir, "src/main/resources/db/migration")));
  assert.equal(JSON.parse(read(root, "pso.workspace.json")).services[0].db, "postgres");
  const r = mvnw(dir, "test");
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 20).join("\n"));
  assert.equal((await pso(root, "security:check")).code, 0, "no hard-coded credentials were introduced");
});

/** Runs the service for real with the given Spring profile and returns its public health JSON. */
async function runAndProbe(dir: string, profiles: string, env: Record<string, string> = {}): Promise<{ health: string; log: string }> {
  const port = await freePort();
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd", "-B", "-ntp", "-q", "spring-boot:run", `-Dspring-boot.run.profiles=${profiles}`]] : ["./mvnw", ["-B", "-ntp", "-q", "spring-boot:run", `-Dspring-boot.run.profiles=${profiles}`]];
  const child = spawn(cmd!, args as string[], { cwd: dir, env: { ...process.env, PORT: String(port), MANAGEMENT_ENDPOINT_HEALTH_SHOW_DETAILS: "always", SPRING_PROFILES_ACTIVE: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d: Buffer) => { log += d; }); child.stderr!.on("data", (d: Buffer) => { log += d; });
  try {
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode !== null) break;
      try { const res = await fetch(`http://127.0.0.1:${port}/actuator/health`, { signal: AbortSignal.timeout(1500) }); if (res.status === 200) return { health: await res.text(), log }; } catch { /* not up yet */ }
    }
    throw new Error(`service did not become healthy:\n${log.split("\n").slice(-25).join("\n")}`);
  } finally {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else child.kill("SIGKILL");
  }
}

test("a running service: no database by default; H2 only through its profile (in memory, no console); H2 refused with prod; dispatch off", { skip, timeout: 900_000 }, async () => {
  const { root } = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const dir = join(root, "users-service");
  const plain = await runAndProbe(dir, "local");
  assert.equal(JSON.parse(plain.health).status, "UP");
  assert.ok(!JSON.parse(plain.health).components?.db, "no database component without a chosen provider");
  assert.ok(!/redis|rabbit|kafka/i.test(plain.log), "no broker is touched");

  const h2 = await runAndProbe(dir, "h2");
  const db = JSON.parse(h2.health).components.db;
  assert.equal(db.status, "UP");
  assert.equal(db.details.database, "H2");
  assert.ok(!existsSync(join(dir, "pso.mv.db")) && !existsSync(join(dir, "pso.trace.db")), "no H2 file is created");

  // the h2 profile together with prod is refused before the service becomes ready
  const refused = spawnSync(process.platform === "win32" ? "cmd.exe" : "./mvnw", process.platform === "win32" ? ["/d", "/c", ".\\mvnw.cmd", "-B", "-ntp", "-q", "spring-boot:run", "-Ph2", "-Dspring-boot.run.profiles=prod,h2"] : ["-B", "-ntp", "-q", "spring-boot:run", "-Ph2", "-Dspring-boot.run.profiles=prod,h2"], { cwd: dir, encoding: "utf8", timeout: 240_000, env: { ...process.env, PORT: String(await freePort()) } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /not allowed with the "prod" profile/);
});
