import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const doc = (id: string) => readFileSync(resolve(import.meta.dirname, "..", "docs", id + ".md"), "utf8").replaceAll("\r\n", "\n");

/** Service contracts and make:service, reproduced: the generator output, the drift error and the Lombok-style service shown in the pages. */
test("make:resource writes both contract copies, drift is detected and --force repairs it; make:service follows the Lombok rule", { timeout: 120_000 }, async () => {
  const base = tmp("pso-contracts-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const ws = join(base, "shop");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--template", "empty")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--template", "empty")).code, 0);
  const made = await pso(ws, "make:resource", "customer", "--service", "catalog", "--route", "/customers", "--scopes", "customers:read");
  assert.equal(made.code, 0);
  const contracts = doc("microservices/service-contracts");
  for (const l of made.out.split("\n").filter((x) => x.startsWith("created"))) assert.ok(contracts.includes(l), `the page shows: ${l}`);
  assert.equal((await pso(ws, "validate")).code, 0);

  const gateway = join(ws, "gateway/src/.app/contracts/customer.contract.json");
  const copy = join(ws, "catalog/src/main/resources/contracts/customer.contract.json");
  assert.equal(readFileSync(gateway, "utf8"), readFileSync(copy, "utf8"), "the two copies are identical");
  writeFileSync(gateway, readFileSync(gateway, "utf8").replace('"version": "0.1.0"', '"version": "0.2.0"'));
  const drift = await pso(ws, "validate");
  assert.equal(drift.code, 1);
  for (const l of ['ERROR   PSO_CONTRACT_DRIFT gateway/src/.app/contracts/customer.contract.json: Contract "customer" differs from its copy in service "catalog"', "hint: Update both copies together (pso make:resource --force regenerates them)"]) { assert.ok((drift.out + drift.err).includes(l), l); assert.ok(contracts.includes(l), `the page shows ${l}`); }
  const forced = await pso(ws, "make:resource", "customer", "--service", "catalog", "--route", "/customers", "--scopes", "customers:read", "--force");
  assert.ok(forced.out.includes("overwritten gateway/src/.app/contracts/customer.contract.json"));
  assert.equal((await pso(ws, "validate")).code, 0);

  const svc = await pso(ws, "make:service", "pricing", "--service", "catalog");
  assert.ok(svc.out.includes("created    src/main/java/com/pso/catalog/application/service/PricingService.java"));
  const java = readFileSync(join(ws, "catalog/src/main/java/com/pso/catalog/application/service/PricingService.java"), "utf8").replaceAll("\r\n", "\n");
  const lombok = doc("spring/lombok");
  for (const l of java.split("\n").filter((x) => x.trim() !== "")) assert.ok(lombok.includes(l), `the Lombok page shows: ${l}`);
  assert.ok(!/@Data|@ToString/.test(java), "generated services do not use @Data or @ToString");
});
