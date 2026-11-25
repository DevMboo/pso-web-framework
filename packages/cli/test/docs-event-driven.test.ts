import { test, after } from "node:test";
import { sessionEnv } from "../../../scripts/dispatch-brokers.mjs";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { pso, prepare, startNode, tmp, randomPort } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const REDIS_URL = (sessionEnv(undefined, ["redis"]) as Record<string, string | undefined>)["PSO_TEST_REDIS_URL"] ?? "redis://127.0.0.1:1";
const reachable = await new Promise<boolean>((r) => { const u = new URL(REDIS_URL); const s = net.connect(Number(u.port), u.hostname); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tutorial = readFileSync(resolve(import.meta.dirname, "..", "docs", "tutorials", "event-driven.md"), "utf8").replaceAll("\r\n", "\n");

function http(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (m) => { let d = ""; m.on("data", (c) => { d += c; }); m.on("end", () => res({ status: m.statusCode!, body: d })); });
    r.on("error", rej); if (body) r.write(body); r.end();
  });
}
const CONTROLLER_BODY = `import { Controller, RestController, Post, Body, HttpError } from "@pso/http";
import { Dispatch } from "@pso/dispatch";

@Controller()
@RestController("/orders")
export class OrdersController {
  constructor(private readonly dispatch: Dispatch) {}

  @Post("/")
  async place(@Body() body: { orderId?: string; fail?: boolean }) {
    if (typeof body?.orderId !== "string" || body.orderId === "") throw new HttpError(400, "orderId is required");
    const result = await this.dispatch.publish("orders.placed", { orderId: body.orderId, ...(body.fail === true ? { fail: true } : {}) });
    return { accepted: true, eventId: result.id };
  }
}
`;

/**
 * "Publish and consume an event": the tutorial's producer (an orchestrator action), consumer, contract and registration are generated and run against a real Redis;
 * what the tutorial says is checked against what happens. Skipped when the local Redis is not running (node scripts/dispatch-brokers.mjs up).
 */
