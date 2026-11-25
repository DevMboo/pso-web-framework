import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frontendContractPath, layoutMoves, projectPath, workspaceLayout } from "@pso/core";
import { pso, tmp } from "./helpers.ts";

/**
 * The mandatory workspace organization of 0.2.0: `pso create workspace` writes the standard directories (with `.infra/` holding only its
 * ignore rule), every generator puts its project in its directory, and the path is registered in pso.workspace.json. Flat 0.1
 * workspaces keep working unchanged and are never reorganized behind the developer's back.
 */
const ws = (root: string) => JSON.parse(readFileSync(join(root, "pso.workspace.json"), "utf8")) as { services: Array<{ name: string; path: string; role: string }>; frontends?: Array<{ name: string; path: string; kind: string }> };

test("create workspace: the standard directories exist at once, .infra/ holds only its ignore rule (no credential, certificate or state)", async () => {
  const base = tmp("pso-layout-");
  const r = await pso(base, "create", "workspace", "shop"); assert.equal(r.code, 0, r.err + r.out);
  const root = join(base, "shop");
  for (const d of [".infra", "orchestrators", "services", "frontends", "frontends/modules", "shared", "docs", "tests"]) assert.ok(existsSync(join(root, d)), d);
  for (const f of ["pso.workspace.json", "README.md", ".gitignore"]) assert.ok(existsSync(join(root, f)), f);
  assert.deepEqual(readdirSync(join(root, ".infra")), [".gitignore"], "nothing is provisioned before pso infra:init");
  assert.equal(readFileSync(join(root, ".infra", ".gitignore"), "utf8"), "*\n");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.infra\/$/m, ".infra/ is excluded from version control");
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /orchestrators\/[\s\S]*services\/[\s\S]*frontends\/[\s\S]*modules\//);
  // the infrastructure engine sees the ignore rules it would write itself (no "update" planned for them)
  const plan = await pso(root, "infra:plan", "--json");
  if (plan.code === 0) assert.doesNotMatch(plan.out, /"workspace:ignore"[^}]*"action":\s*"update"/, "ignore rules already in place");
});

test("generators place every project in its directory and register that path; several FEIs and MEIs; pso validate passes", async () => {
  const base = tmp("pso-layout-");
  await pso(base, "create", "workspace", "shop"); const root = join(base, "shop");
  for (const a of [["service", "catalog"], ["service", "orders", "--template", "empty"], ["orchestrator", "gateway"], ["fei", "shop"], ["fei", "admin"], ["mei", "customers", "--host", "shop", "--register"], ["mei", "products", "--host", "shop", "--register"], ["mei", "users", "--host", "admin", "--register"]]) {
    const r = await pso(root, "create", ...a); assert.equal(r.code, 0, `${a.join(" ")}: ${r.err}${r.out}`);
  }
  const c = ws(root);
  const paths = Object.fromEntries([...c.services, ...(c.frontends ?? [])].map((p) => [p.name, p.path]));
  assert.deepEqual(paths, { catalog: "services/catalog", orders: "services/orders", gateway: "orchestrators/gateway", "fei-shop": "frontends/fei-shop", "fei-admin": "frontends/fei-admin", "mei-customers": "frontends/modules/mei-customers", "mei-products": "frontends/modules/mei-products", "mei-users": "frontends/modules/mei-users" });
  for (const p of Object.values(paths)) assert.ok(existsSync(join(root, ...p.split("/"))), p);
  assert.ok(existsSync(join(root, "services", "catalog", "pom.xml")) && existsSync(join(root, "orchestrators", "gateway", "src", "main.ts")));
  assert.ok(existsSync(join(root, "frontends", "fei-shop", "FEI.pso.ts")) && existsSync(join(root, "frontends", "modules", "mei-users", "MEI.pso.ts")));
  assert.ok(!existsSync(join(root, "catalog")) && !existsSync(join(root, "frontend")), "nothing at the old places");
  // the internal structures are unchanged: modular orchestrator, layered Java service
  assert.ok(existsSync(join(root, "orchestrators", "gateway", "src", ".app")) && existsSync(join(root, "orchestrators", "gateway", "src", "modules")));
  assert.ok(existsSync(join(root, "services", "catalog", "src", "main", "java", "com", "pso", "catalog", "application", "rest")));
  // the shells register their microfrontends from their new places
  assert.match(readFileSync(join(root, "frontends", "fei-admin", "FEI.pso.ts"), "utf8"), /mei-users/);
  const v = await pso(root, "validate"); assert.equal(v.code, 0, v.err + v.out);
  const insp = JSON.parse((await pso(root, "structure:inspect", "--json")).out) as { layout: string; layoutMoves: unknown[] };
  assert.equal(insp.layout, "standard"); assert.deepEqual(insp.layoutMoves, []);
  assert.equal(frontendContractPath(c, root), "shared/contracts/orchestrator.contract.json");
});

