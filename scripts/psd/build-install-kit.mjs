// Assembles the folder sent to an external developer: Install-PSO-Web.ps1 + README-INSTALL.txt + the installer (and the portable ZIP when present).
// The signed release directory is only READ; nothing is published and no asset is modified.
//
//   node scripts/psd/build-install-kit.mjs --release <release dir> --out <kit dir> [--bake-trust]
//
// --bake-trust writes the signing fingerprint and installer SHA-256 from release-manifest.json into the script. Use it ONLY when that script copy will reach the
// developer through a channel the maintainer authenticates (not next to the installer in an e-mail attachment): the fingerprint then stops being "independent".
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const release = flag("release") && resolve(flag("release")), out = flag("out") && resolve(flag("out"));
if (!release || !out || !existsSync(release)) { console.error("usage: build-install-kit.mjs --release <dir> --out <dir> [--bake-trust]"); process.exit(2); }
const exe = readdirSync(release).find((f) => /^PSO-Web-.+-win-x64\.exe$/.test(f));
if (!exe) { console.error("no PSO-Web-*-win-x64.exe in the release directory"); process.exit(2); }
const zip = readdirSync(release).find((f) => /^PSO-Web-.+-win-x64-portable\.zip$/.test(f));
const kit = join(out, "PSO-Web");
rmSync(kit, { recursive: true, force: true }); mkdirSync(kit, { recursive: true });
let ps1 = readFileSync(join(repo, "scripts", "psd", "release-files", "Install-PSO-Web.ps1"), "utf8");
if (a.includes("--bake-trust")) {
  const m = JSON.parse(readFileSync(join(release, "release-manifest.json"), "utf8"));
  const fp = m.signing?.fingerprintSha256, sha = m.installer?.sha256;
  if (!/^[0-9a-f]{64}$/.test(fp ?? "") || !/^[0-9a-f]{64}$/.test(sha ?? "")) { console.error("release-manifest.json has no usable fingerprint/sha256"); process.exit(2); }
  ps1 = ps1.replace("$PreconfiguredSignerFingerprint = ''", () => `$PreconfiguredSignerFingerprint = '${fp}'`).replace("$PreconfiguredInstallerSha256 = ''", () => `$PreconfiguredInstallerSha256 = '${sha}'`);
  console.log("NOTE: trust values were baked into the script; deliver THIS copy only through a channel the maintainer authenticates.");
}
writeFileSync(join(kit, "Install-PSO-Web.ps1"), ps1);
copyFileSync(join(repo, "scripts", "psd", "release-files", "README-INSTALL.txt"), join(kit, "README-INSTALL.txt"));
copyFileSync(join(release, exe), join(kit, exe));
if (zip) copyFileSync(join(release, zip), join(kit, zip));
console.log(JSON.stringify({ kit, files: readdirSync(kit), baked: a.includes("--bake-trust") }, null, 2));
