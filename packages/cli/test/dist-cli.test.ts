import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pso, tmp } from "./helpers.ts";
import { findIscc } from "../src/commands-dist.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const json = async (cwd: string, ...a: string[]) => { const r = await pso(cwd, ...a, "--json"); return { code: r.code, out: r.out ? JSON.parse(r.out) : null, err: r.err }; };

test("pso dist: keys, allowlisted build, signed + encrypted pack, verify, inspect, extract, and every refusal", { timeout: 120_000 }, async () => {
  const base = tmp("pso-dist-"); dirs.push(base);
  const proj = join(base, "proj"), keys = join(base, "keys");
  mkdirSync(join(proj, "app", "bin"), { recursive: true });
  writeFileSync(join(proj, "app", "bin", "run.js"), "console.log('hello');\n");
  writeFileSync(join(proj, "app", "README.md"), "docs\n");
  writeFileSync(join(proj, "app", ".env"), "TOKEN=must-never-ship\n");           // secrets inside an allowlisted directory
  writeFileSync(join(proj, "app", "bin", "dev.pem"), "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n");
  writeFileSync(join(proj, "not-listed.txt"), "outside the allowlist\n");
  writeFileSync(join(proj, "dist.config.json"), JSON.stringify({ name: "demo", version: "1.0.0", platform: "win32", arch: "x64", components: [{ name: "cli", version: "1.0.0", include: [{ from: "app", to: "cli" }] }] }));

  // keys: created explicitly, private key never printed, never overwritten
  const sk = await json(proj, "dist", "keygen", "--kind", "signing", "--out", keys, "--name", "release");
  const rk = await json(proj, "dist", "keygen", "--kind", "recipient", "--out", keys, "--name", "customer");
  assert.equal(sk.code, 0); assert.equal(rk.code, 0);
  assert.ok(!(await pso(proj, "dist", "keygen", "--kind", "signing", "--out", keys, "--name", "release")).code === false, "an existing key is never overwritten");
  assert.ok(!JSON.stringify(sk.out).includes("BEGIN PRIVATE KEY"), "the private key is never printed");

  // build: only the allowlist, secrets excluded and reported
  const stage = join(base, "stage");
  const b = await json(proj, "dist", "build", "--out", stage);
  assert.equal(b.code, 0, b.err);
  assert.equal(b.out.files, 2);
  assert.deepEqual(b.out.excluded.sort(), ["cli/.env", "cli/bin/dev.pem"]);
  assert.ok(existsSync(join(stage, "cli", "bin", "run.js")) && !existsSync(join(stage, "cli", ".env")) && !existsSync(join(stage, "not-listed.txt")));
  assert.equal((await pso(proj, "dist", "build", "--out", stage)).code, 1, "a non-empty stage is refused so stale files cannot be packed");

  // pack: signing key and recipients are explicit
  const pkg = join(base, "demo.psopkg");
  assert.equal((await pso(proj, "dist", "pack", "--stage", stage, "--out", pkg)).code, 1, "no signing key, no package");
  assert.equal((await pso(proj, "dist", "pack", "--stage", stage, "--sign-key", join(keys, "release.private.pem"), "--encrypt", "--out", pkg)).code, 1, "--encrypt without a recipient");
  const p = await json(proj, "dist", "pack", "--stage", stage, "--sign-key", join(keys, "release.private.pem"), "--encrypt", "--recipient", join(keys, "customer.public.pem"), "--out", pkg);
  assert.equal(p.code, 0, p.err); assert.equal(p.out.encrypted, true);
  assert.ok(!readFileSync(pkg).includes("hello"), "the content is encrypted");

  // verify
  const trust = join(keys, "release.public.pem");
  assert.equal((await pso(proj, "dist", "verify", pkg)).code, 1, "no trusted key given");
  const v1 = await json(proj, "dist", "verify", pkg, "--trust", trust);
  assert.deepEqual([v1.code, v1.out.encrypted, v1.out.contentsVerified], [0, true, false], "header and signature only, and it says so");
  const v2 = await json(proj, "dist", "verify", pkg, "--trust", trust, "--key", join(keys, "customer.private.pem"));
  assert.deepEqual([v2.code, v2.out.contentsVerified, v2.out.files], [0, true, 2]);
  assert.equal((await pso(proj, "dist", "verify", pkg, "--trust", join(keys, "customer.public.pem"))).code, 1, "a recipient key is not a signer");
  const ins = await json(proj, "dist", "inspect", pkg, "--trust", trust);
  assert.deepEqual([ins.out.name, ins.out.version, ins.out.encrypted, ins.out.files.map((f: { path: string }) => f.path)], ["demo", "1.0.0", true, ["cli/README.md", "cli/bin/run.js"]]);

  // tampering
  const bad = join(base, "bad.psopkg");
  const bytes = readFileSync(pkg); bytes[bytes.length - 100] = bytes[bytes.length - 100]! ^ 0xff; writeFileSync(bad, bytes);
  const t = await pso(proj, "dist", "verify", bad, "--trust", trust);
  assert.equal(t.code, 1); assert.match(t.err, /PSOPKG_SIGNATURE/);

  // extract
  const out = join(base, "out");
  assert.equal((await pso(proj, "dist", "extract", pkg, "--to", out, "--trust", trust)).code, 1, "encrypted: a key is required");
  const ex = await json(proj, "dist", "extract", pkg, "--to", out, "--trust", trust, "--key", join(keys, "customer.private.pem"));
  assert.equal(ex.code, 0, ex.err);
  assert.equal(readFileSync(join(out, "cli", "bin", "run.js"), "utf8"), "console.log('hello');\n");
  assert.equal((await pso(proj, "dist", "extract", pkg, "--to", out, "--trust", trust, "--key", join(keys, "customer.private.pem"))).code, 1, "never overwrites without --overwrite");

  // unsupported subcommand / platform
  assert.equal((await pso(proj, "dist", "frobnicate")).code, 1);
  assert.equal((await pso(proj, "dist", "installer", "--platform", "linux")).code, 1);
});

