// Tests of Install-PSO-Web.ps1 in clean temp folders. Two kinds, labelled in the test names:
//   REAL   - the script runs as shipped (powershell.exe -File) against real files (including the real alpha.2 portable ZIP, the real pso.cmd and bundled Node.js).
//   MOCKED - the installer EXECUTABLE is replaced by an injected starter (a real unsigned installer cannot be started on a machine whose Smart App Control refuses it);
//            everything around it (argument building, trust handling, log translation, CLI verification) is the real code.
// No test touches the registry except the AddToPath test, which restores the user PATH exactly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SCRIPT = join(repo, "scripts", "psd", "release-files", "Install-PSO-Web.ps1");
const REL = join(repo, "release-out", "psd", "0.1.0-alpha.2");
const ZIP = join(REL, "PSO-Web-0.1.0-alpha.2-win-x64-portable.zip");
const BS = String.fromCharCode(92);
const POWERSHELL = [process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"].join(BS);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ } });
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const FP = "7ebced006968027b3ca9939c1e245637ce93ba8bb6261a125a0fd31f957dcc89"; // the release signing key of alpha.1/alpha.2 (public information)
const group = (h) => h.replace(/(.{4})/g, "$1 ").trim();
const q = (p) => `'${p.replaceAll("'", "''")}'`;
const ps = (file, args = [], env = {}) => spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-File", file, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000 });
const run = (args, env = {}, cwd) => spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-File", cwd && existsSync(join(cwd, "Install-PSO-Web.ps1")) ? join(cwd, "Install-PSO-Web.ps1") : SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000, cwd });
const out = (r) => `${r.stdout}\n${r.stderr}`;
const fake = (name, content = "not a real installer") => { const d = tmp("psd-kit-"); copyFileSync(SCRIPT, join(d, "Install-PSO-Web.ps1")); const f = join(d, name); writeFileSync(f, content); return { d, f, script: join(d, "Install-PSO-Web.ps1") }; };
const noNodeEnv = () => { const sys = process.env.SystemRoot + BS + "System32"; return { PATH: sys + ";" + process.env.SystemRoot, PSO_RECIPIENT_HOME: join(tmp("psd-norecip-"), "none") }; };

let portableOk;
before(() => { portableOk = existsSync(ZIP); });

test("script is pure ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI) and parses", () => {
  const buf = readFileSync(SCRIPT); assert.ok(buf.every((b) => b < 128), "non-ASCII byte found");
  const r = spawnSync(POWERSHELL, ["-NoProfile", "-Command", `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)},[ref]$null,[ref]$e);if($e){$e|%{$_.Message};exit 1}`], { encoding: "utf8" });
  assert.equal(r.status, 0, out(r));
  const text = readFileSync(SCRIPT, "utf8");
  assert.ok(!/Set-MpPreference|DisableRealtimeMonitoring|Add-MpPreference|Unblock-File|ExecutionPolicys+Bypass|Set-ExecutionPolicy|Stop-Service|SmartScreens*=/i.test(text), "no security bypass in the script");
});

test("REAL: missing installer stops with a clear message", () => {
  const d = tmp("psd-kit-"); copyFileSync(SCRIPT, join(d, "Install-PSO-Web.ps1"));
  const r = run(["-ExpectedSigner", FP], noNodeEnv(), d); const o = out(r);
  assert.equal(r.status, 1); assert.match(o, /No installer was found next to this script/);
});

test("REAL: more than one installer is ambiguous", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe"); writeFileSync(join(k.d, "PSO-Web-2.0.0-win-x64.exe"), "x");
  const r = run(["-ExpectedSigner", FP], noNodeEnv(), k.d); assert.equal(r.status, 1); assert.match(out(r), /More than one installer/);
});

test("REAL: no independent fingerprint: stops and does NOT start the installer", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe");
  const r = run([], noNodeEnv(), k.d); const o = out(r);
  assert.equal(r.status, 1); assert.match(o, /Cannot confirm who made this installer/); assert.match(o, /DIFFERENT channel/); assert.doesNotMatch(o, /Starting the official installer/);
});

test("REAL: malformed fingerprint is rejected", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe");
  for (const bad of ["1234", FP.slice(1), FP + "0", "zz".repeat(32)]) { const r = run(["-ExpectedSigner", bad], noNodeEnv(), k.d); assert.equal(r.status, 1, bad); assert.match(out(r), /exactly 64 hexadecimal/); assert.doesNotMatch(out(r), /Starting the official installer/); }
});

