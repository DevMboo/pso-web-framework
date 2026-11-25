import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { randomToken } from "../crypto.ts";
import { redactText } from "../redact.ts";
import { pidAlive, readJson, writeJson, nowIso, ensureDir } from "./state.ts";
import { installAndStart, stopUnit, unitIdentity, unitState, type UnitSlot } from "./systemd.ts";

/**
 * Runtime process management.
 *
 * A process is identified by the combination of its pid, its start time and a random token placed in its environment when it was
 * started (`PSO_SLOT_TOKEN`), never by a port or an executable name. Before a signal is sent, the identity is checked, so that a pid
 * reused by an unrelated program, or an unrelated program listening on a port, is never touched.
 * Identity verification needs /proc (Linux). Where it is unavailable the agent refuses to signal and says so.
 */
export interface SlotState {
  app: string; service: string; release: string; slot: string; instance: number;
  pid?: number; startTicks?: string; token: string; port: number; cmd: string[]; cwd: string; logFile: string;
  startedAt?: string; stoppedAt?: string; status: "created" | "running" | "stopped" | "failed";
  graceSeconds: number;
  /** who keeps the process alive: the agent itself (detached process, the default) or the deploy user's systemd manager */
  supervisor?: "process" | "systemd";
  /** systemd: the unit's name, and the private directory of its environment file */
  unit?: string; runDir?: string; restart?: "no" | "on-failure";
}

const asUnit = (s: SlotState): UnitSlot => ({ app: s.app, service: s.service, release: s.release, instance: s.instance, token: s.token, port: s.port, cmd: s.cmd, cwd: s.cwd, logFile: s.logFile, graceSeconds: s.graceSeconds, runDir: s.runDir ?? join(s.logFile, "..", "..", "run") });

export const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "JAVA_HOME", "NODE_OPTIONS_NONE"];

export function startTicks(pid: number): string | undefined {
  try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); const rest = s.slice(s.lastIndexOf(")") + 2).split(" "); return rest[19]; } catch { return undefined; }
}

/** True only when `pid` is the process this slot started: alive, same start time, same token in its environment. */
export function identityMatches(slot: SlotState): { match: boolean; reason: string } {
  if (slot.supervisor === "systemd") { const i = unitIdentity(slot); return { match: i.match, reason: i.reason }; }
  if (!slot.pid) return { match: false, reason: "no pid recorded" };
  if (!pidAlive(slot.pid)) return { match: false, reason: "process not running" };
  if (!existsSync(`/proc/${slot.pid}/stat`)) return { match: false, reason: "process identity cannot be verified on this platform (no /proc)" };
  if (slot.startTicks && startTicks(slot.pid) !== slot.startTicks) return { match: false, reason: "pid was reused by another process" };
  try {
    const env = readFileSync(`/proc/${slot.pid}/environ`, "utf8");
    if (!env.split("\0").includes(`PSO_SLOT_TOKEN=${slot.token}`)) return { match: false, reason: "process does not carry this slot's identity token" };
  } catch { return { match: false, reason: "process environment is not readable" }; }
  return { match: true, reason: "identity verified" };
}

export interface StartOptions { env: Record<string, string>; secretEnv: Record<string, string> }

