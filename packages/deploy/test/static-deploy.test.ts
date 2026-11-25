import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/agent/auth.ts";
import { Engine, type Deployment } from "../src/agent/engine.ts";
import { AgentState, AuditLog, P, ensureDir } from "../src/agent/state.ts";
import { activePointer, checkMei, feiHistory, history, versions, writeRuntimeConfig, publicKeyRaw } from "@pso/frontend/node";
import { buildFeiManifest, buildRemoteManifest } from "@pso/frontend/node";
import type { FeiDefinition, MeiDefinition } from "@pso/frontend";

/**
 * Native frontend deployment, in process: the SAME engine, plan, artifact, lock, state, history and rollback as a backend deployment, with
 * the static strategy publishing into a site root. No web server is involved here (proxy "none"); real nginx is covered in static-nginx.test.ts.
 */
// The agent targets Linux (GNU tar). On a Windows development machine, Git's GNU tar reads "C:" as a remote host, so the system bsdtar is used first.
if (process.platform === "win32") process.env["PATH"] = `C:/Windows/System32;${process.env["PATH"] ?? ""}`;
const actor = { clientId: "c1", name: "alice", role: "superadmin" };
const feiDef: FeiDefinition = { name: "fei-shop", orchestrator: { service: "gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }, { name: "mei-catalog", path: "/catalog" }, { name: "mei-orders", path: "/orders" }] };
const meiDef = (name: string, contract?: string): MeiDefinition => ({ name, host: "fei-shop", orchestrator: { service: "gateway" }, ...(contract ? { contract: { context: contract } } : {}) });
const SHARED = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" };

function project(shared: Record<string, string> = SHARED): string {
  const dir = mkdtempSync(join(tmpdir(), "pso-sd-proj-"));
  for (const [n, v] of Object.entries(shared)) { mkdirSync(join(dir, "node_modules", n), { recursive: true }); writeFileSync(join(dir, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v })); }
  return dir;
}
function feiArtifact(version: string, marker = "a"): string {
  const dir = project(); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), `<html>${marker}${version}</html>`); writeFileSync(join(dir, "dist", "assets", `main-${marker}${version}.js`), `console.log("${marker}${version}")`);
  buildFeiManifest({ dir, definition: feiDef, version, basePath: "/shop/" });
  return join(dir, "dist");
}
function meiArtifact(name: string, version: string, o: { shared?: Record<string, string>; contract?: string; content?: string; key?: { keyId: string; pem: string } } = {}): string {
  const dir = project(o.shared); mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "remoteEntry.js"), `// ${name} ${version}`); writeFileSync(join(dir, "dist", "assets", "module.js"), o.content ?? `export default "${name}@${version}"`);
  buildRemoteManifest({ dir, definition: meiDef(name, o.contract), routes: [], version, ...(o.key ? { signWith: { keyId: o.key.keyId, privateKeyPem: o.key.pem } } : {}) });
  return join(dir, "dist");
}
const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");
/** Packs a directory like the real client does: a relative archive name from the archive's own directory (GNU tar reads "C:" as a remote host). */
function tgz(dist: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync("tar", ["-czf", "artifact.tgz", "-C", dist, "."], { cwd: outDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return join(outDir, "artifact.tgz");
}

function agent() {
  const home = mkdtempSync(join(tmpdir(), "pso-sd-home-"));
  const state = new AgentState(home);
  Auth.provision(state, "development", { emitToken: false, environment: "testing" });
  const audit = new AuditLog(home);
  const engine = new Engine(state, audit);
  const pack = (dist: string): { uploadId: string; sha256: string; size: number } => {
    const uploadId = `u${Math.random().toString(36).slice(2, 10)}`; ensureDir(join(P.incoming(home), uploadId));
    const out = tgz(dist, join(P.incoming(home), uploadId));
    return { uploadId, sha256: sha(out), size: statSync(out).size };
  };
  const decl = (app: string, kind: "fei" | "mei", extra: Record<string, unknown> = {}) => ({
    name: app, environment: "testing", connection: { provider: "ssh", credentials: "x" }, source: { provider: "artifact", path: "x" },
    services: [{ name: app.replace(/^shop-/, ""), runtime: "static", static: { site: "shop", kind, ...extra } }],
    strategy: { type: "static", proxy: "none" },
  });
  const run = async (app: string, d: unknown, dist: string): Promise<Deployment> => {
    const plan = engine.propose(d, undefined, actor, pack(dist));
    if (plan.blockers.length) return { state: "BLOCKED", error: plan.blockers.join("; ") } as unknown as Deployment;
    engine.approve(app, plan.hash, actor);
    const dep = engine.start(app, plan.hash, actor, () => ({ pid: process.pid }));
    await engine.work(app, dep.id);
    return engine.deployment(app, dep.id)!;
  };
  return { home, engine, state, decl, run, site: P.site("shop", home) };
}
const state = (d: Deployment): string => `${d.state}${d.error ? ` (${d.error})` : ""}`;

test("the plan of a static resource says what happens: versioned copy, atomic pointer, no process, no web-server change for a MEI", () => {
  const a = agent();
  const plan = a.engine.propose(a.decl("shop-customers", "mei"), undefined, actor, (() => { const out = tgz(meiArtifact("mei-customers", "1.0.0"), join(P.incoming(a.home), "up1")); return { uploadId: "up1", sha256: sha(out), size: 1 }; })());
  assert.equal(plan.strategy.type, "static"); assert.deepEqual(plan.blockers, []);
  assert.match(plan.availability.summary, /atomic pointer write/); assert.match(plan.availability.conditions.join(" "), /compatible with the active shell/);
});

test("declarations: a static resource must be one static service with a static strategy; a MEI never touches nginx; unsafe fields are refused", () => {
  const a = agent(); const bad = (d: unknown) => { try { a.engine.propose(d, undefined, actor, { uploadId: "x", sha256: "0".repeat(64), size: 1 }); return "accepted"; } catch (e) { return (e as Error).message; } };
  const base = a.decl("shop-customers", "mei") as Record<string, unknown>;
  assert.match(bad({ ...base, strategy: { type: "static", proxy: "nginx" } }), /never changes nginx/);
  assert.match(bad({ ...base, strategy: { type: "blue-green", proxy: "nginx" } }), /needs strategy.type "static"/);
  assert.match(bad({ ...base, services: [{ name: "x", runtime: "static" }] }), /declares `static/);
  assert.match(bad({ ...base, services: [{ name: "x", runtime: "static", static: { site: "shop", kind: "mei" }, start: ["node", "x.js"] }] }), /runs no process/);
  assert.match(bad({ ...base, services: [{ name: "x", runtime: "static", static: { site: "Shop!", kind: "mei" } }] }), /site is a kebab-case/);
  assert.match(bad({ ...base, services: [{ name: "x", runtime: "static", static: { site: "shop", kind: "mei", publish: "../etc" } }] }), /stays inside/);
  assert.match(bad({ ...base, services: [{ name: "x", runtime: "static", static: { site: "shop", kind: "mei", basePath: "/x/" } }] }), /belong to the shell/);
  assert.match(bad(a.decl("shop-fei", "fei", { basePath: "x" })), /basePath is absolute/);
  assert.match(bad(a.decl("shop-fei", "fei", { api: { upstreamPort: 80 } })), /upstreamPort/);
});

test("the independent lifecycle: shell and three MEIs deployed, one MEI updated and rolled back without touching the others", async () => {
  const a = agent();
  const fei = await a.run("shop-fei", a.decl("shop-fei", "fei", { basePath: "/shop/" }), feiArtifact("1.0.0"));
  assert.equal(fei.state, "COMPLETED", state(fei));
  writeRuntimeConfig({ site: a.site, fei: "fei-shop", auth: { kind: "none" }, orchestratorBasePath: "/api", meis: ["mei-customers", "mei-catalog", "mei-orders"] });
  for (const n of ["customers", "catalog", "orders"]) { const d = await a.run(`shop-${n}`, a.decl(`shop-${n}`, "mei"), meiArtifact(`mei-${n}`, "1.0.0")); assert.equal(d.state, "COMPLETED", `${n}: ${state(d)}`); }
  for (const n of ["customers", "catalog", "orders"]) assert.equal(activePointer(a.site, `mei-${n}`)!.version, "1.0.0");

  const before = { fei: sha(join(a.site, "fei", "current.json")), feiIndex: sha(join(a.site, "fei", "1.0.0", "index.html")), catalog: sha(join(a.site, "_mei", "mei-catalog", "active.json")), orders: sha(join(a.site, "_mei", "mei-orders", "active.json")), config: sha(join(a.site, "pso-runtime-config.json")) };
  const up = await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "1.1.0"));
  assert.equal(up.state, "COMPLETED", state(up));
  assert.equal(activePointer(a.site, "mei-customers")!.version, "1.1.0");
  assert.deepEqual({ fei: sha(join(a.site, "fei", "current.json")), feiIndex: sha(join(a.site, "fei", "1.0.0", "index.html")), catalog: sha(join(a.site, "_mei", "mei-catalog", "active.json")), orders: sha(join(a.site, "_mei", "mei-orders", "active.json")), config: sha(join(a.site, "pso-runtime-config.json")) }, before, "the shell, the other microfrontends and the configuration are byte-identical");
  assert.deepEqual(versions(a.site, "mei-customers"), ["1.0.0", "1.1.0"], "the previous version stays for browsers that still reference it");

  const rb = a.engine.rollback("shop-customers", actor, undefined, () => ({ pid: process.pid }));
  await a.engine.work("shop-customers", rb.id);
  const rd = a.engine.deployment("shop-customers", rb.id)!;
  assert.equal(rd.state, "COMPLETED", state(rd));
  assert.equal(activePointer(a.site, "mei-customers")!.version, "1.0.0");
  assert.deepEqual(history(a.site, "mei-customers").map((h) => `${h.action}:${h.version}`), ["publish:1.0.0", "publish:1.1.0", "rollback:1.0.0"]);
  assert.equal(sha(join(a.site, "_mei", "mei-catalog", "active.json")), before.catalog);
  assert.deepEqual(checkMei(a.site, "mei-customers"), []);
  const status = a.engine.history("shop-customers", 10).map((h) => `${h.kind}:${h.state}`);
  assert.deepEqual(status, ["rollback:COMPLETED", "deploy:COMPLETED", "deploy:COMPLETED"]);
});

test("a failed candidate never invalidates the active release: incompatible, tampered, unsigned-when-required, and an unknown host", async () => {
  const a = agent();
  assert.equal((await a.run("shop-fei", a.decl("shop-fei", "fei", { basePath: "/shop/" }), feiArtifact("1.0.0"))).state, "COMPLETED");
  assert.equal((await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "1.0.0"))).state, "COMPLETED");
  const ptr = sha(join(a.site, "_mei", "mei-customers", "active.json"));
  const stateBefore = a.engine.status("shop-customers") as { active?: { release: string } };

  const incompat = await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "2.0.0", { shared: { ...SHARED, react: "19.0.0", "react-dom": "19.0.0" } }));
  assert.equal(incompat.state, "FAILED"); assert.match(incompat.error ?? "", /not activated|react/);
  const contract = await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "2.0.0", { contract: "2.0" }));
  assert.equal(contract.state, "FAILED");
  const tampered = meiArtifact("mei-customers", "2.1.0"); writeFileSync(join(tampered, "assets", "module.js"), "alert(1)");
  const t = await a.run("shop-customers", a.decl("shop-customers", "mei"), tampered);
  assert.equal(t.state, "FAILED"); assert.match(t.error ?? "", /hash|manifest|not activated/);
  const wrongHost = meiArtifact("mei-customers", "2.2.0");
  const mp = join(wrongHost, "pso-manifest.json"); const m = JSON.parse(readFileSync(mp, "utf8")); m.host = "fei-other"; writeFileSync(mp, JSON.stringify(m));
  assert.equal((await a.run("shop-customers", a.decl("shop-customers", "mei"), wrongHost)).state, "FAILED");

  assert.equal(sha(join(a.site, "_mei", "mei-customers", "active.json")), ptr, "the active pointer was never touched");
  assert.deepEqual(versions(a.site, "mei-customers"), ["1.0.0"], "a refused release is not even copied into the site");
  assert.equal((a.engine.status("shop-customers") as { active?: { release: string } }).active?.release, stateBefore.active?.release, "the engine still records the same active release");

  // a site that requires signatures refuses an unsigned release and accepts a correctly signed one
  const { privateKey } = generateKeyPairSync("ed25519"); const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeRuntimeConfig({ site: a.site, fei: "fei-shop", auth: { kind: "none" }, orchestratorBasePath: "/api", meis: ["mei-customers"], requireSignature: true, trustedKeys: [{ keyId: "r1", publicKey: publicKeyRaw(pem) }] });
  assert.equal((await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "3.0.0"))).state, "FAILED");
  const signed = await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "3.0.0", { key: { keyId: "r1", pem } }));
  assert.equal(signed.state, "COMPLETED", state(signed)); assert.equal(activePointer(a.site, "mei-customers")!.version, "3.0.0");
});

test("a MEI cannot be deployed before the shell it runs in", async () => {
  const a = agent();
  const d = await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "1.0.0"));
  assert.equal(d.state, "FAILED"); assert.match(d.error ?? "", /no FEI release is active|not activated/);
  assert.equal(activePointer(a.site, "mei-customers"), undefined);
});

test("shell releases are versioned, rolled back by the engine, and retention keeps the active and the previous version", async () => {
  const a = agent();
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) assert.equal((await a.run("shop-fei", a.decl("shop-fei", "fei", { basePath: "/shop/", retain: 2 }), feiArtifact(v, v))).state, "COMPLETED");
  assert.deepEqual(readdirSync(join(a.site, "fei")).filter((n) => /^\d/.test(n)).sort(), ["1.1.0", "1.2.0"], "retain 2 removed the oldest, never the active or the previous");
  const rb = a.engine.rollback("shop-fei", actor, undefined, () => ({ pid: process.pid })); await a.engine.work("shop-fei", rb.id);
  assert.equal(a.engine.deployment("shop-fei", rb.id)!.state, "COMPLETED");
  assert.equal(JSON.parse(readFileSync(join(a.site, "fei", "current.json"), "utf8")).version, "1.1.0");
  assert.deepEqual(feiHistory(a.site).map((h) => h.action).slice(-2), ["publish", "rollback"]);
});

test("a deployment interrupted after the pointer moved is completed forward by recovery; one interrupted before is closed without touching the active release", async () => {
  const a = agent();
  assert.equal((await a.run("shop-fei", a.decl("shop-fei", "fei", { basePath: "/shop/" }), feiArtifact("1.0.0"))).state, "COMPLETED");
  assert.equal((await a.run("shop-customers", a.decl("shop-customers", "mei"), meiArtifact("mei-customers", "1.0.0"))).state, "COMPLETED");
  // simulate a worker that died right after the atomic pointer write: the deployment record says SWITCHING_TRAFFIC and its lock is stale
  const dist = meiArtifact("mei-customers", "1.1.0");
  const plan = a.engine.propose(a.decl("shop-customers", "mei"), undefined, actor, (() => { const out = tgz(dist, join(P.incoming(a.home), "upz")); return { uploadId: "upz", sha256: sha(out), size: 1 }; })());
  a.engine.approve("shop-customers", plan.hash, actor);
  const dep = a.engine.start("shop-customers", plan.hash, actor, () => ({ pid: 2147483000 }));      // a pid that does not exist: the "worker"
  // run the real steps up to the pointer write by hand, exactly as the worker would have, then "die"
  const { publishMei } = await import("@pso/frontend/node");
  const rid = dep.releaseId; const rdir = join(P.app("shop-customers", a.home), "releases", rid);
  mkdirSync(join(rdir, "src"), { recursive: true }); cpSync(dist, join(rdir, "src"), { recursive: true });
  writeFileSync(join(rdir, "manifest.json"), JSON.stringify({ releaseId: rid, app: "shop-customers", decl: a.decl("shop-customers", "mei"), source: { provider: "artifact", sha256: "x" }, planHash: plan.hash }));
  publishMei({ site: a.site, dist, by: "alice" });
  const f = join(P.app("shop-customers", a.home), "deployments", `${dep.id}.json`); const cur = JSON.parse(readFileSync(f, "utf8")); cur.state = "SWITCHING_TRAFFIC"; writeFileSync(f, JSON.stringify(cur));
  const rec = await a.engine.recover("shop-customers", actor) as { action?: string; outcome?: string; state?: string };
  const after = a.engine.deployment("shop-customers", dep.id)!;
  assert.equal(after.state, "COMPLETED", `${JSON.stringify(rec)} ${after.error ?? ""}`); assert.equal(after.outcome, "completed-by-recovery");
  assert.equal((a.engine.status("shop-customers") as { active?: { release: string } }).active?.release, rid);
  assert.equal(activePointer(a.site, "mei-customers")!.version, "1.1.0");
});
