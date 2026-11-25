import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, packStage, fingerprintOf, type PackageMeta, type TrustedKey } from "../src/psopkg.ts";
import { InstallError, installPackage, integrityCheck, repair, uninstall, installState, loadTrust } from "../src/install.ts";
import { signCatalog, verifyCatalog, checkForUpdate, installUpdate, rollback, recoverInterrupted, compareVersions, UpdateError, type CatalogBody, type Release } from "../src/update.ts";
import { pso } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "pso-life-")); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { const f = join(root, ...rel.split("/")); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); };
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const err = (f: () => unknown): string => { try { f(); return "none"; } catch (e) { return (e as { code?: string }).code ?? `other:${(e as Error).message}`; } };
const errAsync = async (f: () => Promise<unknown>): Promise<string> => { try { await f(); return "none"; } catch (e) { return (e as { code?: string }).code ?? `other:${(e as Error).message}`; } };

const signer = generateKeyPair("signing"), rogue = generateKeyPair("signing");
const trust: TrustedKey[] = [{ id: signer.id, publicKeyPem: signer.publicKeyPem }];
const meta = (version: string): PackageMeta => ({ name: "pso", version, platform: process.platform, arch: process.arch, components: [{ name: "cli", version }], installRules: { integrations: [{ type: "shim", value: "bin/pso.cmd" }] } });

/** builds a package file of `version` whose files depend on the version */
function build(dir: string, version: string, key = signer.privateKeyPem): string {
  const stage = tmp();
  put(stage, "cli/bin/pso.js", `console.log("pso ${version}");\n`);
  put(stage, "cli/lib/core.js", `exports.v = "${version}";\n` + "x".repeat(2000));
  put(stage, "bin/pso.cmd", "@echo off\r\n");
  put(stage, "studio/index.html", `<h1>${version}</h1>`);
  const out = join(dir, `pso-${version}${key === signer.privateKeyPem ? "" : "-other"}.psopkg`);
  writeFileSync(out, packStage({ stageDir: stage, meta: meta(version), signingKeyPem: key }));
  return out;
}
const freshRoot = (): string => join(tmp(), "pso-home");

test("setup: verified completely first, side by side, refuses duplicates and untrusted signers, writes nothing on failure", () => {
  const pk = tmp(), root = freshRoot();
  const v1 = build(pk, "1.0.0");
  const r = installPackage({ root, packageFile: v1, trustedKeys: trust });
  assert.deepEqual([r.version, r.files, r.activated], ["1.0.0", 4, true]);
  assert.equal(readFileSync(join(root, "versions", "1.0.0", "cli", "bin", "pso.js"), "utf8"), 'console.log("pso 1.0.0");\n');
  assert.equal(installState(root).current, "1.0.0");
  assert.equal(loadTrust(root).length, 1, "the installation remembers the signer it trusts");
  assert.equal(err(() => installPackage({ root, packageFile: v1, trustedKeys: trust })), "INSTALL_EXISTS");
  const root2 = freshRoot();
  assert.equal(err(() => installPackage({ root: root2, packageFile: build(pk, "1.0.1", rogue.privateKeyPem), trustedKeys: trust })), "PSOPKG_SIGNATURE");
  assert.ok(!existsSync(join(root2, "versions")) || readdirSync(join(root2, "versions")).length === 0, "nothing was installed from an untrusted package");
  for (const bad of [homedir(), "C:\\", process.platform === "win32" ? "C:\\Windows" : "/etc"]) assert.equal(err(() => installPackage({ root: bad, packageFile: v1, trustedKeys: trust })), "INSTALL_ROOT", bad);
});

