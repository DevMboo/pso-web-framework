import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFeiManifest, buildRemoteManifest } from "@pso/frontend/node";
import type { FeiDefinition, MeiDefinition } from "@pso/frontend";
import { validateDeployment } from "../src/declare.ts";

/**
 * A frontend that SHARES the server of an existing application (nginx.attachTo / nginx.attachPoint): the host's file includes a directory,
 * the shell's locations live in a managed file there. Real nginx in the Linux image: the host keeps serving its routes, the shell and the
 * microfrontends are deployed by the engine, a microfrontend update never touches nginx, a shell update reloads it, and neither needs the
 * host to be deployed again.
 */
const IMAGE = "pso-e2e-target:1";
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 300_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const available = process.env["PSO_E2E_DOCKER"] !== "0" && docker("image", "inspect", IMAGE).status === 0;
if (process.platform === "win32") process.env["PATH"] = `C:/Windows/System32;${process.env["PATH"] ?? ""}`;
const pkgRoot = resolve(import.meta.dirname, "..", "..");
const fixture = resolve(import.meta.dirname, "fixtures", "static-site");
const norm = (p: string): string => p.replaceAll("\\", "/");
const feiDef: FeiDefinition = { name: "fei-shop", orchestrator: { service: "gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }] };
const meiDef = (n: string): MeiDefinition => ({ name: n, host: "fei-shop", orchestrator: { service: "gateway" } });
const SHARED = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" };
const project = (): string => { const d = mkdtempSync(join(tmpdir(), "pso-sa-")); for (const [n, v] of Object.entries(SHARED)) { mkdirSync(join(d, "node_modules", n), { recursive: true }); writeFileSync(join(d, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v })); } mkdirSync(join(d, "dist", "assets"), { recursive: true }); return d; };
const fei = (v: string): string => { const d = project(); writeFileSync(join(d, "dist", "index.html"), `<html><body>shell ${v}</body></html>`); writeFileSync(join(d, "dist", "assets", `main-${v}.js`), `console.log("${v}");`.repeat(40)); buildFeiManifest({ dir: d, definition: feiDef, version: v, basePath: "/commerce/" }); return join(d, "dist"); };
const mei = (v: string): string => { const d = project(); writeFileSync(join(d, "dist", "remoteEntry.js"), `export const v = "${v}";`.repeat(40)); buildRemoteManifest({ dir: d, definition: meiDef("mei-customers"), routes: [], version: v }); return join(d, "dist"); };
const tgz = (dist: string, run: string, file: string): void => { const r = spawnSync("tar", ["-czf", file, "-C", dist, "."], { cwd: run, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
const get = (port: number, path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> => new Promise((res, rej) => { const r = request({ host: "127.0.0.1", port, path, agent: false, headers: { host: "203.0.113.10", connection: "close" }, timeout: 10_000 }, (x) => { const c: Buffer[] = []; x.on("data", (b: Buffer) => c.push(b)); x.on("end", () => res({ status: x.statusCode ?? 0, headers: Object.fromEntries(Object.entries(x.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(c).toString() })); }); r.on("error", rej); r.end(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const name = `pso-static-attach-${process.pid}`;
after(() => { docker("rm", "-f", name); });

test("declaration rules: an attached shell has no server of its own; only a host that serves through nginx has an attach point", () => {
  const base = { name: "shop-fei", environment: "production", connection: { provider: "ssh", credentials: "azure" }, source: { provider: "artifact", path: "dist" }, strategy: { type: "static", proxy: "nginx" } };
  const svc = (extra: object) => [{ name: "shell", runtime: "static", static: { site: "shop", kind: "fei", basePath: "/commerce/", probe: { port: 20003 }, ...extra } }];
  const errs = (d: unknown) => validateDeployment(d as never).filter((x) => x.level === "error").map((x) => x.message);
  assert.deepEqual(errs({ ...base, services: svc({}), proxy: { nginx: { attachTo: "shop-gateway" } } }), []);
  assert.match(errs({ ...base, services: svc({}), proxy: { nginx: { attachTo: "shop-gateway", domains: ["x.example.com"] } } }).join("|"), /no server of its own/);
  assert.match(errs({ ...base, services: svc({ api: { upstreamPort: 3000 } }), proxy: { nginx: { attachTo: "shop-gateway" } } }).join("|"), /declare no api/);
  assert.match(errs({ ...base, services: svc({}), proxy: { nginx: { attachTo: "../etc" } } }).join("|"), /name of the application/);
  assert.match(errs({ ...base, services: [{ name: "customers", runtime: "static", static: { site: "shop", kind: "mei" } }], strategy: { type: "static", proxy: "none" }, proxy: { nginx: { attachTo: "shop-gateway" } } }).join("|"), /only the shell/);
  assert.match(errs({ ...base, services: svc({}), proxy: { nginx: { attachPoint: true } } }).join("|"), /attachPoint/);
  for (const bad of [{ orchestratorBasePath: "http://evil" , auth: { kind: "none" } }, { orchestratorBasePath: "/api", auth: { kind: "magic" } }, { orchestratorBasePath: "/api", auth: { kind: "oidc", issuer: "x" } }, { orchestratorBasePath: "/api", auth: { kind: "none" }, trustedKeys: [{ keyId: "k", publicKey: "short" }] }]) assert.match(validateDeployment({ ...base, services: svc({ runtimeConfig: bad }), proxy: { nginx: { attachTo: "shop-gateway" } } } as never).filter((x) => x.level === "error").map((x) => x.path).join("|"), /runtimeConfig/);
});

test("real nginx: the host keeps its routes, the engine attaches the shell, microfrontends never touch nginx, a shell update reloads it, and re-deploying the host keeps the attachment", { skip: available ? false : "Docker or the pso-e2e-target:1 image is not available", timeout: 300_000 }, async () => {
  const run = mkdtempSync(join(tmpdir(), "pso-sa-run-"));
  tgz(fei("1.0.0"), run, "fei-1.0.0.tgz"); tgz(fei("1.1.0"), run, "fei-1.1.0.tgz"); tgz(mei("1.0.0"), run, "cus-1.0.0.tgz"); tgz(mei("1.1.0"), run, "cus-1.1.0.tgz");
  const feiStatic = { site: "shop", kind: "fei", basePath: "/commerce/", probe: { port: 20003 }, runtimeConfig: { orchestratorBasePath: "", auth: { kind: "oidc", issuer: "https://idp.example/realms/pso", authorizationEndpoint: "https://idp.example/auth", tokenEndpoint: "https://idp.example/token", clientId: "commerce-web" }, requireSignature: false, trustedKeys: [{ keyId: "release-1", publicKey: "A".repeat(43) }] } };
  const meiStatic = { site: "shop", kind: "mei", probe: { port: 20003 } };
  const phase = (steps: unknown[]) => writeFileSync(join(run, "steps.json"), JSON.stringify(steps));
  const c = docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080", "-v", `${norm(run)}:/fixture-run`, "-v", `${norm(join(pkgRoot, "frontend"))}:/app/node_modules/@pso/frontend:ro`, "-v", `${norm(join(pkgRoot, "deploy"))}:/app/deploy:ro`, "-v", `${norm(fixture)}:/fixture:ro`, "--entrypoint", "sh", IMAGE, "/fixture/boot.sh");
  assert.equal(c.status, 0, c.stderr);
  for (let i = 0; i < 60 && !docker("logs", name).stdout.includes("boot done"); i++) await sleep(500);
  const port = Number(/:(\d+)\s*$/m.exec(docker("port", name, "8080").stdout)![1]);
  const exec = () => { const r = docker("exec", name, "node", "/fixture/engine-e2e.mjs"); const line = r.stdout.split("\n").find((l) => l.startsWith("RESULTS ")); assert.ok(line, `${r.stdout}\n${r.stderr}`); return JSON.parse(line.slice(8)) as Array<{ step: string; state: string; error: string | null; release?: string }>; };
  const workers = () => docker("exec", name, "sh", "-c", "ps -o pid,args | grep 'nginx: worker' | grep -v grep | awk '{print $1}' | sort | tr '\\n' ' '").stdout.trim();
  const host = (rel: string) => { const r = docker("exec", name, "node", "/fixture/host-apply.mjs", rel); assert.equal(r.status, 0, r.stdout + r.stderr); };

  // the web server must be able to read the site root: a directory below a 0700 one is reported before anything is deployed
  const probe = (p: string) => docker("exec", name, "node", "-e", "import(\"/app/deploy/dist/agent/nginx.js\").then((m) => console.log(JSON.stringify(m.webServerCannotRead(process.argv[1]) ?? null)))", p).stdout.trim();
  docker("exec", name, "sh", "-c", "mkdir -p /srv/ok/site /home/u/priv/sites && chmod 755 /srv /srv/ok && chmod 700 /home/u/priv && chmod 750 /home/u");
  assert.equal(probe("/srv/ok/site/commerce"), "null", "a path of traversable directories is fine (and a directory that does not exist yet is judged by its ancestors)");
  assert.match(probe("/home/u/priv/sites/commerce"), /is mode 750 and is not traversable by other users/);

  host("g1");
  assert.match(docker("exec", name, "cat", "/etc/nginx/pso.d/pso-shop-gateway.conf").stdout, /include \/etc\/nginx\/pso\.d\/attach\/shop-gateway\/\*\.conf;/);
  const root = await get(port, "/customers"); assert.equal(root.headers["x-upstream"], "orchestrator", "the host serves its routes before anything is attached");

  phase([{ type: "deploy", id: "fei", app: "shop-fei", kind: "fei", artifact: "fei-1.0.0.tgz", static: feiStatic, attachTo: "shop-gateway" }]);
  const r1 = exec()[0]!; assert.equal(r1.state, "COMPLETED", JSON.stringify(r1));
  const frag = docker("exec", name, "cat", "/etc/nginx/pso.d/attach/shop-gateway/pso-shop-fei.conf").stdout;
  assert.match(frag, /^# Managed by PSO Web \(app=shop-fei\)/m); assert.doesNotMatch(frag, /\bserver\s*\{|listen /, "a fragment has no server and no listener"); assert.match(frag, /attached-to: shop-gateway/);
  const idx = await get(port, "/commerce/"); assert.equal(idx.status, 200); assert.match(idx.body, /shell 1\.0\.0/); assert.equal(idx.headers["x-pso-release"], r1.release);
  assert.equal((await get(port, "/commerce/customers/42")).status, 200); assert.equal((await get(port, "/commerce/assets/nope.js")).status, 404);
  assert.equal((await get(port, "/customers")).headers["x-upstream"], "orchestrator", "the host's routes are untouched by the attachment");
  assert.equal((await get(port, "/health/ready")).headers["x-upstream"], "orchestrator");
  assert.match((await get(port, "/commerce/")).headers["content-security-policy"] ?? "", /script-src 'self'/);
  const cfg = JSON.parse((await get(port, "/commerce/pso-runtime-config.json")).body);
  assert.deepEqual([cfg.fei, cfg.orchestrator.basePath, cfg.auth.kind, cfg.requireSignature, cfg.trustedKeys[0].keyId, Object.keys(cfg.remotes)], ["fei-shop", "", "oidc", undefined, "release-1", ["mei-customers"]], "the runtime configuration was written by the engine from the declaration");

  const before = workers();
  phase([{ type: "deploy", id: "c1", app: "shop-customers", kind: "mei", artifact: "cus-1.0.0.tgz", static: meiStatic }, { type: "deploy", id: "c2", app: "shop-customers", kind: "mei", artifact: "cus-1.1.0.tgz", static: meiStatic }]);
  for (const x of exec()) assert.equal(x.state, "COMPLETED", JSON.stringify(x));
  assert.equal(workers(), before, "microfrontend deployments never reload nginx");
  assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, "1.1.0");
  phase([{ type: "rollback", id: "rb", app: "shop-customers" }]); assert.equal(exec()[0]!.state, "COMPLETED");
  assert.equal(JSON.parse((await get(port, "/_mei/mei-customers/active.json")).body).version, "1.0.0"); assert.equal(workers(), before);

  // re-deploying the HOST rewrites its file: the include stays, the attached shell keeps being served
  host("g2");
  for (let i = 0; i < 40 && (await get(port, "/commerce/")).status !== 200; i++) await sleep(150);
  assert.equal((await get(port, "/commerce/")).status, 200, "the shell is still served after the host was deployed again");
  assert.equal((await get(port, "/customers")).headers["x-upstream"], "orchestrator");

  // a shell update rewrites only the fragment; the host's file is byte-identical
  const hostFile = docker("exec", name, "cat", "/etc/nginx/pso.d/pso-shop-gateway.conf").stdout.replace(/^# generated:.*$/m, "");
  phase([{ type: "deploy", id: "fei2", app: "shop-fei", kind: "fei", artifact: "fei-1.1.0.tgz", static: feiStatic, attachTo: "shop-gateway" }]);
  assert.equal(exec()[0]!.state, "COMPLETED");
  let body = (await get(port, "/commerce/")).body; for (let i = 0; i < 40 && !/shell 1\.1\.0/.test(body); i++) { await sleep(150); body = (await get(port, "/commerce/")).body; }
  assert.match(body, /shell 1\.1\.0/);
  assert.equal(docker("exec", name, "cat", "/etc/nginx/pso.d/pso-shop-gateway.conf").stdout.replace(/^# generated:.*$/m, ""), hostFile, "a shell update does not touch the host's file");
  phase([{ type: "rollback", id: "rbfei", app: "shop-fei" }]); assert.equal(exec()[0]!.state, "COMPLETED");
  body = (await get(port, "/commerce/")).body; for (let i = 0; i < 40 && !/shell 1\.0\.0/.test(body); i++) { await sleep(150); body = (await get(port, "/commerce/")).body; }
  assert.match(body, /shell 1\.0\.0/);
  assert.equal(docker("exec", name, "nginx", "-t").status, 0);
});
