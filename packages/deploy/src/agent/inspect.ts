import { existsSync, readFileSync, readdirSync, statfsSync } from "node:fs";
import { arch, cpus, release, userInfo, platform, totalmem, freemem } from "node:os";
import { AGENT_VERSION } from "../protocol.ts";
import { discoverVhosts, defaultDiscoveryDirs, findNginx, nginxTest } from "./nginx.ts";
import { probe } from "./runtime.ts";
import { systemdAvailable, type SystemdAvailability } from "./systemd.ts";
import { inspectPrivilege, type PrivilegeReport } from "./visibility.ts";
import { P, readJson, type AgentState } from "./state.ts";

/** Remote capability discovery. Read-only: nothing is installed, started or changed. Every probe is a fixed argv, never a shell string. */
export interface Inspection {
  agent: { version: string; mode: string; environmentId: string; home: string };
  os: { platform: string; release: string; arch: string; distro?: string };
  user: { name: string; uid: number; root: boolean };
  cpu: { count: number; model?: string };
  memory: { totalMb: number; availableMb: number };
  disk: { path: string; totalMb: number; freeMb: number };
  tools: Record<"node" | "java" | "git" | "nginx" | "docker" | "systemd" | "npm" | "sudo", { available: boolean; version?: string; note?: string }>;
  systemd: SystemdAvailability;
  /** EFFECTIVE sudo privilege of the agent user (never inferred from a privileged command having worked) */
  privilege: PrivilegeReport;
  listeningPorts: Array<{ port: number; address: string }>;
  nginx: { vhosts: Array<{ file: string; managed: boolean; app?: string; serverNames: string[]; listens: string[] }>; configValid?: boolean; configOutput?: string; managedDir: string; managedDirWritable: boolean };
  pso: { apps: Array<{ name: string; activeRelease?: string; releases: number }>; agentHome: string };
  capabilities: string[];
  blockers: string[];
}

const mb = (n: number): number => Math.round(n / 1024 / 1024);
const ver = (out: string): string | undefined => /(\d+\.\d+(?:\.\d+)?(?:[-+._]\w+)*)/.exec(out)?.[1];

export function listeningPorts(): Array<{ port: number; address: string }> {
  const out: Array<{ port: number; address: string }> = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const c = line.trim().split(/\s+/); if (c[3] !== "0A" || !c[1]) continue;
      const [addr, port] = c[1].split(":"); out.push({ port: parseInt(port!, 16), address: f.endsWith("6") ? (/^0+$/.test(addr!) ? "::" : addr!.startsWith("0000000000000000FFFF0000") || /^0+0100007F$/i.test(addr!) ? "127.0.0.1" : "other") : addr === "0100007F" ? "127.0.0.1" : addr === "00000000" ? "0.0.0.0" : "other" });
    }
  }
  return out.filter((p, i, a) => a.findIndex((q) => q.port === p.port && q.address === p.address) === i).sort((a, b) => a.port - b.port);
}

export function inspect(state: AgentState): Inspection {
  const policy = state.policy();
  const home = state.home;
  let distro: string | undefined;
  try { distro = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync("/etc/os-release", "utf8"))?.[1]; } catch { /* not Linux */ }
  let available = freemem();
  try { const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8")); if (m) available = Number(m[1]) * 1024; } catch { /* not Linux */ }
  let disk = { totalMb: 0, freeMb: 0 };
  try { const s = statfsSync(home); disk = { totalMb: mb(s.blocks * s.bsize), freeMb: mb(s.bavail * s.bsize) }; } catch { /* unsupported */ }
  const node = { available: true, version: process.versions.node };
  const j = probe("java", ["-version"]); const g = probe("git", ["--version"]); const d = probe("docker", ["--version"]); const npm = probe("npm", ["--version"]);
  const sdAvail = systemdAvailable(); const sudo = probe("sudo", ["-n", "-l"]);
  const ngBin = findNginx(); const ngv = ngBin ? probe(ngBin, ["-v"]) : { ok: false, out: "" };
  const nginxPresent = !!ngBin && ngv.ok;
  const managedDir = policy.nginxManagedDir;
  let writable = false; try { writable = existsSync(managedDir) && probe("test", ["-w", managedDir]).ok; } catch { /* unknown */ }
  const ngTest = nginxPresent ? nginxTest(policy) : undefined;
  const apps = existsSync(P.apps(home)) ? readdirSync(P.apps(home)).map((a) => {
    const s = readJson<{ active?: { release: string }; releases?: string[] }>(`${P.app(a, home)}/app.json`, {});
    return { name: a, ...(s.active ? { activeRelease: s.active.release } : {}), releases: s.releases?.length ?? 0 };
  }) : [];
  const caps: string[] = ["ssh-private-agent", "git-release", "process-slots"];
  if (nginxPresent) caps.push("nginx-proxy"); if (j.ok) caps.push("java"); if (d.ok) caps.push("docker"); if (sdAvail.available) caps.push("systemd-user");
  const blockers: string[] = [];
  if (!g.ok) blockers.push("git is not installed (needed for git sources; artifact sources still work)");
  if (!nginxPresent) blockers.push("nginx is not installed: blue-green and rolling need it (recreate with a fixed port still works)");
  else if (ngTest && !ngTest.ok) blockers.push("nginx -t fails on the CURRENT configuration (or the agent may not run it): PSO will not change a proxy it cannot validate");
  if (nginxPresent && !writable && policy.nginxLayout === "pso.d") blockers.push(`${managedDir} is missing or not writable by the agent user: an administrator must create it (see provision:plan)`);
  return {
    agent: { version: AGENT_VERSION, mode: policy.mode, environmentId: state.env().id, home },
    os: { platform: platform(), release: release(), arch: arch(), ...(distro ? { distro } : {}) },
    user: { name: userInfo().username, uid: process.getuid?.() ?? -1, root: process.getuid?.() === 0 },
    cpu: { count: cpus().length, model: cpus()[0]?.model },
    memory: { totalMb: mb(totalmem()), availableMb: mb(available) },
    disk: { path: home, ...disk },
    tools: {
      node, java: { available: j.ok, ...(ver(j.out) ? { version: ver(j.out)! } : {}) }, git: { available: g.ok, ...(ver(g.out) ? { version: ver(g.out)! } : {}) },
      nginx: { available: nginxPresent, ...(ver(ngv.out) ? { version: ver(ngv.out)! } : {}) }, docker: { available: d.ok, ...(ver(d.out) ? { version: ver(d.out)! } : {}) },
      systemd: { available: sdAvail.available, ...(sdAvail.version ? { version: sdAvail.version } : {}), note: "user manager only (no root, no units under /etc)" }, npm: { available: npm.ok, ...(ver(npm.out) ? { version: ver(npm.out)! } : {}) },
      sudo: { available: sudo.ok || /may run|NOPASSWD/.test(sudo.out), note: "availability only: the effective privilege level is in `privilege`" },
    },
    systemd: sdAvail,
    privilege: inspectPrivilege(),
    listeningPorts: listeningPorts(),
    nginx: { vhosts: discoverVhosts(defaultDiscoveryDirs(policy)), ...(ngTest ? { configValid: ngTest.ok, configOutput: ngTest.ok ? "" : ngTest.out.slice(0, 500) } : {}), managedDir, managedDirWritable: writable },
    pso: { apps, agentHome: home },
    capabilities: caps,
    blockers,
  };
}
