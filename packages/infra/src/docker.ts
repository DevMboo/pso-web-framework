import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InfraError } from "./contract.ts";
import { EDGE_REPOSITORY, ensureEdgeImage } from "./edge.ts";
import { paths } from "./render.ts";
import { managedIdentity, type Topology } from "./topology.ts";

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

type ComposeOptions = { onLine?: (l: string) => void; inherit?: boolean; env?: NodeJS.ProcessEnv };
/**
 * Runs `docker compose ...`; output streamed to `onLine` (or inherited). Resolves with the exit code. Every `up` that starts the edge first
 * makes sure the framework's edge image exists (built from this installation when missing) and has nginx test the edge configuration
 * exactly as the container will see it: a configuration nginx rejects is never started, and a running edge keeps serving.
 */
export async function compose(c: ComposeTarget, args: string[], o: ComposeOptions = {}): Promise<number> {
  if (args[0] === "up") { const pre = await prepareEdge(c, args, o); if (pre !== 0) return pre; }
  return run(c, args, o);
}

const EDGE_IMAGE_LINE = new RegExp(String.raw`^\s*image: "(${EDGE_REPOSITORY}:[0-9a-f]+)"\s*$`, "m");
// options of `compose up` that take a value: anything else that is not an option names a service
const UP_VALUE_OPTIONS = new Set(["--wait-timeout", "--timeout", "-t", "--scale", "--pull", "--exit-code-from", "--attach", "--no-attach"]);
function upTargets(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) { const a = args[i]!; if (UP_VALUE_OPTIONS.has(a)) i++; else if (!a.startsWith("-")) out.push(a); }
  return out;
}
async function prepareEdge(c: ComposeTarget, args: string[], o: ComposeOptions): Promise<number> {
  if (!existsSync(c.file)) return 0;
  const m = EDGE_IMAGE_LINE.exec(readFileSync(c.file, "utf8"));
  const targets = upTargets(args);
  if (!m || (targets.length && !targets.includes("edge"))) return 0;
  const log = o.onLine ?? ((l: string) => { if (o.inherit) console.log(l); });
  try { await ensureEdgeImage(m[1]!, log); } catch (e) { log(`${(e as Error).message}${(e as InfraError).hint ? `. ${(e as InfraError).hint}` : ""}`); return 1; }
  const lines: string[] = [];
  const code = await run(c, ["run", "--rm", "--no-deps", "-T", "edge", "nginx", "-e", "stderr", "-t"], { onLine: (l) => lines.push(l), ...(o.env ? { env: o.env } : {}) });
  if (code !== 0) {
    for (const l of lines.filter((x) => /emerg|alert|crit|error|failed/i.test(x))) log(`  ${l}`);
    log(`the edge configuration was rejected by nginx -t (exit ${code}): nothing was started, a running edge keeps its configuration`);
    return code;
  }
  log("edge configuration accepted by nginx -t");
  return 0;
}

function run(c: ComposeTarget, args: string[], o: ComposeOptions): Promise<number> {
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
    if (managedIdentity(t)) out.push({ container: "idp", host: "127.0.0.1", port: t.httpsPort });
    if (t.redis?.provider === "container") out.push({ container: "redis", host: "127.0.0.1", port: t.redis.port });
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

/**
 * The dependency graph of the containers, exactly as the generated compose file declares it (depends_on ... service_healthy): every node
 * starts only after the nodes it lists are healthy. The key server, the databases and Redis need nothing, so the graph has no cycle.
 */
export function containerGraph(t: Topology): Record<string, string[]> {
  const nodes: Record<string, string[]> = {};
  const redis = t.redis?.provider === "container";
  for (const s of t.services) nodes[s.name] = [...s.dependsOn, ...(s.db ? [`${s.name}-db`] : []), ...(managedIdentity(t) && s.authentication === "infrastructure" ? ["idp"] : []), ...(redis && s.redisVariables.length ? ["redis"] : []), ...(s.role === "orchestrator" ? t.services.filter((x) => x.role !== "orchestrator").map((x) => x.name) : [])];
  for (const s of t.services.filter((x) => x.db)) nodes[`${s.name}-db`] = [];
  if (managedIdentity(t)) nodes["idp"] = [];
  if (redis) nodes["redis"] = [];
  for (const f of t.frontends) nodes[f.name] = [];
  nodes["edge"] = [...t.frontends.map((f) => f.name), ...(t.orchestrator ? [t.orchestrator.name] : []), ...(managedIdentity(t) ? ["idp"] : [])];
  return nodes;
}

/** A dependency cycle among the containers (none in a generated topology); the names in order, or undefined. */
export function dependencyCycle(graph: Record<string, string[]>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === "done") return undefined;
    if (state.get(n) === "visiting") return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, "visiting"); stack.push(n);
    for (const d of graph[n] ?? []) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(n, "done");
    return undefined;
  };
  for (const n of Object.keys(graph).sort()) { const c = visit(n); if (c) return c; }
  return undefined;
}

/** The services of the stack in dependency order (dependencies first), from the generated compose model. */
export function startupOrder(t: Topology): string[] {
  const nodes = containerGraph(t);
  const out: string[] = [], seen = new Set<string>();
  const visit = (n: string) => { if (seen.has(n)) return; seen.add(n); for (const d of nodes[n] ?? []) visit(d); out.push(n); };
  Object.keys(nodes).sort().forEach(visit);
  return out;
}

/** Every container a service needs, transitively (for `--with-dependencies` and selective starts). */
export function dependenciesOf(t: Topology, names: string[]): string[] {
  const order = startupOrder(t);
  const graph = containerGraph(t);
  const need = new Set<string>();
  const walk = (n: string) => { if (need.has(n)) return; need.add(n); for (const d of graph[n] ?? []) walk(d); };
  names.forEach(walk);
  return order.filter((n) => need.has(n));
}
