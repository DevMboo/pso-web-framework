import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { redactText } from "../redact.ts";

/**
 * systemd runtime driver (non-containerized Linux).
 *
 * Design decisions, all of them about LEAST PRIVILEGE:
 *  - PSO uses the deploy user's own systemd USER manager (`systemctl --user`). No root, no sudo rule, no unit under /etc: the agent can
 *    only create, start, stop and remove units inside that user's own manager, and a unit runs as that same unprivileged user.
 *    An administrator performs ONE step on the server: `loginctl enable-linger <user>`, so the user manager (and the units enabled in
 *    it) starts at boot without a login session. That is also what makes the active release survive a server restart.
 *  - A unit is PSO's only when its name has the PSO shape AND its file carries the ownership marker AND the slot token. Every systemctl
 *    call goes through `owned()`: an unrelated unit of the same user is never started, stopped, disabled or deleted, whatever name is asked.
 *  - Arguments are argv arrays, never shell strings. Unit text is generated from validated fields; values are escaped for systemd.
 *  - Secrets are never written into the unit file. They live in an EnvironmentFile (mode 0600, in the agent's private run directory).
 *  - The system scope (units under /etc/systemd/system with a configurable `User=`) is NOT implemented: it needs a root-owned helper
 *    and is reported as unavailable instead of being emulated.
 */
export const UNIT_MARKER = "# Managed by PSO Web";
const UNIT_NAME = /^pso-[a-z0-9][a-z0-9-]{0,150}\.service$/;

export interface UnitSlot { app: string; service: string; release: string; instance: number; token: string; port: number; cmd: string[]; cwd: string; logFile: string; graceSeconds: number; runDir: string }

export const unitNameFor = (s: Pick<UnitSlot, "app" | "service" | "release" | "instance">): string => `pso-${s.app}-${s.service}-${s.release}-${s.instance}.service`.toLowerCase();
export const unitDir = (home = homedir()): string => join(home, ".config", "systemd", "user");

/** The environment `systemctl --user` needs when called from a process that did not come from a login session (the detached worker). */
export function userBusEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.() ?? userInfo().uid;
  const runtime = process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${uid}`;
  return { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: process.env["DBUS_SESSION_BUS_ADDRESS"] ?? `unix:path=${runtime}/bus` };
}

function ctl(args: string[], timeoutMs = 20_000): { ok: boolean; out: string; code: number | null } {
  try {
    const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: timeoutMs, env: userBusEnv(), windowsHide: true });
    if (r.error) return { ok: false, out: String(r.error.message), code: null };
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), code: r.status };
  } catch (e) { return { ok: false, out: (e as Error).message, code: null }; }
}
function ctlAsync(args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    const c = spawn("systemctl", ["--user", ...args], { env: userBusEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = ""; c.stdout.on("data", (d: Buffer) => { out += d; }); c.stderr.on("data", (d: Buffer) => { out += d; });
    const t = setTimeout(() => { c.kill("SIGKILL"); res({ ok: false, out: `${out}\n(systemctl timed out)`.trim() }); }, timeoutMs);
    c.on("error", (e) => { clearTimeout(t); res({ ok: false, out: e.message }); });
    c.on("close", (code) => { clearTimeout(t); res({ ok: code === 0, out: out.trim() }); });
  });
}

export interface SystemdAvailability { available: boolean; linger?: boolean; version?: string; reason?: string }
/** Read-only. `reason` says exactly what an administrator has to do. */
export function systemdAvailable(): SystemdAvailability {
  if (process.platform !== "linux") return { available: false, reason: "systemd exists only on Linux" };
  const v = spawnSync("systemctl", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (v.error || v.status !== 0) return { available: false, reason: "systemctl is not installed" };
  const version = /systemd (\d+)/.exec(String(v.stdout))?.[1];
  const st = ctl(["show-environment"]);
  if (!st.ok) return { available: false, ...(version ? { version } : {}), reason: `the user's systemd manager is not reachable (${st.out.split("\n")[0] || "no output"}); an administrator must run: loginctl enable-linger ${userInfo().username}` };
  const lg = spawnSync("loginctl", ["show-user", userInfo().username, "-p", "Linger", "--value"], { encoding: "utf8", windowsHide: true, timeout: 5000, env: userBusEnv() });
  const linger = String(lg.stdout).trim() === "yes";
  return { available: true, linger, ...(version ? { version } : {}), ...(linger ? {} : { reason: `lingering is off: units stop when the last session of the user ends and are not started at boot. An administrator must run: loginctl enable-linger ${userInfo().username}` }) };
}