test("pso dist installer --platform windows: script generated; compiled only with Inno Setup (BLOCKED otherwise); the result says it is unsigned", { timeout: 120_000 }, async () => {
  const base = tmp("pso-inst-"); dirs.push(base);
  const iscc = findIscc();
  // a tiny real package and stage
  const keys = join(base, "keys"), stage = join(base, "stage");
  assert.equal((await pso(base, "dist", "keygen", "--kind", "signing", "--out", keys, "--name", "release")).code, 0);
  mkdirSync(join(stage, "node_modules", "@pso", "cli", "bin"), { recursive: true }); mkdirSync(join(stage, "bin"), { recursive: true });
  writeFileSync(join(stage, "node_modules", "@pso", "cli", "bin", "pso.js"), "console.log('x')\n"); writeFileSync(join(stage, "bin", "pso.cmd"), "@echo off\r\n");
  writeFileSync(join(base, "dist.config.json"), JSON.stringify({ name: "pso", version: "9.9.9", platform: "win32", arch: "x64", components: [{ name: "cli", version: "9.9.9", include: [] }] }));
  const pkg = join(base, "pso.psopkg");
  const { packStage } = await import("../src/psopkg.ts");
  writeFileSync(pkg, packStage({ stageDir: stage, meta: { name: "pso", version: "9.9.9", platform: "win32", arch: "x64", components: [{ name: "cli", version: "9.9.9" }] }, signingKeyPem: readFileSync(join(keys, "release.private.pem"), "utf8") }));
  const trust = join(keys, "release.public.pem");
  const bootstrap = join(base, "pso-bootstrap.mjs");
  writeFileSync(bootstrap, "// stand-in for the small bootstrap\nconsole.log('bootstrap');\n");
  // the installer no longer accepts a staged CLI, a private key as the trust key, or several trust keys
  assert.equal((await pso(base, "dist", "installer", "--platform", "windows", "--package", pkg, "--bootstrap", bootstrap, "--stage", stage, "--trust", trust, "--out", join(base, "inst0"))).code, 1, "--stage is refused");
  writeFileSync(join(base, "private-as-trust.pem"), readFileSync(join(keys, "release.private.pem")));
  assert.equal((await pso(base, "dist", "installer", "--platform", "windows", "--package", pkg, "--bootstrap", bootstrap, "--trust", join(base, "private-as-trust.pem"), "--out", join(base, "inst0"))).code, 1, "a private key is never embedded");
  assert.equal((await pso(base, "dist", "installer", "--platform", "windows", "--package", pkg, "--bootstrap", bootstrap, "--trust", `${trust},${trust}`, "--out", join(base, "inst0"))).code, 1, "exactly one trust key");
  const r = await json(base, "dist", "installer", "--platform", "windows", "--package", pkg, "--bootstrap", bootstrap, "--trust", trust, "--out", join(base, "inst"));
  const script = readFileSync(join(base, "inst", "pso-setup.iss"), "utf8");
  assert.match(script, /PrivilegesRequired=lowest/); assert.ok(!/PrivilegesRequiredOverridesAllowed/.test(script), "no elevation prompt: the recipient key is protected for one Windows account");
  const sources = script.split(/\r?\n/).filter((l) => /^Source:/.test(l));
  assert.equal(sources.length, 3, `the installer carries the package, one public key and the bootstrap, nothing else: ${sources.join(" | ")}`);
  assert.ok(sources.some((l) => /\.psopkg"/.test(l) && /nocompression/.test(l)), "the already-compressed package is not compressed again");
  assert.ok(sources.some((l) => /release\.public\.pem"/.test(l)) && sources.some((l) => /pso-bootstrap\.mjs"/.test(l)));
  assert.ok(sources.every((l) => /dontcopy/.test(l) && /DestDir: "\{tmp\}"/.test(l)), "nothing is installed by Inno itself: everything is extracted on demand to the temporary folder");
  assert.match(script, /function PrepareToInstall\(/, "the installation runs before Inno installs anything, so a refusal leaves nothing behind and exits non-zero");
  assert.ok(!/CurStepChanged/.test(script), "no post-install step: a failure there was swallowed by Inno and left a half installation with exit code 0");
  assert.match(script, /RunOnceId: "PsoUninstallFallback"/, "the uninstaller has a fallback: the previous version's CLI uninstalls when the active one is damaged");
  assert.match(script, /Check: HasPreviousCli/, "the fallback only runs when there is a previous version with a CLI");
  assert.ok(!/recursesubdirs/.test(script) && !script.includes("{tmp}\\bootstrap"), "the staged CLI is not copied to a temporary folder");
  assert.match(script, /SignerFingerprintRaw = '[0-9a-f]{64}'/, "the installer knows its own signer fingerprint only to compare it with the one the person enters");
  assert.match(script, /CreateInputQueryPage/, "the person enters the independently obtained fingerprint (first-install trust bootstrap)");
  assert.ok(!/SignerFingerprintRaw\s*\+/.test(script) && !/CreateOutputMsgPage\([^)]*SignerFingerprint/.test(script), "the embedded fingerprint is never displayed as if it were the trust anchor");
  assert.match(script, /WizardSilent/, "silent installs are judged by /SIGNER=, a pin or the existing installation, never by the wizard page");
  assert.match(script, /unsigned/i); assert.ok(!/PRIVATE KEY/.test(script));
  assert.ok(!existsSync(join(base, "inst", "trust", "release.private.pem")) && existsSync(join(base, "inst", "trust", "release.public.pem")));
  if (iscc) {
    assert.equal(r.code, 0, r.err); assert.deepEqual([r.out.status, r.out.built, r.out.signed], ["BUILT", true, false]);
    const exe = readFileSync(r.out.installer);
    assert.equal(r.out.sha256, createHash("sha256").update(exe).digest("hex"));
    assert.ok(existsSync(r.out.installer + ".manifest.json") && /unsigned.exe$/.test(r.out.installer));
  } else { assert.equal(r.code, 2); assert.equal(r.out.status, "BLOCKED"); assert.equal(r.out.built, false); }
});

test("pso dist installer --sign-command: Inno Setup hands the uninstaller to the PSO sign command while compiling and refuses an unsigned result; the gate refuses unsigned executables", { timeout: 300_000, skip: !findIscc() && "Inno Setup is not installed" }, async () => {
  const base = tmp("pso-inst-sign-"); dirs.push(base);
  const keys = join(base, "keys"), stage = join(base, "stage");
  assert.equal((await pso(base, "dist", "keygen", "--kind", "signing", "--out", keys, "--name", "release")).code, 0);
  mkdirSync(join(stage, "node_modules", "@pso", "cli", "bin"), { recursive: true }); mkdirSync(join(stage, "bin"), { recursive: true });
  writeFileSync(join(stage, "node_modules", "@pso", "cli", "bin", "pso.js"), "console.log('x')\n"); writeFileSync(join(stage, "bin", "pso.cmd"), "@echo off\r\n");
  const pkg = join(base, "pso.psopkg");
  const { packStage } = await import("../src/psopkg.ts");
  writeFileSync(pkg, packStage({ stageDir: stage, meta: { name: "pso", version: "9.9.9", platform: "win32", arch: "x64", components: [{ name: "cli", version: "9.9.9" }] }, signingKeyPem: readFileSync(join(keys, "release.private.pem"), "utf8") }));
  const trust = join(keys, "release.public.pem"), bootstrap = join(base, "pso-bootstrap.mjs");
  writeFileSync(bootstrap, "console.log('bootstrap');\n");
  // a stand-in signer: records what Inno Setup asks it to sign and signs NOTHING (no certificate exists here)
  const calls = join(base, "calls.txt"), signer = join(base, "record-signer.mjs");
  writeFileSync(signer, `import { appendFileSync, readFileSync } from "node:fs";\nconst f = process.argv[2]; const b = readFileSync(f);\nappendFileSync(${JSON.stringify(calls)}, f + "|" + (b[0] === 0x4d && b[1] === 0x5a ? "PE" : "other") + "\\n");\n`);
  const cmd = `"${process.execPath}" "${signer}" $f`;
  const common = ["dist", "installer", "--platform", "windows", "--package", pkg, "--bootstrap", bootstrap, "--trust", trust];
  assert.equal((await pso(base, ...common, "--sign-command", cmd, "--out", join(base, "x1"))).code, 1, "a signed installer names the publisher it is signed for");
  assert.equal((await pso(base, ...common, "--sign-command", cmd, "--dev-distribution", "--out", join(base, "x2"))).code, 1, "a development distribution is never signed");
  assert.equal((await pso(base, ...common, "--sign-command", `"${process.execPath}" "${signer}"`, "--publisher", "PSO Games", "--out", join(base, "x3"))).code, 1, "the command must take $f");
  // with a sign command that signs nothing, Inno Setup itself refuses to build: it checks that the file it handed over came back signed
  const r = await pso(base, ...common, "--publisher", "PSO Games", "--sign-command", cmd, "--name", "signed-test", "--out", join(base, "inst"));
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /does not have a digital signature/, "an unsigned result never becomes an installer");
  assert.ok(!existsSync(join(base, "inst", "signed-test.exe")), "no installer was written");
  const script = readFileSync(join(base, "inst", "pso-setup.iss"), "utf8");
  assert.match(script, /^SignTool=psosign$/m); assert.match(script, /^SignedUninstaller=yes$/m);
  assert.match(script, /Authenticode-signed \(installer and uninstaller\) for the publisher "PSO Games"/);
  const seen = readFileSync(calls, "utf8").trim().split(/\r?\n/);
  assert.equal(seen.length, 1, "the build stopped at the first file");
  assert.match(seen[0]!, /uninst\.e32\.tmp\|PE$/, "the uninstaller is handed to the PSO sign command while compiling, before it is embedded in the installer");
  // the gate reads signatures itself and never trusts that a sign command ran: an unsigned PSO executable is refused
  const fake = join(base, "gate"); mkdirSync(fake);
  const pe = Buffer.alloc(512); pe.write("MZ", 0, "latin1"); pe.writeUInt32LE(0x40, 0x3c); pe.write("PE\0\0", 0x40, "latin1"); pe.writeUInt16LE(0x8664, 0x44);
  writeFileSync(join(fake, "PSO-Web-9.9.9-win-x64.exe"), pe);
  const gateRun = spawnSync(process.execPath, [join(import.meta.dirname, "..", "..", "..", "scripts", "psd", "codesign.mjs"), "gate", "--dir", fake, "--publisher", "PSO Games"], { encoding: "utf8" });
  assert.equal(gateRun.status, 1, gateRun.stdout + gateRun.stderr);
  assert.match(gateRun.stdout, /FAILED\s+Authenticode gate: 1 executable/); assert.match(gateRun.stdout, /REFUSED gate\/PSO-Web-9\.9\.9-win-x64\.exe/);
});

test("pso dist installer --signed-uninstaller-dir (remote signing): pass 1 names the uninstaller to sign, an unsigned one is never used, metadata is consistent", { timeout: 300_000, skip: !findIscc() && "Inno Setup is not installed" }, async () => {
  const base = tmp("pso-inst-sud-"); dirs.push(base);
  const keys = join(base, "keys"), stage = join(base, "stage");
  assert.equal((await pso(base, "dist", "keygen", "--kind", "signing", "--out", keys, "--name", "release")).code, 0);
  mkdirSync(join(stage, "node_modules", "@pso", "cli", "bin"), { recursive: true }); mkdirSync(join(stage, "bin"), { recursive: true });
  writeFileSync(join(stage, "node_modules", "@pso", "cli", "bin", "pso.js"), "console.log('x')\n"); writeFileSync(join(stage, "bin", "pso.cmd"), "@echo off\r\n");
  const pkg = join(base, "pso.psopkg");
  const { packStage } = await import("../src/psopkg.ts");
  writeFileSync(pkg, packStage({ stageDir: stage, meta: { name: "pso", version: "9.9.9-rc.1", platform: "win32", arch: "x64", components: [{ name: "cli", version: "9.9.9-rc.1" }] }, signingKeyPem: readFileSync(join(keys, "release.private.pem"), "utf8") }));
  const bootstrap = join(base, "pso-bootstrap.mjs"); writeFileSync(bootstrap, "console.log('bootstrap');\n");
  const sud = join(base, "signed-uninstaller");
  const common = ["dist", "installer", "--platform", "windows", "--package", pkg, "--bootstrap", bootstrap, "--trust", join(keys, "release.public.pem"), "--name", "remote-test"];
  assert.equal((await pso(base, ...common, "--signed-uninstaller-dir", sud, "--out", join(base, "y1"))).code, 1, "a signed installer names its publisher");
  assert.equal((await pso(base, ...common, "--signed-uninstaller-dir", sud, "--dev-distribution", "--out", join(base, "y2"))).code, 1, "never for a development distribution");
  assert.equal((await pso(base, ...common, "--signed-uninstaller-dir", sud, "--publisher", "SignPath Foundation", "--sign-command", "x $f", "--out", join(base, "y3"))).code, 1, "local or remote signing, not both");
  const pass = () => json(base, ...common, "--publisher", "SignPath Foundation", "--signed-uninstaller-dir", sud, "--app-publisher", "PSO Web Framework", "--out", join(base, "inst"));
  const r1 = await pass();
  assert.equal(r1.code, 2, JSON.stringify(r1)); assert.equal(r1.out.status, "NEEDS_SIGNED_UNINSTALLER");
  assert.equal(r1.out.toSign.length, 1); assert.match(r1.out.toSign[0], /uninst-[0-9.]+-[0-9a-f]+\.e32(\.tmp)?$/);
  assert.ok(existsSync(r1.out.toSign[0]) && !existsSync(join(base, "inst", "remote-test.exe")), "the file to sign exists; no installer was written");
  const script = readFileSync(join(base, "inst", "pso-setup.iss"), "utf8");
  assert.match(script, /^SignedUninstaller=yes$/m); assert.match(script, /^SignedUninstallerDir=/m); assert.doesNotMatch(script, /^SignTool=/m);
  for (const l of ["VersionInfoProductName=PSO Web Framework", "VersionInfoCopyright=Copyright 2026 DevMboo. Licensed under the Apache License 2.0", "VersionInfoProductVersion=9.9.9.0", "VersionInfoVersion=9.9.9.0", "VersionInfoProductTextVersion={#AppVer}", "VersionInfoCompany=PSO Web Framework", "AppPublisher=PSO Web Framework"]) assert.ok(script.split(/\r?\n/).includes(l), l);
  assert.match(script, /#define AppVer "9\.9\.9-rc\.1"/);
  // pass 2 with the file still UNSIGNED: Inno refuses again, an unsigned uninstaller never ships
  if (r1.out.toSign[0].endsWith(".tmp")) copyFileSync(r1.out.toSign[0], r1.out.toSign[0].replace(/\.tmp$/, ""));
  const r2 = await pass();
  assert.equal(r2.code, 2, JSON.stringify(r2)); assert.equal(r2.out.status, "NEEDS_SIGNED_UNINSTALLER"); assert.ok(!existsSync(join(base, "inst", "remote-test.exe")));
});