test("event-driven tutorial: publish from an action, consume, retry, dead-letter, acknowledge (real Redis)", { timeout: 240_000, skip: reachable ? false : "no local Redis (node scripts/dispatch-brokers.mjs up)" }, async () => {
  const base = tmp("pso-event-doc-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab", "--layout", "flat")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gw", "--template", "empty")).code, 0);
  // the tutorial's development identity provider: a key generated here, tokens signed by the CLI
  assert.equal((await pso(ws, "idp:dev", "init", "--issuer", "https://shop.local", "--audience", "shop-api")).code, 0);
  const installed = await pso(ws, "dispatch:install", "redis", "--service", "gw");
  assert.equal(installed.code, 0);
  for (const l of installed.out.split("\n").filter((x) => x.trim() !== "")) assert.ok(tutorial.includes(l), `the tutorial shows the installer line: ${l}`);
  for (const a of [["make:module", "orders"], ["make:controller", "orders"]]) assert.equal((await pso(ws, ...a, "--service", "gw")).code, 0);
  const route = await pso(ws, "make:route", "orders", "place", "--method", "POST", "--path", "/", "--guard", "jwt", "--scopes", "orders:write", "--service", "gw");
  assert.equal(route.code, 0, route.out + route.err);

  const gw = join(ws, "gw");
  writeFileSync(join(gw, "src/modules/orders/controllers/orders.controller.ts"), CONTROLLER_BODY);
  const d = join(gw, "src/dispatch/orders");
  mkdirSync(join(d, "schemas"), { recursive: true });
  const schema = 'export default { type: "object", required: ["orderId"], properties: { orderId: { type: "string" }, fail: { type: "boolean" } } };\n';
  const events = `import { defineEvents } from "@pso/dispatch";\nimport { OrderPlacedConsumer } from "./orders.consumer";\n\nexport default defineEvents({\n  events: [\n    { name: "orders.placed", version: 1, channel: "orders.placed", schema: "schemas/order-placed.schema.ts", key: "orderId" },\n    { name: "orders.confirmed", version: 1, channel: "orders.confirmed", key: "orderId" },\n  ],\n  consumers: [OrderPlacedConsumer],\n});\n`;
  const consumer = `import { Dispatch, DispatchConsumer } from "@pso/dispatch";\n\n@DispatchConsumer("orders.placed")\nexport class OrderPlacedConsumer {\n  constructor(private readonly dispatch: Dispatch) {}\n\n  async handle(payload: { orderId: string; fail?: boolean }) {\n    if (payload.fail) throw new Error("payment provider unavailable");\n    await this.dispatch.publish("orders.confirmed", { orderId: payload.orderId });\n  }\n}\n`;
  writeFileSync(join(d, "schemas/order-placed.schema.ts"), schema);
  writeFileSync(join(d, "EVENTS.pso.ts"), events);
  writeFileSync(join(d, "orders.consumer.ts"), consumer);

  // the files shown in the tutorial are these files
  for (const [name, text] of [["EVENTS.pso.ts", events], ["orders.consumer.ts", consumer], ["order-placed.schema.ts", schema], ["orders.controller.ts", CONTROLLER_BODY]] as const) {
    if (!process.env["PSO_SKIP_DOC"]) for (const l of text.split("\n").filter((x) => x.trim() !== "")) assert.ok(tutorial.includes(l), `the tutorial shows ${name}: ${l}`);
  }

  const validate = await pso(ws, "dispatch:validate");
  assert.equal(validate.code, 0, validate.out + validate.err);
  assert.ok(validate.out.includes("PSO_DISPATCH_UNLOCKED") && validate.out.includes("orders.placed v1 is not locked yet"));
  assert.equal((await pso(ws, "dispatch:lock")).code, 0);
  const structural = await pso(ws, "validate");
  assert.equal(structural.code, 0, structural.out + structural.err);
  prepare(gw);

  const { default: IORedis } = await import("ioredis");
  const redis = new IORedis(REDIS_URL);
  for (const k of ["orders.placed", "orders.placed.dlq", "orders.confirmed", "orders.confirmed.dlq"]) await redis.del(k);
  const keysDir = join(ws, "idp", "keys");
  const pub = join(keysDir, readdirSync(keysDir).find((f) => f.endsWith(".public.pem"))!);
  const port = randomPort();
  const node = await startNode(gw, {
    PORT: String(port), PSO_WORKSPACE: join(ws, "pso.workspace.json"), PSO_LOG_FORMAT: "pretty", PSO_LOG_COLOR: "never",
    PSO_JWT_ISSUER: "https://shop.local", PSO_JWT_AUDIENCE: "shop-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256",
    PSO_DISPATCH_ENABLED: "true", REDIS_URL, PSO_CFG_dispatch__retry__initialDelay: "200ms", PSO_CFG_dispatch__retry__maxDelay: "400ms",
  });
  try {
    const minted = await pso(ws, "idp:dev", "token", "--scopes", "orders:write", "--audience", "shop-api");
    assert.equal(minted.code, 0, minted.out + minted.err);
    const auth = { authorization: `Bearer ${minted.out.trim()}`, "content-type": "application/json" };
    // 1. success: accepted by the action, consumed, confirmed
    const ok = await http(port, "POST", "/orders", auth, JSON.stringify({ orderId: "o-100" }));
    assert.equal(ok.status, 201, ok.body);
    const accepted = JSON.parse(ok.body) as { accepted: boolean; eventId: string };
    assert.equal(accepted.accepted, true);
    await sleep(1500);
    const confirmed = (await redis.xrange("orders.confirmed", "-", "+")) as Array<[string, string[]]>;
    assert.equal(confirmed.length, 1, "the consumer published orders.confirmed");
    const env = JSON.parse(confirmed[0]![1][1]!) as { type: string; payload: { orderId: string }; source: string };
    assert.equal(env.type, "orders.confirmed"); assert.equal(env.payload.orderId, "o-100");
    const groups = (await redis.xinfo("GROUPS", "orders.placed")) as unknown[][];
    const g = Object.fromEntries(Array.from({ length: groups[0]!.length / 2 }, (_, i) => [groups[0]![i * 2] as string, groups[0]![i * 2 + 1]]));
    assert.equal(g["pending"], 0, "acknowledged: nothing pending");
    // 2. an invalid body is refused before anything is published
    const bad = await http(port, "POST", "/orders", auth, JSON.stringify({}));
    assert.equal(bad.status, 400);
    assert.equal((await redis.xlen("orders.placed")), 1, "nothing was published for the invalid request");
    // 3. a handler that fails: retries, then the dead-letter channel
    const failing = await http(port, "POST", "/orders", auth, JSON.stringify({ orderId: "o-fail", fail: true }));
    assert.equal(failing.status, 201);
    await sleep(3500);
    const dlq = (await redis.xrange("orders.placed.dlq", "-", "+")) as Array<[string, string[]]>;
    assert.equal(dlq.length, 1, "the failed event is dead-lettered once");
    const headers = Object.fromEntries(Array.from({ length: dlq[0]![1].length / 2 }, (_, i) => [dlq[0]![1][i * 2], dlq[0]![1][i * 2 + 1]]));
    assert.equal(headers["h:x-pso-reason"], "handler-failed:Error");
    assert.equal(headers["h:x-pso-attempts"], "3");
    assert.equal((await redis.xlen("orders.confirmed")), 1, "a failed handler publishes nothing");
    const logs = node.logs();
    assert.equal((logs.match(/consumer failed/g) ?? []).length, 3, "three attempts");
    if (!process.env["PSO_SKIP_DOC"]) for (const line of ["h:x-pso-reason", "handler-failed:Error", "attempt=3"]) assert.ok(tutorial.includes(line), `the tutorial mentions ${line}`);
    if (process.env["PSO_WRITE_EVIDENCE"]) {
      const lines = logs.split("\n").filter((l) => /consumer failed|orchestrator listening|dispatch/i.test(l));
      writeFileSync(process.env["PSO_WRITE_EVIDENCE"], [`# POST /orders {"orderId":"o-100"} -> ${ok.status} ${ok.body}`, `# invalid body -> ${bad.status} ${bad.body}`, `# POST /orders {"orderId":"o-fail","fail":true} -> ${failing.status} ${failing.body}`, "# orchestrator log (selected lines)", ...lines, "# orders.confirmed", JSON.stringify(env), "# group orders.placed", JSON.stringify(g), "# dlq headers", JSON.stringify(headers)].join("\n") + "\n");
    }
    // the values the tutorial prints as Verified come from a committed run of this very scenario
    const evidence = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "implementation", "evidence", "event-driven-transcript.txt"), "utf8");
    for (const m of tutorial.matchAll(/```(?:json|text) evidence="verified"\n([\s\S]*?)\n```/g)) {
      for (const line of m[1]!.split("\n").filter((x) => /^(\{|2026-)/.test(x))) {
        const value = line.replace(/^\{"accepted":true,"eventId":"/, "").replace(/"\}$/, "");
        assert.ok(evidence.includes(line) || evidence.includes(value), `not in the committed transcript: ${line.slice(0, 100)}`);
      }
    }
  } finally { node.child.kill(); await redis.quit(); }
});
