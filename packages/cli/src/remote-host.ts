import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud, askpassEnv, sshBaseArgs, sshExec, openTunnel, type ConnectionRecord, type SshContext, type Tunnel } from "@pso/deploy";
import { checkAuthority, checkLeaf, type Topology } from "@pso/infra";
import { CliError } from "./fsx.ts";

/**
 * The remote host provider (0.2.0): a Linux host reached over SSH with a connection registered by `pso connection:add` (pinned host key,
 * key file / agent / credential-store reference; nothing secret in the workspace). It runs a small set of FIXED commands built from validated
 * values, never a command typed by a user, and never installs packages, changes the firewall or touches anything outside its root.
 */
export const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/;
export const assertRemotePath = (p: string, what: string): string => { if (!SAFE_PATH.test(p) || p.split("/").includes("..")) throw new CliError(`${what} "${p}" must be an absolute POSIX path without ".."`); return p; };

export class RemoteHost {
  readonly name: string;
  readonly connection: ConnectionRecord;
  private readonly ctx: SshContext;
  constructor(name: string, cloud = new Cloud()) {
    this.name = name;
    try { const s = cloud.sshFor(name); this.connection = s.connection; this.ctx = s.ctx; }
    catch (e) { throw new CliError((e as Error).message, `Register the host first: pso connection:add ${name} --host <host> --user <user> --auth agent|key --accept-host-key <SHA256:...>`); }
  }
  exec(command: string, input?: string | Buffer, timeoutMs = 120_000) { return sshExec(this.connection, this.ctx, command, input, timeoutMs); }
  /** Streams a local program's standard output into a remote command's standard input (docker save | docker load, tar). */
  pipe(local: string[], remoteCommand: string, onLine?: (l: string) => void): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
      const ask = askpassEnv(this.ctx.secrets);
      const ssh = spawn("ssh", [...sshBaseArgs(this.connection, this.ctx), "--", remoteCommand], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ask.env }, windowsHide: true });
      const src = spawn(local[0]!, local.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let err = "";
      src.stdout.pipe(ssh.stdin);
      src.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      ssh.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      ssh.stdout.on("data", (d: Buffer) => { for (const l of d.toString().split(/\r?\n/)) if (l.trim()) onLine?.(l); });
      let srcCode = 0;
      src.on("exit", (c) => { srcCode = c ?? 1; });
      ssh.on("exit", (c) => { ask.cleanup(); resolve({ code: srcCode || (c ?? 1), stderr: err.slice(-2000) }); });
      src.on("error", (e) => { err += e.message; ssh.stdin.end(); });
    });
  }
  tunnel(localPort: number, remotePort: number): Tunnel { return openTunnel(this.connection, this.ctx, localPort, remotePort); }
}

export interface HostFacts {
  host: string; user: string; os: string; arch: string; kernel: string;
  docker: string | null; compose: string | null; dockerAccess: boolean;
  root: string; rootWritable: boolean; diskFreeMb: number | null;
  listening: number[]; deployments: Array<{ project: string; release: string | null }>;
  registry: "reachable" | "unreachable" | "unknown";
}

