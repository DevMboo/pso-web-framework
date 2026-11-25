import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pso, randomPort } from "./helpers.ts";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";

const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); });
const json = { "content-type": "application/json" };

test("generators + runtime: make:dto --fields, make:route --dto, @Body(Dto) end to end with a registered business validator", { timeout: 240_000 }, async () => {
  const g = await buildGateway("pso-dto-", async ({ root, gw }) => {
    assert.equal((await pso(root, "make:module", "orders", "--service", "gw")).code, 0);
    assert.equal((await pso(root, "make:controller", "orders", "--service", "gw", "--prefix", "/orders")).code, 0);
    assert.equal((await pso(root, "make:service", "orders", "sku-rules", "--service", "gw")).code, 0);
    const bad = await pso(root, "make:dto", "orders", "create-order", "--service", "gw", "--fields", "customer:string:min=3:max=40,email:email,quantity:integer:min=1:max=100,priority?:enum=low|high,tags?:string[]:max=3,sku:string");
    assert.equal(bad.code, 0, bad.err);
    const dtoFile = join(gw, "src/routes/orders/dto/create-order.dto.ts");
    const dto = readFileSync(dtoFile, "utf8");
    for (const s of ["@Dto()", "@Required() @StringField() @MinLength(3) @MaxLength(40)", "@Required() @Email()", "@Required() @IntegerField() @Min(1) @Max(100)", '@Optional() @OneOf("low", "high")', '@Optional() @ArrayOf("string") @MaxItems(3)', "priority?: \"low\" | \"high\";", "tags?: string[];"]) assert.ok(dto.includes(s), `generated DTO contains ${s}\n${dto}`);
    // a business rule that needs a service: registered as a provider, declared on the field with @Validate
    writeFileSync(dtoFile, dto.replace('import { Dto,', 'import { Validate, Dto,').replace('@Required() @StringField()\n  sku!: string;', '@Required() @StringField() @Validate(SkuRulesService)\n  sku!: string;').replace('\n\n@Dto()', '\nimport { SkuRulesService } from "../sku-rules.service";\n\n@Dto()'));
    writeFileSync(join(gw, "src/routes/orders/sku-rules.service.ts"), 'import { Injectable } from "@pso/http";\nimport type { FieldValidator } from "@pso/http";\n\n@Injectable()\nexport class SkuRulesService implements FieldValidator {\n  validate(value: unknown): string | undefined {\n    return typeof value === "string" && value.startsWith("SKU-") ? undefined : "must start with SKU-";\n  }\n}\n');
    assert.equal((await pso(root, "make:route", "orders", "create", "--method", "POST", "--path", "/", "--scopes", "customers:read", "--dto", "create-order", "--service", "gw")).code, 0);
    assert.equal((await pso(root, "make:route", "orders", "ghost", "--method", "POST", "--path", "/ghost", "--dto", "nope", "--service", "gw")).code, 1, "a DTO that does not exist is refused by the generator");
    assert.equal((await pso(root, "make:route", "orders", "list", "--method", "GET", "--path", "/list", "--scopes", "customers:read", "--service", "gw")).code, 0);
    assert.equal((await pso(root, "make:route", "orders", "byId", "--method", "GET", "--path", "/item/:id", "--scopes", "customers:read", "--service", "gw")).code, 0);
    const ctlFile = join(gw, "src/routes/orders/orders.controller.ts");
    let ctl = readFileSync(ctlFile, "utf8");
    ctl = ctl.replace("async list() {", 'async list(@Query("page", { type: "integer", min: 1, default: 1 }) page: number, @Query("sort", { oneOf: ["asc", "desc"], default: "asc" }) sort: string) {')
      .replace("// TODO: implement list\n    return {};", "return { page, sort, pageType: typeof page };")
      .replace("async byId(@Param(\"id\") id: string) {", 'async byId(@Param("id", { type: "integer", min: 1 }) id: number) {')
      .replace("// TODO: implement byId\n    return {};", "return { id, idType: typeof id };")
      .replace(/import \{ ([^}]*) \} from "@pso\/http";/, (m, names) => `import { ${names}, Query } from "@pso/http";`);
    writeFileSync(ctlFile, ctl);
    assert.match(ctl, /@Body\(CreateOrderDto\) body: CreateOrderDto/); assert.match(ctl, /from "\.\/dto\/create-order\.dto"/);
    writeFileSync(ctlFile, ctl.replace("// TODO: implement create\n    return {};", "return { accepted: true, customer: body.customer, quantity: body.quantity, priority: body.priority ?? \"low\" };"));
    // the module registers the business validator explicitly
    const modFile = join(gw, "src/routes/orders/MODULE.pso.ts");
    const mod = readFileSync(modFile, "utf8");
    assert.match(mod, /SkuRulesService/);
  });
  gateways.push(g);
  const a = await g.start();
  try {
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(a.url("/orders"), { method: "POST", headers: { ...json, ...a.auth, ...headers }, body: JSON.stringify(body) });
    const ok = await post({ customer: "Grace", email: "grace@example.com", quantity: 3, sku: "SKU-1" });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { accepted: true, customer: "Grace", quantity: 3, priority: "low" });

    const p = await expectProblem(await post({ customer: "Gr", email: "x", quantity: 0, priority: "urgent", tags: ["a", "b", "c", "d"], sku: "BAD-1", extra: 1 }, { "x-correlation-id": "corr-dto-0001" }), 400, "PSO_VALIDATION_FAILED");
    assert.equal(p["correlationId"], "corr-dto-0001");
    const fields = (p["errors"] as Array<{ field: string }>).map((e) => e.field).sort();
    assert.deepEqual(fields, ["customer", "email", "extra", "priority", "quantity", "tags"], "structural errors only: the business validator did not run on an invalid structure");
    assert.ok(!JSON.stringify(p).includes("BAD-1"));
    // structure valid: now the business validator speaks
    const biz = await expectProblem(await post({ customer: "Grace", email: "grace@example.com", quantity: 3, sku: "BAD-1" }), 400, "PSO_VALIDATION_FAILED");
    assert.deepEqual(biz["errors"], [{ field: "sku", message: "must start with SKU-" }]);
    // path and query parameters: explicit, strict conversion
    const get = async (path: string) => { const r = await fetch(a.url(path), { headers: a.auth }); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
    assert.deepEqual(await get("/orders/list"), { status: 200, body: { page: 1, sort: "asc", pageType: "number" } });
    assert.deepEqual((await get("/orders/list?page=3&sort=desc")).body, { page: 3, sort: "desc", pageType: "number" });
    const badQuery = await get("/orders/list?page=12abc&sort=up");
    assert.equal(badQuery.status, 400); assert.equal(badQuery.body["code"], "PSO_VALIDATION_FAILED");
    assert.deepEqual((badQuery.body["errors"] as Array<{ field: string }>).map((e) => e.field).sort(), ["query.page", "query.sort"]);
    assert.deepEqual((await get("/orders/item/42")).body, { id: 42, idType: "number" });
    assert.equal((await get("/orders/item/0")).status, 400); assert.equal((await get("/orders/item/abc")).status, 400);
    // no coercion, no empty body, authentication still comes first
    assert.equal((await post({ customer: "Grace", email: "g@example.com", quantity: "3", sku: "SKU-1" })).status, 400);
    assert.equal((await fetch(a.url("/orders"), { method: "POST", headers: a.auth })).status, 400);
    assert.equal((await fetch(a.url("/orders"), { method: "POST", headers: json, body: "{}" })).status, 401, "validation happens after authentication and authorization");
    assert.match(a.logs(), /"msg":"orchestrator listening"|orchestrator listening/);
    assert.ok(!a.logs().includes("BAD-1") && !a.logs().includes("grace@example.com"), "request values are not logged");
  } finally { a.child.kill(); }
});

