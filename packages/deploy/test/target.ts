import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A disposable Linux server for the end-to-end tests: a Docker container (sshd, nginx, Node, JDK, git) with an unprivileged `pso` user.
 * It is created for one test run and removed afterwards; nothing here touches a real server.
 */
export const IMAGE = "pso-e2e-target:1";
export const SYSTEMD_IMAGE = "pso-e2e-systemd:1";
const here = import.meta.dirname;
export const FIXTURES = resolve(here, "fixtures");

const docker = (args: string[], input?: string) => spawnSync("docker", args, { encoding: "utf8", input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

export function dockerAvailable(image = IMAGE): boolean {
  if (process.env["PSO_E2E_DOCKER"] === "0") return false;
  const r = docker(["image", "inspect", image]);
  return r.status === 0;
}

export class LinuxTarget {
  readonly name = `pso-e2e-${Math.random().toString(36).slice(2, 8)}`;
  readonly image: string;
  constructor(image = IMAGE) { this.image = image; }
  sshPort = 0; httpPort = 0; otherPort = 0;
  readonly dir = mkdtempSync(join(tmpdir(), "pso-e2e-"));
  readonly keyFile = join(this.dir, "id_ed25519");

  start(): void {
    // systemd as PID 1 needs a privileged container with the host cgroup namespace and a tmpfs /run
    const sd = this.image === SYSTEMD_IMAGE ? ["--privileged", "--cgroupns=host", "--tmpfs", "/run", "--tmpfs", "/run/lock"] : [];
    const r = docker(["run", "-d", "--name", this.name, ...sd, "-p", "127.0.0.1::22", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::8081", this.image]);
    if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
    const port = (p: number): number => Number(/:(\d+)\s*$/m.exec(docker(["port", this.name, `${p}/tcp`]).stdout)![1]);
    this.sshPort = port(22); this.httpPort = port(8080); this.otherPort = port(8081);
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", this.keyFile, "-C", "pso-e2e"], { windowsHide: true });
    const pub = readFileSync(`${this.keyFile}.pub`, "utf8").trim();
    this.sh(`mkdir -p /home/pso/.ssh && echo '${pub}' > /home/pso/.ssh/authorized_keys && chmod 700 /home/pso/.ssh && chmod 600 /home/pso/.ssh/authorized_keys && chown -R pso: /home/pso/.ssh`);
  }

  async waitSsh(timeoutMs = 20000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ok = await new Promise<boolean>((res) => { const s = createConnection({ host: "127.0.0.1", port: this.sshPort }, () => { s.once("data", () => { s.destroy(); res(true); }); }); s.on("error", () => res(false)); setTimeout(() => { s.destroy(); res(false); }, 1500); });
      if (ok) return; await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("sshd did not come up");
  }

  /** Runs a shell command in the container as root (the "administrator") or as another user. */
  sh(cmd: string, user = "root"): { code: number | null; out: string } { const r = docker(["exec", "-u", user, this.name, "sh", "-c", cmd]); return { code: r.status, out: `${r.stdout}${r.stderr}` }; }
  shStdin(script: string, user = "root"): { code: number | null; out: string } { const r = docker(["exec", "-i", "-u", user, this.name, "sh"], script); return { code: r.status, out: `${r.stdout}${r.stderr}` }; }

  /** Publishes a local directory as a bare git repository inside the container, at file:///srv/repos/<name>.git */
  putRepo(localRepo: string, name: string): string {
    const bare = join(this.dir, `${name}.git`); rmSync(bare, { recursive: true, force: true });
    spawnSync("git", ["clone", "--bare", "--quiet", localRepo, bare], { windowsHide: true });
    spawnSync("git", ["-C", bare, "config", "uploadpack.allowAnySHA1InWant", "true"], { windowsHide: true });
    this.sh(`rm -rf /srv/repos/${name}.git`);
    const r = docker(["cp", bare, `${this.name}:/srv/repos/${name}.git`]); if (r.status !== 0) throw new Error(r.stderr);
    this.sh(`chown -R pso: /srv/repos/${name}.git`);
    return `file:///srv/repos/${name}.git`;
  }

  stop(): void { docker(["rm", "-f", this.name]); rmSync(this.dir, { recursive: true, force: true }); }
}

/** Creates a local git repository with the fixture applications at a given "version"; `flags` go into the orchestrator's version.json. */
export function makeAppRepo(root: string, which: "orchestrator" | "catalog", version: string, flags: Record<string, unknown> = {}): string {
  mkdirSync(root, { recursive: true });
  const git = (...a: string[]) => { const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  if (!readFileSync.length || !spawnSync("git", ["-C", root, "rev-parse", "--git-dir"], { windowsHide: true }).stdout.length) { git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.test"); git("config", "user.name", "tester"); }
  cpSync(join(FIXTURES, "apps", which), root, { recursive: true });
  if (which === "orchestrator") writeFileSync(join(root, "version.json"), JSON.stringify({ version, ...flags }));
  else writeFileSync(join(root, "version.txt"), version);
  git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", `release ${version}`);
  return git("rev-parse", "HEAD");
}
