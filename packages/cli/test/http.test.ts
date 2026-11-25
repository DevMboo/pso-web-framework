import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportSPKI, generateKeyPair } from "jose";
import { pso, tmp, prepare, startNode, randomPort, unusedPort } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

import { fileURLToPath } from "node:url";
const EX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "docs", "examples", "users");
/** The documented example module: the same files the documentation shows, compiled and run by these tests. */
const ex = (rel: string) => readFileSync(join(EX, rel), "utf8");
const CONTROLLER = ex("controllers/users.controller.ts"), SERVICE = ex("services/users.service.ts"), DTO = ex("dto/request/create-user.dto.ts"), GUARD = ex("guards/users-key.guard.ts"), MODULE = ex("MODULE.pso.ts"), ROUTES = ex("routes/ROUTES.pso.ts");

interface Fx { root: string; gw: string; mod: string; write(rel: string, text: string): void; edit(rel: string, from: string | RegExp, to: string): void; codes(): Promise<string[]>; validate(): Promise<{ code: number; diagnostics: Array<{ code: string; message: string }> }> }

async function fixture(withUsers = true): Promise<Fx> {
  const base = tmp("pso-http-"); dirs.push(base);
  await pso(base, "create", "workspace", "w");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--template", "empty");
  const gw = join(root, "gw");
  const mod = join(gw, "src/modules/users");
  const write = (rel: string, text: string) => { mkdirSync(join(gw, rel, ".."), { recursive: true }); writeFileSync(join(gw, rel), text); };
  if (withUsers) {
    write("src/modules/users/MODULE.pso.ts", MODULE); write("src/modules/users/routes/ROUTES.pso.ts", ROUTES); write("src/modules/users/controllers/users.controller.ts", CONTROLLER);
    write("src/modules/users/services/users.service.ts", SERVICE); write("src/modules/users/dto/request/create-user.dto.ts", DTO); write("src/modules/users/guards/users-key.guard.ts", GUARD);
  }
  const validate = async () => { const r = await pso(root, "validate", "--json"); return { code: r.code, diagnostics: (JSON.parse(r.out).diagnostics as Array<{ code: string; message: string; severity: string }>).filter((d) => d.severity === "error") }; };
  return {
    root, gw, mod, write, validate,
    edit(rel, from, to) { const p = join(gw, rel); const t = readFileSync(p, "utf8"); const n = t.replace(from, to); assert.notEqual(n, t, `edit had no effect: ${rel}`); writeFileSync(p, n); },
    codes: async () => (await validate()).diagnostics.map((d) => d.code),
  };
}

test("a properly declared module validates and routes:list shows exactly the declared routes", async () => {
  const f = await fixture();
  const v = await f.validate();
  assert.equal(v.code, 0, JSON.stringify(v.diagnostics));
  const rows = JSON.parse((await pso(f.root, "routes:list", "--json")).out).routes as Array<{ method: string; path: string; access: string }>;
  assert.deepEqual(rows.map((r) => `${r.method} ${r.path} ${r.access}`), ["GET /users public", "POST /users guard:users-key", "GET /users/:id guard:users-key"]);
  assert.ok(!rows.some((r) => r.method === "DELETE"), "the decorated but undeclared remove() is not listed");
});