/** One round trip: facts about the host, as key=value lines. Read-only. */
export function inspectHost(h: RemoteHost, root = "/srv/pso"): HostFacts {
  assertRemotePath(root, "deploy root");
  const script = [
    "echo user=$(id -un)", "echo os=$( . /etc/os-release 2>/dev/null; echo \"${PRETTY_NAME:-$(uname -s)}\")", "echo arch=$(uname -m)", "echo kernel=$(uname -r)",
    "echo docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null)", "echo compose=$(docker compose version --short 2>/dev/null)",
    `R=${q(root)}`, "P=$R; while [ ! -d \"$P\" ]; do P=$(dirname \"$P\"); done",
    "if [ -w \"$P\" ]; then echo rootWritable=yes; else echo rootWritable=no; fi",
    "echo diskFreeKb=$(df -Pk \"$P\" 2>/dev/null | awk 'NR==2{print $4}')",
    "echo listening=$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{for(i=1;i<=NF;i++) if ($i ~ /:[0-9]+$/) {n=split($i,a,\":\"); print a[n]; break}}' | sort -un | tr '\\n' ',')",
    "for d in \"$R\"/*/; do [ -d \"$d\" ] || continue; c=$(readlink \"$d/current\" 2>/dev/null); echo \"deployment=$(basename \"$d\")|$(basename \"${c:-none}\")\"; done",
    "if getent hosts registry-1.docker.io >/dev/null 2>&1; then echo registry=reachable; else echo registry=unreachable; fi",
  ].join("; ");
  const r = h.exec(script, undefined, 60_000);
  if (r.status !== 0 && !r.stdout) throw new CliError(`cannot inspect ${h.name}: ${r.stderr.trim() || `ssh exited ${r.status}`}`, "pso connection:test " + h.name);
  const kv = new Map<string, string[]>();
  for (const l of r.stdout.split(/\r?\n/)) { const i = l.indexOf("="); if (i > 0) kv.set(l.slice(0, i), [...(kv.get(l.slice(0, i)) ?? []), l.slice(i + 1).trim()]); }
  const one = (k: string) => kv.get(k)?.[0] ?? "";
  return {
    host: `${h.connection.user}@${h.connection.host}:${h.connection.port}`, user: one("user"), os: one("os"), arch: one("arch"), kernel: one("kernel"),
    docker: one("docker") || null, compose: one("compose") || null, dockerAccess: !!one("docker"),
    root, rootWritable: one("rootWritable") === "yes", diskFreeMb: one("diskFreeKb") ? Math.round(Number(one("diskFreeKb")) / 1024) : null,
    listening: one("listening").split(",").filter(Boolean).map(Number).filter((n) => Number.isInteger(n)),
    deployments: (kv.get("deployment") ?? []).map((x) => { const [p, rel] = x.split("|"); return { project: p!, release: rel && rel !== "none" ? rel : null }; }),
    registry: (one("registry") as HostFacts["registry"]) || "unknown",
  };
}

export interface HostFinding { severity: "error" | "warning" | "info"; check: string; message: string }

/**
 * The prerequisites of deploying one environment on this host: Docker and Compose usable by the deploy user, a writable root with free
 * space, the edge port free (or held by this environment's own release), and every certificate and secret the operator must supply,
 * present at the declared paths. Certificates are verified for real: the PUBLIC files are read and checked here (chain, names, expiry);
 * private keys and secret files are only tested for presence, never read.
 */
