import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChildProcess } from "node:child_process";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { pso, tmp, prepare, compileProject, startNode, unusedPort } from "./helpers.ts";
import { expectProblem } from "./gw-fixture.ts";

/**
 * F-14, F-17, F-19, F-06 on a GENERATED orchestrator, built with the public CLI only and run as a real process against three
 * upstream services (real HTTP servers standing in for the customers, orders and catalog microservices):
 *   - an action composes one response from several registered services through the injected UpstreamClient;
 *   - the route declares the services it calls; a call to any other one is refused before anything is sent;
 *   - correlation and trace travel with every call, the caller's token only where it was asked for and allowed;
 *   - deadlines, cancellation, size limits and upstream failures become stable problems that never carry the upstream's body;
 *   - a provider and a lifecycle hook generated with --module are registered explicitly and take part in the application;
 *   - a body is validated at the gateway and only then forwarded (make:route --upstream --dto);
 *   - an unexpected error is diagnosable from the log, and its message is recorded only when development diagnostics are on.
 */

interface Seen { method: string; path: string; headers: IncomingMessage["headers"]; body: string }
interface Stub { server: Server; port: number; seen: Seen[]; closedEarly: string[] }

async function stub(port: number, handle: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<Stub> {
  const out: Stub = { server: undefined as unknown as Server, port, seen: [], closedEarly: [] };
  out.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const seen: Seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      out.seen.push(seen);
      res.on("close", () => { if (!res.writableFinished) out.closedEarly.push(seen.path); });
      handle(req, res, seen);
    });
  });
  await new Promise<void>((r) => out.server.listen(port, "127.0.0.1", r));
  return out;
}
const json = (res: ServerResponse, status: number, body: unknown, type = "application/json"): void => { const data = JSON.stringify(body); res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(data) }); res.end(data); };
const problem = (res: ServerResponse, status: number): void => json(res, status, { type: "urn:pso:problem:http-not-found", title: "Resource not found", status, code: "PSO_HTTP_NOT_FOUND", detail: "SECRET-INTERNAL row 42 of table customers" }, "application/problem+json");

const dirs: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
after(async () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const s of servers) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* the OS reaps temp */ } }
});

interface Fixture {
  root: string; gw: string; ports: Record<"customers" | "orders" | "catalog" | "ghost", number>;
  customers: Stub; orders: Stub; catalog: Stub;
  token(scope: string): Promise<string>;
  start(env?: Record<string, string>): Promise<{ child: ChildProcess; url: (p: string) => string; logs: () => string; lines: () => Array<Record<string, unknown>> }>;
}

let built: Promise<Fixture> | undefined;
const fixture = (): Promise<Fixture> => (built ??= build());

