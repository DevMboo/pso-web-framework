// Validates the EXACT portable ZIP in an isolated temp folder with no Node.js on PATH. Nothing outside the temp folder is touched (no registry, no PATH, no global state).
//   node scripts/psd/validate/portable.mjs --zip <file.zip> --release <release dir> [--evidence <dir>]
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const zip = resolve(flag("zip") ?? ""), releaseDir = resolve(flag("release") ?? "");
if (!existsSync(zip) || !existsSync(releaseDir)) { console.error("--zip and --release are required"); process.exit(2); }
const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const BS = String.fromCharCode(92);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 500) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 400)}`}`); };
const work = mkdtempSync(join(tmpdir(), "psd-portable-v-"));
const sysDirs = () => { const s = spawnSync("reg", ["query", "HKLM" + BS + "SYSTEM" + BS + "CurrentControlSet" + BS + "Control" + BS + "Session Manager" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout.match(/Path\s+REG_\w+\s+(.*)/)?.[1] ?? ""; return s.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m).split(";").filter((p) => p && !existsSync(join(p, "node.exe"))); };
let ext;
const env = { ...process.env, PSO_RECIPIENT_HOME: join(work, "no-recipient") };
const term = (cwd, ...args) => spawnSync(process.env.ComSpec, ["/d", "/c", ...args], { encoding: "utf8", env: { ...env, PATH: [join(ext, "bin"), ...sysDirs()].join(";") }, cwd, timeout: 300_000 });
const state = () => JSON.parse(readFileSync(join(ext, ".pso-install", "install.json"), "utf8"));

try {
  // the asset is the one the signed checksums describe
  const sums = Object.fromEntries(readFileSync(join(releaseDir, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => [l.slice(66), l.slice(0, 64)]));
  const name = zip.split(BS).pop().split("/").pop();
  check("ZIP SHA-256 equals the entry in SHA256SUMS", sums[name] === sha(readFileSync(zip)), `${sums[name]} vs ${sha(readFileSync(zip))}`);
  check("SHA256SUMS signature verifies with the release key (integrity only)", verify(null, readFileSync(join(releaseDir, "SHA256SUMS")), createPublicKey(readFileSync(join(releaseDir, "release-signing-key.public.pem"))), Buffer.from(readFileSync(join(releaseDir, "SHA256SUMS.sig"), "utf8").trim(), "base64")));
  const tar = join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
  const entries = spawnSync(tar, ["-tf", zip], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.split(/\r?\n/).filter(Boolean);
  check("ZIP entry names are safe (relative, no .., no backslashes, one top folder)", entries.length > 100 && entries.every((e) => !e.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(e) && !e.includes(BS) && !/^[A-Za-z]:/.test(e)) && new Set(entries.map((e) => e.split("/")[0])).size === 1, `${entries.length} entries`);

  // extract to a path WITH SPACES in an isolated folder
  const base = join(work, "My Tools"); mkdirSync(base, { recursive: true });
  const x = spawnSync(tar, ["-xf", zip, "-C", base], { encoding: "utf8" });
  ext = join(base, readdirSync(base)[0]);
  check("extraction", x.status === 0 && existsSync(join(ext, "pso.cmd")), x.stderr);
  check("layout: pso.cmd, bin/pso.cmd, private runtime + licence, versions, .pso-install, README", ["pso.cmd", "bin/pso.cmd", "bin/pso-launch.mjs", "runtime/node.exe", "runtime/LICENSE-node.txt", ".pso-install/install.json", "README-PORTABLE.md"].every((p) => existsSync(join(ext, ...p.split("/")))));
  const signatureArgs = ["-NoProfile", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${join(ext, "runtime", "node.exe")}').Status`];
  let signatureCheck = spawnSync("pwsh", signatureArgs, { encoding: "utf8" });
  if (signatureCheck.error?.code === "ENOENT") signatureCheck = spawnSync("powershell", signatureArgs, { encoding: "utf8" });
  const sig = signatureCheck.stdout?.trim() ?? "";
  check("the bundled node.exe is Authenticode-valid (OpenJS Foundation)", signatureCheck.status === 0 && sig === "Valid", signatureCheck.stderr || sig);
  check("no Node.js on the test PATH", spawnSync(process.env.ComSpec, ["/d", "/c", "where", "node"], { env: { ...env, PATH: sysDirs().join(";") } }).status !== 0);

  let r = term(work, join(ext, "pso.cmd"), "--version");
  check("pso.cmd --version by full path, from another folder, no Node.js on PATH", r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout), `${r.stdout}${r.stderr}`);
  r = term(work, "pso", "--version");
  check("`pso --version` once the bin folder is on PATH", r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout), `${r.stdout}${r.stderr}`);
  r = term(work, "pso", "doctor"); check("pso doctor", r.status === 0, `exit ${r.status} ${r.stdout.slice(-300)}${r.stderr}`);
  const gitBash = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"].find((b) => existsSync(b));
  if (gitBash) {
    const gb = spawnSync(gitBash, ["-c", "pso --version"], { encoding: "utf8", env: { ...env, PATH: [join(ext, "bin"), ...sysDirs()].join(";"), MSYS2_PATH_TYPE: "inherit" }, cwd: work, timeout: 120_000 });
    check("`pso --version` in Git Bash (POSIX launcher bin/pso)", gb.status === 0 && /\d+\.\d+\.\d+/.test(gb.stdout), `${gb.stdout}${gb.stderr}`);
  }
  r = term(work, "pso", "integrity", "check", "--full", "--root", ext); check("integrity check --full passes on the extracted ZIP", r.status === 0, `${r.stdout.slice(-300)}${r.stderr}`);
  r = term(work, "pso", "--help"); check("pso --help lists commands", r.status === 0 && /dist|doctor|init/i.test(r.stdout), r.stdout.slice(0, 200));

  // tamper and repair
  const cur = state().current, victim = join(ext, "versions", cur, "node_modules", "@pso", "cli", "package.json"), original = readFileSync(victim);
  writeFileSync(victim, "{\"tampered\":true}");
  check("a modified file is detected", term(work, "pso", "integrity", "check", "--full", "--root", ext).status !== 0);
  r = term(work, "pso", "repair", "--full", "--root", ext);
  check("repair restores it from the authenticated package inside the ZIP", r.status === 0 && readFileSync(victim).equals(original), `${r.stdout.slice(-300)}${r.stderr}`);
  const inv = join(ext, ".pso-install", `inventory-${cur}.json`), invOrig = readFileSync(inv);
  const t = JSON.parse(invOrig.toString("utf8")); t.payloadSha256 = "0".repeat(64); writeFileSync(inv, JSON.stringify(t));
  check("a modified signed inventory is rejected", term(work, "pso", "integrity", "check", "--full", "--root", ext).status !== 0);
  writeFileSync(inv, invOrig);
  check("restoring the inventory returns to a healthy state", term(work, "pso", "integrity", "check", "--full", "--root", ext).status === 0);

  // relocation: the folder can be moved
  const moved = join(work, "Moved Elsewhere", "pso-moved"); mkdirSync(join(work, "Moved Elsewhere"), { recursive: true });
  renameSync(ext, moved); ext = moved;
  r = term(work, "pso", "--version"); check("the folder still works after being moved and renamed", r.status === 0, `${r.stdout}${r.stderr}`);
  r = term(work, "pso", "integrity", "check", "--full", "--root", ext); check("integrity check passes after the move", r.status === 0, `${r.stdout.slice(-300)}${r.stderr}`);

  // a package from another signer cannot update it
  const other = join(work, "other"); mkdirSync(other, { recursive: true });
  const pso = join(repo, "packages", "cli", "bin", "pso.js");
  spawnSync(process.execPath, [pso, "dist", "keygen", "--kind", "signing", "--out", other, "--name", "evil"], { encoding: "utf8" });
  const st = join(work, "evil-stage"); mkdirSync(join(st, "x"), { recursive: true }); writeFileSync(join(st, "x", "a.txt"), "x");
  const cfg = join(work, "evil.json"); writeFileSync(cfg, JSON.stringify({ name: "pso", version: "9.9.9", platform: "win32", arch: "x64", components: [{ name: "c", version: "9.9.9", include: [{ from: "evil-stage", to: "." }] }] }));
  spawnSync(process.execPath, [pso, "dist", "pack", "--config", cfg, "--stage", st, "--sign-key", join(other, "evil.private.pem"), "--out", join(work, "evil.psopkg")], { encoding: "utf8", cwd: work });
  r = term(work, "pso", "update", "install", "--package", join(work, "evil.psopkg"), "--root", ext);
  check("a package signed by another key is refused by pso update", r.status !== 0 && !existsSync(join(ext, "versions", "9.9.9")), `${r.stdout}${r.stderr}`);
  check("the ZIP holds no private key and no developer indicator files", !readdirSync(ext, { recursive: true }).some((f) => /\.private\.pem$|identity\.json$|\.enrollment\.json$/i.test(String(f))));
} catch (e) { check("validation ran to completion", false, e.stack); }
finally {
  const out = flag("evidence");
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "portable-validation.json"), JSON.stringify({ zip, sha256: sha(readFileSync(zip)), node: process.version, windows: spawnSync("cmd", ["/c", "ver"], { encoding: "utf8" }).stdout.trim(), at: new Date().toISOString(), results }, null, 2)); }
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed || !results.length ? 1 : 0;
}