test("RUNTIME: only declared routes exist; decorated-but-undeclared, undeclared controllers and unknown paths are inaccessible; guards still apply", { timeout: 180_000 }, async () => {
  const f = await fixture();
  const marker = join(f.gw, "executed.marker");
  // an undeclared controller whose module-level code would leave a trace if it were ever loaded
  f.write("src/modules/users/controllers/ghost.controller.ts", `import { Controller, RestController, Get } from "@pso/http";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\n@Controller()\n@RestController("/ghost")\nexport class GhostController { @Get("/") async hi() { return "boo"; } }\n`);
  prepare(f.gw);
  const port = randomPort();
  const { child, logs } = await startNode(f.gw, { PORT: String(port) });
  try {
    const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const r1 = await call("GET", "/users");
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), [{ id: "1", name: "ada" }]);
    assert.equal((await call("GET", "/users/42")).status, 401, "declared but guarded");
    const r2 = await call("GET", "/users/42", { "x-key": "k" });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { id: "42" });
    const r3 = await call("POST", "/users", { "x-key": "k", "content-type": "application/json" }, JSON.stringify({ name: "grace", email: "grace@example.com" }));
    assert.equal(r3.status, 201);
    assert.deepEqual(await r3.json(), { id: "2", name: "grace", email: "grace@example.com" });
    // native DTO validation: the action never runs for invalid input, and the answer is an RFC 9457 problem with field errors (no values echoed)
    const bad = await call("POST", "/users", { "x-key": "k", "content-type": "application/json", "x-correlation-id": "corr-validation-1" }, JSON.stringify({ name: "gr", email: "secret-not-an-email", age: 17, admin: true }));
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type") ?? "", /application\/problem\+json/);
    const prob = await bad.json() as { code: string; correlationId: string; errors: Array<{ field: string; message: string }> };
    assert.equal(prob.code, "PSO_VALIDATION_FAILED"); assert.equal(prob.correlationId, "corr-validation-1");
    assert.deepEqual(prob.errors.map((e) => e.field).sort(), ["admin", "age", "email", "name"]);
    assert.ok(!JSON.stringify(prob).includes("secret-not-an-email"), "submitted values are never echoed");
    assert.equal((await (await call("POST", "/users", { "x-key": "k", "content-type": "application/json" }, JSON.stringify({ name: 7, email: "a@b.co" }))).json() as { errors: unknown[] }).errors.length, 1);
    assert.equal((await call("POST", "/users", { "x-key": "k", "content-type": "application/json" }, JSON.stringify([1]))).status, 400, "a JSON array is not a DTO");
    assert.equal((await call("POST", "/users", { "x-key": "k" })).status, 400, "an empty body is not a valid DTO");
    assert.equal((await call("POST", "/users", { "x-key": "k", "content-type": "text/plain" }, "x")).status, 415);
    assert.equal((await call("POST", "/users", { "x-key": "k", "content-type": "application/json" }, "{bad")).status, 400);
    assert.equal((await call("POST", "/users")).status, 401, "POST is guarded");

    assert.equal((await call("DELETE", "/users/42", { "x-key": "k" })).status, 404, "decorated @Delete that is absent from ROUTES.pso.ts is NOT an endpoint");
    assert.equal((await call("GET", "/ghost")).status, 404, "controller outside MODULE.pso.ts is not registered");
    assert.ok(!existsSync(marker), "an undeclared controller is never even loaded");
    assert.match(logs(), /controller file ignored/);
    assert.equal((await call("GET", "/health/ready")).status, 200, "framework health module is declared and validated like any other");
  } finally { child.kill("SIGKILL"); }
});

test("RUNTIME: an inconsistent registry stops start-up and activates nothing", { timeout: 180_000 }, async () => {
  const f = await fixture();
  f.edit("src/modules/users/controllers/users.controller.ts", '@Get("/:id")', '@Post("/:id")');
  prepare(f.gw);
  const port = randomPort();
  await assert.rejects(startNode(f.gw, { PORT: String(port) }), (e: Error) => /PSO_ROUTE_004/.test(e.message) && /startup failed/.test(e.message));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1000) }), "nothing is listening: not even health");
});

test("PSO_ROUTE_004: method mismatch uses the documented diagnostic format", async () => {
  const f = await fixture();
  f.edit("src/modules/users/controllers/users.controller.ts", '@Get("/:id")', '@Post("/:id")');
  const v = await f.validate();
  assert.equal(v.code, 1);
  const d = v.diagnostics.find((x) => x.code === "PSO_ROUTE_004")!;
  assert.equal(d.message, ["Route declaration mismatch.", "", "Module: users", "Route: GET /users/:id", "Controller: UsersController", "Action: findById", "", 'Expected: @Get("/:id")', 'Found: @Post("/:id")', "", "Route activation denied."].join("\n"));
});

test("PSO_ROUTE_005: path mismatch; PSO_ROUTE_002: missing action; PSO_ROUTE_003: undecorated action", async () => {
  const f = await fixture();
  f.edit("src/modules/users/routes/ROUTES.pso.ts", 'path: "/users/:id"', 'path: "/users/:userId/profile"');
  assert.ok((await f.codes()).includes("PSO_ROUTE_005"));
  f.edit("src/modules/users/routes/ROUTES.pso.ts", 'path: "/users/:userId/profile"', 'path: "/users/:id"');
  f.edit("src/modules/users/routes/ROUTES.pso.ts", 'action: "findById"', 'action: "doesNotExist"');
  assert.ok((await f.codes()).includes("PSO_ROUTE_002"));
  f.edit("src/modules/users/routes/ROUTES.pso.ts", 'action: "doesNotExist"', 'action: "findById"');
  f.edit("src/modules/users/controllers/users.controller.ts", '  @Get("/:id")\n', "");
  assert.ok((await f.codes()).includes("PSO_ROUTE_003"));
});

