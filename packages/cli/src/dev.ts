import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LifecycleManager, WORKSPACE_FILE, type ServiceDecl, type WorkspaceConfig, type State } from "@pso/core";
import { formatLine, type LogConfig } from "@pso/http";
import { CliError } from "./fsx.ts";
import { npmInvocation } from "./proc.ts";
import { describeSources, effectiveProjectEnv } from "./project-env.ts";
import { processEnvironment } from "@pso/infra";

/**
 * Colour for the `pso dev` terminal. The services' output is piped (so it can be mirrored into .pso/logs), which makes every child believe it is
 * not on a terminal and print plain text. `pso dev` therefore asks them for colour when ITS OWN stdout is a terminal, and colours the orchestrator's
 * JSON lines itself; the log files always keep clean, structured text (no escape codes, JSON preserved).
 * Opt out with NO_COLOR or PSO_LOG_COLOR=never; FORCE_COLOR / PSO_LOG_COLOR=always force it when output is redirected.
 */
export function devColor(env: NodeJS.ProcessEnv = process.env, tty: boolean = process.stdout.isTTY === true): boolean {
  const mode = (env["PSO_LOG_COLOR"] ?? "auto").toLowerCase();
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "") return env["FORCE_COLOR"] !== "0" && env["FORCE_COLOR"] !== "false";
  return tty && env["CI"] === undefined && env["TERM"] !== "dumb";
}
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, "");
const SERVICE_COLORS = ["36", "35", "34", "96", "95", "94"]; // cyan, magenta, blue and their bright variants: distinct from the level colours (green/yellow/red)
const PRETTY_COLOR: LogConfig = { level: "trace", format: "pretty", color: true, stack: false };
/** Formats one line of a service for the terminal: structured orchestrator lines become pretty and coloured, everything else is kept as is. */
export function terminalLine(name: string, index: number, line: string, color: boolean): string {
  if (!color) return `[${name}] ${line}`;
  const prefix = `\u001b[${SERVICE_COLORS[index % SERVICE_COLORS.length]}m[${name}]\u001b[0m`;
  const text = line.trimStart();
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      if (typeof o["level"] === "string" && typeof o["msg"] === "string") {
        const { ts, level, msg, ...ctx } = o;
        return `${prefix} ${formatLine(PRETTY_COLOR, (level as "info"), msg as string, ctx, typeof ts === "string" ? new Date(ts) : new Date())}`;
      }
    } catch { /* not a structured line */ }
  }
  return `${prefix} ${line}`;
}

export interface RegistryEntry {
  name: string;
  runtime: string;
  role: string;
  url: string;
  health: string;
  port: number;
  pid: number | null;
  /** lifecycle state of the process (DISCOVERED..STOPPED, FAILED) */
  state: State;
  /** result of the last health probe */
  status: "UP" | "DOWN" | "UNKNOWN";
  lastCheck: string | null;
  error?: string;
}

export interface DevOptions {
  root: string;
  config: WorkspaceConfig;
  only?: string[];
  readyTimeoutMs?: number;
  healthIntervalMs?: number;
  install?: boolean;
  log?: (line: string) => void;
  /** the external environment (default: process.env); a test passes its own */
  env?: NodeJS.ProcessEnv;
  /**
   * 0.2.0: the workspace has pso.infra.json. Each service also receives the environment the infrastructure engine prepared for it
   * (`.infra/env/<env>/<service>.env`: identity provider, databases of the dependencies stack), below everything else; `secret://`
   * references are resolved now, into the child's environment only. "" means the contract's default environment.
   */
  infraEnv?: string;
}

/**
 * The environment one service is started with: its own files (see project-env.ts) under the environment `pso dev` runs in, plus
 * what the workspace declares for it. A variable written for one service never reaches another one.
 */