test("integrity: read-only, quick vs full, detects missing/corrupt/extra files and a tampered inventory or trust store", () => {
  const pk = tmp(), root = freshRoot();
  installPackage({ root, packageFile: build(pk, "1.0.0"), trustedKeys: trust });
  const ok = integrityCheck(root, { full: true });
  assert.equal(ok.ok, true); assert.equal(ok.files.ok, 4);
  assert.ok(ok.checks.some((c) => c.name === "inventory signature" && c.status === "ok"));
  const core = join(root, "versions", "1.0.0", "cli", "lib", "core.js");
  const original = readFileSync(core);
  const same = Buffer.from(original); same[same.length - 1] = same[same.length - 1]! ^ 1; writeFileSync(core, same); // same size, different content
  assert.equal(integrityCheck(root, { full: false }).ok, true, "a quick check only looks at presence and size");
  const full = integrityCheck(root, { full: true });
  assert.deepEqual([full.ok, full.files.damaged], [false, [{ path: "cli/lib/core.js", state: "hash-mismatch" }]]);
  assert.deepEqual(readFileSync(core), same, "checking never modifies anything");
  rmSync(join(root, "versions", "1.0.0", "studio", "index.html"));
  put(join(root, "versions", "1.0.0"), "cli/extra.txt", "mine");
  const q = integrityCheck(root, { full: false });
  assert.deepEqual([q.files.damaged.map((d) => d.state), q.files.unexpected], [["missing"], ["cli/extra.txt"]]);
  // the inventory itself is authenticated
  const invFile = join(root, ".pso-install", "inventory-1.0.0.json");
  const inv = JSON.parse(readFileSync(invFile, "utf8")) as { headerBase64: string };
  const header = JSON.parse(Buffer.from(inv.headerBase64, "base64").toString("utf8")) as { files: Array<{ sha256: string }> };
  header.files[0]!.sha256 = sha(Buffer.from("forged"));
  writeFileSync(invFile, JSON.stringify({ ...inv, headerBase64: Buffer.from(JSON.stringify(header)).toString("base64") }));
  const forged = integrityCheck(root, { full: true });
  assert.equal(forged.ok, false); assert.ok(forged.checks.some((c) => c.name === "inventory signature" && c.status === "failed"));
  assert.equal(err(() => integrityCheck(join(tmp(), "nothing"), { full: false })), "INSTALL_NOT_FOUND");
});

test("repair: dry run, quick and full, same version only, authenticated source only, user data untouched, all-or-nothing", () => {
  const pk = tmp(), root = freshRoot();
  const v1 = build(pk, "1.0.0");
  installPackage({ root, packageFile: v1, trustedKeys: trust });
  put(root, "config/settings.json", '{"mine":true}'); put(root, "logs/pso.log", "log"); put(join(root, "versions", "1.0.0"), "cli/user-note.txt", "keep me");
  const dir = join(root, "versions", "1.0.0");
  rmSync(join(dir, "cli", "bin", "pso.js")); writeFileSync(join(dir, "cli", "lib", "core.js"), "x".repeat(2000 + 30)); // missing + wrong size
  const dry = repair(root, { full: false, dryRun: true });
  assert.deepEqual([dry.dryRun, dry.repaired.sort()], [true, ["cli/bin/pso.js", "cli/lib/core.js"]]);
  assert.ok(!existsSync(join(dir, "cli", "bin", "pso.js")), "dry run changed nothing");
  const r = repair(root, { full: false, dryRun: false });
  assert.equal(r.repaired.length, 2);
  assert.equal(integrityCheck(root, { full: true }).ok, true);
  assert.equal(readFileSync(join(root, "config", "settings.json"), "utf8"), '{"mine":true}', "user configuration is untouched");
  assert.equal(readFileSync(join(dir, "cli", "user-note.txt"), "utf8"), "keep me", "files PSO does not own are untouched");
  assert.equal(repair(root, { full: true, dryRun: false }).repaired.length, 0, "idempotent");
  // same-size corruption is only found by --full
  const c = join(dir, "cli", "lib", "core.js"); const b = readFileSync(c); b[5] = b[5]! ^ 0xff; writeFileSync(c, b);
  assert.equal(repair(root, { full: false, dryRun: true }).repaired.length, 0);
  assert.deepEqual(repair(root, { full: true, dryRun: false }).repaired, ["cli/lib/core.js"]);
  // sources: a different version is refused (repair never upgrades), an unsigned/foreign package is refused
  rmSync(join(dir, "studio", "index.html"));
  assert.equal(err(() => repair(root, { full: false, dryRun: false, packageFile: build(pk, "1.0.1") })), "REPAIR_VERSION");
  assert.equal(err(() => repair(root, { full: false, dryRun: false, packageFile: build(pk, "1.0.0", rogue.privateKeyPem) })), "PSOPKG_SIGNATURE");
  assert.ok(!existsSync(join(dir, "studio", "index.html")), "nothing was restored from a refused source");
  // all-or-nothing: a blocked target rolls the earlier replacements back
  rmSync(join(root, ".pso-install", "packages", "1.0.0.psopkg"));
  assert.equal(err(() => repair(root, { full: false, dryRun: false })), "REPAIR_SOURCE", "no cached package and none given");
  rmSync(join(dir, "cli", "bin", "pso.js"), { force: true });
  rmSync(join(dir, "studio"), { recursive: true, force: true }); mkdirSync(join(dir, "studio", "index.html"), { recursive: true }); // a directory where a file belongs
  assert.equal(err(() => repair(root, { full: false, dryRun: false, packageFile: v1 })), "REPAIR_BLOCKED");
  assert.ok(!existsSync(join(dir, "cli", "bin", "pso.js")), "the file restored before the failure was rolled back (no half-repaired state)");
});

