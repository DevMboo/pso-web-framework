import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceConfig } from "@pso/core";
import { devEnvironment, startDev } from "../src/dev.ts";
import { effectiveProjectEnv, parseEnvFile, projectEnv } from "../src/project-env.ts";
import { pomVersions } from "../src/pom-versions.ts";
import { npmInvocation, programInvocation, viaCmd } from "../src/proc.ts";
import { TEMPLATES_DIR } from "../src/templates.ts";
import { pso, tmp, unusedPort } from "./helpers.ts";

/**
 * Configuration maturity:
 *   F-08  `pso dev` starts every service with ITS OWN environment (its files, then the environment of the command, then what the
 *         workspace declares); a variable written for one service never reaches another one;
 *   F-15  the static commands read the sources the application runs with, for one named environment, and say which;
 *   F-11  a release is refused for the versions that matter (the service's own and <pso.version>), not for the Spring Boot parent;
 *   F-24  other programs are started with an executable and an argument array, never through a shell command string.
 */
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const write = (file: string, text: string): void => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };

test("environment files: the accepted syntax, and an invalid line is reported without its content", () => {
  assert.deepEqual(parseEnvFile(['# a comment', '', 'A=1', 'export B = two words ', 'C="quoted # not a comment"  # a comment', "D='single $literal'", 'E="line\\nbreak"', 'F=value # trailing comment', 'G=', 'H=a=b'].join("\n")),
    { A: "1", B: "two words", C: "quoted # not a comment", D: "single $literal", E: "line\nbreak", F: "value", G: "", H: "a=b" });
  assert.throws(() => parseEnvFile("OK=1\nthis is not an assignment hunter2\n", "svc/.env"), (e: Error) => /svc\/\.env: line 2 is not NAME=value/.test(e.message) && !/hunter2/.test(e.message));
  assert.throws(() => parseEnvFile('A="unterminated', "x"), /line 1 has an unterminated double quote/);
  assert.throws(() => parseEnvFile("1BAD=x", "x"), /line 1/);
});

test("precedence and isolation: workspace file < project .env < project .env.<environment> < external environment; production reads no file", () => {
  const root = tmp("pso-env-"); dirs.push(root);
  write(join(root, ".env"), "COMPOSE_ONLY=1\nSHARED=from-compose-file\n"); // belongs to Docker Compose: never read
  write(join(root, ".env.development"), "SHARED=workspace\nLEVEL=workspace\nONLY_WORKSPACE=w\n");
  write(join(root, "orders/.env"), "LEVEL=orders\nDB_URL=jdbc:orders\nPORT=1\nDB_PASSWORD=hunter2\n");
  write(join(root, "orders/.env.development"), "DB_URL=jdbc:orders-dev\n");
  write(join(root, "orders/.env.test"), "DB_URL=jdbc:orders-test\n");
  write(join(root, "customers/.env"), "DB_URL=jdbc:customers\n");
  const orders = { path: "orders" }, customers = { path: "customers" };

  const files = projectEnv(root, orders, "development");
  assert.deepEqual(files.sources.map((s) => [s.file, s.scope]), [[".env.development", "workspace"], ["orders/.env", "project"], ["orders/.env.development", "project"]]);
  assert.deepEqual(files.fromFiles, { SHARED: "workspace", LEVEL: "orders", ONLY_WORKSPACE: "w", DB_URL: "jdbc:orders-dev", PORT: "1", DB_PASSWORD: "hunter2" });
  assert.equal(files.fromFiles["COMPOSE_ONLY"], undefined, "<workspace>/.env is Compose's file, not a development source");

  const e = effectiveProjectEnv(root, orders, { EXTERNAL: "x", LEVEL: "external" }, "development");
  assert.equal(e.env["LEVEL"], "external", "an explicit external variable wins over every file");
  assert.equal(e.env["DB_URL"], "jdbc:orders-dev");
  assert.equal(e.env["PORT"], undefined, "a file cannot set what the workspace declares");
  assert.deepEqual(e.overriddenByEnvironment, ["LEVEL"]);
  assert.deepEqual(e.ignoredDeclared, ["PORT"]);
  // another environment picks its own override; another project sees none of this one's variables
  assert.equal(effectiveProjectEnv(root, orders, {}, "test").env["DB_URL"], "jdbc:orders-test");
  const c = effectiveProjectEnv(root, customers, {}, "development");
  assert.deepEqual(c.env, { SHARED: "workspace", LEVEL: "workspace", ONLY_WORKSPACE: "w", DB_URL: "jdbc:customers" });
  assert.equal(c.env["DB_PASSWORD"], undefined, "a secret of one service is not handed to another");
  // production: only the external environment
  const prod = effectiveProjectEnv(root, orders, { PSO_JWT_ISSUER: "https://idp" }, "production");
  assert.deepEqual(prod.env, { PSO_JWT_ISSUER: "https://idp" });
  assert.deepEqual(prod.sources, []);
  assert.throws(() => projectEnv(root, orders, "../etc"), /Invalid environment name/);

  // what `pso dev` hands to each process, and what it says about it (names only)
  const decl = (name: string, port: number) => ({ name, path: name, runtime: "spring-boot" as const, port });
  const o = devEnvironment(root, decl("orders", 8082), { PATH: "p", LEVEL: "external" }, false);
  assert.equal(o.env["PORT"], "8082"); assert.equal(o.env["HOST"], "127.0.0.1"); assert.equal(o.env["PSO_SERVICE"], "orders");
  assert.equal(o.env["SPRING_PROFILES_ACTIVE"], "local");
  assert.equal(o.env["PSO_LOG_ERROR_DETAILS"], "true", "development diagnostics are on in a dev session");
  assert.equal(o.env["DB_URL"], "jdbc:orders-dev");
  const notes = o.notes.join("\n");
  assert.match(notes, /environment: the process environment, \.env\.development \(3 variables\), orders\/\.env \(4 variables\), orders\/\.env\.development \(1 variable\)/);
  assert.match(notes, /LEVEL comes from the environment of `pso dev`/);
  assert.match(notes, /PORT in an environment file is ignored: it comes from pso\.workspace\.json/);
  assert.ok(!/hunter2|jdbc:/.test(notes), "values are never printed");
  const explicit = devEnvironment(root, decl("orders", 8082), { SPRING_PROFILES_ACTIVE: "dev", PSO_LOG_ERROR_DETAILS: "false" }, false);
  assert.equal(explicit.env["SPRING_PROFILES_ACTIVE"], "dev", "an explicit choice is kept");
  assert.equal(explicit.env["PSO_LOG_ERROR_DETAILS"], "false");
});

