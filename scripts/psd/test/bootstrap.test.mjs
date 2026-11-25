import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pso = join(repo, "packages", "cli", "bin", "pso.js");
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* OS reaps temp */ } });
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000, windowsHide: true });
const PASS = "correct horse battery staple";

let tools, boot, recip, work, keys, stage, pkg, home1, home2, homeOut, rel;
const fp = (pem) => run(boot, ["fingerprint", pem, "--json"]).stdout && JSON.parse(run(boot, ["fingerprint", pem, "--json"]).stdout).fingerprint;
const enroll = (home, label, store) => {
  const o = run(recip, ["init", "--label", label, "--store", store, "--out", work, "--json"], { PSO_RECIPIENT_HOME: home, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(o.status, 0, o.stderr + o.stdout);
  return JSON.parse(o.stdout);
};

before(() => {
  work = tmp("psd-boot-"); tools = join(work, "tools"); keys = join(work, "keys"); stage = join(work, "stage");
  const b = spawnSync(process.execPath, [join(repo, "scripts", "psd", "build-tools.mjs"), "--out", tools], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  boot = join(tools, "pso-bootstrap.mjs"); recip = join(tools, "pso-recipient.mjs");
  for (const [p, c] of [["app/run.js", "console.log('payload');\n"], ["app/lib/a.js", "export const a = 1;\n"], ["README.md", "hello\n"]]) { mkdirSync(join(stage, p, ".."), { recursive: true }); writeFileSync(join(stage, p), c); }
  for (const [kind, name] of [["signing", "release"], ["signing", "other"]]) assert.equal(spawnSync(process.execPath, [pso, "dist", "keygen", "--kind", kind, "--out", keys, "--name", name], { encoding: "utf8" }).status, 0);
  home1 = join(work, "home1"); home2 = join(work, "home2"); homeOut = join(work, "homeOut");
  // dev1 uses REAL Windows DPAPI where available; dev2 uses the passphrase store; the outsider is enrolled but never authorized
  const d1 = enroll(home1, "dev one", process.platform === "win32" ? "dpapi" : "passphrase");
  const d2 = enroll(home2, "dev two", "passphrase");
  enroll(homeOut, "outsider", "passphrase");
  const cfg = join(work, "dist.config.json");
  writeFileSync(cfg, JSON.stringify({ name: "demo", version: "1.0.0", platform: "win32", arch: "x64", components: [{ name: "c", version: "1.0.0", include: [{ from: "stage", to: "." }] }] }));
  pkg = join(work, "demo.psopkg");
  const p = spawnSync(process.execPath, [pso, "dist", "pack", "--config", cfg, "--stage", stage, "--sign-key", join(keys, "release.private.pem"), "--encrypt", "--recipient", [d1, d2].map((d) => join(work, `${d.label.replace(/ /g, "_")}.enrollment.json`)).map((f) => { const e = JSON.parse(readFileSync(f, "utf8")); const pf = f.replace(/\.enrollment\.json$/, ".public.pem"); writeFileSync(pf, e.publicKeyPem); return pf; }).join(","), "--out", pkg], { encoding: "utf8", cwd: work });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  rel = fp(join(keys, "release.public.pem"));
  assert.match(rel, /^[0-9a-f]{64}$/);
});

test("the enrollment file holds only public material; the identity store never holds a plaintext private key", () => {
  const e = JSON.parse(readFileSync(join(work, "dev_one.enrollment.json"), "utf8"));
  assert.ok(!JSON.stringify(e).includes("PRIVATE"));
  assert.match(e.fingerprint, /^[0-9a-f]{64}$/);
  for (const h of [home1, home2]) { const t = readFileSync(join(h, "identity.json"), "utf8"); assert.ok(!t.includes("BEGIN PRIVATE KEY") && !t.includes("MC4CAQAw"), "private key is not stored in clear"); }
  if (process.platform === "win32") assert.equal(JSON.parse(readFileSync(join(home1, "identity.json"), "utf8")).protection.kind, "dpapi");
});

test("the bootstrap contains none of the proprietary PSO modules (it is the only plaintext the installer runs)", () => {
  const m = JSON.parse(readFileSync(join(tools, "tools-manifest.json"), "utf8")).tools.find((t) => t.name === "pso-bootstrap");
  assert.deepEqual(m.forbiddenMarkers, []);
  assert.ok(m.bytes < 64 * 1024, `bootstrap is ${m.bytes} bytes`);
  assert.ok(m.modules.every((x) => /psopkg|install|recipient-store|bootstrap-main|authenticode|fswalk|diagnostics/.test(x)), m.modules.join());
});

test("no independent trust anchor: the installer refuses even though the package is valid", () => {
  const root = join(tmp("psd-root-"), "pso");
  const r = run(boot, ["install", "--package", pkg, "--root", root, "--trust", join(keys, "release.public.pem")], { PSO_RECIPIENT_HOME: home2, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(r.status, 1); assert.match(r.stderr, /NO_TRUST_ANCHOR/); assert.ok(!existsSync(root) || !existsSync(join(root, "versions")));
});

test("a signer that is not the pinned one is refused (replacing both package and embedded key does not help)", () => {
  const root = join(tmp("psd-root-"), "pso");
  assert.equal(run(recip, ["pin-signer", "--fingerprint", rel, "--label", "release"], { PSO_RECIPIENT_HOME: home2 }).status, 0);
  const otherPem = join(keys, "other.public.pem");
  const r = run(boot, ["install", "--package", pkg, "--root", root, "--trust", otherPem], { PSO_RECIPIENT_HOME: home2, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(r.status, 1); assert.match(r.stderr, /SIGNER_NOT_TRUSTED/);
  // the genuine key but a forged signature: the package was re-signed by someone else and the key swapped back
  const forged = join(work, "forged.psopkg");
  const cfg = join(work, "dist.config.json");
  const p = spawnSync(process.execPath, [pso, "dist", "pack", "--config", cfg, "--stage", stage, "--sign-key", join(keys, "other.private.pem"), "--out", forged], { encoding: "utf8", cwd: work });
  assert.equal(p.status, 0, p.stderr);
  const r2 = run(boot, ["install", "--package", forged, "--root", root, "--trust", join(keys, "release.public.pem")], { PSO_RECIPIENT_HOME: home2, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(r2.status, 1); assert.match(r2.stderr, /PSOPKG_SIGNATURE/); assert.ok(!existsSync(join(root, "versions")));
});

test("an enrolled developer who is not a recipient of this release cannot decrypt it", () => {
  const root = join(tmp("psd-root-"), "pso");
  assert.equal(run(recip, ["pin-signer", "--fingerprint", rel], { PSO_RECIPIENT_HOME: homeOut }).status, 0);
  const r = run(boot, ["install", "--package", pkg, "--root", root, "--trust", join(keys, "release.public.pem")], { PSO_RECIPIENT_HOME: homeOut, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(r.status, 1); assert.match(r.stderr, /NOT_AUTHORIZED/); assert.ok(!existsSync(join(root, "versions")));
  const nobody = run(boot, ["install", "--package", pkg, "--root", root, "--trust", join(keys, "release.public.pem"), "--expect-signer", rel], { PSO_RECIPIENT_HOME: join(work, "nobody") });
  assert.equal(nobody.status, 1); assert.match(nobody.stderr, /NO_IDENTITY/);
});

test("a modified package is rejected before decryption", () => {
  const root = join(tmp("psd-root-"), "pso");
  const bytes = readFileSync(pkg); bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const bad = join(work, "tampered.psopkg"); writeFileSync(bad, bytes);
  const r = run(boot, ["install", "--package", bad, "--root", root, "--trust", join(keys, "release.public.pem"), "--expect-signer", rel], { PSO_RECIPIENT_HOME: home2, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(r.status, 1); assert.match(r.stderr, /PSOPKG_SIGNATURE|PSOPKG_FORMAT/); assert.ok(!existsSync(join(root, "versions")));
});

test("authorized developers (DPAPI and passphrase identities) install; the same installer serves both", () => {
  for (const [home, who] of [[home1, "dpapi"], [home2, "passphrase"]]) {
    const root = join(tmp("psd-root-"), "pso");
    const r = run(boot, ["install", "--package", pkg, "--root", root, "--trust", join(keys, "release.public.pem"), "--expect-signer", rel, "--json"], { PSO_RECIPIENT_HOME: home, PSO_RECIPIENT_PASSPHRASE: PASS });
    assert.equal(r.status, 0, `${who}: ${r.stderr}${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).files, 3);
    assert.equal(readFileSync(join(root, "versions", "1.0.0", "app", "run.js"), "utf8"), "console.log('payload');\n");
    const ic = spawnSync(process.execPath, [pso, "integrity", "check", "--full", "--root", root], { encoding: "utf8" });
    assert.equal(ic.status, 0, ic.stdout + ic.stderr);
  }
});

test("repair uses the protected package and the developer's own identity (DPAPI opened lazily), never an unprotected source", () => {
  const root = join(tmp("psd-root-"), "pso");
  assert.equal(run(boot, ["install", "--package", pkg, "--root", root, "--trust", join(keys, "release.public.pem"), "--expect-signer", rel], { PSO_RECIPIENT_HOME: home1 }).status, 0);
  const cached = join(root, ".pso-install", "packages", "1.0.0.psopkg");
  assert.ok(!readFileSync(cached).includes("payload"), "the cached repair source is the encrypted package");
  writeFileSync(join(root, "versions", "1.0.0", "app", "run.js"), "tampered\n");
  const env = { ...process.env, PSO_RECIPIENT_HOME: home1 };
  assert.equal(spawnSync(process.execPath, [pso, "integrity", "check", "--full", "--root", root], { encoding: "utf8", env }).status, 1);
  const noKey = spawnSync(process.execPath, [pso, "repair", "--full", "--root", root], { encoding: "utf8", env: { ...process.env, PSO_RECIPIENT_HOME: join(work, "nobody") } });
  assert.notEqual(noKey.status, 0, "without the identity the encrypted package cannot be opened");
  const fix = spawnSync(process.execPath, [pso, "repair", "--full", "--root", root], { encoding: "utf8", env });
  assert.equal(fix.status, 0, fix.stdout + fix.stderr);
  assert.equal(readFileSync(join(root, "versions", "1.0.0", "app", "run.js"), "utf8"), "console.log('payload');\n");
});

test("an interrupted installation leaves no decrypted staging directory behind after the next run", () => {
  const root = join(tmp("psd-root-"), "pso");
  const stale = join(root, "versions", ".staging-0.9.0-2147483000"); // a pid that is not running
  mkdirSync(join(stale, "app"), { recursive: true }); writeFileSync(join(stale, "app", "plain.js"), "decrypted leftovers\n");
  const r = run(boot, ["install", "--package", pkg, "--root", root, "--trust", join(keys, "release.public.pem"), "--expect-signer", rel], { PSO_RECIPIENT_HOME: home2, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(stale), "stale staging removed");
  assert.deepEqual(readdirSync(join(root, "versions")).filter((n) => n.startsWith(".staging")), []);
});

test("recovery: a passphrase backup restores the identity into a new store (account change, new machine)", () => {
  const backup = join(work, "dev2.backup.json");
  assert.equal(run(recip, ["backup", "--out", backup], { PSO_RECIPIENT_HOME: home2, PSO_RECIPIENT_PASSPHRASE: PASS, PSO_RECIPIENT_BACKUP_PASSPHRASE: "another long passphrase!" }).status, 0);
  assert.ok(!readFileSync(backup, "utf8").includes("BEGIN PRIVATE KEY"));
  const fresh = join(work, "newmachine");
  const wrong = run(recip, ["restore", "--file", backup, "--store", "passphrase"], { PSO_RECIPIENT_HOME: fresh, PSO_RECIPIENT_BACKUP_PASSPHRASE: "wrong passphrase 123", PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /PASSPHRASE_WRONG/);
  const ok = run(recip, ["restore", "--file", backup, "--store", "passphrase"], { PSO_RECIPIENT_HOME: fresh, PSO_RECIPIENT_BACKUP_PASSPHRASE: "another long passphrase!", PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(ok.status, 0, ok.stderr);
  // pinned signers travel with the backup, so the restored identity can install the same release
  const root = join(tmp("psd-root-"), "pso");
  const r = run(boot, ["install", "--package", pkg, "--root", root, "--trust", join(keys, "release.public.pem")], { PSO_RECIPIENT_HOME: fresh, PSO_RECIPIENT_PASSPHRASE: PASS });
  assert.equal(r.status, 0, r.stderr);
});

test("recipient removal: a release encrypted without a developer cannot be opened by them, while their old copy of an earlier release is unaffected", () => {
  const cfg = join(work, "dist.config.json");
  const p2 = join(work, "demo-2.psopkg");
  const pem2 = join(work, "dev_two.public.pem");
  const p = spawnSync(process.execPath, [pso, "dist", "pack", "--config", cfg, "--stage", stage, "--sign-key", join(keys, "release.private.pem"), "--encrypt", "--recipient", pem2, "--out", p2], { encoding: "utf8", cwd: work });
  assert.equal(p.status, 0, p.stderr);
  const d1 = run(boot, ["install", "--package", p2, "--root", join(tmp("psd-root-"), "pso"), "--trust", join(keys, "release.public.pem"), "--expect-signer", rel], { PSO_RECIPIENT_HOME: home1 });
  assert.equal(d1.status, 1); assert.match(d1.stderr, /NOT_AUTHORIZED/);
  const still = run(boot, ["install", "--package", pkg, "--root", join(tmp("psd-root-"), "pso"), "--trust", join(keys, "release.public.pem"), "--expect-signer", rel], { PSO_RECIPIENT_HOME: home1 });
  assert.equal(still.status, 0, "removal cannot revoke an earlier release the developer already holds");
});

test("doctor reports the account and a working DPAPI round trip on Windows", { skip: process.platform !== "win32" }, () => {
  const r = run(recip, ["doctor", "--json"], { PSO_RECIPIENT_HOME: home1 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.match(j.dpapi, /works/); assert.equal(typeof j.elevated, "boolean");
});
