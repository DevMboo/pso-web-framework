import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeiDefinition, MeiDefinition } from "../src/index.ts";
import { activateFei, activateMei, activeFei, activePointer, buildFeiManifest, buildRemoteManifest, checkMei, feiHistory, feiVersions, history, pruneFei, pruneMei, publishFei, publishMei, publicKeyRaw, recoverSite, ReleaseRefused, renderSiteServer, rollbackMei, versions, withSiteLock, writeRuntimeConfig, readRuntimeConfig, verifyDist } from "../src/node.ts";

const feiDef: FeiDefinition = { name: "fei-shop", orchestrator: { service: "gateway" }, microfrontends: [{ name: "mei-customers", path: "/customers" }, { name: "mei-catalog", path: "/catalog" }] };
const meiDef = (name: string, over: Partial<MeiDefinition> = {}): MeiDefinition => ({ name, host: "fei-shop", orchestrator: { service: "gateway" }, ...over });

function project(versions: Record<string, string> = { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" }): string {
  const dir = mkdtempSync(join(tmpdir(), "pso-rel-"));
  for (const [n, v] of Object.entries(versions)) { mkdirSync(join(dir, "node_modules", ...n.split("/")), { recursive: true }); writeFileSync(join(dir, "node_modules", ...n.split("/"), "package.json"), JSON.stringify({ name: n, version: v })); }
  return dir;
}
function feiDist(dir: string, marker = "v1", version = "1.0.0", base = "/"): string {
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), `<html>${marker}</html>`); writeFileSync(join(dir, "dist", "assets", `main-${marker}-${version}.js`), `console.log("${marker}")`);
  buildFeiManifest({ dir, definition: feiDef, version, basePath: base });
  return join(dir, "dist");
}
function meiDist(name: string, version: string, over: { shared?: Record<string, string>; key?: { keyId: string; pem: string }; contract?: string; content?: string } = {}): string {
  const dir = project(over.shared ?? { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.5", "react-router": "7.18.5" });
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "remoteEntry.js"), `// ${name} ${version}`); writeFileSync(join(dir, "dist", "assets", "module.js"), over.content ?? `export default "${name}@${version}"`);
  buildRemoteManifest({ dir, definition: meiDef(name, over.contract ? { contract: { context: over.contract } } : {}), routes: [], version, ...(over.key ? { signWith: { keyId: over.key.keyId, privateKeyPem: over.key.pem } } : {}) });
  return join(dir, "dist");
}
function site(): string { return mkdtempSync(join(tmpdir(), "pso-site-")); }
const refused = (f: () => unknown, re: RegExp) => assert.throws(f, (e: Error) => e instanceof ReleaseRefused && re.test(`${e.message} ${e.reasons.join(" ")}`), String(re));

function liveSite(): string {
  const s = site(); const fdir = project();
  publishFei({ site: s, dist: feiDist(fdir) });
  writeRuntimeConfig({ site: s, fei: "fei-shop", auth: { kind: "dev-token" }, orchestratorBasePath: "/api", meis: ["mei-customers", "mei-catalog"] });
  return s;
}

test("a MEI cannot be published before the FEI it runs in", () => {
  refused(() => publishMei({ site: site(), dist: meiDist("mei-customers", "1.0.0") }), /no FEI release is active/);
});

test("publish activates atomically through a pointer, keeps history and never overwrites a version", () => {
  const s = liveSite();
  const r1 = publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0") });
  assert.equal(r1.activated, true); assert.equal(r1.previous, null);
  const p1 = activePointer(s, "mei-customers")!;
  assert.equal(p1.version, "1.0.0"); assert.equal(p1.manifest, "v/1.0.0/pso-manifest.json");
  assert.ok(existsSync(join(s, "_mei", "mei-customers", "v", "1.0.0", "remoteEntry.js")));
  const r2 = publishMei({ site: s, dist: meiDist("mei-customers", "1.1.0") });
  assert.equal(r2.previous, "1.0.0"); assert.equal(activePointer(s, "mei-customers")!.version, "1.1.0");
  assert.deepEqual(versions(s, "mei-customers"), ["1.0.0", "1.1.0"], "the previous release stays on disk for browsers that still reference it");
  assert.ok(existsSync(join(s, "_mei", "mei-customers", "v", "1.0.0", "assets", "module.js")));
  assert.deepEqual(history(s, "mei-customers").map((h) => `${h.action}:${h.version}<-${h.previous}`), ["publish:1.0.0<-null", "publish:1.1.0<-1.0.0"]);
  // immutability: the same version with different bytes is refused; the same bytes are idempotent
  refused(() => publishMei({ site: s, dist: meiDist("mei-customers", "1.1.0", { content: "export default 'tampered'" }) }), /already published with different content/);
  assert.equal(activePointer(s, "mei-customers")!.version, "1.1.0");
  assert.ok(readdirSync(join(s, "_mei", "mei-customers")).every((n) => !n.includes("tmp")), "no temporary files are left behind");
});

