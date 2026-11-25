import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { pso, tmp, unusedPort } from "./helpers.ts";
import { psoJavaInstalled, psoJavaVersion } from "../src/specs.ts";

/**
 * Generated Spring artifacts are compiled, started and used, not only read (F-01, F-10, F-23, and the development identity provider):
 *   - `pso make:controller orders --service orders` in the service whose prefix is /orders: the service starts and answers at
 *     /orders/orders over real HTTP, with a token signed by `pso idp:dev token` and validated against the JWKS of `pso idp:dev init`;
 *   - `make:event` / `make:listener` are a LOCAL application event and its listener; `make:dispatch-event` / `make:dispatch-handler`
 *     are a DISTRIBUTED event and its consumer. Both pairs compile and run, and neither is the other;
 *   - with Dispatch enabled the way the documentation says (pso.dispatch.enabled: true), every generated test of the service still
 *     passes without a broker: the test profile uses the in-process adapter that `pso dispatch:install` configured.
 */
const javaOk = spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;
const skip = !javaOk ? "JDK not found: Spring Boot integration tests cannot run on this machine" : psoJavaInstalled(psoJavaVersion()) ? false : "PSO Java artifacts are not installed: run `pso java:install` first";
const dirs: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
after(async () => {
  for (const c of children) killTree(c);
  for (const s of servers) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } }
});

