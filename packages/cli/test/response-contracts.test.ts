import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildContract, diffContracts, parseResponseSpec, renderContractTs, type OrchestratorContract } from "../src/frontend-contracts.ts";
import { typedOperations } from "@pso/frontend";

const commerce = resolve(import.meta.dirname, "..", "..", "..", "fixtures", "pso-commerce");
const config = JSON.parse(readFileSync(join(commerce, "pso.workspace.json"), "utf8"));

test("response specifications: DTOs, collections, nullable bodies, void and problem; everything else is refused", () => {
  assert.deepEqual(parseResponseSpec("CustomerResponse"), { kind: "dto", dto: "CustomerResponse" });
  assert.deepEqual(parseResponseSpec("CustomerResponse[]"), { kind: "dto", dto: "CustomerResponse", collection: true });
  assert.deepEqual(parseResponseSpec("CustomerResponse | null"), { kind: "dto", dto: "CustomerResponse", nullable: true });
  assert.deepEqual(parseResponseSpec("CustomerResponse[] | null"), { kind: "dto", dto: "CustomerResponse", collection: true, nullable: true });
  assert.deepEqual(parseResponseSpec("void"), { kind: "void" }); assert.deepEqual(parseResponseSpec("problem"), { kind: "problem" });
  for (const bad of ["", "Array<X>", "X | Y", "{ a: string }", "X[][]", "import('x').Y", "1x"]) assert.equal(parseResponseSpec(bad), undefined, bad);
});

