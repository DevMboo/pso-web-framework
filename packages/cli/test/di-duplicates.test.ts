import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, setLogSink, resetLogging, type App } from "@pso/http";
import { tmp, unusedPort } from "./helpers.ts";

/**
 * Dependency injection when more than one physical copy of an @pso package is loaded (DI-01). The container keys instances by class
 * identity; a provider compiled against ANOTHER copy of @pso/dispatch or @pso/channels names a different class object for the same
 * thing. Before the fix the container did not find it and silently constructed a new, unconnected object (an abstract Dispatch
 * without publish(), a ChannelPublisher without a hub). Now the framework's injectable classes carry a stable token:
 *   - an equivalent copy (same contract) resolves to the instance the runtime registered, and the duplication is reported;
 *   - an incompatible copy (another contract) stops start-up with a diagnostic that names the dependency;
 *   - containers stay per application: nothing is shared through a global registry.
 */
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const distOf = (pkg: string): string => join(REPO, "packages", pkg, "dist", "index.js");

const dirs: string[] = [];
const apps: App[] = [];
after(async () => { for (const a of apps) await a.close().catch(() => undefined); resetLogging(); for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

/** A second PHYSICAL installation of a package: its own files in another directory (its dependencies resolve like the original's). */
function physicalCopy(pkg: "dispatch" | "channels", edit?: (file: string, text: string) => string): string {
  const root = tmp("pso-dup-"); dirs.push(root);
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "junction"); // bare imports of the copy (reflect-metadata, ws, @pso/http, ...) resolve to the repository installation
  const target = join(root, "copies", pkg);
  mkdirSync(target, { recursive: true });
  cpSync(join(REPO, "packages", pkg, "dist"), join(target, "dist"), { recursive: true });
  writeFileSync(join(target, "package.json"), readFileSync(join(REPO, "packages", pkg, "package.json")));
  if (edit) for (const f of ["engine.js", "server.js"]) { const file = join(target, "dist", f); try { writeFileSync(file, edit(f, readFileSync(file, "utf8"))); } catch { /* that file belongs to the other package */ } }
  return join(target, "dist", "index.js");
}

interface Fx { project: string; appDir: string }
/**
 * One module with a provider that injects Dispatch and ChannelPublisher taken from the given package files, and GET /probe that
 * reports what was injected. `dispatch/` exists and dispatch is disabled, so the runtime registers its (disabled) Dispatch without a broker.
 */
function fixture(o: { dispatchFrom?: string; channelsFrom?: string; channels?: boolean; tag: string }): Fx {
  const project = tmp("pso-di-"); dirs.push(project);
  const appDir = join(project, "dist");
  mkdirSync(join(appDir, "routes", "probe"), { recursive: true });
  mkdirSync(join(appDir, "dispatch"), { recursive: true });
  const q = JSON.stringify;
  writeFileSync(join(appDir, "routes", "probe", "ROUTES.pso.js"), `const http = require(${q(distOf("http"))});
const d = require(${q(o.dispatchFrom ?? distOf("dispatch"))});
${o.channels ? `const ch = require(${q(o.channelsFrom ?? distOf("channels"))});` : ""}
class Probe { constructor(dispatch${o.channels ? ", publisher" : ""}) { this.dispatch = dispatch; ${o.channels ? "this.publisher = publisher;" : ""} } }
http.Injectable()(Probe);
Reflect.defineMetadata("design:paramtypes", [d.Dispatch${o.channels ? ", ch.ChannelPublisher" : ""}], Probe);
class ProbeController {
  constructor(probe) { this.probe = probe; }
  async show() {
    (globalThis.__psoProbe ??= {})[${q(o.tag)}] = this.probe;
    const health = typeof this.probe.dispatch.health === "function" ? await this.probe.dispatch.health() : null;
    let published = null;
    ${o.channels ? `try { published = Object.keys(await this.probe.publisher.publish("news", "news.posted", { title: "hello" })); } catch (e) { published = String(e.code || e.message); }` : ""}
    return { publish: typeof this.probe.dispatch.publish, health, published };
  }
}
http.Controller()(ProbeController); http.RestController("/probe")(ProbeController);
http.Get("/")(ProbeController.prototype, "show"); http.Public()(ProbeController.prototype, "show");
Reflect.defineMetadata("design:paramtypes", [Probe], ProbeController);
exports.ProbeController = ProbeController; exports.Probe = Probe;
exports.default = http.defineRoutes({ routes: [{ method: "GET", path: "/probe", controller: ProbeController, action: "show", security: { public: true } }] });
`);
  writeFileSync(join(appDir, "routes", "probe", "MODULE.pso.js"), `const core = require(${q(distOf("core"))}); const http = require(${q(distOf("http"))});
const r = require("./ROUTES.pso.js");
${o.channels ? `const ch = require(${q(distOf("channels"))});
class News { open() { return true; } }
ch.Channel("news", { visibility: "public" })(News); ch.OnSubscribe()(News.prototype, "open"); http.Public()(News.prototype, "open");` : ""}
exports.default = core.defineModule({ name: "probe", controllers: [r.ProbeController], providers: [r.Probe], routes: r.default${o.channels ? ", channels: [News]" : ""} });
`);
  return { project, appDir };
}

const FRAMEWORK_VARS = /^(PSO_|RATE_LIMIT_|OTEL_|MAX_|PORT$|HOST$|NODE_ENV$|REDIS_URL$)/;
const logs: Array<Record<string, unknown>> = [];
async function start(fx: Fx, channels = false): Promise<{ app: App; port: number }> {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (FRAMEWORK_VARS.test(k)) delete process.env[k];
  Object.assign(process.env, { PSO_LOG_LEVEL: "info", PSO_LOG_FORMAT: "json" });
  if (channels) {
    const pem = join(fx.project, "public.pem");
    writeFileSync(pem, generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }) as string);
    Object.assign(process.env, { PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pem, PSO_JWT_ALGORITHMS: "ES256" });
  }
  logs.length = 0;
  setLogSink((l) => { try { logs.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not JSON */ } });
  try {
    const port = await unusedPort();
    const app = await bootstrap({ appDir: fx.appDir, projectDir: fx.project, port, host: "127.0.0.1" });
    apps.push(app);
    return { app, port };
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}
const probe = async (port: number): Promise<{ publish: string; health: { status: string; detail: string } | null; published: unknown }> => (await (await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(5000) })).json()) as never;
const injected = (tag: string): { dispatch: object; publisher?: object } => (globalThis as unknown as { __psoProbe: Record<string, { dispatch: object; publisher?: object }> }).__psoProbe[tag]!;
const duplicateWarnings = (): Array<Record<string, unknown>> => logs.filter((l) => l["code"] === "PSO_DUPLICATE_PACKAGE");
const DISABLED = { status: "down", detail: "dispatch is disabled" };

