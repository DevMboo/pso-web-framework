#!/usr/bin/env node
// Validates the deployment PSO generates, for real, end to end and authenticated:
//
//   test identity provider -> signed JWT -> orchestrator (JWT, scopes) -> HTTPS upstream (verified certificate, token forwarded)
//   -> Spring Boot service (JWT again, scopes and roles) -> business operation (PostgreSQL)
//
// A fresh workspace is generated with the PSO CLI (one Node orchestrator, the Spring services catalog and orders, generated
// resources), TLS material with `pso tls:init --dev`, the deployment with `pso docker:init --vendor`; then `docker compose build`,
// `docker compose up -d --wait` and the checks a release needs: health and readiness, authentication and authorization at both layers,
// routing, TLS verification, recovery of Redis and of the identity provider, key rotation, restart of single services, graceful
// shutdown of the generated process (15 s grace period, 12 s request) and a clean stop.
//
//   node scripts/validate-generated-deployment.mjs [--keep] [--log <file>] [--report <file.json>]
//
// Generated files are used exactly as generated. What a deployment adds itself goes where the generated files say it goes: values
// in .env (copied from .env.example) and the infrastructure (identity provider, PostgreSQL, Redis, RabbitMQ) in
// docker-compose.override.yml. Application code (what a developer writes inside the generated controllers) is written by this script.
// The identity provider is the test fixture scripts/fixtures/test-idp.cjs: synthetic identities, keys generated at start, never a
// public provider.
//
// Isolation: ONE compose project with a unique name (psodeploy<random>); `docker compose -p <name> down` removes that project's
// containers, network, volumes and locally built images and nothing else. Every other container on the machine is recorded before
// and compared at the end. Every Docker operation has a time limit. Nothing is retried to turn a failure into a pass.
// Exit 0: every check passed. Exit 1: at least one failed (each one is listed, with what was observed). Exit 2: Docker is not available.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const logFile = flag("log") ? resolve(flag("log")) : undefined;
const reportFile = flag("report") ? resolve(flag("report")) : undefined;
const say = (s = "") => { console.log(s); if (logFile) appendFileSync(logFile, s + "\n"); };
const project = `psodeploy${randomBytes(4).toString("hex")}`;
const base = mkdtempSync(join(tmpdir(), "pso-deploy-"));
const ws = join(base, "shop");
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- report ----
const SECTIONS = ["generation", "build", "startup", "health", "readiness", "authentication", "authorization", "business", "tls", "routing", "recovery", "restart", "shutdown", "cleanup", "isolation"];
const report = Object.fromEntries(SECTIONS.map((s) => [s, { ok: true, checks: [] }]));
const timings = {};
const check = (section, name, ok, detail = "") => {
  report[section].checks.push({ name, ok: !!ok, ...(detail ? { detail: String(detail).slice(0, 400) } : {}) });
  if (!ok) report[section].ok = false;
  say(`${ok ? "PASS" : "FAIL"}  [${section}] ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ""}`);
  return !!ok;
};