test("REAL: checksum mismatch stops before starting anything; a matching checksum proceeds to start", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe");
  const bad = run(["-ExpectedSigner", FP, "-ExpectedSha256", "0".repeat(64)], noNodeEnv(), k.d); const o = out(bad);
  assert.equal(bad.status, 1); assert.match(o, /does not match the checksum/); assert.doesNotMatch(o, /Starting the official installer/);
  const good = run(["-ExpectedSigner", group(FP).toUpperCase(), "-ExpectedSha256", sha(k.f)], noNodeEnv(), k.d); const g = out(good);
  assert.match(g, /matches the checksum you were given/); assert.match(g, /Starting the official installer/);
  assert.equal(good.status, 1, "the file is not a real program, so it cannot be started"); assert.match(g, /could not be started|refused to start/);
});

test("REAL: without an expected checksum the script warns and shows the value instead of pretending to verify", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe");
  const r = run(["-ExpectedSigner", FP], noNodeEnv(), k.d); assert.match(out(r), /No expected checksum was given/); assert.ok(out(r).includes(sha(k.f)));
});

test("REAL: version 0.1.0-alpha.1 on a machine without Node.js 24 and without a personal key: stops and explains both", () => {
  const k = fake("PSO-Web-0.1.0-alpha.1-win-x64.exe");
  const r = run(["-ExpectedSigner", FP], noNodeEnv(), k.d); const o = out(r);
  assert.equal(r.status, 1); assert.match(o, /Version:\s+0\.1\.0-alpha\.1/); assert.match(o, /Node\.js 24 or newer/); assert.match(o, /no personal PSO key/); assert.doesNotMatch(o, /Starting the official installer/);
  const forced = run(["-ExpectedSigner", FP, "-Force"], noNodeEnv(), k.d); assert.match(out(forced), /continuing because of -Force/); assert.match(out(forced), /Starting the official installer/);
});

test("REAL: version 0.1.0-alpha.1 with a working Node.js 24 on PATH is NOT reported as missing Node (only the missing personal key stops it)", () => {
  const k = fake("PSO-Web-0.1.0-alpha.1-win-x64.exe");
  const env = { ...noNodeEnv() }; env.PATH = env.PATH + ";" + process.execPath.split(BS).slice(0, -1).join(BS);
  const r = run(["-ExpectedSigner", FP], env, k.d); const o = out(r);
  assert.equal(r.status, 1); assert.doesNotMatch(o, /Node.js 24 or newer is required/); assert.match(o, /no personal PSO key/);
});

// ---------------------------------------------------------------------------------------------- MOCKED installer execution (real surrounding logic)
const harness = (body) => { const d = tmp("psd-h-"); const f = join(d, "h.ps1"); writeFileSync(f, body); return f; };
const dotsource = (params, body) => `$ErrorActionPreference='Stop'\n. ${q(SCRIPT)} ${params}\n${body}\n`;

test("MOCKED installer: success path passes /SIGNER (normalized), /LOG, /DIR; then the real CLI check confirms pso --version", { skip: !portableOk }, () => {
  // the 'installation' the mocked installer leaves behind is a real extracted portable layout, so bin\pso.cmd and the bundled runtime are real
  const base = tmp("psd-mock-"); const ex = spawnSync(join(process.env.SystemRoot, "System32", "tar.exe"), ["-xf", ZIP, "-C", base], { encoding: "utf8" }); assert.equal(ex.status, 0, ex.stderr);
  const root = join(base, readdirSync(base)[0]);
  const k = fake("PSO-Web-0.1.0-alpha.2-win-x64.exe");
  const argsFile = join(base, "args.json");
  const h = harness(dotsource(`-InstallerPath ${q(k.f)} -ExpectedSigner ${q(group(FP).toUpperCase())} -InstallDir ${q(root)} -Quiet`, `
$script:Starter = { param($p, $a) ($a | ConvertTo-Json -Compress) | Set-Content -LiteralPath ${q(argsFile)}; return 0 }
$rc = Invoke-PsoInstall
"RC=$rc"`));
  const r = ps(h, [], noNodeEnv()); const o = out(r);
  assert.equal(r.status, 0, o); assert.match(o, /RC=0/); assert.match(o, /pso --version: \d+\.\d+\.\d+/); assert.match(o, /Done\. Open a NEW terminal/);
  const a = [].concat(JSON.parse(readFileSync(argsFile, "utf8")));
  assert.ok(a.includes(`/SIGNER=${FP}`), "the fingerprint is passed to the supported /SIGNER= argument, normalized");
  assert.ok(a.some((x) => x.startsWith("/LOG=")) && a.some((x) => x.startsWith("/DIR=")) && a.includes("/VERYSILENT"));
  assert.ok(!a.some((x) => /ACCEPTUNSIGNEDALPHA|PINSIGNER/.test(x)), "the script never acknowledges the unsigned-alpha notice or pins on the user's behalf");
});