async function build(): Promise<Fixture> {
  const base = tmp("pso-compose-"); dirs.push(base);
  const ok = async (...argv: string[]): Promise<string> => { const r = await pso(root, ...argv); assert.equal(r.code, 0, `pso ${argv.join(" ")}\n${r.out}${r.err}`); return r.out; };
  assert.equal((await pso(base, "create", "workspace", "shop", "--layout", "flat")).code, 0);
  const root = join(base, "shop");
  const ports = { customers: await unusedPort(), orders: await unusedPort(), catalog: await unusedPort(), ghost: await unusedPort() };
  await ok("create", "orchestrator", "gw", "--structure", "legacy");
  for (const name of ["customers", "orders", "catalog", "ghost"] as const) await ok("create", "service", name, "--structure", "legacy", "--port", String(ports[name]));
  const gw = join(root, "gw");

  // ---- everything below is the public CLI: module, controller, an explicitly registered provider and hook, declared routes ----
  await ok("make:module", "summary", "--service", "gw");
  await ok("make:controller", "summary", "--service", "gw");
  const provider = await ok("make:provider", "clock", "--module", "summary", "--service", "gw");
  assert.match(provider, /created\s+src\/providers\/clock\.provider\.ts/);
  assert.match(provider, /updated\s+src\/routes\/summary\/MODULE\.pso\.ts/);
  await ok("make:hook", "audit", "--module", "summary", "--service", "gw");
  await ok("make:config", "shop", "--service", "gw");
  const route = (action: string, path: string, ...more: string[]): Promise<string> => ok("make:route", "summary", action, "--method", "GET", "--path", path, "--service", "gw", ...more);
  await route("show", "/of/:id", "--compose", "customers,orders,catalog", "--scopes", "summary:read");
  await route("translated", "/translated/:id", "--compose", "customers", "--public");
  await route("undeclared", "/undeclared", "--compose", "customers", "--public");
  await route("slow", "/slow", "--compose", "orders", "--public");
  await route("hang", "/hang", "--compose", "orders", "--public");
  await route("big", "/big", "--compose", "catalog", "--public");
  await route("redirect", "/redirect", "--compose", "catalog", "--public");
  await route("down", "/down", "--compose", "ghost", "--public");
  await route("unknown", "/unknown", "--compose", "customers", "--public");
  await route("boom", "/boom", "--public");
  await ok("make:dto", "summary", "place-order", "--fields", "customerId:string,quantity:integer:min=1", "--service", "gw");
  await ok("make:route", "summary", "place", "--method", "POST", "--path", "/orders", "--upstream", "orders", "--dto", "place-order", "--scopes", "orders:write", "--service", "gw");

  // the generator declared, for each composing route, exactly the services it may call
  const routes = readFileSync(join(gw, "src/routes/summary/ROUTES.pso.ts"), "utf8");
  assert.match(routes, /action: "show",\s+security: \{ guard: "jwt", scopes: \["summary:read"\] \},\s+metadata: \{ services: \["customers","orders","catalog"\] \}/);
  assert.match(routes, /action: "place",\s+security: \{ guard: "jwt", scopes: \["orders:write"\] \},\s+metadata: \{ service: "orders" \}/);
  const moduleFile = readFileSync(join(gw, "src/routes/summary/MODULE.pso.ts"), "utf8");
  assert.match(moduleFile, /import \{ ClockProvider \} from "\.\.\/\.\.\/providers\/clock\.provider"/);
  assert.match(moduleFile, /providers: \[ClockProvider, AuditHook\]/, "the provider and the hook are registered explicitly");

  // ---- the application code a developer writes into the generated actions ----
  const file = join(gw, "src/routes/summary/summary.controller.ts");
  let c = readFileSync(file, "utf8");
  assert.match(c, /private readonly services: UpstreamClient/, "make:route --compose injects the service client");
  assert.match(c, /@Body\(PlaceOrderDto\) _body: PlaceOrderDto/, "make:route --upstream --dto validates the body before forwarding");
  assert.match(c, /return this\.upstream\.forward\(req, res, "orders"\);/);
  const body = (action: string, code: string): void => {
    const re = new RegExp(`(async ${action}\\([^\\n]*\\) \\{\\n)[\\s\\S]*?// TODO: implement ${action}\\n\\s*return \\{\\};`);
    assert.ok(re.test(c), `generated body of ${action}`);
    c = c.replace(re, (_m, head: string) => `${head}${code}`);
  };
  c = c.replace('import { Controller,', 'import { HttpError, UpstreamCallError, Controller,');
  c = c.replace(/(import \{ HttpError[^\n]*\n)/, `$1import { ClockProvider } from "../../providers/clock.provider";\nimport shopConfig from "../../configs/shop.config";\n`);
  c = c.replace("private readonly services: UpstreamClient", "private readonly services: UpstreamClient, private readonly clock: ClockProvider");
  body("show", `    const customer = await this.services.get<{ id: string; name: string }>("customers", "/customers/:id", { params: { id }, credentials: "caller" });
    const orders = await this.services.get<Array<{ id: string; productIds: string[] }>>("orders", "/orders", { query: { customerId: id } });
    const ids = [...new Set(orders.flatMap((o) => o.productIds))];
    const products = await Promise.all(ids.map((pid) => this.services.get<{ id: string; title: string }>("catalog", "/products/:id", { params: { id: pid } })));
    return { customer, orders, products, generatedAt: this.clock.now(), shop: shopConfig.name };`);
  body("translated", `    try { return await this.services.get("customers", "/customers/:id", { params: { id } }); }
    catch (e) { if (e instanceof UpstreamCallError && e.is(404)) throw new HttpError(422, "unknown_customer"); throw e; }`);
  body("undeclared", `    return this.services.get("catalog", "/products/:id", { params: { id: "p1" } });`);
  body("slow", `    return this.services.get("orders", "/slow", { timeoutMs: 200 });`);
  body("hang", `    return this.services.get("orders", "/hang");`);
  body("big", `    return this.services.get("catalog", "/big", { maxResponseBytes: 64 });`);
  body("redirect", `    return this.services.get("catalog", "/redirect");`);
  body("down", `    return this.services.get("ghost", "/anything");`);
  body("unknown", `    return this.services.get("customers", "/customers/:id", { params: { id: "nobody" } });`);
  body("boom", `    throw new Error("secret internals: /etc/passwd password=hunter2");`);
  writeFileSync(file, c);
  const clock = join(gw, "src/providers/clock.provider.ts");
  writeFileSync(clock, readFileSync(clock, "utf8").replace("export class ClockProvider {\n}", "export class ClockProvider {\n  now(): string { return \"2026-01-01T00:00:00.000Z\"; }\n}").replace("export class ClockProvider {\r\n}", "export class ClockProvider {\n  now(): string { return \"2026-01-01T00:00:00.000Z\"; }\n}"));

  // the declarations are consistent, and the compiler now knows the service and guard names
  const validated = await pso(root, "validate");
  assert.equal(validated.code, 0, validated.out + validated.err);
  // the route listing names the services a composing route declared (it used to leave the column empty)
  assert.match(await ok("routes:list"), /\.show\s+-> customers,orders,catalog\s/);
  const types = await ok("types");
  assert.match(types, /created\s+gw\/src\/pso-types\.d\.ts/);
  assert.match(types, /services: catalog, customers, ghost, orders/);
  assert.equal((await pso(root, "types", "--check")).code, 0);
  prepare(gw);

  const customers = await stub(ports.customers, (_req, res, s) => { if (s.path === "/customers/customers/c1") json(res, 200, { id: "c1", name: "Ada" }); else problem(res, 404); });
  const orders = await stub(ports.orders, (_req, res, s) => {
    if (s.method === "GET" && s.path === "/orders/orders?customerId=c1") json(res, 200, [{ id: "o1", productIds: ["p1", "p2"] }, { id: "o2", productIds: ["p2"] }]);
    else if (s.path === "/orders/slow") setTimeout(() => json(res, 200, { late: true }), 3000).unref();
    else if (s.path === "/orders/hang") { /* never answers: the call ends when the client goes away */ }
    else if (s.method === "POST") json(res, 201, { accepted: JSON.parse(s.body || "null") });
    else problem(res, 404);
  });
  const catalog = await stub(ports.catalog, (_req, res, s) => {
    const m = /^\/catalog\/products\/(p\d)$/.exec(s.path);
    if (m) json(res, 200, { id: m[1], title: `Product ${m[1]}` });
    else if (s.path === "/catalog/big") json(res, 200, { blob: "x".repeat(10_000) });
    else if (s.path === "/catalog/redirect") { res.writeHead(302, { location: `http://127.0.0.1:${ports.customers}/customers/customers/c1` }); res.end(); }
    else problem(res, 404);
  });
  servers.push(customers.server, orders.server, catalog.server);

  const keys = await generateKeyPair("ES256", { extractable: true });
  const pub = join(root, "test-public.pem");
  writeFileSync(pub, await exportSPKI(keys.publicKey));
  return {
    root, gw, ports, customers, orders, catalog,
    token: (scope) => new SignJWT({ scope }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject("tester").setIssuedAt().setExpirationTime("30m").sign(keys.privateKey),
    async start(env = {}) {
      const port = await unusedPort();
      const { child, logs } = await startNode(gw, { PORT: String(port), PSO_WORKSPACE: join(root, "pso.workspace.json"), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256", PSO_LOG_FORMAT: "json", RATE_LIMIT_PER_MINUTE: "0", ...env });
      children.push(child);
      const lines = (): Array<Record<string, unknown>> => logs().split(/\r?\n/).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
      return { child, url: (p: string) => `http://127.0.0.1:${port}${p}`, logs, lines };
    },
  };
}

const READY = { timeout: 600_000 } as const;

test("an action composes one response from three registered services; correlation, trace and credentials travel as declared", READY, async () => {
  const fx = await fixture();
  const gw = await fx.start();
  try {
    for (const s of [fx.customers, fx.orders, fx.catalog]) s.seen.length = 0;
    const token = await fx.token("summary:read");
    const res = await fetch(gw.url("/summary/of/c1"), { headers: { authorization: `Bearer ${token}`, "x-correlation-id": "corr-compose-0001" } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), {
      customer: { id: "c1", name: "Ada" },
      orders: [{ id: "o1", productIds: ["p1", "p2"] }, { id: "o2", productIds: ["p2"] }],
      products: [{ id: "p1", title: "Product p1" }, { id: "p2", title: "Product p2" }],
      generatedAt: "2026-01-01T00:00:00.000Z", // the provider generated with --module was injected
      shop: "shop", // the configuration module is used by importing it
    });
    // the service prefix was applied once, the path parameter and the query were encoded by the client
    assert.deepEqual(fx.customers.seen.map((s) => `${s.method} ${s.path}`), ["GET /customers/customers/c1"]);
    assert.deepEqual(fx.orders.seen.map((s) => `${s.method} ${s.path}`), ["GET /orders/orders?customerId=c1"]);
    assert.deepEqual(fx.catalog.seen.map((s) => s.path).sort(), ["/catalog/products/p1", "/catalog/products/p2"]);
    const all = [...fx.customers.seen, ...fx.orders.seen, ...fx.catalog.seen];
    for (const s of all) {
      assert.equal(s.headers["x-correlation-id"], "corr-compose-0001", "every call carries the correlation id of the request");
      assert.match(String(s.headers["traceparent"]), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      assert.equal(s.headers["cookie"], undefined);
    }
    assert.equal(new Set(all.map((s) => String(s.headers["traceparent"]).split("-")[1])).size, 1, "one trace across the three services");
    // the caller's token went only where the action asked for it (credentials: "caller") and the policy allowed it
    assert.equal(fx.customers.seen[0]!.headers["authorization"], `Bearer ${token}`);
    for (const s of [...fx.orders.seen, ...fx.catalog.seen]) assert.equal(s.headers["authorization"], undefined, "no credentials unless requested");
    // the route is protected like any other
    await expectProblem(await fetch(gw.url("/summary/of/c1")), 401, "PSO_AUTH_UNAUTHORIZED");
    await expectProblem(await fetch(gw.url("/summary/of/c1"), { headers: { authorization: `Bearer ${await fx.token("other:scope")}` } }), 403, "PSO_AUTH_FORBIDDEN");
  } finally { gw.child.kill("SIGKILL"); }
});

test("only declared, registered services can be called; upstream outcomes are stable problems that never carry the upstream body", READY, async () => {
  const fx = await fixture();
  const gw = await fx.start();
  try {
    for (const s of [fx.customers, fx.orders, fx.catalog]) s.seen.length = 0;
    // the route declares "customers" and the action calls "catalog": refused before anything is sent
    const undeclared = await expectProblem(await fetch(gw.url("/summary/undeclared")), 500, "PSO_UPSTREAM_POLICY");
    assert.equal(fx.catalog.seen.length, 0, "nothing was sent to the undeclared service");
    assert.ok(gw.lines().some((l) => l["msg"] === "upstream call refused" && /calls "catalog" but declares "customers"/.test(String(l["detail"]))), "the log says which declaration is missing");
    assert.ok(!/catalog/.test(JSON.stringify(undeclared)), "the answer does not name internal services");

    // an answer of a service is not a gateway failure: 404 stays 404, and the action can translate it on purpose
    const nf = await expectProblem(await fetch(gw.url("/summary/unknown")), 404, "PSO_UPSTREAM_NOT_FOUND");
    assert.ok(!/SECRET-INTERNAL|table customers/.test(JSON.stringify(nf)), "the upstream's body is never forwarded");
    const translated = await expectProblem(await fetch(gw.url("/summary/translated/nobody")), 422, "PSO_HTTP_ERROR_422");
    assert.equal(translated["detail"], "unknown_customer");
    assert.equal((await fetch(gw.url("/summary/translated/c1"))).status, 200);
    // a hostile path parameter stays one encoded segment: it cannot leave the service's path
    fx.customers.seen.length = 0;
    await fetch(gw.url("/summary/translated/..%2F..%2Fadmin"));
    assert.deepEqual(fx.customers.seen.map((s) => s.path), ["/customers/customers/..%2F..%2Fadmin"]);

    await expectProblem(await fetch(gw.url("/summary/slow")), 504, "PSO_UPSTREAM_TIMEOUT");
    await expectProblem(await fetch(gw.url("/summary/big")), 502, "PSO_UPSTREAM_RESPONSE_TOO_LARGE");
    await expectProblem(await fetch(gw.url("/summary/down")), 503, "PSO_UPSTREAM_UNAVAILABLE");
    // a redirect is an answer, never followed: the other service was not contacted on the client's behalf
    fx.customers.seen.length = 0;
    await expectProblem(await fetch(gw.url("/summary/redirect")), 502, "PSO_UPSTREAM_REJECTED");
    assert.equal(fx.customers.seen.length, 0, "the redirect target was not requested");

    // when the client goes away, the calls made for it are cancelled
    fx.orders.closedEarly.length = 0;
    const abort = new AbortController();
    const pending = fetch(gw.url("/summary/hang"), { signal: abort.signal }).catch(() => undefined);
    for (let i = 0; i < 100 && !fx.orders.seen.some((s) => s.path === "/orders/hang"); i++) await new Promise((r) => setTimeout(r, 50));
    abort.abort();
    await pending;
    for (let i = 0; i < 100 && fx.orders.closedEarly.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fx.orders.closedEarly, ["/orders/hang"], "the upstream call was aborted");

    // every failure was logged with the service and the reason, and none of the logs carries the upstream body
    const failures = gw.lines().filter((l) => l["msg"] === "an upstream call failed and the action did not handle it");
    assert.ok(failures.some((l) => l["service"] === "customers" && l["upstreamStatus"] === 404 && l["problem"] === "upstream_not_found" && l["component"] === "SummaryController.unknown"));
    assert.ok(failures.some((l) => l["service"] === "orders" && l["reason"] === "timeout"));
    assert.ok(!/SECRET-INTERNAL/.test(gw.logs()));
  } finally { gw.child.kill("SIGKILL"); }
});

test("make:route --upstream --dto: the body is validated at the gateway, then forwarded unchanged with the caller's credentials", READY, async () => {
  const fx = await fixture();
  const gw = await fx.start();
  try {
    fx.orders.seen.length = 0;
    const token = await fx.token("orders:write");
    const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }): Promise<Response> =>
      fetch(gw.url("/summary/orders"), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    // invalid input never reaches the service
    const invalid = await expectProblem(await post({ customerId: "c1", quantity: 0 }), 400, "PSO_VALIDATION_FAILED");
    assert.ok((invalid["errors"] as Array<{ field?: string }>).some((e) => e.field === "quantity"));
    await expectProblem(await post({ customerId: "c1", quantity: 2, admin: true }), 400, "PSO_VALIDATION_FAILED");
    await expectProblem(await post("{not json"), 400, "PSO_HTTP_INVALID_JSON");
    // neither does an unauthenticated or unauthorized request
    await expectProblem(await post({ customerId: "c1", quantity: 2 }, {}), 401, "PSO_AUTH_UNAUTHORIZED");
    await expectProblem(await post({ customerId: "c1", quantity: 2 }, { authorization: `Bearer ${await fx.token("summary:read")}` }), 403, "PSO_AUTH_FORBIDDEN");
    assert.equal(fx.orders.seen.length, 0, "the service saw none of the refused requests");
    // a valid request is forwarded: the same bytes, the service prefix applied, the token forwarded on the guarded route
    const raw = '{ "customerId": "c1",  "quantity": 2 }';
    const ok = await post(raw);
    assert.equal(ok.status, 201, await ok.clone().text());
    assert.deepEqual(await ok.json(), { accepted: { customerId: "c1", quantity: 2 } });
    assert.equal(fx.orders.seen.length, 1);
    const sent = fx.orders.seen[0]!;
    assert.equal(sent.path, "/orders/summary/orders");
    assert.equal(sent.body, raw, "the upstream receives exactly what the client sent");
    assert.equal(sent.headers["authorization"], `Bearer ${token}`);
    assert.equal(sent.headers["content-type"], "application/json");
  } finally { gw.child.kill("SIGKILL"); }
});

test("lifecycle hook and unexpected-error diagnostics on the running process", READY, async () => {
  const fx = await fixture();
  // default: the error is diagnosable (type, origin, component, correlation id) and its message is not recorded
  const quiet = await fx.start();
  try {
    const ready = quiet.lines().findIndex((l) => l["msg"] === "hook ready" && l["component"] === "audit");
    const listening = quiet.lines().findIndex((l) => l["msg"] === "orchestrator listening");
    assert.ok(ready >= 0, "the hook registered with --module ran");
    assert.ok(ready < listening, "onReady runs before the application reports that it is listening");
    assert.ok(quiet.lines().some((l) => l["msg"] === "lifecycle hooks ran" && JSON.stringify(l["hooks"]) === '["AuditHook"]'));
    const p = await expectProblem(await fetch(quiet.url("/summary/boom"), { headers: { "x-correlation-id": "corr-boom-000001" } }), 500, "PSO_INTERNAL_ERROR");
    assert.ok(!/hunter2|passwd|secret internals/.test(JSON.stringify(p)));
    const logged = quiet.lines().find((l) => l["msg"] === "unhandled error in a request")!;
    assert.equal(logged["error"], "Error");
    assert.equal(logged["component"], "SummaryController.boom");
    assert.equal(logged["route"], "GET /summary/boom");
    assert.equal(logged["correlationId"], "corr-boom-000001");
    assert.match(String(logged["origin"]), /SummaryController\.boom .*summary\.controller\.js:\d+:\d+/, "the log points at the failing line of the application");
    assert.equal(logged["message"], undefined, "the message is not recorded by default");
    assert.equal(logged["stack"], undefined);
    assert.ok(!/hunter2|passwd/.test(quiet.logs()));
  } finally { quiet.child.kill("SIGKILL"); }

  // development diagnostics (what `pso dev` turns on): message and stack, through the logger's redaction
  const dev = await fx.start({ PSO_LOG_ERROR_DETAILS: "true" });
  try {
    const p = await expectProblem(await fetch(dev.url("/summary/boom")), 500, "PSO_INTERNAL_ERROR");
    assert.ok(!/hunter2|passwd|secret internals/.test(JSON.stringify(p)), "the client still gets the sanitized problem");
    const logged = dev.lines().find((l) => l["msg"] === "unhandled error in a request")!;
    assert.match(String(logged["message"]), /secret internals: \/etc\/passwd password=\[REDACTED\]/, "the message is there and credentials in it are redacted");
    assert.ok(Array.isArray(logged["stack"]) && (logged["stack"] as string[]).some((f) => /summary\.controller\.js/.test(f)), "with the stack");
    assert.ok(!/hunter2/.test(dev.logs()));
  } finally { dev.child.kill("SIGKILL"); }

  // production never records the message, whatever the variable says, and says that it ignored it
  const prod = await fx.start({ PSO_LOG_ERROR_DETAILS: "true", PSO_ENV: "production" });
  try {
    await expectProblem(await fetch(prod.url("/summary/boom")), 500, "PSO_INTERNAL_ERROR");
    const logged = prod.lines().find((l) => l["msg"] === "unhandled error in a request")!;
    assert.equal(logged["message"], undefined);
    assert.match(String(logged["origin"]), /summary\.controller\.js/, "the origin is still recorded");
    assert.ok(prod.lines().some((l) => /logging\.errorDetails is ignored in production/.test(String(l["msg"]))));
    assert.ok(!/hunter2|passwd/.test(prod.logs()));
  } finally { prod.child.kill("SIGKILL"); }
});

test("the declarations stay authoritative: an unknown service is refused by pso validate, by the compiler and at start-up", READY, async () => {
  const fx = await fixture();
  const routesFile = join(fx.gw, "src/routes/summary/ROUTES.pso.ts");
  const original = readFileSync(routesFile, "utf8");
  try {
    writeFileSync(routesFile, original.replace('metadata: { services: ["customers","orders","catalog"] }', 'metadata: { services: ["customers","orders","billing"] }'));
    const v = await pso(fx.root, "validate");
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /PSO_ROUTE_010/);
    assert.match(v.out, /Found: billing/);
    // with src/pso-types.d.ts the compiler refuses the name as well
    assert.throws(() => compileProject(fx.gw), /billing/);
  } finally { writeFileSync(routesFile, original); }
  compileProject(fx.gw);
  // the generated type file follows the workspace: a new service makes it stale until `pso types` runs again
  assert.equal((await pso(fx.root, "create", "service", "billing", "--structure", "legacy", "--port", String(await unusedPort()))).code, 0);
  assert.equal((await pso(fx.root, "types", "--check")).code, 1);
  assert.equal((await pso(fx.root, "types")).code, 0);
  assert.match(readFileSync(join(fx.gw, "src/pso-types.d.ts"), "utf8"), /"billing": true;/);
  assert.ok(existsSync(join(fx.gw, "src/hooks/audit.hook.ts")));
});