// ---- processes: every one bounded in time ----
const sh = (cmd, a, o = {}) => { const r = spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000, ...o }); if (r.error?.code === "ETIMEDOUT") r.timedOut = true; r.stdout ??= ""; r.stderr ??= ""; return r; };
const pso = (cwd, ...a) => { const r = sh(process.execPath, [join(ROOT, "packages", "cli", "bin", "pso.js"), ...a], { cwd, timeout: 180_000 }); say(`$ pso ${a.join(" ")}   (exit ${r.status})`); if (r.status !== 0) say((r.stdout + r.stderr).split(/\r?\n/).slice(-8).join("\n")); return r; };
let composeEnv = { ...process.env };
const dc = (a, o = {}) => sh("docker", ["compose", "-p", project, ...a], { cwd: ws, env: composeEnv, ...o });
const dcSay = (a, timeout = 120_000) => { const t = Date.now(); const r = dc(a, { timeout }); say(`$ docker compose ${a.join(" ")}   (exit ${r.status}${r.timedOut ? `, TIMED OUT after ${timeout / 1000} s` : ""}, ${((Date.now() - t) / 1000).toFixed(1)} s)`); return r; };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const cid = (service) => dc(["ps", "-aq", service]).stdout.trim().split(/\s+/)[0] ?? "";
const inspect = (id, f) => (id ? sh("docker", ["inspect", "-f", f, id]).stdout.trim() : "");
const health = (service) => inspect(cid(service), "{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}");
const until = async (f, ms, step = 1000) => { for (let t = 0; t < ms; t += step) { if (await f()) return true; await sleep(step); } return false; };
const logs = (service, since) => { const r = dc(["logs", "--no-color", "--no-log-prefix", ...(since ? ["--since", since] : []), service]); return `${r.stdout}${r.stderr}`; };
const jsonLines = (text) => text.split(/\r?\n/).flatMap((l) => { try { return l.startsWith("{") ? [JSON.parse(l)] : []; } catch { return []; } });
const errorLines = (service) => logs(service).split(/\r?\n/).filter((l) => /"level":"(ERROR|error)"|startup failed/.test(l)).slice(-3).map((l) => l.slice(0, 500)).join("\n");
/** every container that is not part of this project: id -> identity and start time */
const outsiders = () => new Map(sh("docker", ["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Label \"com.docker.compose.project\"}}"]).stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")).filter(([, p]) => p !== project).map(([id]) => [id, inspect(id, "{{.Name}} {{.State.Running}} {{.State.StartedAt}} {{.RestartCount}}")]));

// ---- HTTP ----
let gwPort = 0, idpPort = 0, caPem = "";
function request(o, body) {
  const t = Date.now();
  return new Promise((res) => {
    const req = (o.tls ? https : http).request({ host: "127.0.0.1", port: o.port, path: o.path, method: o.method ?? "GET", agent: false, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(o.tls ? { ca: caPem, servername: "localhost" } : {}), timeout: o.timeout ?? 30_000 }, (r) => {
      let b = ""; r.setEncoding("utf8"); r.on("data", (c) => { b += c; });
      r.on("end", () => { let json; try { json = JSON.parse(b); } catch { /* not JSON */ } res({ status: r.statusCode, body: b, json, ms: Date.now() - t }); });
      r.on("error", () => res({ status: "cut", body: "", ms: Date.now() - t }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => res({ status: "cut", body: e.code ?? e.message, ms: Date.now() - t }));
    req.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}
const gw = (path, token, method, body) => request({ port: gwPort, path, token, method }, body);
/** a JWT from the test identity provider (synthetic identity; see scripts/fixtures/test-idp.cjs) */
const token = async (claims = {}) => { const r = await request({ port: idpPort, path: "/token", method: "POST", tls: true }, claims); if (!r.json?.token) throw new Error(`the test identity provider issued no token: ${r.status} ${r.body}`); return r.json.token; };
const show = (r) => `${r.status} ${String(r.body).replace(/\s+/g, " ").slice(0, 150)}`;

// ---- application code a developer would write inside the generated service (the generated stubs return constants) ----
const PRODUCTS_CONTROLLER = `package com.pso.catalog.routes;

import com.pso.catalog.contracts.ProductsDto;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/products")
public class ProductsController {

    private final JdbcTemplate jdbc;

    public ProductsController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @PreAuthorize("hasAuthority('SCOPE_catalog:read')")
    @GetMapping
    public List<ProductsDto> list() {
        return jdbc.query("select id, name from products order by id", (rs, i) -> new ProductsDto(rs.getString("id"), rs.getString("name")));
    }
}
`;
const PRODUCT_ENTRIES_CONTROLLER = `package com.pso.catalog.routes;

import com.pso.catalog.contracts.ProductEntriesDto;
import jakarta.validation.Valid;
import java.security.Principal;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/product-entries")
public class ProductEntriesController {

    private final JdbcTemplate jdbc;

    public ProductEntriesController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Stores the product with the authenticated caller as its author: the identity comes from the verified token, never from the body. */
    @PreAuthorize("hasAuthority('SCOPE_catalog:write')")
    @PostMapping
    public ProductEntriesDto create(@Valid @RequestBody ProductEntriesDto body, Principal caller) {
        jdbc.update("insert into products (id, name, created_by) values (?, ?, ?)", body.id(), body.name(), caller.getName());
        return body;
    }
}
`;
const PRODUCTS_SQL = `create table products (
  id varchar(64) primary key,
  name varchar(120) not null,
  created_by varchar(200) not null
);
insert into products (id, name, created_by) values ('seed-1', 'Seeded by the migration', 'flyway');
`;

async function main() {
  if (logFile) writeFileSync(logFile, "");
  say(`# generated deployment validation ${new Date().toISOString()}\n# compose project: ${project}\n# workspace: ${ws}`);
  const before = outsiders();
  say(`# ${before.size} container(s) on this machine do not belong to the project; they are compared again at the end`);

  // ================= 1. generate =================
  say("\n== 1. generate (PSO CLI) ==");
  let t0 = Date.now();
  gwPort = await freePort(); idpPort = await freePort();
  let ok = pso(base, "create", "workspace", "shop").status === 0;
  ok &&= pso(ws, "create", "orchestrator", "gw", "--port", String(gwPort)).status === 0;
  ok &&= pso(ws, "create", "service", "catalog", "--runtime", "spring-boot", "--port", "8081", "--db", "postgres").status === 0;
  ok &&= pso(ws, "create", "service", "orders", "--runtime", "spring-boot", "--port", "8082").status === 0;
  ok &&= pso(ws, "make:resource", "products", "--service", "catalog", "--scopes", "catalog:read").status === 0;                               // GET  /products        -> catalog
  ok &&= pso(ws, "make:resource", "product-entries", "--service", "catalog", "--method", "POST", "--scopes", "catalog:write").status === 0;   // POST /product-entries -> catalog
  ok &&= pso(ws, "make:resource", "orders", "--service", "orders", "--scopes", "orders:read").status === 0;                                   // GET  /orders          -> orders (resource named like the service)
  ok &&= pso(ws, "make:resource", "shipments", "--service", "orders", "--public").status === 0;                                               // GET  /shipments       -> orders, public at the gateway
  // an action that COMPOSES its response from two services (UpstreamClient): the module, the controller and the declared route
  ok &&= pso(ws, "make:module", "overview", "--service", "gw").status === 0;
  ok &&= pso(ws, "make:controller", "overview", "--service", "gw").status === 0;
  ok &&= pso(ws, "make:route", "overview", "show", "--method", "GET", "--path", "/", "--compose", "catalog,orders", "--scopes", "catalog:read,orders:read", "--service", "gw").status === 0;
  ok &&= pso(ws, "make:migration", "create-products", "--service", "catalog").status === 0;
  ok &&= pso(ws, "dispatch:install", "redis", "--service", "gw").status === 0;
  ok &&= pso(ws, "dispatch:install", "rabbitmq", "--service", "orders").status === 0;
  check("generation", "workspace, orchestrator, two Spring services, four resources, a migration and two dispatch providers are generated by the CLI", ok);
  if (!ok) return;

  // application code (developer's): the catalog operations read and write PostgreSQL; the orders operation needs a role and returns the caller
  const routes = (svc) => join(ws, svc, "src", "main", "java", "com", "pso", svc, "routes");
  writeFileSync(join(routes("catalog"), "ProductsController.java"), PRODUCTS_CONTROLLER);
  writeFileSync(join(routes("catalog"), "ProductEntriesController.java"), PRODUCT_ENTRIES_CONTROLLER);
  writeFileSync(join(ws, "catalog", "src", "main", "resources", "db", "migration", "V1__create_products.sql"), PRODUCTS_SQL);
  const ordersFile = join(routes("orders"), "OrdersController.java");
  const generatedOrders = readFileSync(ordersFile, "utf8");
  check("generation", "make:resource orders --service orders declares the repeated path instead of generating a service that cannot start", /@RepeatsServicePrefix\r?\n@RequestMapping\("\/orders"\)/.test(generatedOrders));
  const orders = generatedOrders
    .replace(`@PreAuthorize("hasAuthority('SCOPE_orders:read')")`, `@PreAuthorize("hasAuthority('SCOPE_orders:read') and hasRole('manager')")`)
    .replace("public List<OrdersDto> list() {", "public List<OrdersDto> list(java.security.Principal caller) {")
    .replace("return List.of();", 'return List.of(new OrdersDto("order-of-" + caller.getName(), "orders service, authenticated as " + caller.getName()));');
  if (orders === generatedOrders || !orders.includes("hasRole('manager')") || !orders.includes("caller.getName()")) { check("generation", "the generated orders controller has the expected shape", false); return; }
  writeFileSync(ordersFile, orders);
  // the composing action (developer's code in the generated stub): both services are called with the caller's token, in parallel
  const overviewFile = join(ws, "gw", "src", "routes", "overview", "overview.controller.ts");
  const generatedOverview = readFileSync(overviewFile, "utf8");
  const overview = generatedOverview.replace(/\/\/ Compose the response[\s\S]*?\/\/ TODO: implement show\r?\n\s*return \{\};/, `const [products, orders] = await Promise.all([
      this.services.get<Array<{ id: string }>>("catalog", "/products", { credentials: "caller" }),
      this.services.get<Array<{ id: string }>>("orders", "/orders", { credentials: "caller" }),
    ]);
    return { products, orders };`);
  check("generation", "make:route --compose generates an action with the service client and declares the services it may call", overview !== generatedOverview && /private readonly services: UpstreamClient/.test(generatedOverview)
    && /metadata: \{ services: \["catalog","orders"\] \}/.test(readFileSync(join(ws, "gw", "src", "routes", "overview", "ROUTES.pso.ts"), "utf8")));
  writeFileSync(overviewFile, overview);
  check("generation", "pso types writes the service and guard names for the compiler", pso(ws, "types").status === 0 && /"catalog": true;[\s\S]*"orders": true;/.test(readFileSync(join(ws, "gw", "src", "pso-types.d.ts"), "utf8")));
  // one module whose action takes 12 s, for the shutdown check
  const slow = join(ws, "gw", "src", "routes", "slow");
  mkdirSync(slow, { recursive: true });
  writeFileSync(join(slow, "slow.controller.ts"), `import { Controller, RestController, Get, Public } from "@pso/http";\n\n@Controller()\n@RestController("/slow")\nexport class SlowController {\n  @Get("/12")\n  @Public()\n  async twelve() { await new Promise((r) => setTimeout(r, 12_000)); return { waited: 12_000 }; }\n}\n`);
  writeFileSync(join(slow, "ROUTES.pso.ts"), `import { defineRoutes } from "@pso/http";\nimport { SlowController } from "./slow.controller";\n\nexport default defineRoutes({ routes: [{ method: "GET", path: "/slow/12", controller: SlowController, action: "twelve", security: { public: true } }] });\n`);
  writeFileSync(join(slow, "MODULE.pso.ts"), `import { defineModule } from "@pso/core";\nimport slowRoutes from "./ROUTES.pso";\nimport { SlowController } from "./slow.controller";\n\nexport default defineModule({ name: "slow", controllers: [SlowController], providers: [], routes: slowRoutes, imports: [], exports: [] });\n`);
  // dispatch is enabled in this deployment, and an enabled dispatch needs at least one declared event per service
  const dsp = join(ws, "gw", "src", "dispatch", "audit");
  mkdirSync(join(dsp, "schemas"), { recursive: true });
  writeFileSync(join(dsp, "schemas", "recorded.schema.ts"), 'export default { type: "object", required: ["id"], properties: { id: { type: "string" } } };\n');
  writeFileSync(join(dsp, "EVENTS.pso.ts"), `import { defineEvents } from "@pso/dispatch";\n\nexport default defineEvents({\n  events: [{ name: "audit.recorded", version: 1, channel: "audit.events", schema: "schemas/recorded.schema.ts" }],\n  consumers: [],\n});\n`);
  writeFileSync(join(ws, "orders", "src", "main", "resources", "dispatch", "orders.events.json"), JSON.stringify({ events: [{ name: "orders.created", version: 1, channel: "orders.created", key: "orderId", schema: { type: "object", required: ["orderId"], properties: { orderId: { type: "string" } } } }] }, null, 2) + "\n");
  ok = pso(ws, "dispatch:lock").status === 0 && pso(ws, "dispatch:validate").status === 0 && pso(ws, "validate").status === 0;

  // secure deployment through the supported mechanisms: development certificates, then the deployment files
  ok &&= pso(ws, "tls:init", "--dev", "--hosts", "idp").status === 0;
  const init = pso(ws, "docker:init", "--vendor"); ok &&= init.status === 0;
  say(init.stdout.split(/\r?\n/).filter((l) => /^(NOTE|WARNING)/.test(l)).join("\n"));
  ok &&= pso(ws, "tls:check", "--hosts", "idp").status === 0;
  check("generation", "the workspace validates; `pso tls:init --dev`, `pso docker:init --vendor` and `pso tls:check` succeed", ok);
  if (!ok) return;
  const compose = readFileSync(join(ws, "docker-compose.yml"), "utf8");
  check("tls", "the generated compose file uses TLS for every upstream and authorizes no plaintext (no ALLOW_PLAINTEXT, no verification switch)",
    /PSO_UPSTREAM_CATALOG_TLS: "true"/.test(compose) && /PSO_UPSTREAM_ORDERS_TLS: "true"/.test(compose) && /PSO_UPSTREAM_CATALOG_TLS_CA_FILE: \/run\/pso\/tls\/ca\.crt/.test(compose)
    && !/ALLOW_PLAINTEXT/.test(compose) && !/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized|insecure/i.test(compose) && (compose.match(/SERVER_SSL_CERTIFICATE: file:/g) ?? []).length === 2);
  caPem = readFileSync(join(ws, "tls", "ca.crt"), "utf8");

  // what the deployment adds: .env (the documented "copy .env.example and fill in") and docker-compose.override.yml
  const dotenv = readFileSync(join(ws, ".env.example"), "utf8")
    .replace(/^PSO_JWT_ISSUER=.*$/m, "PSO_JWT_ISSUER=https://idp:8443")
    .replace(/^PSO_JWT_JWKS_URI=.*$/m, "PSO_JWT_JWKS_URI=https://idp:8443/.well-known/jwks.json")
    .replace(/^# PSO_JWT_JWKS_PRIVATE_HOSTS=.*$/m, "PSO_JWT_JWKS_PRIVATE_HOSTS=idp:8443")
    .replace(/^# PSO_JWT_JWKS_CA_FILE=.*$/m, "PSO_JWT_JWKS_CA_FILE=/run/pso/tls/ca.crt")
    .replace(/^# PSO_SHUTDOWN_GRACE_MS=.*$/m, "PSO_SHUTDOWN_GRACE_MS=15000");
  writeFileSync(join(ws, ".env"), dotenv);
  if (!/^PSO_JWT_JWKS_PRIVATE_HOSTS=idp:8443$/m.test(dotenv) || !/^PSO_JWT_JWKS_CA_FILE=/m.test(dotenv) || !/^PSO_SHUTDOWN_GRACE_MS=15000$/m.test(dotenv)) { check("generation", ".env.example offers the private identity provider and shutdown settings", false); return; }
  mkdirSync(join(ws, "idp"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "fixtures", "test-idp.cjs"), join(ws, "idp", "test-idp.cjs"));
  const key = () => randomBytes(32).toString("hex");
  composeEnv = { ...process.env, GW_DISPATCH_KEY: key(), ORDERS_DISPATCH_KEY: key(), DB_PASSWORD: key() };
  writeFileSync(join(ws, "docker-compose.override.yml"), `# Infrastructure of this deployment (not generated by PSO). Secrets come from the environment.
services:
  idp:   # TEST FIXTURE: a synthetic issuer (scripts/fixtures/test-idp.cjs); keys are generated when it starts
    image: node:24-alpine
    command: ["node", "/idp/test-idp.cjs"]
    environment: { IDP_ISSUER: "https://idp:8443", IDP_PORT: "8443", IDP_CERT: /run/pso/tls/tls.crt, IDP_KEY: /run/pso/tls/tls.key }
    volumes: ["./idp:/idp:ro", "./tls/idp:/run/pso/tls:ro"]
    ports: ["127.0.0.1:${idpPort}:8443"]
    healthcheck: { test: ["CMD", "node", "-e", "require('https').get({host:'localhost',port:8443,path:'/healthz',ca:require('fs').readFileSync('/run/pso/tls/ca.crt')},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"], interval: 3s, timeout: 3s, retries: 20 }
    networks: [internal]
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_DB: catalog, POSTGRES_USER: catalog, POSTGRES_PASSWORD: "\${DB_PASSWORD:?}" }
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U catalog -d catalog"], interval: 5s, timeout: 3s, retries: 20 }
    networks: [internal]
  redis:
    image: redis:7-alpine
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, timeout: 3s, retries: 20 }
    networks: [internal]
  rabbitmq:
    image: rabbitmq:3.13-alpine
    healthcheck: { test: ["CMD-SHELL", "nc -z 127.0.0.1 5672"], interval: 5s, timeout: 3s, retries: 40, start_period: 20s }
    networks: [internal]
  catalog:
    environment: { DB_URL: "jdbc:postgresql://postgres:5432/catalog", DB_USER: catalog, DB_PASSWORD: "\${DB_PASSWORD:?}" }
    depends_on: { postgres: { condition: service_healthy }, idp: { condition: service_healthy } }
  orders:
    environment: { PSO_DISPATCH_ENABLED: "true", RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672", PSO_DISPATCH_TRUST_MODE: required, PSO_DISPATCH_SIGNING_KEY: "\${ORDERS_DISPATCH_KEY:?}" }
    depends_on: { rabbitmq: { condition: service_healthy }, idp: { condition: service_healthy } }
  gw:
    environment: { PSO_DISPATCH_ENABLED: "true", REDIS_URL: "redis://redis:6379", PSO_DISPATCH_TRUST_MODE: required, PSO_DISPATCH_SIGNING_KEY: "\${GW_DISPATCH_KEY:?}" }
    depends_on: { redis: { condition: service_healthy }, idp: { condition: service_healthy } }
`);
  timings.generateMs = Date.now() - t0;

  // ================= 2. build =================
  say("\n== 2. build the images (docker compose build) ==");
  t0 = Date.now();
  const build = dcSay(["build"], 1_500_000);
  timings.buildMs = Date.now() - t0;
  if (!check("build", "docker compose build: the orchestrator image and both Spring images are built from the generated Dockerfiles", build.status === 0, build.status === 0 ? `${(timings.buildMs / 1000).toFixed(0)} s` : (build.stdout + build.stderr).split(/\r?\n/).slice(-12).join(" | "))) return;

  // ================= 3. start =================
  say("\n== 3. start the stack (docker compose up -d --wait) ==");
  t0 = Date.now();
  const up = dcSay(["up", "-d", "--wait", "--wait-timeout", "300"], 420_000);
  timings.startupMs = Date.now() - t0;
  const services = ["gw", "catalog", "orders", "idp", "postgres", "redis", "rabbitmq"];
  check("startup", "docker compose up -d --wait succeeds on the first attempt", up.status === 0, up.status === 0 ? `${(timings.startupMs / 1000).toFixed(0)} s` : (up.stdout + up.stderr).split(/\r?\n/).filter((l) => /unhealthy|Error|error/.test(l)).slice(-4).join(" | "));
  for (const s of services) check("startup", `${s} is running and healthy`, health(s) === "running/healthy", health(s));
  for (const s of ["gw", "catalog", "orders"]) check("startup", `${s} started once (no container restart was needed)`, inspect(cid(s), "{{.RestartCount}}") === "0", `RestartCount ${inspect(cid(s), "{{.RestartCount}}")}`);
  if (services.some((s) => health(s) !== "running/healthy")) { for (const s of ["gw", "catalog", "orders"]) if (health(s) !== "running/healthy") say(`--- ${s}: last error lines ---\n${errorLines(s)}`); return; }

  // ================= 4. health, readiness, discovery =================
  say("\n== 4. health, readiness, transport ==");
  const live = await gw("/health/live"), ready = await gw("/health/ready");
  say(`GET /health/live  -> ${show(live)}\nGET /health/ready -> ${show(ready)}`);
  check("health", "gateway /health/live answers 200", live.status === 200);
  check("readiness", "gateway /health/ready answers 200: status UP, both upstreams, dispatch (Redis) UP", ready.status === 200 && ready.json?.status === "UP" && ready.json?.upstreams === 2 && ready.json?.checks?.dispatch?.status === "UP");
  for (const [s, port] of [["catalog", 8081], ["orders", 8082]]) {
    const h = dc(["exec", "-T", s, "curl", "-fsS", "--cacert", "/run/pso/tls/ca.crt", `https://localhost:${port}/actuator/health`]);
    const clear = dc(["exec", "-T", s, "curl", "-s", "-o", "/dev/null", "-m", "4", "-w", "%{http_code}", `http://localhost:${port}/actuator/health`]);
    check("health", `${s} answers its health over HTTPS on its own port ${port}, with a certificate verified against the authority`, h.status === 0 && /"status":"UP"/.test(h.stdout), h.stdout.trim() || h.stderr.trim());
    check("tls", `${s} does not serve plain HTTP on that port`, clear.stdout.trim() !== "200", `plain HTTP -> ${clear.stdout.trim()}`);
  }
  const gwLines = jsonLines(logs("gw"));
  const configured = gwLines.filter((l) => l.msg === "upstream configured");
  say(configured.map((l) => `gw log: upstream configured service=${l.service} tls=${l.tls} plaintext=${l.plaintext ?? false}`).join("\n"));
  check("tls", "the orchestrator configured both upstreams with TLS and none in clear text", configured.length === 2 && configured.every((l) => l.tls === true && !l.plaintext) && !gwLines.some((l) => /plain HTTP/.test(l.msg ?? "")));
  check("startup", "the orchestrator runs in production mode and loaded the issuer's keys from the private identity provider on its first start", gwLines.some((l) => l.msg === "starting orchestrator" && l.environment === "production") && !gwLines.some((l) => l.msg === "startup failed"));

  // ================= 5. authentication =================
  say("\n== 5. authentication (tokens from the test identity provider, through the gateway) ==");
  const run = randomBytes(4).toString("hex");
  const reader = await token({ sub: `reader-${run}`, scope: "catalog:read" });
  const writer = await token({ sub: `writer-${run}`, scope: "catalog:read catalog:write" });
  const manager = await token({ sub: `manager-${run}`, scope: "orders:read", roles: ["manager"] });
  const clerk = await token({ sub: `clerk-${run}`, scope: "orders:read", roles: ["clerk"] });
  const list1 = await gw("/products", reader);
  say(`GET /products (valid token, catalog:read) -> ${show(list1)}`);
  check("authentication", "a valid JWT reaches the catalog service: GET /products returns the rows of the database (the migration's seed row)", list1.status === 200 && Array.isArray(list1.json) && list1.json.some((p) => p.id === "seed-1"));
  const cases = [
    ["no token", undefined],
    ["an expired token", await token({ sub: "x", scope: "catalog:read", expiresIn: -600 })],
    ["a token of another issuer", await token({ sub: "x", scope: "catalog:read", iss: "https://someone-else.example" })],
    ["a token for another audience", await token({ sub: "x", scope: "catalog:read", aud: "another-api" })],
    ["a token with an invalid signature (signed by a key the issuer does not publish)", await token({ sub: "x", scope: "catalog:read", forge: true })],
    ["a malformed token", "not.a.jwt"],
  ];
  const catalogLogBefore = logs("catalog").length;
  for (const [what, tk] of cases) { const r = await gw("/products", tk); say(`GET /products with ${what} -> ${r.status}`); check("authentication", `${what} is refused by the gateway with 401`, r.status === 401); }
  await sleep(500);
  check("authentication", "none of the refused requests reached the service", !/products/.test(logs("catalog").slice(catalogLogBefore)));

  // ================= 6. authorization and business operations =================
  say("\n== 6. authorization and business operations ==");
  const id = `p-${run}`;
  const denied = await gw("/product-entries", reader, "POST", { id, name: "must not be stored" });
  say(`POST /product-entries with catalog:read only -> ${show(denied)}`);
  check("authorization", "a token without the required scope is refused by the gateway with 403", denied.status === 403);
  const created = await gw("/product-entries", writer, "POST", { id, name: `Created in run ${run}` });
  say(`POST /product-entries with catalog:write -> ${show(created)}`);
  check("business", "an authorized POST stores a product through the gateway and the service", created.status === 200 && created.json?.id === id);
  const row = dc(["exec", "-T", "postgres", "psql", "-U", "catalog", "-d", "catalog", "-tAc", `select name || '|' || created_by from products where id = '${id}'`]);
  say(`PostgreSQL: products[${id}] = ${row.stdout.trim()}`);
  check("business", "the row is in PostgreSQL with the authenticated caller as its author (the token's subject, verified by the service)", row.stdout.trim() === `Created in run ${run}|writer-${run}`, row.stdout.trim() || row.stderr.trim());
  const refused = dc(["exec", "-T", "postgres", "psql", "-U", "catalog", "-d", "catalog", "-tAc", "select count(*) from products where name = 'must not be stored'"]);
  check("business", "the refused request stored nothing", refused.stdout.trim() === "0", refused.stdout.trim());
  const list2 = await gw("/products", reader);
  check("business", "GET /products now returns the new row as well", list2.status === 200 && list2.json?.some((p) => p.id === id) && list2.json?.some((p) => p.id === "seed-1"));
  const invalid = await gw("/product-entries", writer, "POST", { id: "", name: "" });
  check("business", "DTO validation of the service answers 400 for an invalid body", invalid.status === 400, show(invalid));
  const asManager = await gw("/orders", manager), asClerk = await gw("/orders", clerk), wrongScope = await gw("/orders", reader);
  say(`GET /orders as manager -> ${show(asManager)}\nGET /orders as clerk (scope, no role) -> ${show(asClerk)}\nGET /orders with a catalog token -> ${wrongScope.status}`);
  check("authorization", "the orders service authenticates the forwarded token itself: it answers with the caller's identity", asManager.status === 200 && asManager.json?.[0]?.id === `order-of-manager-${run}`);
  check("authorization", "a role the gateway does not check is enforced by the Spring service: scope without the role is 403 from the service", asClerk.status === 403);
  check("authorization", "a token without the route's scope is 403 at the gateway", wrongScope.status === 403);
  // composition: one request to the gateway, two services, one response
  const lead = await token({ sub: `lead-${run}`, scope: "catalog:read orders:read", roles: ["manager"] });
  const composed = await gw("/overview", lead);
  say(`GET /overview (composes catalog and orders) -> ${show(composed)}`);
  check("business", "an orchestrator action composes one response from two services over verified HTTPS; each service authenticated the caller's token itself",
    composed.status === 200 && Array.isArray(composed.json?.products) && composed.json.products.some((p) => p.id === "seed-1") && composed.json?.orders?.[0]?.id === `order-of-lead-${run}`, show(composed));
  const noRole = await gw("/overview", await token({ sub: `assistant-${run}`, scope: "catalog:read orders:read", roles: ["clerk"] }));
  say(`GET /overview with the scopes but without the role the orders service requires -> ${show(noRole)}`);
  check("authorization", "a refusal by one of the composed services is a stable gateway problem (502 PSO_UPSTREAM_REJECTED) that carries nothing of that service's answer", noRole.status === 502 && noRole.json?.code === "PSO_UPSTREAM_REJECTED" && !/order-of|seed-1/.test(String(noRole.body)), show(noRole));
  const overviewAnonymous = await gw("/overview"), overviewWrongScope = await gw("/overview", reader);
  check("authorization", "the composing route is protected like any other: 401 without a token, 403 without its scopes", overviewAnonymous.status === 401 && overviewWrongScope.status === 403, `${overviewAnonymous.status} / ${overviewWrongScope.status}`);
  const pub = await gw("/shipments");
  say(`GET /shipments (public at the gateway, no token) -> ${show(pub)}`);
  check("authorization", "a route that is public at the gateway is still protected by the service: no token, 401 from Spring", pub.status === 401);

  // ================= 7. TLS verification =================
  say("\n== 7. TLS verification between the orchestrator and the services ==");
  const forwarded = jsonLines(logs("gw")).filter((l) => l.msg === "bearer token not forwarded to upstream");
  check("tls", "the token was forwarded over verified HTTPS (the 200 answers above) and never withheld on these routes", forwarded.length === 0 && asManager.status === 200 && list1.status === 200, `${forwarded.length} withheld`);
  // a second orchestrator of the same image and configuration, with one setting changed, on its own port
  const variant = async (name, extra, probe) => {
    const port = await freePort();
    const cname = `${project}-variant-${name}`;
    const r = sh("docker", ["compose", "-p", project, "run", "-d", "--no-deps", "--name", cname, "-p", `127.0.0.1:${port}:${gwPort}`, ...extra, "gw"], { cwd: ws, env: composeEnv, timeout: 120_000 });
    try {
      if (r.status !== 0) return { error: (r.stderr || r.stdout).slice(-300) };
      await until(async () => (await request({ port, path: "/health/live", timeout: 3000 })).status === 200 || inspect(cname, "{{.State.Running}}") !== "true", 60_000, 500);
      const running = inspect(cname, "{{.State.Running}}") === "true";
      const out = sh("docker", ["logs", cname]);
      return { running, exit: inspect(cname, "{{.State.ExitCode}}"), log: `${out.stdout}${out.stderr}`, answer: running && probe ? await request({ port, path: probe, token: reader }) : undefined };
    } finally { sh("docker", ["rm", "-f", cname], { timeout: 60_000 }); }
  };
  writeFileSync(join(ws, "tls", "another-ca.crt"), sh(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(join(ROOT, "packages", "core", "dist", "index.js"))}).createDevCertificate({ commonName: "another authority", ca: true }).certPem)`]).stdout);
  const untrusted = await variant("untrusted", ["-v", `${join(ws, "tls", "another-ca.crt")}:/run/pso/another-ca.crt:ro`, "-e", "PSO_UPSTREAM_CATALOG_TLS_CA_FILE=/run/pso/another-ca.crt"], "/products");
  say(`orchestrator trusting another authority for catalog: GET /products -> ${untrusted.answer ? show(untrusted.answer) : JSON.stringify(untrusted).slice(0, 300)}`);
  check("tls", "a service certificate that the configured authority did not sign is refused: 502 upstream_tls, nothing is sent", untrusted.answer?.status === 502 && /upstream[_-]tls/.test(untrusted.answer.body));
  const wrongName = await variant("wrongname", ["-e", "PSO_UPSTREAM_CATALOG_TLS_SERVER_NAME=billing"], "/products");
  say(`orchestrator expecting the certificate to name "billing": GET /products -> ${wrongName.answer ? show(wrongName.answer) : JSON.stringify(wrongName).slice(0, 300)}`);
  check("tls", "a certificate that does not carry the expected name is refused: 502 upstream_tls", wrongName.answer?.status === 502 && /upstream[_-]tls/.test(wrongName.answer.body));
  const noTls = await variant("notls", ["-e", "PSO_UPSTREAM_CATALOG_TLS=", "-e", "PSO_UPSTREAM_CATALOG_TLS_CA_FILE="]);
  const why = (noTls.log ?? "").split(/\r?\n/).find((l) => /startup failed/.test(l)) ?? "";
  say(`orchestrator with the TLS settings of catalog removed -> ${noTls.running ? "running" : `exit ${noTls.exit}`}\n${why.slice(0, 420)}`);
  check("tls", "without TLS for an upstream the production orchestrator refuses to start (exit 1) and names the upstream; plaintext is never a fallback", noTls.running === false && noTls.exit === "1" && /catalog: production requires TLS to non-loopback upstreams/.test(why) && !/orders: production requires/.test(why));
  const noIdpApproval = await variant("noapproval", ["-e", "PSO_JWT_JWKS_PRIVATE_HOSTS="]);
  const whyIdp = (noIdpApproval.log ?? "").split(/\r?\n/).filter((l) => /security initialization failed|startup failed/.test(l)).join(" ");
  say(`orchestrator without the approval of the private identity provider -> ${noIdpApproval.running ? "running" : `exit ${noIdpApproval.exit}`} ${whyIdp.slice(0, 300)}`);
  check("tls", "without the explicit approval the identity provider on the private network is refused (blocked address) and the orchestrator does not start", noIdpApproval.running === false && noIdpApproval.exit === "1" && /jwks_blocked_address/.test(whyIdp));
  const noIdpCa = await variant("noidpca", ["-e", "PSO_JWT_JWKS_CA_FILE="]);
  const whyCa = (noIdpCa.log ?? "").split(/\r?\n/).filter((l) => /security initialization failed/.test(l)).join(" ");
  say(`orchestrator without the certificate authority of the identity provider -> ${noIdpCa.running ? "running" : `exit ${noIdpCa.exit}`} ${whyCa.slice(0, 300)}`);
  check("tls", "without the identity provider's certificate authority its certificate is not trusted (jwks_tls, not retried) and the orchestrator does not start", noIdpCa.running === false && noIdpCa.exit === "1" && /jwks_tls/.test(whyCa) && /\(1 attempt in/.test(whyCa));

  // ================= 8. routing =================
  say("\n== 8. routing ==");
  const missing = await gw("/nothing-here", reader);
  dcSay(["stop", "orders"]);
  const p2 = await gw("/products", reader), o2 = await gw("/orders", manager);
  say(`with orders stopped: GET /products -> ${p2.status}; GET /orders -> ${show(o2)}`);
  check("routing", "GET /products is served by catalog: it still answers 200 with orders stopped", p2.status === 200);
  check("routing", "GET /orders is served by orders: 200 before, an upstream failure (503 or 504) once orders is stopped", asManager.status === 200 && (o2.status === 503 || o2.status === 504));
  check("routing", "an undeclared path is 404 at the gateway", missing.status === 404);

  // ================= 9. restart single services =================
  say("\n== 9. restart single services ==");
  const gwStarted = inspect(cid("gw"), "{{.State.StartedAt}}");
  dcSay(["start", "orders"]);
  check("restart", "orders comes back healthy after a stop/start", await until(() => health("orders") === "running/healthy", 180_000, 2000), health("orders"));
  dcSay(["restart", "catalog"]);
  const catBack = await until(() => health("catalog") === "running/healthy", 180_000, 2000);
  const p3 = await gw("/products", reader), o3 = await gw("/orders", manager);
  say(`after the restarts: GET /products -> ${p3.status} (${p3.json?.length} rows); GET /orders -> ${o3.status}`);
  check("restart", "catalog comes back healthy; authenticated requests to both services succeed and the stored row is still there", catBack && p3.status === 200 && p3.json?.some((p) => p.id === id) && o3.status === 200);
  check("restart", "the gateway was not restarted by either operation", inspect(cid("gw"), "{{.State.StartedAt}}") === gwStarted);

  // ================= 10. recovery =================
  say("\n== 10. recovery: Redis, identity provider, key rotation ==");
  dcSay(["stop", "redis"]);
  const notReady = await until(async () => (await gw("/health/ready")).status === 503, 60_000);
  const nr = await gw("/health/ready");
  say(`with Redis stopped: GET /health/ready -> ${show(nr)}; GET /health/live -> ${(await gw("/health/live")).status}; GET /products -> ${(await gw("/products", reader)).status}`);
  dcSay(["start", "redis"]);
  const readyAgain = await until(async () => (await gw("/health/ready")).status === 200, 90_000);
  check("recovery", "/health/ready turns 503 when Redis (required by dispatch) is gone and 200 again when it is back; liveness stays 200", notReady && readyAgain && nr.json?.checks?.dispatch?.status === "DOWN");

  // the identity provider goes away while the orchestrator runs: cached keys keep verifying; nothing unverified is accepted
  dcSay(["stop", "idp"]);
  const cached = await gw("/products", reader), forgedWhileDown = await gw("/products", cases[4][1]);
  say(`identity provider stopped: GET /products with a valid token -> ${cached.status}; with an invalid signature -> ${forgedWhileDown.status}`);
  check("recovery", "with the identity provider down, a valid token is still verified with the cached keys and an invalid one is still refused", cached.status === 200 && forgedWhileDown.status === 401);
  // the orchestrator is started while its identity provider is unavailable, and the provider comes back a few seconds later
  dcSay(["stop", "gw"], 60_000);
  const since = new Date().toISOString();
  const restartsBefore = inspect(cid("gw"), "{{.RestartCount}}");
  const tStart = Date.now();
  // the container itself is started (docker start), so nothing else is started along with it
  const startOnly = sh("docker", ["start", cid("gw")]); say(`$ docker start <gw>   (exit ${startOnly.status})`);
  await sleep(6000);
  const idpDownMeanwhile = inspect(cid("idp"), "{{.State.Running}}") === "false";
  const stillStarting = (await gw("/health/ready")).status !== 200 && inspect(cid("gw"), "{{.State.Running}}") === "true";
  dcSay(["start", "idp"]);
  const recovered = await until(async () => (await gw("/health/ready")).status === 200, 60_000, 500);
  const recoveryMs = Date.now() - tStart;
  const startLog = jsonLines(logs("gw", since));
  const retries = startLog.filter((l) => l.msg === "key refresh failed").length;
  say(`orchestrator started without its identity provider: after 6 s ${stillStarting ? "still starting (not ready, not exited)" : "NOT in the expected state"}; ready ${recovered ? `${recoveryMs} ms after its start` : "never"}; ${retries} failed key load(s) logged; RestartCount ${restartsBefore} -> ${inspect(cid("gw"), "{{.RestartCount}}")}`);
  if (!recovered) say(errorLines("gw"));
  check("recovery", "an orchestrator started while the identity provider is down keeps retrying within its deadline and is not ready meanwhile", idpDownMeanwhile && stillStarting && retries >= 1, `identity provider down: ${idpDownMeanwhile}; ${retries} failed load(s)`);
  check("recovery", "when the identity provider returns, the SAME process loads the keys and becomes ready: no exit, no container restart", recovered && inspect(cid("gw"), "{{.RestartCount}}") === restartsBefore && !startLog.some((l) => l.msg === "startup failed"));
  // the provider restarted with NEW keys (the fixture generates them at start): a token of the current key is accepted end to end
  const afterRestart = await token({ sub: `reader-${run}`, scope: "catalog:read" });
  const acceptedAfter = await until(async () => (await gw("/products", afterRestart)).status === 200, 90_000, 2000);
  check("recovery", "after the recovery a token signed with the provider's current key is accepted end to end (gateway and service)", acceptedAfter);
  const rot = await request({ port: idpPort, path: "/rotate", method: "POST", tls: true }, {});
  const rotated = await token({ sub: `manager-${run}`, scope: "orders:read catalog:read", roles: ["manager"] });
  const tRot = Date.now();
  const rotGw = await until(async () => (await gw("/products", rotated)).status === 200, 120_000, 2000);
  const rotGwMs = Date.now() - tRot;
  const rotSvc = await until(async () => (await gw("/orders", rotated)).status === 200, 120_000, 2000);
  say(`key rotation (${rot.json?.signingKey}): a token of the new key is accepted through the catalog route after ${rotGwMs} ms and through the orders route ${rotSvc ? `after ${Date.now() - tRot} ms` : "never"}`);
  check("recovery", "key rotation: a token signed with a newly published key is accepted by the gateway and by both Spring services without any restart", rotGw && rotSvc, `${rotGwMs} ms`);
  check("recovery", "a token signed with the previous key, which is still published, remains valid", (await gw("/products", afterRestart)).status === 200);

  // ================= 11. graceful shutdown =================
  say("\n== 11. graceful shutdown of the generated process in its container: grace period 15 s, request 12 s ==");
  const graceEnv = inspect(cid("gw"), "{{range .Config.Env}}{{println .}}{{end}}").split(/\r?\n/).find((e) => e.startsWith("PSO_SHUTDOWN_GRACE_MS=")) ?? "";
  const gwId = cid("gw");
  const sinceStop = new Date().toISOString();
  const longReq = request({ port: gwPort, path: "/slow/12", timeout: 60_000 });
  await sleep(1500);
  const ts = Date.now();
  const stop = dcSay(["stop", "gw"], 90_000);
  const stopMs = Date.now() - ts;
  const lr = await longReq;
  const exit = inspect(gwId, "{{.State.ExitCode}}");
  const tail = jsonLines(logs("gw", sinceStop)).filter((l) => /shut|in-flight|grace/.test(l.msg ?? ""));
  say(`${graceEnv}\nrequest: ${lr.status} after ${lr.ms} ms ${String(lr.body).slice(0, 60)}\ndocker compose stop gw took ${stopMs} ms; exit code ${exit}\nstop issued ${new Date(ts).toISOString()}; container finished ${inspect(gwId, "{{.State.FinishedAt}}")}; command returned ${new Date(ts + stopMs).toISOString()}`);
  say(tail.map((l) => `gw log: ${l.level} ${l.msg} ${JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !["ts", "level", "msg"].includes(k))))}`).join("\n"));
  check("shutdown", "the configured grace period is 15 s and the derived deadline is 26 s", graceEnv === "PSO_SHUTDOWN_GRACE_MS=15000" && tail.some((l) => l.msg === "shutting down" && l.deadlineMs === 26_000));
  check("shutdown", "the 12 s request completed with 200 after SIGTERM", lr.status === 200 && lr.ms >= 11_900, `${lr.status} after ${lr.ms} ms`);
  check("shutdown", "the process waited for it (past the former 10 s limit, less than the period), completed its shutdown and exited 0", stop.status === 0 && stopMs > 10_000 && stopMs < 15_000 && exit === "0" && tail.some((l) => l.msg === "shutdown complete" && l.exitCode === 0), `${stopMs} ms, exit ${exit}`);
  dcSay(["start", "gw"]);
  const gwBack = await until(async () => (await gw("/health/ready")).status === 200, 120_000);
  if (!gwBack) say(errorLines("gw"));
  check("shutdown", "the gateway starts again and becomes ready", gwBack);

  // ================= 12. stop and start the whole stack =================
  say("\n== 12. stop the whole stack, start it again ==");
  const ids = Object.fromEntries(services.map((s) => [s, cid(s)]));
  const tsAll = Date.now();
  const stopAll = dcSay(["stop"], 180_000);
  const stopAllMs = Date.now() - tsAll;
  const codes = Object.fromEntries(services.map((s) => [s, inspect(ids[s], "{{.State.ExitCode}}")]));
  say(`exit codes: ${JSON.stringify(codes)}`);
  check("shutdown", "docker compose stop ends every container within its stop period (no SIGKILL: no exit code 137)", stopAll.status === 0 && Object.values(codes).every((c) => c !== "137") && stopAllMs < 90_000, `${stopAllMs} ms`);
  check("shutdown", "the orchestrator exits 0; the Spring services end by their graceful shutdown (143, the JVM's answer to SIGTERM, or 0)", codes.gw === "0" && ["catalog", "orders"].every((s) => codes[s] === "143" || codes[s] === "0"), JSON.stringify(codes));
  const again = dcSay(["up", "-d", "--wait", "--wait-timeout", "300"], 420_000);
  const fresh = await token({ sub: `reader-${run}`, scope: "catalog:read" }).catch(() => undefined);
  const afterAll = fresh ? await gw("/products", fresh) : { status: "no token" };
  check("restart", "the stack starts again; every service is healthy and an authenticated request returns the stored data", again.status === 0 && services.every((s) => health(s) === "running/healthy") && afterAll.status === 200 && afterAll.json?.some((p) => p.id === id), `GET /products -> ${afterAll.status}`);

  const after = outsiders();
  let same = true; for (const [cidOther, st] of before) if (after.get(cidOther) !== st) { same = false; say(`CHANGED outside the project: ${st} -> ${after.get(cidOther) ?? "(gone)"}`); }
  check("isolation", `no container outside the project changed (${before.size} compared: same identity, start time and restart count)`, same);
}

let crashed;
if (sh("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 }).status !== 0) { say("the Docker engine is not running: nothing was validated"); if (reportFile) writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), ok: false, skipped: "the Docker engine is not running" }, null, 2) + "\n"); process.exit(2); }
try { await main(); } catch (e) { crashed = String(e.stack ?? e); say(`ERROR ${crashed}`); }
finally {
  if (args.includes("--keep")) say(`\nkept: docker compose -p ${project} (in ${ws})`);
  else {
    say("\n== cleanup (this project only) ==");
    const d = dcSay(["down", "-v", "--rmi", "local", "--remove-orphans", "--timeout", "45"], 240_000);
    const left = sh("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]).stdout.trim();
    const net2 = sh("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]).stdout.trim();
    check("cleanup", "the project's containers, network, volumes and images are removed", d.status === 0 && left === "" && net2 === "");
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* the OS reaps temp */ }
  }
  const all = SECTIONS.flatMap((s) => report[s].checks.map((c) => ({ section: s, ...c })));
  const bad = all.filter((c) => !c.ok);
  // a section without any check means the run stopped before it: that is not a pass
  const missing = SECTIONS.filter((s) => report[s].checks.length === 0 && !(s === "cleanup" && args.includes("--keep")));
  const ok = !crashed && bad.length === 0 && missing.length === 0;
  say(`\n${all.length} check(s): ${all.length - bad.length} passed, ${bad.length} failed${bad.length ? `\n${bad.map((b) => `  FAILED [${b.section}] ${b.name}${b.detail ? `: ${b.detail}` : ""}`).join("\n")}` : ""}${missing.length ? `\nNOT REACHED: ${missing.join(", ")}` : ""}`);
  say(`duration ${((Date.now() - startedAt) / 1000).toFixed(0)} s (build ${((timings.buildMs ?? 0) / 1000).toFixed(0)} s, first start ${((timings.startupMs ?? 0) / 1000).toFixed(0)} s)`);
  say(`GENERATED DEPLOYMENT: ${ok ? "VALIDATED" : "NOT VALIDATED"}`);
  if (reportFile) writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), project, ok, durationMs: Date.now() - startedAt, timings, total: all.length, passed: all.length - bad.length, failed: bad, notReached: missing, ...(crashed ? { error: crashed.slice(0, 2000) } : {}), sections: report }, null, 2) + "\n");
  process.exit(ok ? 0 : 1);
}
