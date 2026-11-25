import { test } from "node:test";
import assert from "node:assert/strict";
import { readDecl } from "@pso/frontend/node";
import { validateMei, validateRoutes } from "@pso/frontend";
import { customersService } from "../src/services/customers.service.ts";

const dir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("declarations are valid", () => {
  const m = readDecl(`${dir}MEI.pso.ts`, "defineMEI"); assert.deepEqual(m.diagnostics, []); assert.deepEqual(validateMei(m.value).filter((x) => x.severity === "error"), []);
  const r = readDecl(`${dir}ROUTES.pso.ts`, "defineFrontendRoutes"); assert.deepEqual(r.diagnostics, []); assert.deepEqual(validateRoutes(r.value), []);
});

test("the service uses orchestrator paths, encodes identifiers and sends the documented bodies", async () => {
  const calls: Array<[string, string, unknown]> = [];
  const rec = (m: string) => async (p: string, b?: unknown) => { calls.push([m, p, b]); return {}; };
  const s = customersService({ get: rec("GET"), post: rec("POST"), patch: rec("PATCH") } as never);
  await s.findAll(); await s.findById("a/b c"); await s.create({ name: "Ana", email: "ana@example.com" }); await s.setStatus("7", "SUSPENDED");
  assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), ["GET /customers", "GET /customers/a%2Fb%20c", "POST /customers", "PATCH /customers/7/status"]);
  assert.deepEqual(calls[2]![2], { name: "Ana", email: "ana@example.com" });
  assert.deepEqual(calls[3]![2], { status: "SUSPENDED" });
});
