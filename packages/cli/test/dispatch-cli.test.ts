import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pso, tmp, prepare, randomPort } from "./helpers.ts";
import { psoJavaInstalled, psoJavaVersion } from "../src/specs.ts";
// @ts-expect-error plain ESM script shared with the other dispatch tests
import { up, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const json = async (root: string, ...args: string[]) => JSON.parse((await pso(root, ...args, "--json")).out);

let env: Record<string, string> | undefined;
let brokersSkip: string | false = false;
before(async () => {
  if (process.env["PSO_TEST_REDIS_URL"]) { env = process.env as Record<string, string>; return; }
  if (!dockerAvailable()) { brokersSkip = "no Docker engine: real broker tests not run"; return; }
  try { env = await up(); } catch (e) { brokersSkip = `brokers unavailable: ${(e as Error).message}`; }
});
const javaOk = spawnSync("java", ["-version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0 && psoJavaInstalled(psoJavaVersion());
const mavenSkip = !javaOk ? "JDK or PSO Java artifacts not available (run `pso java:install`)" : false;

async function workspace(): Promise<string> {
  const base = tmp("pso-dsp-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  return join(base, "w");
}

function mvnw(cwd: string, extraEnv: Record<string, string>, ...args: string[]) {
  const [cmd, base] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd"]] : ["./mvnw", []];
  return spawnSync(cmd!, [...(base as string[]), "-B", "-ntp", ...args], { cwd, encoding: "utf8", timeout: 600_000, env: { ...process.env, ...extraEnv } });
}

test("a new Spring service has dispatch configured but disabled: no provider, no adapter dependency, nothing to connect to", async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const yml = read(root, "users-service/src/main/resources/application.yml");
  assert.match(yml, /dispatch:[\s\S]*enabled: false\s+provider: none/);
  assert.ok(!/pso-dispatch-/.test(read(root, "users-service/pom.xml")), "no adapter dependency by default");
  const d = (await json(root, "dispatch:inspect")) as Array<{ provider: string; installedAdapter: string | null; enabled: boolean }>;
  assert.deepEqual([d[0]!.provider, d[0]!.installedAdapter, d[0]!.enabled], ["none", null, false]);
  assert.equal((await pso(root, "dispatch:validate")).code, 0);
  assert.equal((await pso(root, "dispatch:remove", "--service", "users-service")).code, 0, "removing nothing is not an error");
});

test("dispatch:install: Spring service (dependency, provider block, empty events, local broker file), idempotent, dry-run, one provider per service", async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const dir = join(root, "users-service");
  const before = read(dir, "pom.xml");
  const dry = await pso(root, "dispatch:install", "redis", "--service", "users-service", "--dry-run");
  assert.equal(dry.code, 0, dry.err);
  assert.equal(read(dir, "pom.xml"), before, "dry-run changes nothing");
  assert.ok(!existsSync(join(root, "infra")));
  assert.equal((await pso(root, "dispatch:install", "nats", "--service", "users-service")).code, 1);
  assert.equal((await pso(root, "dispatch:install", "redis", "--service", "users-service")).code, 0);
  assert.match(read(dir, "pom.xml"), /<artifactId>pso-dispatch-redis-starter<\/artifactId>/);
  const yml = read(dir, "src/main/resources/application.yml");
  assert.match(yml, /dispatch:[\s\S]*enabled: false\s+provider: redis/, "installed but still disabled: enabling is a separate, explicit step");
  assert.match(yml, /redis:\s+url: \$\{REDIS_URL:\}/, "credentials come from the environment, never from the file");
  assert.ok(existsSync(join(dir, "src/main/resources/dispatch/users-service.events.json")));
  assert.match(read(root, "infra/dispatch/redis.compose.yml"), /redis:7-alpine/);
  const again = await pso(root, "dispatch:install", "redis", "--service", "users-service");
  assert.match(again.out, /already has redis installed/);
  const other = await pso(root, "dispatch:install", "kafka", "--service", "users-service");
  assert.equal(other.code, 1);
  assert.match(other.err, /already has the redis adapter/);
  const custom = read(dir, "src/main/resources/application.yml") + "# custom note\n";
  writeFileSync(join(dir, "src/main/resources/application.yml"), custom);
  assert.equal((await pso(root, "dispatch:remove", "--service", "users-service")).code, 0);
  const removed = read(dir, "src/main/resources/application.yml");
  assert.match(removed, /enabled: false\s+provider: none/);
  assert.ok(!/^    redis:/m.test(removed) && removed.includes("# custom note"), "the provider block is removed, user content is kept");
  assert.ok(!/pso-dispatch-redis-starter/.test(read(dir, "pom.xml")));
  assert.ok(existsSync(join(dir, "src/main/resources/dispatch/users-service.events.json")), "event declarations are never deleted");
});

test("dispatch:outbox: needs PostgreSQL and a provider, adds the migration once, enables the outbox, migration SQL equals the Java one", async () => {
  const root = await workspace();
  await pso(root, "create", "service", "orders-service", "--structure", "legacy", "--db", "postgres");
  const dir = join(root, "orders-service");
  const noProvider = await pso(root, "dispatch:outbox", "--service", "orders-service");
  assert.equal(noProvider.code, 1);
  assert.match(noProvider.err, /no dispatch provider/);
  await pso(root, "dispatch:install", "redis", "--service", "orders-service");
  const dry = await pso(root, "dispatch:outbox", "--service", "orders-service", "--dry-run");
  assert.equal(dry.code, 0, dry.err);
  assert.match(read(dir, "src/main/resources/application.yml"), /outbox:[^\n]*\n\s+enabled: false/, "dry-run changes nothing");
  assert.equal((await pso(root, "dispatch:outbox", "--service", "orders-service")).code, 0);
  assert.match(read(dir, "src/main/resources/application.yml"), /outbox:[^\n]*\n\s+enabled: true/);
  const sql = read(dir, "src/main/resources/db/migration/V1__pso_outbox.sql");
  const java = readFileSync(join(import.meta.dirname, "../../../pso-java/pso-spring-boot-autoconfigure/src/main/java/com/pso/spring/autoconfigure/dispatch/Outbox.java"), "utf8");
  const javaSql = /TABLE_SQL = """\n([\s\S]*?)""";/.exec(java)![1]!.replace(/^ {8}/gm, "");
  assert.equal(sql.split("\n").slice(1).join("\n"), javaSql, "the generated migration and Outbox.TABLE_SQL must not drift");
  const again = await pso(root, "dispatch:outbox", "--service", "orders-service");
  assert.match(again.out, /nothing to change/);
  assert.ok(!existsSync(join(dir, "src/main/resources/db/migration/V3__pso_outbox.sql")));
  await pso(root, "create", "service", "plain-service", "--structure", "legacy");
  await pso(root, "dispatch:install", "redis", "--service", "plain-service");
  const nodb = await pso(root, "dispatch:outbox", "--service", "plain-service");
  assert.equal(nodb.code, 1);
  assert.match(nodb.err, /no PostgreSQL/);
});

test("pso validate includes dispatch findings: a broken declaration fails the workspace validation", async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  await pso(root, "dispatch:install", "redis", "--service", "users-service");
  assert.equal((await pso(root, "validate")).code, 0, "a clean dispatch setup validates");
  writeFileSync(join(root, "users-service/src/main/resources/dispatch/users-service.events.json"), JSON.stringify({ events: [{ name: "Bad Name", version: 1, channel: "users.events" }] }));
  const r = await pso(root, "validate");
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /PSO_DISPATCH_003/);
});

