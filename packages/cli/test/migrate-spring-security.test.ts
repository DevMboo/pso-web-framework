import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRules, ruleMatches } from "../src/migrate-spring-security.ts";
import { pso, tmp } from "./helpers.ts";

/** A workspace as 0.1 generated it: a public and a protected resource, and NO PUBLIC rule in the Spring service. */
async function legacy() {
  const parent = tmp("pso-mig-sec-");
  await pso(parent, "create", "workspace", "w", "--layout", "flat");
  const root = join(parent, "w");
  for (const a of [["create", "orchestrator", "gateway", "--structure", "legacy"], ["create", "service", "catalog", "--structure", "legacy"], ["make:resource", "product", "--service", "catalog", "--route", "/catalog/products", "--method", "GET", "--public"], ["make:resource", "order", "--service", "catalog", "--route", "/catalog/orders", "--method", "POST", "--scopes", "orders:write"]]) {
    const r = await pso(root, ...a); assert.equal(r.code, 0, r.out + r.err);
  }
  const yml = join(root, "catalog", "src", "main", "resources", "application.yml");
  // what generators before 0.2.0 left behind: an empty rules list
  writeFileSync(yml, readFileSync(yml, "utf8").replace(/^    rules:[^\n]*\n(      [^\n]*\n)+/m, "    rules: []                  # explicit authorization rules; everything not listed requires a valid token\n"));
  assert.match(readFileSync(yml, "utf8"), /^    rules: \[\]/m);
  return { root, yml };
}
const json = (s: string) => JSON.parse(s) as { springSecurity: { findings: Array<{ kind: string; route: string; method: string }> }; springAdded?: string[]; springBackups?: string[] };

test("rule matching follows Spring's ant patterns", () => {
  assert.ok(ruleMatches("/catalog/products", "/catalog/products"));
  assert.ok(ruleMatches("/catalog/*", "/catalog/products"));
  assert.ok(!ruleMatches("/catalog/*", "/catalog/products/1"));
  assert.ok(ruleMatches("/catalog/**", "/catalog/products/1"));
  assert.ok(ruleMatches("/catalog/products/*", "/catalog/products/:id"));
  assert.ok(!ruleMatches("/catalog/orders", "/catalog/products"));
});

test("legacy service: the dry run proposes exactly the public route; apply adds it with a backup; a second run changes nothing", async () => {
  const { root, yml } = await legacy();
  const before = readFileSync(yml, "utf8");
  const dry = await pso(root, "workspace:migrate", "--json");
  assert.equal(dry.code, 0, dry.out + dry.err);
  const f = json(dry.out).springSecurity.findings;
  assert.deepEqual(f.filter((x) => x.kind === "add").map((x) => `${x.method} ${x.route}`), ["GET /catalog/products"]);
  assert.ok(!f.some((x) => x.route === "/catalog/orders" && x.kind === "add"), "a protected route is never made public");
  assert.equal(readFileSync(yml, "utf8"), before, "the dry run writes nothing");
  const ap = await pso(root, "workspace:migrate", "--apply", "--json");
  assert.equal(ap.code, 0, ap.out + ap.err);
  const after = readFileSync(yml, "utf8");
  assert.match(after, /    rules:[^\n]*\n      - path: \/catalog\/products\n        methods: \[GET\]\n        access: PUBLIC      # added by pso workspace:migrate/);
  assert.doesNotMatch(after, /\/catalog\/orders/);
  const backups = json(ap.out).springBackups!;
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(root, ...backups[0]!.split("/")), "utf8"), before, "the original file is recoverable");
  const again = await pso(root, "workspace:migrate", "--apply", "--json");
  assert.equal(again.code, 0);
  assert.equal(readFileSync(yml, "utf8"), after, "idempotent");
  assert.deepEqual(json(again.out).springSecurity.findings.filter((x) => x.kind === "add"), []);
  assert.ok(existsSync(join(root, "pso.infra.json")), "the infrastructure steps ran too");
});

test("existing custom rules are preserved; a contradicting explicit rule, an unreadable block and an unmapped route are reported, never rewritten", async () => {
  const { root, yml } = await legacy();
  // a custom rule list where the developer explicitly protects the same path
  writeFileSync(yml, readFileSync(yml, "utf8").replace(/^    rules: \[\][^\n]*$/m, "    rules:\n      - path: /internal/**\n        methods: [GET]\n        access: AUTHENTICATED\n      - path: /catalog/products\n        methods: [GET]\n        access: SCOPES\n        scopes: [catalog:read]"));
  const custom = readFileSync(yml, "utf8");
  const r = json((await pso(root, "workspace:migrate", "--apply", "--json")).out);
  assert.ok(r.springSecurity.findings.some((x) => x.kind === "conflict" && x.route === "/catalog/products"));
  assert.equal(readFileSync(yml, "utf8"), custom, "the developer's explicit decision is kept");
  // flow style: cannot be edited safely
  writeFileSync(yml, custom.replace(/^    rules:\n(      [^\n]*\n|        [^\n]*\n)*/m, "    rules: [{ path: /x, access: PUBLIC }]\n"));
  const flow = readFileSync(yml, "utf8");
  const r2 = json((await pso(root, "workspace:migrate", "--json")).out);
  assert.ok(r2.springSecurity.findings.some((x) => x.kind === "ambiguous"));
  assert.equal(readFileSync(yml, "utf8"), flow);
  assert.deepEqual(readRules("pso:\n  security:\n    rules: [{ path: /x }]\n"), undefined);
});

test("a service rule that makes public what the orchestrator protects is reported", async () => {
  const { root, yml } = await legacy();
  writeFileSync(yml, readFileSync(yml, "utf8").replace(/^    rules: \[\][^\n]*$/m, "    rules:\n      - path: /catalog/**\n        access: PUBLIC"));
  const r = json((await pso(root, "workspace:migrate", "--json")).out);
  assert.ok(r.springSecurity.findings.some((x) => x.kind === "exposed-extra" && x.route === "/catalog/orders"));
  assert.ok(r.springSecurity.findings.some((x) => x.kind === "covered" && x.route === "/catalog/products"));
});