test("pso dev: two services started together each receive their own ports, database, dispatch, logging and application settings", { timeout: 120_000 }, async () => {
  const root = tmp("pso-dev-env-"); dirs.push(root);
  const ports = { customers: await unusedPort(), orders: await unusedPort() };
  // a service that reports the environment it was started with and answers its health check
  const script = `const http = require("node:http"); const fs = require("node:fs");
const keys = ["PORT","PSO_SERVICE","DB_URL","DB_USER","PSO_DISPATCH_PROVIDER","REDIS_URL","PSO_LOG_LEVEL","APP_GREETING","SHARED_REGION","EXTERNAL_FLAG","DB_PASSWORD"];
fs.writeFileSync("seen.json", JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
http.createServer((q, r) => { r.writeHead(200); r.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");
`;
  for (const name of ["customers", "orders"] as const) write(join(root, name, "service.cjs"), script);
  write(join(root, ".env.development"), "SHARED_REGION=eu-west\nPSO_LOG_LEVEL=info\n");
  write(join(root, "customers/.env"), "DB_URL=jdbc:postgresql://localhost:5432/customers\nDB_USER=customers_app\nDB_PASSWORD=customers-secret\nPSO_LOG_LEVEL=debug\nAPP_GREETING=hello-customers\n");
  write(join(root, "orders/.env"), "DB_URL=jdbc:postgresql://localhost:5432/orders\nDB_USER=orders_app\nPSO_DISPATCH_PROVIDER=rabbitmq\nREDIS_URL=redis://127.0.0.1:6380\nAPP_GREETING=hello-orders\n");
  const config: WorkspaceConfig = { schemaVersion: 1, name: "shop", services: (["customers", "orders"] as const).map((name) => ({ name, path: name, runtime: "node" as const, port: ports[name], health: "/", dev: { command: [process.execPath, "service.cjs"] } })) };
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify(config));
  const lines: string[] = [];
  const session = await startDev({ root, config, readyTimeoutMs: 30_000, log: (l) => lines.push(l), env: { ...process.env, EXTERNAL_FLAG: "from-shell", PSO_ENV: "development" } });
  try {
    const seen = (name: string): Record<string, string | null> => JSON.parse(readFileSync(join(root, name, "seen.json"), "utf8")) as Record<string, string | null>;
    const customers = seen("customers"), orders = seen("orders");
    assert.deepEqual(customers, { PORT: String(ports.customers), PSO_SERVICE: "customers", DB_URL: "jdbc:postgresql://localhost:5432/customers", DB_USER: "customers_app", PSO_DISPATCH_PROVIDER: null, REDIS_URL: null, PSO_LOG_LEVEL: "debug", APP_GREETING: "hello-customers", SHARED_REGION: "eu-west", EXTERNAL_FLAG: "from-shell", DB_PASSWORD: "customers-secret" });
    assert.deepEqual(orders, { PORT: String(ports.orders), PSO_SERVICE: "orders", DB_URL: "jdbc:postgresql://localhost:5432/orders", DB_USER: "orders_app", PSO_DISPATCH_PROVIDER: "rabbitmq", REDIS_URL: "redis://127.0.0.1:6380", PSO_LOG_LEVEL: "info", APP_GREETING: "hello-orders", SHARED_REGION: "eu-west", EXTERNAL_FLAG: "from-shell", DB_PASSWORD: null });
    const said = lines.join("\n");
    assert.match(said, /\[pso\] customers: environment: the process environment, \.env\.development \(2 variables\), customers\/\.env \(5 variables\)/);
    assert.ok(!/customers-secret|jdbc:postgresql/.test(said), "the session output names files and variables, never values");
  } finally { await session.stop(); }
});

