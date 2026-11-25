import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repeatsPrefix } from "../src/commands-resource.ts";
import { pso, tmp } from "./helpers.ts";
import { psoJavaInstalled, psoJavaVersion } from "../src/specs.ts";

/**
 * CLI-01. `pso make:resource orders --service orders` generated a controller mapped to /orders in the service whose prefix is
 * /orders. The service serves it at /orders/orders (prefix + resource path, which is also what the orchestrator forwards to), and the
 * Spring starter refused to start because a mapping that begins with the prefix twice is usually a controller that wrote the prefix
 * by hand. The path is legitimate here, so the generator now declares it (@RepeatsServicePrefix) and the starter keeps refusing the
 * undeclared case. The generated service is compiled, started and called, not only read.
 */
const javaOk = spawnSync("java", ["-version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const skip = !javaOk ? "JDK not found: Spring Boot integration tests cannot run on this machine" : psoJavaInstalled(psoJavaVersion()) ? false : "PSO Java artifacts are not installed: run `pso java:install` first";
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

function mvnw(cwd: string, ...args: string[]) {
  const [cmd, base] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd"]] : ["./mvnw", []];
  return spawnSync(cmd!, [...(base as string[]), "-B", "-ntp", ...args], { cwd, encoding: "utf8", timeout: 900_000, maxBuffer: 128 * 1024 * 1024 });
}
const controller = (root: string, svc: string, pkg: string, cls: string) => readFileSync(join(root, svc, "src", "main", "java", "com", "pso", pkg, "routes", `${cls}Controller.java`), "utf8").replaceAll("\r\n", "\n");

test("a repeated prefix is recognised segment by segment: the resource named like the service and paths below it, nothing that merely looks similar", () => {
  assert.equal(repeatsPrefix("/orders", "/orders"), true);
  assert.equal(repeatsPrefix("/orders", "/orders/archive"), true);
  assert.equal(repeatsPrefix("/orders", "/shipments"), false);
  assert.equal(repeatsPrefix("/orders", "/orders-archive"), false, "a longer first segment is another segment");
  assert.equal(repeatsPrefix("/orders", "/v1/orders"), false, "the prefix later in the path is not a repetition");
  assert.equal(repeatsPrefix("/api/billing", "/billing"), false);
  assert.equal(repeatsPrefix("/api/billing", "/api/billing/reports"), true);
  assert.equal(repeatsPrefix("/api/billing", "/api"), false);
  assert.equal(repeatsPrefix("", "/orders"), false);
  assert.equal(repeatsPrefix("/", "/orders"), false, "a service without a prefix repeats nothing");
});

test("make:resource in a service named like the resource, with other resources, nested paths and a custom prefix: generated, compiled, started and called", { skip, timeout: 1_500_000 }, async () => {
  const base = tmp("pso-res-prefix-"); dirs.push(base);
  const root = join(base, "w");
  assert.equal((await pso(base, "create", "workspace", "w")).code, 0);
  assert.equal((await pso(root, "create", "orchestrator", "gw", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "service", "orders", "--structure", "legacy", "--port", "8082")).code, 0);
  assert.equal((await pso(root, "create", "service", "billing", "--structure", "legacy", "--port", "8083", "--prefix", "/api/billing")).code, 0);

  // the exact command of the defect, then several more resources in the same service
  const same = await pso(root, "make:resource", "orders", "--service", "orders", "--scopes", "orders:read");
  assert.equal(same.code, 0, same.err + same.out);
  assert.equal((await pso(root, "make:resource", "shipments", "--service", "orders", "--scopes", "orders:read")).code, 0);
  assert.equal((await pso(root, "make:resource", "order-archive", "--service", "orders", "--route", "/orders/archive", "--scopes", "orders:read")).code, 0);
  assert.equal((await pso(root, "make:resource", "orders-export", "--service", "orders", "--method", "POST", "--scopes", "orders:write")).code, 0);
  // a custom prefix: the resource named like the service does not repeat /api/billing; an explicit path below the prefix does
  assert.equal((await pso(root, "make:resource", "billing", "--service", "billing", "--scopes", "billing:read")).code, 0);
  assert.equal((await pso(root, "make:resource", "billing-reports", "--service", "billing", "--route", "/api/billing/reports", "--scopes", "billing:read")).code, 0);

  // what was generated: the declaration only where the path really repeats the prefix; no path was rewritten
  const orders = controller(root, "orders", "orders", "Orders");
  assert.match(orders, /import com\.pso\.spring\.autoconfigure\.RepeatsServicePrefix;/);
  assert.match(orders, /\/\/ The service prefix \/orders is applied by PSO, so this resource is served at \/orders\/orders\./);
  assert.match(orders, /@RestController\n@RepeatsServicePrefix\n@RequestMapping\("\/orders"\)/);
  assert.match(controller(root, "orders", "orders", "OrderArchive"), /@RepeatsServicePrefix\n@RequestMapping\("\/orders\/archive"\)/);
  for (const [cls, path] of [["Shipments", "/shipments"], ["OrdersExport", "/orders-export"]] as const) {
    const c = controller(root, "orders", "orders", cls);
    assert.doesNotMatch(c, /RepeatsServicePrefix/, cls);
    assert.ok(c.includes(`@RequestMapping("${path}")`), cls);
  }
  assert.doesNotMatch(controller(root, "billing", "billing", "Billing"), /RepeatsServicePrefix/);
  assert.match(controller(root, "billing", "billing", "BillingReports"), /@RepeatsServicePrefix\n@RequestMapping\("\/api\/billing\/reports"\)/);
  // the declarative model is unchanged: each route is declared in its module's ROUTES.pso.ts and targets its service
  for (const [mod, path, svc] of [["orders", "/orders", "orders"], ["shipments", "/shipments", "orders"], ["order-archive", "/orders/archive", "orders"], ["billing", "/billing", "billing"]] as const) {
    const routes = readFileSync(join(root, "gw", "src", "routes", mod, "ROUTES.pso.ts"), "utf8");
    assert.ok(routes.includes(`path: "${path}"`) && routes.includes(`metadata: { service: "${svc}" }`), mod);
  }
  assert.equal((await pso(root, "validate")).code, 0);
  // the test PSO generated next to the controller calls the composed path
  assert.ok(readFileSync(join(root, "orders", "src", "test", "java", "com", "pso", "orders", "routes", "OrdersControllerTests.java"), "utf8").includes('get("/orders/orders")'));
  assert.ok(readFileSync(join(root, "billing", "src", "test", "java", "com", "pso", "billing", "routes", "BillingReportsControllerTests.java"), "utf8").includes('get("/api/billing/api/billing/reports")'));

  // compiled, started and called: the generated tests start the Spring application and send real requests through its dispatcher
  // (200 with the scope, 403 without it, 401 anonymous, 400 for an invalid body), for every resource above
  for (const svc of ["orders", "billing"]) {
    const r = mvnw(join(root, svc), "-o", "test");
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `${svc}: ${out.split("\n").filter((l) => /ERROR|FAIL|Tests run|already contain/.test(l)).slice(0, 25).join("\n")}`);
    assert.doesNotMatch(out, /already contain it/, "the service starts");
    const ran = [...out.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm)].pop();
    assert.ok(ran && Number(ran[1]) >= (svc === "orders" ? 12 : 6) && ran[2] === "0" && ran[3] === "0", `${svc}: ${ran?.[0]}`);
    for (const cls of svc === "orders" ? ["OrdersControllerTests", "ShipmentsControllerTests", "OrderArchiveControllerTests", "OrdersExportControllerTests"] : ["BillingControllerTests", "BillingReportsControllerTests"]) assert.match(out, new RegExp(`Tests run: \\d+, Failures: 0, Errors: 0, Skipped: 0.* -- in com\\.pso\\.${svc}\\.routes\\.${cls}`), cls);
  }
});
