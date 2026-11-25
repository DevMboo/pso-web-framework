// The REAL Inno Setup installers on this machine (per user, no administrator rights), into a temporary folder:
//   clean installation of 0.1.x -> a workspace -> the 0.2.0 installer over it (upgrade) -> CLI registration on the user PATH (a new terminal
//   finds `pso`) -> 0.2.0 commands -> Studio -> integrity, repair -> rollback and forward -> the real uninstaller -> PATH restored exactly,
//   uninstall entry gone, installation folder emptied, workspace untouched.
// Changes made to the machine, all reverted by the uninstaller and verified: HKCU\Environment\Path (this installation's entry only) and the
// HKCU uninstall entry. The user's PATH value is saved before and compared after.
//   node scripts/psd/validate/installer-020.mjs --from <0.1.x setup.exe> --to-exe <0.2.0 setup.exe> --to <label> [--evidence <dir>]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const fromExe = resolve(flag("from") ?? ""), toExe = resolve(flag("to-exe") ?? ""), to = flag("to");
if (!existsSync(fromExe) || !existsSync(toExe) || !to) { console.error("--from, --to-exe and --to are required"); process.exit(2); }
const BS = String.fromCharCode(92);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 600) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 500)}`}`); };
const work = mkdtempSync(join(tmpdir(), "psd-inno-v-"));
const app = join(work, "PSO Web");
const regPath = () => spawnSync("reg", ["query", "HKCU" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout.match(/Path\s+REG_\w+\s+(.*)/)?.[1]?.trimEnd() ?? null;
const uninstallKeys = () => spawnSync("reg", ["query", "HKCU" + BS + "Software" + BS + "Microsoft" + BS + "Windows" + BS + "CurrentVersion" + BS + "Uninstall", "/s", "/f", "PSO Web", "/d"], { encoding: "utf8" }).stdout;
const sysDirs = () => { const s = spawnSync("reg", ["query", "HKLM" + BS + "SYSTEM" + BS + "CurrentControlSet" + BS + "Control" + BS + "Session Manager" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout.match(/Path\s+REG_\w+\s+(.*)/)?.[1] ?? ""; return s.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m).split(";").filter((p) => p && !existsSync(join(p, "node.exe"))); };
// a NEW terminal: PATH = machine PATH (without any node.exe) + the user's PATH as the registry holds it now
let nodeOnPath = true; // 0.1.x installers require Node.js on PATH; 0.2.0 bundles its private runtime and is run without it
// another `pso` earlier on this user's PATH (for example an npm-global link to a development checkout) would shadow the installation: such folders are
// left out of the test terminal and recorded in the evidence
const shadowing = new Set();
const newTerminalPath = () => [...(nodeOnPath ? [dirname(process.execPath)] : []), ...sysDirs(), ...(regPath() ?? "").replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m).split(";").filter((p) => {
  if (!p || existsSync(join(p, "node.exe"))) return false;
  if (p.toLowerCase() !== join(app, "bin").toLowerCase() && existsSync(join(p, "pso.cmd"))) { shadowing.add(p); return false; }
  return true;
})].join(";");
const env = () => ({ ...process.env, PSO_RECIPIENT_HOME: join(work, "no-recipient"), PSO_NO_BROWSER: "1", PATH: newTerminalPath() });
const term = (cwd, ...args) => { const r = spawnSync(process.env.ComSpec, ["/d", "/c", "pso", ...args], { encoding: "utf8", env: env(), cwd, timeout: 600_000 }); return { ...r, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
const setup = (exe, log, extra = []) => spawnSync(exe, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", `/DIR=${app}`, `/LOG=${join(work, log)}`, "/ACCEPTUNSIGNEDALPHA=1", ...extra], { encoding: "utf8", timeout: 600_000 });
const state = () => JSON.parse(readFileSync(join(app, ".pso-install", "install.json"), "utf8"));
const treeHash = (dir) => { const h = createHash("sha256"); for (const f of readdirSync(dir, { recursive: true }).map(String).sort()) { const p = join(dir, f); if (statSync(p).isFile()) h.update(f.split(BS).join("/")).update(readFileSync(p)); } return h.digest("hex"); };

const pathBefore = regPath();
writeFileSync(join(work, "user-path.before.txt"), pathBefore ?? "(no user PATH value)");
let installed = false;
try {
  check("no PSO uninstall entry before the test", !/PSO Web/.test(uninstallKeys()));
  // 1. clean installation of 0.1.x with the real installer
  let r = setup(fromExe, "setup-from.log", ["/TASKS=addpath"]); installed = true;
  check("0.1.x installer: clean silent per-user installation", r.status === 0 && existsSync(join(app, "bin", "pso.cmd")), `exit ${r.status} ${existsSync(join(work, "setup-from.log")) ? readFileSync(join(work, "setup-from.log"), "utf8").split("\n").slice(-6).join(" | ") : ""}`);
  check("CLI registration: this installation's bin folder is on the user PATH", (regPath() ?? "").toLowerCase().split(";").includes(join(app, "bin").toLowerCase()), regPath());
  check("the rest of the user PATH is unchanged", (regPath() ?? "").toLowerCase().startsWith((pathBefore ?? "").toLowerCase()));
  r = term(work, "--version"); const fromVersion = r.stdout.trim();
  check("a new terminal runs `pso` (0.1.x, Node.js on PATH as 0.1.x requires)", r.status === 0 && /0\.1\./.test(fromVersion), r.out);
  check("an uninstall entry is registered", /PSO Web/.test(uninstallKeys()));
  const projects = join(work, "Projects"); mkdirSync(projects, { recursive: true });
  r = term(projects, "create", "workspace", "keep-me"); const ws = join(projects, "keep-me");
  check("0.1.x creates a workspace outside the installation", r.status === 0 && existsSync(join(ws, "pso.workspace.json")), r.out);
  term(ws, "create", "orchestrator", "gateway");
  const wsBefore = treeHash(ws);

  // 2. the 0.2.0 installer over the 0.1.x installation (upgrade)
  nodeOnPath = false;
  r = setup(toExe, "setup-to.log", ["/TASKS=addpath"]);
  check(`0.2.0 installer upgrades the installation (-> ${to})`, r.status === 0 && state().current === to, `exit ${r.status} ${existsSync(join(work, "setup-to.log")) ? readFileSync(join(work, "setup-to.log"), "utf8").split("\n").slice(-6).join(" | ") : ""}`);
  check("the user PATH holds this installation once", (regPath() ?? "").toLowerCase().split(";").filter((p) => p === join(app, "bin").toLowerCase()).length === 1, regPath());
  check("no Node.js on the PATH of the new terminal from here on", spawnSync(process.env.ComSpec, ["/d", "/c", "where", "node"], { env: env() }).status !== 0);
  r = term(work, "--version"); check("a new terminal runs 0.2.0 with its private runtime", r.status === 0 && /0\.2\.0/.test(r.stdout), r.out);
  check("0.1.x is kept side by side for rollback", existsSync(join(app, "versions", state().previous ?? "-")));
  check("the workspace is untouched by the upgrade", treeHash(ws) === wsBefore);
  r = term(work, "integrity", "check", "--full"); check("integrity check --full after the upgrade", r.status === 0, r.out.slice(-300));
  r = term(work, "--help"); check("the 0.2.0 infrastructure, host and deploy commands are registered", ["infra:apply", "infra:identity", "host:check", "deploy:status", "workspace:migrate"].every((c) => r.stdout.includes(c)));
  r = term(ws, "workspace:migrate", "--apply", "--identity", "pso-dev"); check("workspace:migrate --apply on the 0.1.x workspace", r.status === 0 && existsSync(join(ws, "pso.infra.json")), r.out.slice(-300));
  r = term(ws, "infra:apply", "--yes"); check("infra:apply", r.status === 0, r.out.slice(-300));
  r = term(ws, "infra:status"); check("infra:status", r.status === 0, r.out.slice(-300));
  const wsMigrated = treeHash(ws);

  // 3. Studio
  const studio = spawn(process.env.ComSpec, ["/d", "/c", "pso", "studio", "--no-open", "--port", "17952"], { cwd: ws, env: env() });
  let out = ""; studio.stdout.on("data", (d) => { out += d; }); studio.stderr.on("data", (d) => { out += d; });
  const deadline = Date.now() + 60_000; while (!/http:\/\/127\.0\.0\.1:\d+\/\S+/.test(out) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 300));
  const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0];
  let ok = false;
  if (url) { const page = await fetch(url, { redirect: "manual" }); const cookie = page.headers.get("set-cookie")?.split(";")[0]; const ov = await fetch(new URL("/api/overview", url), { headers: cookie ? { cookie } : {} }).catch(() => null); ok = !!ov && ov.status === 200 && JSON.stringify(await ov.json()).includes("keep-me"); }
  check("Studio of the installed 0.2.0 starts and answers the workspace overview", ok, out.slice(0, 300));
  spawnSync("taskkill", ["/pid", String(studio.pid), "/t", "/f"]);

  // 4. integrity and repair (a file of the engine the CLI loads at start)
  const victim = join(app, "versions", to, "node_modules", "@pso", "infra", "package.json"), original = readFileSync(victim);
  writeFileSync(victim, "{}");
  check("damage is detected", term(work, "integrity", "check", "--full").status !== 0);
  r = term(work, "repair", "--full"); check("repair --full restores the damaged file", r.status === 0 && readFileSync(victim).equals(original), r.out.slice(-300));
  // 5. rollback and forward
  r = term(work, "update", "rollback"); nodeOnPath = true; check("update rollback to 0.1.x", r.status === 0 && term(work, "--version").stdout.trim() === fromVersion, r.out.slice(-300));
  nodeOnPath = false;
  r = term(work, "update", "rollback"); check("update rollback forward to 0.2.0", r.status === 0 && state().current === to, r.out.slice(-300));

  // 6. the real uninstaller
  const unins = readdirSync(app).filter((f) => /^unins\d+\.exe$/i.test(f)).sort().pop();
  r = spawnSync(join(app, unins ?? "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { encoding: "utf8", timeout: 300_000 });
  // the uninstaller copies itself to TEMP and returns at once; wait until it has finished
  const until = Date.now() + 120_000; while (Date.now() < until && (existsSync(join(app, "bin")) || /PSO Web/.test(uninstallKeys()) || regPath() !== pathBefore)) await new Promise((res) => setTimeout(res, 500));
  installed = /PSO Web/.test(uninstallKeys());
  check("the uninstaller ran", r.status === 0, `exit ${r.status}`);
  check("installed versions, launchers and runtime are removed", !existsSync(join(app, "versions")) && !existsSync(join(app, "bin")) && !existsSync(join(app, "runtime")), existsSync(app) ? readdirSync(app).join(", ") : "");
  check("the uninstall entry is removed", !installed);
  check("the user PATH is restored exactly to its value before the test", regPath() === pathBefore, `${regPath()}\nvs\n${pathBefore}`);
  check("the workspace survives the uninstall unchanged", treeHash(ws) === wsMigrated);
} catch (e) { check("validation ran to completion", false, e.stack); }
finally {
  if (installed && existsSync(app)) { const u = readdirSync(app).filter((f) => /^unins\d+\.exe$/i.test(f)).sort().pop(); if (u) spawnSync(join(app, u), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]); }
  const after = regPath();
  if (after !== pathBefore) console.log(`WARNING: the user PATH differs from its saved value; the saved value is in ${join(work, "user-path.before.txt")} (kept)`);
  const outDir = flag("evidence");
  if (outDir) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, "installer-validation.json"), JSON.stringify({ from: { file: fromExe.split(BS).pop(), sha256: sha(readFileSync(fromExe)) }, to: { file: toExe.split(BS).pop(), sha256: sha(readFileSync(toExe)), label: to }, authenticode: "not signed (no trusted code-signing certificate available)", otherPsoOnUserPath: [...shadowing], windows: spawnSync("cmd", ["/c", "ver"], { encoding: "utf8" }).stdout.trim(), at: new Date().toISOString(), results }, null, 2) + "\n"); }
  if (after === pathBefore) try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed || !results.length ? 1 : 0;
}
