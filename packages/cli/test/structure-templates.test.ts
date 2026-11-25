import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pso, tmp } from "./helpers.ts";

// The official structures are complete in every new project, with or without the reference CRUD.
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const ORCH = [".app/configs", ".app/contracts", ".app/filters", ".app/guards", ".app/middlewares", ".app/interceptors", ".app/decorators", "modules", "shared"];
const JAVA = ["application/rest", "application/service", "application/dto/request", "application/dto/response", "application/mapper",
  "infrastructure/persistence", "infrastructure/entity", "infrastructure/config", "infrastructure/security", "infrastructure/filter",
  "shared/exception", "shared/constant", "shared/validation"];
const allDirs = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? [n, ...allDirs(p)] : []; });

test("new orchestrators and services have the complete official structure, CRUD or empty; Java has no providers, modules or .app", { timeout: 120_000 }, async () => {
  const base = tmp("pso-structure-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop", "--layout", "flat")).code, 0);
  const ws = join(base, "shop");
  for (const a of [["service", "catalog"], ["service", "billing", "--template", "empty"], ["orchestrator", "gateway"]]) assert.equal((await pso(ws, "create", ...a)).code, 0, a.join(" "));
  for (const d of ORCH) assert.ok(existsSync(join(ws, "gateway", "src", ...d.split("/"))), `gateway/src/${d}`);
  for (const m of ["routes", "controllers", "services", "providers", "dto/request", "dto/response", "contracts", "mappers"]) assert.ok(existsSync(join(ws, "gateway", "src", "modules", "products", ...m.split("/"))), `products/${m}`);
  assert.ok(existsSync(join(ws, "gateway", "src", "modules", "products", "MODULE.pso.ts")));
  for (const svc of ["catalog", "billing"]) {
    const pkg = join(ws, svc, "src", "main", "java", "com", "pso", svc);
    for (const d of JAVA) assert.ok(existsSync(join(pkg, ...d.split("/"))), `${svc}: ${d}`);
    const found = allDirs(join(ws, svc, "src"));
    for (const bad of ["providers", "modules", ".app", "app"]) assert.ok(!found.includes(bad), `${svc} must not contain a ${bad} package`);
  }
  assert.equal((await pso(ws, "validate")).code, 0);
  // a JPA entity needs a database: refused with the command that adds one
  const ent = await pso(ws, "make:entity", "invoice", "--service", "billing");
  assert.equal(ent.code, 1);
  assert.match(ent.err, /pso database:enable postgresql --service billing/);
});
