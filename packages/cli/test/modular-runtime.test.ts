import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, StartupError, resetLogging, setLogSink, type App } from "@pso/http";
import { tmp, unusedPort } from "./helpers.ts";

/**
 * The runtime serves the official modular structure from a real build: application-wide components in dist/.app/, modules in
 * dist/modules/<m>/ with routes/ROUTES.pso.js and controllers/, interceptors around actions, explicit results (201 + Location, 204),
 * HttpError details in Problem Details, and a build that mixes the 0.1 and modular structures is refused before anything listens.
 */
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const dist = (pkg: string): string => JSON.stringify(join(REPO, "packages", pkg, "dist", "index.js"));
const dirs: string[] = [];
const apps: App[] = [];
after(async () => { for (const a of apps) await a.close().catch(() => undefined); resetLogging(); for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });

const put = (root: string, rel: string, body: string): void => { const f = join(root, ...rel.split("/")); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); };

function modularApp(extra: Record<string, string> = {}, interceptors = '["envelope"]'): { project: string; appDir: string } {
  const project = tmp("pso-modular-"); dirs.push(project);
  const appDir = join(project, "dist");
  put(appDir, ".app/interceptors/envelope.interceptor.js", `exports.default = async (call, next) => { const r = await next(); if (Array.isArray(r)) return { items: r, route: call.route.path }; return r; };`);
  put(appDir, "modules/products/controllers/product.controller.js", `const http = require(${dist("http")});
const store = new Map([["p-1", { id: "p-1", name: "Espresso beans" }]]);
class ProductController {
  list() { return [...store.values()]; }
  find(id) { const p = store.get(id); if (!p) throw new http.HttpError(404, "not_found", { detail: "No product has the id " + id.length + " characters long id given" }); return p; }
  create(body) { if (store.has(body.id)) throw new http.HttpError(409, "conflict", { detail: "A product with this id already exists" }); store.set(body.id, body); return http.created(body, "/products/" + body.id); }
  remove(id) { store.delete(id); return http.noContent(); }
}
http.Controller()(ProductController); http.RestController("/products")(ProductController);
http.Get("/")(ProductController.prototype, "list"); http.Get("/:id")(ProductController.prototype, "find"); http.Post("/")(ProductController.prototype, "create"); http.Delete("/:id")(ProductController.prototype, "remove");
http.Param("id")(ProductController.prototype, "find", 0); http.Body()(ProductController.prototype, "create", 0); http.Param("id")(ProductController.prototype, "remove", 0);
for (const a of ["list", "find", "create", "remove"]) http.Public()(ProductController.prototype, a);
exports.ProductController = ProductController;
`);
  put(appDir, "modules/products/routes/ROUTES.pso.js", `const http = require(${dist("http")});
const { ProductController } = require("../controllers/product.controller.js");
const pub = { public: true };
exports.default = http.defineRoutes({ routes: [
  { method: "GET", path: "/products", controller: ProductController, action: "list", security: pub, interceptors: ${interceptors} },
  { method: "GET", path: "/products/:id", controller: ProductController, action: "find", security: pub },
  { method: "POST", path: "/products", controller: ProductController, action: "create", security: pub },
  { method: "DELETE", path: "/products/:id", controller: ProductController, action: "remove", security: pub },
] });
`);
  put(appDir, "modules/products/MODULE.pso.js", `const core = require(${dist("core")});
const { ProductController } = require("./controllers/product.controller.js");
exports.default = core.defineModule({ name: "products", controllers: [ProductController], providers: [], routes: require("./routes/ROUTES.pso.js").default, imports: [], exports: [] });
`);
  for (const [k, v] of Object.entries(extra)) put(appDir, k, v);
  return { project, appDir };
}

const quiet = (): void => { setLogSink(() => {}); };