function mvnw(cwd: string, ...args: string[]) {
  const [cmd, base] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd"]] : ["./mvnw", []];
  return spawnSync(cmd!, [...(base as string[]), "-B", "-ntp", ...args], { cwd, encoding: "utf8", timeout: 900_000, maxBuffer: 128 * 1024 * 1024 });
}
/** Ends a process and everything it started. On Windows `java` on the PATH is a launcher: the JVM is its child and survives a plain kill. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}
const java = (root: string, ...p: string[]): string => readFileSync(join(root, "orders", "src", "main", "java", "com", "pso", "orders", ...p), "utf8").replaceAll("\r\n", "\n");

test("layered service: make:event, make:listener, make:dispatch-event and make:dispatch-handler write application/event/, validate and compile", { skip, timeout: 900_000 }, async () => {
  const base = tmp("pso-deam-layered-"); dirs.push(base);
  const root = join(base, "w");
  const ok = async (...argv: string[]): Promise<string> => { const r = await pso(root, ...argv); assert.equal(r.code, 0, `pso ${argv.join(" ")}\n${r.out}${r.err}`); return r.out; };
  assert.equal((await pso(base, "create", "workspace", "w", "--layout", "flat")).code, 0);
  await ok("create", "service", "orders", "--template", "empty");
  assert.match(await ok("make:event", "order-shipped", "--service", "orders"), /created\s+src\/main\/java\/com\/pso\/orders\/application\/event\/OrderShippedEvent\.java/);
  assert.match(await ok("make:listener", "order-shipped", "--service", "orders"), /created\s+src\/main\/java\/com\/pso\/orders\/application\/event\/OrderShippedListener\.java/);
  assert.match(await ok("make:dispatch-event", "orders.placed", "--service", "orders", "--fields", "orderId:string,total:number"), /created\s+src\/main\/java\/com\/pso\/orders\/application\/event\/OrdersPlacedEvent\.java/);
  assert.match(await ok("make:dispatch-handler", "orders.placed", "--service", "orders"), /created\s+src\/main\/java\/com\/pso\/orders\/application\/event\/OrdersPlacedHandler\.java/);
  for (const f of ["OrderShippedEvent", "OrderShippedListener", "OrdersPlacedEvent", "OrdersPlacedHandler"]) assert.match(java(root, "application", "event", `${f}.java`), /^package com\.pso\.orders\.application\.event;\n/, f);
  assert.match(java(root, "application", "event", "OrderShippedListener.java"), /public void on\(OrderShippedEvent event\)/, "the listener finds its event in application/event/");
  assert.match(java(root, "application", "event", "OrdersPlacedHandler.java"), /public void on\(OrdersPlacedEvent event, ConsumeContext ctx\)/, "the handler finds its payload record in application/event/");
  assert.ok(!existsSync(join(root, "orders", "src", "main", "java", "com", "pso", "orders", "events")), "no 0.1 events/ package in a layered service");
  const validated = await pso(root, "validate");
  assert.equal(validated.code, 0, validated.out + validated.err);
  assert.equal((await pso(root, "dispatch:validate")).code, 0);
  assert.match(await ok("dispatch:consumers"), /\(src\/main\/java\/com\/pso\/orders\/application\/event\/OrdersPlacedHandler\.java\)/);
  const built = mvnw(join(root, "orders"), "-o", "-q", "compile");
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`.split("\n").filter((l) => /ERROR/.test(l)).slice(0, 20).join("\n"));
});

test("generated controller (prefix named like the service), local events and Dispatch events: compiled, started, called over HTTP and executed", { skip, timeout: 1_800_000 }, async () => {
  const base = tmp("pso-deam-spring-"); dirs.push(base);
  const root = join(base, "w");
  const ok = async (...argv: string[]): Promise<string> => { const r = await pso(root, ...argv); assert.equal(r.code, 0, `pso ${argv.join(" ")}\n${r.out}${r.err}`); return r.out; };
  assert.equal((await pso(base, "create", "workspace", "w", "--layout", "flat")).code, 0);
  const port = await unusedPort();
  await ok("create", "orchestrator", "gw", "--structure", "legacy");
  await ok("create", "service", "orders", "--structure", "legacy", "--port", String(port));

  // ---- F-01: the exact command of the finding, plus the cases that must NOT be touched ----
  await ok("make:controller", "orders", "--service", "orders");
  await ok("make:controller", "invoices", "--service", "orders");
  await ok("make:controller", "order-archive", "--service", "orders", "--route", "/orders/archive");
  await ok("make:controller", "orders-export", "--service", "orders", "--method", "POST");
  const orders = java(root, "routes", "OrdersController.java");
  assert.match(orders, /import com\.pso\.spring\.autoconfigure\.RepeatsServicePrefix;/);
  assert.match(orders, /\/\/ The service prefix \/orders is applied by PSO, so this controller is served at \/orders\/orders\./);
  assert.match(orders, /@RestController\n@RepeatsServicePrefix\n@RequestMapping\("\/orders"\)/, "the repetition is declared; the path is not rewritten");
  assert.match(java(root, "routes", "OrderArchiveController.java"), /@RepeatsServicePrefix\n@RequestMapping\("\/orders\/archive"\)/);
  assert.doesNotMatch(java(root, "routes", "InvoicesController.java"), /RepeatsServicePrefix/, "another path is not annotated");
  assert.doesNotMatch(java(root, "routes", "OrdersExportController.java"), /RepeatsServicePrefix/, "/orders-export is another segment, not a repetition");

  // ---- F-10: the two kinds of event say what they are ----
  await ok("make:event", "order-placed", "--service", "orders");
  await ok("make:listener", "order-placed", "--service", "orders");
  const localEvent = java(root, "events", "OrderPlacedEvent.java");
  assert.match(localEvent, /LOCAL application event/);
  assert.match(localEvent, /pso make:dispatch-event/);
  const listener = java(root, "events", "OrderPlacedListener.java");
  assert.match(listener, /@EventListener\n    public void on\(OrderPlacedEvent event\)/, "the listener is typed with the event of the same name");
  assert.match(listener, /It is not a PSO Dispatch consumer/);
  const installed = await ok("dispatch:install", "redis", "--service", "orders");
  assert.match(installed, /pom\.xml: \+ pso-dispatch-test \(test scope/);
  assert.match(installed, /application-test\.yml: pso\.dispatch\.provider = memory/);
  const declared = await ok("make:dispatch-event", "orders.placed", "--service", "orders", "--fields", "orderId:string,total:number,note?:string", "--key", "orderId");
  assert.match(declared, /created\s+src\/main\/java\/com\/pso\/orders\/events\/OrdersPlacedEvent\.java/);
  await ok("make:dispatch-handler", "orders.placed", "--service", "orders");
  const decl = JSON.parse(readFileSync(join(root, "orders/src/main/resources/dispatch/orders.events.json"), "utf8")) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(decl.events, [{ name: "orders.placed", version: 1, channel: "orders.events", key: "orderId", compatibility: "full", schema: { type: "object", required: ["orderId", "total"], properties: { orderId: { type: "string" }, total: { type: "number" }, note: { type: ["string", "null"] } } } }]);
  assert.match(java(root, "events", "OrdersPlacedEvent.java"), /public record OrdersPlacedEvent\(String orderId, double total, String note\)/);
  const handler = java(root, "events", "OrdersPlacedHandler.java");
  assert.match(handler, /@PsoEventHandler\("orders\.placed"\)\n    public void on\(OrdersPlacedEvent event, ConsumeContext ctx\)/);
  assert.match(handler, /It is not a Spring @EventListener/);
  // a second declaration of the same version, a handler for an undeclared event and a key that is not a field are refused
  assert.equal((await pso(root, "make:dispatch-event", "orders.placed", "--service", "orders", "--fields", "orderId:string")).code, 1);
  assert.equal((await pso(root, "make:dispatch-handler", "orders.cancelled", "--service", "orders")).code, 1);
  assert.equal((await pso(root, "make:dispatch-event", "orders.shipped", "--service", "orders", "--fields", "orderId:string", "--key", "trackingId")).code, 1);
  const checked = await pso(root, "dispatch:validate");
  assert.equal(checked.code, 0, checked.out + checked.err);
  assert.match(await ok("dispatch:consumers"), /orders\.placed\s+orders\s+on\s+group orders\s+\(src\/main\/java\/com\/pso\/orders\/events\/OrdersPlacedHandler\.java\)/);
  assert.equal((await pso(root, "validate")).code, 0);

  // ---- the development identity provider: keys generated here, public keys served on loopback, a token signed by the CLI ----
  await ok("idp:dev", "init", "--issuer", "http://localhost:9", "--audience", "pso-api");
  const jwks = createServer((req, res) => { if (req.url === "/.well-known/jwks.json") { const t = readFileSync(join(root, "idp", "jwks.json")); res.writeHead(200, { "content-type": "application/json", "content-length": t.length }); res.end(t); } else { res.writeHead(404); res.end(); } });
  servers.push(jwks);
  await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
  const token = (await ok("idp:dev", "token", "--scopes", "orders:read", "--sub", "alice")).trim();
  assert.match(token, /^[\w-]+\.[\w-]+\.[\w-]+$/, "the command prints the token and nothing else");
  assert.ok(!existsSync(join(root, "idp", "keys", "..", "jwks.json.private")), "sanity");
  assert.ok(readFileSync(join(root, ".gitignore"), "utf8").includes("idp/keys/"), "the private key is git-ignored");
  assert.ok(!/PRIVATE KEY/.test(readFileSync(join(root, "idp", "jwks.json"), "utf8") + readFileSync(join(root, "idp", "dev-idp.cjs"), "utf8")), "the JWKS server holds public keys only");

  // ---- compiled and started: the real application, a real port, real HTTP ----
  const svc = join(root, "orders");
  const built = mvnw(svc, "-o", "-q", "package", "-DskipTests");
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`.split("\n").filter((l) => /ERROR/.test(l)).slice(0, 20).join("\n"));
  const child = spawn("java", ["-jar", join(svc, "target", "orders-0.1.0.jar")], {
    cwd: svc, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), SPRING_PROFILES_ACTIVE: "local", PSO_JWT_ISSUER: "http://localhost:9", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_JWKS_URI: `http://127.0.0.1:${(jwks.address() as { port: number }).port}/.well-known/jwks.json`, PSO_JWT_ALGORITHMS: "ES256" },
  });
  children.push(child);
  let logs = "";
  child.stdout!.on("data", (d: Buffer) => { logs += d; });
  child.stderr!.on("data", (d: Buffer) => { logs += d; });
  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  for (let i = 0; i < 240 && child.exitCode === null; i++) {
    try { if ((await fetch(url("/actuator/health"), { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(child.exitCode, null, `the service started (a repeated prefix that was not declared would have stopped it):\n${logs.slice(-3000)}`);
  assert.doesNotMatch(logs, /already contain it/);
  const auth = { authorization: `Bearer ${token}` };
  const get = await fetch(url("/orders/orders"), { headers: auth });
  assert.equal(get.status, 200, `GET /orders/orders: ${await get.clone().text()}\n${logs.slice(-2000)}`);
  assert.deepEqual(await get.json(), []);
  assert.equal((await fetch(url("/orders/orders/archive"), { headers: auth })).status, 200);
  assert.equal((await fetch(url("/orders/invoices"), { headers: auth })).status, 200);
  assert.equal((await fetch(url("/orders/orders-export"), { method: "POST", headers: auth })).status, 200);
  assert.equal((await fetch(url("/orders"), { headers: auth })).status, 404, "the prefix alone is not a route");
  // the token of the development identity provider is really validated: none, a tampered one and another audience are refused
  assert.equal((await fetch(url("/orders/orders"))).status, 401);
  assert.equal((await fetch(url("/orders/orders"), { headers: { authorization: `Bearer ${token.slice(0, -4)}AAAA` } })).status, 401);
  const other = (await ok("idp:dev", "token", "--audience", "another-api")).trim();
  assert.equal((await fetch(url("/orders/orders"), { headers: { authorization: `Bearer ${other}` } })).status, 401);
  killTree(child);
  await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));

  // ---- executed: the local event reaches its listener, the Dispatch event its handler, with Dispatch ENABLED and no broker ----
  const yml = join(svc, "src/main/resources/application.yml");
  const before = readFileSync(yml, "utf8");
  const enabled = before.replace(/^(  dispatch:[^\n]*\r?\n    enabled: )false/m, "$1true");
  assert.notEqual(enabled, before, "pso.dispatch.enabled was switched on the documented way");
  writeFileSync(yml, enabled);
  const record = (file: string, marker: string, line: string): void => {
    const f = join(svc, "src/main/java/com/pso/orders/events", file);
    const t = readFileSync(f, "utf8");
    assert.ok(t.includes(marker), `${file}: ${marker}`);
    writeFileSync(f, t.replace(marker, `${marker}\n        SEEN.add(${line});`).replace(/public class (\w+) \{/, "public class $1 {\n\n    public static final java.util.List<String> SEEN = new java.util.concurrent.CopyOnWriteArrayList<>();"));
  };
  record("OrderPlacedListener.java", "public void on(OrderPlacedEvent event) {", '"local:" + event.id()');
  record("OrdersPlacedHandler.java", "public void on(OrdersPlacedEvent event, ConsumeContext ctx) {", '"dispatch:" + event.orderId() + ":" + event.total()');
  const testDir = join(svc, "src/test/java/com/pso/orders/events");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "EventsFlowTests.java"), `package com.pso.orders.events;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pso.dispatch.DispatchAdapter;
import com.pso.dispatch.PsoDispatch;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest
@ActiveProfiles("test")
class EventsFlowTests {

    @Autowired ApplicationEventPublisher local;
    @Autowired PsoDispatch dispatch;
    @Autowired DispatchAdapter adapter;

    @Test
    void theLocalEventReachesItsListenerInProcess() {
        local.publishEvent(new OrderPlacedEvent("o-1"));
        assertTrue(OrderPlacedListener.SEEN.contains("local:o-1"));
        assertTrue(OrdersPlacedHandler.SEEN.stream().noneMatch(s -> s.contains("o-1")), "a local event is not a Dispatch event");
    }

    @Test
    void theDispatchEventReachesItsHandlerThroughTheTestAdapter() throws Exception {
        assertEquals("memory", adapter.capabilities().provider(), "the tests of the service use the in-process adapter: no broker");
        dispatch.publish("orders.placed", new OrdersPlacedEvent("o-2", 12.5, null));
        long deadline = System.currentTimeMillis() + 15000;
        while (!OrdersPlacedHandler.SEEN.contains("dispatch:o-2:12.5") && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
        assertTrue(OrdersPlacedHandler.SEEN.contains("dispatch:o-2:12.5"));
        assertTrue(OrderPlacedListener.SEEN.stream().noneMatch(s -> s.contains("o-2")), "a Dispatch event is not a local event");
    }
}
`);
  const tested = mvnw(svc, "-o", "test");
  const out = `${tested.stdout}${tested.stderr}`;
  assert.equal(tested.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 30).join("\n"));
  assert.match(out, /Tests run: 2, Failures: 0, Errors: 0, Skipped: 0.* -- in com\.pso\.orders\.events\.EventsFlowTests/);
  // the tests PSO generated with the service still pass with Dispatch enabled: none of them needs a broker
  // (ApplicationTests includes the generated check that a broker adapter exists exactly when Dispatch is enabled)
  for (const cls of ["ApplicationTests", "routes\\.PingControllerTests", "application\\.PingServiceTests"]) assert.match(out, new RegExp(`Tests run: \\d+, Failures: 0, Errors: 0, Skipped: 0.* -- in com\\.pso\\.orders\\.${cls}`), cls);
  // static validation keeps the test adapter where it belongs
  writeFileSync(yml, enabled.replace(/^(    provider: )redis/m, "$1memory"));
  const misplaced = await pso(root, "security:validate");
  assert.equal(misplaced.code, 1, misplaced.out);
  assert.match(misplaced.out, /SPR015/);
});
