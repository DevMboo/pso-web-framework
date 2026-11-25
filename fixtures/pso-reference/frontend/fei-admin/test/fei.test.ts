import { test } from "node:test";
import assert from "node:assert/strict";
import { readDecl } from "@pso/frontend/node";
import { validateFei, validateRoutes } from "@pso/frontend";

const dir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("FEI.pso.ts is a valid FEI declaration", () => {
  const d = readDecl(`${dir}FEI.pso.ts`, "defineFEI");
  assert.deepEqual(d.diagnostics, []);
  assert.deepEqual(validateFei(d.value).filter((x) => x.severity === "error"), []);
});

test("ROUTES.pso.ts is a valid route declaration", () => {
  const d = readDecl(`${dir}ROUTES.pso.ts`, "defineFrontendRoutes");
  assert.deepEqual(d.diagnostics, []);
  assert.deepEqual(validateRoutes(d.value), []);
});