export function devEnvironment(root: string, s: ServiceDecl, base: NodeJS.ProcessEnv, color: boolean): { env: NodeJS.ProcessEnv; notes: string[] } {
  const e = effectiveProjectEnv(root, s, base);
  const notes: string[] = [];
  if (e.sources.length) notes.push(`environment: ${describeSources(e)}`);
  if (e.overriddenByEnvironment.length) notes.push(`${e.overriddenByEnvironment.join(", ")} ${e.overriddenByEnvironment.length > 1 ? "come" : "comes"} from the environment of \`pso dev\`, which takes precedence over the service's files`);
  if (e.ignoredDeclared.length) notes.push(`${e.ignoredDeclared.join(", ")} in an environment file ${e.ignoredDeclared.length > 1 ? "are" : "is"} ignored: ${e.ignoredDeclared.length > 1 ? "they come" : "it comes"} from pso.workspace.json`);
  const env: NodeJS.ProcessEnv = {
    ...e.env,
    PORT: String(s.port), HOST: "127.0.0.1", PSO_WORKSPACE: join(root, WORKSPACE_FILE), PSO_SERVICE: s.name,
    // `pso dev` is a local development session: Spring services get the "local" profile unless the developer chose another one
    ...(s.runtime === "spring-boot" && !e.env["SPRING_PROFILES_ACTIVE"] ? { SPRING_PROFILES_ACTIVE: "local" } : {}),
    ...(color && e.env["PSO_LOG_COLOR"] === undefined ? { PSO_LOG_COLOR: "always" } : {}),
    // development diagnostics: the message and stack of an unexpected error are logged (never in production, whatever this says)
    ...(e.env["PSO_LOG_ERROR_DETAILS"] === undefined && e.environment !== "production" ? { PSO_LOG_ERROR_DETAILS: "true" } : {}),
  };
  return { env, notes };
}

export interface DevSession {
  registry(): RegistryEntry[];
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    await r.arrayBuffer();
    return r.status === 200;
  } catch {
    return false;
  }
}

/** argv for a service; never goes through a shell. */
export function devCommand(s: ServiceDecl): string[] {
  if (s.dev?.command) return s.dev.command;
  // the orchestrator is compiled (decorators are not executable by Node directly): `npm run dev` = tsc + node dist/main.js
  if (s.runtime === "node") return process.platform === "win32" ? ["cmd.exe", "/d", "/c", "npm", "run", "dev"] : ["npm", "run", "dev"];
  return process.platform === "win32" ? ["cmd.exe", "/d", "/c", ".\\mvnw.cmd", "spring-boot:run"] : ["./mvnw", "spring-boot:run"];
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } }
}

