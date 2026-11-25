// Validation of an Authenticode-signed PSO release on an ISOLATED Windows 11 machine with Smart App Control ENABLED (a clean virtual machine
// made for this run, never a developer's or a consumer's computer):
//   signed checksums -> installer signature as Windows judges it -> silent installation (no acknowledgement flag: the publisher is
//   authenticated) -> every installed executable signed (PSO: the publisher; Node.js: OpenJS Foundation) -> pso --version, doctor,
//   integrity -> repair -> update to a newer signed package and rollback (when one is supplied) -> the signed uninstaller -> PATH and
//   uninstall entry restored. Throughout, the Code Integrity log must record no block of a PSO file.
//
// It never changes Smart App Control, never installs a certificate or a trusted root and never weakens a policy. It refuses to run when
// Smart App Control is not ON (that would not be a Smart App Control validation), when the machine already has a PSO installation, or
// without --isolated (the operator's statement that this is a disposable test machine).
//
//   node scripts/psd/validate/signed-sac.mjs --isolated --installer <PSO-Web-<v>-win-x64.exe> --release <dir with SHA256SUMS(.sig) and
//        release-signing-key.public.pem> --publisher "<certificate common name>" [--update-package <newer .psopkg>] [--evidence <dir>]
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gate, judgeExecutable } from "../codesign.mjs";
import { readAuthenticode } from "../tools/authenticode.ts";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const installer = flag("installer") && resolve(flag("installer")), releaseDir = flag("release") && resolve(flag("release")), publisher = flag("publisher");
const updatePkg = flag("update-package") && resolve(flag("update-package"));
if (!installer || !releaseDir || !publisher || !existsSync(installer)) { console.error("usage: signed-sac.mjs --isolated --installer <setup.exe> --release <dir> --publisher <CN> [--update-package <file.psopkg>] [--evidence <dir>]"); process.exit(2); }
const BS = String.fromCharCode(92);
const ps = (script) => spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 120_000, windowsHide: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 600) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 500)}`}`); };

// ---- preconditions (read only)
const build = Number(/\d+/.exec(spawnSync("reg", ["query", "HKLM" + BS + "SOFTWARE" + BS + "Microsoft" + BS + "Windows NT" + BS + "CurrentVersion", "/v", "CurrentBuildNumber"], { encoding: "utf8" }).stdout.split("REG_SZ")[1] ?? "0")?.[0] ?? 0);
const sacOut = spawnSync("reg", ["query", "HKLM" + BS + "SYSTEM" + BS + "CurrentControlSet" + BS + "Control" + BS + "CI" + BS + "Policy", "/v", "VerifiedAndReputablePolicyState"], { encoding: "utf8" }).stdout;
const sac = Number(/0x([0-9a-f]+)/i.exec(sacOut)?.[1] ? parseInt(/0x([0-9a-f]+)/i.exec(sacOut)[1], 16) : -1);
const SAC = { 0: "Off", 1: "On", 2: "Evaluation" }[sac] ?? "unknown";
const uninstallKeys = () => spawnSync("reg", ["query", "HKCU" + BS + "Software" + BS + "Microsoft" + BS + "Windows" + BS + "CurrentVersion" + BS + "Uninstall", "/s", "/f", "PSO Web", "/d"], { encoding: "utf8" }).stdout;
const blockers = [
  ...(!argv.includes("--isolated") ? ["--isolated is required: run this only on a disposable Windows 11 test machine"] : []),
  ...(process.platform !== "win32" || build < 22000 ? [`Windows 11 is required (build ${build})`] : []),
  ...(sac !== 1 ? [`Smart App Control is ${SAC}, not On: this would not be a Smart App Control validation (it is never changed by this script)`] : []),
  ...(/PSO Web/.test(uninstallKeys()) ? ["a PSO installation already exists on this machine: use a clean machine"] : []),
];
if (blockers.length) { for (const b of blockers) console.error(`BLOCKED: ${b}`); process.exit(3); }
console.log(`Windows build ${build}, Smart App Control ${SAC}`);

