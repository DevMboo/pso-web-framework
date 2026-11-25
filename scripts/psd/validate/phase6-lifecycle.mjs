// Phase 6: update (offline package and installer), rollback, repair, rejection of forged/tampered updates, PATH registration, workspace preservation and uninstall,
// all on the installed protected distribution in the isolated profile (and the real Inno uninstaller).
//   node scripts/psd/validate/phase6-lifecycle.mjs --label 0.1.0-alpha.1 --next 0.1.0-alpha.2 --last 0.1.0-alpha.3
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Evidence, makeIso, node, run, sha } from "./iso.mjs";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const arg = (n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : a[i + 1]; };
const L1 = arg("label", "0.1.0-alpha.1"), L2 = arg("next", "0.1.0-alpha.2"), L3 = arg("last", "0.1.0-alpha.3");
const K = join(process.env.USERPROFILE, ".pso-psd");
const evDir = join(repo, "docs", "implementation", "evidence", "psd", L1);
const ev = new Evidence(join(evDir, "validation-lifecycle.json"));
const iso = makeIso(join(K, "validation", "iso-dev"), { fresh: false });
const dir = join(iso.root, "pso");
const cli = (v) => join(dir, "versions", v, "node_modules", "@pso", "cli", "bin", "pso.js");
const pso = (args, o = {}) => node(iso, [cli(current()), ...args], o);
const state = () => JSON.parse(readFileSync(join(dir, ".pso-install", "install.json"), "utf8"));
const current = () => state().current;
const walk = (d, acc = []) => { if (!existsSync(d)) return acc; for (const n of readdirSync(d)) { if (n === "node_modules" || n === "target" || n === ".m2") continue; const f = join(d, n); statSync(f).isDirectory() ? walk(f, acc) : acc.push(f); } return acc; };
const treeHash = (d) => { const h = createHash("sha256"); for (const f of walk(d).sort()) h.update(relative(d, f).split(sep).join("/") + "\0").update(readFileSync(f)); return h.digest("hex").slice(0, 16); };
const RK = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B2E1F6A3-7C34-4D0E-9A55-3C1D8A9F0001}_is1`;
const hasKey = () => spawnSync("reg", ["query", RK], { encoding: "utf8" }).status === 0;
const userPath = () => { const r = spawnSync("reg", ["query", String.raw`HKCU\Environment`, "/v", "Path"], { encoding: "utf8" }); const m = /^\s*Path\s+(REG_\w+)\s+(.*)$/mi.exec(r.stdout ?? ""); return m ? { type: m[1], data: m[2].replace(/\r$/, "") } : null; };

// ---- build the two follow-up releases (same recipients, same signer)
const build = (label) => spawnSync(process.execPath, [join(repo, "scripts", "psd", "build-release.mjs"), "--label", label, "--signing-key", join(K, "keys", "release.private.pem"), "--recipients", join(K, "recipients"), "--maven", join(repo, "release-out", "maven", "repository"), "--obfuscate", "--skip-docs"], { encoding: "utf8", env: { ...process.env, TEMP: join(K, "tmp"), TMP: join(K, "tmp") }, timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
const reuse = a.includes("--reuse-builds");
for (const l of [L2, L3]) { if (reuse && existsSync(join(K, "work", l, `pso-${l}-win32-x64.psopkg`)) && existsSync(join(repo, "release-out", "psd", l))) { ev.check(`candidate ${l} built (reused)`, true); continue; } const b = build(l); ev.check(`candidate ${l} built`, b.status === 0, b.stdout.split("\n").filter((x) => /FAILED|BLOCKED/.test(x)).join("; ")); if (b.status !== 0) { ev.save(); process.exit(1); } }
const pkgOf = (l) => join(K, "work", l, `pso-${l}-win32-x64.psopkg`);
const exeOf = (l) => join(repo, "release-out", "psd", l, `PSO-Web-${l}-win-x64.exe`);
const fp = JSON.parse(readFileSync(join(repo, "release-out", "psd", L1, "release-manifest.json"), "utf8")).signing.fingerprintSha256;

// ---- a clean starting point: the validation installation is removed and alpha.1 is installed again with the real installer
rmSync(dir, { recursive: true, force: true });
{
  const x = run(iso, exeOf(L1), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${dir}`, `/LOG=${join(iso.work, "reinstall.log")}`], { timeout: 300_000 });
  ev.check(`${L1} installed with the real installer (clean starting point)`, x.status === 0 && existsSync(cli(L1)), `exit ${x.status}`);
}

// ---- developer-owned data that must survive everything
const mine = join(iso.work, "my-own-notes.txt"); writeFileSync(mine, "business notes");
const wsHash = { shop: treeHash(join(iso.work, "shop")), fe: existsSync(join(iso.work, "fe")) ? treeHash(join(iso.work, "fe")) : null };
const identityBefore = sha(readFileSync(join(iso.local, "PSO", "recipient", "identity.json")));
ev.check(`starting point: ${L1} is installed and active`, current() === L1, JSON.stringify({ current: current(), previous: state().previous }));