function catalog(releases: Release[], key = signer.privateKeyPem, o: Partial<CatalogBody> = {}): string {
  const body: CatalogBody = { schema: 1, product: "pso", sequence: 1, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), releases, ...o };
  return JSON.stringify(signCatalog(body, key));
}
const release = (pkgFile: string, version: string, channel: Release["channel"] = "stable"): Release => { const b = readFileSync(pkgFile); return { version, channel, platform: process.platform, arch: process.arch, package: { file: pkgFile, sha256: sha(b), size: b.length } }; };

test("update: signed catalog, channels, side-by-side install, atomic activation, rollback, offline package", async () => {
  const pk = tmp(), root = freshRoot(), work = tmp();
  installPackage({ root, packageFile: build(pk, "1.0.0"), trustedKeys: trust });
  const v11 = build(pk, "1.1.0"), v2b = build(pk, "2.0.0-beta.1");
  const cat = join(work, "catalog.json");
  writeFileSync(cat, catalog([release(v11, "1.1.0"), release(v2b, "2.0.0-beta.1", "beta")], signer.privateKeyPem, { sequence: 5 }));
  const check = await checkForUpdate(root, { catalog: cat, channel: "stable" });
  assert.deepEqual([check.current, check.available?.version], ["1.0.0", "1.1.0"]);
  assert.equal((await checkForUpdate(root, { catalog: cat, channel: "beta" })).available?.version, "2.0.0-beta.1", "the beta channel sees pre-releases");
  const up = await installUpdate(root, { catalog: cat, channel: "stable" });
  assert.deepEqual([up.from, up.to], ["1.0.0", "1.1.0"]);
  const st = installState(root);
  assert.deepEqual([st.current, st.previous, st.versions.map((v) => v.version)], ["1.1.0", "1.0.0", ["1.0.0", "1.1.0"]]);
  assert.ok(existsSync(join(root, "versions", "1.0.0", "cli", "bin", "pso.js")), "the previous version stays for rollback");
  assert.equal(integrityCheck(root, { full: true }).ok, true);
  assert.equal(await errAsync(() => installUpdate(root, { catalog: cat, channel: "stable" })), "NO_UPDATE", "already current");
  const back = rollback(root);
  assert.deepEqual([back.from, back.to, installState(root).current], ["1.1.0", "1.0.0", "1.0.0"]);
  assert.equal(err(() => { rmSync(join(root, "versions", "1.1.0", "cli", "bin", "pso.js")); rollback(root); }), "PREVIOUS_DAMAGED", "rolling back to a damaged version is refused");
  // offline package
  const root2 = freshRoot();
  installPackage({ root: root2, packageFile: build(pk, "1.0.0"), trustedKeys: trust });
  assert.equal((await installUpdate(root2, { channel: "stable", packageFile: v11 })).to, "1.1.0");
  assert.equal(await errAsync(() => installUpdate(root2, { channel: "stable", packageFile: build(pk, "1.2.0", rogue.privateKeyPem) })), "PSOPKG_SIGNATURE", "an unsigned or foreign offline package is refused");
  assert.equal(await errAsync(() => installUpdate(root2, { channel: "stable", packageFile: build(pk, "0.9.0") })), "NO_UPDATE", "no downgrade by accident");
  assert.equal((await installUpdate(root2, { channel: "stable", packageFile: build(pk, "0.9.0"), allowDowngrade: true })).to, "0.9.0", "unless explicitly allowed");
  assert.equal(err(() => rollback(freshRootWith(pk))), "NO_PREVIOUS");
});
const freshRootWith = (pk: string): string => { const r = freshRoot(); installPackage({ root: r, packageFile: build(pk, "1.0.0"), trustedKeys: trust }); return r; };

