// Interoperability helper used by the Java integration tests: the TypeScript runtime as a publisher or as a consumer of the same
// channel the Java runtime uses. Configuration comes from the environment; output is line based (READY, RECEIVED <json>, PUBLISHED).
import { DispatchRuntime, DEFAULT_SETTINGS, EventRegistry, loadTrustKeys, type TrustMode } from "../src/index.ts";
import { RedisStreamsAdapter } from "../src/redis.ts";
import { RabbitMqAdapter } from "../src/rabbitmq.ts";
import { KafkaAdapter } from "../src/kafka.ts";

const e = process.env as Record<string, string>;
const provider = e["CL_PROVIDER"]!;
const adapter = provider === "redis" ? new RedisStreamsAdapter({ url: e["PSO_TEST_REDIS_URL"]!, maxLength: 10000, minIdleMs: 60_000, blockMs: 300, streamCreation: "auto" })
  : provider === "rabbitmq" ? new RabbitMqAdapter({ url: e["PSO_TEST_RABBITMQ_URL"]!, exchangePrefix: "pso." })
    : new KafkaAdapter({ brokers: [e["PSO_TEST_KAFKA_BROKERS"]!], clientId: `ts-crosslang-${process.pid}`, topicCreation: "auto", partitions: 1, replicationFactor: 1, ssl: false });

const registry = new EventRegistry();
registry.add({ name: "it.user-created", version: 1, channel: "it-events", key: "run", schema: { type: "object", required: ["run", "n", "mode"], additionalProperties: false, properties: { run: { type: "string", minLength: 1 }, n: { type: "integer", minimum: 0 }, mode: { enum: ["ok", "fail-twice", "always-fail"] } } } });
// publisher trust (optional): CL_TRUST_MODE = off | permissive | required, keys from PSO_DISPATCH_SIGNING_KEY / PSO_DISPATCH_TRUST_KEY_<SERVICE>,
// CL_SOURCE = the service name this process claims (default ts-service). Without them the script behaves exactly as before.
const source = e["CL_SOURCE"] ?? "ts-service";
const problems: Array<{ code: string; message: string }> = [];
const keys = loadTrustKeys(e, source, problems);
if (problems.length) { process.stdout.write(`CONFIG ${problems.map((p) => p.message).join("; ")}\n`); process.exit(2); }
const trust = e["CL_TRUST_MODE"] || keys.signingKey ? { trust: { mode: (e["CL_TRUST_MODE"] ?? "off") as TrustMode, ...keys } } : {};
const runtime = new DispatchRuntime({ settings: { source, ...DEFAULT_SETTINGS, ...trust }, adapter, registry });

if (e["CL_MODE"] === "consume") {
  runtime.registerFunction("it.user-created", (payload, ctx) => { process.stdout.write(`RECEIVED ${JSON.stringify({ payload, id: ctx.envelope.id, source: ctx.envelope.source, correlationId: ctx.envelope.correlationId, version: ctx.envelope.version, type: ctx.envelope.type, verifiedSource: ctx.verifiedSource ?? null })}\n`); }, { group: e["CL_GROUP"]! });
  await runtime.start();
  process.stdout.write("READY\n");
  process.stdin.resume();
  process.stdin.on("close", async () => { await runtime.stop(); process.exit(0); });
} else {
  await runtime.start();
  const r = await runtime.publish("it.user-created", JSON.parse(e["CL_PAYLOAD"]!), { correlationId: e["CL_CORRELATION"]!, id: e["CL_ID"]! });
  process.stdout.write(`PUBLISHED ${r.provider}\n`);
  await runtime.stop();
  process.exit(0);
}
