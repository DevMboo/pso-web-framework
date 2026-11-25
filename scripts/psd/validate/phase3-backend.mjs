// Phase 3: a real application generated, built and run with ONLY the installed protected distribution (isolated profile).
// Generates a workspace, an orchestrator and two Spring Boot services, builds them, starts them and calls them over HTTP with and without credentials.
//   node scripts/psd/validate/phase3-backend.mjs --label 0.1.0-alpha.1
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { Evidence, makeIso, node, run } from "./iso.mjs";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const label = a[a.indexOf("--label") + 1] ?? "0.1.0-alpha.1";
const K = join(process.env.USERPROFILE, ".pso-psd");
const ev = new Evidence(join(repo, "docs", "implementation", "evidence", "psd", label, "validation-backend.json"));
const iso = makeIso(join(K, "validation", "iso-dev"), { fresh: false });
const ver = join(iso.root, "pso", "versions", label);
const cli = join(ver, "node_modules", "@pso", "cli", "bin", "pso.js");
const pso = (args, o = {}) => node(iso, [cli, ...args], o);
const ws = join(iso.work, "shop");
const PORT = { gw: 3101, cat: 8181, ord: 8182 };

const http = (port, method, path, { token, body, headers = {} } = {}) => new Promise((res) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers }, timeout: 15_000 }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: b })); });
  req.on("error", (e) => res({ status: 0, body: String(e.message), headers: {} })); req.on("timeout", () => { req.destroy(); res({ status: 0, body: "timeout", headers: {} }); });
  if (data) req.write(data); req.end();
});
const until = async (fn, ms, step = 1500) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await new Promise((r) => setTimeout(r, step)); } };
const kill = (child) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); else if (typeof child?.kill === "function") child.kill(); };

rmSync(ws, { recursive: true, force: true });

// ---- generation with the installed CLI
let r = pso(["create", "workspace", "shop"], { cwd: iso.work }); ev.check("create workspace", r.status === 0, r.err);
for (const args of [["create", "orchestrator", "gateway", "--port", String(PORT.gw)], ["create", "service", "catalog", "--runtime", "spring-boot", "--port", String(PORT.cat)], ["create", "service", "orders", "--runtime", "spring-boot", "--port", String(PORT.ord)]]) { r = pso(args, { cwd: ws }); ev.check(`pso ${args.slice(0, 3).join(" ")}`, r.status === 0, r.err || r.out.split("\n")[0]); }
r = pso(["make:resource", "customer", "--service", "catalog", "--route", "/customers", "--scopes", "customers:read"], { cwd: ws }); ev.check("make:resource customer (route + contract in the orchestrator, controller + DTO + test in the Spring service)", r.status === 0, r.err.slice(0, 200));
r = pso(["make:resource", "order", "--service", "orders", "--route", "/orders", "--scopes", "orders:read"], { cwd: ws }); ev.check("make:resource order", r.status === 0, r.err.slice(0, 200));
r = pso(["make:route", "customer", "create", "--method", "POST", "--path", "/", "--guard", "jwt", "--scopes", "customers:write", "--upstream", "catalog", "--service", "gateway"], { cwd: ws }); ev.check("make:route POST /customers (declared, decorated, kept consistent)", r.status === 0, r.err.slice(0, 200));
r = pso(["make:dto", "customer", "create-customer", "--fields", "name:string:min=3,email:email,age?:integer:min=18", "--service", "gateway"], { cwd: ws }); ev.check("make:dto with validation rules", r.status === 0, r.err.slice(0, 200));
r = pso(["make:route", "customer", "validate", "--method", "POST", "--path", "/validate", "--guard", "jwt", "--scopes", "customers:write", "--service", "gateway"], { cwd: ws }); ev.check("make:route POST /customers/validate (a route the gateway answers itself)", r.status === 0, r.err.slice(0, 200));
{
  // implement the generated action with a validated body: `@Body(Dto)` is the documented way to validate in the orchestrator
  const file = join(ws, "gateway", "src", "routes", "customer", "customer.controller.ts");
  let src = readFileSync(file, "utf8");
  src = src.replace(/@Post\("\/validate"\)[\s\S]*?\n  }\n/, `@Post("/validate")\n  async validate(@Body(CreateCustomerDto) body: CreateCustomerDto) {\n    return { accepted: body.name, email: body.email };\n  }\n`);
  src = src.replace(/import \{([^}]*)\} from "@pso\/http";/, (m, names) => (/\bBody\b/.test(names) ? m : `import {${names.replace(/\s+$/, "")}, Body } from "@pso/http";`));
  src = `import { CreateCustomerDto } from "./dto/create-customer.dto";\n` + src;
  writeFileSync(file, src);
  ev.check("the validate action uses @Body(CreateCustomerDto)", /@Body\(CreateCustomerDto\)/.test(src), src.slice(0, 0));
}
r = pso(["make:middleware", "audit", "--service", "gateway"], { cwd: ws }); ev.check("make:middleware", r.status === 0, r.err.slice(0, 200));
r = pso(["database:enable", "h2", "--service", "catalog"], { cwd: ws }); ev.check("database:enable h2 (Spring persistence starter)", r.status === 0, r.err.slice(0, 200));

