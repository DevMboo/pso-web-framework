import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWorkspaceShape } from "../src/workspace.ts";

const base = { schemaVersion: 1, name: "shop", services: [{ name: "gateway", path: "gateway", runtime: "node", role: "orchestrator", port: 3000 }] };
const codes = (frontends: unknown, services = base.services) => validateWorkspaceShape({ ...base, services, frontends }).map((d) => d.code);

test("a workspace without frontends is unchanged (the member is optional)", () => {
  assert.deepEqual(validateWorkspaceShape(base), []);
});

test("valid frontends are accepted", () => {
  assert.deepEqual(codes([{ name: "fei-shop", kind: "fei", path: "frontend/fei-shop", port: 4200 }, { name: "mei-customers", kind: "mei", path: "frontend/mei-customers", port: 9000 }]), []);
});

test("frontend declarations are checked: names, kind, path traversal (both separators), ports shared with services, duplicates, one FEI", () => {
  assert.ok(codes([{ name: "Fei", kind: "fei", path: "a", port: 4200 }]).includes("PSO_FRONTEND_SHAPE"));
  assert.ok(codes([{ name: "x-a", kind: "spa", path: "a", port: 4200 }]).includes("PSO_FRONTEND_SHAPE"));
  for (const p of ["../x", "a/../b", "a\\..\\b", "/abs", "C:\\abs"]) assert.ok(codes([{ name: "fei-a", kind: "fei", path: p, port: 4200 }]).includes("PSO_FRONTEND_PATH"), p);
  assert.ok(codes([{ name: "fei-a", kind: "fei", path: "a", port: 3000 }]).includes("PSO_PORT_CONFLICT"), "a frontend cannot take a service's port");
  assert.ok(codes([{ name: "fei-a", kind: "fei", path: "a", port: 80 }]).includes("PSO_FRONTEND_PORT"));
  assert.ok(codes([{ name: "gateway", kind: "mei", path: "a", port: 9000 }]).includes("PSO_DUPLICATE_SERVICE"), "frontends share the project namespace");
  assert.ok(codes([{ name: "mei-a", kind: "mei", path: "a", port: 9000 }, { name: "mei-b", kind: "mei", path: "b", port: 9000 }]).includes("PSO_PORT_CONFLICT"));
  // 0.2.0: several independent shells are allowed; they still cannot share a port
  assert.deepEqual(codes([{ name: "fei-a", kind: "fei", path: "a", port: 4200 }, { name: "fei-b", kind: "fei", path: "b", port: 4201 }]), [], "two FEIs are allowed");
  assert.ok(codes([{ name: "fei-a", kind: "fei", path: "a", port: 4200 }, { name: "fei-b", kind: "fei", path: "b", port: 4200 }]).includes("PSO_PORT_CONFLICT"), "two FEIs on one port");
  assert.ok(codes("nope").includes("PSO_FRONTEND_SHAPE"));
});