test("update: forged, expired, replayed catalogs and a package that does not match the catalog are refused", async () => {
  const pk = tmp(), work = tmp(), root = freshRootWith(pk);
  const v11 = build(pk, "1.1.0");
  const w = (name: string, text: string): string => { const f = join(work, name); writeFileSync(f, text); return f; };
  assert.equal(await errAsync(() => checkForUpdate(root, { catalog: w("a.json", catalog([release(v11, "1.1.0")], rogue.privateKeyPem)), channel: "stable" })), "CATALOG_SIGNATURE");
  const good = JSON.parse(catalog([release(v11, "1.1.0")])) as { releases: Array<{ version: string }> };
  good.releases[0]!.version = "9.9.9"; // modified after signing
  assert.equal(await errAsync(() => checkForUpdate(root, { catalog: w("b.json", JSON.stringify(good)), channel: "stable" })), "CATALOG_SIGNATURE");
  assert.equal(await errAsync(() => checkForUpdate(root, { catalog: w("c.json", catalog([release(v11, "1.1.0")], signer.privateKeyPem, { expiresAt: new Date(Date.now() - 1000).toISOString() })), channel: "stable" })), "CATALOG_EXPIRED");
  assert.equal(await errAsync(() => checkForUpdate(root, { catalog: w("d.json", "{not json"), channel: "stable" })), "CATALOG_FORMAT");
  // a package whose bytes differ from the signed catalog entry (swapped on the server) is discarded and nothing changes
  const entry = release(v11, "1.1.0");
  const swapped = build(tmp(), "1.1.0"); // validly signed by the same key, but not the file the catalog describes
  entry.package = { file: swapped, sha256: entry.package.sha256, size: entry.package.size };
  assert.equal(await errAsync(() => installUpdate(root, { catalog: w("e.json", catalog([entry], signer.privateKeyPem, { sequence: 7 })), channel: "stable" })), "PACKAGE_HASH");
  assert.equal(installState(root).current, "1.0.0");
  // replay: after sequence 9 is accepted, sequence 3 is refused
  await installUpdate(root, { catalog: w("f.json", catalog([release(v11, "1.1.0")], signer.privateKeyPem, { sequence: 9 })), channel: "stable" });
  assert.equal(await errAsync(() => checkForUpdate(root, { catalog: w("g.json", catalog([release(build(pk, "1.2.0"), "1.2.0")], signer.privateKeyPem, { sequence: 3 })), channel: "stable" })), "CATALOG_REPLAY");
  // requires.minInstalled
  const r15 = { ...release(build(pk, "1.5.0"), "1.5.0"), requires: { minInstalled: "1.4.0" } };
  const res = await checkForUpdate(root, { catalog: w("h.json", catalog([r15], signer.privateKeyPem, { sequence: 10 })), channel: "stable" });
  assert.equal(res.available, null); assert.match(res.reason, /requires at least 1\.4\.0/);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.2"), 1); assert.equal(compareVersions("1.10.0", "1.9.9"), 1); assert.equal(compareVersions("2.0.0-beta.1", "2.0.0-beta.2"), -1);
  assert.throws(() => verifyCatalog("{}", trust), (e: unknown) => e instanceof UpdateError);
});

