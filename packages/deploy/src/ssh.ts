import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionRecord } from "./local-state.ts";
import { registerSecret, redactText } from "./redact.ts";

/**
 * SSH through the operating system's OpenSSH client: no SSH implementation of our own, no extra dependency, and the user's ssh-agent,
 * hardware keys and certificates work as they always did.
 *
 *  - Host identity is verified strictly (StrictHostKeyChecking=yes) against a known_hosts file owned by PSO. A host key is pinned only
 *    after the user approved its fingerprint (`scanHostKey` + `pinHostKey`); a changed key is a hard failure, never a prompt.
 *  - Keys are used in place (`-i path`, IdentitiesOnly) and are never copied or imported. A passphrase or password reaches ssh through an
 *    askpass helper whose secret lives only in the environment of that one child process, never in an argument list.
 *  - Nothing is executed on the server except the agent in `serve` mode, whose protocol offers no shell (see protocol.ts).
 */
const SAFE_HOST = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;
const SAFE_USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const SAFE_DIR = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,120}$/;

export function validateConnectionShape(c: Pick<ConnectionRecord, "host" | "port" | "user" | "agentDir" | "jump">): string | undefined {
  if (!SAFE_HOST.test(c.host)) return "host must be a DNS name or IP address";
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return "port must be 1-65535";
  if (!SAFE_USER.test(c.user)) return "user contains characters that are not allowed";
  if (!SAFE_DIR.test(c.agentDir) || c.agentDir.includes("..")) return "agent directory must be a plain relative path";
  if (c.jump && (!SAFE_HOST.test(c.jump.host) || !SAFE_USER.test(c.jump.user) || !(c.jump.port >= 1 && c.jump.port <= 65535))) return "invalid jump host";
  return undefined;
}

export interface SshSecrets { password?: string; passphrase?: string }

export interface SshContext { knownHosts: string; secrets?: SshSecrets }

