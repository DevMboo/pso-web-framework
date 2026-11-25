// Process-level isolation for validating the installed distribution as a developer would meet it.
// NOT a clean virtual machine: the registry (HKCU), the Windows account, DPAPI and the machine's network are the real ones. What is isolated: the user profile
// folders, TEMP, the npm cache, the Maven repository (it lives under the isolated profile), PATH (Node, the JDK and system folders only: no repository, no
// PSO) and every PSO variable. Nothing from the development repository is reachable through an environment variable or PATH.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const JDK = process.env.PSD_JDK ?? "C:\\Program Files\\Java\\jdk-25.0.3";
export const sha = (b) => createHash("sha256").update(b).digest("hex");

export function makeIso(root, { fresh = true } = {}) {
  if (fresh) rmSync(root, { recursive: true, force: true });
  const d = { root, home: join(root, "home"), appdata: join(root, "home", "AppData", "Roaming"), local: join(root, "home", "AppData", "Local"), temp: join(root, "temp"), npm: join(root, "npm-cache"), work: join(root, "work") };
  for (const k of ["home", "appdata", "local", "temp", "npm", "work"]) mkdirSync(d[k], { recursive: true });
  const sys = process.env.SystemRoot ?? "C:\\Windows";
  const env = {
    SystemRoot: sys, windir: sys, ComSpec: join(sys, "System32", "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD;.JS;.MJS",
    PATH: [dirname(process.execPath), join(sys, "System32"), sys, join(sys, "System32", "Wbem"), join(sys, "System32", "WindowsPowerShell", "v1.0"), join(JDK, "bin")].join(";"),
    USERPROFILE: d.home, HOME: d.home, APPDATA: d.appdata, LOCALAPPDATA: d.local, TEMP: d.temp, TMP: d.temp, npm_config_cache: d.npm, JAVA_HOME: JDK,
    USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN, COMPUTERNAME: process.env.COMPUTERNAME, ProgramFiles: process.env.ProgramFiles, "ProgramFiles(x86)": process.env["ProgramFiles(x86)"], ProgramData: process.env.ProgramData,
    ALLUSERSPROFILE: process.env.ALLUSERSPROFILE, NODE_OPTIONS: "", PSO_LOG_COLOR: "never", NO_COLOR: "1",
  };
  return { ...d, env };
}

export function run(iso, cmd, args, o = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: o.cwd ?? iso.work, env: { ...iso.env, ...(o.env ?? {}) }, encoding: "utf8", timeout: o.timeout ?? 600_000, windowsHide: true, maxBuffer: 256 * 1024 * 1024, shell: o.shell ?? false, input: o.input });
  return { status: r.status, out: (r.stdout ?? "").toString(), err: (r.stderr ?? "").toString(), ms: Date.now() - t0, signal: r.signal, error: r.error?.message };
}
export const node = (iso, args, o) => run(iso, process.execPath, args, o);

export class Evidence {
  constructor(file) { this.file = file; this.checks = []; }
  check(name, ok, detail = "") { this.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${String(detail).slice(0, 200).replace(/\s+/g, " ")}` : ""}`); return !!ok; }
  save(extra = {}) { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ generatedAt: new Date().toISOString(), passed: this.checks.filter((c) => c.ok).length, failed: this.checks.filter((c) => !c.ok).length, ...extra, checks: this.checks }, null, 2)); }
  get failed() { return this.checks.filter((c) => !c.ok).length; }
}