const started = new Date();
const work = mkdtempSync(join(tmpdir(), "pso-sac-v-"));
const app = join(work, "PSO Web");
const regPath = () => spawnSync("reg", ["query", "HKCU" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout.match(/Path\s+REG_\w+\s+(.*)/)?.[1]?.trimEnd() ?? null;
const pathBefore = regPath();
const sysDirs = () => (spawnSync("reg", ["query", "HKLM" + BS + "SYSTEM" + BS + "CurrentControlSet" + BS + "Control" + BS + "Session Manager" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout.match(/Path\s+REG_\w+\s+(.*)/)?.[1] ?? "").split(";").filter((p) => p && !existsSync(join(p.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m), "node.exe")));
const env = () => ({ ...process.env, PSO_NO_BROWSER: "1", PATH: [...sysDirs(), ...(regPath() ?? "").replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m).split(";").filter(Boolean)].join(";") });
const term = (...args) => { const r = spawnSync(process.env.ComSpec, ["/d", "/c", "pso", ...args], { encoding: "utf8", env: env(), cwd: work, timeout: 600_000 }); return { ...r, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
const state = () => JSON.parse(readFileSync(join(app, ".pso-install", "install.json"), "utf8"));
/** Code Integrity / Smart App Control decisions since the start that name a file of this test (3033, 3034 audit; 3076, 3077 block) */
const ciEvents = () => {
  const r = ps(`$ErrorActionPreference='SilentlyContinue'; Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-CodeIntegrity/Operational'; StartTime=[datetime]'${started.toISOString()}'; Id=3033,3034,3076,3077} | ForEach-Object { [pscustomobject]@{id=$_.Id; message=$_.Message} } | ConvertTo-Json -Compress`);
  const out = (r.stdout ?? "").trim(); if (!out) return [];
  const list = [].concat(JSON.parse(out));
  return list.filter((e) => [basename(installer), work, "PSO"].some((k) => String(e.message).toLowerCase().includes(k.toLowerCase())));
};

let installed = false;
try {
  // 1. release integrity: the signed checksums, then the installer's own Authenticode signature
  const sums = readFileSync(join(releaseDir, "SHA256SUMS"));
  const sigOk = verify(null, sums, createPublicKey(readFileSync(join(releaseDir, "release-signing-key.public.pem"))), Buffer.from(readFileSync(join(releaseDir, "SHA256SUMS.sig"), "utf8").trim(), "base64"));
  check("SHA256SUMS signature verifies (Ed25519 release key)", sigOk);
  check("the installer's SHA-256 is the one in SHA256SUMS", sums.toString("utf8").includes(`${sha(readFileSync(installer))} *${basename(installer)}`));
  const j = judgeExecutable(basename(installer), readAuthenticode(installer), publisher);
  check(`the installer is Authenticode-signed by "${publisher}", trusted by Windows and timestamped`, j.ok, j.reason);

  // 2. silent installation: a signed build needs no acknowledgement flag and no fingerprint
  const r1 = spawnSync(installer, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", `/DIR=${app}`, `/LOG=${join(work, "setup.log")}`], { encoding: "utf8", timeout: 600_000 });
  installed = /PSO Web/.test(uninstallKeys());
  check("Smart App Control lets the signed installer run and it installs (exit 0)", r1.status === 0 && existsSync(join(app, "bin", "pso.cmd")), `exit ${r1.status}${r1.error ? ` ${r1.error.message}` : ""}; ${existsSync(join(work, "setup.log")) ? readFileSync(join(work, "setup.log"), "utf8").slice(-800) : ""}`);
  check("the installation records the Authenticode anchor (no development mode)", !existsSync(join(app, ".pso-install", "distribution.json")));
  const g = gate([app], publisher);
  check(`every installed executable is signed (uninstaller by "${publisher}", runtime by its publisher)`, g.ok && g.pso >= 1, JSON.stringify(g.failures));

  // 3. the installed CLI
  let r = term("--version"); check("pso --version in a new terminal", r.status === 0 && r.stdout.trim() === state().current, r.out.slice(-300));
  r = term("doctor"); check("pso doctor", r.status === 0, r.out.slice(-300));
  r = term("integrity", "check", "--full"); check("integrity check --full", r.status === 0, r.out.slice(-300));

  // 4. repair
  const victim = join(app, "versions", state().current, "node_modules", "@pso", "cli", "package.json"), original = readFileSync(victim);
  writeFileSync(victim, "{}");
  check("damage is detected", term("integrity", "check", "--full").status !== 0);
  r = term("repair", "--full"); check("repair --full restores the damaged file", r.status === 0 && readFileSync(victim).equals(original), r.out.slice(-300));

  // 5. update and rollback (needs a newer package signed by the same release key)
  if (updatePkg) {
    const before = state().current;
    r = term("update", "install", "--package", updatePkg); check("update install to the newer signed package", r.status === 0 && state().current !== before && state().previous === before, r.out.slice(-300));
    r = term("update", "rollback"); check("update rollback returns to the previous version", r.status === 0 && state().current === before, r.out.slice(-300));
  } else check("update and rollback", true, "NOT RUN: no --update-package given");

  // 6. the signed uninstaller
  const unins = readdirSync(app).filter((f) => /^unins\d+\.exe$/i.test(f)).sort().pop();
  const ju = unins ? judgeExecutable(unins, readAuthenticode(join(app, unins)), publisher) : { ok: false, reason: "no uninstaller" };
  check(`the uninstaller is Authenticode-signed by "${publisher}"`, ju.ok, ju.reason);
  r = spawnSync(join(app, unins ?? "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { encoding: "utf8", timeout: 300_000 });
  const until = Date.now() + 120_000; while (Date.now() < until && (existsSync(join(app, "bin")) || /PSO Web/.test(uninstallKeys()) || regPath() !== pathBefore)) await new Promise((res) => setTimeout(res, 500));
  installed = /PSO Web/.test(uninstallKeys());
  check("Smart App Control lets the signed uninstaller run (exit 0)", r.status === 0, `exit ${r.status}`);
  check("installed versions, launchers and runtime are removed", !existsSync(join(app, "versions")) && !existsSync(join(app, "bin")) && !existsSync(join(app, "runtime")));
  check("the uninstall entry is removed", !installed);
  check("the user PATH is restored exactly", regPath() === pathBefore, `${regPath()} vs ${pathBefore}`);

  // 7. what Smart App Control decided during the whole run
  const ev = ciEvents();
  check("Code Integrity recorded no block or audit event for a PSO file", ev.length === 0, ev.map((e) => `${e.id}: ${String(e.message).slice(0, 200)}`).join(" | "));
} catch (e) { check("validation ran to completion", false, e.stack); }
finally {
  if (installed && existsSync(app)) { const u = readdirSync(app).filter((f) => /^unins\d+\.exe$/i.test(f)).sort().pop(); if (u) spawnSync(join(app, u), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]); }
  const outDir = flag("evidence");
  if (outDir) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, "signed-sac-validation.json"), JSON.stringify({ windowsBuild: build, smartAppControl: SAC, installer: { file: basename(installer), sha256: sha(readFileSync(installer)) }, publisher, update: updatePkg ? basename(updatePkg) : null, results, at: new Date().toISOString() }, null, 2)); }
  if (regPath() === pathBefore) try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed || !results.length ? 1 : 0;
}