test("start-up refuses a broken DTO declaration and an unregistered business validator, naming the route and what to fix", { timeout: 240_000 }, async () => {
  const g = await buildGateway("pso-dto2-", async ({ root, gw }) => {
    await pso(root, "make:module", "orders", "--service", "gw");
    await pso(root, "make:controller", "orders", "--service", "gw", "--prefix", "/orders");
    await pso(root, "make:dto", "orders", "item", "--service", "gw", "--fields", "name:string");
    await pso(root, "make:route", "orders", "create", "--method", "POST", "--path", "/", "--scopes", "customers:read", "--dto", "item", "--service", "gw");
    writeFileSync(join(gw, "src/routes/orders/rules.ts"), 'import { Injectable } from "@pso/http";\n@Injectable()\nexport class NameRules { validate(): string | undefined { return undefined; } }\n');
    const f = join(gw, "src/routes/orders/dto/item.dto.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace('import { ', 'import { Validate, ').replace("\n\n@Dto()", '\nimport { NameRules } from "../rules";\n\n@Dto()').replace("@Required() @StringField()", "@Required() @StringField() @Validate(NameRules)"));
  });
  gateways.push(g);
  const run = () => spawnSync(process.execPath, ["dist/main.js"], { cwd: g.gw, encoding: "utf8", timeout: 20_000, env: { ...process.env, PORT: String(randomPort()), PSO_WORKSPACE: join(g.root, "pso.workspace.json"), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: join(g.root, "test-public.pem"), PSO_JWT_ALGORITHMS: "ES256" } });
  const r1 = run();
  assert.notEqual(r1.status, 0); assert.match(r1.stdout + r1.stderr, /NameRules must be listed in the providers of module/, (r1.stdout + r1.stderr).slice(-900)); assert.match(r1.stdout + r1.stderr, /POST \/orders/);
  assert.ok(!/listening/.test(r1.stdout + r1.stderr), "nothing started");
});