test("dispatch:install for the orchestrator: dependencies, pso.config.json (secret references only), src/dispatch", async () => {
  const root = await workspace();
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  assert.equal((await pso(root, "dispatch:install", "kafka", "--service", "gw")).code, 0);
  const pkg = JSON.parse(read(root, "gw/package.json")) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies["@pso/dispatch"] && pkg.dependencies["kafkajs"]);
  const cfg = JSON.parse(read(root, "gw/pso.config.json"));
  assert.deepEqual([cfg.dispatch.enabled, cfg.dispatch.provider], [false, "kafka"]);
  assert.equal(cfg.dispatch.kafka.brokers, "${env:KAFKA_BOOTSTRAP_SERVERS}");
  assert.ok(existsSync(join(root, "gw/src/dispatch")));
  assert.match((await pso(root, "dispatch:install", "kafka", "--service", "gw")).out, /nothing to change/);
});

const EVENTS_JSON = (schema: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ events: [{ name: "users.created", version: 1, channel: "users.events", schema, ...extra }] }, null, 2);
const SCHEMA_V1 = { type: "object", required: ["userId"], properties: { userId: { type: "string" } } };

test("static validation: undeclared handlers, bad names and schemas, duplicates, provider mismatches, cross-service channel conflicts", async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  await pso(root, "create", "service", "orders-service", "--structure", "legacy");
  const u = join(root, "users-service"), o = join(root, "orders-service");
  await pso(root, "dispatch:install", "redis", "--service", "users-service");
  const evFile = join(u, "src/main/resources/dispatch/users-service.events.json");
  writeFileSync(evFile, EVENTS_JSON(SCHEMA_V1));
  assert.equal((await pso(root, "dispatch:validate")).code, 0);
  assert.equal((await json(root, "dispatch:events")).length, 1);

  // an undeclared handler
  mkdirSync(join(u, "src/main/java/com/pso/usersservice/application"), { recursive: true });
  const handler = join(u, "src/main/java/com/pso/usersservice/application/Handlers.java");
  writeFileSync(handler, 'package com.pso.usersservice.application;\nimport com.pso.dispatch.PsoEventHandler;\nclass Handlers {\n  @PsoEventHandler("users.deleted")\n  public void on(String payload) { }\n  @PsoEventHandler(value = "users.created", group = "audit")\n  void created(String p) { }\n}\n');
  let v = await json(root, "dispatch:validate");
  assert.equal(v.ok, false);
  const codes = (r: { services: Array<{ findings: Array<{ code: string }> }> }) => r.services.flatMap((s) => s.findings.map((f) => f.code));
  assert.ok(codes(v).includes("PSO_DISPATCH_007"), "handler of an undeclared event");
  assert.deepEqual((await json(root, "dispatch:consumers")).map((c: { event: string; group: string }) => [c.event, c.group]).sort(), [["users.created", "audit"], ["users.deleted", "users-service"]]);
  rmSync(handler);

  // bad declarations
  writeFileSync(evFile, EVENTS_JSON({ type: "object", oneOf: [] }, { name: "Users.Created", channel: "Bad Channel" }));
  v = await json(root, "dispatch:validate");
  const msgs = v.services.flatMap((s: { findings: Array<{ message: string }> }) => s.findings.map((f) => f.message)).join("\n");
  assert.match(msgs, /invalid name/); assert.match(msgs, /invalid channel/); assert.match(msgs, /unsupported keyword "oneOf"/);

  // duplicates and conflicting channels (also across services)
  writeFileSync(evFile, JSON.stringify({ events: [{ name: "users.created", version: 1, channel: "users.events" }, { name: "users.created", version: 1, channel: "users.events" }] }));
  assert.ok(codes(await json(root, "dispatch:validate")).includes("PSO_DISPATCH_009"));
  writeFileSync(evFile, EVENTS_JSON(SCHEMA_V1));
  await pso(root, "dispatch:install", "redis", "--service", "orders-service");
  writeFileSync(join(o, "src/main/resources/dispatch/orders-service.events.json"), JSON.stringify({ events: [{ name: "users.created", version: 1, channel: "other.channel", publish: false }] }));
  assert.ok(codes(await json(root, "dispatch:validate")).includes("PSO_DISPATCH_011"), "one event lives on one channel everywhere");

  // enabled without an adapter or provider
  writeFileSync(join(o, "src/main/resources/dispatch/orders-service.events.json"), JSON.stringify({ events: [] }));
  const ymlFile = join(o, "src/main/resources/application.yml");
  writeFileSync(ymlFile, read(o, "src/main/resources/application.yml").replace("    enabled: false\n    provider: redis", "    enabled: true\n    provider: none"));
  assert.ok(codes(await json(root, "dispatch:validate")).includes("PSO_DISPATCH_012"));
  const b = (await json(root, "dispatch:graph")) as { edges: unknown[] };
  assert.ok(Array.isArray(b.edges));
  assert.match((await pso(root, "dispatch:graph", "--mermaid")).out, /graph LR/);
});

