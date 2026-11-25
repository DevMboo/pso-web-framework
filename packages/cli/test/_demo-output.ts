// Not a test (no .test.ts suffix): produces the real terminal output quoted in the documentation. Run: node packages/cli/test/_demo-output.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pso } from "./helpers.ts";
import { buildGateway } from "./gw-fixture.ts";

const g = await buildGateway("pso-demo-", async ({ root, gw }) => {
  await pso(root, "make:module", "orders", "--service", "gw");
  await pso(root, "make:controller", "orders", "--service", "gw", "--prefix", "/orders");
  await pso(root, "make:dto", "orders", "create-order", "--service", "gw", "--fields", "customer:string:min=3:max=40,email:email,quantity:integer:min=1:max=100");
  await pso(root, "make:route", "orders", "create", "--method", "POST", "--path", "/", "--scopes", "customers:read", "--dto", "create-order", "--service", "gw");
  const f = join(gw, "src/routes/orders/orders.controller.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace("// TODO: implement create\n    return {};", "return { accepted: true, customer: body.customer, quantity: body.quantity };"));
  console.log("=== generated DTO ===\n" + readFileSync(join(gw, "src/routes/orders/dto/create-order.dto.ts"), "utf8"));
  console.log("=== generated controller ===\n" + readFileSync(f, "utf8"));
});
const a = await g.start({ PSO_LOG_FORMAT: "pretty", PSO_LOG_COLOR: "never", PSO_ENV: "development" });
const post = (body: unknown) => fetch(a.url("/orders"), { method: "POST", headers: { "content-type": "application/json", ...a.auth, "x-correlation-id": "demo-corr-0001" }, body: JSON.stringify(body) });
const ok = await post({ customer: "Grace", email: "grace@example.com", quantity: 3 });
console.log("=== valid ===\n" + ok.status + " " + (await ok.text()));
const bad = await post({ customer: "Gr", email: "nope", quantity: 0, admin: true });
console.log("=== invalid ===\n" + bad.status + " " + bad.headers.get("content-type") + "\n" + JSON.stringify(await bad.json(), null, 2));
await new Promise((r) => setTimeout(r, 300));
console.log("=== terminal output (pretty, no colour) ===\n" + a.logs().split("\n").filter((l) => !l.includes("upstream configured")).join("\n"));
a.child.kill();
g.dispose();