/** systemd command-line quoting for one ExecStart word. */
export const execWord = (w: string): string => `"${w.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "$$$$").replace(/%/g, "%%").replace(/\n/g, "\\n")}"`;
const envLine = (k: string, v: string): string => `${k}=${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}`;

/** systemd needs an absolute path for the program; PSO resolves it from the agent's PATH. */
export function resolveProgram(cmd: string): string | undefined {
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : undefined;
  for (const d of (process.env["PATH"] ?? "").split(delimiter)) { if (!d) continue; const p = join(d, cmd); if (existsSync(p)) return p; }
  return undefined;
}

export function renderUnit(s: UnitSlot, envFile: string, exec: string[], opts: { restart?: "no" | "on-failure" | "always" } = {}): string {
  const lines = [
    `${UNIT_MARKER} (app=${s.app}, service=${s.service}, release=${s.release}, instance=${s.instance}). Do not edit: it is rewritten by every deployment.`,
    "[Unit]",
    `Description=PSO ${s.app}/${s.service} release ${s.release} instance ${s.instance}`,
    `X-PSO-App=${s.app}`, `X-PSO-Service=${s.service}`, `X-PSO-Release=${s.release}`, `X-PSO-Token=${s.token}`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${s.cwd}`,
    `ExecStart=${exec.map(execWord).join(" ")}`,
    `EnvironmentFile=-${envFile}`,
    `Environment="${envLine("PSO_SLOT_TOKEN", s.token)}" "${envLine("PSO_RELEASE", s.release)}" "${envLine("PSO_SERVICE", s.service)}" "${envLine("PORT", String(s.port))}"`,
    "KillMode=control-group", "KillSignal=SIGTERM", "SuccessExitStatus=143", `TimeoutStopSec=${Math.max(1, s.graceSeconds + 5)}`,
    `Restart=${opts.restart ?? "no"}`, ...(opts.restart && opts.restart !== "no" ? ["RestartSec=2"] : []),
    "NoNewPrivileges=yes", "LimitCORE=0",
    `StandardOutput=append:${s.logFile}`, `StandardError=append:${s.logFile}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

/** True when `unit` is a unit of the PSO shape whose file carries the marker (and, when given, the token). */
export function owned(unit: string, token?: string, home = homedir()): boolean {
  if (!UNIT_NAME.test(unit)) return false;
  const f = join(unitDir(home), unit);
  try { const t = readFileSync(f, "utf8"); if (!t.startsWith(UNIT_MARKER)) return false; return token ? t.includes(`\nX-PSO-Token=${token}\n`) : true; } catch { return false; }
}

export interface UnitState { exists: boolean; active: boolean; state: string; sub: string; mainPid: number; result: string; restarts: number }
export function unitState(unit: string): UnitState {
  if (!UNIT_NAME.test(unit)) return { exists: false, active: false, state: "invalid", sub: "", mainPid: 0, result: "", restarts: 0 };
  const r = ctl(["show", unit, "-p", "LoadState,ActiveState,SubState,MainPID,Result,NRestarts"]);
  const kv: Record<string, string> = {}; for (const l of r.out.split("\n")) { const i = l.indexOf("="); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
  return { exists: kv["LoadState"] === "loaded", active: kv["ActiveState"] === "active" && kv["SubState"] === "running", state: kv["ActiveState"] ?? "unknown", sub: kv["SubState"] ?? "", mainPid: Number(kv["MainPID"] ?? 0), result: kv["Result"] ?? "", restarts: Number(kv["NRestarts"] ?? 0) };
}

export interface InstallResult { ok: boolean; unit: string; detail: string }
/** Writes the unit and its private environment file, reloads the user manager and starts the unit. */
export function installAndStart(s: UnitSlot, o: { env: Record<string, string>; secretEnv: Record<string, string>; restart?: "no" | "on-failure" | "always" }, home = homedir()): InstallResult {
  const unit = unitNameFor(s);
  if (!UNIT_NAME.test(unit)) return { ok: false, unit, detail: "the generated unit name is not a valid PSO unit name" };
  const program = resolveProgram(s.cmd[0]!);
  if (!program) return { ok: false, unit, detail: `program "${s.cmd[0]}" was not found on the agent's PATH (systemd needs an absolute path)` };
  const existing = join(unitDir(home), unit);
  if (existsSync(existing) && !owned(unit, undefined, home)) return { ok: false, unit, detail: `${unit} exists and is not managed by PSO: it is left untouched` };
  mkdirSync(unitDir(home), { recursive: true, mode: 0o700 }); mkdirSync(s.runDir, { recursive: true, mode: 0o700 }); mkdirSync(join(s.logFile, ".."), { recursive: true, mode: 0o700 });
  const envFile = join(s.runDir, `${unit}.env`);
  const envText = Object.entries({ ...o.env, ...o.secretEnv }).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => envLine(k, v)).join("\n") + "\n";
  writeFileSync(envFile, envText, { mode: 0o600 }); try { chmodSync(envFile, 0o600); } catch { /* best effort on exotic file systems */ }
  writeFileSync(existing, renderUnit(s, envFile, [program, ...s.cmd.slice(1)], { restart: o.restart }), { mode: 0o600 });
  const dr = ctl(["daemon-reload"]); if (!dr.ok) return { ok: false, unit, detail: `daemon-reload failed: ${redactText(dr.out)}` };
  ctl(["reset-failed", unit]);
  const st = ctl(["start", unit], 30_000);
  return { ok: st.ok, unit, detail: st.ok ? "started" : `start failed: ${redactText(st.out)}` };
}

/** `systemctl stop` sends SIGTERM to the whole control group, waits TimeoutStopSec (the service's declared grace + margin) and then SIGKILLs. */
export async function stopUnit(s: Pick<UnitSlot, "app" | "service" | "release" | "instance" | "token" | "graceSeconds">, extraMargin = 5, home = homedir()): Promise<{ stopped: boolean; method: "not-running" | "graceful" | "forced" | "refused"; elapsedMs: number; detail: string }> {
  const unit = unitNameFor(s); const t0 = Date.now();
  if (!owned(unit, s.token, home)) {
    // the unit file may have been rewritten by a later start of the same slot (a new token); the marker alone is enough to stop it
    if (!owned(unit, undefined, home)) return { stopped: !existsSync(join(unitDir(home), unit)), method: existsSync(join(unitDir(home), unit)) ? "refused" : "not-running", elapsedMs: 0, detail: existsSync(join(unitDir(home), unit)) ? `${unit} is not managed by PSO: not touched` : "unit does not exist" };
  }
  const before = unitState(unit);
  if (!before.active && before.state !== "activating" && before.state !== "deactivating") { ctl(["disable", unit]); return { stopped: true, method: "not-running", elapsedMs: 0, detail: "already stopped" }; }
  ctl(["disable", unit]);
  const r = await ctlAsync(["stop", unit], (s.graceSeconds + extraMargin + 15) * 1000);
  const after = unitState(unit);
  const elapsed = Date.now() - t0;
  if (!r.ok || after.active) return { stopped: false, method: "forced", elapsedMs: elapsed, detail: `systemctl stop did not finish: ${redactText(r.out)}` };
  return { stopped: true, method: after.result === "timeout" || elapsed > s.graceSeconds * 1000 ? "forced" : "graceful", elapsedMs: elapsed, detail: `stopped by systemd in ${Math.round(elapsed / 100) / 10}s (grace ${s.graceSeconds}s, result ${after.result || "success"})` };
}

/** Persistence across reboots: only the ACTIVE release's units are enabled; with lingering the user manager starts them at boot. */
export function setBootPersistence(unit: string, on: boolean, home = homedir()): { ok: boolean; detail: string } {
  if (!owned(unit, undefined, home)) return { ok: false, detail: "not a PSO-managed unit" };
  const r = ctl([on ? "enable" : "disable", unit]); return { ok: r.ok, detail: redactText(r.out) };
}

/** Removes a PSO-owned unit (stopped first by the caller): file, environment file, and the manager's memory of it. */
export function removeUnit(s: Pick<UnitSlot, "app" | "service" | "release" | "instance" | "runDir">, home = homedir()): boolean {
  const unit = unitNameFor(s); if (!owned(unit, undefined, home)) return false;
  ctl(["disable", unit]); ctl(["stop", unit]);
  rmSync(join(unitDir(home), unit), { force: true }); rmSync(join(s.runDir, `${unit}.env`), { force: true });
  ctl(["daemon-reload"]); ctl(["reset-failed", unit]); return true;
}

/** Identity for the engine: the unit is PSO's, carries THIS slot's token, and its main process is alive. */
export function unitIdentity(s: Pick<UnitSlot, "app" | "service" | "release" | "instance" | "token">, home = homedir()): { match: boolean; reason: string; pid?: number } {
  const unit = unitNameFor(s);
  if (!owned(unit, s.token, home)) return { match: false, reason: existsSync(join(unitDir(home), unit)) ? "unit does not carry this slot's token" : "unit does not exist" };
  const st = unitState(unit);
  if (!st.active) return { match: false, reason: `unit is ${st.state}/${st.sub}${st.result && st.result !== "success" ? ` (${st.result})` : ""}` };
  return { match: true, reason: "unit active and owned by PSO", pid: st.mainPid };
}

export interface UnitDetails { pid: number; restarts: number; activeSince?: string; memoryBytes?: number; cpuSeconds?: number; rssKb?: number }
/** Measured values of a running PSO unit (systemd properties and /proc), nothing estimated. */
export function unitDetails(unit: string): UnitDetails {
  const r = ctl(["show", unit, "-p", "MainPID,NRestarts,ActiveEnterTimestamp,MemoryCurrent"]); const kv: Record<string, string> = {}; for (const l of r.out.split("\n")) { const i = l.indexOf("="); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
  const pid = Number(kv["MainPID"] ?? 0); const d: UnitDetails = { pid, restarts: Number(kv["NRestarts"] ?? 0) };
  if (kv["ActiveEnterTimestamp"]) d.activeSince = kv["ActiveEnterTimestamp"]; const mem = Number(kv["MemoryCurrent"]); if (Number.isFinite(mem) && mem > 0 && mem < 2 ** 60) d.memoryBytes = mem;
  if (pid > 0) { try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); const f = st.slice(st.lastIndexOf(")") + 2).split(" "); d.cpuSeconds = Math.round(((Number(f[11]) + Number(f[12])) / 100) * 10) / 10; } catch { /* gone */ } try { d.rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]); } catch { /* gone */ } }
  return d;
}

/** Journal lines of a PSO unit, sanitized. `journalctl --user` needs the user's journal to be readable; when it is not, say so. */
export function journalTail(unit: string, lines = 200): { ok: boolean; text: string; reason?: string } {
  if (!owned(unit)) return { ok: false, text: "", reason: "not a PSO-managed unit" };
  try {
    const r = spawnSync("journalctl", ["--user", "-u", unit, "-n", String(Math.max(1, Math.min(2000, lines))), "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 10_000, env: userBusEnv(), windowsHide: true });
    if (r.error || r.status !== 0) return { ok: false, text: "", reason: `journalctl unavailable or not permitted (${String(r.stderr ?? r.error?.message ?? "").trim().split("\n")[0]})` };
    return { ok: true, text: redactText(String(r.stdout)) };
  } catch (e) { return { ok: false, text: "", reason: (e as Error).message }; }
}

/** What a unit's recorded exit looks like, for the failure message of a candidate that did not become ready. */
export function unitFailure(unit: string): string {
  const st = unitState(unit); return `unit ${st.state}/${st.sub}, result=${st.result || "?"}, restarts=${st.restarts}`;
}
