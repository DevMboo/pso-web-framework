import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const page = readFileSync(resolve(import.meta.dirname, "..", "docs", "reference", "diagnostics-catalog.md"), "utf8").replaceAll("\r\n", "\n");

/** Every mistake of "Validation errors, one by one" is made again here; the page must show the codes (and the Expected/Found lines) the CLI really prints. */
test("the diagnostics catalog shows exactly what pso validate prints for each mistake", { timeout: 120_000 }, async () => {
  const base = tmp("pso-diag-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--template", "empty")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--template", "empty", "--port", "8081")).code, 0);
  for (const a of [["make:module", "orders"], ["make:controller", "orders"]]) assert.equal((await pso(ws, ...a, "--service", "gateway")).code, 0);
  assert.equal((await pso(ws, "make:route", "orders", "list", "--method", "GET", "--path", "/", "--guard", "jwt", "--scopes", "orders:read", "--upstream", "catalog", "--service", "gateway")).code, 0);
  const baseline = await pso(ws, "validate");
  assert.equal(baseline.code, 0);

  const dir = join(ws, "gateway/src/modules/orders");
  const files = { mod: join(dir, "MODULE.pso.ts"), routes: join(dir, "routes", "ROUTES.pso.ts") };
  const orig = { mod: readFileSync(files.mod, "utf8"), routes: readFileSync(files.routes, "utf8") };
  const restore = () => { writeFileSync(files.mod, orig.mod); writeFileSync(files.routes, orig.routes); };
  const check = async (what: string, codes: string[], expectedLines: string[], edit: () => void) => {
    edit();
    const r = await pso(ws, "validate");
    restore();
    assert.notEqual(r.code, 0, `${what}: validate must fail`);
    const text = r.out + r.err;
    for (const c of codes) { assert.ok(text.includes(c), `${what}: the CLI prints ${c}`); assert.ok(page.includes(c), `${what}: the page documents ${c}`); }
    for (const l of expectedLines) { assert.ok(text.includes(l), `${what}: the CLI prints "${l}"`); assert.ok(page.includes(l), `${what}: the page shows "${l}"`); }
  };
  const set = (file: "mod" | "routes", from: string, to: string) => () => { assert.ok(orig[file].includes(from), `fixture contains ${from}`); writeFileSync(files[file], orig[file].replace(from, to)); };

  await check("module without its controller", ["PSO_MODULE_003", "PSO_ROUTE_001"], ["Found: controllers: []"], set("mod", "controllers: [OrdersController]", "controllers: []"));
  await check("unknown action", ["PSO_ROUTE_002"], ["Expected: method listAll() on OrdersController", "Found: actions: list"], set("routes", 'action: "list"', 'action: "listAll"'));
  await check("method mismatch", ["PSO_ROUTE_004"], ['Expected: @Post("/")', 'Found: @Get("/")'], set("routes", 'method: "GET"', 'method: "POST"'));
  await check("path mismatch", ["PSO_ROUTE_005"], ['Found: path "/order"'], set("routes", 'path: "/orders"', 'path: "/order"'));
  await check("unknown guard", ["PSO_ROUTE_008"], ["Found: available: jwt"], set("routes", 'guard: "jwt"', 'guard: "jwtt"'));
  await check("unknown service", ["PSO_ROUTE_010"], ["Expected: one of catalog", "Found: billing"], set("routes", 'service: "catalog"', 'service: "billing"'));
  await check("registry deleted", ["PSO_MODULE_002"], ["Controllers are never exposed without an explicit route registry."], () => rmSync(files.routes));

  // an empty registry is valid: decorators alone expose nothing
  writeFileSync(files.routes, 'import { defineRoutes } from "@pso/http";\nexport default defineRoutes({ routes: [] });\n');
  assert.equal((await pso(ws, "validate")).code, 0, "a decorated action with no route is valid and exposes nothing");
  restore();

  // workspace level
  const wsFile = join(ws, "pso.workspace.json");
  const wsOrig = readFileSync(wsFile, "utf8");
  const w = JSON.parse(wsOrig) as { services: Array<{ port: number }> };
  w.services[1]!.port = w.services[0]!.port;
  writeFileSync(wsFile, JSON.stringify(w, null, 2));
  const port = await pso(ws, "validate");
  writeFileSync(wsFile, wsOrig);
  assert.match(port.out + port.err, /PSO_PORT_CONFLICT/);
  assert.ok(page.includes("PSO_PORT_CONFLICT") && page.includes("both use port 3000"));

  const mis = join(ws, "catalog/src/main/java/com/pso/catalog/misc");
  mkdirSync(mis, { recursive: true });
  writeFileSync(join(mis, "OrderMapper.java"), "package com.pso.catalog.misc;\npublic class OrderMapper {}\n");
  const layout = await pso(ws, "validate");
  rmSync(mis, { recursive: true });
  assert.ok((layout.out + layout.err).includes('mapper "OrderMapper" must live in "application/mapper/" (under the application package) in the layered structure'));
  assert.ok(page.includes('mapper "OrderMapper" must live in "application/mapper/" (under the application package) in the layered structure'));

  // security
  const sec = await pso(ws, "security:validate");
  for (const l of ["PSO_SEC_MISSING: issuer is required (PSO_JWT_ISSUER)", "PSO_SEC_MISSING: audience is required (PSO_JWT_AUDIENCE)"]) { assert.ok((sec.out + sec.err).includes(l), l); assert.ok(page.includes(l), l); }
  const check2 = await pso(ws, "security:check");
  assert.ok((check2.out + check2.err).includes("SEC005") && page.includes("SEC005"));
});

/** The claim of "Why discovery never executes your code": validation parses files, it does not import them. */
test("pso validate parses a controller that would throw and write a file if it were executed, and does not run it", { timeout: 120_000 }, async () => {
  const base = tmp("pso-noexec-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--template", "empty")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--template", "empty", "--port", "8081")).code, 0);
  for (const a of [["make:module", "orders"], ["make:controller", "orders"]]) assert.equal((await pso(ws, ...a, "--service", "gateway")).code, 0);
  assert.equal((await pso(ws, "make:route", "orders", "list", "--method", "GET", "--path", "/", "--guard", "jwt", "--scopes", "orders:read", "--upstream", "catalog", "--service", "gateway")).code, 0);
  const controller = join(ws, "gateway/src/modules/orders/controllers/orders.controller.ts");
  const marker = join(base, "EXECUTED.marker");
  const original = readFileSync(controller, "utf8");
  writeFileSync(controller, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nthrow new Error("boom: this file must never be executed by validation");\n` + original);
  const r = await pso(ws, "validate");
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.out.includes("gateway: 4 resource(s)") && r.out.trim().endsWith("OK"));
  assert.equal(existsSync(marker), false, "validation must not execute the controller");
  assert.ok(page.includes("EXECUTED.marker") === false && readFileSync(resolve(import.meta.dirname, "..", "docs", "decisions", "why-no-code-execution-in-discovery.md"), "utf8").includes("throw new Error"));
});