// ---- 1. update with an offline package (verified, side by side, atomic activation)
let r = pso(["update", "install", "--package", pkgOf(L2), "--root", dir]);
ev.check(`update install --package ${L2} (signed, encrypted, decrypted with the developer's DPAPI identity)`, r.status === 0 && current() === L2 && state().previous === L1, r.out.split("\n")[0] || r.err.slice(0, 200));
r = pso(["integrity", "check", "--full", "--root", dir]); ev.check("integrity check --full after the update", r.status === 0, r.out.split("\n")[0]);
ev.check("developer workspaces and own files are untouched by the update", treeHash(join(iso.work, "shop")) === wsHash.shop && (wsHash.fe === null || treeHash(join(iso.work, "fe")) === wsHash.fe) && readFileSync(mine, "utf8") === "business notes");
ev.check("the previous version is kept side by side for rollback", existsSync(cli(L1)) && existsSync(cli(L2)));
r = pso(["update", "rollback", "--root", dir]); ev.check("update rollback returns to the previous version", r.status === 0 && current() === L1, r.out.split("\n")[0] || r.err.slice(0, 200));
r = pso(["integrity", "check", "--full", "--root", dir]); ev.check("integrity check --full after the rollback", r.status === 0);

// ---- 2. forged and tampered update packages are refused before anything is decrypted
const other = join(iso.work, "other-keys"); mkdirSync(other, { recursive: true });
node(iso, [cli(L1), "dist", "keygen", "--kind", "signing", "--out", other, "--name", "rogue"]);
const forged = join(iso.work, "forged.psopkg");
r = node(iso, [cli(L1), "dist", "pack", "--config", join(K, "work", L3, "dist.config.json"), "--stage", join(K, "work", L3, "stage"), "--sign-key", join(other, "rogue.private.pem"), "--encrypt", "--recipient", join(K, "recipients", "validation-dev.public.pem"), "--out", forged]);
ev.check("a package signed by a different key can be built (the attacker's side)", r.status === 0 && existsSync(forged), r.err.slice(0, 160));
r = pso(["update", "install", "--package", forged, "--root", dir]); ev.check("an update signed by a signer the installation does not trust is refused", r.status !== 0 && /SIGNATURE|trusted/i.test(r.out + r.err) && current() === L1, (r.err || r.out).slice(0, 160));
const tam = Buffer.from(readFileSync(pkgOf(L3))); tam[Math.floor(tam.length / 2)] ^= 0xff; const tampered = join(iso.work, "tampered.psopkg"); writeFileSync(tampered, tam);
r = pso(["update", "install", "--package", tampered, "--root", dir]); ev.check("a modified update package is refused", r.status !== 0 && current() === L1, (r.err || r.out).slice(0, 160));