test("a compatible update of one MEI leaves the other MEIs untouched", () => {
  const s = liveSite();
  publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0") }); publishMei({ site: s, dist: meiDist("mei-catalog", "1.0.0") });
  const catalogBefore = readFileSync(join(s, "_mei", "mei-catalog", "active.json"), "utf8");
  const configBefore = readFileSync(join(s, "pso-runtime-config.json"), "utf8");
  publishMei({ site: s, dist: meiDist("mei-customers", "1.2.0") });
  assert.equal(readFileSync(join(s, "_mei", "mei-catalog", "active.json"), "utf8"), catalogBefore);
  assert.equal(readFileSync(join(s, "pso-runtime-config.json"), "utf8"), configBefore, "the FEI's configuration did not change: no FEI rebuild or redeploy is needed");
  assert.equal(activeFei(s)!.version, "1.0.0");
});

test("incompatible releases are refused before activation and the previous release stays active", () => {
  const s = liveSite();
  publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0") });
  refused(() => publishMei({ site: s, dist: meiDist("mei-customers", "1.1.0", { shared: { react: "19.0.0", "react-dom": "19.0.0", "react-router-dom": "7.18.5", "react-router": "7.18.5" } }) }), /"react": the MEI needs/);
  refused(() => publishMei({ site: s, dist: meiDist("mei-customers", "1.1.0", { contract: "2.0" }) }), /major versions differ/);
  assert.equal(activePointer(s, "mei-customers")!.version, "1.0.0");
  assert.deepEqual(versions(s, "mei-customers"), ["1.0.0"], "a refused release is not even copied into the site");
});

test("a tampered build output is detected against its manifest", () => {
  const s = liveSite(); const dist = meiDist("mei-customers", "1.0.0");
  writeFileSync(join(dist, "assets", "module.js"), "alert(1)");
  refused(() => publishMei({ site: s, dist }), /does not match its recorded hash/);
  const d2 = meiDist("mei-customers", "1.0.1"); writeFileSync(join(d2, "assets", "extra.js"), "x");
  refused(() => publishMei({ site: s, dist: d2 }), /not listed in the manifest/);
  assert.deepEqual(verifyDist(d2, JSON.parse(readFileSync(join(d2, "pso-manifest.json"), "utf8"))).length, 1);
});