test("contract lock: a locked schema cannot change silently, a new version is checked for compatibility, compatibility none is the deliberate escape", async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  await pso(root, "dispatch:install", "redis", "--service", "users-service");
  const evFile = join(root, "users-service/src/main/resources/dispatch/users-service.events.json");
  writeFileSync(evFile, EVENTS_JSON(SCHEMA_V1));
  assert.equal((await pso(root, "dispatch:lock", "--dry-run")).code, 0);
  assert.ok(!existsSync(join(root, "pso.dispatch.lock.json")));
  assert.equal((await pso(root, "dispatch:lock")).code, 0);
  assert.match(read(root, "pso.dispatch.lock.json"), /users\.created/);
  assert.equal((await pso(root, "dispatch:validate")).code, 0);

  const ids = async () => { const r = await json(root, "dispatch:validate"); return r.services.flatMap((s: { findings: Array<{ code: string }> }) => s.findings.map((f) => f.code)); };
  // same version, changed schema: refused
  writeFileSync(evFile, EVENTS_JSON({ ...SCHEMA_V1, required: ["userId", "email"], properties: { userId: { type: "string" }, email: { type: "string" } } }));
  assert.ok((await ids()).includes("PSO_DISPATCH_SCHEMA_CHANGED"));
  assert.equal((await pso(root, "dispatch:lock")).code, 1, "the lock refuses a changed contract");
  // version 2 with a new REQUIRED property is not backward compatible under the default (full) policy
  const v2 = { type: "object", required: ["userId", "email"], properties: { userId: { type: "string" }, email: { type: "string" } } };
  writeFileSync(evFile, JSON.stringify({ events: [{ name: "users.created", version: 2, channel: "users.events", schema: v2 }] }));
  assert.ok((await ids()).includes("PSO_DISPATCH_INCOMPATIBLE"));
  // the same version 2 with an OPTIONAL property is compatible
  writeFileSync(evFile, JSON.stringify({ events: [{ name: "users.created", version: 2, channel: "users.events", schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" }, email: { type: "string" } } } }] }));
  assert.equal((await pso(root, "dispatch:validate")).code, 0);
  // a deliberate breaking change is declared, not accidental
  writeFileSync(evFile, JSON.stringify({ events: [{ name: "users.created", version: 2, channel: "users.events", compatibility: "none", schema: v2 }] }));
  assert.equal((await pso(root, "dispatch:validate")).code, 0);
  assert.equal((await pso(root, "dispatch:lock")).code, 0);
  assert.match(read(root, "pso.dispatch.lock.json"), /"2"/);
});

test("orchestrator declarations are verified statically from EVENTS.pso.ts without executing it", async () => {
  const root = await workspace();
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "dispatch:install", "redis", "--service", "gw");
  const d = join(root, "gw/src/dispatch/users");
  mkdirSync(join(d, "schemas"), { recursive: true });
  writeFileSync(join(d, "schemas/user-created.schema.ts"), 'export default { type: "object", required: ["userId"], properties: { userId: { type: "string" } } };\n');
  writeFileSync(join(d, "EVENTS.pso.ts"), 'import { defineEvents } from "@pso/dispatch";\nimport { UserCreatedConsumer } from "./users.consumer";\nexport default defineEvents({\n  events: [{ name: "users.created", version: 1, channel: "users.events", schema: "schemas/user-created.schema.ts" }],\n  consumers: [UserCreatedConsumer],\n});\n');
  writeFileSync(join(d, "users.consumer.ts"), 'import { DispatchConsumer } from "@pso/dispatch";\n@DispatchConsumer("users.created")\nexport class UserCreatedConsumer {\n  async handle(_payload: { userId: string }) {}\n}\n@DispatchConsumer("users.created")\nexport class Forgotten {\n  async handle(_payload: unknown) {}\n}\n');
  let r = await json(root, "dispatch:validate");
  const findings = r.services.flatMap((s: { findings: Array<{ code: string; severity: string }> }) => s.findings);
  assert.deepEqual(findings.filter((f: { severity: string }) => f.severity === "error"), [], JSON.stringify(findings));
  assert.ok(findings.some((f: { code: string }) => f.code === "PSO_DISPATCH_008"), "a decorated but unlisted consumer is reported: it is never registered");
  assert.deepEqual((await json(root, "dispatch:events")).map((e: { event: string; schema: string }) => [e.event, e.schema]), [["users.created", "yes"]]);
  // a missing schema file and an unlisted-but-undeclared consumer reference
  writeFileSync(join(d, "EVENTS.pso.ts"), 'import { defineEvents } from "@pso/dispatch";\nexport default defineEvents({\n  events: [{ name: "users.created", version: 1, channel: "users.events", schema: "schemas/missing.schema.ts" }],\n  consumers: [Nope],\n});\n');
  r = await json(root, "dispatch:validate");
  const msgs = r.services.flatMap((s: { findings: Array<{ message: string }> }) => s.findings.map((f) => f.message)).join("\n");
  assert.match(msgs, /does not exist/); assert.match(msgs, /Nope is listed/);
  // code that cannot be verified without running it is refused instead of guessed
  writeFileSync(join(d, "EVENTS.pso.ts"), 'import { defineEvents } from "@pso/dispatch";\nconst name = ["users", "created"].join(".");\nexport default defineEvents({ events: [{ name, version: 1, channel: "users.events" }] });\n');
  assert.match(JSON.stringify(await json(root, "dispatch:validate")), /cannot be verified statically/);
});

test("dispatch:doctor reports a broker that is not configured or unreachable honestly", async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  await pso(root, "dispatch:install", "redis", "--service", "users-service");
  const r = await pso(root, "dispatch:doctor", "--json");
  const out = JSON.parse(r.out) as { connections: Array<{ status: string; detail: string }> };
  assert.equal(out.connections[0]!.status, "not-configured", "configuration alone is never reported as a connection");
  assert.match(out.connections[0]!.detail, /REDIS_URL/);
});

test("dispatch:doctor really connects to a broker (Redis)", { skip: brokersSkip, timeout: 60_000 }, async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  await pso(root, "dispatch:install", "redis", "--service", "users-service");
  process.env["REDIS_URL"] = env!["PSO_TEST_REDIS_URL"]!;
  try {
    const up = JSON.parse((await pso(root, "dispatch:doctor", "--json")).out) as { connections: Array<{ status: string; ms: number }> };
    assert.equal(up.connections[0]!.status, "up");
    process.env["REDIS_URL"] = "redis://127.0.0.1:1";
    const down = await pso(root, "dispatch:doctor", "--json");
    assert.equal(down.code, 1);
    assert.equal((JSON.parse(down.out) as { connections: Array<{ status: string }> }).connections[0]!.status, "down");
  } finally { delete process.env["REDIS_URL"]; }
});

// ---------------------------------------------------------------- generated projects against REAL brokers

const JAVA_EVENT = (pkg: string) => `package ${pkg};

import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.stereotype.Component;

@Component
public class UserEvents {
    public record UserCreated(String userId, String run) { }
    public static final List<String> SEEN = new CopyOnWriteArrayList<>();

    @PsoEventHandler("users.created")
    public void on(UserCreated event, ConsumeContext ctx) {
        SEEN.add(event.run() + ":" + event.userId() + ":" + ctx.envelope().source());
    }
}
`;

const JAVA_TEST = (pkg: string, provider: string) => `package ${pkg};

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pso.dispatch.PsoDispatch;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

// an integration test against the real broker selects the installed provider itself: the "test" profile of a generated service
// uses the in-process adapter (pso.dispatch.provider: memory) so that its ordinary tests need no broker
@SpringBootTest(properties = {"pso.dispatch.enabled=true", "pso.dispatch.provider=${provider}"})
@ActiveProfiles("test")
class DispatchRoundTripTests {

    @Autowired PsoDispatch dispatch;

    @Test
    void anEventPublishedThroughTheFrameworkIsConsumedByAnAnnotatedHandler() throws Exception {
        String run = UUID.randomUUID().toString();
        var result = dispatch.publish("users.created", Map.of("userId", "u-1", "run", run));
        assertEquals("${provider}", result.provider());
        long end = System.currentTimeMillis() + 60_000;
        while (UserEvents.SEEN.stream().noneMatch(s -> s.startsWith(run)) && System.currentTimeMillis() < end) {
            Thread.sleep(100);
        }
        assertTrue(UserEvents.SEEN.stream().anyMatch(s -> s.equals(run + ":u-1:users-service")), "handler saw " + UserEvents.SEEN);
    }
}
`;

test("a generated Spring service installs each provider with the CLI and exchanges events through a real broker (Maven, Spring Boot, Redis, RabbitMQ, Kafka)", { skip: brokersSkip || mavenSkip, timeout: 1_500_000 }, async () => {
  const root = await workspace();
  await pso(root, "create", "service", "users-service", "--structure", "legacy");
  const dir = join(root, "users-service");
  const pkg = "com.pso.usersservice";
  const pkgDir = join(dir, "src/main/java/com/pso/usersservice");
  const testDir = join(dir, "src/test/java/com/pso/usersservice");
  const brokerEnv = { REDIS_URL: env!["PSO_TEST_REDIS_URL"]!, RABBITMQ_URL: env!["PSO_TEST_RABBITMQ_URL"]!, KAFKA_BOOTSTRAP_SERVERS: env!["PSO_TEST_KAFKA_BROKERS"]! };
  for (const provider of ["redis", "rabbitmq", "kafka"]) {
    if (provider !== "redis") assert.equal((await pso(root, "dispatch:remove", "--service", "users-service")).code, 0);
    assert.equal((await pso(root, "dispatch:install", provider, "--service", "users-service")).code, 0);
    writeFileSync(join(dir, "src/main/resources/dispatch/users-service.events.json"), EVENTS_JSON({ type: "object", required: ["userId", "run"], properties: { userId: { type: "string" }, run: { type: "string" } } }, { key: "userId" }));
    writeFileSync(join(pkgDir, "UserEvents.java"), JAVA_EVENT(pkg));
    writeFileSync(join(testDir, "DispatchRoundTripTests.java"), JAVA_TEST(pkg, provider));
    assert.equal((await pso(root, "dispatch:validate")).code, 0);
    const r = mvnw(dir, brokerEnv, "test", "-Dtest=DispatchRoundTripTests");
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, `${provider}: ${out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 15).join("\n")}`);
    assert.match(out, /Tests run: 1, Failures: 0, Errors: 0/);
  }
  // with dispatch disabled (the default in application.yml) the very same project starts without any broker
  const plain = mvnw(dir, { REDIS_URL: "", RABBITMQ_URL: "", KAFKA_BOOTSTRAP_SERVERS: "" }, "test", "-Dtest=ApplicationTests");
  assert.equal(plain.status, 0, (plain.stdout + plain.stderr).split("\n").filter((l) => /ERROR|FAIL/.test(l)).slice(0, 10).join("\n"));
});