test("PSO_ROUTE_001: a declared route whose controller is not in the module (or does not exist) fails", async () => {
  const f = await fixture();
  f.edit("src/modules/users/MODULE.pso.ts", "controllers: [UsersController]", "controllers: []");
  const c = await f.codes();
  assert.ok(c.includes("PSO_ROUTE_001"), c.join());
  assert.ok(c.includes("PSO_MODULE_003"), "and the controller itself is rejected as undeclared");
});

test("PSO_ROUTE_006: duplicate and conflicting declarations across modules (param names do not hide a conflict)", async () => {
  const f = await fixture();
  f.write("src/modules/other/MODULE.pso.ts", `import { defineModule } from "@pso/core";
import { OtherController } from "./controllers/other.controller";
import otherRoutes from "./routes/ROUTES.pso";
export default defineModule({ name: "other", controllers: [OtherController], providers: [], routes: otherRoutes, imports: [], exports: [] });
`);
  f.write("src/modules/other/services/other.service.ts", `export class OtherService {}\n`);
  f.write("src/modules/other/controllers/other.controller.ts", `import { Controller, RestController, Get } from "@pso/http";\n@Controller()\n@RestController("/users")\nexport class OtherController {\n  @Get("/:userId")\n  async one() { return {}; }\n}\n`);
  f.write("src/modules/other/routes/ROUTES.pso.ts", `import { defineRoutes } from "@pso/http";\nimport { OtherController } from "../controllers/other.controller";\nexport default defineRoutes({ routes: [{ method: "GET", path: "/users/:userId", controller: OtherController, action: "one", security: { public: true } }] });\n`);
  const v = await f.validate();
  assert.ok(v.diagnostics.some((d) => d.code === "PSO_ROUTE_006"), JSON.stringify(v.diagnostics.map((d) => d.code)));
});

test("PSO_MODULE_001 / 002: missing MODULE.pso.ts or ROUTES.pso.ts fails, with no fallback discovery", async () => {
  const f = await fixture();
  rmSync(join(f.mod, "routes", "ROUTES.pso.ts"));
  const c1 = await f.codes();
  assert.ok(c1.includes("PSO_MODULE_002"), c1.join());
  writeFileSync(join(f.mod, "routes", "ROUTES.pso.ts"), ROUTES);
  rmSync(join(f.mod, "MODULE.pso.ts"));
  const c2 = await f.codes();
  assert.ok(c2.includes("PSO_MODULE_001"), c2.join());
  const listed = await pso(f.root, "routes:list", "--json");
  assert.equal(listed.code, 1, "routes:list fails on an invalid registry");
  assert.ok(JSON.parse(listed.out).routes.every((r: { active: boolean }) => r.active === false), "declared routes are shown as NOT active");
});

test("PSO_MODULE_003: a controller outside the module declaration is rejected statically and never registered", async () => {
  const f = await fixture();
  f.write("src/modules/users/controllers/audit.controller.ts", `import { Controller, RestController, Get } from "@pso/http";\n@Controller()\n@RestController("/audit")\nexport class AuditController { @Get("/") async list() { return []; } }\n`);
  const v = await f.validate();
  assert.ok(v.diagnostics.some((d) => d.code === "PSO_MODULE_003" && /AuditController/.test(d.message)));
});

