// Upgrade 0.1.x -> 0.2.0 on the EXACT portable distribution, in an isolated temp folder with no Node.js on PATH (no registry, no PATH, no
// global state changed): a 0.1.0-alpha.2 portable creates a workspace; the 0.2.0 signed package is installed with `pso update install`;
// the workspace is untouched; the 0.2.0 commands (workspace:migrate, infra:*, host/deploy commands) work; Studio starts and answers;
// integrity, repair, rollback to 0.1.0-alpha.2 and forward again; standard uninstall; the workspace survives everything.
//   node scripts/psd/validate/upgrade-020.mjs --from-zip <0.1.x portable.zip> --package <0.2.0 .psopkg> --to <label> [--evidence <dir>]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const fromZip = resolve(flag("from-zip") ?? ""), pkg = resolve(flag("package") ?? ""), to = flag("to");
if (!existsSync(fromZip) || !existsSync(pkg) || !to) { console.error("--from-zip, --package and --to are required"); process.exit(2); }
const BS = String.fromCharCode(92);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 600) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${String(detail).slice(0, 500)}`}`); };
const work = mkdtempSync(join(tmpdir(), "psd-upgrade-v-"));
const sysDirs = () => { const s = spawnSync("reg", ["query", "HKLM" + BS + "SYSTEM" + BS + "CurrentControlSet" + BS + "Control" + BS + "Session Manager" + BS + "Environment", "/v", "Path"], { encoding: "utf8" }).stdout.match(/Path\s+REG_\w+\s+(.*)/)?.[1] ?? ""; return s.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m).split(";").filter((p) => p && !existsSync(join(p, "node.exe"))); };
let ext;
const env = () => ({ ...process.env, PSO_RECIPIENT_HOME: join(work, "no-recipient"), PSO_NO_BROWSER: "1", PATH: [join(ext, "bin"), ...sysDirs()].join(";") });
const term = (cwd, ...args) => { const r = spawnSync(process.env.ComSpec, ["/d", "/c", "pso", ...args], { encoding: "utf8", env: env(), cwd, timeout: 600_000 }); return { ...r, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
const state = () => JSON.parse(readFileSync(join(ext, ".pso-install", "install.json"), "utf8"));
const treeHash = (dir) => { const h = createHash("sha256"); for (const f of readdirSync(dir, { recursive: true }).map(String).sort()) { const p = join(dir, f); if (statSync(p).isFile()) h.update(f.split(BS).join("/")).update(readFileSync(p)); } return h.digest("hex"); };

try {
  const tar = join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
  const base = join(work, "Program Files Like"); mkdirSync(base, { recursive: true });
  check("extract the 0.1.x portable ZIP", spawnSync(tar, ["-xf", fromZip, "-C", base]).status === 0);
  ext = join(base, readdirSync(base)[0]);
  check("no Node.js on the test PATH", spawnSync(process.env.ComSpec, ["/d", "/c", "where", "node"], { env: { ...process.env, PATH: sysDirs().join(";") } }).status !== 0);
  let r = term(work, "--version"); const fromVersion = r.stdout.trim();
  // the starting release is the one the ZIP names (PSO-Web-<label>-win-x64-portable.zip): 0.1.x or an earlier 0.2.0 candidate. Its CLI
  // reports the version without the release label (0.2.0-rc.6 reports 0.2.0)
  const zipLabel = /^PSO-Web-(.+)-win-x64-portable\.zip$/.exec(basename(fromZip))?.[1];
  const fromLabel = state().current;
  check(`the starting release ${zipLabel ?? "(unknown: the ZIP name does not carry it)"} is installed and runs`, r.status === 0 && !!zipLabel && fromLabel === zipLabel && fromVersion === zipLabel.replace(/-.*$/, ""), `${r.out} | installed ${fromLabel}`);

  // a user workspace created by 0.1.x, outside the installation
  const projects = join(work, "My Projects"); mkdirSync(projects, { recursive: true });
  r = term(projects, "create", "workspace", "legacy-app"); const ws = join(projects, "legacy-app");
  check("0.1.x creates a workspace", r.status === 0 && existsSync(join(ws, "pso.workspace.json")), r.out);
  r = term(ws, "create", "orchestrator", "gateway"); check("0.1.x adds an orchestrator", r.status === 0, r.out);
  r = term(ws, "create", "service", "orders"); check("0.1.x adds a service", r.status === 0, r.out);
  const wsBefore = treeHash(ws);

  // upgrade with the signed 0.2.0 package, verified by the installed 0.1.x
  r = term(work, "update", "install", "--package", pkg, "--root", ext);
  check(`pso update install --package (0.1.x -> ${to})`, r.status === 0 && state().current === to, r.out);
  r = term(work, "--version"); check("the CLI reports 0.2.0 after the upgrade", r.status === 0 && /0\.2\.0/.test(r.stdout), r.out);
  check("the previous version is kept side by side", existsSync(join(ext, "versions", fromLabel)) && existsSync(join(ext, "versions", to)));
  r = term(work, "integrity", "check", "--full", "--root", ext); check("integrity check --full on the upgraded installation", r.status === 0, r.out.slice(-400));
  check("the user workspace is untouched by the upgrade", treeHash(ws) === wsBefore);
  r = term(work, "--help");
  const missing = ["infra:init", "infra:plan", "infra:apply", "infra:identity", "host:inspect", "host:check", "deploy:status", "deploy:logs", "deploy:unlock", "workspace:migrate"].filter((c) => !r.stdout.includes(c));
  check("the 0.2.0 commands are registered (infra, identity, host, deploy, migrate)", r.status === 0 && !missing.length, `missing: ${missing.join(", ")}`);

  // migrate the 0.1.x workspace: inspection first, then apply
  r = term(ws, "workspace:migrate"); check("workspace:migrate inspection changes nothing", r.status === 0 && treeHash(ws) === wsBefore, r.out.slice(-500));
  r = term(ws, "workspace:migrate", "--apply", "--identity", "pso-dev"); check("workspace:migrate --apply writes the infrastructure contract", r.status === 0 && existsSync(join(ws, "pso.infra.json")), r.out.slice(-500));
  r = term(ws, "workspace:migrate"); check("a second migration has nothing to do", r.status === 0 && /Nothing to migrate/i.test(r.out), r.out.slice(-300));
  // infrastructure commands of the installed distribution (no container needs to run)
  r = term(ws, "infra:plan"); check("infra:plan", r.status === 0, r.out.slice(-400));
  r = term(ws, "infra:apply", "--yes"); check("infra:apply (certificates, secrets, generated configuration under .infra)", r.status === 0 && existsSync(join(ws, ".infra")), r.out.slice(-400));
  r = term(ws, "infra:status"); check("infra:status", r.status === 0, r.out.slice(-400));
  r = term(ws, "infra:validate"); check("infra:validate", r.status === 0, r.out.slice(-400));
  r = term(ws, "infra:plan"); check("a second plan is empty (idempotent)", r.status === 0 && !/\bcreate\b|\bupdate\b/.test(r.out.replace(/no changes|up to date/gi, "")) , r.out.slice(-400));
  r = term(ws, "validate"); check("pso validate on the migrated workspace", r.status === 0, r.out.slice(-400));

  // Studio from the installed distribution
  const studio = spawn(process.env.ComSpec, ["/d", "/c", "pso", "studio", "--no-open", "--port", "17951"], { cwd: ws, env: env() });
  let out = ""; studio.stdout.on("data", (d) => { out += d; }); studio.stderr.on("data", (d) => { out += d; });
  const deadline = Date.now() + 60_000; while (!/http:\/\/127\.0\.0\.1:\d+\/\S+/.test(out) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 300));
  const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0];
  let studioOk = false, overviewOk = false;
  if (url) {
    const page = await fetch(url, { redirect: "manual" }); const cookie = page.headers.get("set-cookie")?.split(";")[0];
    studioOk = page.status === 200 || page.status === 302 || page.status === 303;
    const ov = await fetch(new URL("/api/overview", url), { headers: cookie ? { cookie } : {} }).catch(() => null);
    overviewOk = !!ov && ov.status === 200 && JSON.stringify(await ov.json()).includes("legacy-app");
  }
  check("Studio starts from the installed distribution (loopback, one-time token)", !!url && studioOk, out.slice(0, 400));
  check("Studio answers the workspace overview", overviewOk, out.slice(0, 300));
  spawnSync("taskkill", ["/pid", String(studio.pid), "/t", "/f"]);

  // integrity, repair, rollback and forward again
  const cur = state().current, victim = join(ext, "versions", cur, "node_modules", "@pso", "infra", "package.json"), original = readFileSync(victim);
  writeFileSync(victim, "{\"tampered\":true}");
  check("damage to a 0.2.0 file (@pso/infra) is detected", term(work, "integrity", "check", "--full", "--root", ext).status !== 0);
  r = term(work, "repair", "--full", "--root", ext); check("repair --full restores it", r.status === 0 && readFileSync(victim).equals(original), r.out.slice(-400));
  r = term(work, "update", "rollback", "--root", ext); check(`update rollback returns to ${fromLabel}`, r.status === 0 && state().current === fromLabel, r.out.slice(-400));
  r = term(work, "--version"); check("the CLI reports 0.1.x after the rollback", r.status === 0 && r.stdout.trim() === fromVersion, r.out);
  r = term(work, "integrity", "check", "--full", "--root", ext); check("integrity check after the rollback", r.status === 0, r.out.slice(-300));
  r = term(work, "update", "install", "--package", pkg, "--root", ext); check("installing the kept 0.2.0 again is refused (it is still installed side by side)", r.status !== 0 && /INSTALL_EXISTS/.test(r.out), r.out.slice(-300));
  r = term(work, "update", "rollback", "--root", ext); check("update rollback again returns forward to 0.2.0", r.status === 0 && state().current === to, r.out.slice(-300));
  r = term(work, "--version"); check("the CLI reports 0.2.0 again", r.status === 0 && /0\.2\.0/.test(r.stdout), r.out);
  const wsAfter = treeHash(ws);

  // standard uninstall: the installation goes, the workspace stays
  r = term(work, "uninstall", "--root", ext, "--yes");
  check("pso uninstall removes the installed versions", r.status === 0 && !existsSync(join(ext, "versions", to)), r.out.slice(-400));
  check("the user workspace survives the uninstall unchanged", existsSync(join(ws, "pso.workspace.json")) && treeHash(ws) === wsAfter);
  check("nothing of the installation remains inside the workspace", !readdirSync(ws, { recursive: true }).some((f) => /\.pso-install|runtime[\\/]node\.exe/.test(String(f))));
} catch (e) { check("validation ran to completion", false, e.stack); }
finally {
  const outDir = flag("evidence");
  if (outDir) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, "upgrade-validation.json"), JSON.stringify({ from: relative(process.cwd(), fromZip), package: relative(process.cwd(), pkg), packageSha256: sha(readFileSync(pkg)), to, windows: spawnSync("cmd", ["/c", "ver"], { encoding: "utf8" }).stdout.trim(), at: new Date().toISOString(), results }, null, 2) + "\n"); }
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exitCode = failed || !results.length ? 1 : 0;
}