// ---- structural discovery and validation (static, nothing executed)
r = pso(["lint"], { cwd: ws }); ev.check("pso lint (structural discovery, routes, contracts, security) reports exactly the expected finding: JWT guard used but no issuer/audience/key configured yet (SEC005)", r.status === 1 && /SEC005/.test(r.out) && !/ERROR\s+(?!SEC005)/.test(r.out), r.out.split("\n").slice(0, 3).join(" | ") + r.err.slice(0, 100));
r = pso(["routes:list"], { cwd: ws }); ev.check("routes:list shows the declared routes with their guards", /\/customers/.test(r.out) && /jwt/.test(r.out) && /\/orders/.test(r.out), r.out.split("\n").slice(0, 4).join(" | "));
r = pso(["graph"], { cwd: ws }); ev.check("graph", r.status === 0 && /catalog/.test(r.out) && /orders/.test(r.out));

// ---- keys, then build and start the orchestrator
r = pso(["security:keys", "--generate", "--json"], { cwd: ws }); ev.check("security:keys --generate", r.status === 0, r.err.slice(0, 200));
const keysDir = join(ws, "keys"); const pubPem = join(keysDir, readdirSync(keysDir).find((f) => f.endsWith(".public.pem")) ?? "none");
const privPem = join(keysDir, readdirSync(keysDir).find((f) => f.endsWith(".private.pem")) ?? "none");
const gw = join(ws, "gateway");
const t0 = Date.now();
r = run(iso, "npm.cmd", ["install", "--no-audit", "--no-fund"], { cwd: gw, shell: true, timeout: 600_000 });
ev.check("npm install in the generated orchestrator (framework packages from the installed protected distribution)", r.status === 0, `${Date.now() - t0} ms ${r.err.split("\n").slice(-2).join(" ")}`);
r = run(iso, "npm.cmd", ["run", "build"], { cwd: gw, shell: true, timeout: 300_000 });
ev.check("npm run build (tsc) of the generated orchestrator against the protected packages' declarations", r.status === 0 && existsSync(join(gw, "dist", "main.js")), r.out.slice(-300));

