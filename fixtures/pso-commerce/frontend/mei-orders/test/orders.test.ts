import { test } from "node:test";
import assert from "node:assert/strict";
import { readDecl } from "@pso/frontend/node";
import { validateMei, validateRoutes } from "@pso/frontend";
import { ordersService } from "../src/services/orders.service.ts";
import { isFinal, statusTone } from "../src/models/order.ts";

const dir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("declarations are valid", () => {
  const m = readDecl(`${dir}MEI.pso.ts`, "defineMEI"); assert.deepEqual(m.diagnostics, []); assert.deepEqual(validateMei(m.value).filter((x) => x.severity === "error"), []);
  const r = readDecl(`${dir}ROUTES.pso.ts`, "defineFrontendRoutes"); assert.deepEqual(r.diagnostics, []); assert.deepEqual(validateRoutes(r.value), []);
});

test("order status handling", () => {
  assert.equal(isFinal("PENDING"), false); assert.equal(isFinal("CONFIRMED"), true);
  assert.equal(statusTone("CONFIRMED"), "ok"); assert.equal(statusTone("PENDING"), "warn"); assert.equal(statusTone("REJECTED"), "bad");
});

test("the service uses orchestrator paths and documented bodies", async () => {
  const calls: Array<[string, string, unknown]> = [];
  const rec = (m: string) => async (p: string, b?: unknown) => { calls.push([m, p, b]); return {}; };
  const s = ordersService({ get: rec("GET"), post: rec("POST") } as never);
  await s.findAll(); await s.findById("o/1"); await s.place({ customerId: "c", productId: "p", quantity: 2 });
  assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), ["GET /orders", "GET /orders/o%2F1", "POST /orders"]);
  assert.deepEqual(calls[2]![2], { customerId: "c", productId: "p", quantity: 2 });
});
