// First-install trust bootstrap: a clean machine has no trust state, and the key inside the installer must never be a trust anchor by itself.
// Everything runs in isolated temp stores (PSO_RECIPIENT_HOME) and temp install roots; no real developer installation or registry entry is touched
// (the Inno tests use a test-only AppId and a temp directory).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { judgeSignature, commonName } from "../tools/authenticode.ts";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pso = join(repo, "packages", "cli", "bin", "pso.js");
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
after(() => { if (process.env.PSD_KEEP) { console.log("# kept", dirs.join(" ")); return; } for (const d of dirs) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* OS reaps temp */ } });
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000, windowsHide: true });

let work, tools, boot, recip, keys, stage, cfg, pkgA, pkgA2, pkgB, fpA, fpB;
const fpOf = (pem) => JSON.parse(run(boot, ["fingerprint", pem, "--json"]).stdout).fingerprint;
const pack = (out, key, version) => {
  writeFileSync(cfg, JSON.stringify({ name: "demo", version, platform: "win32", arch: "x64", components: [{ name: "c", version, include: [{ from: "stage", to: "." }] }] }));
  const p = spawnSync(process.execPath, [pso, "dist", "pack", "--config", cfg, "--stage", stage, "--sign-key", join(keys, `${key}.private.pem`), "--out", out], { encoding: "utf8", cwd: work });
  assert.equal(p.status, 0, p.stdout + p.stderr);
};
const clean = () => ({ store: tmp("psd-store-"), root: join(tmp("psd-root-"), "pso") }); // a machine with no trust state at all
const install = (c, pkg, key, extra = []) => run(boot, ["install", "--package", pkg, "--root", c.root, "--trust", join(keys, `${key}.public.pem`), ...extra], { PSO_RECIPIENT_HOME: c.store });
const noRoot = (c) => assert.ok(!existsSync(c.root), `nothing may be left behind, found ${c.root}`);

before(() => {
  work = tmp("psd-trust-"); tools = join(work, "tools"); keys = join(work, "keys"); stage = join(work, "stage"); cfg = join(work, "dist.config.json");
  const b = spawnSync(process.execPath, [join(repo, "scripts", "psd", "build-tools.mjs"), "--out", tools], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  boot = join(tools, "pso-bootstrap.mjs"); recip = join(tools, "pso-recipient.mjs");
  mkdirSync(join(stage, "app"), { recursive: true }); writeFileSync(join(stage, "app", "run.js"), "console.log('payload');\n");
  for (const name of ["a", "b"]) assert.equal(spawnSync(process.execPath, [pso, "dist", "keygen", "--kind", "signing", "--out", keys, "--name", name], { encoding: "utf8" }).status, 0);
  pkgA = join(work, "a-1.psopkg"); pkgA2 = join(work, "a-2.psopkg"); pkgB = join(work, "b-3.psopkg");
  pack(pkgA, "a", "1.0.0"); pack(pkgA2, "a", "2.0.0"); pack(pkgB, "b", "3.0.0");
  fpA = fpOf(join(keys, "a.public.pem")); fpB = fpOf(join(keys, "b.public.pem"));
});

test("clean machine, no trust state: refused, with an actionable message, and nothing is created", () => {
  const c = clean();
  const r = install(c, pkgA, "a");
  assert.equal(r.status, 1); assert.match(r.stderr, /NO_TRUST_ANCHOR/);
  assert.match(r.stderr, /DIFFERENT channel/); assert.match(r.stderr, /\/SIGNER=/); assert.match(r.stderr, /pin-signer/);
  noRoot(c);
  assert.equal(run(boot, ["check-anchor", "--trust", join(keys, "a.public.pem"), "--root", c.root], { PSO_RECIPIENT_HOME: c.store }).status, 1, "the wizard must ask on a clean machine");
});

test("correct, independently obtained fingerprint (any copy/paste formatting) installs a public release with no identity", () => {
  const c = clean();
  const pretty = fpA.toUpperCase().replace(/(.{4})/g, "$1 ").trim();
  const r = install(c, pkgA, "a", ["--expect-signer", pretty, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).signer, fpA);
  assert.ok(existsSync(join(c.root, "versions", "1.0.0", "app", "run.js")));
  assert.ok(!existsSync(join(c.store, "trust.json")), "typing the fingerprint must not pin it silently");
  assert.ok(!existsSync(join(c.store, "identity.json")), "a public release needs no recipient identity");
  const ic = spawnSync(process.execPath, [pso, "integrity", "check", "--full", "--root", c.root], { encoding: "utf8" });
  assert.equal(ic.status, 0, ic.stdout + ic.stderr);
});

test("incorrect or malformed fingerprint: refused, nothing created", () => {
  const c = clean();
  const wrong = install(c, pkgA, "a", ["--expect-signer", fpB]);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /SIGNER_MISMATCH/); noRoot(c);
  const bad = install(c, pkgA, "a", ["--expect-signer", "1234"]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /FINGERPRINT_INVALID/); noRoot(c);
  const empty = install(c, pkgA, "a", ["--expect-signer", ""]);
  assert.equal(empty.status, 1); assert.match(empty.stderr, /FINGERPRINT_INVALID/); noRoot(c);
});