test("MOCKED installer: failure codes in the installer log are translated into plain advice", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe");
  const cases = [["SIGNER_MISMATCH", /does NOT match this installer/], ["NO_TRUST_ANCHOR", /no way to confirm/], ["SIGNER_NOT_TRUSTED", /does not trust/], ["PSOPKG_SIGNATURE", /damaged or was modified/], ["NO_IDENTITY", /no PSO key/], ["NOT_AUTHORIZED", /not prepared for your PSO key/]];
  for (const [code, re] of cases) {
    const h = harness(dotsource(`-InstallerPath ${q(k.f)} -ExpectedSigner ${q(FP)}`, `
$script:Starter = { param($p, $a) $l = ($a | Where-Object { $_ -like '/LOG=*' }) -replace '^/LOG="|"$',''; Set-Content -LiteralPath $l -Value 'PSO bootstrap failed: PSO was not installed. error: ${code}: details'; return 1 }
Invoke-PsoInstall`));
    const r = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", `try { & ${q(h)} } catch { Write-Output ('CAUGHT: ' + $_.Exception.Message); exit [int]$_.Exception.Data['PsoExitCode'] }`], { encoding: "utf8", env: { ...process.env, ...noNodeEnv() } });
    assert.equal(r.status, 1, `${code}: ${out(r)}`); assert.match(out(r), re, code); assert.ok(out(r).includes(code));
  }
});

test("MOCKED installer: cancelled or failed without a log, and a Windows application-control block, are reported honestly", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe");
  const wrap = (starter) => harness(dotsource(`-InstallerPath ${q(k.f)} -ExpectedSigner ${q(FP)}`, `
$script:Starter = ${starter}
try { Invoke-PsoInstall } catch { Write-Output ('CAUGHT: ' + $_.Exception.Message); exit [int]$_.Exception.Data['PsoExitCode'] }`));
  let r = ps(wrap("{ param($p,$a) return 2 }"), [], noNodeEnv());
  assert.equal(r.status, 1); assert.match(out(r), /ended with code 2/); assert.match(out(r), /Nothing new was left installed/);
  r = ps(wrap("{ param($p,$a) throw (New-Object System.ComponentModel.Win32Exception 1260) }"), [], noNodeEnv());
  assert.equal(r.status, 3, out(r)); assert.match(out(r), /refused to start the installer/); assert.match(out(r), /does not bypass that/); assert.match(out(r), /Do not turn security features off/);
  r = ps(wrap("{ param($p,$a) throw 'Uma politica de Controle de Aplicativo bloqueou este arquivo.' }"), [], noNodeEnv());
  assert.equal(r.status, 3, out(r));
  r = ps(wrap("{ param($p,$a) throw 'disk exploded' }"), [], noNodeEnv());
  assert.equal(r.status, 1); assert.match(out(r), /could not be started: disk exploded/);
});

test("MOCKED installer: an installer that exits 0 but installed nothing is NOT reported as success", () => {
  const k = fake("PSO-Web-1.0.0-win-x64.exe"); const nowhere = join(tmp("psd-none-"), "PSO");
  const h = harness(dotsource(`-InstallerPath ${q(k.f)} -ExpectedSigner ${q(FP)} -InstallDir ${q(nowhere)}`, `
$script:Starter = { param($p,$a) return 0 }
try { Invoke-PsoInstall } catch { Write-Output ('CAUGHT: ' + $_.Exception.Message); exit [int]$_.Exception.Data['PsoExitCode'] }`));
  const r = ps(h, [], noNodeEnv()); assert.equal(r.status, 1, out(r)); assert.match(out(r), /could not be confirmed/);
});

// ---------------------------------------------------------------------------------------------- REAL portable ZIP
const zipSha = () => sha(ZIP);
const noNode = () => ({ ...noNodeEnv() });
const portable = (target, extra = [], env = noNode()) => run(["-PortableZip", ZIP, "-PortableDir", target, ...extra], env, tmp("psd-cwd-"));

test("REAL portable: correct checksum + fingerprint extracts into a folder with spaces, pso.cmd --version and integrity work with no Node.js on PATH", { skip: !portableOk }, () => {
  const target = join(tmp("psd-p-"), "My PSO Tools");
  const r = portable(target, ["-ExpectedSha256", zipSha(), "-ExpectedSigner", group(FP)]); const o = out(r);
  assert.equal(r.status, 0, o); assert.match(o, /signing key inside the ZIP matches/); assert.match(o, /pso --version: \d+\.\d+\.\d+/); assert.match(o, /integrity check passed/);
  const root = join(target, readdirSync(target)[0]);
  const v = spawnSync(process.env.ComSpec, ["/d", "/c", join(root, "pso.cmd"), "--version"], { encoding: "utf8", env: { ...process.env, ...noNodeEnv() } });
  assert.equal(v.status, 0, v.stdout + v.stderr); assert.match(v.stdout, /\d+\.\d+\.\d+/);
  assert.deepEqual(readdirSync(target).filter((n) => n.startsWith(".pso-extract")), [], "no staging left behind");
});