const children = [];
try {
  const env = { ...iso.env, PORT: String(PORT.gw), PSO_WORKSPACE: join(ws, "pso.workspace.json"), PSO_JWT_ISSUER: "https://shop.local", PSO_JWT_AUDIENCE: "shop-api", PSO_JWT_PUBLIC_KEY_FILE: pubPem, PSO_JWT_ALGORITHMS: "ES256", PSO_LOG_FORMAT: "json", PSO_ENV: "development" };
  const orch = spawn(process.execPath, ["dist/main.js"], { cwd: gw, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(orch);
  let logs = ""; orch.stdout.on("data", (c) => (logs += c)); orch.stderr.on("data", (c) => (logs += c));
  const up = await until(async () => (await http(PORT.gw, "GET", "/health/live")).status === 200 || /orchestrator listening/.test(logs), 40_000);
  ev.check("the orchestrator starts from the generated project", !!up, logs.slice(-300));

  // tokens: signed with the generated ES256 key by the installed jose
  const jose = await import(pathToUrl(join(ver, "node_modules", "jose", "dist", "webapi", "index.js")));
  const { createPrivateKey } = await import("node:crypto");
  const key = createPrivateKey(readFileSync(privPem));
  const kid = privPem.split(/[\\/]/).pop().replace(/\.private\.pem$/, "");
  const token = (scopes) => new jose.SignJWT({ scope: scopes }).setProtectedHeader({ alg: "ES256", kid }).setIssuer("https://shop.local").setAudience("shop-api").setSubject("ana").setIssuedAt().setExpirationTime("10m").sign(key);
  const t = { none: undefined, read: await token("customers:read"), other: await token("something:else"), write: await token("customers:write customers:read"), expired: await new jose.SignJWT({ scope: "customers:read" }).setProtectedHeader({ alg: "ES256", kid }).setIssuer("https://shop.local").setAudience("shop-api").setSubject("ana").setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(key) };

  // authentication and authorization
  let x = await http(PORT.gw, "GET", "/customers"); ev.check("no token -> 401 application/problem+json PSO_AUTH_UNAUTHORIZED", x.status === 401 && /problem\+json/.test(x.headers["content-type"] ?? "") && /PSO_AUTH_UNAUTHORIZED/.test(x.body), `${x.status} ${x.body.slice(0, 80)}`);
  x = await http(PORT.gw, "GET", "/customers", { token: t.expired }); ev.check("expired token -> 401", x.status === 401, `${x.status}`);
  x = await http(PORT.gw, "GET", "/customers", { token: t.other }); ev.check("valid token without the scope -> 403 PSO_AUTH_FORBIDDEN", x.status === 403 && /PSO_AUTH_FORBIDDEN/.test(x.body), `${x.status}`);
  x = await http(PORT.gw, "GET", "/customers", { token: t.read }); ev.check("right scope, upstream not running -> 503 PSO_UPSTREAM_UNAVAILABLE (honest, not 404/500)", x.status === 503 && /PSO_UPSTREAM_UNAVAILABLE/.test(x.body), `${x.status}`);
  x = await http(PORT.gw, "GET", "/nothing-here", { token: t.read }); ev.check("unknown path -> 404 PSO_HTTP_NOT_FOUND", x.status === 404 && /PSO_HTTP_NOT_FOUND/.test(x.body), `${x.status}`);
  x = await http(PORT.gw, "GET", "/customers", { token: t.read, headers: { "x-correlation-id": "psd-corr-0001" } }); ev.check("the correlation id is propagated in the error", /psd-corr-0001/.test(x.body) || x.headers["x-correlation-id"] === "psd-corr-0001", "");

  // Spring services authenticate against a JWKS: publish the generated public key as one on loopback
  const { createPublicKey } = await import("node:crypto");
  const jwk = { ...(await jose.exportJWK(createPublicKey(readFileSync(pubPem)))), kid, alg: "ES256", use: "sig" };
  const jwksServer = (await import("node:http")).createServer((q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((ok) => jwksServer.listen(9553, "127.0.0.1", ok)); children.push({ kill: () => jwksServer.close() });
  // Spring services: build with the bundled compiled artifacts and start them
  const javaEnv = { ...iso.env };
  for (const [svc, port] of [["catalog", PORT.cat], ["orders", PORT.ord]]) {
    const mvnw = join(ws, svc, "mvnw.cmd");
    const tb = Date.now();
    const b = run(iso, "cmd.exe", ["/d", "/s", "/c", mvnw, "-B", "-q", "package", "-DskipTests=false"], { cwd: join(ws, svc), env: javaEnv, timeout: 1_500_000 });
    ev.check(`Maven build and tests of the generated Spring service "${svc}" against the bundled compiled com.pso artifacts`, b.status === 0, `${Math.round((Date.now() - tb) / 1000)} s ${b.status === 0 ? "" : (b.out + b.err).slice(-400)}`);
    const jar = existsSync(join(ws, svc, "target")) ? readdirSync(join(ws, svc, "target")).find((f) => f.endsWith(".jar") && !f.endsWith(".original")) : undefined;
    if (!jar) continue;
    const child = spawn(join(iso.env.JAVA_HOME, "bin", "java.exe"), ["-jar", join(ws, svc, "target", jar), `--server.port=${port}`, `--spring.profiles.active=local`], { cwd: join(ws, svc), env: { ...iso.env, PSO_SECURITY_JWT_ISSUER: "https://shop.local", PSO_SECURITY_JWT_AUDIENCE: "shop-api", PSO_SECURITY_JWT_JWKS_URI: "http://127.0.0.1:9553/jwks.json" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(child);
    let jl = ""; child.stdout.on("data", (c) => (jl += c)); child.stderr.on("data", (c) => (jl += c));
    const ok = await until(async () => (await http(port, "GET", "/actuator/health")).status === 200 || (await http(port, "GET", "/health/live")).status === 200, 120_000, 2000);
    ev.check(`the Spring service "${svc}" starts (Spring Boot, auto-configuration of the compiled PSO starters)`, !!ok, ok ? "" : jl.slice(-400));
  }
  x = await http(PORT.gw, "GET", "/customers", { token: t.read }); ev.check("gateway -> catalog over HTTP with the caller's token: 200 and a JSON array", x.status === 200 && x.body.trim().startsWith("["), `${x.status} ${x.body.slice(0, 80)}`);
  x = await http(PORT.gw, "GET", "/orders", { token: await token("orders:read") }); ev.check("gateway -> orders: 200", x.status === 200, `${x.status}`);
  x = await http(PORT.gw, "POST", "/customers/validate", { token: t.write, body: { name: "ab", email: "not-an-email", age: 7 } });
  let problem = {}; try { problem = JSON.parse(x.body); } catch { /* reported below */ }
  ev.check("POST with an invalid body -> 400 problem+json PSO_VALIDATION_FAILED with a violation per field (DTO validation, decorators + reflection through the protected packages)", x.status === 400 && /problem\+json/.test(x.headers["content-type"] ?? "") && /PSO_VALIDATION_FAILED/.test(x.body) && /name/.test(x.body) && /email/.test(x.body) && /age/.test(x.body), `${x.status} ${x.body.slice(0, 220)}`);
  x = await http(PORT.gw, "POST", "/customers/validate", { token: t.write, body: { name: "Ana Souza", email: "ana@example.com", age: 30 } });
  ev.check("POST with a valid body -> 201 Created (the POST default) and the action receives the validated DTO", x.status === 201 && /Ana Souza/.test(x.body), `${x.status} ${x.body.slice(0, 100)}`);
  x = await http(PORT.gw, "POST", "/customers/validate", { token: t.read, body: { name: "Ana Souza", email: "ana@example.com" } });
  ev.check("POST without the write scope -> 403 before the body is even validated", x.status === 403, `${x.status}`);
  x = await http(PORT.gw, "DELETE", "/customers", { token: t.write });
  ev.check("a method that was never declared -> 404/405 problem+json (never reaches the upstream)", (x.status === 404 || x.status === 405) && /problem\+json/.test(x.headers["content-type"] ?? ""), `${x.status}`);
} finally { for (const c of children) kill(c); }
ev.save({ label, workspace: ws });
console.log(`\n${ev.checks.length - ev.failed}/${ev.checks.length} checks passed`);
process.exit(ev.failed ? 1 : 0);

function pathToUrl(p) { return "file:///" + p.replace(/\\/g, "/"); }