export function startSlot(slot: SlotState, o: StartOptions): SlotState {
  if (slot.supervisor === "systemd") {
    const r = installAndStart(asUnit(slot), { env: o.env, secretEnv: o.secretEnv, restart: slot.restart });
    const st = r.ok ? unitState(r.unit) : undefined;
    return { ...slot, unit: r.unit, pid: st?.mainPid || undefined, startTicks: st?.mainPid ? startTicks(st.mainPid) : undefined, startedAt: nowIso(), status: r.ok ? "running" : "failed" };
  }
  ensureDir(join(slot.logFile, ".."));
  const out = openSync(slot.logFile, "a", 0o600);
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  Object.assign(env, o.env, o.secretEnv, { PSO_SLOT_TOKEN: slot.token, PSO_RELEASE: slot.release, PSO_SLOT: slot.slot, PSO_SERVICE: slot.service, PORT: String(slot.port) });
  const child = spawn(slot.cmd[0]!, slot.cmd.slice(1), { cwd: slot.cwd, env, detached: true, stdio: ["ignore", out, out], windowsHide: true });
  closeSync(out);
  child.on("error", () => undefined); // a missing executable is detected by the readiness check, not by crashing the agent
  child.unref();
  const pid = child.pid;
  return { ...slot, pid, startTicks: pid ? startTicks(pid) : undefined, startedAt: nowIso(), status: pid ? "running" : "failed" };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface StopResult { stopped: boolean; method: "not-running" | "graceful" | "forced" | "refused"; elapsedMs: number; detail: string }

/**
 * Stops a slot: SIGTERM to its process group, then waits for the service's REAL grace period (declared per service; the framework
 * default is 30 s), and only then SIGKILL. A fixed short timeout would kill services that are still draining requests.
 */
export async function stopSlot(slot: SlotState, extraMarginSeconds = 5): Promise<StopResult> {
  const t0 = Date.now();
  if (slot.supervisor === "systemd") return stopUnit(slot, extraMarginSeconds);
  if (!slot.pid || !pidAlive(slot.pid)) return { stopped: true, method: "not-running", elapsedMs: 0, detail: "already stopped" };
  const id = identityMatches(slot);
  if (!id.match) return { stopped: false, method: "refused", elapsedMs: 0, detail: `not signalled: ${id.reason}` };
  const signal = (s: NodeJS.Signals): void => { try { process.kill(-slot.pid!, s); } catch { try { process.kill(slot.pid!, s); } catch { /* gone */ } } };
  signal("SIGTERM");
  const deadline = t0 + (slot.graceSeconds + extraMarginSeconds) * 1000;
  while (Date.now() < deadline) {
    if (!pidAlive(slot.pid) || !identityMatches(slot).match) return { stopped: true, method: "graceful", elapsedMs: Date.now() - t0, detail: `exited ${Math.round((Date.now() - t0) / 100) / 10}s after SIGTERM (grace ${slot.graceSeconds}s)` };
    await sleep(200);
  }
  if (identityMatches(slot).match) signal("SIGKILL");
  await sleep(500);
  return { stopped: !pidAlive(slot.pid), method: "forced", elapsedMs: Date.now() - t0, detail: `still running after ${slot.graceSeconds + extraMarginSeconds}s: SIGKILL` };
}

export const newToken = (): string => randomToken(18);

// ------------------------------------------------------------------ ports
export const portFree = (port: number): Promise<boolean> => new Promise((res) => {
  const s = createServer(); s.once("error", () => res(false)); s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
});

/** Ports reserved by this agent (any app, any release): a port is only handed out when it is neither reserved nor in use. */
export class PortAllocator {
  private readonly file: string; private readonly range: { from: number; to: number };
  constructor(file: string, range: { from: number; to: number }) { this.file = file; this.range = range; }
  private all(): Record<string, string> { return readJson(this.file, {}); }
  async allocate(owner: string): Promise<number> {
    const used = this.all();
    for (let p = this.range.from; p <= this.range.to; p++) {
      if (used[String(p)]) continue;
      if (!(await portFree(p))) continue;
      const again = this.all(); if (again[String(p)]) continue;
      again[String(p)] = owner; writeJson(this.file, again);
      return p;
    }
    throw new Error(`no free port in ${this.range.from}-${this.range.to}`);
  }
  reserve(port: number, owner: string): void { const a = this.all(); a[String(port)] = owner; writeJson(this.file, a); }
  release(port: number): void { const a = this.all(); delete a[String(port)]; writeJson(this.file, a); }
  ownedBy(owner: string): number[] { return Object.entries(this.all()).filter(([, o]) => o === owner).map(([p]) => Number(p)); }
  releaseOwner(prefix: string): void { const a = this.all(); for (const [p, o] of Object.entries(a)) if (o.startsWith(prefix)) delete a[p]; writeJson(this.file, a); }
}

// ------------------------------------------------------------------ health
export interface HealthResult { ok: boolean; status?: number; ms: number; error?: string; headers?: Record<string, string | string[] | undefined> }

export function httpGet(port: number, path: string, headers: Record<string, string> = {}, timeoutMs = 3000, host = "127.0.0.1"): Promise<HealthResult> {
  return new Promise((res) => {
    const t0 = Date.now();
    const r = request({ host, port, path, method: "GET", headers, timeout: timeoutMs }, (resp) => { resp.resume(); resp.on("end", () => res({ ok: true, status: resp.statusCode ?? 0, ms: Date.now() - t0, headers: resp.headers })); });
    r.on("timeout", () => { r.destroy(); res({ ok: false, ms: Date.now() - t0, error: "timeout" }); });
    r.on("error", (e) => res({ ok: false, ms: Date.now() - t0, error: (e as NodeJS.ErrnoException).code ?? "error" }));
    r.end();
  });
}

export interface WaitReady { ok: boolean; attempts: number; lastStatus?: number; lastError?: string; ms: number; exited?: boolean }

/** Polls until `consecutive` successful probes in a row, the process dies, or the timeout expires. */
export async function waitReady(opts: { port: number; path: string; expectStatus: number; timeoutSeconds: number; intervalSeconds: number; consecutive: number; alive: () => boolean; headers?: Record<string, string> }): Promise<WaitReady> {
  const t0 = Date.now(); let attempts = 0; let streak = 0; let lastStatus: number | undefined; let lastError: string | undefined;
  while (Date.now() - t0 < opts.timeoutSeconds * 1000) {
    if (!opts.alive()) return { ok: false, attempts, ms: Date.now() - t0, exited: true, ...(lastStatus !== undefined ? { lastStatus } : {}), ...(lastError ? { lastError } : {}) };
    attempts++;
    const r = await httpGet(opts.port, opts.path, opts.headers);
    if (r.ok && r.status === opts.expectStatus) { streak++; lastStatus = r.status; if (streak >= opts.consecutive) return { ok: true, attempts, lastStatus: r.status, ms: Date.now() - t0 }; } else { streak = 0; lastStatus = r.status; lastError = r.error; }
    await sleep(opts.intervalSeconds * 1000);
  }
  return { ok: false, attempts, ms: Date.now() - t0, ...(lastStatus !== undefined ? { lastStatus } : {}), ...(lastError ? { lastError } : {}) };
}

export const tailLog = (file: string, maxBytes = 16_000): string => {
  try { const b = readFileSync(file); return redactText(b.subarray(Math.max(0, b.length - maxBytes)).toString("utf8")); } catch { return ""; }
};

// ------------------------------------------------------------------ small probes (fixed argv, no shell)
export function probe(cmd: string, args: string[], timeoutMs = 8000): { ok: boolean; out: string } {
  try { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }); if (r.error) return { ok: false, out: "" }; return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }; } catch { return { ok: false, out: "" }; }
}
export const listSlots = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