test("update over HTTP: a local server serves the catalog and the package; redirects, oversize and plain remote http are refused", async () => {
  const pk = tmp(), root = freshRootWith(pk);
  const v11 = build(pk, "1.1.0"), bytes = readFileSync(v11);
  const rel: Release = { version: "1.1.0", channel: "stable", platform: process.platform, arch: process.arch, package: { url: "", sha256: sha(bytes), size: bytes.length } };
  let server: Server | undefined;
  let baseUrl = "";
  const base = await new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/catalog.json") { rel.package.url = `${baseUrl}/pso-1.1.0.psopkg`; res.writeHead(200, { "content-type": "application/json" }); res.end(catalog([rel])); }
      else if (req.url === "/pso-1.1.0.psopkg") { res.writeHead(200); res.end(bytes); }
      else if (req.url === "/redirect") { res.writeHead(302, { location: "/catalog.json" }); res.end(); }
      else { res.writeHead(404); res.end(); }
    });
    server.listen(0, "127.0.0.1", () => { baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`; resolve(baseUrl); });
  });
  try {
    const up = await installUpdate(root, { catalog: `${base}/catalog.json`, channel: "stable" });
    assert.equal(up.to, "1.1.0");
    assert.equal(await errAsync(() => checkForUpdate(root, { catalog: `${base}/redirect`, channel: "stable" })), "FETCH", "redirects are not followed");
    assert.equal(await errAsync(() => checkForUpdate(root, { catalog: "http://example.com/catalog.json", channel: "stable" })), "FETCH", "plain http to a remote host");
    assert.equal(await errAsync(() => checkForUpdate(root, { catalog: "https://user:pw@example.com/catalog.json", channel: "stable" })), "FETCH", "credentials in the URL");
  } finally { await new Promise<void>((r) => { server!.closeAllConnections(); server!.close(() => r()); }); }
});

test("interrupted update: leftovers are cleaned, the active version is never changed", () => {
  const pk = tmp(), root = freshRootWith(pk);
  put(join(root, "versions"), ".staging-9.9.9-1/cli/x.js", "half"); put(join(root, "versions"), "7.7.7/cli/y.js", "extracted but never recorded");
  put(join(root, ".pso-install"), "downloads/9.9.9.psopkg", "partial"); writeFileSync(join(root, ".pso-install", "journal.json"), '{"operation":"update"}');
  assert.deepEqual(recoverInterrupted(root), { recovered: true });
  assert.deepEqual(readdirSync(join(root, "versions")), ["1.0.0"]);
  assert.ok(!existsSync(join(root, ".pso-install", "downloads")) && !existsSync(join(root, ".pso-install", "journal.json")));
  assert.equal(installState(root).current, "1.0.0");
  assert.deepEqual(recoverInterrupted(root), { recovered: false }, "nothing to do the second time");
});

test("uninstall: standard keeps user data, complete removes only what PSO owns, purge needs exact confirmation, links are never followed", (t) => {
  const pk = tmp();
  const root = freshRootWith(pk);
  put(root, "config/settings.json", "{}"); put(root, "cache/x.bin", "c"); put(root, "logs/a.log", "l"); put(root, "unknown/readme.txt", "not PSO's");
  const s = uninstall(root, { mode: "standard" });
  assert.equal(s.removedFiles, 4);
  assert.deepEqual(s.preserved.sort(), ["cache", "config", "logs"]);
  assert.ok(existsSync(join(root, "config", "settings.json")) && existsSync(join(root, "unknown", "readme.txt")));
  assert.ok(!existsSync(join(root, "versions", "1.0.0")), "the installed files are gone");
  assert.equal(installState(root).current, null);
  const r2 = uninstall(root, { mode: "complete" });
  assert.ok(!existsSync(join(root, "config")) && !existsSync(join(root, ".pso-install")), "complete removes everything PSO owns");
  assert.ok(existsSync(join(root, "unknown", "readme.txt")), "but never what it does not own");
  assert.ok(existsSync(root), "the root is not deleted while foreign content remains");
  assert.equal(r2.mode, "complete");

  // links: a junction inside the version directory pointing at a directory outside must not cause deletion outside
  const root3 = freshRootWith(pk), outside = tmp();
  put(outside, "precious.txt", "do not delete");
  try { symlinkSync(outside, join(root3, "versions", "1.0.0", "ext"), process.platform === "win32" ? "junction" : "dir"); } catch { return t.skip("links cannot be created here"); }
  uninstall(root3, { mode: "complete" });
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "do not delete", "nothing outside the installation was touched");
  // a link where a config directory belongs
  const root4 = freshRootWith(pk), outside2 = tmp();
  put(outside2, "keep.txt", "keep");
  try { symlinkSync(outside2, join(root4, "config"), process.platform === "win32" ? "junction" : "dir"); } catch { return; }
  uninstall(root4, { mode: "complete" });
  assert.equal(readFileSync(join(outside2, "keep.txt"), "utf8"), "keep", "a linked config directory is unlinked, its target is not deleted");
});

test("purge: only named, confirmed PSO projects; never the root, the home directory, a parent of the installation or an unmarked directory", () => {
  const pk = tmp();
  const proj = tmp(); put(proj, "pso.workspace.json", "{}"); put(proj, "src/app.ts", "x");
  const plain = tmp(); put(plain, "notes.txt", "not a PSO project");
  const root = freshRootWith(pk);
  assert.equal(err(() => uninstall(root, { mode: "purge" })), "PURGE_NONE");
  assert.equal(err(() => uninstall(root, { mode: "purge", purgeProjects: [proj] })), "PURGE_CONFIRM", "the exact path must be confirmed");
  assert.equal(err(() => uninstall(root, { mode: "purge", purgeProjects: [proj], confirmPaths: [plain] })), "PURGE_CONFIRM", "confirming a different path does not count");
  assert.equal(err(() => uninstall(root, { mode: "purge", purgeProjects: [plain], confirmPaths: [plain] })), "PURGE_PATH", "no PSO marker: refused");
  assert.equal(err(() => uninstall(root, { mode: "purge", purgeProjects: [join(root, "..")], confirmPaths: [join(root, "..")] })), "PURGE_PATH", "a parent of the installation");
  assert.equal(err(() => uninstall(root, { mode: "purge", purgeProjects: [root], confirmPaths: [root] })), "PURGE_PATH", "the installation itself");
  assert.ok(existsSync(join(root, "versions", "1.0.0")), "a refused purge removes nothing");
  const r = uninstall(root, { mode: "purge", purgeProjects: [proj], confirmPaths: [proj] });
  assert.deepEqual(r.purgedProjects, [proj]);
  assert.ok(!existsSync(proj) && existsSync(plain));
});

test("CLI: setup, integrity, repair, update and uninstall need an explicit root, report exit codes and honour --yes", { timeout: 120_000 }, async () => {
  const pk = tmp(), keys = tmp(), cwd = tmp(), work = tmp();
  const kp = generateKeyPair("signing");
  writeFileSync(join(keys, "release.public.pem"), kp.publicKeyPem);
  const v1 = build(pk, "1.0.0", kp.privateKeyPem), v11 = build(pk, "1.1.0", kp.privateKeyPem);
  const root = join(tmp(), "home");
  const j = async (...a: string[]) => { const r = await pso(cwd, ...a, "--json"); return { code: r.code, out: r.out ? JSON.parse(r.out) : null, err: r.err }; };
  assert.equal((await pso(cwd, "integrity", "check")).code, 1, "no root: refuses to guess");
  const s = await j("setup", "--package", v1, "--root", root, "--trust", join(keys, "release.public.pem"));
  assert.deepEqual([s.code, s.out.version], [0, "1.0.0"], s.err);
  assert.equal((await j("integrity", "check", "--full", "--root", root)).code, 0);
  // an installed pso: its launcher names the installation it runs from, used when neither --root nor PSO_HOME is given
  process.env["PSO_LAUNCHED_FROM"] = root;
  try {
    const own = await j("integrity", "check", "--full");
    assert.equal(own.code, 0, own.err);
    process.env["PSO_HOME"] = join(tmp(), "elsewhere");
    assert.equal((await pso(cwd, "integrity", "check")).code, 1, "PSO_HOME takes precedence over the launching installation");
  } finally { delete process.env["PSO_LAUNCHED_FROM"]; delete process.env["PSO_HOME"]; }
  rmSync(join(root, "versions", "1.0.0", "cli", "bin", "pso.js"));
  const bad = await j("integrity", "report", "--root", root);
  assert.deepEqual([bad.code, bad.out.ok, bad.out.files.damaged[0].state], [1, false, "missing"]);
  const dry = await j("repair", "--dry-run", "--root", root);
  assert.deepEqual([dry.code, dry.out.repaired], [0, ["cli/bin/pso.js"]]);
  assert.equal((await j("repair", "--quick", "--full", "--root", root)).code, 1, "exclusive flags");
  assert.equal((await j("repair", "--root", root)).code, 0);
  assert.equal((await j("integrity", "check", "--root", root)).code, 0);
  const cat = join(work, "catalog.json");
  writeFileSync(cat, JSON.stringify(signCatalog({ schema: 1, product: "pso", sequence: 1, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), releases: [release(v11, "1.1.0")] }, kp.privateKeyPem)));
  assert.equal((await j("update", "check", "--catalog", cat, "--root", root)).out.available.version, "1.1.0");
  assert.equal((await j("update", "install", "--catalog", cat, "--root", root)).out.to, "1.1.0");
  assert.equal((await j("update", "rollback", "--root", root)).out.to, "1.0.0");
  assert.equal((await pso(cwd, "uninstall", "--root", root)).code, 1, "destructive: needs --yes");
  assert.equal((await j("uninstall", "--complete", "--yes", "--root", root)).code, 0);
  assert.ok(!existsSync(join(root, ".pso-install")));
  assert.equal(fingerprintOf(kp.publicKeyPem).length, 16);
});