/** One argument of the ProxyCommand line (it is parsed by a shell): forward slashes, no characters that could end the quoting. */
const proxyArg = (v: string): string => {
  const x = v.split("\\").join("/").replace(/%/g, "%%");
  if (/["`$;&|<>\r\n]/.test(x)) throw new Error("a path or value that is not allowed in a jump host connection");
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(x) ? x : `"${x}"`;
};

export function sshBaseArgs(c: ConnectionRecord, ctx: SshContext, opts: { tty?: boolean; forwarding?: boolean } = {}): string[] {
  const bad = validateConnectionShape(c);
  if (bad) throw new Error(`invalid connection: ${bad}`);
  const secret = c.auth.kind === "password" || !!c.auth.passphraseRef;
  // options that apply to EVERY hop: host identity, timeouts, no forwarding, and how we authenticate
  const common = [
    "-o", `BatchMode=${secret ? "no" : "yes"}`, "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${ctx.knownHosts}`, "-o", "GlobalKnownHostsFile=none",
    "-o", `ConnectTimeout=${Math.max(1, Math.round(c.timeoutSeconds))}`, "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "LogLevel=ERROR",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
  ];
  const auth: string[] = [];
  if (c.auth.kind === "key") {
    if (!c.auth.keyPath) throw new Error("this connection uses a key but names no key file");
    auth.push("-i", c.auth.keyPath, "-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no");
  } else if (c.auth.kind === "agent") auth.push("-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no");
  else auth.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1");
  const a = [...common, "-o", `ClearAllForwardings=${opts.forwarding ? "no" : "yes"}`, "-p", String(c.port), ...(opts.tty ? [] : ["-T"]), ...auth];
  if (c.jump) {
    // OpenSSH's -J does NOT apply command-line options to the jump hop: it would use the user's own known_hosts and defaults. A ProxyCommand
    // carries exactly the same strict options to the bastion, so both hops are verified against PSO's pinned host keys.
    const hop = ["ssh", ...[...common, "-o", "ClearAllForwardings=no", ...auth, "-T", "-p", String(c.jump.port)].map(proxyArg), "-W", "%h:%p", `${c.jump.user}@${c.jump.host}`].join(" ");
    a.push("-o", `ProxyCommand=${hop}`);
  }
  a.push(`${c.user}@${c.host}`);
  return a;
}

/** Creates the askpass helper for one ssh child. Returns the environment to add and a cleanup function. */
export function askpassEnv(secrets: SshSecrets | undefined): { env: Record<string, string>; cleanup: () => void } {
  const value = secrets?.password ?? secrets?.passphrase;
  if (value === undefined) return { env: {}, cleanup: () => undefined };
  registerSecret(value);
  const dir = mkdtempSync(join(tmpdir(), "pso-askpass-"));
  try { chmodSync(dir, 0o700); } catch { /* not supported on this file system */ }
  const js = join(dir, "askpass.mjs");
  writeFileSync(js, "process.stdout.write((process.env.PSO_SSH_SECRET ?? '') + '\\n');\n", { mode: 0o600 });
  let launcher: string;
  if (process.platform === "win32") { launcher = join(dir, "askpass.cmd"); writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${js}"\r\n`); }
  else { launcher = join(dir, "askpass.sh"); writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${js}"\n`, { mode: 0o700 }); chmodSync(launcher, 0o700); }
  return { env: { SSH_ASKPASS: launcher, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env["DISPLAY"] ?? "pso:0", PSO_SSH_SECRET: value }, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp is reaped by the OS */ } } };
}

/** The fixed remote command line for the agent (every part is validated; nothing the user typed reaches a shell unchecked). */
export const agentCommand = (c: Pick<ConnectionRecord, "agentDir">, sub: string): string => `PSO_AGENT_HOME="$HOME/${c.agentDir}" PSO_AGENT_ENTRY="$HOME/${c.agentDir}/bin/pso-agent.mjs" exec node "$HOME/${c.agentDir}/bin/pso-agent.mjs" ${sub}`;

/** Starts `ssh ... <agent command>` and returns the child with its stdio piped. The remote command is built from validated parts only. */
export function spawnAgentOverSsh(c: ConnectionRecord, ctx: SshContext): { child: ChildProcess; cleanup: () => void } {
  const ask = askpassEnv(ctx.secrets);
  const remote = agentCommand(c, "serve");
  const child = spawn("ssh", [...sshBaseArgs(c, ctx), "--", remote], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ask.env }, windowsHide: true });
  child.on("close", ask.cleanup);
  return { child, cleanup: ask.cleanup };
}

