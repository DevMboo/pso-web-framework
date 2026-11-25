// Child process used by providers.test.ts: consumes one message and hangs without acknowledging; the test then kills the process
// (a real crash: sockets and heartbeats stop abruptly, nothing is committed).
import { DispatchRuntime, DEFAULT_SETTINGS, EventRegistry } from "../src/index.ts";
import { KafkaAdapter } from "../src/kafka.ts";

const channel = process.env["CRASH_CHANNEL"]!;
const registry = new EventRegistry();
registry.add({ name: "t.event", version: 1, channel });
const runtime = new DispatchRuntime({
  settings: { source: "svc-service", ...DEFAULT_SETTINGS },
  adapter: new KafkaAdapter({ brokers: [process.env["PSO_TEST_KAFKA_BROKERS"]!], clientId: `crash-${process.pid}`, topicCreation: "auto", partitions: 3, replicationFactor: 1, ssl: false }),
  registry,
});
runtime.registerFunction("t.event", async () => { process.stdout.write("HANDLING\n"); await new Promise(() => undefined); }, { group: process.env["CRASH_GROUP"]! });
await runtime.start();
process.stdout.write("STARTED\n");
