import { test } from "node:test";
import assert from "node:assert/strict";
import { readDecl } from "@pso/frontend/node";
import { validateMei, validateRoutes } from "@pso/frontend";
import { cartService } from "../src/services/cart.service.ts";

const dir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("MEI.pso.ts and ROUTES.pso.ts are valid declarations", () => {
  const m = readDecl(`${dir}MEI.pso.ts`, "defineMEI"); assert.deepEqual(m.diagnostics, []);
  assert.deepEqual(validateMei(m.value).filter((x) => x.severity === "error"), []);
  const r = readDecl(`${dir}ROUTES.pso.ts`, "defineFrontendRoutes"); assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(validateRoutes(r.value), []);
});

test("the service talks to the orchestrator paths only and encodes identifiers", async () => {
  const calls: string[] = [];
  const api = { get: async (p: string) => { calls.push(p); return []; } } as never;
  const s = cartService(api);
  await s.findAll(); await s.findById("a/b c");
  assert.deepEqual(calls, ["/cart", "/cart/a%2Fb%20c"]);
});