test("when the site requires signatures, unsigned, wrongly signed and untrusted releases are refused", () => {
  const s = site(); const fdir = project();
  publishFei({ site: s, dist: feiDist(fdir) });
  const mk = () => generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const good = mk(), evil = mk();
  writeRuntimeConfig({ site: s, fei: "fei-shop", auth: { kind: "none" }, orchestratorBasePath: "/api", meis: ["mei-customers"], requireSignature: true, trustedKeys: [{ keyId: "release", publicKey: publicKeyRaw(good) }] });
  refused(() => publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0") }), /not signed/);
  refused(() => publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0", { key: { keyId: "release", pem: evil } }) }), /does not match/);
  refused(() => publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0", { key: { keyId: "rogue", pem: good } }) }), /does not trust/);
  assert.equal(publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0", { key: { keyId: "release", pem: good } }) }).activated, true);
  assert.equal(readRuntimeConfig(s)!.requireSignature, true);
});

test("rollback re-points to the previous release (or a chosen one) and is itself recorded; unknown versions are refused", () => {
  const s = liveSite();
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) publishMei({ site: s, dist: meiDist("mei-customers", v) });
  assert.deepEqual(rollbackMei(s, "mei-customers"), { from: "1.2.0", to: "1.1.0" });
  assert.equal(activePointer(s, "mei-customers")!.version, "1.1.0");
  assert.deepEqual(rollbackMei(s, "mei-customers", "1.0.0"), { from: "1.1.0", to: "1.0.0" });
  assert.deepEqual(history(s, "mei-customers").map((h) => h.action), ["publish", "publish", "publish", "rollback", "rollback"]);
  refused(() => rollbackMei(s, "mei-customers", "9.9.9"), /not published/);
  refused(() => rollbackMei(s, "mei-customers", "1.0.0"), /already active/);
  refused(() => rollbackMei(s, "mei-none"), /no earlier release/);
  // the rolled-back release must still be compatible with the CURRENT FEI: a newer FEI that moved to another React major refuses the old MEI
  const fdir = project({ react: "19.0.0", "react-dom": "19.0.0", "react-router-dom": "7.18.5", "react-router": "7.18.5" });
  publishFei({ site: s, dist: feiDist(fdir, "v2", "2.0.0") });
  refused(() => rollbackMei(s, "mei-customers", "1.1.0"), /"react": the MEI needs/);
  assert.equal(activePointer(s, "mei-customers")!.version, "1.0.0");
});

test("an FEI release is versioned and immutable and the FEI pointer moves atomically", () => {
  const s = site(); const fdir = project();
  const r = publishFei({ site: s, dist: feiDist(fdir, "v1", "1.0.0", "/shop/") });
  assert.equal(r.basePath, "/shop/"); assert.deepEqual(r.mounts.map((m) => m.path), ["/customers", "/catalog"]);
  assert.equal(r.shared["react"], "18.3.1");
  assert.deepEqual(JSON.parse(readFileSync(join(s, "fei", "current.json"), "utf8")).version, "1.0.0");
  assert.throws(() => publishFei({ site: s, dist: feiDist(project(), "v2", "1.0.0", "/shop/") }), /already published with different content/);
  publishFei({ site: s, dist: feiDist(project(), "v2", "1.1.0", "/shop/") });
  assert.equal(activeFei(s)!.version, "1.1.0"); assert.ok(existsSync(join(s, "fei", "1.0.0", "index.html")), "the previous FEI release stays");
});

test("the shared nginx renderer keeps API, remotes and shell apart, refuses unsafe input and restricts what the browser may load", () => {
  const n = renderSiteServer({ site: "/srv/pso/site", fei: { base: "/commerce/" }, remotes: true, api: { path: "/api", port: 3000 } });
  assert.match(n, /location \^~ \/api\//); assert.match(n, /location \^~ \/_mei\//); assert.match(n, /immutable/); assert.match(n, /no-store/);
  assert.match(n, /connect-src 'self'/); assert.match(n, /script-src 'self'/); assert.doesNotMatch(n, /unsafe-eval|unsafe-inline/);
  assert.match(n, /location \^~ \/commerce\/assets\//); assert.match(n, /return 404;/, "file-looking paths that do not exist are never the entry page");
  for (const bad of [{ site: "/srv/a b" }, { site: "/srv/../etc" }, { site: "relative" }]) assert.throws(() => renderSiteServer({ ...bad, fei: { base: "/" } }), /invalid site configuration/);
  assert.throws(() => renderSiteServer({ site: "/srv/s", fei: { base: "/api/x/" }, api: { path: "/api", port: 3000 } }), /reserved prefix|inside the API prefix/);
  assert.throws(() => renderSiteServer({ site: "/srv/s", fei: { base: "/_mei/" } }), /reserved prefix/);
  assert.throws(() => renderSiteServer({ site: "/srv/s", fei: { base: "/x/" }, api: { path: "/api;evil", port: 3000 } }), /api path/);
});

test("staging a MEI does not activate it; activation is a separate checked step", () => {
  const s = liveSite();
  publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0") });
  const r = publishMei({ site: s, dist: meiDist("mei-customers", "1.1.0"), stage: true });
  assert.equal(r.activated, false); assert.equal(activePointer(s, "mei-customers")!.version, "1.0.0");
  assert.deepEqual(versions(s, "mei-customers"), ["1.0.0", "1.1.0"]);
  activateMei(s, "mei-customers", "1.1.0"); assert.equal(activePointer(s, "mei-customers")!.version, "1.1.0");
});

test("FEI: stage, activate and return to the previous version; history records both", () => {
  const s = site(); const fdir = project();
  publishFei({ site: s, dist: feiDist(fdir, "v1", "1.0.0") });
  publishFei({ site: s, dist: feiDist(project(), "v2", "1.1.0") });
  activateFei(s, "1.0.0", "rollback");
  assert.equal(activeFei(s)!.version, "1.0.0");
  assert.deepEqual(feiHistory(s).map((h) => `${h.action}:${h.version}`), ["publish:1.0.0", "publish:1.1.0", "rollback:1.0.0"]);
  assert.throws(() => activateFei(s, "9.9.9"), /not staged/);
  const bad = feiDist(project(), "v3", "1.2.0"); writeFileSync(join(bad, "assets", "main-v3-1.2.0.js"), "tampered");
  assert.throws(() => publishFei({ site: s, dist: bad }), /does not match its manifest/);
});

test("retention never removes the active version, the rollback target, or fewer than two versions", () => {
  const s = liveSite();
  for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"]) publishMei({ site: s, dist: meiDist("mei-customers", v) });
  rollbackMei(s, "mei-customers", "1.3.0");
  const removed = pruneMei(s, "mei-customers", 2);
  assert.deepEqual(removed.sort(), ["1.0.0", "1.1.0", "1.2.0"]);
  assert.deepEqual(versions(s, "mei-customers"), ["1.3.0", "1.4.0"], "the active 1.3.0 and the one it replaced, 1.4.0, remain");
  assert.deepEqual(pruneMei(s, "mei-customers", 0), [], "keep below two is raised to two");
  assert.deepEqual(checkMei(s, "mei-customers"), []);
  const f = site();
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) publishFei({ site: f, dist: feiDist(project(), "m" + v, v) });
  assert.deepEqual(pruneFei(f, 2), ["1.0.0"]); assert.deepEqual(feiVersions(f), ["1.1.0", "1.2.0"]);
});

test("recovery after an interrupted publish: leftovers are swept, pointers are verified, nothing is edited", () => {
  const s = liveSite();
  publishMei({ site: s, dist: meiDist("mei-customers", "1.0.0") });
  const root = join(s, "_mei", "mei-customers");
  mkdirSync(join(root, "v", "1.1.0.staging-4242", "assets"), { recursive: true }); writeFileSync(join(root, "v", "1.1.0.staging-4242", "remoteEntry.js"), "half");
  writeFileSync(join(root, "active.json.tmp-4242-1"), "{");
  let rep = recoverSite(s);
  assert.equal(rep.removed.length, 2); assert.deepEqual(rep.problems, []); assert.deepEqual(versions(s, "mei-customers"), ["1.0.0"]);
  assert.equal(activePointer(s, "mei-customers")!.version, "1.0.0");
  writeFileSync(join(root, "v", "1.0.0", "assets", "module.js"), "altered");
  rep = recoverSite(s);
  assert.ok(rep.problems.some((p) => /does not match its recorded hash/.test(p)), rep.problems.join(" | "));
  writeFileSync(join(root, "history.json"), JSON.stringify([]));
  assert.ok(checkMei(s, "mei-customers").length >= 1);
});

test("the site lock serializes writers and is taken over from a dead process or a stale owner", () => {
  const s = site();
  let inside = 0, max = 0;
  const work = () => withSiteLock(s, () => { inside++; max = Math.max(max, inside); inside--; return 1; });
  assert.equal(work() + work(), 2); assert.equal(max, 1);
  assert.throws(() => withSiteLock(s, () => withSiteLock(s, () => 1, 150)), /holds this site/, "a second holder waits and then refuses");
  mkdirSync(join(s, ".pso-lock")); writeFileSync(join(s, ".pso-lock", "owner.json"), JSON.stringify({ pid: 2147483646, at: Date.now() }));
  assert.equal(withSiteLock(s, () => "taken over", 500), "taken over", "a lock held by a process that no longer exists is taken over");
  mkdirSync(join(s, ".pso-lock")); writeFileSync(join(s, ".pso-lock", "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000 }));
  assert.equal(withSiteLock(s, () => "stale", 500), "stale");
});