test("a generated orchestrator consumes with a @DispatchConsumer, gets Dispatch injected and republishes, over a real Redis", { skip: brokersSkip, timeout: 240_000 }, async () => {
  const root = await workspace();
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  assert.equal((await pso(root, "dispatch:install", "redis", "--service", "gw")).code, 0);
  const gw = join(root, "gw");
  const d = join(gw, "src/dispatch/users");
  mkdirSync(join(d, "schemas"), { recursive: true });
  const run = `r${Date.now()}`;
  writeFileSync(join(d, "schemas/user-created.schema.ts"), 'export default { type: "object", required: ["userId", "run"], properties: { userId: { type: "string" }, run: { type: "string" } } };\n');
  writeFileSync(join(d, "EVENTS.pso.ts"), 'import { defineEvents } from "@pso/dispatch";\nimport { UserCreatedConsumer } from "./users.consumer";\nexport default defineEvents({\n  events: [\n    { name: "users.created", version: 1, channel: "users.events.' + run + '", schema: "schemas/user-created.schema.ts", publish: false },\n    { name: "users.echoed", version: 1, channel: "users.echo.' + run + '", key: "userId" },\n  ],\n  consumers: [UserCreatedConsumer],\n});\n');
  writeFileSync(join(d, "users.consumer.ts"), 'import { Dispatch, DispatchConsumer } from "@pso/dispatch";\n\n@DispatchConsumer("users.created")\nexport class UserCreatedConsumer {\n  constructor(private readonly dispatch: Dispatch) {}\n  async handle(payload: { userId: string; run: string }) {\n    await this.dispatch.publish("users.echoed", { userId: payload.userId, run: payload.run });\n  }\n}\n');
  assert.equal((await pso(root, "dispatch:validate")).code, 0);
  prepare(gw);
  const port = randomPort();
  const child = spawn(process.execPath, ["dist/main.js"], { cwd: gw, env: { ...process.env, PORT: String(port), PSO_WORKSPACE: join(root, "pso.workspace.json"), PSO_SERVICE: "gw", PSO_DISPATCH_ENABLED: "true", REDIS_URL: env!["PSO_TEST_REDIS_URL"]!, PSO_DISPATCH_REDIS_URL: env!["PSO_TEST_REDIS_URL"]!, PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_JWKS_URI: "https://idp.test/jwks", PSO_DIAGNOSTICS_TOKEN: "d".repeat(40) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout!.on("data", (x: Buffer) => { logs += x; }); child.stderr!.on("data", (x: Buffer) => { logs += x; });
  try {
    for (let i = 0; i < 150 && !/orchestrator listening/.test(logs) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 200));
    assert.match(logs, /orchestrator listening/, logs.slice(-1500));
    const { default: IORedis } = await import("ioredis");
    const redis = new IORedis(env!["PSO_TEST_REDIS_URL"]!);
    // another service publishes users.created (written the way any producer of the canonical envelope would)
    await redis.xadd(`users.events.${run}`, "*", "envelope", JSON.stringify({ envelopeVersion: 1, id: `evt-${run}`, type: "users.created", version: 1, source: "other-service", occurredAt: new Date().toISOString(), correlationId: "corr-gw-1", contentType: "application/json", payload: { run, userId: "u-9" } }));
    let echoed: unknown[] = [];
    for (let i = 0; i < 100 && echoed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const entries = (await redis.xrange(`users.echo.${run}`, "-", "+")) as Array<[string, string[]]>;
      echoed = entries.filter(([, f]) => (f[1] ?? "").includes(run));
    }
    assert.equal(echoed.length, 1, `the consumer ran and republished through the injected Dispatch\n${logs.slice(-1000)}`);
    const sent = JSON.parse((echoed[0] as [string, string[]])[1][1]!);
    assert.deepEqual([sent.type, sent.source, sent.payload.run], ["users.echoed", "gw", run]);
    assert.ok(!logs.includes("redis://"), "broker URLs never appear in the logs");
    // the same run, seen through the authenticated diagnostics endpoint: real dispatch counters and the adapter's own health probe
    let tel: { dispatch: { metrics: { published: number; consumed: number; failed: number; deadLettered: number }; health: { status: string } } | null } = { dispatch: null };
    for (let i = 0; i < 40; i++) {
      tel = (await (await fetch(`http://127.0.0.1:${port}/_pso/telemetry`, { headers: { authorization: `Bearer ${"d".repeat(40)}` } })).json()) as typeof tel;
      if (tel.dispatch?.metrics.consumed === 1 && tel.dispatch.health.status === "up") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.deepEqual([tel.dispatch?.metrics.consumed, tel.dispatch?.metrics.published, tel.dispatch?.metrics.failed, tel.dispatch?.metrics.deadLettered, tel.dispatch?.health.status], [1, 1, 0, 0, "up"], "the diagnostics report what really happened, and the broker health is the adapter's own probe");
    redis.disconnect();
  } finally { child.kill("SIGKILL"); }
});

test("a generated orchestrator refuses to start when dispatch is enabled but declarations or the broker are invalid", { skip: brokersSkip, timeout: 120_000 }, async () => {
  const root = await workspace();
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "dispatch:install", "redis", "--service", "gw");
  const gw = join(root, "gw");
  const d = join(gw, "src/dispatch/users");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "EVENTS.pso.ts"), 'import { defineEvents } from "@pso/dispatch";\nexport default defineEvents({ events: [{ name: "users.created", version: 1, channel: "users.events" }] });\n');
  prepare(gw);
  const start = (extra: Record<string, string>) => spawnSync(process.execPath, ["dist/main.js"], { cwd: gw, encoding: "utf8", timeout: 30_000, env: { ...process.env, PORT: String(randomPort()), PSO_WORKSPACE: join(root, "pso.workspace.json"), PSO_DISPATCH_ENABLED: "true", PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_JWKS_URI: "https://idp.test/jwks", ...extra } });
  const noUrl = start({ PSO_DISPATCH_REDIS_URL: "" });
  assert.notEqual(noUrl.status, 0);
  assert.match(noUrl.stdout + noUrl.stderr, /dispatch\.redis\.url|dispatch initialization failed/);
  const unreachable = start({ PSO_DISPATCH_REDIS_URL: "redis://:topsecret@127.0.0.1:1" });
  assert.notEqual(unreachable.status, 0);
  assert.match(unreachable.stdout + unreachable.stderr, /cannot connect to Redis/);
  assert.ok(!(unreachable.stdout + unreachable.stderr).includes("topsecret"), "credentials never reach the logs");
});
