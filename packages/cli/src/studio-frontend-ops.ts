import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { activePointer, activeFei, feiHistory, feiVersions, history, versions } from "@pso/frontend/node";
import { scrub } from "./studio-data.ts";

/**
 * Operational actions for the frontend section of Studio. They are OFF unless Studio was started with `--frontend-ops`, and they never
 * implement anything themselves: every action runs the same `pso frontend:*` command a developer would type (so the same validation,
 * build, publish and rollback code), in the workspace, with a fixed argument grammar. Studio keeps no credentials: remote deployment and
 * rollback of a published frontend are the existing Cloud operations (`pso release:*`, Studio's Cloud section, with their own roles).
 *
 * Boundaries: loopback only, the Studio access cookie, a same-origin request with a custom header (see studio.ts), project names taken from
 * the workspace (never free text), publishing only into a fixed local site root inside the workspace, typed confirmation for the
 * state-changing actions, one operation at a time, bounded output, secrets scrubbed from everything shown.
 */
export const ACTIONS = ["validate", "build", "dev-start", "dev-stop", "dev-restart", "publish", "rollback"] as const;
export type Action = (typeof ACTIONS)[number];
const NEEDS_CONFIRM = new Set<Action>(["publish", "rollback"]);
const BASE_PATH = /^\/([A-Za-z0-9._~-]+\/)*$/;
const PROJECT = /^(fei|mei)-[a-z][a-z0-9-]{0,40}$/;

export interface OpResult { action: Action; project?: string; ok: boolean; exitCode: number | null; output: string; durationMs: number; at: string }
export interface OpsStatus {
  enabled: boolean;
  busy: string | null;
  dev: { running: boolean; pid?: number; startedAt?: string; log: string[] };
  last: OpResult | null;
  siteRoot: string;
  /** what is active on the local site root that `publish` writes to (the same registry `pso frontend:releases` reads) */
  releases: { fei: { active: string | null; versions: string[]; history: Array<{ at: string; action: string; version: string }> } | null; meis: Array<{ name: string; active: string | null; versions: string[]; history: Array<{ at: string; action: string; version: string }> }> };
}

const tail = (s: string, max = 20_000): string => (s.length > max ? `…${s.slice(s.length - max)}` : s);
const killTree = (pid: number): void => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } }
};

