#!/usr/bin/env node
// Creates the PSO 0.2.0 reference workspace with the real CLI, step by step (no file is written by hand except the
// application-specific parts listed at the end). Usage: node scripts/reference/create-reference-workspace.mjs <parent-dir> [--force]
//
//   orchestrator  gateway                      (Node, inbound TLS behind the edge)
//   services      catalog (Spring, PostgreSQL)  accounts (Spring, mutual TLS from the orchestrator)
//   shells        fei-shop  (public home page, public catalog microfrontend, protected cart)
//                 fei-admin (authenticated; the users microfrontend needs users:admin)
//   MEIs          mei-catalog (public, in fei-shop)  mei-cart (cart:write, in fei-shop)  mei-users (users:admin, in fei-admin)
//   identity      Keycloak (generated realm: roles, one client per FEI, development users ana and bob)
//   environments  local (development, docker, pso.localhost)   staging (operator-supplied TLS and secret files)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PSO = resolve(here, "..", "..", "packages", "cli", "bin", "pso.js");
const parent = resolve(process.argv[2] ?? join(here, "..", "..", "fixtures"));
const root = join(parent, "pso-reference");
if (existsSync(root)) {
  if (!process.argv.includes("--force")) { console.error(`${root} exists (pass --force to recreate it)`); process.exit(2); }
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(parent, { recursive: true });
const pso = (cwd, ...args) => {
  console.log(`\n$ pso ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [PSO, ...args], { cwd, encoding: "utf8", env: { ...process.env, PSO_NO_BROWSER: "1" } });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  if (r.status !== 0) { console.error(`FAILED (exit ${r.status}): pso ${args.join(" ")}`); process.exit(1); }
  return r.stdout;
};
const edit = (rel, fn) => { const f = join(root, ...rel.split("/")); writeFileSync(f, fn(readFileSync(f, "utf8"))); };

pso(parent, "create", "workspace", "pso-reference");
pso(root, "create", "orchestrator", "gateway");
pso(root, "create", "service", "catalog", "--db", "postgres");
pso(root, "create", "service", "accounts");
pso(root, "infra:init", "--identity", "keycloak", "--runtime", "docker", "--users", "ana,bob");
// the application-specific part of the contract: who the development users are, which hop uses mutual TLS, a staging environment
edit("pso.infra.json", (t) => {
  const c = JSON.parse(t);
  c.identity.users = [{ username: "ana", scopes: ["catalog:read", "cart:write", "users:admin", "accounts:read"] }, { username: "bob", scopes: ["catalog:read", "cart:write"] }];
  c.services = { accounts: { mtls: true } };
  // staging runs on a Linux host reached over SSH (pso connection:add staging-host ...); certificates and secret files are the operator's, on that host
  c.environments.staging = { kind: "staging", domain: "staging.pso.localhost", runtime: "docker", httpsPort: 9443, tls: { source: "external", dir: "/etc/pso-reference/tls" }, secrets: { provider: "file", dir: "/etc/pso-reference/secrets" }, dns: { provider: "external" }, deploy: { target: "ssh", connection: "staging-host", root: "/srv/pso" } };
  return JSON.stringify(c, null, 2) + "\n";
});
// backend routes: one explicitly public endpoint, the rest protected by scopes (public pages never make an endpoint public by themselves)
pso(root, "make:resource", "product", "--service", "catalog", "--route", "/catalog/products", "--method", "GET", "--public");
pso(root, "make:resource", "cart-item", "--service", "catalog", "--route", "/catalog/cart-items", "--method", "POST", "--scopes", "cart:write");
pso(root, "make:resource", "user", "--service", "accounts", "--route", "/accounts/users", "--method", "GET", "--scopes", "users:admin");
// two independent shells and their microfrontends
pso(root, "create", "fei", "shop");
pso(root, "create", "fei", "admin");
pso(root, "create", "mei", "catalog", "--host", "shop");
pso(root, "create", "mei", "cart", "--host", "shop");
pso(root, "create", "mei", "users", "--host", "admin");
// the shop's home page is public (a visitor without a session may open it); the admin shell stays fully authenticated
edit("frontend/fei-shop/ROUTES.pso.ts", (t) => t.replace(`{ path: "/", page: "./src/pages/Home.tsx", title: "Home" }`, `{ path: "/", page: "./src/pages/Home.tsx", title: "Home", public: true }`));
pso(root, "fei:register", "catalog", "--public", "--title", "Catalog");
pso(root, "fei:register", "cart", "--scopes", "cart:write", "--title", "Cart");
pso(root, "fei:register", "users", "--scopes", "users:admin", "--title", "Users");
// application code (not framework): the sample controllers return a few records and the MEIs call the real endpoints
edit("catalog/src/main/java/com/pso/catalog/routes/ProductController.java", (t) => t.replace("        return List.of();", `        return List.of(new ProductDto("p-1", "Espresso beans"), new ProductDto("p-2", "Pour-over kettle"));`));
edit("accounts/src/main/java/com/pso/accounts/routes/UserController.java", (t) => t.replace("        return List.of();", `        return List.of(new UserDto("u-1", "ana"), new UserDto("u-2", "bob"));`));
edit("frontend/mei-catalog/src/services/catalog.service.ts", (t) => t.replace(`api.get<Item[]>("/catalog"`, `api.get<Item[]>("/catalog/products"`).replace("api.get<Item>(`/catalog/", "api.get<Item>(`/catalog/products/"));
edit("frontend/mei-cart/src/services/cart.service.ts", (t) => t.replace(`api.get<Item[]>("/cart"`, `api.get<Item[]>("/catalog/products"`).replace("api.get<Item>(`/cart/", "api.get<Item>(`/catalog/products/"));
edit("frontend/mei-users/src/services/users.service.ts", (t) => t.replace(`api.get<Item[]>("/users"`, `api.get<Item[]>("/accounts/users"`).replace("api.get<Item>(`/users/", "api.get<Item>(`/accounts/users/"));
pso(root, "validate");
pso(root, "frontend:validate");
pso(root, "infra:plan");
console.log(`\nreference workspace created in ${root}`);
