import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { InfraError } from "./contract.ts";
import { paths } from "./render.ts";
import type { Topology } from "./topology.ts";

/**
 * The container engine runs on Docker Engine and Compose; PSO does not reimplement a runtime. What PSO owns is everything around it: the
 * topology (generated from the declarations), dependency resolution, the order of operations, health verification and safe defaults
 * (data volumes are kept unless their removal is explicitly authorized).
 */
export function dockerReady(): { ok: boolean; version?: string; compose?: string; reason?: string } {
  const v = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (v.error) return { ok: false, reason: "docker is not installed or not on PATH" };
  if (v.status !== 0) return { ok: false, reason: "the Docker daemon is not running (start Docker Desktop or dockerd)" };
  const c = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (c.status !== 0) return { ok: false, reason: "Docker Compose v2 is not available (docker compose)" };
  return { ok: true, version: v.stdout.trim(), compose: c.stdout.trim() };
}

export interface ComposeTarget { root: string; file: string; project: string }
export function composeTarget(root: string, t: Topology, mode: "stack" | "dependencies" = "stack"): ComposeTarget {
  const rel = mode === "stack" ? paths.compose(t.env) : paths.composeDeps(t.env);
  const file = join(root, ...rel.split("/"));
  if (!existsSync(file)) throw new InfraError(`${rel} has not been generated`, "PSO_DOCKER_NOT_GENERATED", `Run: pso infra:apply --env ${t.env}`);
  return { root, file, project: mode === "stack" ? t.project : `${t.project}-deps` };
}
const base = (c: ComposeTarget): string[] => ["compose", "-f", c.file, "--project-directory", c.root, "-p", c.project];

