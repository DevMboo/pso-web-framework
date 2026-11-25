// Builds the portable Windows x64 ZIP of an unsigned developer alpha from the SAME validated components the installer carries: the signed .psopkg, the bootstrap and
// the bundled Node.js runtime. The package is verified and extracted by the bootstrap (every file checked before it is written), so the ZIP holds a complete, relocatable
// PSO installation (versions/, .pso-install/ with the signed inventory and authenticated package copy, runtime/, bin/pso.cmd). Nothing is published.
//
//   node scripts/psd/build-portable.mjs --label 0.1.0-alpha.2 --work <build work dir> --runtime <node.exe> --runtime-license <file> --release <release dir> --signing-key <ed25519 private pem>
// It then adds the ZIP to the release directory, rewrites RELEASE-NOTES.md and SHA256SUMS, and re-signs SHA256SUMS. Existing assets (the installer) are not modified.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const label = flag("label"), work = flag("work") && resolve(flag("work")), runtime = flag("runtime") && resolve(flag("runtime")), licenseFile = flag("runtime-license") && resolve(flag("runtime-license"));
const releaseDir = flag("release") && resolve(flag("release")), keyFile = flag("signing-key");
// production (Authenticode-signed release): --publisher "<certificate common name>" runs the release gate on the assembled folder before it is zipped
const publisher = flag("publisher");
if (!label || !work || !runtime || !licenseFile || !releaseDir || !keyFile || ![work, runtime, licenseFile, releaseDir, keyFile].every((p) => existsSync(p))) { console.error("usage: build-portable.mjs --label <v> --work <dir> --runtime <node.exe> --runtime-license <file> --release <dir> --signing-key <pem>"); process.exit(2); }
const sha = (b) => createHash("sha256").update(b).digest("hex");
const BS = String.fromCharCode(92);
const pkg = join(work, readdirSync(work).find((f) => f.endsWith(".psopkg")));
const top = `PSO-Web-${label}-win-x64-portable`, zipName = `${top}.zip`;
const tmp = mkdtempSync(join(tmpdir(), "psd-portable-"));
const root = join(tmp, top);
const fail = (m) => { console.error("FAILED: " + m); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } process.exit(1); };

// 1. verified install into the staging root (the bootstrap refuses anything not signed by the embedded key, then extracts with per-file verification)
let r = spawnSync(runtime, [join(work, "tools", "pso-bootstrap.mjs"), "install", "--package", pkg, "--root", root, "--trust", join(work, "release.public.pem"), "--dev-distribution", "--bundle-runtime", "--json"], { encoding: "utf8" });
if (r.status !== 0) fail(`bootstrap: ${r.stdout}${r.stderr}`);
copyFileSync(licenseFile, join(root, "runtime", "LICENSE-node.txt"));
// 2. portable specifics: a root-level launcher, the notice, and the mode recorded as portable
writeFileSync(join(root, "pso.cmd"), ["@echo off", `call "%~dp0bin${BS}pso.cmd" %*`, "exit /b %ERRORLEVEL%", ""].join("\r\n"));
const distFile = join(root, ".pso-install", "distribution.json");
const dist = JSON.parse(readFileSync(distFile, "utf8")); dist.mode = "portable-unsigned"; delete dist.installedAt;
writeFileSync(distFile, JSON.stringify(dist, null, 2));
writeFileSync(join(root, "README-PORTABLE.md"), readFileSync(join(repo, "scripts", "psd", "release-files", "PORTABLE-ALPHA.md"), "utf8").replaceAll("{{LABEL}}", label).replaceAll("{{ZIP}}", zipName).replaceAll("{{FINGERPRINT}}", dist.signer));
// 2b. production release gate: every executable of the portable installation verified (PSO-owned: the publisher; third-party: their own)
if (publisher) {
  const g = spawnSync(process.execPath, [join(repo, "scripts", "psd", "codesign.mjs"), "gate", "--dir", root, "--publisher", publisher], { encoding: "utf8" });
  if (g.status !== 0) fail(`Authenticode release gate: ${(g.stdout + g.stderr).trim()}`);
  console.log(g.stdout.trim());
}
// 3. ZIP with the bsdtar shipped in Windows 10/11 (standard zip entries with forward slashes)
const zipPath = join(releaseDir, zipName);
rmSync(zipPath, { force: true });
r = spawnSync(join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe"), ["-a", "-c", "-f", zipPath, "-C", tmp, top], { encoding: "utf8" });
if (r.status !== 0 || !existsSync(zipPath)) fail(`zip: ${r.stderr}`);
const zipBytes = readFileSync(zipPath);
// 4. release notes and checksums (the installer asset is untouched)
if (!publisher) writeFileSync(join(releaseDir, "RELEASE-NOTES.md"), readFileSync(join(repo, "scripts", "psd", "release-files", "RELEASE-NOTES-ALPHA.md"), "utf8").replaceAll("{{LABEL}}", label).replaceAll("{{ZIP}}", zipName).replaceAll("{{ZIP_SHA256}}", sha(zipBytes)).replaceAll("{{FINGERPRINT}}", dist.signer));
copyFileSync(join(root, "README-PORTABLE.md"), join(releaseDir, "PORTABLE.md"));
const m = JSON.parse(readFileSync(join(releaseDir, "release-manifest.json"), "utf8"));
m.portable = { file: zipName, bytes: zipBytes.length, sha256: sha(zipBytes), contents: "complete relocatable installation: bin/pso.cmd launcher, private Node.js runtime, versions/, .pso-install/ (signed inventory, authenticated package)", authenticode: "NOT SIGNED; node.exe inside is signed by the OpenJS Foundation, PSO files are not", note: "unsigned portable distribution: integrity is checked, publisher identity is NOT independently verified" };
writeFileSync(join(releaseDir, "release-manifest.json"), JSON.stringify(m, null, 2));
const files = readdirSync(releaseDir).filter((f) => statSync(join(releaseDir, f)).isFile() && !f.startsWith("SHA256SUMS")).sort();
writeFileSync(join(releaseDir, "SHA256SUMS"), files.map((f) => `${sha(readFileSync(join(releaseDir, f)))} *${f}`).join("\n") + "\n");
writeFileSync(join(releaseDir, "SHA256SUMS.sig"), sign(null, readFileSync(join(releaseDir, "SHA256SUMS")), createPrivateKey(readFileSync(keyFile, "utf8"))).toString("base64") + "\n");
try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
console.log(JSON.stringify({ zip: zipPath, bytes: zipBytes.length, sha256: sha(zipBytes), installerUntouched: m.installer.sha256 === sha(readFileSync(join(releaseDir, m.installer.file))), files: files.length }, null, 2));