test("REAL portable: PATH is not modified unless -AddToPath is given (and then exactly one user entry, restored afterwards)", { skip: !portableOk }, () => {
  const reg = (...x) => spawnSync("reg", ["query", "HKCU" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout;
  const before = reg(); const rawBefore = (before.match(/Path\s+REG_(\w+)\s+(.*)/) ?? []);
  try {
    const t1 = join(tmp("psd-p-"), "a");
    assert.equal(portable(t1, ["-ExpectedSha256", zipSha()]).status, 0);
    assert.equal(reg(), before, "PATH untouched without -AddToPath");
    const t2 = join(tmp("psd-p-"), "b");
    const r = portable(t2, ["-ExpectedSha256", zipSha(), "-AddToPath"]); assert.equal(r.status, 0, out(r));
    const bin = join(t2, readdirSync(t2)[0], "bin");
    assert.ok(reg().includes(bin), "bin entry added");
    assert.equal(reg().split(bin).length - 1, 1, "added once");
  } finally {
    if (rawBefore[2] !== undefined) spawnSync("reg", ["add", "HKCU" + BS + "Environment", "/v", "Path", "/t", `REG_${rawBefore[1]}`, "/d", rawBefore[2].trim(), "/f"], { encoding: "utf8" });
    assert.equal(reg().replace(/\s+/g, ""), before.replace(/\s+/g, ""), "user PATH restored exactly");
  }
});

test("REAL portable: wrong fingerprint, wrong checksum, no anchor, existing folder and unsafe ZIP are all refused without leaving anything", { skip: !portableOk }, () => {
  const parent = tmp("psd-p-"); const target = join(parent, "t");
  let r = portable(target, ["-ExpectedSha256", zipSha(), "-ExpectedSigner", "ab".repeat(32)]);
  assert.equal(r.status, 1); assert.match(out(r), /is not the fingerprint you gave/); assert.deepEqual(existsSync(target) ? readdirSync(target) : [], [], "wrong fingerprint: nothing kept");
  r = portable(target, ["-ExpectedSha256", "0".repeat(64)]); assert.equal(r.status, 1); assert.match(out(r), /does not match the checksum/); assert.deepEqual(existsSync(target) ? readdirSync(target) : [], []);
  r = portable(target); assert.equal(r.status, 1); assert.match(out(r), /Cannot confirm where this ZIP comes from/); assert.deepEqual(existsSync(target) ? readdirSync(target) : [], []);
  assert.equal(portable(target, ["-ExpectedSha256", zipSha()]).status, 0);
  r = portable(target, ["-ExpectedSha256", zipSha()]); assert.equal(r.status, 1); assert.match(out(r), /already exists/); assert.match(out(r), /Nothing was overwritten/);
  assert.deepEqual(readdirSync(target).filter((n) => n.startsWith(".pso-extract")), []);
  // a ZIP that tries to escape the target folder (zip slip) is refused even with a matching checksum
  const evil = join(tmp("psd-evil-"), "evil.zip");
  const mk = spawnSync(POWERSHELL, ["-NoProfile", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open(${q(evil)},'Create'); $e=$z.CreateEntry('pkg/ok.txt'); $e2=$z.CreateEntry('../escaped.txt'); $w=New-Object IO.StreamWriter($e2.Open()); $w.Write('x'); $w.Close(); $z.Dispose()`], { encoding: "utf8" });
  assert.equal(mk.status, 0, out(mk));
  const t2 = join(parent, "z");
  r = run(["-PortableZip", evil, "-PortableDir", t2, "-ExpectedSha256", sha(evil)], noNode(), parent);
  assert.equal(r.status, 1); assert.match(out(r), /unsafe path/); assert.ok(!existsSync(join(t2, "..", "escaped.txt")) && !existsSync(join(parent, "escaped.txt")), "nothing escaped");
  assert.deepEqual(existsSync(t2) ? readdirSync(t2) : [], []);
});

test("REAL portable: a modified ZIP is refused by its checksum", { skip: !portableOk }, () => {
  const d = tmp("psd-mod-"); const bad = join(d, "PSO-Web-0.1.0-alpha.2-win-x64-portable.zip"); const b = readFileSync(ZIP); b[Math.floor(b.length / 2)] ^= 0xff; writeFileSync(bad, b);
  const target = join(d, "t"); const r = run(["-PortableZip", bad, "-PortableDir", target, "-ExpectedSha256", zipSha()], noNode(), d);
  assert.equal(r.status, 1); assert.match(out(r), /does not match the checksum/); assert.deepEqual(existsSync(target) ? readdirSync(target) : [], []);
});