test("a flat (0.1) workspace keeps its layout: new projects go where the existing ones are, nothing is moved, and the plan is only shown", async () => {
  const base = tmp("pso-layout-");
  // a workspace made by an earlier version: projects at the root, frontends under frontend/
  const root = join(base, "old"); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "old", services: [] }, null, 2));
  assert.equal(workspaceLayout(ws(root), root), "flat", "no standard directories: an older empty workspace stays flat");
  assert.equal((await pso(root, "create", "orchestrator", "gateway")).code, 0);
  assert.equal((await pso(root, "create", "service", "catalog")).code, 0);
  assert.equal((await pso(root, "create", "fei", "shop")).code, 0);
  assert.equal((await pso(root, "create", "mei", "customers", "--register")).code, 0);
  const c = ws(root);
  assert.deepEqual([...c.services, ...(c.frontends ?? [])].map((p) => p.path).sort(), ["catalog", "frontend/fei-shop", "frontend/mei-customers", "gateway"]);
  assert.equal(frontendContractPath(c, root), "frontend/contracts/orchestrator.contract.json");
  // the explicit flat layout is the same thing
  await pso(base, "create", "workspace", "flat", "--layout", "flat"); assert.ok(!existsSync(join(base, "flat", "services")) && !existsSync(join(base, "flat", ".infra")));
  // inspection proposes the moves and changes nothing
  const before = readFileSync(join(root, "pso.workspace.json"), "utf8");
  const insp = JSON.parse((await pso(root, "structure:inspect", "--json")).out) as { layout: string; layoutMoves: Array<{ from: string; to: string }> };
  assert.equal(insp.layout, "flat");
  assert.deepEqual(insp.layoutMoves.map((m) => `${m.from}->${m.to}`).sort(), ["catalog->services/catalog", "frontend/fei-shop->frontends/fei-shop", "frontend/mei-customers->frontends/modules/mei-customers", "gateway->orchestrators/gateway"]);
  assert.equal(readFileSync(join(root, "pso.workspace.json"), "utf8"), before); assert.ok(existsSync(join(root, "catalog", "pom.xml")));
  assert.equal((await pso(root, "validate")).code, 0);
  assert.notEqual((await pso(base, "create", "workspace", "x", "--layout", "nested")).code, 0, "unknown layouts are refused");
});

test("the layout rule: decided by declared paths, never mixed", () => {
  const svc = (name: string, path: string, role = "service") => ({ name, path, role, runtime: "spring-boot", port: 1 }) as never;
  assert.equal(workspaceLayout({ services: [] }), "standard");
  assert.equal(workspaceLayout({ services: [svc("a", "services/a"), svc("g", "orchestrators/g", "orchestrator")] }), "standard");
  assert.equal(workspaceLayout({ services: [svc("a", "a")] }), "flat");
  assert.equal(workspaceLayout({ services: [svc("a", "services/a")], frontends: [{ name: "mei-x", kind: "mei", path: "frontends/mei-x", port: 1 }] }), "flat", "a MEI must be in frontends/modules");
  assert.equal(projectPath({ services: [svc("a", "a")] }, "service", "b"), "b");
  assert.equal(projectPath({ services: [svc("a", "a")] }, "mei", "mei-b"), "frontend/mei-b");
  assert.equal(projectPath({ services: [] }, "mei", "mei-b"), "frontends/modules/mei-b");
  assert.deepEqual(layoutMoves({ services: [svc("a", "services/a")] }), []);
});