export function checkHost(h: RemoteHost, t: Topology, facts: HostFacts, needed: { secrets: string[]; certificates: Array<{ name: string; names: string[]; client?: boolean }> }): HostFinding[] {
  const out: HostFinding[] = [];
  const add = (severity: HostFinding["severity"], check: string, message: string) => out.push({ severity, check, message });
  if (!facts.docker) add("error", "docker", "Docker Engine is not available to the deploy user (missing, stopped, or the user is not in the docker group). PSO does not install it");
  else add("info", "docker", `Docker ${facts.docker}`);
  if (!facts.compose) add("error", "compose", "Docker Compose v2 (docker compose) is not available. PSO does not install it");
  if (!/x86_64|amd64|aarch64|arm64/.test(facts.arch)) add("warning", "arch", `architecture ${facts.arch}: images built on this machine may not run there`);
  if (!facts.rootWritable) add("error", "root", `${facts.root} (or its nearest existing parent) is not writable by ${facts.user}: an administrator must create it (install -d -o ${facts.user} ${facts.root})`);
  if (facts.diskFreeMb !== null && facts.diskFreeMb < 4096) add(facts.diskFreeMb < 1024 ? "error" : "warning", "disk", `${facts.diskFreeMb} MB free under ${facts.root} (images and releases need several GB)`);
  // this environment's own containers (even of a release that was never activated) hold its port legitimately
  const ours = facts.deployments.some((d) => d.project === t.project);
  if (facts.listening.includes(t.httpsPort) && !ours) add("error", "ports", `port ${t.httpsPort} is already in use on the host by something that is not this environment`);
  if (facts.registry === "unreachable") add("info", "registry", "the host cannot resolve Docker Hub: images are transferred over SSH, so no registry is needed");
  if (t.tlsSource === "external") {
    const dir = assertRemotePath(t.decl.tls!.dir!.replace(/\/+$/, ""), "tls.dir");
    const files = ["ca.crt", ...needed.certificates.flatMap((c) => [`${c.name}/tls.crt`])];
    const read = h.exec(files.map((f) => `echo '-----PSO ${f}-----'; cat ${q(`${dir}/${f}`)} 2>/dev/null`).join("; ") + "; " + needed.certificates.map((c) => `[ -r ${q(`${dir}/${c.name}/tls.key`)} ] && echo 'KEY ${c.name} ok' || echo 'KEY ${c.name} missing'`).join("; "), undefined, 60_000);
    const parts = new Map<string, string>(); let cur = "";
    for (const l of read.stdout.split(/\r?\n/)) { const m = /^-----PSO (.+)-----$/.exec(l); if (m) { cur = m[1]!; parts.set(cur, ""); } else if (cur && !l.startsWith("KEY ")) parts.set(cur, parts.get(cur)! + l + "\n"); }
    const tmp = mkdtempSync(join(tmpdir(), "pso-remote-tls-"));
    try {
      const ca = parts.get("ca.crt")?.trim();
      if (!ca) add("error", "tls", `${dir}/ca.crt is missing on the host`);
      else {
        writeFileSync(join(tmp, "ca.crt"), ca + "\n");
        const a = checkAuthority(join(tmp, "ca.crt"));
        if (!a.ok) add("error", "tls", `${dir}/ca.crt: ${a.problems.join("; ")}`);
        for (const c of needed.certificates) {
          const crt = parts.get(`${c.name}/tls.crt`)?.trim();
          const keyOk = read.stdout.includes(`KEY ${c.name} ok`);
          if (!crt) { add("error", "tls", `${dir}/${c.name}/tls.crt is missing on the host`); continue; }
          if (!keyOk) add("error", "tls", `${dir}/${c.name}/tls.key is missing or not readable by ${facts.user}`);
          writeFileSync(join(tmp, `${c.name}.crt`), crt + "\n");
          // the leaf is checked against the authority and its required names; the key stays on the host (a placeholder satisfies the reader)
          const leaf = checkLeaf(join(tmp, `${c.name}.crt`), join(tmp, `${c.name}.crt`), join(tmp, "ca.crt"), c.names, c.client ? { client: true } : {});
          const problems = leaf.problems.filter((p) => !/private key|not valid PEM/.test(p));
          if (problems.length) add("error", "tls", `${c.name}: ${problems.join("; ")}`);
          else if (leaf.warnings.length) add("warning", "tls", `${c.name}: ${leaf.warnings.join("; ")}`);
        }
        if (!out.some((f) => f.check === "tls" && f.severity === "error")) add("info", "tls", `${needed.certificates.length} certificate(s) verified on the host (authority, names, expiry; keys present)`);
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  if (t.secretProvider === "file") {
    const dir = assertRemotePath(t.decl.secrets!.dir!.replace(/\/+$/, ""), "secrets.dir");
    const r = h.exec(needed.secrets.map((s) => `[ -s ${q(`${dir}/${s}`)} ] && [ -r ${q(`${dir}/${s}`)} ] && echo 'S ${s} ok' || echo 'S ${s} missing'`).join("; ") || "true", undefined, 30_000);
    const missing = needed.secrets.filter((s) => !r.stdout.includes(`S ${s} ok`));
    if (missing.length) add("error", "secrets", `secret file(s) missing or unreadable in ${dir}: ${missing.join(", ")} (supplied by the operator; PSO never creates them)`);
    else if (needed.secrets.length) add("info", "secrets", `${needed.secrets.length} secret file(s) present (contents not read)`);
  } else if (t.secretProvider === "env") add("warning", "secrets", "secrets come from PSO_SECRET_* variables: they must be in the environment of the Docker Compose run on the host (not verifiable from here)");
  return out;
}