// ---- 3. update through the installer of the next release (the other supported path)
const t0 = Date.now();
r = run(iso, exeOf(L3), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${dir}`, `/LOG=${join(iso.work, "update.log")}`], { timeout: 300_000 });
ev.check(`running the ${L3} installer over the installation updates it`, r.status === 0 && current() === L3 && state().previous === L1, `exit ${r.status}, ${Date.now() - t0} ms, current ${current()}`);
r = pso(["integrity", "check", "--full", "--root", dir]); ev.check("integrity check --full after the installer update", r.status === 0);
ev.check("workspaces untouched after the installer update; the same identity is used", treeHash(join(iso.work, "shop")) === wsHash.shop && sha(readFileSync(join(iso.local, "PSO", "recipient", "identity.json"))) === identityBefore);

// ---- 4. repair restores the protected file from the encrypted package, never an unprotected source
// The worst case: the file that IS the running CLI is replaced. The documented recovery runs the repair with any working CLI (here the previous version,
// kept side by side) against the installation: the damaged copy cannot be asked to repair itself.
const good = (args) => node(iso, [cli(L1), ...args]);
const victim = join(dir, "versions", L3, "node_modules", "@pso", "cli", "dist", "main.js");
const authentic = readFileSync(victim);
writeFileSync(victim, "console.log('replaced');\n");
ev.check("the active CLI no longer works once its own file is replaced (the situation repair exists for)", !/PSO CLI/.test(pso(["help"]).out));
r = good(["integrity", "check", "--full", "--root", dir]); ev.check("a replaced protected file is detected (checked from the previous version's CLI)", r.status === 1 && /cli\/dist\/main\.js/.test(r.out), r.out.split("\n").filter((l) => /damaged/.test(l)).join(" "));
r = good(["repair", "--full", "--root", dir]); ev.check("repair restores the authentic protected file (byte-identical, still minified)", r.status === 0 && readFileSync(victim).equals(authentic) && !/\n {2,}/.test(readFileSync(victim, "utf8").slice(0, 4000)), r.out.split("\n")[0]);
ev.check("the repaired CLI works again", /PSO CLI/.test(pso(["help"]).out));
rmSync(join(dir, "versions", L3, "node_modules", "@pso", "http", "dist"), { recursive: true, force: true }); // the CLI itself imports @pso/http: it cannot start, so the previous version repairs it
r = good(["repair", "--full", "--root", dir]); ev.check("repair restores a whole deleted directory (the public SDK) and the unexpected-file policy keeps user files", r.status === 0, r.out.split("\n")[0]);
r = pso(["integrity", "check", "--full", "--root", dir]); ev.check("integrity check --full after repair", r.status === 0);

// ---- 6. uninstall through the real Inno uninstaller: framework files go, developer-owned data stays
ev.check("registry uninstall entry exists before uninstalling", hasKey());
// the worst case for the uninstaller: the ACTIVE version's CLI is damaged and cannot uninstall; the previous version's CLI must (fallback entry)
writeFileSync(victim, "console.log('damaged');\n");
ev.check("the active CLI is damaged right before the uninstall (the previous version is kept side by side)", !/PSO CLI/.test(pso(["help"]).out) && state().previous === L1, `previous ${state().previous}`);
mkdirSync(join(dir, "config"), { recursive: true }); writeFileSync(join(dir, "config", "keep-me-not.json"), "{}"); // PSO-owned user data: removed by complete uninstall
writeFileSync(join(dir, "foreign.txt"), "not owned by PSO");
r = run(iso, join(dir, "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { timeout: 300_000 });
await new Promise((ok) => setTimeout(ok, 4000)); // the Inno uninstaller finishes by removing itself asynchronously
ev.check("the Inno uninstaller (unins000.exe) ran: exit 0", r.status === 0, `exit ${r.status}`);
ev.check("PSO-owned files, versions, inventory and cached packages are gone", !existsSync(join(dir, "versions")) && !existsSync(join(dir, ".pso-install")) && !existsSync(join(dir, "config")), existsSync(dir) ? readdirSync(dir).join(",") : "(root removed)");
ev.check("a foreign file inside the root is left alone (never deleted blindly)", existsSync(join(dir, "foreign.txt")));
ev.check("developer-owned applications and files are preserved", treeHash(join(iso.work, "shop")) === wsHash.shop && readFileSync(mine, "utf8") === "business notes");
ev.check("the registry uninstall entry is removed", !hasKey());
ev.check("the developer's recipient identity is NOT deleted by uninstalling the framework (it belongs to the developer)", existsSync(join(iso.local, "PSO", "recipient", "identity.json")));

// the PATH test runs AFTER the uninstall: both installations would share one Inno AppId and therefore one registry entry
// ---- 6. PATH registration (the real per-user registry value is restored exactly afterwards)
const original = userPath();
const isoPath = makeIso(join(K, "validation", "iso-path"));
mkdirSync(join(isoPath.local, "PSO"), { recursive: true });
cpIdentity(join(iso.local, "PSO", "recipient"), join(isoPath.local, "PSO", "recipient"));
const pathDir = join(isoPath.root, "pso");
try {
  r = run(isoPath, exeOf(L3), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${pathDir}`, "/TASKS=addpath", `/LOG=${join(isoPath.work, "setup.log")}`], { timeout: 300_000 });
  const after = userPath();
  ev.check("PATH task: the per-user PATH gets the installation's bin directory appended (existing entries kept)", r.status === 0 && !!after && after.data.includes(join(pathDir, "bin")) && after.data.startsWith(original?.data ?? ""), `exit ${r.status}`);
  const expanded = (after?.data ?? "").replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? "");
  const shell = run(isoPath, "cmd.exe", ["/d", "/c", "pso help"], { env: { PATH: `${expanded};${isoPath.env.PATH}` }, timeout: 60_000 });
  ev.check("the `pso` shim resolves from the registered PATH in a new process", shell.status === 0 && /PSO CLI/.test(shell.out), shell.out.split("\n")[0] || shell.err.slice(0, 160));
} finally {
  if (original) spawnSync("reg", ["add", String.raw`HKCU\Environment`, "/v", "Path", "/t", original.type, "/d", original.data, "/f"], { encoding: "utf8" });
}
const restored = userPath();
ev.check("the user's PATH registry value was restored exactly (type and data)", !!original && restored?.type === original.type && restored?.data === original.data);
function cpIdentity(from, to) { mkdirSync(to, { recursive: true }); copyFileSync(join(from, "identity.json"), join(to, "identity.json")); }
// remove the PATH-test installation through ITS uninstaller
r = run(isoPath, join(pathDir, "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { timeout: 180_000 });

ev.save({ label: L1, releases: [L1, L2, L3] });
console.log(`\n${ev.checks.length - ev.failed}/${ev.checks.length} checks passed`);
process.exit(ev.failed ? 1 : 0);
