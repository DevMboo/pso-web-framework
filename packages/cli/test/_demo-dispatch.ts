// Not a test (no .test.ts suffix): produces the real Dispatch transcript quoted in the documentation. Needs the local brokers (node scripts/dispatch-brokers.mjs up).
// Run: node packages/cli/test/_demo-dispatch.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { sessionEnv } from "../../../scripts/dispatch-brokers.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pso, prepare, randomPort } from "./helpers.ts";

const REDIS = (sessionEnv(undefined, ["redis"]) as Record<string, string | undefined>)["PSO_TEST_REDIS_URL"] ?? "redis://127.0.0.1:1";
const base = mkdtempSync(join(tmpdir(), "pso-demo-dsp-"));
await pso(base, "create", "workspace", "shop");
const root = join(base, "shop");
await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
const inst = await pso(root, "dispatch:install", "redis", "--service", "gw");
console.log("$ pso dispatch:install redis --service gw\n" + inst.out);
const gw = join(root, "gw");
const d = join(gw, "src/dispatch/orders");
mkdirSync(join(d, "schemas"), { recursive: true });
const run = `demo${Date.now() % 100000}`;
writeFileSync(join(d, "schemas/order-placed.schema.ts"), 'export default { type: "object", required: ["orderId"], properties: { orderId: { type: "string" }, fail: { type: "boolean" } } };\n');
writeFileSync(join(d, "EVENTS.pso.ts"), `import { defineEvents } from "@pso/dispatch";
import { OrderPlacedConsumer } from "./orders.consumer";
export default defineEvents({
  events: [
    { name: "orders.placed", version: 1, channel: "orders.${run}", schema: "schemas/order-placed.schema.ts", publish: false },
    { name: "orders.confirmed", version: 1, channel: "orders.confirmed.${run}", key: "orderId" },
  ],
  consumers: [OrderPlacedConsumer],
});
`);
writeFileSync(join(d, "orders.consumer.ts"), `import { Dispatch, DispatchConsumer } from "@pso/dispatch";

@DispatchConsumer("orders.placed")
export class OrderPlacedConsumer {
  constructor(private readonly dispatch: Dispatch) {}
  async handle(payload: { orderId: string; fail?: boolean }) {
    if (payload.fail) throw new Error("payment provider unavailable");
    await this.dispatch.publish("orders.confirmed", { orderId: payload.orderId });
  }
}
`);
console.log("\n$ pso dispatch:validate\n" + (await pso(root, "dispatch:validate")).out);
console.log("$ pso dispatch:events\n" + (await pso(root, "dispatch:events")).out);
console.log("$ pso dispatch:consumers\n" + (await pso(root, "dispatch:consumers")).out);
console.log("$ pso dispatch:graph\n" + (await pso(root, "dispatch:graph")).out);
prepare(gw);
const port = randomPort();
const child = spawn(process.execPath, ["dist/main.js"], { cwd: gw, env: { ...process.env, PORT: String(port), PSO_LOG_FORMAT: "pretty", PSO_LOG_COLOR: "never", PSO_WORKSPACE: join(root, "pso.workspace.json"), PSO_SERVICE: "gw", PSO_DISPATCH_ENABLED: "true", REDIS_URL: REDIS, PSO_DISPATCH_REDIS_URL: REDIS, PSO_CFG_dispatch__retry__maxAttempts: "3", PSO_CFG_dispatch__retry__initialDelay: "200ms", PSO_CFG_dispatch__retry__maxDelay: "400ms", PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_JWKS_URI: "https://idp.test/jwks", PSO_DIAGNOSTICS_TOKEN: "d".repeat(40) }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout!.on("data", (x: Buffer) => { logs += x; }); child.stderr!.on("data", (x: Buffer) => { logs += x; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 150 && !/orchestrator listening/.test(logs) && child.exitCode === null; i++) await sleep(200);
const { default: IORedis } = await import("ioredis");
const redis = new IORedis(REDIS);
const envelope = (id: string, payload: unknown) => JSON.stringify({ envelopeVersion: 1, id, type: "orders.placed", version: 1, source: "orders-service", occurredAt: new Date().toISOString(), correlationId: `corr-${id}`, contentType: "application/json", payload });
await redis.xadd(`orders.${run}`, "*", "envelope", envelope("evt-ok-1", { orderId: "o-100" }));
await sleep(1500);
console.log("\n=== stream orders.confirmed (published by the consumer) ===");
for (const [, f] of (await redis.xrange(`orders.confirmed.${run}`, "-", "+")) as Array<[string, string[]]>) { const e = JSON.parse(f[1]!); console.log(JSON.stringify({ id: e.id, type: e.type, source: e.source, correlationId: e.correlationId, causationId: e.causationId, payload: e.payload })); }
await redis.xadd(`orders.${run}`, "*", "envelope", envelope("evt-bad-1", { orderId: "o-200", fail: true }));
await sleep(3500);
await redis.xadd(`orders.${run}`, "*", "envelope", JSON.stringify({ envelopeVersion: 1, id: "evt-poison-1", type: "orders.placed", version: 1, source: "orders-service", occurredAt: new Date().toISOString(), contentType: "application/json", payload: { wrong: 1 } }));
await sleep(1500);
console.log("\n=== dead-letter channel orders." + run + ".dlq ===");
for (const [, f] of (await redis.xrange(`orders.${run}.dlq`, "-", "+")) as Array<[string, string[]]>) { const h: Record<string, string> = {}; for (let i = 0; i < f.length; i += 2) h[f[i]!] = f[i + 1]!.length > 120 ? f[i + 1]!.slice(0, 120) + "…" : f[i + 1]!; console.log(JSON.stringify(h)); }
console.log("\n=== consumer group state ===");
console.log(JSON.stringify(await redis.xinfo("GROUPS", `orders.${run}`)));
const tel = (await (await fetch(`http://127.0.0.1:${port}/_pso/telemetry`, { headers: { authorization: `Bearer ${"d".repeat(40)}` } })).json()) as { dispatch: unknown };
console.log("\n=== /_pso/telemetry dispatch ===\n" + JSON.stringify(tel.dispatch));
console.log("\n=== orchestrator terminal (dispatch-related) ===\n" + logs.split("\n").filter((l) => /dispatch|consumer|retry|dead|poison|handler|evt-/i.test(l)).join("\n").slice(0, 3500));
child.kill("SIGKILL");
await redis.del(`orders.${run}`, `orders.confirmed.${run}`, `orders.${run}.dlq`);
redis.disconnect();
try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
