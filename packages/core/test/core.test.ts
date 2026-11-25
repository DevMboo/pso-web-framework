import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, validateProject, buildManifest, serializeManifest, validateWorkspaceShape, findCycles, topoOrder, LifecycleManager, hasErrors } from "../src/index.ts";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pso-core-"));
  for (const [f, c] of Object.entries(files)) {
    const p = join(root, ...f.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, c);
  }
  return root;
}

const contract = JSON.stringify({ name: "users", version: "1.0.0", service: "users", operations: [{ id: "list", method: "GET", path: "/users" }] });

test("discovery classifies by suffix, ignores helpers, never executes modules", () => {
  // these files would throw if they were imported or executed
  const root = project({
    "src/routes/users/MODULE.pso.ts": "throw new Error('must not run');",
    "src/routes/users/ROUTES.pso.ts": "throw new Error('must not run');",
    "src/routes/users/users.controller.ts": "throw new Error('must not run');",
    "src/guards/authenticated.guard.ts": "",
    "src/util/helper.ts": "",
    "src/contracts/users.contract.json": contract,
  });
  try {
    const d = discover(root, "node");
    assert.deepEqual(d.resources.map((r) => r.key), ["contract:users", "controller:users/users", "guard:authenticated", "module:users", "route-registry:users"]);
    assert.equal(hasErrors(validateProject(root, d)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("misplaced, badly named and duplicate resources are reported with codes", () => {
  const root = project({
    "src/other/users.controller.ts": "",
    "src/routes/users/BadName.controller.ts": "",
    "src/guards/a/dup.guard.ts": "",
    "src/guards/b/dup.guard.ts": "",
  });
  try {
    const codes = validateProject(root, discover(root, "node")).map((d) => d.code);
    assert.ok(codes.includes("PSO_MISPLACED_RESOURCE"));
    assert.ok(codes.includes("PSO_BAD_NAME"));
    assert.ok(codes.includes("PSO_DUPLICATE_ID"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid contract is diagnosed, not thrown", () => {
  const root = project({ "src/contracts/x.contract.json": "{not json", "src/contracts/y.contract.json": JSON.stringify({ name: "y", version: "1", service: "y", operations: [] }) });
  try {
    const codes = validateProject(root, discover(root, "node")).map((d) => d.code);
    assert.ok(codes.includes("PSO_CONTRACT_INVALID_JSON"));
    assert.ok(codes.includes("PSO_CONTRACT_VERSION"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spring discovery uses the last package segment and PascalCase ids", () => {
  const root = project({
    "src/main/java/com/acme/users/routes/CustomerController.java": "",
    "src/main/java/com/acme/users/adapters/CustomerMapper.java": "",
    "src/main/java/com/acme/users/wrong/OrderService.java": "",
  });
  try {
    const d = discover(root, "spring-boot");
    assert.deepEqual(d.resources.map((r) => r.key), ["controller:CustomerController", "mapper:CustomerMapper"]);
    assert.ok(d.diagnostics.some((x) => x.code === "PSO_MISPLACED_RESOURCE"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manifest is deterministic regardless of creation order", () => {
  const a = project({ "src/guards/a.guard.ts": "", "src/guards/b.guard.ts": "" });
  const b = project({ "src/guards/b.guard.ts": "", "src/guards/a.guard.ts": "" });
  try {
    assert.equal(serializeManifest(buildManifest(discover(a, "node"))), serializeManifest(buildManifest(discover(b, "node"))));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("workspace validation: port conflict, missing dependency, cycle, unsupported schema, path escape", () => {
  const svc = (name: string, port: number, dependsOn: string[] = [], path = name) => ({ name, path, runtime: "node", port, dependsOn });
  const codes = (w: unknown) => validateWorkspaceShape(w).map((d) => d.code);
  assert.ok(codes({ schemaVersion: 1, name: "w", services: [svc("a", 4000), svc("b", 4000)] }).includes("PSO_PORT_CONFLICT"));
  assert.ok(codes({ schemaVersion: 1, name: "w", services: [svc("a", 4000, ["zz"])] }).includes("PSO_MISSING_DEPENDENCY"));
  assert.ok(codes({ schemaVersion: 1, name: "w", services: [svc("a", 4000, ["b"]), svc("b", 4001, ["a"])] }).includes("PSO_CYCLE"));
  assert.ok(codes({ schemaVersion: 2, name: "w", services: [] }).includes("PSO_SCHEMA_VERSION"));
  assert.ok(codes({ schemaVersion: 1, name: "w", services: [svc("a", 4000, [], "../escape")] }).includes("PSO_SERVICE_PATH"));
  assert.deepEqual(codes({ schemaVersion: 1, name: "w", services: [svc("a", 4000, ["b"]), svc("b", 4001)] }), []);
});

test("graph: cycles and dependency-first order", () => {
  assert.deepEqual(findCycles(new Map([["a", ["b"]], ["b", ["a"]]]))[0], ["a", "b", "a"]);
  assert.deepEqual(topoOrder(new Map([["app", ["db", "cache"]], ["db", []], ["cache", []]])), ["cache", "db", "app"]);
  assert.throws(() => topoOrder(new Map([["a", ["a"]]])));
});

test("lifecycle: dependency order, reverse stop, rollback on failure, recovery", async () => {
  const log: string[] = [];
  const mk = (id: string, dependsOn: string[] = [], failInit = false) => ({
    id, dependsOn,
    init() { if (failInit) throw new Error("boom"); log.push(`init:${id}`); },
    stop() { log.push(`stop:${id}`); },
  });
  const ok = new LifecycleManager();
  ok.register(mk("api", ["db"])); ok.register(mk("db"));
  await ok.start();
  assert.deepEqual(log, ["init:db", "init:api"]);
  await ok.stop();
  assert.deepEqual(log.slice(2), ["stop:api", "stop:db"]);
  assert.equal(ok.state("db").state, "STOPPED");

  log.length = 0;
  const bad = new LifecycleManager();
  bad.register(mk("db")); bad.register(mk("cache", ["db"], true)); bad.register(mk("api", ["db", "cache"]));
  await assert.rejects(bad.start(), /Start failed at "cache": boom/);
  assert.equal(bad.state("cache").state, "FAILED");
  assert.equal(bad.state("db").state, "STOPPED", "already-started dependency is rolled back");
  assert.notEqual(bad.state("api").state, "READY", "dependent never becomes READY");
  assert.throws(() => bad.retry("db"), /illegal transition/);
  bad.retry("cache");
  assert.equal(bad.state("cache").state, "REGISTERED");
});