test("security policy: deny by default, a declaration never weakens a guard, unknown guards are rejected", async () => {
  const f = await fixture();
  f.edit("src/modules/users/routes/ROUTES.pso.ts", 'security: { guard: "users-key" } },\n    { method: "POST"', 'security: {} },\n    { method: "POST"');
  assert.ok((await f.codes()).includes("PSO_ROUTE_007"), "no policy at all is denied");
  f.edit("src/modules/users/routes/ROUTES.pso.ts", 'security: {} }', 'security: { guard: "users-key" } }');
  f.edit("src/modules/users/controllers/users.controller.ts", '  @Get("/")\n', '  @Get("/")\n  @UseGuards("users-key")\n');
  f.edit("src/modules/users/controllers/users.controller.ts", "Param, Body }", "Param, Body, UseGuards }");
  assert.ok((await f.codes()).includes("PSO_ROUTE_007"), "route says public but the action demands a guard: conflict, never weakened");
  f.edit("src/modules/users/controllers/users.controller.ts", '  @UseGuards("users-key")\n', "");
  f.edit("src/modules/users/routes/ROUTES.pso.ts", 'guard: "users-key" } }\n  ]', 'guard: "nope" } }\n  ]');
  assert.ok((await f.codes()).includes("PSO_ROUTE_008"), "unknown guard");
});

test("DI: unresolvable constructor dependencies and provider cycles fail validation", async () => {
  const f = await fixture();
  f.edit("src/modules/users/MODULE.pso.ts", "providers: [UsersService]", "providers: []");
  assert.ok((await f.codes()).includes("PSO_MODULE_006"));
  f.edit("src/modules/users/MODULE.pso.ts", "providers: []", "providers: [UsersService, AService, BService]");
  f.edit("src/modules/users/MODULE.pso.ts", 'import usersRoutes', 'import { AService } from "./services/a.service";\nimport { BService } from "./services/b.service";\nimport usersRoutes');
  f.write("src/modules/users/services/a.service.ts", `import { Injectable } from "@pso/http";\nimport { BService } from "./b.service";\n@Injectable()\nexport class AService { constructor(private readonly b: BService) {} }\n`);
  f.write("src/modules/users/services/b.service.ts", `import { Injectable } from "@pso/http";\nimport { AService } from "./a.service";\n@Injectable()\nexport class BService { constructor(private readonly a: AService) {} }\n`);
  assert.ok((await f.codes()).includes("PSO_MODULE_007"));
});

test("static discovery and validation never execute application code", async () => {
  const f = await fixture();
  const marker = join(f.gw, "static.marker");
  for (const rel of ["src/modules/users/controllers/users.controller.ts", "src/modules/users/routes/ROUTES.pso.ts", "src/modules/users/MODULE.pso.ts", "src/modules/users/services/users.service.ts"]) {
    const t = readFileSync(join(f.gw, rel), "utf8");
    writeFileSync(join(f.gw, rel), `require("fs").writeFileSync(${JSON.stringify(marker)}, "executed");\nthrow new Error("must not run");\n` + t);
  }
  for (const cmd of [["validate"], ["routes:list"], ["inspect", "--service", "gw"], ["security:check"], ["security:policy"], ["graph"]]) await pso(f.root, ...cmd);
  assert.ok(!existsSync(marker), "files were parsed, never imported or run");
});