test("a wrong typed fingerprint is not rescued by an older pin (an explicit contradiction is never overridden)", () => {
  const c = clean();
  assert.equal(run(recip, ["pin-signer", "--fingerprint", fpA], { PSO_RECIPIENT_HOME: c.store }).status, 0);
  const r = install(c, pkgA, "a", ["--expect-signer", fpB]);
  assert.equal(r.status, 1); assert.match(r.stderr, /SIGNER_MISMATCH/); noRoot(c);
});

test("existing machine with a pinned signer: installs without being told again; pinning needs no identity", () => {
  const c = clean();
  const p = run(recip, ["pin-signer", "--fingerprint", fpA, "--label", "release"], { PSO_RECIPIENT_HOME: c.store });
  assert.equal(p.status, 0, p.stderr);
  assert.ok(!existsSync(join(c.store, "identity.json")));
  assert.equal(run(boot, ["check-anchor", "--trust", join(keys, "a.public.pem"), "--root", c.root], { PSO_RECIPIENT_HOME: c.store }).status, 0);
  const r = install(c, pkgA, "a");
  assert.equal(r.status, 0, r.stderr);
  assert.match(run(recip, ["signers"], { PSO_RECIPIENT_HOME: c.store }).stdout, new RegExp(fpA.slice(0, 4)));
});

test("--pin-signer remembers the typed fingerprint only after a successful install, and only when asked", () => {
  const c = clean();
  const fail = install(c, pkgA, "a", ["--expect-signer", fpB, "--pin-signer"]);
  assert.equal(fail.status, 1);
  assert.ok(!existsSync(join(c.store, "trust.json")), "a refused install pins nothing");
  const ok = install(c, pkgA, "a", ["--expect-signer", fpA, "--pin-signer"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(join(c.store, "trust.json"), "utf8")).pinnedSigners[0].fingerprint, fpA);
});

test("modified installer payload is rejected before anything is written, even with the right fingerprint", () => {
  const c = clean();
  const bytes = readFileSync(pkgA); bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const bad = join(work, "payload-tampered.psopkg"); writeFileSync(bad, bytes);
  const r = install(c, bad, "a", ["--expect-signer", fpA]);
  assert.equal(r.status, 1); assert.match(r.stderr, /PSOPKG_SIGNATURE|PSOPKG_FORMAT/); noRoot(c);
});

test("modified package signature is rejected", () => {
  const c = clean();
  const bytes = readFileSync(pkgA); bytes[bytes.length - 1] ^= 0x01;
  const bad = join(work, "sig-tampered.psopkg"); writeFileSync(bad, bytes);
  const r = install(c, bad, "a", ["--expect-signer", fpA]);
  assert.equal(r.status, 1); assert.match(r.stderr, /PSOPKG_SIGNATURE/); noRoot(c);
});

test("a package re-signed by someone else with the embedded key swapped is refused (the embedded key is not an anchor)", () => {
  const c = clean();
  // attacker replaces package AND embedded key with their own: only the fingerprint the person obtained elsewhere (A) catches it
  const r = install(c, pkgB, "b", ["--expect-signer", fpA]);
  assert.equal(r.status, 1); assert.match(r.stderr, /SIGNER_MISMATCH/); noRoot(c);
});

