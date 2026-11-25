import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { up, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const page = readFileSync(resolve(import.meta.dirname, "..", "docs", "dispatch", "diagnostics.md"), "utf8").replaceAll("\r\n", "\n");

// The real brokers: the PSO_TEST_* variables when set, otherwise this test session's own containers (labelled, on ports the operating
// system assigned). No address is assumed: a run without brokers reports the broker test as skipped, never as passed.
let infra: Record<string, string> = {};
let brokersSkip: string | false = false;
before(async () => {
  if (!dockerAvailable() && !(process.env["PSO_TEST_REDIS_URL"] && process.env["PSO_TEST_RABBITMQ_URL"] && process.env["PSO_TEST_KAFKA_BROKERS"])) { brokersSkip = "no Docker engine: real broker tests not run"; return; }
  try { infra = (await up({ kinds: ["redis", "rabbitmq", "kafka"] })) as Record<string, string>; } catch (e) { brokersSkip = `brokers unavailable: ${(e as Error).message}`; }
}, { timeout: 300_000 });
const DOCTOR_VARS = ["PSO_DISPATCH_ENABLED", "REDIS_URL", "RABBITMQ_URL", "KAFKA_BOOTSTRAP_SERVERS"];

/** "Checking Dispatch and what its errors mean": the static commands and every error are reproduced; the broker checks run when the local brokers are up. */
test("dispatch diagnostics page: declarations, lock, and each error are what the CLI prints", { timeout: 120_000 }, async () => {
  const base = tmp("pso-dsp-doc-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab", "--layout", "flat")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gw", "--template", "empty")).code, 0);
  const inst = await pso(ws, "dispatch:install", "redis", "--service", "gw");
  assert.equal(inst.code, 0);
  for (const l of ["package.json: + @pso/dispatch", "package.json: + ioredis", "pso.config.json: dispatch.provider = redis (enabled stays false; secrets are ${env:...} references)"]) assert.ok(inst.out.includes(l) && page.includes(l), l);

  const providers = (await pso(ws, "dispatch:providers")).out;
  for (const l of providers.split("\n").filter((x) => x.trim() !== "" && !x.includes("installed in:"))) assert.ok(page.includes(l.trimEnd()), `the page shows the provider line: ${l}`);

  const d = join(ws, "gw/src/dispatch/orders");
  mkdirSync(join(d, "schemas"), { recursive: true });
  const schema = 'export default { type: "object", required: ["orderId"], properties: { orderId: { type: "string" } } };\n';
  const events = (schemaPath: string) => `import { defineEvents } from "@pso/dispatch";\nimport { OrderPlacedConsumer } from "./orders.consumer";\nexport default defineEvents({\n  events: [\n    { name: "orders.placed", version: 1, channel: "orders.events", schema: "${schemaPath}", publish: false },\n  ],\n  consumers: [OrderPlacedConsumer],\n});\n`;
  const consumer = (event: string) => `import { Dispatch, DispatchConsumer } from "@pso/dispatch";\n\n@DispatchConsumer("${event}")\nexport class OrderPlacedConsumer {\n  constructor(private readonly dispatch: Dispatch) {}\n  async handle(payload: { orderId: string }) { void payload; }\n}\n`;
  writeFileSync(join(d, "schemas/order-placed.schema.ts"), schema);
  writeFileSync(join(d, "orders.consumer.ts"), consumer("orders.placed"));
  writeFileSync(join(d, "EVENTS.pso.ts"), events("schemas/order-placed.schema.ts"));
  // the files the page shows are the files created here
  for (const f of ["EVENTS.pso.ts", "orders.consumer.ts"]) for (const l of readFileSync(join(d, f), "utf8").split("\n").filter((x) => x.trim() !== "")) assert.ok(page.includes(l), `the page shows ${f}: ${l}`);

  const seen = async (what: string, ...fragments: string[]) => { const r = await pso(ws, "dispatch:validate"); const t = r.out + r.err; for (const f of fragments) { assert.ok(t.includes(f), `${what}: CLI prints "${f}"`); assert.ok(page.includes(f), `${what}: page shows "${f}"`); } return r; };
  assert.equal((await seen("unlocked", "PSO_DISPATCH_UNLOCKED", "orders.placed v1 is not locked yet")).code, 0);
  assert.equal((await pso(ws, "dispatch:lock")).out.trim(), "locked: orders.placed@1");
  assert.ok(page.includes("locked: orders.placed@1"));
  assert.equal((await seen("locked", "no findings")).code, 0);

  writeFileSync(join(d, "EVENTS.pso.ts"), events("schemas/missing.schema.ts"));
  assert.equal((await seen("missing schema", "PSO_DISPATCH_004", 'schema file schemas/missing.schema.ts of "orders.placed" does not exist', "2 error(s)")).code, 1);
  writeFileSync(join(d, "EVENTS.pso.ts"), events("schemas/order-placed.schema.ts"));
  writeFileSync(join(d, "schemas/order-placed.schema.ts"), 'export default { type: "object", required: ["orderId", "total"], properties: { orderId: { type: "string" }, total: { type: "number" } } };\n');
  assert.equal((await seen("breaking change", "PSO_DISPATCH_SCHEMA_CHANGED", "changed after it was locked", "Declare version 2")).code, 1);
  writeFileSync(join(d, "schemas/order-placed.schema.ts"), schema);
  writeFileSync(join(d, "orders.consumer.ts"), consumer("orders.shipped"));
  assert.equal((await seen("undeclared event", "PSO_DISPATCH_007", 'handles "orders.shipped"')).code, 1);
  writeFileSync(join(d, "orders.consumer.ts"), consumer("orders.placed"));

  // the doctor: not configured is never reported as up
  const nc = await pso(ws, "dispatch:doctor");
  assert.match(nc.out, /NOT-CONFIGURED gw \(redis\): invalid dispatch configuration:/);
  assert.ok(page.includes("NOT-CONFIGURED gw (redis): invalid dispatch configuration:"));
  const prev = { ...process.env };
  try {
    process.env["PSO_DISPATCH_ENABLED"] = "true"; process.env["REDIS_URL"] = "redis://127.0.0.1:1";
    const down = await pso(ws, "dispatch:doctor");
    assert.equal(down.code, 1);
    assert.ok(down.out.includes("DOWN           gw (redis): cannot connect to Redis (Error)") && page.includes("DOWN           gw (redis): cannot connect to Redis (Error)"));
    // RabbitMQ and Kafka: an address nothing listens on (port 1 of this machine) is reported as DOWN
    for (const [provider, variable, dead, downLine] of [
      ["rabbitmq", "RABBITMQ_URL", "amqp://guest:guest@127.0.0.1:1", "DOWN           gw (rabbitmq): cannot connect to RabbitMQ (Error)"],
      ["kafka", "KAFKA_BOOTSTRAP_SERVERS", "127.0.0.1:1", "DOWN           gw (kafka): connection timed out after 8 s"],
    ] as const) {
      delete process.env["REDIS_URL"];
      assert.equal((await pso(ws, "dispatch:remove", "--service", "gw")).code, 0);
      assert.equal((await pso(ws, "dispatch:install", provider, "--service", "gw")).code, 0);
      process.env[variable] = dead;
      const down2 = await pso(ws, "dispatch:doctor");
      assert.equal(down2.code, 1);
      assert.ok(down2.out.includes(downLine) && page.includes(downLine), downLine);
      delete process.env[variable];
    }
  } finally { for (const k of DOCTOR_VARS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
});

/** The doctor against real brokers: connectivity only (reachability is what the doctor proves, not delivery). */
test("dispatch diagnostics page: the doctor reports each real broker as UP with the line the page shows", { timeout: 180_000 }, async (t) => {
  if (brokersSkip) return t.skip(brokersSkip);
  const base = tmp("pso-dsp-doc-up-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab", "--layout", "flat")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gw", "--template", "empty")).code, 0);
  const prev = { ...process.env };
  try {
    process.env["PSO_DISPATCH_ENABLED"] = "true";
    let installed = false;
    for (const [provider, variable, address, upLine] of [
      ["redis", "REDIS_URL", infra["PSO_TEST_REDIS_URL"], "gw (redis): PING answered"],
      ["rabbitmq", "RABBITMQ_URL", infra["PSO_TEST_RABBITMQ_URL"], "gw (rabbitmq): connection open"],
      ["kafka", "KAFKA_BOOTSTRAP_SERVERS", infra["PSO_TEST_KAFKA_BROKERS"], "gw (kafka): metadata request answered"],
    ] as const) {
      assert.ok(address, `the ${provider} address of this test session is known`);
      if (installed) assert.equal((await pso(ws, "dispatch:remove", "--service", "gw")).code, 0);
      assert.equal((await pso(ws, "dispatch:install", provider, "--service", "gw")).code, 0);
      installed = true;
      process.env[variable] = address;
      const r = await pso(ws, "dispatch:doctor");
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /^UP {13}gw /m);
      assert.ok(r.out.includes(upLine) && page.includes(upLine), upLine);
      delete process.env[variable];
    }
  } finally { for (const k of DOCTOR_VARS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
});
