import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateContract } from "@pso/infra";
import { pso, tmp } from "./helpers.ts";

/**
 * `pso frontend:config --env <name> --fei <name> --auth <mode>`: accepted by the argument validator, resolved through pso.infra.json, recorded
 * per environment and per FEI, rendered by the infrastructure engine, and kept by later provisioning. Two shells: shop (made public) and
 * admin (OIDC through Keycloak, unchanged).
 */
const runtime = (root: string, fei: string) => JSON.parse(readFileSync(join(root, ".infra", "sites", "local", fei, "pso-runtime-config.json"), "utf8")) as { fei: string; auth: { kind: string; issuer?: string; clientId?: string } };

async function workspace(): Promise<string> {
  const base = tmp("pso-fecfg-");
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const root = join(base, "shop");
  for (const a of [["service", "catalog"], ["orchestrator", "gateway"], ["fei", "shop"], ["fei", "admin"], ["mei", "catalog", "--host", "shop", "--register"], ["mei", "users", "--host", "admin", "--register"]]) {
    const r = await pso(root, "create", ...a); assert.equal(r.code, 0, `${a.join(" ")}: ${r.err}${r.out}`);
  }
  const init = await pso(root, "infra:init", "--identity", "keycloak", "--runtime", "docker"); assert.equal(init.code, 0, init.err + init.out);
  const ap = await pso(root, "infra:apply", "--yes"); assert.equal(ap.code, 0, ap.err + ap.out);
  return root;
}

test("frontend:config --env is accepted and makes only the selected FEI public; admin keeps OIDC; later provisioning keeps the choice", { timeout: 600_000 }, async () => {
  const root = await workspace();
  assert.equal(runtime(root, "fei-shop").auth.kind, "oidc", "before: both shells sign in through Keycloak");
  assert.equal(runtime(root, "fei-admin").auth.kind, "oidc");

  const r = await pso(root, "frontend:config", "--fei", "shop", "--env", "local", "--auth", "none");
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /fei-shop in local: sign-in oidc -> none/);
  const contract = JSON.parse(readFileSync(join(root, "pso.infra.json"), "utf8")) as { environments: Record<string, { frontends?: Record<string, { auth: string }> }> };
  assert.deepEqual(contract.environments["local"]!.frontends, { "fei-shop": { auth: "none" } }, "recorded for this environment and this FEI only");
  assert.deepEqual(validateContract(contract), [], "the contract stays valid");
  assert.equal(runtime(root, "fei-shop").auth.kind, "none");
  const admin = runtime(root, "fei-admin"); assert.equal(admin.auth.kind, "oidc"); assert.equal(admin.auth.clientId, "fei-admin");

  // the next provisioning does not restore the previous sign-in: the contract is the source of the rendered file
  const plan = await pso(root, "infra:plan", "--json"); assert.equal(plan.code, 0, plan.err);
  assert.doesNotMatch(plan.out, /"runtime-config:fei-shop"[^}]*"action":\s*"(update|replace)"/, "nothing to change for the shop configuration");
  assert.equal((await pso(root, "infra:apply", "--yes")).code, 0);
  assert.equal(runtime(root, "fei-shop").auth.kind, "none", "infra:apply keeps auth none");
  assert.equal(runtime(root, "fei-admin").auth.kind, "oidc", "and admin keeps OIDC");
  // the routes the orchestrator protects are not touched by a frontend setting
  const routes = await pso(root, "routes:list", "--json"); assert.equal(routes.code, 0);
  const listed = (JSON.parse(routes.out) as { routes: Array<{ method: string; path: string; public: boolean; guard?: string }> }).routes;
  const prot = listed.filter((x) => x.path === "/products" && x.method === "GET");
  assert.ok(prot.length === 1 && prot[0]!.public === false && prot[0]!.guard === "jwt", "GET /products stays protected by the jwt guard");

  // back to OIDC through the same command
  assert.equal((await pso(root, "frontend:config", "--fei", "shop", "--env", "local", "--auth", "oidc")).code, 0);
  assert.equal(runtime(root, "fei-shop").auth.kind, "oidc");
});

test("frontend:config --env refusals: nothing is written", { timeout: 600_000 }, async () => {
  const root = await workspace();
  const before = readFileSync(join(root, "pso.infra.json"), "utf8");
  const no = async (re: RegExp, ...a: string[]) => { const r = await pso(root, "frontend:config", ...a); assert.notEqual(r.code, 0, a.join(" ")); assert.match(r.err + r.out, re, a.join(" ")); };
  await no(/2 FEIs: pass --fei/, "--env", "local", "--auth", "none");
  await no(/--auth .* is required/, "--env", "local", "--fei", "shop");
  await no(/Unknown environment "staging"/, "--env", "staging", "--fei", "shop", "--auth", "none");
  await no(/--site and --env/, "--env", "local", "--site", "x", "--fei", "shop", "--auth", "none");
  await no(/--oidc-issuer only apply to a site you manage yourself/, "--env", "local", "--fei", "shop", "--auth", "oidc", "--oidc-issuer", "https://idp.example");
  await no(/Invalid --auth/, "--env", "local", "--fei", "shop", "--auth", "magic");
  assert.equal(readFileSync(join(root, "pso.infra.json"), "utf8"), before, "pso.infra.json is unchanged after every refusal");
  // a production environment never accepts dev-token sign-in, and the file is restored when the engine refuses
  const c = JSON.parse(before) as { environments: Record<string, unknown> };
  c.environments["prod"] = { kind: "production", domain: "shop.example.com", tls: { source: "external", dir: "/etc/pso/tls" } };
  writeFileSync(join(root, "pso.infra.json"), JSON.stringify(c, null, 2) + "\n");
  const withProd = readFileSync(join(root, "pso.infra.json"), "utf8");
  const r = await pso(root, "frontend:config", "--env", "prod", "--fei", "shop", "--auth", "dev-token");
  assert.notEqual(r.code, 0); assert.match(r.err + r.out, /dev-token/);
  assert.equal(readFileSync(join(root, "pso.infra.json"), "utf8"), withProd, "restored after the engine refused");
});

test("frontend:config --site still writes a hand-managed site as before", async () => {
  const root = await workspace();
  const site = join(root, "..", "manual-site");
  const r = await pso(root, "frontend:config", "--site", site, "--fei", "shop", "--auth", "dev-token");
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(existsSync(join(site, "pso-runtime-config.json")));
  assert.equal(JSON.parse(readFileSync(join(site, "pso-runtime-config.json"), "utf8")).auth.kind, "dev-token");
});

test("the contract accepts per-environment frontend auth and refuses everything else there", () => {
  const base = { schemaVersion: 1, environments: { local: { kind: "development", domain: "pso.localhost" } } } as Record<string, any>;
  assert.deepEqual(validateContract({ ...base, environments: { local: { ...base.environments.local, frontends: { "fei-shop": { auth: "none" } } } } }), []);
  const issues = (fr: unknown, kind = "development") => validateContract({ ...base, environments: { local: { kind, domain: kind === "production" ? "shop.example.com" : "pso.localhost", ...(kind === "production" ? { tls: { source: "external" } } : {}), frontends: fr } } }).map((i) => i.code);
  assert.ok(issues({ "fei-shop": { auth: "open" } }).includes("PSO_INFRA_FRONTEND_AUTH"));
  assert.ok(issues({ "fei-shop": { host: "x" } }).includes("PSO_INFRA_FRONTEND"), "host stays workspace-wide");
  assert.ok(issues({ "fei-shop": { auth: "dev-token" } }, "production").includes("PSO_INFRA_DEV_TOKEN_PRODUCTION"));
});