test("missing signer key file", () => {
  const c = clean();
  const r = run(boot, ["install", "--package", pkgA, "--root", c.root, "--trust", join(work, "nope.pem"), "--expect-signer", fpA], { PSO_RECIPIENT_HOME: c.store });
  assert.equal(r.status, 1); assert.match(r.stderr, /TRUST_MISSING/); noRoot(c);
  const junk = join(work, "junk.pem"); writeFileSync(junk, "not a key");
  const r2 = run(boot, ["install", "--package", pkgA, "--root", c.root, "--trust", junk, "--expect-signer", fpA], { PSO_RECIPIENT_HOME: c.store });
  assert.equal(r2.status, 1); assert.match(r2.stderr, /TRUST_INVALID/); noRoot(c);
});

test("interrupted installation and retry: stale decrypted staging is swept, a failed first attempt leaves no root, the retry succeeds", () => {
  const c = clean();
  const bytes = readFileSync(pkgA); bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const bad = join(work, "retry-tampered.psopkg"); writeFileSync(bad, bytes);
  assert.equal(install(c, bad, "a", ["--expect-signer", fpA]).status, 1); noRoot(c);
  const ok = install(c, pkgA, "a", ["--expect-signer", fpA]);
  assert.equal(ok.status, 0, ok.stderr);
  // an interrupted run of a later version leaves a staging directory of a process that no longer exists
  const stale = join(c.root, "versions", ".staging-9.9.9-2147483000"); mkdirSync(join(stale, "app"), { recursive: true }); writeFileSync(join(stale, "app", "plain.js"), "leftover\n");
  assert.equal(install(c, pkgA2, "a").status, 0, "the installation's own trusted signer anchors the next installer");
  assert.ok(!existsSync(stale));
  assert.deepEqual(readdirSync(join(c.root, "versions")).filter((n) => n.startsWith(".staging")), []);
});

test("update from an already trusted installation: pso update verifies against the signer fixed at first install, and rejects any other", () => {
  const c = clean();
  assert.equal(install(c, pkgA, "a", ["--expect-signer", fpA]).status, 0);
  const up = spawnSync(process.execPath, [pso, "update", "install", "--package", pkgA2, "--root", c.root], { encoding: "utf8" });
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.equal(JSON.parse(readFileSync(join(c.root, ".pso-install", "install.json"), "utf8")).current, "2.0.0");
  const evil = spawnSync(process.execPath, [pso, "update", "install", "--package", pkgB, "--root", c.root], { encoding: "utf8" });
  assert.notEqual(evil.status, 0, "a package from an unknown signer cannot update the installation");
  assert.equal(JSON.parse(readFileSync(join(c.root, ".pso-install", "install.json"), "utf8")).current, "2.0.0");
});

test("signer rotation is explicit: the new key needs its own independently obtained fingerprint, the old key can then be retired", () => {
  const c = clean();
  assert.equal(run(recip, ["pin-signer", "--fingerprint", fpA], { PSO_RECIPIENT_HOME: c.store }).status, 0);
  assert.equal(install(c, pkgA, "a").status, 0);
  // the maintainer rotates to key B: nothing already trusted vouches for it
  const silent = install(c, pkgB, "b");
  assert.equal(silent.status, 1); assert.match(silent.stderr, /SIGNER_NOT_TRUSTED/); assert.match(silent.stderr, /rotated/);
  assert.ok(!existsSync(join(c.root, "versions", "3.0.0")));
  // an update through pso update does not silently accept the new signer either
  assert.notEqual(spawnSync(process.execPath, [pso, "update", "install", "--package", pkgB, "--root", c.root], { encoding: "utf8" }).status, 0);
  // the person obtains B's fingerprint from the maintainer through the independent channel and passes it
  const rot = install(c, pkgB, "b", ["--expect-signer", fpB, "--pin-signer"]);
  assert.equal(rot.status, 0, rot.stderr);
  const trusted = readdirSync(join(c.root, ".pso-install", "trust")).sort();
  assert.equal(trusted.length, 2, "the installation now trusts both signers");
  // retire A: releases signed by it are refused again
  assert.equal(run(recip, ["unpin-signer", "--fingerprint", fpA], { PSO_RECIPIENT_HOME: c.store }).status, 0);
  const signers = JSON.parse(run(recip, ["signers", "--json"], { PSO_RECIPIENT_HOME: c.store }).stdout).pinnedSigners.map((p) => p.fingerprint);
  assert.deepEqual(signers, [fpB]);
  const fresh = clean(); fresh.store = c.store;
  const old = install(fresh, pkgA, "a");
  assert.equal(old.status, 1); assert.match(old.stderr, /SIGNER_NOT_TRUSTED/); noRoot(fresh);
});

