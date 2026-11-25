import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { startStudio, type Studio } from "../src/studio.ts";
import { pso, tmp } from "./helpers.ts";

/**
 * Operational actions of Studio's frontend section: off by default, loopback and cookie and CSRF-guarded like the Cloud operations, a fixed
 * argument grammar, typed confirmation for the state-changing actions, and every action is the real `pso frontend:*` command.
 */
const studios: Studio[] = []; after(async () => { for (const s of studios) await s.close(); });
async function workspace() {
  const base = tmp("pso-studio-ops-");
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const root = join(base, "shop");
  assert.equal((await pso(root, "create", "orchestrator", "shop-gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "fei", "shop")).code, 0);
  assert.equal((await pso(root, "create", "mei", "customers", "--register")).code, 0);
  return root;
}
interface Res { status: number; body: any; headers: Record<string, string | string[] | undefined> }
function call(s: Studio, method: string, path: string, o: { cookie?: string | undefined; body?: unknown; headers?: Record<string, string>; host?: string } = {}): Promise<Res> {
  return new Promise((res, rej) => {
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    const r = request({ host: "127.0.0.1", port: s.port, method, path, headers: { host: o.host ?? `127.0.0.1:${s.port}`, ...(o.cookie ? { cookie: o.cookie } : {}), ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...(o.headers ?? {}) } }, (x) => { const c: Buffer[] = []; x.on("data", (b: Buffer) => c.push(b)); x.on("end", () => { let b: unknown = Buffer.concat(c).toString(); try { b = JSON.parse(b as string); } catch { /* text */ } res({ status: x.statusCode ?? 0, body: b, headers: x.headers }); }); });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
}
const cookieOf = async (s: Studio): Promise<string> => { const r = await call(s, "GET", `/?t=${s.token}`); return String((r.headers["set-cookie"] as string[])[0]).split(";")[0]!; };
const post = (s: Studio, cookie: string, body: unknown, over: { headers?: Record<string, string>; host?: string } = {}) => call(s, "POST", "/api/frontend/ops", { cookie, body, headers: { origin: `http://127.0.0.1:${s.port}`, "x-pso-studio": "1", ...(over.headers ?? {}) }, ...(over.host ? { host: over.host } : {}) });

test("frontend operations are off by default: the status says so and every action is refused", async () => {
  const root = await workspace();
  const s = await startStudio({ root }); studios.push(s); const c = await cookieOf(s);
  const st = await call(s, "GET", "/api/frontend/ops", { cookie: c }); assert.equal(st.status, 200); assert.equal(st.body.enabled, false);
  const r = await post(s, c, { action: "validate" }); assert.equal(r.status, 403); assert.match(r.body.error, /disabled/); assert.match(r.body.hint, /--frontend-ops/);
});

test("when enabled: the guards of Studio still apply (cookie, host, origin, header, JSON), the argument grammar is fixed, and confirmation is typed", async () => {
  const root = await workspace();
  const s = await startStudio({ root, frontendOps: true }); studios.push(s); const c = await cookieOf(s);
  assert.equal((await call(s, "POST", "/api/frontend/ops", { body: { action: "validate" }, headers: { origin: `http://127.0.0.1:${s.port}`, "x-pso-studio": "1" } })).status, 403, "no access cookie");
  assert.equal((await post(s, c, { action: "validate" }, { host: "evil.example" })).status, 403, "DNS rebinding");
  assert.equal((await post(s, c, { action: "validate" }, { headers: { origin: "http://evil.example" } })).status, 403, "cross-origin");
  assert.equal((await call(s, "POST", "/api/frontend/ops", { cookie: c, body: { action: "validate" }, headers: { origin: `http://127.0.0.1:${s.port}` } })).status, 403, "the custom header is required");
  assert.equal((await call(s, "PUT", "/api/frontend/ops", { cookie: c, body: {} })).status, 405);
  assert.equal((await post(s, c, { action: "format-disk" })).status, 400);
  for (const project of ["../../etc", "fei-shop; rm -rf", "mei-nope", "FEI-SHOP", "x".repeat(80)]) assert.equal((await post(s, c, { action: "build", project })).status, 400, project);
  assert.equal((await post(s, c, { action: "build", project: "fei-shop", basePath: "https://evil.example/" })).status, 400);
  assert.equal((await post(s, c, { action: "publish", project: "mei-customers" })).status, 400, "publish needs the typed confirmation");
  assert.equal((await post(s, c, { action: "publish", project: "mei-customers", confirm: "yes" })).status, 400);
  assert.equal((await post(s, c, { action: "rollback", project: "mei-customers", confirm: "publish mei-customers" })).status, 400, "the confirmation names the action AND the project");
  assert.equal((await post(s, c, { action: "publish" })).status, 400, "publish needs a project");
  assert.ok(!existsSync(join(root, ".pso", "studio-site")), "nothing was written by a refused request");
});

test("validate, publish and rollback are the real CLI commands: output and exit codes come from them, and the local site registry shows what is active", async () => {
  const root = await workspace();
  const { buildFeiManifest, buildRemoteManifest } = await import("@pso/frontend/node");
  const shared = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" };
  for (const [proj] of [["fei-shop"], ["mei-customers"]]) { const d = join(root, "frontend", proj!); for (const [n, v] of Object.entries(shared)) { mkdirSync(join(d, "node_modules", n), { recursive: true }); writeFileSync(join(d, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v })); } mkdirSync(join(d, "dist", "assets"), { recursive: true }); }
  writeFileSync(join(root, "frontend", "fei-shop", "dist", "index.html"), "<html>shell</html>"); writeFileSync(join(root, "frontend", "fei-shop", "dist", "assets", "main-1.js"), "x");
  buildFeiManifest({ dir: join(root, "frontend", "fei-shop"), definition: { name: "fei-shop", orchestrator: { service: "shop-gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }] }, version: "1.0.0", basePath: "/" });
  writeFileSync(join(root, "frontend", "mei-customers", "dist", "remoteEntry.js"), "export {}"); writeFileSync(join(root, "frontend", "mei-customers", "dist", "assets", "m.js"), "export default 1");
  buildRemoteManifest({ dir: join(root, "frontend", "mei-customers"), definition: { name: "mei-customers", host: "fei-shop", orchestrator: { service: "shop-gateway" } }, routes: [], version: "1.0.0" });

  const s = await startStudio({ root, frontendOps: true }); studios.push(s); const c = await cookieOf(s);
  const v = await post(s, c, { action: "validate" }); assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.body.ok, true, v.body.output); assert.match(v.body.output, /OK/); assert.ok(v.body.durationMs >= 0);

  const early = await post(s, c, { action: "publish", project: "mei-customers", confirm: "publish mei-customers" });
  assert.equal(early.body.ok, false, "a microfrontend is not published before its shell"); assert.match(early.body.output, /FEI release is active|publish the FEI first/i);

  const feiPub = await post(s, c, { action: "publish", project: "fei-shop", confirm: "publish fei-shop" }); assert.equal(feiPub.body.ok, true, feiPub.body.output);
  const meiPub = await post(s, c, { action: "publish", project: "mei-customers", confirm: "publish mei-customers" }); assert.equal(meiPub.body.ok, true, meiPub.body.output);
  const st = (await call(s, "GET", "/api/frontend/ops", { cookie: c })).body;
  assert.equal(st.releases.fei.active, "1.0.0"); assert.deepEqual(st.releases.meis.map((m: { name: string; active: string }) => [m.name, m.active]), [["mei-customers", "1.0.0"]]);
  assert.equal(st.last.action, "publish"); assert.equal(st.siteRoot, ".pso/studio-site");

  const rb = await post(s, c, { action: "rollback", project: "mei-customers", confirm: "rollback mei-customers" });
  assert.equal(rb.body.ok, false, "there is no earlier release: the CLI refuses and nothing changes"); assert.match(rb.body.output, /no earlier release/);
  assert.equal((await call(s, "GET", "/api/frontend/ops", { cookie: c })).body.releases.meis[0].active, "1.0.0");
  assert.doesNotMatch(JSON.stringify(st), /password|secret|token/i);
});

test("development servers: a start that cannot work reports why in the log, a stop is always safe, and nothing keeps running after Studio closes", async () => {
  const root = await workspace();
  const s = await startStudio({ root, frontendOps: true }); const c = await cookieOf(s);
  const started = await post(s, c, { action: "dev-start" }); assert.equal(started.status, 200);
  for (let i = 0; i < 50 && (await call(s, "GET", "/api/frontend/ops", { cookie: c })).body.dev.running; i++) await new Promise((r) => setTimeout(r, 200));
  const after1 = (await call(s, "GET", "/api/frontend/ops", { cookie: c })).body.dev;
  assert.equal(after1.running, false, "without installed dependencies the servers cannot start"); assert.ok(after1.log.length > 0, "the log says what happened");
  assert.equal((await post(s, c, { action: "dev-stop" })).status, 200, "stopping when nothing runs is a no-op");
  assert.equal((await post(s, c, { action: "dev-start", project: "mei-customers" })).status, 200);
  await s.close();
});
