// Not a test (no .test.ts suffix): produces the real controller behavior quoted in orchestrator/controllers.md.
// Run: node packages/cli/test/_demo-controller.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pso } from "./helpers.ts";
import { buildGateway } from "./gw-fixture.ts";

const g = await buildGateway("pso-demo-ctl-", async ({ root, gw }) => {
  await pso(root, "make:module", "orders", "--service", "gw");
  await pso(root, "make:controller", "orders", "--service", "gw", "--prefix", "/orders");
  for (const [name, method, path] of [["list", "GET", "/"], ["byId", "GET", "/:id"], ["create", "POST", "/"], ["boom", "GET", "/boom/now"], ["gone", "GET", "/gone/now"], ["teapot", "GET", "/teapot/now"], ["nothing", "GET", "/nothing/now"]] as const) {
    const r = await pso(root, "make:route", "orders", name, "--method", method, "--path", path, "--scopes", "customers:read", "--service", "gw");
    if (r.code !== 0) throw new Error(`${name}: ${r.err}`);
  }
  const f = join(gw, "src/routes/orders/orders.controller.ts");
  let t = readFileSync(f, "utf8");
  const body = (name: string, code: string): void => { t = t.replace(new RegExp(`// TODO: implement ${name}\\n    return \\{\\};`), code); };
  body("list", 'return [{ id: "1", total: 10 }, { id: "2", total: 25 }];');
  body("byId", 'return { id, found: true };');
  body("create", 'return { created: true };');
  body("boom", 'throw new Error("database password is hunter2");');
  body("gone", 'throw new HttpError(404, "not_found");');
  body("teapot", 'throw new HttpError(418, "I am a teapot");');
  body("nothing", "return undefined;");
  t = t.replace(/import \{ ([^}]*) \} from "@pso\/http";/, (_m, n: string) => `import { ${n}, HttpError } from "@pso/http";`);
  writeFileSync(f, t);
});
const a = await g.start({ PSO_LOG_FORMAT: "pretty", PSO_LOG_COLOR: "never" });
const show = async (title: string, path: string, method = "GET") => {
  const r = await fetch(a.url(path), { method, headers: { ...a.auth, "content-type": "application/json", "x-correlation-id": "doc-ctl-0001" }, ...(method === "POST" ? { body: "{}" } : {}) });
  console.log(`\n$ ${title}\nHTTP ${r.status} ${r.headers.get("content-type") ?? ""}\n${await r.text()}`);
};
await show("GET /orders", "/orders");
await show("GET /orders/42", "/orders/42");
await show("POST /orders", "/orders", "POST");
await show("GET /orders/nothing/now  (action returns undefined)", "/orders/nothing/now");
await show("GET /orders/gone/now  (throw new HttpError(404, \"not_found\"))", "/orders/gone/now");
await show("GET /orders/teapot/now  (throw new HttpError(418, \"I am a teapot\"))", "/orders/teapot/now");
await show("GET /orders/boom/now  (throw new Error(\"database password is hunter2\"))", "/orders/boom/now");
await new Promise((r) => setTimeout(r, 300));
console.log("\n=== terminal (errors) ===\n" + a.logs().split("\n").filter((l) => /ERROR|WARN|boom|hunter2|status=500/.test(l)).join("\n"));
a.child.kill();
g.dispose();