test("a damaged trust store fails closed with a way out", () => {
  const c = clean();
  writeFileSync(join(c.store, "trust.json"), "{not json");
  const r = install(c, pkgA, "a");
  assert.equal(r.status, 1); assert.match(r.stderr, /TRUST_STORE_CORRUPT/); noRoot(c);
});

// ------------------------------------------------------------------ the real Inno Setup installer (silent mode; the wizard page itself needs a human)
const iscc = ["ISCC", "C:\\Program Files\\Inno Setup 7\\ISCC.exe", "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe", "C:\\Program Files\\Inno Setup 6\\ISCC.exe"].map((p) => p === "ISCC" ? process.env.ISCC : p).find((p) => p && existsSync(p));
const TEST_APPID = "{{0F5C2E5A-7A3B-4C8E-9D11-5E57A11B0001}";
const hkcuKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{0F5C2E5A-7A3B-4C8E-9D11-5E57A11B0001}_is1";
const regHas = () => spawnSync("reg", ["query", hkcuKey], { encoding: "utf8" }).status === 0;

test("Inno installer, silent: the wizard-less paths enforce the same anchor, leave nothing behind and keep the developer's real installation untouched", { skip: process.platform !== "win32" || !iscc }, (t) => {
  const out = join(work, "inno");
  const r = spawnSync(process.execPath, [pso, "dist", "installer", "--platform", "windows", "--package", pkgA, "--bootstrap", boot, "--trust", join(keys, "a.public.pem"), "--out", out, "--name", "trust-test"], { encoding: "utf8", env: { ...process.env, ISCC: iscc } });
  // regenerate with a test-only AppId so no real Uninstall entry can be shared or replaced
  const issFile = join(out, "pso-setup.iss");
  assert.ok(existsSync(issFile), r.stdout + r.stderr);
  const iss = readFileSync(issFile, "utf8");
  assert.match(iss, /CreateInputQueryPage/); assert.match(iss, /check-anchor/); assert.doesNotMatch(iss, /pinned when you enrolled/);
  const realKeyBefore = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{B2E1F6A3-7C34-4D0E-9A55-3C1D8A9F0001}_is1"], { encoding: "utf8" }).stdout;
  writeFileSync(issFile, iss.replace(/AppId=\{\{[0-9A-F-]+\}/, `AppId=${TEST_APPID}`));
  const store = tmp("psd-store-"); const dir = join(tmp("psd-inno-"), "pso");
  let last, exe, attempts = 0;
  const run1 = (args) => (last = spawnSync(exe, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${dir}`, `/LOG=${join(work, "setup.log")}`, ...args], { encoding: "utf8", env: { ...process.env, PSO_RECIPIENT_HOME: store }, timeout: 300_000 }));
  const logText = () => { assert.ok(existsSync(join(work, "setup.log")), `Setup left no log: status ${last?.status} error ${last?.error?.message}`); return readFileSync(join(work, "setup.log"), "utf8"); };
  const refused = (args, re) => { const x = run1(args); assert.notEqual(x.status, 0, "Setup must stop"); const t = logText(); assert.match(t, re, t.slice(-2500)); assert.ok(!existsSync(dir), "no install directory"); assert.ok(!regHas(), "no uninstall entry"); };
  // Windows App Control may refuse to start a freshly built UNSIGNED executable (spawn error UNKNOWN, no policy bypass is attempted): a rebuild is a new file, so rebuild a few times
  for (; attempts < 5; attempts++) {
    exe = join(out, `trust-test-${attempts}.exe`);
    const c = spawnSync(iscc, ["/Q", `/F${`trust-test-${attempts}`}`, issFile], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stdout + c.stderr);
    run1(["/SIGNER=zz"]);
    if (!last.error) break;
  }
  if (last.error) { t.skip(`Windows application control (Smart App Control) refused to start every rebuilt unsigned installer (${attempts + 1} attempts): ${last.error.message}. Not bypassed; this check did NOT run.`); return; }
  console.log(`# inno installer started after ${attempts + 1} build attempt(s)`);
  try {
    refused([], /NO_TRUST_ANCHOR/);
    refused([`/SIGNER=${fpB}`], /SIGNER_MISMATCH/);
    refused(["/SIGNER=zz"], /FINGERPRINT_INVALID/);
    const ok = run1([`/SIGNER=${fpA}`]);
    assert.equal(ok.status, 0, logText().slice(-2500));
    assert.ok(existsSync(join(dir, "versions", "1.0.0", "app", "run.js"))); assert.ok(regHas());
    assert.ok(!existsSync(join(store, "trust.json")), "no silent pin");
  } finally {
    const un = join(dir, "unins000.exe");
    if (existsSync(un)) spawnSync(un, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { timeout: 120_000 });
    spawnSync("reg", ["delete", hkcuKey, "/f"], { encoding: "utf8" });
  }
  const realKeyAfter = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{B2E1F6A3-7C34-4D0E-9A55-3C1D8A9F0001}_is1"], { encoding: "utf8" }).stdout;
  assert.equal(realKeyAfter, realKeyBefore, "the real PSO uninstall entry is untouched");
});

// ------------------------------------------------------------------ Authenticode publisher trust (the operating-system-backed anchor)
// A positive end-to-end run needs a code-signing certificate whose chain this Windows trusts; none exists here and none is faked (no test root is installed).
// What IS verified: the judgement rules, and that unsigned / untrusted-signature files never produce an anchor.
const good = { status: "Valid", subject: 'CN=PSO Games, O="PSO Games Ltda", C=BR', thumbprint: "AB12", timestamped: true };

test("authenticode judgement: only Valid + exact publisher + timestamp is accepted", () => {
  assert.equal(commonName('CN="PSO, Games", C=BR'), "PSO, Games");
  assert.equal(judgeSignature(good, "PSO Games").ok, true);
  for (const status of ["NotSigned", "HashMismatch", "UnknownError", "NotTrusted", "Incompatible"]) assert.equal(judgeSignature({ ...good, status }, "PSO Games").ok, false, status);
  assert.equal(judgeSignature({ ...good, subject: "CN=PSO Games Evil, C=XX" }, "PSO Games").ok, false, "a look-alike publisher");
  assert.equal(judgeSignature({ ...good, subject: "CN=Someone, O=PSO Games" }, "PSO Games").ok, false, "publisher name only in another field");
  assert.equal(judgeSignature({ ...good, timestamped: false }, "PSO Games").ok, false);
  assert.equal(judgeSignature(good, "PSO Games", ["ZZ99"]).ok, false); assert.equal(judgeSignature(good, "PSO Games", ["ab12"]).ok, true);
  assert.equal(judgeSignature(undefined, "PSO Games").ok, false); assert.equal(judgeSignature(good, "").ok, false);
});

test("an unsigned installer is never accepted as a publisher anchor; the bootstrap falls back to the explicit fingerprint", { skip: process.platform !== "win32" }, () => {
  const c = clean();
  const exe = process.execPath; // a real executable that is NOT signed by the test publisher
  const args = ["--setup-exe", join(work, "unsigned-setup.exe"), "--publisher", "PSO Games"];
  writeFileSync(join(work, "unsigned-setup.exe"), readFileSync(pkgA)); // not even a PE file
  const r = install(c, pkgA, "a", args);
  assert.equal(r.status, 1); assert.match(r.stderr, /NO_TRUST_ANCHOR/); noRoot(c);
  assert.equal(run(boot, ["check-anchor", "--trust", join(keys, "a.public.pem"), "--root", c.root, ...args], { PSO_RECIPIENT_HOME: c.store }).status, 1);
  // Node's own executable is signed by its publisher (OpenJS), which is not the expected one: refused even though Windows trusts that signature
  const other = install(c, pkgA, "a", ["--setup-exe", exe, "--publisher", "PSO Games"]);
  assert.equal(other.status, 1); assert.match(other.stderr, /NO_TRUST_ANCHOR/); noRoot(c);
  // the fingerprint path still works next to it
  assert.equal(install(c, pkgA, "a", [...args, "--expect-signer", fpA]).status, 0);
});

test("sign-installer: without a certificate it refuses to sign and says exactly what is missing; verification of an unsigned file is REFUSED", { skip: process.platform !== "win32" }, () => {
  const s = join(repo, "scripts", "psd", "sign-installer.mjs");
  const f = join(work, "unsigned-setup.exe"); writeFileSync(f, "MZ");
  const env = { PSO_SIGN_THUMBPRINT: "", PSO_SIGN_PFX: "", PSO_SIGN_DLIB: "" };
  const sign = run(s, ["--file", f, "--publisher", "PSO Games"], env);
  assert.equal(sign.status, 3); assert.match(sign.stderr, /BLOCKED/); assert.match(sign.stderr, /No signing identity/);
  const ver = run(s, ["--file", f, "--publisher", "PSO Games", "--verify-only"], env);
  assert.equal(ver.status, 1); assert.match(ver.stdout, /REFUSED/);
});

// ------------------------------------------------------------------ development distribution (unsigned alpha) + private runtime + launcher
const dev = ["--dev-distribution"];
const noNodePath = () => process.env.SystemRoot + String.fromCharCode(92) + "System32";

test("dev distribution: a clean machine installs with no fingerprint, records the mode, and the key it used becomes the only trusted one", () => {
  const c = clean();
  const r = install(c, pkgA, "a", [...dev, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).anchor, "development");
  const d = JSON.parse(readFileSync(join(c.root, ".pso-install", "distribution.json"), "utf8"));
  assert.equal(d.mode, "development-unsigned"); assert.match(d.publisherClaim, /PSO Web Framework \(maintainer DevMboo\), NOT verified/); assert.equal(d.signer, fpA);
  assert.ok(!existsSync(join(c.store, "trust.json")), "dev mode never pins");
  // the installation now trusts exactly this key: a package from another key cannot update it
  assert.notEqual(spawnSync(process.execPath, [pso, "update", "install", "--package", pkgB, "--root", c.root], { encoding: "utf8" }).status, 0);
  // and a later dev installer of the same key is accepted, of another key refused (no trust-on-first-use twice)
  assert.equal(install(c, pkgA2, "a", dev).status, 0);
  const other = install(c, pkgB, "b", dev);
  assert.equal(other.status, 1); assert.match(other.stderr, /SIGNER_NOT_TRUSTED/);
});

test("dev distribution never downgrades trusted state: a pinned signer, or an installation that trusts another key, refuses it", () => {
  const pinned = clean();
  assert.equal(run(recip, ["pin-signer", "--fingerprint", fpA], { PSO_RECIPIENT_HOME: pinned.store }).status, 0);
  const r1 = install(pinned, pkgB, "b", dev);
  assert.equal(r1.status, 1); assert.match(r1.stderr, /SIGNER_NOT_TRUSTED/); noRoot(pinned);
  const installed = clean();
  assert.equal(install(installed, pkgA, "a", ["--expect-signer", fpA]).status, 0);
  const r2 = install(installed, pkgB, "b", dev);
  assert.equal(r2.status, 1); assert.match(r2.stderr, /SIGNER_NOT_TRUSTED/);
  assert.ok(!existsSync(join(installed.root, "versions", "3.0.0")));
  assert.ok(!existsSync(join(installed.root, ".pso-install", "distribution.json")), "a trusted installation is not relabelled");
});

test("dev distribution still rejects tampering, and a typed fingerprint that contradicts the key still wins", () => {
  const c = clean();
  const bytes = readFileSync(pkgA); bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const bad = join(work, "dev-tampered.psopkg"); writeFileSync(bad, bytes);
  const t = install(c, bad, "a", dev);
  assert.equal(t.status, 1); assert.match(t.stderr, /PSOPKG_SIGNATURE|PSOPKG_FORMAT/); noRoot(c);
  const sig = readFileSync(pkgA); sig[sig.length - 1] ^= 1; const bad2 = join(work, "dev-badsig.psopkg"); writeFileSync(bad2, sig);
  assert.equal(install(c, bad2, "a", dev).status, 1); noRoot(c);
  const m = install(c, pkgA, "a", [...dev, "--expect-signer", fpB]);
  assert.equal(m.status, 1); assert.match(m.stderr, /SIGNER_MISMATCH/); noRoot(c);
  assert.equal(install(c, pkgA, "a", ["--expect-signer", fpA]).status, 0, "without --dev-distribution nothing changed");
});

test("without --dev-distribution the strict behaviour is unchanged (still NO_TRUST_ANCHOR)", () => {
  const c = clean();
  const r = install(c, pkgA, "a"); assert.equal(r.status, 1); assert.match(r.stderr, /NO_TRUST_ANCHOR/); noRoot(c);
});

test("private runtime and launcher: pso runs from a new terminal with no Node.js on PATH, follows the active version, and leaves global state alone", { skip: process.platform !== "win32" }, () => {
  const stage2 = join(work, "stage-launch");
  mkdirSync(join(stage2, "node_modules", "@pso", "cli", "bin"), { recursive: true });
  writeFileSync(join(stage2, "node_modules", "@pso", "cli", "bin", "pso.js"), "console.log('launched ' + process.argv.slice(2).join(',') + ' ' + process.cwd().length);\n");
  const mk = (v, out) => { writeFileSync(cfg, JSON.stringify({ name: "demo", version: v, platform: "win32", arch: "x64", components: [{ name: "c", version: v, include: [{ from: "stage-launch", to: "." }] }] })); assert.equal(spawnSync(process.execPath, [pso, "dist", "pack", "--config", cfg, "--stage", stage2, "--sign-key", join(keys, "a.private.pem"), "--out", out], { encoding: "utf8", cwd: work }).status, 0); };
  const p1 = join(work, "l1.psopkg"), p2 = join(work, "l2.psopkg"); mk("1.0.0", p1); mk("2.0.0", p2);
  const c = clean();
  const pathBefore = spawnSync("reg", ["query", "HKCU\Environment", "/v", "Path"], { encoding: "utf8" }).stdout;
  assert.equal(install(c, p1, "a", [...dev, "--bundle-runtime"]).status, 0);
  const cmd = join(c.root, "bin", "pso.cmd");
  const text = readFileSync(cmd, "utf8");
  assert.ok(/^@echo off\r\n/.test(text) && text.includes(["..", "runtime", "node.exe"].join(String.fromCharCode(92))) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), "no control characters in the launcher");
  const env = { ...process.env, PATH: noNodePath() };
  const go = (...a) => spawnSync(process.env.ComSpec, ["/d", "/c", cmd, ...a], { encoding: "utf8", env, cwd: work });
  let r = go("--version");
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /launched --version/);
  assert.equal(spawnSync("where", ["node"], { encoding: "utf8", env }).status !== 0, true, "the test environment really has no node on PATH");
  // the active version is read at run time: an update changes what pso runs without touching PATH or the launcher
  assert.equal(install(c, p2, "a", [...dev, "--bundle-runtime"]).status, 0);
  assert.equal(JSON.parse(readFileSync(join(c.root, ".pso-install", "install.json"), "utf8")).current, "2.0.0");
  r = go("x"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /launched x/);
  assert.equal(spawnSync("reg", ["query", "HKCU\Environment", "/v", "Path"], { encoding: "utf8" }).stdout, pathBefore, "bootstrap never edits PATH (the installer does, for the current user only)");
  assert.ok(readdirSync(join(c.root, "runtime")).includes("node.exe"));
  // a failed first install of an unrelated root leaves nothing, including no runtime or launcher
  const bad = clean(); const bytes = readFileSync(p1); bytes[Math.floor(bytes.length / 2)] ^= 0xff; const bp = join(work, "l-bad.psopkg"); writeFileSync(bp, bytes);
  assert.equal(install(bad, bp, "a", [...dev, "--bundle-runtime"]).status, 1); noRoot(bad);
});