test("single installation: Dispatch and ChannelPublisher are the runtime's instances; nothing is reported", async () => {
  const { port } = await start(fixture({ tag: "single", channels: true }), true);
  const seen = await probe(port);
  assert.equal(seen.publish, "function");
  assert.deepEqual(seen.health, DISABLED, "the Dispatch the runtime registered for this application");
  assert.deepEqual(seen.published, ["eventId"], "the publisher is connected to this application's hub");
  assert.deepEqual(duplicateWarnings(), []);
});

test("a second physical copy of @pso/dispatch (equivalent version): the provider receives the runtime's Dispatch, not an unconnected object; the duplication is reported", async () => {
  const copy = physicalCopy("dispatch");
  const { port } = await start(fixture({ tag: "dup-dispatch", dispatchFrom: copy }));
  const seen = await probe(port);
  assert.equal(seen.publish, "function", "before the fix this was \"undefined\": a bare instance of the other copy's abstract class");
  assert.deepEqual(seen.health, DISABLED, "it IS the instance the runtime registered");
  const { Dispatch } = await import("@pso/dispatch");
  assert.ok(injected("dup-dispatch").dispatch instanceof Dispatch, "an object of the runtime's own class");
  const warned = duplicateWarnings();
  assert.equal(warned.length, 1, "reported once");
  assert.equal(warned[0]!["dependency"], "Dispatch");
  assert.match(String(warned[0]!["msg"] ?? warned[0]!["message"]), /more than one copy/);
});

test("a second physical copy of @pso/channels: ChannelPublisher resolves to the publisher connected to the hub", async () => {
  const copy = physicalCopy("channels");
  const { port } = await start(fixture({ tag: "dup-channels", channels: true, channelsFrom: copy }), true);
  const seen = await probe(port);
  assert.deepEqual(seen.published, ["eventId"], "before the fix: PSO_CHANNEL_UNAVAILABLE (a publisher of the other copy, whose hub was never set)");
  assert.equal(duplicateWarnings().filter((w) => w["dependency"] === "ChannelPublisher").length, 1);
});

test("an INCOMPATIBLE copy (another contract version) is refused at start-up with a diagnostic that names the dependency", async () => {
  const copy = physicalCopy("dispatch", (_f, text) => text.replace(/contract: 1 \}/g, "contract: 2 }"));
  assert.ok(readFileSync(join(copy, "..", "engine.js"), "utf8").includes("contract: 2 }"), "the copy really declares another contract");
  await assert.rejects(start(fixture({ tag: "incompatible", dispatchFrom: copy })), (e: Error) => {
    assert.match(e.message, /PSO_DI_INCOMPATIBLE/);
    assert.match(e.message, /Dispatch/);
    assert.match(e.message, /contract 2/);
    assert.match(e.message, /one version/i);
    return true;
  });
});

test("Windows: the same files loaded under two spellings of the drive letter are two module instances; injection still resolves and says why", { skip: process.platform === "win32" ? false : "drive letters exist on Windows only" }, async () => {
  const real = distOf("dispatch");
  const other = /^[A-Z]:/.test(real) ? real[0]!.toLowerCase() + real.slice(1) : real[0]!.toUpperCase() + real.slice(1);
  assert.notEqual(other, real);
  const { port } = await start(fixture({ tag: "drive-case", dispatchFrom: other }));
  const seen = await probe(port);
  assert.equal(seen.publish, "function");
  assert.deepEqual(seen.health, DISABLED);
  assert.equal(duplicateWarnings().length, 1);
});

test("containers are per application: two applications in one process each get their own instances, with or without duplicate copies", async () => {
  const copy = physicalCopy("dispatch");
  const a = await start(fixture({ tag: "app-a", dispatchFrom: copy }));
  const b = await start(fixture({ tag: "app-b" }));
  const c = await start(fixture({ tag: "app-c", dispatchFrom: copy }));
  for (const x of [a, b, c]) assert.equal((await probe(x.port)).publish, "function");
  const [da, db, dc] = [injected("app-a").dispatch, injected("app-b").dispatch, injected("app-c").dispatch];
  assert.ok(da !== db && db !== dc && da !== dc, "no instance is shared between applications (no global registry)");
  assert.notEqual(injected("app-a"), injected("app-c"), "providers are per application as well");
});