export class FrontendOps {
  readonly #o: { root: string; enabled: boolean; cli: string };
  #busy: string | null = null;
  #dev: { child: ChildProcess; startedAt: string; log: string[] } | undefined;
  #last: OpResult | null = null;
  constructor(o: { root: string; enabled: boolean; cli: string }) { this.#o = o; }

  get enabled(): boolean { return this.#o.enabled; }
  get siteRoot(): string { return join(this.#o.root, ".pso", "studio-site"); }

  status(): OpsStatus {
    const site = this.siteRoot;
    const rel = (): OpsStatus["releases"] => {
      const fei = existsSync(join(site, "fei")) ? { active: activeFei(site)?.version ?? null, versions: feiVersions(site), history: feiHistory(site).slice(-5).map((h) => ({ at: h.at, action: h.action, version: h.version })) } : null;
      const names = existsSync(join(site, "_mei")) ? readdirSync(join(site, "_mei")) : [];
      return { fei, meis: names.map((name) => ({ name, active: activePointer(site, name)?.version ?? null, versions: versions(site, name), history: history(site, name).slice(-5).map((h) => ({ at: h.at, action: h.action, version: h.version })) })) };
    };
    return { enabled: this.#o.enabled, busy: this.#busy, dev: { running: this.#dev !== undefined && this.#dev.child.exitCode === null, ...(this.#dev?.child.pid ? { pid: this.#dev.child.pid } : {}), ...(this.#dev ? { startedAt: this.#dev.startedAt } : {}), log: this.#dev ? this.#dev.log.slice(-200) : [] }, last: this.#last, siteRoot: ".pso/studio-site", releases: rel() };
  }

  /** `frontends` are the project names of the workspace: the only values a project argument may take. */
  async run(body: Record<string, unknown>, frontends: readonly string[]): Promise<{ status: number; body: unknown }> {
    if (!this.#o.enabled) return { status: 403, body: { error: "frontend operations are disabled", hint: "start Studio with `pso studio --frontend-ops`" } };
    const action = body["action"] as Action;
    if (!ACTIONS.includes(action)) return { status: 400, body: { error: `unknown action; one of ${ACTIONS.join(", ")}` } };
    const project = typeof body["project"] === "string" && body["project"] !== "" ? body["project"] : undefined;
    if (project !== undefined && (!PROJECT.test(project) || !frontends.includes(project))) return { status: 400, body: { error: "unknown project", hint: `one of ${frontends.join(", ") || "(no frontend projects)"}` } };
    const basePath = typeof body["basePath"] === "string" && body["basePath"] !== "" ? body["basePath"] : undefined;
    if (basePath !== undefined && !BASE_PATH.test(basePath)) return { status: 400, body: { error: "basePath must be absolute and end with /" } };
    if ((action === "publish" || action === "rollback") && !project) return { status: 400, body: { error: `${action} needs a project` } };
    if (NEEDS_CONFIRM.has(action) && body["confirm"] !== `${action} ${project}`) return { status: 400, body: { error: "confirmation required", hint: `type "${action} ${project}" to confirm` } };
    if (this.#busy) return { status: 409, body: { error: `another operation is running: ${this.#busy}` } };

    if (action === "dev-stop") return { status: 200, body: this.#stopDev() };
    if (action === "dev-start") return { status: 200, body: this.#startDev(project) };
    if (action === "dev-restart") { this.#stopDev(); await new Promise((r) => setTimeout(r, 600)); return { status: 200, body: this.#startDev(project) }; }

    const args: string[] = action === "validate" ? ["frontend:validate"]
      : action === "build" ? ["frontend:build", ...(project ? [project] : []), ...(basePath ? ["--base-path", basePath] : [])]
      : action === "publish" ? ["frontend:publish", project!, "--site", this.siteRoot, ...(basePath ? ["--base-path", basePath] : [])]
      : ["frontend:rollback", project!, "--site", this.siteRoot];
    this.#busy = `${action}${project ? ` ${project}` : ""}`;
    const started = Date.now();
    try {
      const r = await this.#exec(args, action === "build" ? 600_000 : 120_000);
      const res: OpResult = { action, ...(project ? { project } : {}), ok: r.code === 0, exitCode: r.code, output: scrub(tail(r.out)), durationMs: Date.now() - started, at: new Date().toISOString() };
      this.#last = res;
      return { status: 200, body: res };
    } finally { this.#busy = null; }
  }

  #exec(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.#o.cli, ...args], { cwd: this.#o.root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = ""; const add = (b: Buffer): void => { out += b.toString("utf8"); if (out.length > 200_000) out = out.slice(-100_000); };
      child.stdout?.on("data", add); child.stderr?.on("data", add);
      const timer = setTimeout(() => { if (child.pid) killTree(child.pid); out += "\n(stopped: the operation took longer than its limit)"; }, timeoutMs);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "") }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out: `could not start: ${e.message}` }); });
    });
  }

  #startDev(project?: string): OpsStatus {
    if (this.#dev && this.#dev.child.exitCode === null) return this.status();
    const args = ["frontend:dev", ...(project ? ["--standalone", project.replace(/^mei-/, "")] : [])];
    const child = spawn(process.execPath, [this.#o.cli, ...args], { cwd: this.#o.root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const log: string[] = []; const add = (b: Buffer): void => { for (const line of b.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) if (line.trim()) { log.push(scrub(line).slice(0, 400)); if (log.length > 400) log.shift(); } };
    child.stdout?.on("data", add); child.stderr?.on("data", add);
    child.on("exit", (code) => { log.push(`(development servers exited with code ${code})`); });
    this.#dev = { child, startedAt: new Date().toISOString(), log };
    return this.status();
  }

  #stopDev(): OpsStatus {
    const d = this.#dev;
    if (d && d.child.exitCode === null && d.child.pid) killTree(d.child.pid);
    return this.status();
  }

  /** Studio is closing: nothing it started keeps running. */
  close(): void { this.#stopDev(); }
}