test("generators keep MODULE, ROUTES and controller consistent, preserve user code, and refuse duplicates", async () => {
  const f = await fixture(false);
  assert.equal((await pso(f.root, "make:module", "orders", "--service", "gw")).code, 0);
  assert.ok(existsSync(join(f.gw, "src/modules/orders/MODULE.pso.ts")) && existsSync(join(f.gw, "src/modules/orders/routes/ROUTES.pso.ts")));
  assert.equal((await pso(f.root, "make:module", "orders", "--service", "gw")).code, 1, "no overwrite");
  assert.equal((await pso(f.root, "make:module", "health", "--service", "gw")).code, 1, "health is reserved");
  assert.equal((await pso(f.root, "make:controller", "orders", "--service", "gw")).code, 0);
  assert.equal((await pso(f.root, "make:service", "orders", "--service", "gw", "--export")).code, 0);
  assert.equal((await pso(f.root, "make:dto", "orders", "create-order", "--service", "gw")).code, 0);

  const ctl = join(f.gw, "src/modules/orders/controllers/orders.controller.ts");
  writeFileSync(ctl, readFileSync(ctl, "utf8").replace("export class", "// my own comment, must survive\nexport class"));

  assert.equal((await pso(f.root, "make:route", "orders", "findAll", "--method", "GET", "--path", "/", "--public", "--service", "gw")).code, 0);
  assert.equal((await pso(f.root, "make:route", "orders", "findById", "--method", "GET", "--path", "/:id", "--guard", "jwt", "--scopes", "orders:read", "--service", "gw")).code, 0);
  assert.equal((await pso(f.root, "make:route", "orders", "create", "--method", "POST", "--path", "/", "--service", "gw")).code, 0);

  const text = readFileSync(ctl, "utf8");
  assert.match(text, /\/\/ my own comment, must survive/);
  assert.match(text, /@Get\("\/:id"\)\n  async findById\(@Param\("id"\) id: string\)/);
  assert.match(text, /@Post\("\/"\)\n  async create\(@Body\(\) body: unknown\)/);
  const routes = readFileSync(join(f.gw, "src/modules/orders/routes/ROUTES.pso.ts"), "utf8");
  assert.match(routes, /path: "\/orders\/:id"/);
  assert.match(routes, /security: \{ guard: "jwt", scopes: \["orders:read"\] \}/);
  const mod = readFileSync(join(f.gw, "src/modules/orders/MODULE.pso.ts"), "utf8");
  assert.match(mod, /controllers: \[OrdersController\]/);
  assert.match(mod, /providers: \[OrdersService\]/);
  assert.match(mod, /exports: \[OrdersService\]/);
  const v = await f.validate();
  assert.equal(v.code, 0, JSON.stringify(v.diagnostics));

  // running a generator again changes nothing and never overwrites
  const before = readFileSync(ctl, "utf8");
  assert.equal((await pso(f.root, "make:route", "orders", "findAll", "--method", "GET", "--path", "/", "--public", "--service", "gw")).code, 1, "action already exists");
  assert.equal((await pso(f.root, "make:route", "orders", "other", "--method", "GET", "--path", "/", "--public", "--service", "gw")).code, 1, "duplicate GET /orders");
  assert.equal(readFileSync(ctl, "utf8"), before);
  assert.equal((await pso(f.root, "make:route", "orders", "x", "--method", "POST", "--path", "/y", "--public", "--service", "gw")).code, 1, "public POST refused");
  assert.equal((await pso(f.root, "make:route", "nomodule", "x", "--service", "gw")).code, 1);
  assert.equal((await pso(f.root, "make:route", "orders", "bad name", "--service", "gw")).code, 1);
  assert.equal((await pso(f.root, "make:route", "orders", "evil", "--path", "/../x", "--service", "gw")).code, 1);

  // an unknown guard would make the registry invalid: the generator rolls everything back
  const snapshot = { ctl: readFileSync(ctl, "utf8"), routes: readFileSync(join(f.gw, "src/modules/orders/routes/ROUTES.pso.ts"), "utf8") };
  const bad = await pso(f.root, "make:route", "orders", "audit", "--method", "GET", "--path", "/audit", "--guard", "ghost", "--service", "gw");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /rolled back/);
  assert.equal(readFileSync(ctl, "utf8"), snapshot.ctl);
  assert.equal(readFileSync(join(f.gw, "src/modules/orders/routes/ROUTES.pso.ts"), "utf8"), snapshot.routes);

  const dry = await pso(f.root, "make:route", "orders", "list2", "--method", "GET", "--path", "/list", "--public", "--dry-run", "--json", "--service", "gw");
  assert.equal(dry.code, 0);
  assert.equal(readFileSync(ctl, "utf8"), snapshot.ctl, "dry-run writes nothing");
});

test("generated orchestrator compiles and make:route --upstream forwards through the Upstream provider", { timeout: 240_000 }, async () => {
  const f = await fixture(false);
  await pso(f.root, "create", "service", "users", "--structure", "legacy", "--port", String(await unusedPort()));
  assert.equal((await pso(f.root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read")).code, 0);
  assert.equal((await pso(f.root, "make:route", "customer", "ping", "--method", "GET", "--path", "/ping", "--public", "--upstream", "users", "--service", "gw")).code, 0);
  assert.equal((await f.validate()).code, 0);
  prepare(f.gw); // real tsc: decorators, metadata, imports all compile
  const port = randomPort();
  const pub = join(f.root, "test-public.pem");
  writeFileSync(pub, await exportSPKI((await generateKeyPair("ES256", { extractable: true })).publicKey));
  const { child } = await startNode(f.gw, { PORT: String(port), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256" });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/customers`)).status, 401, "guarded and no token presented -> 401");
    assert.equal((await fetch(`http://127.0.0.1:${port}/customers/ping`)).status, 503, "declared and public, but the upstream service is not running -> 503 service unavailable, never 404");
  } finally { child.kill("SIGKILL"); }
});