export async function startDev(opts: DevOptions): Promise<DevSession> {
  const log = opts.log ?? (() => {});
  const names = new Set(opts.only ?? opts.config.services.map((s) => s.name));
  const services = opts.config.services.filter((s) => names.has(s.name));
  for (const n of names) if (!services.some((s) => s.name === n)) throw new CliError(`Unknown service "${n}"`);

  const entries = new Map<string, RegistryEntry>();
  const procs = new Map<string, ChildProcess>();
  const lc = new LifecycleManager();
  const regFile = join(opts.root, ".pso", "registry.json");
  const timeout = opts.readyTimeoutMs ?? 120_000;

  const persist = () => {
    for (const e of entries.values()) { const st = lc.state(e.name); e.state = st.state; if (st.error) e.error = st.error; }
    mkdirSync(join(opts.root, ".pso"), { recursive: true });
    const tmpFile = `${regFile}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify({ workspace: opts.config.name, pid: process.pid, services: [...entries.values()] }, null, 2));
    renameSync(tmpFile, regFile); // atomic: readers never see a half-written file
  };

  for (const s of services) {
    const e: RegistryEntry = { name: s.name, runtime: s.runtime, role: s.role ?? "service", url: `http://127.0.0.1:${s.port}`, health: s.health ?? "/actuator/health", port: s.port, pid: null, state: "REGISTERED", status: "UNKNOWN", lastCheck: null };
    entries.set(s.name, e);
    const dir = join(opts.root, ...s.path.split("/"));
    lc.register({
      id: s.name,
      dependsOn: (s.dependsOn ?? []).filter((d) => names.has(d)),
      async init() {
        if (!existsSync(dir)) throw new Error(`path "${s.path}" does not exist`);
        if (!(await portFree(s.port))) throw new Error(`port ${s.port} is already in use (PSO_PORT_IN_USE)`);
        if (s.runtime === "node" && !s.dev && existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"))) {
          if (!opts.install) throw new Error(`dependencies are not installed: run "npm install" in ${s.path} or pass --install`);
          log(`[${s.name}] npm install`);
          const npm = npmInvocation("npm", ["install", "--no-audit", "--no-fund"]);
          const r = spawnSync(npm.command, npm.args, { cwd: dir, stdio: "ignore" });
          if (r.status !== 0) throw new Error("npm install failed");
        }
      },
      async start() {
        const [cmd, ...args] = devCommand(s);
        const serviceIndex = [...names].indexOf(s.name);
        const color = devColor();
        // every service gets its own environment: its files, then the environment of this command, then what the workspace declares
        const started = devEnvironment(opts.root, s, opts.env ?? process.env, color);
        for (const n of started.notes) log(`[pso] ${s.name}: ${n}`);
        if (opts.infraEnv !== undefined) {
          const pe = processEnvironment(opts.root, s.name, opts.infraEnv || undefined);
          if (pe) {
            const added = Object.keys(pe.vars).filter((k) => started.env[k] === undefined);
            for (const k of added) started.env[k] = pe.vars[k];
            if (added.length) log(`[pso] ${s.name}: infrastructure environment "${pe.env}" (${pe.file}): ${added.length} variable(s)${pe.secrets.length ? `, secrets resolved for ${pe.secrets.join(", ")} (values not shown)` : ""}`);
            if (pe.missing.length) throw new Error(`secret(s) ${pe.missing.join(", ")} are not provisioned for "${pe.env}": run pso infra:apply --env ${pe.env}`);
          }
        }
        const child = spawn(cmd!, args, { cwd: dir, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: started.env });
        procs.set(s.name, child);
        e.pid = child.pid ?? null;
        mkdirSync(join(opts.root, ".pso", "logs"), { recursive: true });
        const logFile = join(opts.root, ".pso", "logs", `${s.name}.log`);
        writeFileSync(logFile, ""); // fresh log per session
        const out = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => { const clean = stripAnsi(l); log(terminalLine(s.name, serviceIndex, l, color)); try { appendFileSync(logFile, clean + "\n"); } catch { /* logging must never crash the supervisor */ } });
        child.stdout!.on("data", out);
        child.stderr!.on("data", out);
        let exited: number | null | undefined;
        child.once("exit", (code) => { exited = code ?? -1; });
        child.once("error", (err) => { exited = -2; log(`[${s.name}] failed to spawn: ${err.message}`); });
        const deadline = Date.now() + timeout;
        const url = `${e.url}${e.health}`;
        while (Date.now() < deadline) {
          if (exited !== undefined) throw new Error(`process exited with code ${exited} before becoming ready`);
          if (await probe(url)) { e.status = "UP"; e.lastCheck = new Date().toISOString(); persist(); return; }
          await sleep(300);
        }
        throw new Error(`not ready after ${timeout} ms (${url})`);
      },
      async stop() {
        const child = procs.get(s.name);
        if (!child) return;
        const done = new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
        killTree(child);
        await Promise.race([done, sleep(10_000)]);
        if (child.exitCode === null && process.platform !== "win32") { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
        e.status = "DOWN"; e.pid = null;
      },
    });
  }

  /** Kills every process this session spawned, whatever its lifecycle state (a FAILED service may still be running). */
  const killRemaining = async () => {
    const live = [...procs.entries()].filter(([, c]) => c.exitCode === null && c.signalCode === null);
    for (const [, c] of live) killTree(c);
    await Promise.all(live.map(([, c]) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())))));
    for (const [n] of live) { const e = entries.get(n)!; e.status = "DOWN"; e.pid = null; }
  };

  persist();
  try {
    await lc.start();
  } catch (err) {
    await lc.stop();
    await killRemaining();
    persist();
    throw new CliError((err as Error).message, "See the service log lines above; fix the cause and re-run `pso dev`");
  }
  persist();

  // continuous health monitoring
  const monitor = setInterval(async () => {
    for (const e of entries.values()) {
      if (lc.state(e.name).state !== "READY") continue;
      const ok = await probe(`${e.url}${e.health}`);
      const next = ok ? "UP" : "DOWN";
      if (next !== e.status) log(`[pso] ${e.name} is now ${next}`);
      e.status = next;
      e.lastCheck = new Date().toISOString();
    }
    persist();
  }, opts.healthIntervalMs ?? 5000);
  monitor.unref();

  return {
    registry: () => { persist(); return [...entries.values()].map((e) => ({ ...e })); },
    async stop() {
      clearInterval(monitor);
      await lc.stop();
      await killRemaining();
      persist();
    },
  };
}

export const readRegistry = (root: string): { workspace: string; pid: number; services: RegistryEntry[] } | undefined => {
  try { return JSON.parse(readFileSync(join(root, ".pso", "registry.json"), "utf8")); } catch { return undefined; }
};
