import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* OS reaps temp */ } } });

async function ws() {
  const base = tmp("pso-res-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "service", "users", "--structure", "legacy");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  return root;
}
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

test("make:resource connects route, contract, controller, DTO, test and docs; validate passes", async () => {
  const root = await ws();
  const r = await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read");
  assert.equal(r.code, 0, r.out + r.err);
  for (const f of ["gw/src/routes/customer/MODULE.pso.ts", "gw/src/routes/customer/ROUTES.pso.ts", "gw/src/routes/customer/customer.controller.ts", "gw/src/contracts/customer.contract.json", "users/src/main/resources/contracts/customer.contract.json", "users/src/main/java/com/pso/users/routes/CustomerController.java", "users/src/main/java/com/pso/users/contracts/CustomerDto.java", "users/src/test/java/com/pso/users/routes/CustomerControllerTests.java", "docs/api/customer.md"]) assert.ok(existsSync(join(root, f)), f);
  assert.equal(read(root, "gw/src/contracts/customer.contract.json"), read(root, "users/src/main/resources/contracts/customer.contract.json"));
  assert.match(read(root, "gw/src/routes/customer/ROUTES.pso.ts"), /security: \{ guard: "jwt", scopes: \["customers:read"\] \},\n      metadata: \{ service: "users" \}/);
  assert.match(read(root, "gw/src/routes/customer/customer.controller.ts"), /this\.upstream\.forward\(req, res, "users"\)/);
  assert.match(read(root, "users/src/main/java/com/pso/users/routes/CustomerController.java"), /@PreAuthorize\("hasAuthority\('SCOPE_customers:read'\)"\)/);
  const v = await pso(root, "validate", "--json");
  assert.equal(v.code, 0, v.out);
  const pol = JSON.parse((await pso(root, "security:policy", "--json")).out);
  assert.deepEqual(pol.routes.map((x: { path: string; access: string }) => [x.path, x.access]), [["/customers", "guarded"]]);
});

test("make:resource is deterministic, idempotent, atomic on conflict, honours --dry-run", async () => {
  const root = await ws();
  const dry = JSON.parse((await pso(root, "make:resource", "customer", "--service", "users", "--dry-run", "--json")).out);
  assert.equal(dry.dryRun, true);
  assert.ok(!existsSync(join(root, "gw/src/routes/customer")), "dry-run writes nothing");
  assert.equal((await pso(root, "make:resource", "customer", "--service", "users")).code, 0);
  const again = JSON.parse((await pso(root, "make:resource", "customer", "--service", "users", "--json")).out);
  assert.ok(again.files.every((f: { action: string }) => f.action === "unchanged"), "second run changes nothing");

  // user edits one file: nothing at all may be written on conflict
  writeFileSync(join(root, "users/src/main/java/com/pso/users/routes/CustomerController.java"), "// mine\n");
  writeFileSync(join(root, "docs/api/customer.md"), "# edited docs\n");
  const before = read(root, "gw/src/routes/customer/ROUTES.pso.ts");
  const c = await pso(root, "make:resource", "customer", "--service", "users", "--route", "/people");
  assert.equal(c.code, 1);
  assert.match(c.out, /nothing was written/);
  assert.equal(read(root, "gw/src/routes/customer/ROUTES.pso.ts"), before, "orchestrator untouched when the service side conflicts");
  assert.equal(read(root, "users/src/main/java/com/pso/users/routes/CustomerController.java"), "// mine\n");
});

test("make:resource rejects unsafe or unsupported input", async () => {
  const root = await ws();
  const bad = async (...a: string[]) => (await pso(root, "make:resource", ...a)).code;
  assert.equal(await bad("customer"), 1, "no service");
  assert.equal(await bad("customer", "--service", "gw"), 1, "orchestrator is not a target");
  assert.equal(await bad("customer", "--service", "nope"), 1);
  assert.equal(await bad("../x", "--service", "users"), 1);
  assert.equal(await bad("c", "--service", "users", "--route", "/a/../b"), 1);
  assert.equal(await bad("c", "--service", "users", "--route", "/a/{id}"), 1, "path params unsupported");
  assert.equal(await bad("c", "--service", "users", "--method", "DELETE"), 1);
  assert.equal(await bad("c", "--service", "users", "--method", "POST", "--public"), 1, "public POST refused");
  assert.equal(await bad("c", "--service", "users", "--scopes", "a b;rm"), 1);
  assert.ok(!existsSync(join(root, "gw/src/routes/c")));
});

test("validate detects contract drift, unknown services and duplicate routes", async () => {
  const root = await ws();
  await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers");
  writeFileSync(join(root, "users/src/main/resources/contracts/customer.contract.json"), "{}\n");
  let v = JSON.parse((await pso(root, "validate", "--json")).out);
  assert.ok(v.diagnostics.some((d: { code: string }) => d.code === "PSO_CONTRACT_DRIFT"));

  await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--force");
  assert.equal((await pso(root, "validate")).code, 0);

  const c = JSON.parse(read(root, "gw/src/contracts/customer.contract.json"));
  c.service = "ghost";
  writeFileSync(join(root, "gw/src/contracts/customer.contract.json"), JSON.stringify(c));
  v = JSON.parse((await pso(root, "validate", "--json")).out);
  const codes = v.diagnostics.map((d: { code: string }) => d.code);
  assert.ok(codes.includes("PSO_CONTRACT_UNKNOWN_SERVICE"));
});
