// Component-level validation of the unsigned alpha, for machines where Windows application control (Smart App Control) refuses to START the unsigned Inno installer.
// It runs the SAME bootstrap, the SAME package and the SAME Node.js runtime that the installer carries, exactly as the installer's [Code] invokes them, into an isolated
// temp directory: install, launcher from a "new terminal" with no Node.js on PATH, doctor, integrity, tamper + repair, upgrade, rollback, update refusal of another signer,
// complete uninstall run from the private runtime. It does NOT validate the Inno wrapper (wizard pages, PATH registry entry, registered uninstaller).
//   node scripts/psd/validate/alpha-components.mjs --work <build work dir> --runtime <node.exe> --upgrade-work <newer build work dir> [--evidence <dir>]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const w1 = resolve(flag("work") ?? ""), w2 = flag("upgrade-work") && resolve(flag("upgrade-work")), runtime = resolve(flag("runtime") ?? "");
const BS = String.fromCharCode(92);
const pkgOf = (w) => join(w, readdirSync(w).find((f) => f.endsWith(".psopkg")));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 500) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 400)}`}`); };
const work = mkdtempSync(join(tmpdir(), "psd-alpha-c-"));
const root = join(work, "PSO Install"), store = join(work, "recipient");
const env = { ...process.env, PSO_RECIPIENT_HOME: store };
const boot = (pkg, extra = []) => spawnSync(runtime, [join(w1, "tools", "pso-bootstrap.mjs"), "install", "--package", pkg, "--root", root, "--trust", join(w1, "release.public.pem"), "--dev-distribution", "--bundle-runtime", "--json", ...extra], { encoding: "utf8", env });
const sysPath = (spawnSync("reg", ["query", "HKLM" + BS + "SYSTEM" + BS + "CurrentControlSet" + BS + "Control" + BS + "Session Manager" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout.match(/Path\s+REG_\w+\s+(.*)/) ?? [])[1] ?? "";
const expand = (s) => s.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m);
const newTerminalPath = () => [join(root, "bin"), ...expand(sysPath).split(";")].filter((p) => p && !existsSync(join(p, "node.exe"))).join(";"); // no directory with a Node.js
const term = (...args) => spawnSync(process.env.ComSpec, ["/d", "/c", ...args], { encoding: "utf8", env: { ...env, PATH: newTerminalPath() }, cwd: work, timeout: 300_000 });
const state = () => JSON.parse(readFileSync(join(root, ".pso-install", "install.json"), "utf8"));

try {
  const manifest = JSON.parse(readFileSync(join(w1, "installer", readdirSync(join(w1, "installer")).find((f) => f.endsWith(".manifest.json"))), "utf8"));
  const recorded = flag("manifest") ? JSON.parse(readFileSync(resolve(flag("manifest")), "utf8")).installer?.bundledRuntime?.sha256 : undefined;
  check("the runtime used has the SHA-256 recorded in the release manifest for the bundled runtime", !!recorded && createHash("sha256").update(readFileSync(runtime)).digest("hex") === recorded && manifest.built === true, `recorded ${recorded}`);
  const sig = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${runtime}').Status`], { encoding: "utf8" }).stdout.trim();
  check("bundled Node.js carries a valid Authenticode signature (OpenJS Foundation)", sig === "Valid", sig);

  let r = boot(pkgOf(w1));
  check("install with the bundled runtime and no fingerprint", r.status === 0 && existsSync(join(root, "runtime", "node.exe")), `${r.stdout}${r.stderr}`);
  const j = r.status === 0 ? JSON.parse(r.stdout) : {};
  check("anchor is the development distribution, recorded in the installation", j.anchor === "development" && JSON.parse(readFileSync(join(root, ".pso-install", "distribution.json"), "utf8")).mode === "development-unsigned");
  const v1 = state().current;
  check("new terminal without Node.js on PATH", spawnSync(process.env.ComSpec, ["/d", "/c", "where", "node"], { env: { ...env, PATH: newTerminalPath() } }).status !== 0);
  r = term("pso", "--version");
  check("pso --version from a new terminal without Node.js", r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout), `${r.stdout}${r.stderr}`);
  r = term("pso", "doctor");
  check("pso doctor runs", r.status === 0, `exit ${r.status} ${r.stdout.slice(-300)}${r.stderr}`);
  r = term("pso", "integrity", "check", "--full", "--root", root);
  check("integrity check --full passes", r.status === 0, `${r.stdout.slice(-300)}${r.stderr}`);

  const victim = join(root, "versions", v1, "node_modules", "@pso", "cli", "package.json"), original = readFileSync(victim);
  writeFileSync(victim, "{\"tampered\":true}");
  check("tampering is detected", term("pso", "integrity", "check", "--full", "--root", root).status !== 0);
  r = term("pso", "repair", "--full", "--root", root);
  check("repair restores from the authenticated package", r.status === 0 && readFileSync(victim).equals(original), `${r.stdout.slice(-300)}${r.stderr}`);

  if (w2) {
    r = boot(pkgOf(w2));
    const s2 = state();
    check("upgrade: a newer package of the same signer installs next to the old one", r.status === 0 && s2.current !== v1 && s2.previous === v1, `${r.stdout}${r.stderr} ${JSON.stringify(s2)}`);
    r = term("pso", "update", "rollback", "--root", root);
    check("rollback to the previous version", r.status === 0 && state().current === v1, `${r.stdout.slice(-300)}${r.stderr}`);
    r = term("pso", "update", "install", "--package", pkgOf(w2), "--root", root, "--allow-downgrade");
    check("update install accepts the same signer's package", r.status === 0 || /already installed/i.test(r.stdout + r.stderr), `${r.stdout.slice(-300)}${r.stderr}`);
  }

  // a package signed by another key must be refused by update (the installation trusts exactly the first key)
  const other = join(work, "other-keys"); mkdirSync(other, { recursive: true });
  const pso = join(resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "packages", "cli", "bin", "pso.js");
  spawnSync(process.execPath, [pso, "dist", "keygen", "--kind", "signing", "--out", other, "--name", "evil"], { encoding: "utf8" });
  const evilStage = join(work, "evil-stage"); mkdirSync(join(evilStage, "x"), { recursive: true }); writeFileSync(join(evilStage, "x", "a.txt"), "x");
  const cfg = join(work, "evil.json"); writeFileSync(cfg, JSON.stringify({ name: "pso", version: "9.9.9", platform: "win32", arch: "x64", components: [{ name: "c", version: "9.9.9", include: [{ from: "evil-stage", to: "." }] }] }));
  spawnSync(process.execPath, [pso, "dist", "pack", "--config", cfg, "--stage", evilStage, "--sign-key", join(other, "evil.private.pem"), "--out", join(work, "evil.psopkg")], { encoding: "utf8", cwd: work });
  r = term("pso", "update", "install", "--package", join(work, "evil.psopkg"), "--root", root);
  check("a package signed by another key is refused by pso update", r.status !== 0 && !existsSync(join(root, "versions", "9.9.9")), `${r.stdout}${r.stderr}`);
  r = boot(join(work, "evil.psopkg"), []); // bootstrap against the installation, with the other key as embedded key
  const evilTrust = spawnSync(runtime, [join(w1, "tools", "pso-bootstrap.mjs"), "install", "--package", join(work, "evil.psopkg"), "--root", root, "--trust", join(other, "evil.public.pem"), "--dev-distribution", "--json"], { encoding: "utf8", env });
  check("a development installer with another key cannot replace the trusted installation", evilTrust.status === 1 && /SIGNER_NOT_TRUSTED/.test(evilTrust.stderr) && !existsSync(join(root, "versions", "9.9.9")), evilTrust.stderr);

  // the registered uninstaller runs the active CLI with the private runtime; Inno then removes bin and runtime (UninstallDelete)
  r = spawnSync(join(root, "runtime", "node.exe"), [join(root, "versions", state().current, "node_modules", "@pso", "cli", "bin", "pso.js"), "uninstall", "--complete", "--yes", "--root", root], { encoding: "utf8", env });
  const left = existsSync(root) ? readdirSync(root).sort() : [];
  check("complete uninstall run from the private runtime leaves only bin and runtime (removed by Inno UninstallDelete)", r.status === 0 && left.every((n) => ["bin", "runtime"].includes(n)), `exit ${r.status} left=${left.join(",")} ${r.stdout.slice(-200)}${r.stderr}`);
} catch (e) { check("validation ran to completion", false, e.stack); }
finally {
  writeFileSync(join(work, "done"), "");
  const out = flag("evidence");
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "alpha-components.json"), JSON.stringify({ scope: "bootstrap + package + bundled runtime, NOT the Inno wrapper", node: process.version, at: new Date().toISOString(), results }, null, 2)); }
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed || !results.length ? 1 : 0;
}
