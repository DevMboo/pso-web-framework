import { test } from "node:test";
import assert from "node:assert/strict";
import { readDecl } from "@pso/frontend/node";
import { validateMei, validateRoutes } from "@pso/frontend";
import { productsService } from "../src/services/products.service.ts";
import { formatPrice, parsePrice } from "../src/models/product.ts";

const dir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("declarations are valid", () => {
  const m = readDecl(`${dir}MEI.pso.ts`, "defineMEI"); assert.deepEqual(m.diagnostics, []); assert.deepEqual(validateMei(m.value).filter((x) => x.severity === "error"), []);
  const r = readDecl(`${dir}ROUTES.pso.ts`, "defineFrontendRoutes"); assert.deepEqual(r.diagnostics, []); assert.deepEqual(validateRoutes(r.value), []);
});

test("prices are parsed to integer cents without floating point", () => {
  assert.equal(parsePrice("19.90"), 1990); assert.equal(parsePrice("19,9"), 1990); assert.equal(parsePrice("0"), 0); assert.equal(parsePrice("1234"), 123400);
  for (const bad of ["", "-1", "1.234", "abc", "1e3", "1.", "12345678901"]) assert.equal(parsePrice(bad), undefined, bad);
  assert.match(formatPrice(1990), /19\.90/);
});

test("the service uses orchestrator paths and documented bodies", async () => {
  const calls: Array<[string, string, unknown]> = [];
  const rec = (m: string) => async (p: string, b?: unknown) => { calls.push([m, p, b]); return {}; };
  const s = productsService({ get: rec("GET"), post: rec("POST"), patch: rec("PATCH") } as never);
  await s.findAll(); await s.findById("x y"); await s.create({ sku: "A1", name: "A", priceCents: 100, stock: 3 }); await s.setStock("9", 4);
  assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), ["GET /products", "GET /products/x%20y", "POST /products", "PATCH /products/9/stock"]);
  assert.deepEqual(calls[3]![2], { stock: 4 });
});