/** Runs `docker compose ...`; output streamed to `onLine` (or inherited). Resolves with the exit code. */
export function compose(c: ComposeTarget, args: string[], o: { onLine?: (l: string) => void; inherit?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("docker", [...base(c), ...args], { cwd: c.root, stdio: o.inherit ? "inherit" : ["ignore", "pipe", "pipe"], env: { ...process.env, ...(o.env ?? {}) }, windowsHide: true });
    const pipe = (s: NodeJS.ReadableStream | null) => { if (!s || !o.onLine) return; let buf = ""; s.on("data", (d: Buffer) => { buf += d.toString(); const ls = buf.split(/\r?\n/); buf = ls.pop() ?? ""; for (const l of ls) if (l.trim()) o.onLine!(l); }); s.on("end", () => { if (buf.trim()) o.onLine!(buf); }); };
    pipe(p.stdout); pipe(p.stderr);
    p.on("error", () => resolve(127));
    p.on("exit", (code) => resolve(code ?? 1));
  });
}
export function composeSync(c: ComposeTarget, args: string[], timeout = 120_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("docker", [...base(c), ...args], { cwd: c.root, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export interface ContainerRow { service: string; name: string; state: string; health: string; status: string; ports: string; image: string }
export function ps(c: ComposeTarget): ContainerRow[] {
  const r = composeSync(c, ["ps", "--all", "--format", "json"]);
  if (r.status !== 0) throw new InfraError(`docker compose ps failed: ${r.stderr.trim().split("\n").pop() ?? ""}`, "PSO_DOCKER_PS");
  const text = r.stdout.trim();
  if (!text) return [];
  const rows: Array<Record<string, unknown>> = text.startsWith("[") ? JSON.parse(text) as Array<Record<string, unknown>> : text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return rows.map((x) => ({ service: String(x["Service"] ?? ""), name: String(x["Name"] ?? ""), state: String(x["State"] ?? ""), health: String(x["Health"] ?? ""), status: String(x["Status"] ?? ""), ports: String(x["Ports"] ?? ""), image: String(x["Image"] ?? "") })).sort((a, b) => (a.service < b.service ? -1 : 1));
}

/** Host ports a compose mode publishes, with the container that publishes each one. */
export function publishedPorts(t: Topology, mode: "stack" | "dependencies"): Array<{ container: string; host: string; port: number }> {
  const out: Array<{ container: string; host: string; port: number }> = [];
  const loop = t.kind === "development" ? "127.0.0.1" : "0.0.0.0";
  if (mode === "dependencies") {
    t.services.filter((s) => s.db).forEach((s, i) => out.push({ container: `${s.name}-db`, host: "127.0.0.1", port: 5432 + i }));
    if (t.identity?.provider === "keycloak") out.push({ container: "idp", host: "127.0.0.1", port: t.httpsPort });
    return out;
  }
  out.push({ container: "edge", host: loop, port: t.httpsPort });
  if (t.kind === "development" && t.decl.publishServices === true) for (const s of t.services) out.push({ container: s.name, host: "127.0.0.1", port: s.port });
  return out;
}

/** Published ports that something other than this stack already uses: found BEFORE anything is started. */
export async function portConflicts(c: ComposeTarget, t: Topology, mode: "stack" | "dependencies", only?: string[]): Promise<Array<{ container: string; port: number }>> {
  const { createServer } = await import("node:net");
  const free = (host: string, port: number) => new Promise<boolean>((res) => { const s = createServer(); s.once("error", () => res(false)); s.listen(port, host, () => s.close(() => res(true))); });
  let running: ContainerRow[] = [];
  try { running = ps(c).filter((r) => r.state === "running"); } catch { /* not started */ }
  const out: Array<{ container: string; port: number }> = [];
  for (const p of publishedPorts(t, mode)) {
    if (only && !only.includes(p.container)) continue;
    if (running.some((r) => r.service === p.container)) continue; // held by this stack's own container
    if (!(await free(p.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1", p.port))) out.push({ container: p.container, port: p.port });
  }
  return out;
}

/** The services of the stack in dependency order (dependencies first), from the generated compose model. */
export function startupOrder(t: Topology): string[] {
  const nodes: Record<string, string[]> = {};
  for (const s of t.services) nodes[s.name] = [...s.dependsOn, ...(s.db ? [`${s.name}-db`] : []), ...(t.identity?.provider === "keycloak" ? ["idp"] : []), ...(s.role === "orchestrator" ? t.services.filter((x) => x.role !== "orchestrator").map((x) => x.name) : [])];
  for (const s of t.services.filter((x) => x.db)) nodes[`${s.name}-db`] = [];
  if (t.identity?.provider === "keycloak") nodes["idp"] = [];
  for (const f of t.frontends) nodes[f.name] = [];
  nodes["edge"] = [...t.frontends.map((f) => f.name), ...(t.orchestrator ? [t.orchestrator.name] : []), ...(t.identity?.provider === "keycloak" ? ["idp"] : [])];
  const out: string[] = [], seen = new Set<string>();
  const visit = (n: string) => { if (seen.has(n)) return; seen.add(n); for (const d of nodes[n] ?? []) visit(d); out.push(n); };
  Object.keys(nodes).sort().forEach(visit);
  return out;
}

/** Every container a service needs, transitively (for `--with-dependencies` and selective starts). */
export function dependenciesOf(t: Topology, names: string[]): string[] {
  const order = startupOrder(t);
  const graph: Record<string, string[]> = {};
  for (const s of t.services) graph[s.name] = [...s.dependsOn, ...(s.db ? [`${s.name}-db`] : []), ...(t.identity?.provider === "keycloak" ? ["idp"] : []), ...(s.role === "orchestrator" ? t.services.filter((x) => x.role !== "orchestrator").map((x) => x.name) : [])];
  graph["edge"] = [...t.frontends.map((f) => f.name), ...(t.orchestrator ? [t.orchestrator.name] : []), ...(t.identity?.provider === "keycloak" ? ["idp"] : [])];
  const need = new Set<string>();
  const walk = (n: string) => { if (need.has(n)) return; need.add(n); for (const d of graph[n] ?? []) walk(d); };
  names.forEach(walk);
  return order.filter((n) => need.has(n));
}