test("a modular build is served: .app interceptors, modules/<m>/routes, created() with Location, noContent(), HttpError detail", { timeout: 60_000 }, async () => {
  quiet();
  const fx = modularApp();
  const port = await unusedPort();
  const app = await bootstrap({ appDir: fx.appDir, projectDir: fx.project, port, host: "127.0.0.1" }); apps.push(app);
  const base = `http://127.0.0.1:${port}`;
  const list = await (await fetch(`${base}/products`)).json() as { items: unknown[]; route: string };
  assert.deepEqual([list.items.length, list.route], [1, "/products"], "the interceptor wrapped the action result");
  const c = await fetch(`${base}/products`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "p-2", name: "Kettle" }) });
  assert.deepEqual([c.status, c.headers.get("location")], [201, "/products/p-2"]);
  const dup = await fetch(`${base}/products`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "p-2", name: "Kettle" }) });
  const dupBody = await dup.json() as { status: number; code: string; detail: string };
  assert.deepEqual([dup.status, dupBody.code, dupBody.detail, dup.headers.get("content-type")?.startsWith("application/problem+json")], [409, "PSO_HTTP_CONFLICT", "A product with this id already exists", true]);
  const missing = await fetch(`${base}/products/nope`);
  assert.deepEqual([missing.status, ((await missing.json()) as { code: string }).code], [404, "PSO_HTTP_NOT_FOUND"]);
  const del = await fetch(`${base}/products/p-2`, { method: "DELETE" });
  assert.deepEqual([del.status, await del.text(), del.headers.get("content-length")], [204, "", null]);
  await app.close(); apps.pop();
});

test("a literal path wins over a parameter at the same position, whatever the declaration order (/items/options vs /items/:id)", { timeout: 60_000 }, async () => {
  quiet();
  const fx = modularApp({
    "modules/items/controllers/item.controller.js": `const http = require(${dist("http")});
class ItemController { one(id) { return { route: "id", id }; } options() { return { route: "options" }; } }
http.Controller()(ItemController); http.RestController("/items")(ItemController);
http.Get("/:id")(ItemController.prototype, "one"); http.Get("/options")(ItemController.prototype, "options");
http.Param("id")(ItemController.prototype, "one", 0);
for (const a of ["one", "options"]) http.Public()(ItemController.prototype, a);
exports.ItemController = ItemController;
`,
    "modules/items/routes/ROUTES.pso.js": `const http = require(${dist("http")});
const { ItemController } = require("../controllers/item.controller.js");
exports.default = http.defineRoutes({ routes: [
  { method: "GET", path: "/items/:id", controller: ItemController, action: "one", security: { public: true } },
  { method: "GET", path: "/items/options", controller: ItemController, action: "options", security: { public: true } },
] });
`,
    "modules/items/MODULE.pso.js": `const core = require(${dist("core")});
const { ItemController } = require("./controllers/item.controller.js");
exports.default = core.defineModule({ name: "items", controllers: [ItemController], providers: [], routes: require("./routes/ROUTES.pso.js").default, imports: [], exports: [] });
`,
  });
  const port = await unusedPort();
  const app = await bootstrap({ appDir: fx.appDir, projectDir: fx.project, port, host: "127.0.0.1" }); apps.push(app);
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${base}/items/options`)).json(), { route: "options" });
  assert.deepEqual(await (await fetch(`${base}/items/i-7`)).json(), { route: "id", id: "i-7" });
  await app.close(); apps.pop();
});

test("a route naming an interceptor that does not exist is refused before anything listens", { timeout: 60_000 }, async () => {
  quiet();
  const fx = modularApp({}, '["nope"]');
  await assert.rejects(() => bootstrap({ appDir: fx.appDir, projectDir: fx.project, port: 0, host: "127.0.0.1" }), (e: unknown) => e instanceof StartupError && e.diagnostics.some((d) => d.code === "PSO_ROUTE_008"));
});

test("a build that mixes the modular and 0.1 structures does not start", { timeout: 60_000 }, async () => {
  quiet();
  const fx = modularApp({ "routes/legacy/MODULE.pso.js": "exports.default = {};" });
  await assert.rejects(() => bootstrap({ appDir: fx.appDir, projectDir: fx.project, port: 0, host: "127.0.0.1" }), (e: unknown) => e instanceof StartupError && e.diagnostics.some((d) => d.code === "PSO_STRUCTURE_MIXED"));
});