/** Runs one fixed, parameter-free remote command (installing the agent, reading the bootstrap result). Not reachable from the management protocol. */
export function sshExec(c: ConnectionRecord, ctx: SshContext, remoteCommand: string, input?: Buffer | string, timeoutMs = 120_000): { status: number | null; stdout: string; stderr: string } {
  const ask = askpassEnv(ctx.secrets);
  try {
    const r = spawnSync("ssh", [...sshBaseArgs(c, ctx), "--", remoteCommand], { input, encoding: "utf8", env: { ...process.env, ...ask.env }, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: redactText(r.stderr ?? "") };
  } finally { ask.cleanup(); }
}

// ------------------------------------------------------------------ host keys
export interface HostKeyCandidate { type: string; fingerprint: string; line: string }

/** Asks the server for its host keys (no authentication happens here). The result must be shown to the user for approval. */
export function scanHostKey(host: string, port: number, timeoutSeconds = 10): HostKeyCandidate[] {
  if (!SAFE_HOST.test(host)) throw new Error("invalid host");
  const r = spawnSync("ssh-keyscan", ["-T", String(timeoutSeconds), "-p", String(port), "-t", "ed25519,ecdsa,rsa", host], { encoding: "utf8", windowsHide: true, timeout: (timeoutSeconds + 5) * 1000 });
  let lines = (r.stdout ?? "").split("\n").filter((l) => l && !l.startsWith("#"));
  if (!lines.length) lines = hostKeysThroughSsh(host, port, timeoutSeconds);
  const out: HostKeyCandidate[] = [];
  for (const line of lines) {
    const f = spawnSync("ssh-keygen", ["-lf", "-"], { input: line + "\n", encoding: "utf8", windowsHide: true });
    const m = /(\d+) (SHA256:\S+) .* \((\w+)\)/.exec(f.stdout ?? "");
    if (m) out.push({ type: m[3]!.toLowerCase(), fingerprint: m[2]!, line });
  }
  return out;
}

/**
 * Fallback of scanHostKey when ssh-keyscan returns nothing. OpenSSH for Windows 9.5's ssh-keyscan proposes a key exchange
 * (sntrup761x25519) it cannot carry out, so it fails against OpenSSH 9.x/10.x servers, while its ssh negotiates curve25519 fine.
 * Each host key type is collected by `ssh` into a throw-away known_hosts file, with no authentication attempted and no user
 * configuration read. These are only CANDIDATES: nothing is pinned until the user approves a fingerprint (pinHostKey).
 */
function hostKeysThroughSsh(host: string, port: number, timeoutSeconds: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), "pso-hostkeys-"));
  try {
    const kh = join(dir, "known_hosts"), cfg = join(dir, "config");
    writeFileSync(cfg, "");
    const lines: string[] = [];
    for (const alg of ["ssh-ed25519", "ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521", "rsa-sha2-512,rsa-sha2-256"]) {
      writeFileSync(kh, "");
      spawnSync("ssh", ["-F", cfg, "-p", String(port), "-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeoutSeconds}`, "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${kh}`, "-o", "GlobalKnownHostsFile=none",
        "-o", `HostKeyAlgorithms=${alg}`, "-o", "PreferredAuthentications=none", "-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "HashKnownHosts=no",
        `pso-hostkey-scan@${host}`, "exit"], { encoding: "utf8", windowsHide: true, timeout: (timeoutSeconds + 5) * 1000 });
      for (const l of readFileSync(kh, "utf8").split(/\r?\n/)) if (l.trim() && !l.startsWith("#")) lines.push(l.trim());
    }
    return lines;
  } catch { return []; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Pins the host key whose fingerprint the user approved. Refuses when the server presents no key with that fingerprint. */
export function pinHostKey(knownHostsFile: string, host: string, port: number, approvedFingerprint: string): HostKeyCandidate {
  const found = scanHostKey(host, port).find((k) => k.fingerprint === approvedFingerprint);
  if (!found) throw new Error(`the server at ${host}:${port} does not present a host key with fingerprint ${approvedFingerprint}; nothing was pinned`);
  mkdirSync(join(knownHostsFile, ".."), { recursive: true });
  const marker = port === 22 ? host : `[${host}]:${port}`;
  const keyPart = found.line.split(" ").slice(1).join(" ");
  const existing = existsSync(knownHostsFile) ? readFileSync(knownHostsFile, "utf8") : "";
  if (!existing.split("\n").some((l) => l === `${marker} ${keyPart}`)) appendFileSync(knownHostsFile, `${marker} ${keyPart}\n`, { mode: 0o600 });
  return found;
}

/** Removes every pinned key of a host (for a deliberate, user-approved key change). */
export function unpinHost(knownHostsFile: string, host: string, port: number): void {
  if (!existsSync(knownHostsFile)) return;
  const marker = port === 22 ? host : `[${host}]:${port}`;
  writeFileSync(knownHostsFile, readFileSync(knownHostsFile, "utf8").split("\n").filter((l) => l && !l.startsWith(marker + " ")).join("\n") + "\n", { mode: 0o600 });
}

// ------------------------------------------------------------------ private tunnels
export interface Tunnel { localPort: number; close(): void; child: ChildProcess }

/** Forwards a LOCAL loopback port to a LOOPBACK port on the server, through the authenticated SSH connection. Never binds publicly. */
export function openTunnel(c: ConnectionRecord, ctx: SshContext, localPort: number, remotePort: number): Tunnel {
  if (![localPort, remotePort].every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) throw new Error("invalid port");
  const ask = askpassEnv(ctx.secrets);
  const args = sshBaseArgs(c, ctx, { forwarding: true });
  const final = [...args.slice(0, -1), "-o", "ExitOnForwardFailure=yes", "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, args[args.length - 1]!];
  const child = spawn("ssh", final, { stdio: "ignore", env: { ...process.env, ...ask.env }, windowsHide: true });
  child.on("close", ask.cleanup);
  return { localPort, child, close: () => { child.kill(); } };
}
