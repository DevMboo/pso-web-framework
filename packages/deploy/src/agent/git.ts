import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText, registerSecret } from "../redact.ts";
import type { GitSource } from "../declare.ts";
import { P } from "./state.ts";

/**
 * Git access for releases. A release is always built from an immutable commit in an isolated workspace: `git pull` is never run, and
 * never inside a running release. Credentials come from the server's secret store and reach git through its environment (an ssh key
 * file for `-i`, or an HTTP authorization header through GIT_CONFIG_*), never inside the repository URL or an argument list.
 */
export interface GitContext { home: string; secret: (name: string) => string | undefined }

interface Prepared { env: NodeJS.ProcessEnv; cleanup: () => void }

function prepare(src: GitSource, ctx: GitContext): Prepared {
  const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"], HOME: process.env["HOME"], LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "echo", GCM_INTERACTIVE: "never" };
  let cleanup = (): void => undefined;
  const known = ctx.secret("git-known-hosts");
  const khFile = join(P.state(ctx.home), "git_known_hosts");
  if (known !== undefined) { mkdirSync(P.state(ctx.home), { recursive: true }); writeFileSync(khFile, known, { mode: 0o600 }); }
  const sshBase = `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${existsSync(khFile) ? khFile : "/dev/null"}`;
  if (src.credentials) {
    const secret = ctx.secret(src.credentials);
    if (secret === undefined) throw new Error(`the secret "${src.credentials}" named by source.credentials is not set on this server (use \`pso environment:secret\`)`);
    registerSecret(secret);
    if (secret.includes("PRIVATE KEY-----")) {
      const dir = mkdtempSync(join(tmpdir(), "pso-git-")); const key = join(dir, "key");
      writeFileSync(key, secret.endsWith("\n") ? secret : secret + "\n", { mode: 0o600 }); try { chmodSync(key, 0o600); } catch { /* not supported */ }
      env["GIT_SSH_COMMAND"] = `${sshBase} -o IdentitiesOnly=yes -i ${key}`;
      cleanup = () => rmSync(dir, { recursive: true, force: true });
    } else {
      // an access token: sent as an HTTP header from the environment, so it is in neither the URL nor argv
      env["GIT_CONFIG_COUNT"] = "1"; env["GIT_CONFIG_KEY_0"] = "http.extraHeader";
      env["GIT_CONFIG_VALUE_0"] = `Authorization: Basic ${Buffer.from(`x-access-token:${secret.trim()}`).toString("base64")}`;
      registerSecret(Buffer.from(`x-access-token:${secret.trim()}`).toString("base64"));
    }
  }
  if (!env["GIT_SSH_COMMAND"]) env["GIT_SSH_COMMAND"] = sshBase;
  return { env, cleanup };
}

const git = (args: string[], env: NodeJS.ProcessEnv, cwd?: string, timeoutMs = 600_000) => {
  const r = spawnSync("git", args, { env, cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: redactText(`${r.stdout ?? ""}${r.stderr ?? ""}`.trim()), stdout: r.stdout ?? "" };
};

export interface Resolved { commit: string; ref: string; refType: "branch" | "tag" | "commit" }

/** Resolves a branch or tag to the commit it points to NOW. The commit, not the name, is what the plan records and what is deployed. */
export function resolveSource(src: GitSource, ctx: GitContext): Resolved {
  if (src.commit) return { commit: src.commit, ref: src.commit, refType: "commit" };
  const p = prepare(src, ctx);
  try {
    const pattern = src.branch ? [`refs/heads/${src.branch}`] : [`refs/tags/${src.tag}`, `refs/tags/${src.tag}^{}`];
    const r = git(["ls-remote", "--", src.url, ...pattern], p.env, undefined, 60_000);
    if (!r.ok) throw new Error(`cannot read the repository: ${r.out.split("\n")[0] ?? "git ls-remote failed"}`);
    const lines = r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t") as [string, string]);
    const peeled = lines.find(([, ref]) => ref.endsWith("^{}")) ?? lines[0];
    if (!peeled) throw new Error(`${src.branch ? "branch" : "tag"} "${src.branch ?? src.tag}" was not found in the repository`);
    return { commit: peeled[0], ref: src.branch ?? src.tag!, refType: src.branch ? "branch" : "tag" };
  } finally { p.cleanup(); }
}

/** Fetches exactly `commit` into an empty workspace and checks it out detached. Verifies the checked-out HEAD equals the requested commit. */
export function fetchCommit(src: GitSource, commit: string, dest: string, ctx: GitContext): { ok: true } | { ok: false; error: string } {
  const p = prepare(src, ctx);
  try {
    mkdirSync(dest, { recursive: true });
    const steps: string[][] = [["init", "--quiet"], ["remote", "add", "origin", src.url]];
    for (const s of steps) { const r = git(s, p.env, dest); if (!r.ok) return { ok: false, error: r.out }; }
    let f = git(["fetch", "--quiet", "--depth", "1", "origin", commit], p.env, dest);
    if (!f.ok) f = git(["fetch", "--quiet", "origin", src.branch ? `refs/heads/${src.branch}` : src.tag ? `refs/tags/${src.tag}` : commit], p.env, dest);
    if (!f.ok) return { ok: false, error: f.out };
    const co = git(["checkout", "--quiet", "--detach", commit], p.env, dest); if (!co.ok) return { ok: false, error: co.out };
    const head = git(["rev-parse", "HEAD"], p.env, dest);
    if (head.stdout.trim() !== commit) return { ok: false, error: `checked-out commit ${head.stdout.trim()} differs from the planned commit ${commit}` };
    if (src.submodules) { const s = git(["submodule", "update", "--init", "--recursive", "--depth", "1"], p.env, dest); if (!s.ok) return { ok: false, error: s.out }; }
    rmSync(join(dest, ".git", "config"), { force: true }); // the remote URL and any header settings do not stay in the release
    writeFileSync(join(dest, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    return { ok: true };
  } finally { p.cleanup(); }
}

export const gitAvailable = (): boolean => spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
