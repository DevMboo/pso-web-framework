// Validates the REAL unsigned-alpha installer (silent paths) in an isolated directory: refusal without acknowledgement, install, PATH and `pso --version` from a
// "new terminal" that has NO Node.js on PATH, doctor, integrity, repair, upgrade over the same folder, update, uninstall, exact PATH restoration.
// It refuses to run if a PSO installation already exists for this installer's AppId (it would replace it).
//   node scripts/psd/validate/alpha-install.mjs --installer <exe> [--upgrade <exe of a newer build>] [--evidence <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const exe = resolve(flag("installer") ?? ""), upgrade = flag("upgrade") && resolve(flag("upgrade"));
if (!existsSync(exe)) { console.error("--installer <exe> is required"); process.exit(2); }
const BS = String.fromCharCode(92);
const APPKEY = ["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "{B2E1F6A3-7C34-4D0E-9A55-3C1D8A9F0001}_is1"].join(BS);
const reg = (...x) => spawnSync("reg", x, { encoding: "utf8" });
if (reg("query", APPKEY).status === 0) { console.error("a PSO installation with this AppId already exists; refusing to touch it"); process.exit(2); }

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 400)}`}`); return ok; };
const work = mkdtempSync(join(tmpdir(), "psd-alpha-"));
const store = join(work, "recipient"), dir = join(work, "PSO Install"), log = join(work, "setup.log");
const userPath = () => (reg("query", "HKCU" + BS + "Environment", "/v", "Path").stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/) ?? [])[1]?.trim();
const pathBefore = userPath();
writeFileSync(join(work, "user-path-backup.txt"), pathBefore ?? "(unset)");
const sysPath = (reg("query", "HKLM" + BS + "SYSTEM" + BS + "CurrentControlSet" + BS + "Control" + BS + "Session Manager" + BS + "Environment", "/v", "Path").stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/) ?? [])[1]?.trim() ?? "";
const expand = (s) => s.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m);
// what a NEW terminal would see, minus every directory that contains a Node.js
const newTerminalPath = () => [expand(userPath() ?? ""), expand(sysPath)].join(";").split(";").filter((p) => p && !existsSync(join(p, "node.exe"))).join(";");
const setup = (exePath, args) => spawnSync(exePath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${dir}`, `/LOG=${log}`, ...args], { encoding: "utf8", env: { ...process.env, PSO_RECIPIENT_HOME: store }, timeout: 600_000 });
const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const term = (...args) => spawnSync(process.env.ComSpec, ["/d", "/c", ...args], { encoding: "utf8", env: { ...process.env, PATH: newTerminalPath() }, cwd: work, timeout: 300_000 });

try {
  // 0. the executable starts (Windows App Control may refuse an unsigned file: reported, never bypassed)
  let r = setup(exe, []);
  if (r.error) { check("installer starts", false, `could not start: ${r.error.message} (Windows application control may have blocked this unsigned file; rebuild is a new file, no policy bypass was attempted)`); throw new Error("blocked"); }
  check("refused without the explicit unsigned-alpha acknowledgement", r.status !== 0 && /acknowledgement/i.test(logText()) && !existsSync(dir) && reg("query", APPKEY).status !== 0, `exit ${r.status}`);

  // 1. install
  r = setup(exe, ["/ACCEPTUNSIGNEDALPHA=1"]);
  check("silent install succeeds with no fingerprint and no Node.js requirement", r.status === 0 && existsSync(join(dir, "runtime", "node.exe")), `exit ${r.status} ${logText().slice(-600)}`);
  check("layout: bin, private runtime + licence, versions, launcher", ["bin/pso.cmd", "bin/pso-launch.mjs", "runtime/node.exe", "runtime/LICENSE-node.txt", ".pso-install/install.json", ".pso-install/distribution.json"].every((p) => existsSync(join(dir, ...p.split("/")))));
  const dist = existsSync(join(dir, ".pso-install", "distribution.json")) ? JSON.parse(readFileSync(join(dir, ".pso-install", "distribution.json"), "utf8")) : {};
  check("installation is labelled development-unsigned with the unverified publisher claim", dist.mode === "development-unsigned" && /NOT verified/.test(dist.publisherClaim ?? ""));
  check("user PATH gained exactly the install bin entry and nothing else changed", (userPath() ?? "") === `${pathBefore ? pathBefore + ";" : ""}${dir}${BS}bin` || (userPath() ?? "").split(";").filter(Boolean).join(";") === `${(pathBefore ?? "").split(";").filter(Boolean).join(";")}${pathBefore ? ";" : ""}${dir}${BS}bin`, userPath());

  // 2. a new terminal with no Node.js on PATH
  check("the simulated new terminal has no node on PATH", spawnSync(process.env.ComSpec, ["/d", "/c", "where", "node"], { env: { ...process.env, PATH: newTerminalPath() } }).status !== 0);
  r = term("pso", "--version");
  check("pso --version works from a new terminal without Node.js", r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout), `${r.stdout}${r.stderr}`);
  const version1 = r.stdout.trim();
  r = term("pso", "doctor");
  check("pso doctor runs", r.status === 0 || /node|runtime/i.test(r.stdout), `exit ${r.status} ${r.stdout.slice(-300)}${r.stderr}`);
  r = term("pso", "integrity", "check", "--full", "--root", dir);
  check("integrity check --full passes on the fresh install", r.status === 0, `${r.stdout.slice(-400)}${r.stderr}`);

  // 3. tamper + repair (the authenticated package is kept next to the installation)
  const current = JSON.parse(readFileSync(join(dir, ".pso-install", "install.json"), "utf8")).current;
  const victim = join(dir, "versions", current, "node_modules", "@pso", "cli", "package.json");
  const original = readFileSync(victim);
  writeFileSync(victim, "{\"tampered\":true}");
  r = term("pso", "integrity", "check", "--full", "--root", dir);
  check("tampering is detected", r.status !== 0, r.stdout.slice(-200));
  r = term("pso", "repair", "--full", "--root", dir);
  check("repair restores the file from the signed package", r.status === 0 && readFileSync(victim).equals(original), `${r.stdout.slice(-300)}${r.stderr}`);

  // 4. upgrade over the same folder with a newer installer (same signer => anchored by the installation, no downgrade of trust)
  if (upgrade) {
    r = setup(upgrade, ["/ACCEPTUNSIGNEDALPHA=1"]);
    const st = JSON.parse(readFileSync(join(dir, ".pso-install", "install.json"), "utf8"));
    check("upgrade by running a newer installer over the installation", r.status === 0 && st.current !== current && st.previous === current, `exit ${r.status} current=${st.current} previous=${st.previous} ${logText().slice(-400)}`);
    r = term("pso", "--version");
    check("pso --version reports the new version without any PATH change", r.status === 0 && r.stdout.trim() !== version1, `${version1} -> ${r.stdout.trim()}`);
    r = term("pso", "update", "rollback", "--root", dir);
    check("rollback to the previous version works", r.status === 0 && JSON.parse(readFileSync(join(dir, ".pso-install", "install.json"), "utf8")).current === current, `${r.stdout.slice(-300)}${r.stderr}`);
  } else check("upgrade", false, "no --upgrade installer supplied");

  // 5. uninstall (the registered uninstaller), exact PATH restoration, no leftovers
  const un = join(dir, "unins000.exe");
  check("an uninstaller is registered", existsSync(un) && reg("query", APPKEY).status === 0);
  r = spawnSync(un, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 20 && existsSync(un); i++) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
  const left = existsSync(dir) ? readdirSync(dir) : [];
  check("uninstall removes the installation", r.status === 0 && left.length === 0, `exit ${r.status} left: ${left.join(", ")}`);
  check("uninstall removes the registry entry", reg("query", APPKEY).status !== 0);
  const norm = (s) => (s ?? "").split(";").filter(Boolean).join(";");
  check("user PATH is restored exactly", norm(userPath()) === norm(pathBefore), `${userPath()} vs ${pathBefore}`);
} catch (e) {
  if (e.message !== "blocked") check("validation ran to completion", false, e.stack);
} finally {
  // never leave state behind, whatever happened
  const un = join(dir, "unins000.exe");
  if (existsSync(un)) spawnSync(un, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { timeout: 300_000 });
  if (reg("query", APPKEY).status === 0) reg("delete", APPKEY, "/f");
  if (pathBefore !== undefined && norm0(userPath()) !== norm0(pathBefore)) { reg("add", "HKCU" + BS + "Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", pathBefore, "/f"); console.log("NOTE: user PATH was restored from the backup in " + join(work, "user-path-backup.txt")); }
  const out = flag("evidence");
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "alpha-install.json"), JSON.stringify({ installer: exe, upgradeInstaller: upgrade ?? null, node: process.version, windows: spawnSync("cmd", ["/c", "ver"], { encoding: "utf8" }).stdout.trim(), at: new Date().toISOString(), results }, null, 2)); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed || results.length === 0 ? 1 : 0;
}
function norm0(s) { return (s ?? "").split(";").filter(Boolean).join(";"); }