test("static security commands evaluate the sources the application runs with, for one named environment", async () => {
  const base = tmp("pso-parity-"); dirs.push(base);
  const root = join(base, "w");
  assert.equal((await pso(base, "create", "workspace", "w")).code, 0);
  assert.equal((await pso(root, "create", "orchestrator", "gw", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "service", "users", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read")).code, 0);
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^PSO_/.test(k)) delete process.env[k];
  try {
    // the guarded route needs JWT settings: none anywhere yet
    const none = await pso(root, "security:check");
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /environment: development \(default; choose another with --env or PSO_ENV\)/);
    assert.match(none.out, /SEC005 gw/);
    assert.match(none.out, /is not configured for "development"/);
    assert.match(none.out, /for development: in gw\/\.env/);
    // the documented development model: the gateway's .env (what `npm run dev` and `pso dev` read)
    write(join(root, "gw/.env"), "PSO_JWT_ISSUER=https://idp.example.com\nPSO_JWT_AUDIENCE=pso-api\nPSO_JWT_JWKS_URI=https://idp.example.com/.well-known/jwks.json\nSESSION_SECRET=hunter2-do-not-print\n");
    const dev = await pso(root, "security:check");
    assert.equal(dev.code, 0, dev.out + dev.err);
    assert.match(dev.out, /gw: configuration from the process environment, gw\/\.env \(4 variables\)/);
    assert.match(dev.out, /This result is about "development"\. It says nothing about production/);
    assert.ok(!/hunter2|idp\.example\.com/.test(dev.out), "the report names sources and variables, never values");
    for (const cmd of [["security:validate"], ["lint"]]) {
      const r = await pso(root, ...cmd, "--json");
      const parsed = JSON.parse(r.out) as { targets?: Array<{ target: string; status: string }>; problems?: string[] };
      if (parsed.targets) assert.equal(parsed.targets.find((t) => t.target === "gw")!.status, "valid", `${cmd[0]}: the gateway .env is taken into account`);
      else assert.ok(!(parsed.problems ?? []).some((p) => /SEC005/.test(p)), `${cmd[0]}: ${(parsed.problems ?? []).join("\n")}`);
    }
    // a development file never makes production pass: production is evaluated from the process environment only
    const prod = await pso(root, "security:check", "--env", "production");
    assert.equal(prod.code, 1, prod.out);
    assert.match(prod.out, /environment: production/);
    assert.match(prod.out, /gw: configuration from the process environment only \(environment files are not read for production\)/);
    assert.match(prod.out, /SEC005 gw[\s\S]*is not configured for "production"/);
    assert.equal((await pso(root, "security:validate", "--env", "production")).code, 1);
    Object.assign(process.env, { PSO_JWT_ISSUER: "https://idp.prod.example", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_JWKS_URI: "https://idp.prod.example/jwks" });
    assert.equal((await pso(root, "security:check", "--env", "production")).code, 0, "with the production variables present it passes");
    process.env["PSO_ENV"] = "production";
    assert.match((await pso(root, "security:check")).out, /^environment: production$/m, "PSO_ENV selects the environment");
    delete process.env["PSO_ENV"];
    // a production mistake is reported by a development check too: file-based checks do not depend on the chosen environment
    write(join(root, "gw/pso.config.production.json"), JSON.stringify({ security: { authentication: { issuer: "https://idp.prod.example", audience: "pso-api", jwks: { uri: "http://idp.prod.example/jwks" } } } }));
    const mixed = await pso(root, "security:check", "--env", "development");
    assert.equal(mixed.code, 1, mixed.out);
    assert.match(mixed.out, /SEC007 gw\s+JWKS is fetched over plain http/);
    rmSync(join(root, "gw/pso.config.production.json"));
    // the development identity provider is never what production trusts
    assert.equal((await pso(root, "idp:dev", "init")).code, 0);
    Object.assign(process.env, { PSO_JWT_ISSUER: "https://idp:8443", PSO_JWT_JWKS_URI: "https://idp:8443/.well-known/jwks.json" });
    const devIdp = await pso(root, "security:check", "--env", "production");
    assert.equal(devIdp.code, 1, devIdp.out);
    assert.match(devIdp.out, /CRITICAL SEC013/);
    assert.equal((await pso(root, "security:check", "--env", "nope!")).code, 2, "a mistyped environment is refused, not replaced");
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test("release versions are read from the right places of a real generated pom.xml", () => {
  const template = readFileSync(join(TEMPLATES_DIR, "service-spring", "pom.xml"), "utf8").replaceAll("{{name}}", "orders").replaceAll("{{pkg}}", "com.pso.orders").replaceAll("{{dbDeps}}", "").replaceAll("{{dbTestDeps}}", "");
  const withPso = (v: string): string => template.replaceAll("{{psoVersion}}", v);
  // the default generated service: its own version is fixed, the PSO artifacts are a SNAPSHOT. The parent (Spring Boot 3.5.6) is not what matters
  const dev = pomVersions(withPso("0.1.0-SNAPSHOT"));
  assert.equal(dev.project, "0.1.0"); assert.equal(dev.pso, "0.1.0-SNAPSHOT");
  assert.deepEqual(dev.snapshots, ["the PSO artifacts are 0.1.0-SNAPSHOT (<pso.version>): a local development build of com.pso:*"]);
  // a release: fixed versions everywhere
  assert.deepEqual(pomVersions(withPso("1.2.0")).snapshots, []);
  // the service's own version, a property reference, a pinned dependency, a SNAPSHOT parent, and a comment that only looks like one
  assert.match(pomVersions(withPso("1.2.0").replace("<version>0.1.0</version>", "<version>0.2.0-SNAPSHOT</version>")).snapshots.join("|"), /the service's own version is 0\.2\.0-SNAPSHOT/);
  const viaProperty = withPso("1.2.0").replace("<version>0.1.0</version>", "<version>${revision}</version>").replace("<properties>", "<properties>\n    <revision>3.0.0-SNAPSHOT</revision>");
  assert.match(pomVersions(viaProperty).snapshots.join("|"), /the service's own version is 3\.0\.0-SNAPSHOT/);
  assert.match(pomVersions(withPso("1.2.0").replace("<version>0.1.0</version>", "<version>${undefined.property}</version>")).snapshots.join("|"), /cannot be resolved without running Maven/);
  const pinned = withPso("1.2.0").replace("</dependencies>", "  <dependency><groupId>com.acme</groupId><artifactId>billing-client</artifactId><version>2.0-SNAPSHOT</version></dependency>\n  </dependencies>");
  assert.deepEqual(pomVersions(pinned).snapshots, ["dependency com.acme:billing-client is 2.0-SNAPSHOT"]);
  assert.match(pomVersions(withPso("1.2.0").replace("<version>3.5.6</version>", "<version>3.6.0-SNAPSHOT</version>")).snapshots.join("|"), /parent org\.springframework\.boot:spring-boot-starter-parent is 3\.6\.0-SNAPSHOT/);
  assert.deepEqual(pomVersions(withPso("1.2.0").replace("<properties>", "<!-- <version>9.9.9-SNAPSHOT</version> -->\n  <properties>")).snapshots, []);
});

test("other programs are started with an executable and an argument array, never a shell command string", () => {
  // POSIX: the program itself
  assert.deepEqual(npmInvocation("npm", ["install", "--no-audit"], "linux"), { command: "npm", args: ["install", "--no-audit"] });
  assert.deepEqual(programInvocation("mvn", ["--version"], "linux"), { command: "mvn", args: ["--version"] });
  // Windows: npm is run with the current Node binary (no batch wrapper, no shell); a path with spaces stays ONE argument
  const win = npmInvocation("npm", ["pack", "--pack-destination", "C:\\Program Files\\out dir"], "win32", process.execPath);
  if (existsSync(join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js"))) {
    assert.equal(win.command, process.execPath);
    assert.match(win.args[0]!, /npm-cli\.js$/);
    assert.deepEqual(win.args.slice(1), ["pack", "--pack-destination", "C:\\Program Files\\out dir"]);
  }
  // a batch wrapper goes through cmd.exe with an argument ARRAY, and an argument cmd.exe would interpret is refused
  const cmd = viaCmd("mvn", ["-B", "--version"]);
  assert.deepEqual(cmd.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.deepEqual(cmd.args.slice(3), ["mvn", "-B", "--version"]);
  for (const hostile of ["a & del x", "x | y", "%PATH%", "a > b", 'say "hi"', "^caret", "two\nlines"]) assert.throws(() => viaCmd("npm", ["install", hostile]), /shell metacharacter/, hostile);
  assert.deepEqual(programInvocation("java", ["-version"], "win32"), { command: "java", args: ["-version"] }, "a real executable is started directly");
});
