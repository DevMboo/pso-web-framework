#!/usr/bin/env node
// Real execution validation of the official structures and the reference CRUD, with the DISTRIBUTED CLI (installed from the release
// tarballs into an empty directory; every workspace action is a `pso` command). Docker, Keycloak, PostgreSQL, real HTTP through the edge.
//   node scripts/reference/validate-crud.mjs <dir-with-tarballs> [--keep]
// Also measures the developer experience (commands, manual edits, times) and writes docs/implementation/evidence/v020/crud-validation.json.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const dist = resolve(process.argv[2] ?? join(repo, "release-out", "0.2.0-rc.2", "npm"));
const keep = process.argv.includes("--keep");
const outFile = join(repo, "docs", "implementation", "evidence", "v020", "crud-validation.json");
const { plan, netRequest, developmentUserToken, environmentCa, localResolution } = await import(new URL("../../packages/infra/dist/index.js", import.meta.url).href);
const base = mkdtempSync(join(tmpdir(), "pso-crud-"));
const results = [], timings = {}, transcript = [];
let commands = 0;
const now = () => performance.now();
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, " ").slice(0, 170)})` : ""}`); };
const sh = (cmd, args, cwd, o = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32" && /^npm/.test(cmd), timeout: 2_400_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PSO_NO_BROWSER: "1", ...(o.env ?? {}) } });

// ---------------------------------------------------------------- the distributed CLI
const inst = join(base, "cli"); mkdirSync(inst);
writeFileSync(join(inst, "package.json"), JSON.stringify({ name: "crud-validation", private: true }));
const tgz = readdirSync(dist).filter((f) => f.endsWith(".tgz")).map((f) => `"${join(dist, f)}"`);
let t0 = now();
const ir = sh("npm", ["install", "--no-audit", "--no-fund", ...tgz], inst);
check("the CLI installs from the release tarballs", ir.status === 0, (ir.stdout + ir.stderr).slice(-200));
timings.installCliMs = Math.round(now() - t0);
const PSO = join(inst, "node_modules", "@pso", "cli", "bin", "pso.js");
const pso = (cwd, ...a) => { commands++; const s = now(); const r = sh(process.execPath, [PSO, ...a], cwd); const ms = Math.round(now() - s); transcript.push({ command: `pso ${a.join(" ")}`, exit: r.status, ms }); console.log(`[${(ms / 1000).toFixed(1).padStart(6)} s] pso ${a.join(" ")}${r.status ? `  -> exit ${r.status}` : ""}`); if (r.status !== 0) console.log((r.stdout + r.stderr).slice(-1500)); return { code: r.status, out: r.stdout + r.stderr, ms }; };
const must = (cwd, ...a) => { const r = pso(cwd, ...a); if (r.code !== 0) throw new Error(`pso ${a.join(" ")} failed`); return r; };

const ws = join(base, "refcrud");
const PROJECT = "refcrud";
let studio;
try {
  // ---------------------------------------------------------------- generation
  must(base, "create", "workspace", PROJECT);
  timings.createServiceMs = must(ws, "create", "service", "catalog", "--port", "18581").ms;
  timings.createOrchestratorMs = must(ws, "create", "orchestrator", "gateway", "--port", "13500").ms;
  must(ws, "infra:init", "--identity", "keycloak", "--runtime", "docker", "--users", "ana,bob:products:read");
  const v = pso(ws, "validate");
  check("pso validate accepts the generated workspace", v.code === 0, v.out.split("\n").slice(-3).join(" | "));
  const inspect = pso(ws, "structure:inspect");
  check("structure:inspect: modular orchestrator, layered service", /gateway \(node\): modular/.test(inspect.out) && /catalog \(spring-boot\): layered/.test(inspect.out), inspect.out.slice(0, 200));

  // ---------------------------------------------------------------- structural checks
  const C = join(ws, "catalog", "src", "main", "java", "com", "pso", "catalog"), G = join(ws, "gateway", "src");
  const has = (...p) => existsSync(join(...p));
  check("Java packages: application/{rest,service,dto/request,dto/response,mapper}, infrastructure/{entity,persistence}, shared/{exception,validation}",
    ["application/rest/ProductController.java", "application/service/ProductService.java", "application/dto/request/CreateProductRequest.java", "application/dto/response/ProductResponse.java", "application/mapper/ProductMapper.java", "infrastructure/entity/ProductEntity.java", "infrastructure/persistence/ProductRepository.java", "shared/exception/ConflictException.java", "shared/validation/PageRequests.java"].every((f) => has(C, ...f.split("/"))));
  check("no providers, modules or .app package in the Java service", !has(C, "providers") && !has(C, "modules") && !has(C, ".app") && !has(C, "app"));
  check("orchestrator: src/.app and src/modules/products with routes/, controllers/, services/, providers/, contracts/, dto/, mappers/",
    ["/.app/guards/jwt.guard.ts", "/modules/products/MODULE.pso.ts", "/modules/products/routes/ROUTES.pso.ts", "/modules/products/controllers/product.controller.ts", "/modules/products/services/product.service.ts", "/modules/products/providers/product.provider.ts", "/modules/products/contracts/product.contract.ts", "/modules/products/dto/request/create-product.dto.ts", "/modules/products/dto/response/product.dto.ts", "/modules/products/mappers/product.mapper.ts"].every((f) => has(G + f)));
  check("package declarations follow the directories", readFileSync(join(C, "application", "rest", "ProductController.java"), "utf8").startsWith("package com.pso.catalog.application.rest;") && readFileSync(join(C, "infrastructure", "entity", "ProductEntity.java"), "utf8").startsWith("package com.pso.catalog.infrastructure.entity;"));
  check("the orchestrator module is bound to catalog", /PRODUCT_SERVICE = "catalog"/.test(readFileSync(join(G, "modules", "products", "contracts", "product.contract.ts"), "utf8")));
  check("PostgreSQL is declared for the CRUD service (provisioned by the infrastructure engine)", JSON.parse(readFileSync(join(ws, "pso.workspace.json"), "utf8")).services.find((s) => s.name === "catalog")?.db === "postgres");

  // ---------------------------------------------------------------- generated tests of both projects
  const npmI = sh("npm", ["install", "--no-audit", "--no-fund"], join(ws, "gateway"));
  check("orchestrator dependencies install", npmI.status === 0, npmI.stderr.slice(-200));
  const ot = sh("npm", ["test"], join(ws, "gateway"));
  // node --test prints "# pass N" (TAP) or "ℹ pass N" (spec reporter, the default when the output is not a terminal on Node 24)
  check("orchestrator: tsc build of src (with .app) and its generated tests pass", ot.status === 0 && /(#|ℹ) pass [1-9]\d*/.test(ot.stdout) && /(#|ℹ) fail 0/.test(ot.stdout), (ot.stdout.match(/(#|ℹ) (pass|fail) \d+/g) ?? []).join(" ") + ot.stderr.slice(-200));
  check("the build contains the compiled .app components", existsSync(join(ws, "gateway", "dist", ".app", "guards", "jwt.guard.js")) || existsSync(join(ws, "gateway", ".test-dist", "src", ".app", "guards", "jwt.guard.js")));
  const mvnw = join(ws, "catalog", process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  t0 = now();
  const mt = spawnSync(mvnw, ["-B", "-ntp", "-o", "test"], { cwd: join(ws, "catalog"), encoding: "utf8", shell: process.platform === "win32", timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
  const summary = (mt.stdout.match(/Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+\s*$/m) ?? [""])[0];
  check("catalog: the generated Spring tests pass (embedded PostgreSQL, Flyway, JWT, HTTP)", mt.status === 0, summary || (mt.stdout + mt.stderr).slice(-400));
  timings.springTestsMs = Math.round(now() - t0);

  // ---------------------------------------------------------------- Docker: the whole stack
  t0 = now();
  const up = pso(ws, "docker:up", "--env", "local", "--vendor", "--timeout", "900");
  check("docker:up: catalog, its PostgreSQL, Keycloak, the orchestrator and the edge are healthy", up.code === 0 && /ready:/.test(up.out), up.out.split("\n").slice(-3).join(" | "));
  timings.firstStartMs = Math.round(now() - t0);
  const probe = pso(ws, "infra:validate", "--probe");
  check("infra:validate --probe through the edge", probe.code === 0, probe.out.split("\n").slice(-2).join(" | "));

  const p = plan(ws, "local");
  const t = p.topology, ca = environmentCa(ws, t), map = localResolution(t), api = t.api.origin;
  const call = async (method, path, o = {}) => {
    const s = now();
    const body = o.json !== undefined ? JSON.stringify(o.json) : o.raw;
    const r = await netRequest({ url: `${api}${path}`, method, ca, resolve: map, timeoutMs: 30_000, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}), ...(o.headers ?? {}) }, ...(body !== undefined ? { body } : {}) });
    const text = r.body.toString("utf8");
    let j; try { j = text ? JSON.parse(text) : undefined; } catch { j = undefined; }
    return { status: r.status, headers: r.headers, json: j, text, ms: Math.round(now() - s) };
  };
  const ana = (await developmentUserToken(ws, t, "ana")).accessToken, bob = (await developmentUserToken(ws, t, "bob")).accessToken;
  const scp = (tok) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).scp ?? [];
  check("Keycloak tokens: ana has products:read+write, bob only products:read", scp(ana).includes("products:write") && scp(ana).includes("products:read") && scp(bob).includes("products:read") && !scp(bob).includes("products:write"), `ana=${scp(ana).join(",")} bob=${scp(bob).join(",")}`);

  const evidence = {};
  const product = (sku, extra = {}) => ({ sku, name: `Keyboard ${sku}`, description: "Mechanical, 87 keys", price: "49.90", active: true, ...extra });
  let r = await call("GET", "/products/options");
  check("public route: GET /products/options answers without a token (orchestrator only)", r.status === 200 && Array.isArray(r.json?.sort), r.text.slice(0, 120));
  evidence.options = r.json;
  r = await call("GET", "/products");
  check("protected route without a token: 401 problem", r.status === 401 && /problem\+json/.test(r.headers["content-type"] ?? "") && r.json?.code === "PSO_AUTH_UNAUTHORIZED", r.text.slice(0, 160));
  evidence.unauthorized = r.json;
  t0 = now();
  r = await call("POST", "/products", { token: ana, json: product("KB-100"), headers: { "x-correlation-id": "crud-validation-0001" } });
  timings.firstCrudRequestMs = Math.round(now() - t0);
  const created = r.json;
  check("create: 201, Location, price as an exact decimal string, UTC timestamps", r.status === 201 && r.headers["location"] === `/products/${created?.id}` && created?.price === "49.90" && /Z$/.test(created?.createdAt ?? ""), `${r.status} ${r.headers["location"]} ${r.text.slice(0, 160)}`);
  check("the correlation id travels back to the caller", r.headers["x-correlation-id"] === "crud-validation-0001", r.headers["x-correlation-id"]);
  evidence.create = { status: r.status, location: r.headers["location"], body: created };
  r = await call("GET", `/products/${created.id}`, { token: bob });
  check("read with products:read (bob): 200", r.status === 200 && r.json?.sku === "KB-100");
  for (const sku of ["KB-101", "KB-102", "MS-200"]) await call("POST", "/products", { token: ana, json: product(sku, sku === "MS-200" ? { name: "Mouse", active: false } : {}) });
  r = await call("GET", "/products?page=0&size=2&sort=sku,asc", { token: ana });
  check("pagination + sorting: page 0 of size 2, sorted by sku, totalItems 4, totalPages 2", r.status === 200 && r.json?.items?.length === 2 && r.json.items[0].sku === "KB-100" && r.json.totalItems === 4 && r.json.totalPages === 2, r.text.slice(0, 200));
  evidence.page = r.json;
  r = await call("GET", "/products?name=keyboard&active=true", { token: ana });
  check("filtering in the database: name contains 'keyboard' (case-insensitive) and active", r.status === 200 && r.json?.totalItems === 3, r.text.slice(0, 160));
  r = await call("GET", "/products?sku=MS-200", { token: ana });
  check("filtering by sku (exact)", r.status === 200 && r.json?.totalItems === 1 && r.json.items[0].name === "Mouse");
  r = await call("GET", "/products?sort=version", { token: ana });
  check("sorting by a field that is not allowed: 400 (refused by the orchestrator)", r.status === 400 && r.json?.code === "PSO_VALIDATION_FAILED", r.text.slice(0, 200));
  r = await call("GET", "/products?size=101", { token: ana });
  check("page size above the maximum: 400", r.status === 400);
  r = await call("POST", "/products", { token: ana, json: { sku: "x", price: "12.345", unexpected: 1 } });
  check("invalid DTO: 400 validation_failed listing the fields (sku pattern, missing name, price precision, unknown property)", r.status === 400 && r.json?.code === "PSO_VALIDATION_FAILED" && Array.isArray(r.json?.errors) && r.json.errors.length >= 3, JSON.stringify(r.json?.errors ?? []).slice(0, 240));
  evidence.invalid = r.json;
  r = await call("POST", "/products", { token: ana, json: product("KB-100") });
  check("duplicate SKU: 409 conflict with the service's safe detail", r.status === 409 && r.json?.code === "PSO_HTTP_CONFLICT" && /already exists/.test(r.json?.detail ?? ""), r.text.slice(0, 200));
  evidence.duplicate = r.json;
  const burst = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/products", { token: ana, json: product("RACE-1") })));
  const won = burst.filter((x) => x.status === 201).length, lost = burst.filter((x) => x.status === 409).length;
  check("10 concurrent creations of the same SKU: exactly one 201, nine 409", won === 1 && lost === 9, `201 x${won}, 409 x${lost}, other ${burst.filter((x) => x.status !== 201 && x.status !== 409).map((x) => x.status).join(",")}`);
  r = await call("GET", "/products/00000000-0000-0000-0000-000000000000", { token: ana });
  check("missing resource: 404 not_found", r.status === 404 && r.json?.code === "PSO_HTTP_NOT_FOUND", r.text.slice(0, 160));
  evidence.missing = r.json;
  r = await call("GET", "/products/not-a-uuid", { token: ana });
  check("malformed id: 400 before the microservice is called", r.status === 400);
  r = await call("POST", "/products", { token: bob, json: product("KB-300") });
  check("authorization: bob (products:read only) cannot create: 403", r.status === 403 && r.json?.code === "PSO_AUTH_FORBIDDEN", r.text.slice(0, 160));
  evidence.forbidden = r.json;
  r = await call("GET", "/products", { token: `${ana.slice(0, -6)}AAAAAA` });
  check("a forged token: 401", r.status === 401);
  r = await call("PUT", `/products/${created.id}`, { token: ana, json: product("KB-100", { name: "Keyboard (renamed)", price: "44.00" }) });
  check("update (PUT, full replacement): 200 with the new values", r.status === 200 && r.json?.name === "Keyboard (renamed)" && r.json?.price === "44.00", r.text.slice(0, 160));
  r = await call("PUT", `/products/${created.id}`, { token: ana, json: product("KB-101") });
  check("update to another product's SKU: 409", r.status === 409);
  const victim = (await call("GET", "/products?sku=KB-102", { token: ana })).json.items[0];
  r = await call("DELETE", `/products/${victim.id}`, { token: ana });
  check("delete: 204 without a body", r.status === 204 && r.text === "");
  r = await call("DELETE", `/products/${victim.id}`, { token: ana });
  check("delete again: 404", r.status === 404);

  // persistence: the rows are in PostgreSQL, and survive a restart of the application and its database
  const dbRows = () => spawnSync("docker", ["exec", `${PROJECT}-local-catalog-db-1`, "psql", "-U", "catalog", "-d", "catalog", "-tAc", "SELECT count(*) FROM products"], { encoding: "utf8" });
  let q = dbRows();
  check("the rows are in PostgreSQL (psql in the database container)", q.status === 0 && q.stdout.trim() === "4", (q.stdout + q.stderr).trim());
  // the orchestrator logs every request with its correlation id; the microservice receives it on every call (asserted over real HTTP by
  // packages/cli/test/composition.test.ts) and logs it only in the lines it writes, and a successful request writes none
  const correl = spawnSync("docker", ["logs", `${PROJECT}-local-gateway-1`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  check("the correlation id is in the orchestrator's request log (and was echoed to the caller above)", (correl.stdout + correl.stderr).split("\n").some((l) => l.includes('"correlationId":"crud-validation-0001"') && l.includes('"path":"/products"')));
  must(ws, "docker:down", "--env", "local");
  t0 = now();
  const up2 = pso(ws, "docker:up", "--env", "local", "--timeout", "900");
  timings.subsequentStartMs = Math.round(now() - t0);
  check("the stack starts again", up2.code === 0);
  const ana2 = (await developmentUserToken(ws, t, "ana")).accessToken;
  r = await call("GET", `/products/${created.id}`, { token: ana2 });
  check("after docker:down and docker:up the product is still there (persistent volume)", r.status === 200 && r.json?.name === "Keyboard (renamed)", r.text.slice(0, 120));

  // downstream failures: the microservice stops; the products routes answer a stable problem, the public route keeps working
  spawnSync("docker", ["stop", `${PROJECT}-local-catalog-1`], { encoding: "utf8" });
  r = await call("GET", "/products", { token: ana2 });
  check("microservice down: a stable 5xx problem (upstream unavailable / bad gateway), nothing leaks", r.status >= 502 && r.status <= 504 && /^PSO_UPSTREAM_/.test(r.json?.code ?? "") && !/catalog:8081|Exception/.test(r.text), `${r.status} ${r.json?.code}`);
  evidence.downstream = { status: r.status, body: r.json };
  r = await call("GET", "/products/options");
  check("an unrelated route keeps working while the service is down", r.status === 200);
  must(ws, "docker:up", "--env", "local", "--service", "catalog", "--timeout", "600");

  // Studio API Client: discovered endpoints, the reference collection, a real request through the orchestrator
  t0 = now();
  studio = spawn(process.execPath, [PSO, "studio", "--no-open", "--port", "17981"], { cwd: ws, env: { ...process.env, PSO_NO_BROWSER: "1" } });
  let sout = ""; studio.stdout.on("data", (d) => { sout += d; });
  const until = Date.now() + 60_000; while (!/http:\/\/127\.0\.0\.1:\d+\/\S+/.test(sout) && Date.now() < until) await new Promise((res) => setTimeout(res, 300));
  const surl = sout.match(/http:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0];
  const page = await fetch(surl, { redirect: "manual" }); const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
  const sget = async (path) => (await fetch(new URL(path, surl), { headers: { cookie } })).json();
  const targets = await sget("/api/client/targets?env=local");
  const eps = (targets.endpoints ?? []).filter((e) => e.path.startsWith("/products"));
  check("Studio discovers the products endpoints from the declarations (6, through the orchestrator)", eps.length === 6 && eps.every((e) => e.source === "orchestrator"), eps.map((e) => `${e.method} ${e.path}`).join(", "));
  const coll = await sget("/api/client/collections");
  const ref = (coll.reference ?? []).find((c) => /Products/.test(c.name));
  check("Studio offers the reference request collection (version-controlled, no credential in it)", !!ref && ref.requests.length >= 10 && !/eyJ|Bearer /.test(JSON.stringify(ref)), ref ? `${ref.requests.length} requests from ${ref.file}` : JSON.stringify(coll).slice(0, 200));
  const list = ref?.requests.find((x) => /list/.test(x.name));
  const send = await (await fetch(new URL("/api/client/send", surl), { method: "POST", headers: { cookie, origin: new URL(surl).origin, "content-type": "application/json", "x-pso-studio": "1" }, body: JSON.stringify({ env: "local", target: list.target, method: list.method, path: list.path, query: list.query, auth: { kind: "dev-user", user: "ana" } }) })).json();
  timings.studioRequestMs = Math.round(now() - t0);
  // Studio returns the answer's body as text: it must be a real page of the API
  let sentPage; try { sentPage = JSON.parse(send?.text ?? ""); } catch { sentPage = undefined; }
  check("Studio sends the reference 'list' request through the orchestrator with ana: real 200 page", send?.status === 200 && Number.isInteger(sentPage?.totalItems) && Array.isArray(sentPage?.items), JSON.stringify(send).slice(0, 200));
  const send403 = await (await fetch(new URL("/api/client/send", surl), { method: "POST", headers: { cookie, origin: new URL(surl).origin, "content-type": "application/json", "x-pso-studio": "1" }, body: JSON.stringify({ env: "local", target: "edge:api", method: "POST", path: "/products", body: { kind: "json", text: JSON.stringify(product("KB-900")) }, auth: { kind: "dev-user", user: "bob" } }) })).json();
  check("Studio: the same API refuses bob's create with 403", send403?.status === 403, JSON.stringify(send403).slice(0, 160));
  studio.kill(); studio = undefined;

  // generators on the running workspace: a second resource on both stacks, built and served
  t0 = now();
  const crud = pso(ws, "make:crud", "order", "--service", "catalog", "--orchestrator", "--fields", "code:string:unique:length=3-32:filter:sort,total:decimal:precision=12:scale=2:min=0:sort,paid:boolean:default=false:filter");
  timings.makeCrudMs = Math.round(now() - t0);
  check("make:crud order: Spring resource (V2 migration) + orchestrator module", crud.code === 0 && existsSync(join(C, "application", "rest", "OrderController.java")) && existsSync(join(ws, "catalog", "src", "main", "resources", "db", "migration", "V2__create_orders.sql")) && existsSync(join(G, "modules", "orders", "routes", "ROUTES.pso.ts")));
  const dup = pso(ws, "make:crud", "order", "--service", "catalog");
  check("make:crud refuses to overwrite an existing resource", dup.code !== 0 && /never overwritten/.test(dup.out));
  const up3 = pso(ws, "docker:up", "--env", "local", "--build", "--vendor", "--timeout", "900");
  check("the stack rebuilds with the new resource", up3.code === 0);
  const ana3 = (await developmentUserToken(ws, t, "ana")).accessToken;
  check("the identity provider gave ana the new scopes without a console or a restart", scp(ana3).includes("orders:write"), scp(ana3).join(","));
  r = await call("POST", "/orders", { token: ana3, json: { code: "ORD-1", total: "120.00", paid: false } });
  check("the generated orders CRUD answers through the orchestrator: 201", r.status === 201 && r.json?.total === "120.00", r.text.slice(0, 160));
  r = await call("GET", "/orders?paid=false", { token: ana3 });
  check("orders: filtering by a boolean field", r.status === 200 && r.json?.totalItems === 1);
  r = await call("GET", `/products/${created.id}`, { token: ana3 });
  check("the products data survived the rebuild", r.status === 200);
  evidence.orders = r.json;

  // hybrid: the database and Keycloak in containers, the CRUD service as a local process
  must(ws, "docker:down", "--env", "local");
  const hy = pso(ws, "dev", "--service", "catalog", "--with-dependencies", "--smoke", "--timeout", "500");
  check("hybrid run: catalog as a local process against its containerized PostgreSQL and Keycloak", hy.code === 0 && /READY|ready/.test(hy.out), hy.out.split("\n").slice(-3).join(" | "));

  writeFileSync(join(base, "evidence-http.json"), JSON.stringify(evidence, null, 2));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(join(dirname(outFile), "crud-http-examples.json"), JSON.stringify(evidence, null, 2) + "\n");
} catch (e) { check("validation ran to completion", false, e.stack ?? String(e)); }
finally {
  if (studio) studio.kill();
  if (!keep) {
    const down = sh(process.execPath, [PSO, "docker:down", "--env", "local", "--volumes", "--yes"], ws);
    void down;
    for (const img of (spawnSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" }).stdout ?? "").split(/\r?\n/).filter((x) => x.startsWith(`${PROJECT}-`))) spawnSync("docker", ["image", "rm", img]);
    for (const vol of (spawnSync("docker", ["volume", "ls", "--format", "{{.Name}}"], { encoding: "utf8" }).stdout ?? "").split(/\r?\n/).filter((x) => x.startsWith(`${PROJECT}-`))) spawnSync("docker", ["volume", "rm", vol]);
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* temp */ }
  }
  const failed = results.filter((r) => !r.ok).length;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), cli: `installed from ${tgz.length} release tarballs`, commands, manualEditsOfInfrastructureFiles: 0, timings, results, transcript }, null, 2) + "\n");
  console.log(`\n${results.length - failed}/${results.length} checks passed; ${commands} pso commands; timings ${JSON.stringify(timings)}`);
  process.exitCode = failed ? 1 : 0;
}