test("the Commerce orchestrator publishes explicit response contracts; routes without them keep working and stay untyped", () => {
  const c = buildContract(commerce, config);
  const get = (id: string) => c.operations.find((o) => o.id === id)!;
  assert.deepEqual(get("GET /customers").responses, { 200: { kind: "dto", dto: "CustomerResponse", collection: true }, 401: { kind: "problem" }, 403: { kind: "problem" } });
  assert.deepEqual(get("POST /orders").responses?.["201"], { kind: "dto", dto: "OrderResponse" });
  assert.equal(get("GET /customers/:id/summary").responses, undefined, "a route that declares nothing stays untyped: nothing is inferred");
  for (const n of ["CustomerResponse", "ProductResponse", "OrderResponse"]) assert.ok(c.dtos[n], `${n} is published`);
  assert.ok(!c.dtos["CustomerSummaryResponse"], "an undeclared DTO is not exposed automatically");
  const ts = renderContractTs(c);
  assert.match(ts, /"GET \/customers": \{ 200: CustomerResponse\[\]; 401: Problem; 403: Problem \};/);
  assert.match(ts, /export interface CustomerResponse \{\n  id: string;\n  name: string;/, "a response DTO is complete unless a field is declared with ?");
  assert.match(ts, /export const createOperations = /);
});

test("the generated contract compiles, and the compiler rejects wrong operations, missing parameters, wrong bodies and wrong response use", () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-rc-"));
  try {
    const c = buildContract(commerce, config);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "contract.generated.ts"), renderContractTs(c));
    writeFileSync(join(dir, "src", "use.ts"), `import type { PsoApi } from "@pso/frontend";
import { createOperations, type CustomerResponse, type Problem } from "./contract.generated.ts";
declare const api: PsoApi;
const ops = createOperations(api);
export async function ok() {
  const all: CustomerResponse[] = await ops.call("GET /customers");
  const one: CustomerResponse = await ops.call("GET /customers/:id", { params: { id: "42" } });
  const made: CustomerResponse = await ops.call("POST /customers", { body: { name: "Ana", email: "a@b.c" } });
  const order = await ops.call("GET /orders/:id", { params: { id: "o1" } });
  const total: number = order.totalCents;
  const p: Problem | undefined = undefined;
  return [all, one, made, total, p];
}
// @ts-expect-error not an operation of the contract
ops.call("GET /nope");
// @ts-expect-error a POST with a body needs its body
ops.call("POST /customers");
// @ts-expect-error the body must match the DTO
ops.call("POST /customers", { body: { name: 1 } });
export async function wrongUse() {
  // @ts-expect-error a customer is not a product
  const x: import("./contract.generated.ts").ProductResponse = await ops.call("GET /customers/:id", { params: { id: "1" } });
  return x;
}
`);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, exactOptionalPropertyTypes: false, baseUrl: ".", paths: { "@pso/frontend": [join(resolve(import.meta.dirname, "..", "..", "frontend", "src", "index.ts")).replaceAll("\\", "/")] } }, include: ["src"] }));
    const tsc = join(resolve(import.meta.dirname, "..", "..", "..", "node_modules", "typescript", "bin", "tsc"));
    const r = spawnSync(process.execPath, [tsc, "-p", dir], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an invalid response contract is refused with the route and the reason", () => {
  const root = mkdtempSync(join(tmpdir(), "pso-rc2-"));
  try {
    cpSync(join(commerce, "gateway"), join(root, "gateway"), { recursive: true, filter: (s) => !/node_modules|dist|vendor/.test(s) });
    const f = join(root, "gateway", "src", "routes", "customers", "ROUTES.pso.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace('200: "CustomerResponse[]"', '200: "NoSuchDto[]"'));
    const cfg = { ...config, services: config.services.filter((s: { role?: string }) => s.role === "orchestrator").map((s: { path: string }) => ({ ...s, path: "gateway" })) };
    assert.throws(() => buildContract(root, cfg), /GET \/customers: response 200 names "NoSuchDto", but no @Dto\(\) class of that name exists/);
    writeFileSync(f, readFileSync(f, "utf8").replace('200: "NoSuchDto[]"', '200: "Array<X>"'));
    assert.throws(() => buildContract(root, cfg), /is not a DTO name/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contract changes are classified: removals and type changes break frontends, additions do not", () => {
  const prev = buildContract(commerce, config);
  const clone = (): OrchestratorContract => JSON.parse(JSON.stringify(prev));
  assert.deepEqual(diffContracts(prev, clone()), { breaking: [], additive: [] });

  const add = clone(); add.operations.push({ id: "GET /extra", method: "GET", path: "/extra", scopes: [], auth: "jwt", pathParams: [], body: null }); add.dtos["CustomerResponse"]!.push({ name: "nickname", type: "string", required: false, optional: true });
  const a = diffContracts(prev, add); assert.deepEqual(a.breaking, []); assert.ok(a.additive.some((x) => /operation GET \/extra was added/.test(x)) && a.additive.some((x) => /field "nickname" was added/.test(x)));

  const brk = clone();
  brk.operations = brk.operations.filter((o) => o.id !== "GET /orders");
  brk.dtos["CustomerResponse"] = brk.dtos["CustomerResponse"]!.filter((f) => f.name !== "email");
  brk.dtos["ProductResponse"]!.find((f) => f.name === "priceCents")!.type = "string";
  brk.dtos["OrderResponse"]!.find((f) => f.name === "status")!.optional = true;
  brk.operations.find((o) => o.id === "GET /customers")!.scopes.push("customers:admin");
  delete brk.operations.find((o) => o.id === "GET /products/:id")!.responses!["404"];
  const b = diffContracts(prev, brk).breaking.join("\n");
  for (const re of [/operation GET \/orders was removed/, /CustomerResponse: field "email" was removed/, /ProductResponse\.priceCents: type changed from number to string/, /OrderResponse\.status: became optional/, /GET \/customers: now requires the scope "customers:admin"/, /GET \/products\/:id: the 404 response is no longer declared/]) assert.match(b, re);
});

test("typedOperations: parameters are substituted and encoded, the method decides the call, and mistakes fail before any request", async () => {
  const calls: Array<{ m: string; path: string; body?: unknown; opts?: unknown }> = [];
  const rec = (m: string) => (path: string, a?: unknown, b?: unknown) => { calls.push(m === "GET" || m === "DELETE" ? { m, path, opts: a } : { m, path, body: a, opts: b }); return Promise.resolve({ ok: true }); };
  const api = { get: rec("GET"), delete: rec("DELETE"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), upload: rec("POST"), download: rec("GET") } as never;
  const table = { "GET /a/:id": { method: "GET", path: "/a/:id", pathParams: ["id"] }, "PATCH /a/:id/b": { method: "PATCH", path: "/a/:id/b", pathParams: ["id"] }, "POST /a": { method: "POST", path: "/a", pathParams: [] }, "TRACE /t": { method: "TRACE", path: "/t", pathParams: [] } } as const;
  const ops = typedOperations<typeof table>(api, table) as unknown as { call(id: string, o?: unknown): Promise<unknown> };
  await ops.call("GET /a/:id", { params: { id: "a/b c?" }, query: { x: 1 } });
  await ops.call("PATCH /a/:id/b", { params: { id: 7 }, body: { v: 1 } });
  await ops.call("POST /a", { body: { n: 1 }, idempotencyKey: "k" });
  assert.equal(calls[0]!.path, "/a/a%2Fb%20c%3F", "a path parameter can never add a segment or a query"); assert.deepEqual(calls[0]!.opts, { query: { x: 1 } });
  assert.deepEqual([calls[1]!.m, calls[1]!.path, calls[1]!.body], ["PATCH", "/a/7/b", { v: 1 }]);
  assert.deepEqual([calls[2]!.m, calls[2]!.body, calls[2]!.opts], ["POST", { n: 1 }, { idempotencyKey: "k" }]);
  await assert.rejects(ops.call("GET /a/:id", {}), /needs the path parameter "id"/);
  await assert.rejects(ops.call("GET /nope"), /unknown operation/);
  await assert.rejects(ops.call("TRACE /t"), /does not send/);
  assert.equal(calls.length, 3, "nothing was sent for the three mistakes");
});
