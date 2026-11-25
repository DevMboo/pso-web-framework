import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { findWorkspaceRoot } from "@pso/core";
import {
  Cloud, CloudError, DEFAULT_PIPELINE, declFor, discoverDeclarations, redactValue, validateDeployment, validatePipeline, servicesOf,
  type DeclarationFile, type DeploymentDecl, type Plan, type Deployment,
} from "@pso/deploy";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, json, type Command, type Ctx } from "./commands.ts";

/**
 * Cloud Lifecycle & Operations commands. They are thin: every operation is a call to `Cloud` from @pso/deploy, the same facade Studio
 * uses, so the CLI and Studio enforce identical policies. Secrets (passwords, passphrases, enrollment tokens, secret values) are never
 * accepted as arguments: they are typed at a hidden prompt or piped on standard input.
 */
export const EXIT_NEEDS_CONFIRMATION = 3;

// ------------------------------------------------------------------ secret and confirmation input (replaceable in tests)
export interface Input { secret(prompt: string): Promise<string>; confirm(question: string): Promise<boolean>; interactive: boolean }
const readStdin = (): Promise<string> => new Promise((res) => { let b = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (b += d)); process.stdin.on("end", () => res(b)); process.stdin.resume(); });
export const defaultInput: Input = {
  interactive: !!process.stdin.isTTY,
  async secret(prompt) {
    if (!process.stdin.isTTY) { const v = (await readStdin()).replace(/\r?\n$/, ""); if (!v) throw new CliError("no secret was provided on standard input"); return v; }
    process.stderr.write(prompt);
    return new Promise((res) => {
      let v = ""; process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
      const on = (ch: string): void => {
        for (const c of ch) {
          if (c === "\r" || c === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", on); process.stderr.write("\n"); res(v); return; }
          if (c === "\u0003") { process.stdin.setRawMode(false); process.exit(130); }
          if (c === "\u007f" || c === "\b") v = v.slice(0, -1); else v += c;
        }
      };
      process.stdin.on("data", on);
    });
  },
  async confirm(q) { const rl = createInterface({ input: process.stdin, output: process.stderr }); return new Promise((res) => rl.question(`${q} [y/N] `, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); })); },
};
let input: Input = defaultInput;
export const setInput = (i: Input): void => { input = i; };
let cloudFactory = (): Cloud => new Cloud();
export const setCloudFactory = (f: () => Cloud): void => { cloudFactory = f; };
/** The Cloud facade other command groups use (frontend release signing with a local signer). */
export const cloudInstance = (): Cloud => cloudFactory();

const wrap = async (fn: () => Promise<number>): Promise<number> => {
  try { return await fn(); } catch (e) {
    if (e instanceof CloudError) throw new CliError(e.message, e.hint, e.code === "FORBIDDEN" ? 4 : 1);
    if (e instanceof Error && e.name === "CredentialStoreError") throw new CliError(e.message, undefined, 1);
    throw e;
  }
};
const yes = (ctx: Ctx, what: string): void => { if (ctx.flags["yes"] !== true) throw new CliError(`${what} needs explicit authorization`, "Review the plan, then repeat the command with --yes", EXIT_NEEDS_CONFIRMATION); };
const need = (ctx: Ctx, i: number, what: string): string => { const v = ctx.positionals[i]; if (!v) throw new CliError(`Missing ${what}`); return v; };
const roots = (ctx: Ctx): string => findWorkspaceRoot(ctx.cwd) ?? ctx.cwd;

function envContext(ctx: Ctx, envName: string): { cloud: Cloud; root: string; decl: DeploymentDecl; file: DeclarationFile; pipeline: ReturnType<typeof declFor>["pipeline"]; conn: string; overrides: string[] } {
  const root = roots(ctx); const cloud = cloudFactory();
  const found = declFor(discoverDeclarations(root), envName);
  const decl = JSON.parse(JSON.stringify(found.deployment.value)) as DeploymentDecl; const overrides: string[] = [];
  const b = str(ctx.flags["branch"]), t = str(ctx.flags["tag"]), c = str(ctx.flags["commit"]);
  if ([b, t, c].filter(Boolean).length > 1) throw new CliError("give only one of --branch, --tag, --commit");
  if (b || t || c) {
    if (decl.source.provider !== "git") throw new CliError("--branch/--tag/--commit apply to git sources");
    delete decl.source.branch; delete decl.source.tag; delete decl.source.commit;
    if (b) decl.source.branch = b; if (t) decl.source.tag = t; if (c) decl.source.commit = c;
    overrides.push(`source ref overridden on the command line: ${b ? `branch ${b}` : t ? `tag ${t}` : `commit ${c}`}`);
    const errs = validateDeployment(decl).filter((d) => d.level === "error"); if (errs.length) throw new CliError(`invalid override:\n${errs.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
  }
  return { cloud, root, decl, file: found.deployment, pipeline: found.pipeline, conn: decl.connection.credentials, overrides };
}

// ------------------------------------------------------------------ formatting
const icon = (s: string): string => ({ passed: "PASS", failed: "FAIL", skipped: "SKIP", disabled: "OFF ", unavailable: "N/A ", running: "RUN ", pending: "WAIT", blocked: "BLOCK", cancelled: "CANC", "awaiting-approval": "APPR" } as Record<string, string>)[s] ?? s;
export function formatPlan(p: Plan): string {
  const L: string[] = [];
  L.push(`Deployment plan ${p.hash.slice(0, 12)}  (${p.app} -> ${p.environment}, environment ${p.environmentId})`);
  L.push(`  server        ${p.server.user}@${p.server.os} ${p.server.arch}`);
  L.push(`  strategy      ${p.strategy.type}${p.strategy.proxy === "nginx" ? " behind nginx" : ""}, rollback ${p.strategy.rollback ? "enabled" : "disabled"}, keep ${p.strategy.keep} release(s)`);
  L.push(`  release       ${p.currentRelease ?? "(none active)"}  ->  ${p.candidateRelease}`);
  L.push(`  source        ${p.source.provider === "git" ? `${p.source.refType} ${p.source.ref} = commit ${p.source.commit}` : `artifact sha256:${p.source.sha256.slice(0, 16)}… (${p.source.size} bytes)`}`);
  L.push(`  provenance    ${p.provenance.authenticity === "verified" ? `AUTHENTIC, signed by ${p.provenance.signer?.name} (sequence ${p.provenance.sequence}); integrity ${p.provenance.integrity}` : `NOT authentic: ${p.provenance.authenticity}; integrity ${p.provenance.integrity}`}`);
  L.push(`  runtime       ${p.runtime.supervisor}${p.runtime.supervisor === "systemd" ? ` (user manager, restart ${p.runtime.restart})` : " (agent-managed processes)"}`);
  L.push(`  availability  ${p.availability.impact === "downtime" ? "DOWNTIME EXPECTED. " : ""}${p.availability.summary}`);
  for (const c of p.availability.conditions) L.push(`                - ${c}`);
  L.push(`  resources     memory ${p.resources.requiredMemoryMb} MB needed / ${p.resources.availableMemoryMb} MB free; disk ${p.resources.requiredDiskMb} MB needed / ${p.resources.availableDiskMb} MB free`);
  L.push("  services");
  for (const s of p.services) L.push(`    ${s.name.padEnd(16)} ${s.runtime.padEnd(5)} port ${String(s.port).padEnd(5)} x${s.instances}  grace ${s.shutdownGraceSeconds}s${s.route ? `  route ${s.route}` : ""}`);
  if (p.changes.configuration.length) { L.push("  changes"); for (const c of p.changes.configuration) L.push(`    ${c.kind.padEnd(9)} ${c.action.padEnd(12)} ${c.target}`); }
  for (const i of p.changes.infrastructure) L.push(`    infra     ${i}`);
  L.push("  pipeline");
  for (const s of p.stages) L.push(`    ${s.enabled ? "on " : "OFF"} ${s.id.padEnd(14)}${s.reason ? ` (${s.reason})` : ""}${s.requiresApproval ? " [needs approval]" : ""}`);
  if (p.disabledChecks.length) { L.push("  disabled or omitted checks (recorded in the audit log)"); for (const d of p.disabledChecks) L.push(`    - ${d.stage}: ${d.reason}`); }
  L.push("  always enforced (cannot be disabled by a pipeline)"); for (const m of p.mandatory) L.push(`    - ${m}`);
  L.push(`  permissions   role "${p.permissions.minimumRole}" or higher${p.permissions.privileged.length ? `; privileged: ${p.permissions.privileged.join("; ")}` : ""}`);
  for (const n of p.distributed.notes) L.push(`  workload      ${n}`);
  L.push(`  rollback      [${p.rollback.dataSafety}] ${p.rollback.eligible ? `eligible, to ${p.rollback.to}` : "NOT eligible"}${p.rollback.notes.length ? `. ${p.rollback.notes.join(" ")}` : ""}`);
  if (p.migrations.mode !== "none") L.push(`  migrations    ${p.migrations.mode}, owner ${p.migrations.owner}${p.migrations.destructive ? ", DESTRUCTIVE" : ""}. ${p.migrations.notes.join(" ")}`);
  L.push(`  approvals     ${p.approvalsRequired} required`);
  for (const w of p.warnings) L.push(`  warning       ${w}`);
  for (const b of p.blockers) L.push(`  BLOCKED       ${b}`);
  return L.join("\n");
}
export function formatDeployment(d: Deployment & { effectiveState?: string }): string {
  const L = [`${d.kind} ${d.id}: ${d.effectiveState ?? d.state}   release ${d.releaseId} (previous ${d.previousRelease ?? "none"}), strategy ${d.strategy}`];
  for (const s of d.stages) L.push(`  ${icon(s.status)} ${s.id.padEnd(13)} ${s.detail ?? ""}`);
  if (d.availability) L.push(`  active-release verification: ${d.availability.requests - d.availability.failures}/${d.availability.requests} probes reached the new release`);
  if (d.error) L.push(`  error: ${d.error}`);
  return L.join("\n");
}

const spec = (flag: string): string => flag;
const signedFrom = (ctx: Ctx): import("@pso/deploy").SignedManifest | undefined => { const f = str(ctx.flags["signed"]); if (!f) return undefined; try { return JSON.parse(readFileSync(f, "utf8")) as import("@pso/deploy").SignedManifest; } catch { throw new CliError(`cannot read the signed manifest ${f}`, "Create one with pso release:sign"); } };
void spec;

// ------------------------------------------------------------------ commands
export const CLOUD_COMMANDS: Record<string, Command> = {
  "connection:add": {
    usage: "pso connection:add <name> --host <host> --user <user> [--port 22] [--auth key|agent|password] [--key <private-key-file>] [--jump <user@host:port>] [--timeout 15] [--accept-host-key <SHA256:fingerprint>] [--passphrase-stdin] [--password-stdin] [--json]",
    summary: "Register an SSH connection to a Linux server: pins its SSH host key after you approve the fingerprint, stores a key passphrase or password only in the protected credential store",
    next: "`pso agent:install <name> --mode development --environment <env> --yes` installs and enrolls the runtime agent",
    run: (ctx) => wrap(async () => {
      const name = need(ctx, 0, "connection name"); const host = str(ctx.flags["host"]); const user = str(ctx.flags["user"]);
      if (!host || !user) throw new CliError("--host and --user are required");
      const auth = (str(ctx.flags["auth"]) ?? (ctx.flags["key"] ? "key" : "agent")) as "key" | "agent" | "password";
      if (!["key", "agent", "password"].includes(auth)) throw new CliError("--auth is key, agent or password");
      if (auth === "password" && ctx.flags["password-stdin"] !== true) throw new CliError("password authentication reads the password from standard input", "Pass --password-stdin and pipe the password, or run in a terminal for a hidden prompt (it is never an argument)");
      if (ctx.flags["password-stdin"] === true && auth !== "password") throw new CliError("--password-stdin needs --auth password");
      if (ctx.flags["passphrase-stdin"] === true && auth !== "key") throw new CliError("--passphrase-stdin needs --auth key");
      const port = Number(str(ctx.flags["port"]) ?? 22); const cloud = cloudFactory();
      const jm = str(ctx.flags["jump"]) ? /^([^@]+)@([^:]+)(?::(\d+))?$/.exec(str(ctx.flags["jump"])!) : undefined;
      if (str(ctx.flags["jump"]) && !jm) throw new CliError("--jump is user@host[:port]");
      const keys = cloud.hostKeys(host, port);
      if (!keys.length) throw new CliError(`${host}:${port} presented no SSH host key (is SSH reachable?)`);
      const approved = str(ctx.flags["accept-host-key"]);
      let chosen = approved ? keys.find((k) => k.fingerprint === approved) : undefined;
      if (approved && !chosen) throw new CliError(`the server does not present the host key ${approved}`, `It presents: ${keys.map((k) => `${k.type} ${k.fingerprint}`).join(", ")}. Nothing was stored`);
      if (!chosen) {
        const lines = keys.map((k) => `  ${k.type.padEnd(8)} ${k.fingerprint}`).join("\n");
        if (!input.interactive) throw new CliError(`the server's SSH host keys must be approved before they are trusted:\n${lines}`, "Compare one with the fingerprint your provider shows (or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server), then repeat with --accept-host-key <fingerprint>", EXIT_NEEDS_CONFIRMATION);
        ctx.print(`SSH host keys of ${host}:${port}:\n${lines}`);
        if (!(await input.confirm("Do these match what you expect?"))) throw new CliError("not trusted: nothing was stored");
        chosen = keys.find((k) => k.type === "ed25519") ?? keys[0]!;
      }
      let passphrase: string | undefined; let password: string | undefined;
      if (auth === "password") password = await input.secret(`SSH password for ${user}@${host}: `);
      if (ctx.flags["passphrase-stdin"] === true) passphrase = await input.secret("Passphrase of the private key: ");
      const rec = cloud.add({ name, host, port, user, auth, ...(str(ctx.flags["key"]) ? { keyPath: str(ctx.flags["key"])! } : {}), ...(passphrase ? { passphrase } : {}), ...(password ? { password } : {}), ...(jm ? { jump: { user: jm[1]!, host: jm[2]!, port: Number(jm[3] ?? 22) } } : {}), ...(str(ctx.flags["timeout"]) ? { timeoutSeconds: Number(str(ctx.flags["timeout"])) } : {}) }, chosen.fingerprint);
      emit(ctx, { name: rec.name, host: rec.host, port: rec.port, hostKey: chosen.fingerprint, auth: rec.auth.kind, credentialStore: cloud.creds().id }, `connection ${rec.name} added: ${user}@${host}:${port}\n  host key pinned  ${chosen.fingerprint}\n  authentication   ${auth}${auth === "key" ? ` (key file ${rec.auth.keyPath} stays where it is)` : ""}\n  secrets          ${password || passphrase ? `in ${cloud.creds().id}` : "none stored"}`);
      return 0;
    }),
  },
  "connection:list": {
    usage: "pso connection:list [--json]", summary: "List registered connections (references only: no secret is ever shown)",
    run(ctx) { const rows = cloudFactory().list(); emit(ctx, rows, rows.length ? rows.map((c) => `${c.name.padEnd(16)} ${c.user}@${c.host}:${c.port}  ${c.auth.padEnd(8)} agent ${c.agentFingerprint ? "pinned" : "not installed"}  ${c.enrolled ? `enrolled as ${c.role}` : "not enrolled"}${c.revoked ? "  REVOKED" : ""}`).join("\n") : "no connections yet: `pso connection:add`"); return 0; },
  },
  "connection:test": {
    usage: "pso connection:test <name> [--pin-agent <SHA256:fingerprint>] [--json]", summary: "Check a connection layer by layer: SSH and host identity, the agent, the agent's pinned identity, your authenticated session",
    run: (ctx) => wrap(async () => { const r = await cloudFactory().test(need(ctx, 0, "connection name"), { ...(str(ctx.flags["pin-agent"]) ? { pinAgent: str(ctx.flags["pin-agent"])! } : {}) }); emit(ctx, r, `${r.steps.map((s) => `${s.ok ? "OK  " : "FAIL"} ${s.step.padEnd(15)} ${s.detail}`).join("\n")}`); return r.ok ? 0 : 1; }),
  },
  "connection:key": {
    usage: "pso connection:key <name> [--repair --yes] [--json]", summary: "Diagnose the access rights of the connection's SSH private key file (OpenSSH refuses a key other users can read); with --repair --yes restrict the file to you after showing each command",
    run: (ctx) => wrap(async () => {
      const name = need(ctx, 0, "connection name"); const cloud = cloudFactory(); const a = cloud.keyAccess(name);
      const show = (k: typeof a): string[] => [`key file ${k.path} (${k.platform})`, ...k.entries.map((e) => `  ${e.safe ? "ok    " : "OPEN  "} ${e.principal}  ${e.rights}`), `verdict: ${k.verdict.toUpperCase()}  ${k.detail}`];
      if (ctx.flags["repair"] !== true) { emit(ctx, a, [...show(a), ...(a.plan.length ? ["", "a repair would run exactly:", ...a.plan.map((p) => `  ${p}`), "", `run: pso connection:key ${name} --repair --yes`] : [])].join("\n")); return a.verdict === "ok" ? 0 : 1; }
      if (a.verdict === "ok") { emit(ctx, a, [...show(a), "nothing to repair"].join("\n")); return 0; }
      yes(ctx, `changing the access rights of the private key file ${a.path}`);
      const r = cloud.repairKeyAccess(name, { confirm: true }); emit(ctx, r, [...r.ran.map((c) => `ran: ${c}`), "", ...show(r.after)].join("\n")); return r.after.verdict === "ok" ? 0 : 1;
    }),
  },
  "connection:rotate": {
    usage: "pso connection:rotate <name> [--ssh-secret] [--json]", summary: "Rotate credentials: by default the Ed25519 client key used with the agent (enroll a new key, revoke the old); with --ssh-secret the stored SSH password or key passphrase (new value on stdin)",
    run: (ctx) => wrap(async () => {
      const name = need(ctx, 0, "connection name"); const cloud = cloudFactory();
      if (ctx.flags["ssh-secret"] === true) { cloud.rotateSshSecret(name, await input.secret("New SSH secret: ")); emit(ctx, { rotated: "ssh-secret" }, `the stored SSH secret of ${name} was replaced and the old one removed`); return 0; }
      const r = await cloud.rotateClientKey(name); emit(ctx, r, `client key rotated for ${name}\n  new identity ${r.clientId}\n  the previous identity ${r.previous} was revoked on the server and its key deleted here`); return 0;
    }),
  },
  "connection:revoke": {
    usage: "pso connection:revoke <name> --yes [--json]", summary: "Revoke this machine's access: the server forgets the client identity and every local secret of the connection is deleted",
    run: (ctx) => wrap(async () => { yes(ctx, "revoking a connection"); const r = await cloudFactory().revoke(need(ctx, 0, "connection name")); emit(ctx, r, `revoked. server side: ${r.serverRevoked ? "client revoked" : "NOT reached (revoke it from another administrator or on the server)"}; local secrets removed: ${r.localRemoved.length}`); return 0; }),
  },
  "connection:remove": {
    usage: "pso connection:remove <name> --yes [--json]", summary: "Delete a connection from this machine (credentials and pinned host key included); the server and its applications are not touched",
    run: (ctx) => wrap(async () => { yes(ctx, "removing a connection"); const r = cloudFactory().remove(need(ctx, 0, "connection name")); emit(ctx, r, "connection removed from this machine; nothing was changed on the server"); return 0; }),
  },
  "connection:tunnel": {
    usage: "pso connection:tunnel <name> --remote-port <port> [--local-port <port>]", summary: "Open a private SSH tunnel from a loopback port here to a loopback port on the server (for example a service's actuator); never binds publicly, runs until Ctrl+C",
    run: (ctx) => wrap(async () => {
      const name = need(ctx, 0, "connection name"); const cloud = cloudFactory(); const c = cloud.get(name);
      const remote = Number(str(ctx.flags["remote-port"])); const local = Number(str(ctx.flags["local-port"]) ?? remote);
      if (!Number.isInteger(remote) || remote < 1 || remote > 65535) throw new CliError("--remote-port is required (1-65535)");
      void c;
      const t = cloud.tunnel(name, local, remote);
      ctx.print(`tunnel open: 127.0.0.1:${local} -> ${name} 127.0.0.1:${remote} (loopback only, through SSH). Press Ctrl+C to close.`);
      await new Promise<void>((done) => { const stop = (): void => { t.close(); done(); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); void t.exited.then(() => done()); });
      return 0;
    }),
  },

  "agent:install": {
    usage: "pso agent:install <connection> --mode development|protected --environment <name> --yes [--json]", summary: "Install the runtime agent over SSH, provision it (server identity, policy, a single-use administrator enrollment) and enroll this machine as its first superadministrator. Remote management stays disabled unless you choose a mode",
    next: "`pso connection:test <connection>`, then `pso environment:inspect <env>` and `pso environment:plan <env>`",
    run: (ctx) => wrap(async () => {
      yes(ctx, "installing the agent");
      const mode = str(ctx.flags["mode"]); const env = str(ctx.flags["environment"]);
      if (mode !== "development" && mode !== "protected") throw new CliError("--mode is required: development or protected", "Remote management is disabled unless you choose one explicitly");
      if (!env) throw new CliError("--environment is required (for example production)");
      const r = await cloudFactory().installAgent(need(ctx, 0, "connection name"), { mode, environment: env, yes: true });
      emit(ctx, r, `agent ${r.version} installed in ~/${r.agentDir} and provisioned (${mode}, environment ${env})\n  agent identity  ${r.fingerprint}  (pinned)\n  this machine    enrolled as ${r.role}; its private key is in the credential store, the administrator token was single use and is gone\n  environment id  ${r.environmentId}`);
      return 0;
    }),
  },
  "agent:enroll": {
    usage: "pso agent:enroll <connection> [--json]", summary: "Enroll this machine with a single-use token an administrator created (the token is read from standard input or a hidden prompt, never from an argument)",
    run: (ctx) => wrap(async () => { const token = await input.secret("Enrollment token: "); const r = await cloudFactory().enroll(need(ctx, 0, "connection name"), token.trim()); emit(ctx, r, `enrolled as ${r.role}; the token is spent`); return 0; }),
  },
  "agent:status": {
    usage: "pso agent:status <connection> [--json]", summary: "Show the agent's version, mode and who is enrolled", run: (ctx) => wrap(async () => {
      const cloud = cloudFactory(); const name = need(ctx, 0, "connection name");
      const r = await cloud.with(name, async (c) => ({ agent: c.agent, who: await c.call("whoami"), policy: await c.call("policy.get"), clients: await c.call<any[]>("client.list").catch(() => undefined) }));
      emit(ctx, redactValue(r), `agent ${r.agent.agentVersion}  mode ${r.agent.mode}  identity ${r.agent.fingerprint}\n${r.clients ? r.clients.map((c: any) => `  ${c.revoked ? "revoked " : "        "}${c.role.padEnd(10)} ${c.name}  ${c.id}`).join("\n") : "  (client list needs the admin role)"}`); return 0;
    }),
  },
  "agent:upgrade": {
    usage: "pso agent:upgrade <connection> --yes [--json]", summary: "Install the agent bundled in this installation as a new versioned release on the server: verified upload, start check, one atomic link switch; every earlier release is kept (see agent:releases) and can be returned to with agent:rollback. Identity, roles, policy and deployments are untouched; the policy is never changed by an upgrade",
    run: (ctx) => wrap(async () => { yes(ctx, "upgrading the agent"); const r = cloudFactory().upgradeAgent(need(ctx, 0, "connection name")); emit(ctx, r, r.changed ? `agent ${r.from} -> ${r.to} (release ${r.release}); previous release kept: ${r.previous ?? "none"}; return with: pso agent:rollback ${need(ctx, 0, "connection name")} --yes` : `agent ${r.to}: release ${r.release} is already the active one; nothing changed`); return 0; }),
  },
  "agent:releases": {
    usage: "pso agent:releases <connection> [--json]", summary: "List the agent releases kept on the server: the active and the previous one, each build's version, build id, checksum, installation time and installer, and the history of activations and rollbacks",
    run: (ctx) => wrap(async () => {
      const r = cloudFactory().agentReleases(need(ctx, 0, "connection name"));
      const lines = [`layout: ${r.layout}   active: ${r.active ?? "(none)"}   previous: ${r.previous ?? "(none)"}   retention: ${r.retain}`, "", ...r.releases.map((x) => `${x.id === r.active ? "*" : x.id === r.previous ? "-" : " "} ${x.id.padEnd(24)} sha256 ${x.sha256.slice(0, 16)}...  ${x.installedAt}  by ${x.installedBy}  ${x.source}`), "", "history (newest last):", ...r.history.map((h) => `  ${h.at}  ${h.action.padEnd(8)} ${h.release}${h.from ? "  from " + h.from : ""}  by ${h.by}`)];
      emit(ctx, r, lines.join("\n")); return 0;
    }),
  },
  "agent:rollback": {
    usage: "pso agent:rollback <connection> [--to <release id>] --yes [--json]", summary: "Return the server's agent to an earlier release (the previous one, or a named one from agent:releases): the release's checksum is verified again and it must start before the link is switched atomically. Server identity, roles, policy and deployments are untouched",
    run: (ctx) => wrap(async () => { yes(ctx, "returning the remote agent to an earlier release"); const r = cloudFactory().rollbackAgent(need(ctx, 0, "connection name"), str(ctx.flags["to"])); emit(ctx, r, `agent returned from ${r.from} to ${r.to}`); return 0; }),
  },
  "agent:uninstall": {
    usage: "pso agent:uninstall <connection> --yes [--purge-applications] [--json]", summary: "Remove the management agent from the server. Applications, their data and processes stay unless --purge-applications is given (refused while services run)",
    run: (ctx) => wrap(async () => { yes(ctx, "uninstalling the agent"); const r = cloudFactory().uninstallAgent(need(ctx, 0, "connection name"), { purgeApplications: ctx.flags["purge-applications"] === true }); emit(ctx, r, `agent removed. ${JSON.stringify(r)}`); return 0; }),
  },

  "environment:add": {
    usage: "pso environment:add <environment> --connection <name> --repo <git-url> [--branch <branch>] [--tag <tag>] [--commit <sha>] [--runtime node|java] [--service <name>] [--start \"node dist/main.js\"] [--build \"npm ci\"] [--domain <host>] [--http-port 80] [--strategy blue-green|rolling|recreate] [--force] [--dry-run] [--json]",
    summary: "Write deploy/<environment>.deployment.pso.ts and a pipeline declaration for it (no credentials; references only). Never overwrites an existing file without --force",
    run(ctx) {
      const envName = need(ctx, 0, "environment name"); const conn = str(ctx.flags["connection"]); const repo = str(ctx.flags["repo"]);
      if (!conn || !repo) throw new CliError("--connection and --repo are required");
      const runtime = (str(ctx.flags["runtime"]) ?? "node") as "node" | "java"; if (!["node", "java"].includes(runtime)) throw new CliError("--runtime is node or java");
      const strategy = (str(ctx.flags["strategy"]) ?? "blue-green") as DeploymentDecl["strategy"]["type"];
      const split = (s: string | undefined, d: string[]): string[] => (s ? s.trim().split(/\s+/) : d);
      const service = str(ctx.flags["service"]) ?? "app";
      const decl: Record<string, unknown> = {
        name: service, environment: envName, connection: { provider: "ssh", credentials: conn },
        source: { provider: "git", url: repo, ...(str(ctx.flags["tag"]) ? { tag: str(ctx.flags["tag"]) } : str(ctx.flags["commit"]) ? { commit: str(ctx.flags["commit"]) } : { branch: str(ctx.flags["branch"]) ?? "main" }) },
        service: { name: service, runtime, build: [split(str(ctx.flags["build"]), runtime === "java" ? ["mvn", "-B", "-DskipTests", "package"] : ["npm", "ci"])], start: split(str(ctx.flags["start"]), runtime === "java" ? ["java", "-jar", "target/app.jar", "--server.port={port}"] : ["node", "dist/main.js"]), health: { readyPath: "/health/ready", timeoutSeconds: 60 }, shutdownGraceSeconds: 30, route: { path: "/" } },
        strategy: strategy === "recreate" ? { type: "recreate", proxy: "none", downtimeAcknowledged: true, rollback: true } : { type: strategy, proxy: "nginx", rollback: true, autoRollback: true, drainSeconds: 10, retention: { keep: 5 } },
        ...(strategy === "recreate" ? {} : { proxy: { nginx: { ...(str(ctx.flags["domain"]) ? { domains: [str(ctx.flags["domain"])] } : {}), listen: { http: Number(str(ctx.flags["http-port"]) ?? 80) } } } }),
        pipeline: envName,
      };
      if (strategy === "recreate") (decl["service"] as Record<string, unknown>)["port"] = 8080;
      const errs = validateDeployment(decl).filter((d) => d.level === "error");
      if (errs.length) throw new CliError(`the generated declaration is invalid:\n${errs.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
      const pipeline = { name: envName, stages: [{ type: "integrity" }, { type: "compatibility" }, { type: "security", enabled: envName === "production" || envName === "staging" }, { type: "tests", enabled: false }, { type: "resources" }, { type: "build" }, { type: "health" }, { type: "deploy" }] };
      const root = roots(ctx);
      const files: Record<string, string> = {
        [`deploy/${envName}.deployment.pso.ts`]: `import { defineDeployment } from "@pso/deploy";\n\n// Declares WHERE and HOW this project is deployed. It holds references, never credentials: the connection "${conn}" and any secret are\n// stored with \`pso connection:add\` and \`pso environment:secret\`. Read statically: nothing in this file is executed.\nexport default defineDeployment(${JSON.stringify(decl, null, 2)});\n`,
        [`deploy/${envName}.pipeline.pso.ts`]: `import { definePipeline } from "@pso/deploy";\n\n// Optional stages can be turned off. The mandatory protections (identity, authorization, locking, release integrity, a valid\n// proxy configuration, candidate readiness) are part of the engine and are not stages: no setting here disables them.\nexport default definePipeline(${JSON.stringify(pipeline, null, 2)});\n`,
      };
      const out: Array<{ path: string; action: string }> = [];
      for (const [rel, text] of Object.entries(files)) {
        const abs = join(root, rel); const exists = existsSync(abs);
        if (exists && ctx.flags["force"] !== true) { out.push({ path: rel, action: "exists (kept; use --force to replace)" }); continue; }
        if (ctx.flags["dry-run"] !== true) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }
        out.push({ path: rel, action: exists ? "replaced" : "created" });
      }
      emit(ctx, { dryRun: ctx.flags["dry-run"] === true, files: out }, `${out.map((o) => `${ctx.flags["dry-run"] === true ? "[dry-run] " : ""}${o.action.padEnd(10)} ${o.path}`).join("\n")}\nNext: \`pso pipeline:validate ${envName}\`, then \`pso release:plan ${envName}\``);
      return 0;
    },
  },
  "environment:list": {
    usage: "pso environment:list [--json]", summary: "List the environments declared in this project (deploy/*.deployment.pso.ts) with their connection, strategy and declaration problems",
    run(ctx) {
      const decls = discoverDeclarations(roots(ctx)).filter((d) => d.kind === "deployment"); const cloud = cloudFactory();
      const rows = decls.map((d) => { const v = d.value as DeploymentDecl | undefined; const c = v ? cloud.store.connection(v.connection?.credentials) : undefined; return { environment: v?.environment ?? "?", name: v?.name ?? d.name, file: d.relative, connection: v?.connection?.credentials, connectionState: c ? (c.revoked ? "revoked" : c.clientId ? "enrolled" : "registered") : "missing", strategy: v?.strategy?.type, services: v ? servicesOf(v).map((s) => s.name) : [], problems: d.diagnostics.filter((x) => x.level === "error").length, warnings: d.diagnostics.filter((x) => x.level === "warning").length }; });
      emit(ctx, rows, rows.length ? rows.map((r) => `${r.environment.padEnd(12)} ${r.name.padEnd(18)} ${String(r.strategy).padEnd(10)} connection ${r.connection} (${r.connectionState})  ${r.file}${r.problems ? `  ${r.problems} PROBLEM(S)` : ""}`).join("\n") : "no deployment declarations: `pso environment:add`"); return 0;
    },
  },
  "environment:inspect": {
    usage: "pso environment:inspect <environment> [--json]", summary: "Inspect the remote server (OS, CPU, memory, disk, ports, Java, Node, git, nginx, existing PSO apps and vhosts); read-only",
    run: (ctx) => wrap(async () => {
      const { cloud, conn } = envContext(ctx, need(ctx, 0, "environment"));
      const i = await cloud.with(conn, (c) => c.call<any>("inspect"));
      emit(ctx, i, `${i.os.distro ?? i.os.platform} ${i.os.arch}, ${i.cpu.count} CPU, ${i.memory.availableMb}/${i.memory.totalMb} MB memory free, ${i.disk.freeMb} MB disk free; agent runs as ${i.user.name}${i.user.root ? " (ROOT)" : ""}\ntools: ${Object.entries(i.tools).map(([k, v]: any) => `${k} ${v.available ? v.version ?? "yes" : "no"}`).join(", ")}\nlistening ports: ${i.listeningPorts.map((p: any) => `${p.port}${p.address === "127.0.0.1" ? "(loopback)" : ""}`).join(" ")}\nnginx vhosts: ${i.nginx.vhosts.map((v: any) => `${v.managed ? "[PSO]" : "[external]"} ${v.file}`).join("; ") || "none"}\napps managed by PSO: ${i.pso.apps.map((a: any) => `${a.name}@${a.activeRelease ?? "-"}`).join(", ") || "none"}\n${i.blockers.length ? `BLOCKERS:\n${i.blockers.map((b: string) => `  - ${b}`).join("\n")}` : "no blockers"}`);
      return i.blockers.length ? 1 : 0;
    }),
  },
  "environment:plan": {
    usage: "pso environment:plan <environment> [--json]", summary: "Show what provisioning would do on the server: steps PSO performs unprivileged, steps an administrator must run, and the exact script for them (nothing is executed)",
    run: (ctx) => wrap(async () => {
      const { cloud, conn } = envContext(ctx, need(ctx, 0, "environment"));
      const p = await cloud.with(conn, (c) => c.call<any>("provision.plan"));
      emit(ctx, p, `${p.steps.map((s: any) => `${({ ok: "OK   ", agent: "AGENT", admin: "ADMIN", info: "INFO " } as any)[s.status]} ${s.title}: ${s.detail}`).join("\n")}\n\n${p.note}\n\nAdministrator script (review it; PSO never runs it):\n${p.adminScript}`); return 0;
    }),
  },
  "environment:provision": {
    usage: "pso environment:provision <environment> --yes [--json]", summary: "Apply the unprivileged provisioning steps (agent directories, default policy). Idempotent. Privileged steps are only listed: PSO never installs packages, edits nginx.conf, changes firewall rules or replaces existing configuration",
    run: (ctx) => wrap(async () => { yes(ctx, "provisioning"); const { cloud, conn } = envContext(ctx, need(ctx, 0, "environment")); const r = await cloud.with(conn, (c) => c.call<any>("provision.apply")); emit(ctx, r, `applied: ${r.applied.join("; ") || "nothing to do (already converged)"}\nstill needs an administrator: ${r.remaining.join(", ") || "nothing"}`); return 0; }),
  },
  "environment:secret": {
    usage: "pso environment:secret <environment> <name> [--remove] [--list] [--json]", summary: "Store a named secret on the server (value from standard input or a hidden prompt) for services to receive as environment variables; --list shows names only, never values",
    args: 2,
    run: (ctx) => wrap(async () => {
      const { cloud, conn } = envContext(ctx, need(ctx, 0, "environment"));
      if (ctx.flags["list"] === true) { const l = await cloud.with(conn, (c) => c.call<string[]>("secret.list")); emit(ctx, l, l.join("\n") || "no secrets"); return 0; }
      const name = need(ctx, 1, "secret name");
      if (ctx.flags["remove"] === true) { await cloud.with(conn, (c) => c.call("secret.remove", { name })); cloud.store.audit("secret.removed", { connection: conn, name }); emit(ctx, { removed: name }, `secret ${name} removed`); return 0; }
      const value = await input.secret(`Value of ${name}: `);
      await cloud.with(conn, (c) => c.call("secret.set", { name, value })); cloud.store.audit("secret.set", { connection: conn, name });
      emit(ctx, { stored: name }, `secret ${name} stored on the server (mode 600); it is not shown again`); return 0;
    }),
  },
  "environment:policy": {
    usage: "pso environment:policy <environment> [--set key=value] [--compat] [--migrate <id>] [--history] [--revert <entry>] [--yes] [--json]", summary: "Show the server-side deployment policy (mode, approvals, allowed strategies, retention...); --set changes it (superadministrator, audited). The server policy overrides anything a project declares",
    run: (ctx) => wrap(async () => {
      const { cloud, conn } = envContext(ctx, need(ctx, 0, "environment"));
      if (ctx.flags["compat"] === true) {
        const c = await cloud.with(conn, (x) => x.call<any>("policy.compat"));
        const lines = [`agent ${c.agentVersion}, policy version ${c.policyVersion} (${c.policyVersionSupported ? "understood" : "NOT understood"})`, "", "capabilities:", ...c.capabilities.map((k: any) => `  ${k.status === "permitted" ? "permitted    " : "NOT PERMITTED"} ${k.id.padEnd(22)} since ${k.introducedIn}  ${k.summary}`), "", c.migrations.some((m: any) => m.pending) ? "pending migrations (nothing is applied until an administrator runs one):" : "no pending migration"];
        for (const m of c.migrations.filter((x: any) => x.pending)) lines.push(`  ${m.id}: ${m.summary}`, ...Object.entries(m.changes).map(([k, v]: any) => `      ${k}: ${JSON.stringify(v.from)} -> ${JSON.stringify(v.to)}`), `      preview and apply: pso environment:policy ${conn} --migrate ${m.id} [--yes]`);
        lines.push("", ...c.notes); emit(ctx, c, lines.join("\n")); return 0;
      }
      if (ctx.flags["history"] === true) { const h = await cloud.with(conn, (x) => x.call<any>("policy.history")); emit(ctx, h, h.entries.length ? h.entries.map((e: any) => `${e.id}  ${e.at}  ${e.by}  ${e.kind}${e.migration ? " " + e.migration : ""}${e.revertedBy ? " (reverted by " + e.revertedBy + ")" : ""}: ${Object.entries(e.changes).map(([k, v]: any) => `${k} ${JSON.stringify(v.from)} -> ${JSON.stringify(v.to)}`).join("; ")}`).join("\n") : "no policy change has been recorded"); return 0; }
      const mig = str(ctx.flags["migrate"]);
      if (mig) {
        const pv = await cloud.with(conn, (x) => x.call<any>("policy.migrate", { id: mig, preview: true }));
        const p = pv.preview;
        const show = [`migration ${p.id} (introduced in ${p.introducedIn}): ${p.summary}`, "it permits:", ...p.grants.map((g: string) => `  - ${g}`), p.pending ? "exact difference:" : "nothing to change: the policy already satisfies it", ...Object.entries(p.changes).map(([k, v]: any) => `  ${k}: ${JSON.stringify(v.from)} -> ${JSON.stringify(v.to)}`)].join("\n");
        if (!p.pending || ctx.flags["yes"] !== true) { emit(ctx, pv, show + (p.pending ? "\nnothing was changed: repeat with --yes to apply exactly this difference (superadministrator, audited, reversible with --revert)" : "")); return 0; }
        const r = await cloud.with(conn, (x) => x.call<any>("policy.migrate", { id: mig, digest: p.digest })); cloud.store.audit("policy.migrated", { connection: conn, migration: mig, entry: r.entry });
        emit(ctx, r, show + `\napplied (history entry ${r.entry}); undo with: pso environment:policy ${conn} --revert ${r.entry} --yes`); return 0;
      }
      const rev = str(ctx.flags["revert"]);
      if (rev) { yes(ctx, "reverting a server policy change"); const r = await cloud.with(conn, (x) => x.call<any>("policy.revert", { entry: rev })); cloud.store.audit("policy.reverted", { connection: conn, entry: rev }); emit(ctx, r, `reverted ${r.reverted}: restored ${JSON.stringify(r.restored)}`); return 0; }
      const sets = str(ctx.flags["set"]);
      if (sets) {
        yes(ctx, "changing the server policy");
        const changes: Record<string, unknown> = {};
        for (const kv of sets.split("\n")) { const m = /^([A-Za-z]+)=(.*)$/.exec(kv); if (!m) throw new CliError(`--set expects key=value (got "${kv}")`); const v = m[2]!; changes[m[1]!] = v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v.includes(",") && m[1] === "allowedStrategies" ? v.split(",") : m[1] === "allowedStrategies" ? [v] : v; }
        const r = await cloud.with(conn, (c) => c.call<any>("policy.set", { changes })); cloud.store.audit("policy.changed", { connection: conn, changed: r.changed });
        emit(ctx, r, `policy updated: ${Object.entries(r.changed).map(([k, v]: any) => `${k}: ${JSON.stringify(v.from)} -> ${JSON.stringify(v.to)}`).join("; ") || "no change"}`); return 0;
      }
      const p = await cloud.with(conn, (c) => c.call<any>("policy.get")); emit(ctx, p, Object.entries(p).map(([k, v]) => `${k.padEnd(28)} ${JSON.stringify(v)}`).join("\n")); return 0;
    }),
  },
  "environment:access": {
    usage: "pso environment:access <environment> [--invite viewer|operator|deployer|admin] [--minutes 15] [--revoke <client-id>] [--json]", summary: "List who may manage the environment; --invite creates a single-use enrollment token for a teammate (shown once), --revoke ends a client's access immediately",
    run: (ctx) => wrap(async () => {
      const { cloud, conn } = envContext(ctx, need(ctx, 0, "environment"));
      const inv = str(ctx.flags["invite"]); const rev = str(ctx.flags["revoke"]);
      if (rev) { await cloud.with(conn, (c) => c.call("client.revoke", { clientId: rev })); cloud.store.audit("client.revoked", { connection: conn, target: rev }); emit(ctx, { revoked: rev }, `access of ${rev} revoked; its sessions ended`); return 0; }
      if (inv) { const t = await cloud.with(conn, (c) => c.call<any>("enroll.create", { role: inv, minutes: Number(str(ctx.flags["minutes"]) ?? 15) })); cloud.store.audit("enroll.token-created", { connection: conn, role: inv }); emit(ctx, t, `enrollment token (role ${t.role}, expires ${t.expiresAt}, single use). Give it to the teammate over a private channel; they run \`pso agent:enroll <connection>\`:\n${t.token}`); return 0; }
      const l = await cloud.with(conn, (c) => c.call<any[]>("client.list")); emit(ctx, l, l.map((c) => `${c.revoked ? "revoked " : "active  "} ${c.role.padEnd(10)} ${c.name.padEnd(28)} ${c.id}`).join("\n")); return 0;
    }),
  },


  // ------------------------------------------------------------------ release signing and trusted signers
  "signer:generate": {
    usage: "pso signer:generate <name> [--json]", summary: "Create an Ed25519 release-signing key on THIS machine. The private key goes to the protected credential store (never to a file, a project or a server); the public key is what an environment is told to trust",
    args: 1,
    run: (ctx) => wrap(async () => { const s = cloudFactory().signerGenerate(need(ctx, 0, "signer name")); emit(ctx, s, `signer "${s.name}" created\n  key id  ${s.keyId}\n  The private key is in this machine's credential store. Trust it on an environment with: pso trust:add <environment> --signer "${s.name}" --yes`); return 0; }),
  },
  "signer:list": {
    usage: "pso signer:list [--json]", summary: "List the signing identities of this machine (names, key ids, public keys; never private keys)",
    run: (ctx) => wrap(async () => { const l = cloudFactory().signers(); emit(ctx, l, l.map((s) => `${s.name.padEnd(24)} ${s.keyId}  created ${s.createdAt}`).join("\n") || "no signers (create one with pso signer:generate)"); return 0; }),
  },
  "signer:remove": {
    usage: "pso signer:remove <name> --yes [--json]", summary: "Delete a signing key from THIS machine. It does not revoke trust on servers: if the key may be compromised, run pso trust:revoke on every environment first",
    args: 1,
    run: (ctx) => wrap(async () => { yes(ctx, "removing a signing key"); const r = cloudFactory().signerRemove(need(ctx, 0, "signer name")); emit(ctx, r, r.removed ? "signer removed from this machine (servers that trust its public key still do, until you revoke it there)" : "no such signer"); return r.removed ? 0 : 1; }),
  },
  "release:sign": {
    usage: "pso release:sign <environment> --signer <name> --sequence <n> [--path <checkout>] [--artifact <file>] [--out <file>] [--json]", summary: "Sign the release manifest (application, immutable commit or artifact checksum, strictly increasing sequence) with a local signer. The server verifies it against its own trust store and refuses replays and downgrades",
    args: 1,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "environment")); const signer = str(ctx.flags["signer"]); const seq = Number(str(ctx.flags["sequence"])); if (!signer) throw new CliError("--signer <name> is required"); if (!Number.isInteger(seq)) throw new CliError("--sequence <n> is required (greater than the last signed release of this application)");
      const path = str(ctx.flags["path"]) ?? e.root; const art = str(ctx.flags["artifact"]);
      const manifest = e.cloud.buildManifest({ app: e.decl.name, path, sequence: seq, ...(art ? { artifactFile: art } : {}), ...(e.decl.source.provider === "git" ? { url: e.decl.source.url } : {}) });
      const signed = e.cloud.signRelease(signer, manifest); const out = str(ctx.flags["out"]) ?? join(e.root, `${e.decl.name}.release.signed.json`);
      mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(signed, null, 2));
      emit(ctx, { file: out, manifest, keyId: signed.signatures[0]!.keyId }, `signed ${e.decl.name} sequence ${seq} (${manifest.source.kind === "git" ? `commit ${manifest.source.commit}` : `sha256 ${manifest.source.sha256.slice(0, 16)}…`})\n  wrote ${out}\n  plan it with: pso release:plan ${e.decl.environment} --signed ${out}`); return 0;
    }),
  },
  "release:verify": {
    usage: "pso release:verify <environment> --signed <file> [--json]", summary: "Ask the environment's SERVER whether a signed manifest is authentic (a trusted, unrevoked signer) and integral (it names exactly the release), reporting the two separately",
    args: 1,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "environment")); const f = str(ctx.flags["signed"]); if (!f) throw new CliError("--signed <file> is required");
      const signed = JSON.parse(readFileSync(f, "utf8")) as import("@pso/deploy").SignedManifest; const m = JSON.parse(signed.manifest) as import("@pso/deploy").ReleaseManifest;
      const r = await e.cloud.verifyOnServer(e.conn, m.app, signed, m.source.kind === "git" ? { kind: "git", commit: m.source.commit } : { kind: "artifact", sha256: m.source.sha256 }) as import("@pso/deploy").Provenance;
      emit(ctx, r, `authenticity: ${r.authenticity}\nintegrity:    ${r.integrity}\n${r.reasons.map((x) => "  - " + x).join("\n")}`); return r.authenticity === "verified" ? 0 : 1;
    }),
  },
  "trust:list": {
    usage: "pso trust:list <environment> [--json]", summary: "Show which signers the environment's server trusts (and which were revoked or expired)",
    args: 1,
    run: (ctx) => wrap(async () => { const e = envContext(ctx, need(ctx, 0, "environment")); const l = await e.cloud.trustList(e.conn); emit(ctx, l, l.map((s) => `${s.revokedAt ? "revoked " : "trusted "} ${s.name.padEnd(22)} ${s.keyId}${s.apps ? `  apps ${s.apps.join(",")}` : ""}${s.notAfter ? `  until ${s.notAfter}` : ""}${s.revokedReason ? `  (${s.revokedReason})` : ""}`).join("\n") || "no trusted signers"); return 0; }),
  },
  "trust:add": {
    usage: "pso trust:add <environment> (--signer <name> | --public-key-file <file> --name <name>) [--apps a,b] [--not-after <date>] --yes [--json]", summary: "Make the environment trust a signer's PUBLIC key (superadministrator, audited). A server that requires signed releases accepts only signers added here; no project file can add one",
    args: 1,
    run: (ctx) => wrap(async () => {
      yes(ctx, "changing the trusted signers of an environment"); const e = envContext(ctx, need(ctx, 0, "environment")); const pk = str(ctx.flags["public-key-file"]);
      const r = await e.cloud.trustAdd(e.conn, { ...(str(ctx.flags["signer"]) ? { signer: str(ctx.flags["signer"])! } : {}), ...(pk ? { publicKey: readFileSync(pk, "utf8") } : {}), ...(str(ctx.flags["name"]) ? { name: str(ctx.flags["name"])! } : {}), ...(str(ctx.flags["apps"]) ? { apps: str(ctx.flags["apps"])!.split(",").map((x) => x.trim()) } : {}), ...(str(ctx.flags["not-after"]) ? { notAfter: str(ctx.flags["not-after"])! } : {}) });
      emit(ctx, r, `${e.decl.environment} now trusts "${r.name}" (${r.keyId})`); return 0;
    }),
  },
  "trust:revoke": {
    usage: "pso trust:revoke <environment> <key-id> [--reason <text>] --yes [--json]", summary: "Revoke a trusted signer (superadministrator, audited). A revoked key is never trusted again; releases it signed no longer qualify, including for rollback where signing is required",
    args: 2,
    run: (ctx) => wrap(async () => { yes(ctx, "revoking a trusted signer"); const e = envContext(ctx, need(ctx, 0, "environment")); const id = need(ctx, 1, "key id"); const r = await e.cloud.trustRevoke(e.conn, id, str(ctx.flags["reason"])); emit(ctx, r, `signer ${id} revoked on ${e.decl.environment}`); return 0; }),
  },


  // ------------------------------------------------------------------ operational visibility
  "release:url": {
    usage: "pso release:url <application> [--verify] [--tunnel] [--ca-file <pem>] [--save-ca] [--json]", summary: "Where the deployed application can be reached, from the deployment metadata and the REAL nginx file; --verify measures each layer independently (process, local health, proxy, this machine, TLS, optional SSH tunnel). COMPLETED is not proof of public access",
    args: 1,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "application")); const ca = str(ctx.flags["ca-file"]); if (ca && ctx.flags["save-ca"] === true) e.cloud.setTlsCa(e.conn, ca);
      const ov = await e.cloud.applicationOverview(e.conn, e.decl.name); const lines = [`${ov.app}  environment ${ov.environment}  release ${ov.release.active ?? "none"}  (previous ${ov.release.previous ?? "none"})  strategy ${ov.strategy}  runtime ${ov.runtime.supervisor}  server ${ov.server.address}`];
      for (const u of ov.resolvedUrls) lines.push(`  ${u.visibility === "private" ? "private  " : u.redirectsTo ? "redirect " : "public   "} ${u.url}${u.service ? `  -> ${u.service}` : ""}${u.tls ? "  [TLS]" : ""}${u.hostNote ? `  (${u.hostNote})` : ""}`);
      if (!ov.resolvedUrls.length) lines.push("  (no URL: the application has no nginx server block)");
      let reach; if (ctx.flags["verify"] === true || ctx.flags["tunnel"] === true) { reach = await e.cloud.reachability(e.conn, e.decl.name, { ...(ca ? { caFile: ca } : {}), tunnel: ctx.flags["tunnel"] === true }); lines.push("", "  access layers (each measured on its own):"); for (const s of reach.steps) lines.push(`    ${s.status.padEnd(14)} ${s.label}: ${s.detail}`); for (const d of reach.diagnosis) lines.push(`  diagnosis: ${d}`); lines.push(`  ${reach.note}`); }
      emit(ctx, { overview: ov, ...(reach ? { reachability: reach } : {}) }, lines.join("\n")); return reach && reach.steps.some((s) => s.id === "client-direct" && s.status === "failed") ? 1 : 0;
    }),
  },
  "release:endpoints": {
    usage: "pso release:endpoints <application> [--json]", summary: "The routes published WITH the active release (method, effective URL, controller, service, guard, required scopes), from release metadata; a release without metadata says so. Declared, deployed and verified are different states: nothing here is 'verified' until a request proves it",
    args: 1,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "application")); const r = await e.cloud.endpoints(e.conn, e.decl.name);
      emit(ctx, r, r.published ? [`${r.app}  release ${r.release}  base ${r.baseUrl ?? "(no public URL)"}`, ...r.routes.map((x: any) => `  ${String(x.method).padEnd(7)} ${String(x.path).padEnd(28)} ${(x.public ? "public" : `jwt ${(x.scopes ?? []).join(",")}`).padEnd(28)} ${x.service || (x.services ?? []).join(",")}  ${x.controller}.${x.action}`)].join("\n") : `no endpoints: ${r.reason}`); return 0;
    }),
  },
  "environment:network": {
    usage: "pso environment:network <application> [--verify] [--json]", summary: "Every listening socket of the server, who owns it and whether it is meant to be public. Flags internal infrastructure (RabbitMQ, Redis, PostgreSQL, Kafka, PSO services) on all interfaces as potentially unsafe and prints a remediation plan; it changes nothing. --verify adds a TCP check from this machine",
    args: 1,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "application")); const r = await e.cloud.exposure(e.conn, { verifyFromClient: ctx.flags["verify"] === true });
      const L = r.listeners.map((l: any) => `  ${(l.address + ":" + l.port).padEnd(24)} ${l.binding.padEnd(15)} ${l.component.padEnd(22)} ${l.verdict}${l.clientProbe ? `  [from this machine: ${l.clientProbe.result}]` : ""}`);
      const F = r.findings.flatMap((f: any) => [`\n  ${f.severity.toUpperCase()}: ${f.title}`, `    ${f.implication}`, ...f.remediation.map((x: string) => `    - ${x}`)]);
      emit(ctx, r, [`listeners (policy: public ports ${r.policy.intentionallyPublicPorts.join(",")}; ${r.policy.infrastructureNetwork}):`, ...L, ...(F.length ? ["", "findings:", ...F, "", "  " + r.remediation] : ["", "no unexpected exposure"]), "", ...r.notes.map((n: string) => "  note: " + n)].join("\n")); return r.findings.length ? 1 : 0;
    }),
  },
  "environment:privileges": {
    usage: "pso environment:privileges <application> [--json]", summary: "The EFFECTIVE sudo privilege of the agent's user: none, restricted (exact commands), broad (wildcards, shells, editors), unrestricted or unknown. A privileged command that works is never read as least privilege",
    args: 1,
    run: (ctx) => wrap(async () => { const e = envContext(ctx, need(ctx, 0, "application")); const p = await e.cloud.privileges(e.conn); emit(ctx, p, [`user ${p.user} (uid ${p.uid}), groups: ${p.groups.join(" ")}`, `effective sudo privilege: ${p.level.toUpperCase()}  passwordless: ${p.passwordless}  narrow policy verified: ${p.narrowPolicyVerified ? "yes" : "NO"}`, ...p.commands.map((c: string) => `  rule: ${c}`), ...p.evidence.map((x: string) => `  evidence: ${x}`), "", p.recommendation].join("\n")); return p.narrowPolicyVerified || p.level === "none" ? 0 : 1; }),
  },
  "release:config": {
    usage: "pso release:config <application> [--json]", summary: "The effective configuration of the ACTIVE release as the server holds it: services, ports, routes, health, environment variables (values that look like secrets are redacted) and secret reference names. Never a secret value.",
    args: 1,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "application")); const r = await e.cloud.appConfig(e.conn, e.decl.name);
      const lines: string[] = [`${r.app}  environment ${r.environment ?? "?"}  release ${r.release ?? "none"}  strategy ${r.strategy?.type ?? "?"}  runtime ${r.runtime?.supervisor ?? "?"}`];
      for (const s of r.services ?? []) { lines.push("", `service ${s.name} (${s.runtime})  route ${s.route ?? "-"}  port ${s.port}  stable port ${s.stablePort ?? "-"}  instances ${s.instances}`, ...s.env.map((v: any) => `  ${v.name.padEnd(34)} ${v.sensitive ? "[REDACTED]" : v.value}`), ...(Array.isArray(s.secretReferences) && s.secretReferences.length ? [`  secrets by reference: ${s.secretReferences.length} (names are in the declaration; values are never shown)`] : [])); }
      emit(ctx, r, lines.join("\n")); return 0;
    }),
  },
  "release:nginx": {
    usage: "pso release:nginx <application> [--show <file>] [--validate <file> [--content <local-file>]] [--apply <file> --content <local-file> --base <sha256> --yes] [--enable <file> --yes] [--disable <file> --yes] [--backups] [--restore <backup-id> --yes] [--json]", summary: "The real nginx configuration of the server: files, enabled links, effective includes, virtual hosts, upstreams, TLS paths and which files PSO manages. Edits are limited to PSO-managed files, are linted, checked against concurrent changes, validated by nginx -t and restored automatically on failure",
    args: 1,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "application")); const show = str(ctx.flags["show"]); const applyF = str(ctx.flags["apply"]); const valF = str(ctx.flags["validate"]); const restore = str(ctx.flags["restore"]); const en = str(ctx.flags["enable"]); const dis = str(ctx.flags["disable"]);
      if (show) { const r = await e.cloud.nginxRead(e.conn, show); emit(ctx, r, `# ${r.path}  [${r.managedBy}${r.app ? ` app=${r.app}` : ""}${r.release ? ` release=${r.release}` : ""}]  sha256 ${r.sha256}  ${r.editable ? "editable by PSO" : "read-only (external)"}\n${r.content}`); return 0; }
      if (valF) { const cf = str(ctx.flags["content"]); const text = cf ? readFileSync(cf, "utf8") : (await e.cloud.nginxRead(e.conn, valF)).content; const p = e.cloud.nginxLint(text); emit(ctx, { file: valF, problems: p }, p.length ? `REFUSED:\n${p.map((x) => "  - " + x).join("\n")}\n(nginx -t runs when you apply)` : "lint passed: no forbidden directive. nginx -t runs when you apply, and the previous file is restored if it fails"); return p.length ? 1 : 0; }
      if (restore) { yes(ctx, "restoring an nginx configuration"); const r = await e.cloud.nginxApply(e.conn, { file: str(ctx.flags["file"]) ?? (await e.cloud.nginxBackups(e.conn, e.decl.name)).find((b) => b.id === restore)?.file ?? "", action: "restore", backupId: restore }); emit(ctx, r, "restored and reloaded"); return 0; }
      if (applyF) { yes(ctx, "changing an nginx configuration"); const cf = str(ctx.flags["content"]); const base = str(ctx.flags["base"]); if (!cf || !base) throw new CliError("--content <local-file> and --base <sha256 of the file you started from> are required"); const r = await e.cloud.nginxApply(e.conn, { file: applyF, action: "edit", content: readFileSync(cf, "utf8"), expectedHash: base }); emit(ctx, r, `applied and reloaded; backup ${r.backupId}. ${r.note}`); return 0; }
      if (en || dis) { yes(ctx, "enabling or disabling a virtual host"); const r = await e.cloud.nginxApply(e.conn, { file: (en ?? dis)!, action: en ? "enable" : "disable" }); emit(ctx, r, en ? "enabled" : "disabled"); return 0; }
      if (ctx.flags["backups"] === true) { const b = await e.cloud.nginxBackups(e.conn, e.decl.name); emit(ctx, b, b.map((x) => `${x.id}  ${x.at}  ${x.file}`).join("\n") || "no backups"); return 0; }
      const v = await e.cloud.nginxView(e.conn);
      emit(ctx, v, [`main configuration ${v.mainConf}`, ...v.files.map((f: any) => `  ${f.managedBy === "pso" ? "PSO     " : "external"} ${f.kind.padEnd(15)} ${f.path}${f.symlinkTarget ? ` -> ${f.symlinkTarget}` : ""}  ${f.effective ? "effective" : "NOT effective"}${f.app ? `  app=${f.app}` : ""}${f.release ? ` release=${f.release}` : ""}${f.servers.length ? `  servers: ${f.servers.map((s: any) => `${s.names.join(" ") || "_"}[${s.listens.map((l: any) => l.port + (l.ssl ? "s" : "")).join(",")}]`).join(" ")}` : ""}`), ...v.notes.map((n: string) => `  note: ${n}`)].join("\n")); return 0;
    }),
  },

  "pipeline:validate": {
    usage: "pso pipeline:validate [<environment>] [--json]", summary: "Statically validate deployment and pipeline declarations (no network, no code executed): structure, secrets in declarations, strategy feasibility, stage order and dependencies",
    run(ctx) {
      const decls = discoverDeclarations(roots(ctx)); const env = ctx.positionals[0];
      const picked = env ? decls.filter((d) => d.environment === env || d.name === env || (d.kind === "pipeline" && d.name === env)) : decls;
      if (env && !picked.length) throw new CliError(`no declaration found for "${env}"`);
      if (!picked.length) throw new CliError("no deployment or pipeline declarations found", "Create them with `pso environment:add`");
      let errors = 0; const lines: string[] = [];
      for (const d of picked) {
        const e = d.diagnostics.filter((x) => x.level === "error"), w = d.diagnostics.filter((x) => x.level === "warning"); errors += e.length;
        lines.push(`${e.length ? "FAIL" : "OK  "} ${d.relative}  (${d.kind} ${d.name})`); for (const x of [...e, ...w]) lines.push(`     ${x.level.toUpperCase().padEnd(7)} ${x.path}  ${x.message}`);
      }
      const dp = picked.find((d) => d.kind === "pipeline"); void dp; void validatePipeline; void DEFAULT_PIPELINE;
      emit(ctx, { ok: errors === 0, files: picked.map((d) => ({ file: d.relative, kind: d.kind, errors: d.diagnostics.filter((x) => x.level === "error"), warnings: d.diagnostics.filter((x) => x.level === "warning") })) }, `${lines.join("\n")}\nStatic validation only: no server was contacted and no project code was executed.`);
      return errors ? 1 : 0;
    },
  },

  "release:plan": {
    usage: "pso release:plan <environment> [--branch <branch>] [--tag <tag>] [--commit <sha>] [--signed <file>] [--json]", summary: "Ask the server for a deployment plan: resolves the branch or tag to an immutable commit, checks resources, strategy, nginx, policy and pipeline. Changes nothing but the stored proposal",
    next: "`pso release:deploy <environment> --plan <hash> --yes`",
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "environment")); const plan = await e.cloud.plan(e.conn, e.decl, e.pipeline?.value as never, e.root, signedFrom(ctx));
      emit(ctx, { plan, overrides: e.overrides }, `${e.overrides.map((o) => `note: ${o}\n`).join("")}${formatPlan(plan)}\n\nplan hash: ${plan.hash}`); return plan.blockers.length ? 1 : 0;
    }),
  },
  "release:approve": {
    usage: "pso release:approve <environment> --plan <hash> [--json]", summary: "Approve a proposed plan (the server policy decides whether the proposer may approve their own plan). The approval is bound to the plan hash, the commit and the policy",
    run: (ctx) => wrap(async () => { const e = envContext(ctx, need(ctx, 0, "environment")); const h = str(ctx.flags["plan"]); if (!h) throw new CliError("--plan <hash> is required"); const r = await e.cloud.approve(e.conn, e.decl.name, h); emit(ctx, r, `approved: ${r.approvals} of ${r.required} required`); return 0; }),
  },
  "release:deploy": {
    usage: "pso release:deploy <environment> [--plan <hash>] [--branch <branch>] [--tag <tag>] [--commit <sha>] [--signed <file>] [--approve] [--no-follow] --yes [--json]", summary: "Deploy: with --plan, exactly that approved plan; without it, a fresh plan is made, shown and executed. The deployment runs on the server and continues if this command or your connection ends",
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "environment"));
      let hash = str(ctx.flags["plan"]); let plan: Plan | undefined;
      if (!hash) {
        plan = await e.cloud.plan(e.conn, e.decl, e.pipeline?.value as never, e.root, signedFrom(ctx));
        ctx.print(`${e.overrides.map((o) => `note: ${o}\n`).join("")}${formatPlan(plan)}\n`);
        if (plan.blockers.length) return 1;
        hash = plan.hash;
      }
      yes(ctx, `deploying ${e.decl.name} to ${e.decl.environment}`);
      if (ctx.flags["approve"] === true) { const r = await e.cloud.approve(e.conn, e.decl.name, hash); ctx.print(`approved (${r.approvals}/${r.required})`); }
      const d = await e.cloud.start(e.conn, e.decl.name, hash); ctx.print(`deployment ${d.id} started on the server (release ${d.releaseId})`);
      if (ctx.flags["no-follow"] === true) { emit(ctx, d, `follow it with: pso release:status ${e.decl.environment} --deployment ${d.id}`); return 0; }
      const end = await e.cloud.follow(e.conn, e.decl.name, d.id, (x) => { if (!json(ctx)) ctx.print(`  ${x.effectiveState}${x.stages.length ? `  [${x.stages.map((s) => `${s.id}:${s.status}`).join(" ")}]` : ""}`); });
      emit(ctx, end, formatDeployment(end)); return end.effectiveState === "COMPLETED" ? 0 : 1;
    }),
  },
  "release:status": {
    usage: "pso release:status <environment> [--deployment <id>] [--json]", summary: "Active, previous and last known-good release, the lock, the services and the latest (or chosen) deployment as the server sees it (INTERRUPTED when its worker is gone)",
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "environment")); const dep = str(ctx.flags["deployment"]);
      const s = await e.cloud.with(e.conn, (c) => c.call<any>("release.status", { app: e.decl.name, ...(dep ? { deployment: dep } : {}) }));
      emit(ctx, s, `${e.decl.name}: active ${s.active?.release ?? "none"}  previous ${s.previous ?? "none"}  last known-good ${s.lastKnownGood ?? "none"}  lock ${s.lock.status}\n${s.services.map((x: any) => `  ${x.service}#${x.instance} ${x.running ? "running" : "NOT running"} pid ${x.pid} port ${x.port}`).join("\n")}\n${s.deployment ? formatDeployment(s.deployment) : "no deployments yet"}`); return 0;
    }),
  },
  "release:history": {
    usage: "pso release:history <environment> [--limit 20] [--json]", summary: "Deployment history from the server (newest first): who, what, strategy, outcome",
    run: (ctx) => wrap(async () => { const e = envContext(ctx, need(ctx, 0, "environment")); const h = await e.cloud.with(e.conn, (c) => c.call<any[]>("release.history", { app: e.decl.name, limit: Number(str(ctx.flags["limit"]) ?? 20) })); emit(ctx, h, h.map((d) => `${d.startedAt}  ${d.id}  ${d.kind.padEnd(8)} ${String(d.effectiveState).padEnd(12)} ${d.releaseId}  ${d.strategy}  by ${d.requestedBy?.name ?? "?"}${d.error ? `  (${String(d.error).slice(0, 80)})` : ""}`).join("\n") || "no deployments yet"); return 0; }),
  },
  "release:cancel": {
    usage: "pso release:cancel <environment> --deployment <id> --yes [--json]", summary: "Cancel a running deployment at the next safe point (before traffic moves); the active release is untouched. After traffic moved, use rollback",
    run: (ctx) => wrap(async () => { yes(ctx, "cancelling"); const e = envContext(ctx, need(ctx, 0, "environment")); const id = str(ctx.flags["deployment"]); if (!id) throw new CliError("--deployment is required"); const r = await e.cloud.with(e.conn, (c) => c.call<any>("release.cancel", { app: e.decl.name, deployment: id })); e.cloud.store.audit("release.cancel", { connection: e.conn, deployment: id }); emit(ctx, r, r.note); return 0; }),
  },
  "release:rollback": {
    usage: "pso release:rollback <environment> [--to <release>] --yes [--no-follow] [--json]", summary: "Re-activate the previous (or a chosen kept) release with the same candidate-verify-switch-drain sequence. Application rollback does not undo database changes",
    run: (ctx) => wrap(async () => {
      yes(ctx, "rolling back"); const e = envContext(ctx, need(ctx, 0, "environment"));
      const d = await e.cloud.with(e.conn, (c) => c.call<Deployment>("release.rollback", { app: e.decl.name, ...(str(ctx.flags["to"]) ? { to: str(ctx.flags["to"]) } : {}) })); e.cloud.store.audit("release.rollback", { connection: e.conn, deployment: d.id, to: d.releaseId });
      ctx.print(`rollback ${d.id} to ${d.releaseId} started`);
      if (ctx.flags["no-follow"] === true) return 0;
      const end = await e.cloud.follow(e.conn, e.decl.name, d.id); emit(ctx, end, formatDeployment(end)); return end.effectiveState === "COMPLETED" ? 0 : 1;
    }),
  },
  "release:recover": {
    usage: "pso release:recover <environment> --yes [--json]", summary: "Reconcile an interrupted deployment: inspects what really exists on the server, then completes it, undoes it, or stops and asks for an operator when the state is ambiguous. Never replays steps blindly",
    run: (ctx) => wrap(async () => { yes(ctx, "recovering"); const e = envContext(ctx, need(ctx, 0, "environment")); const r = await e.cloud.with(e.conn, (c) => c.call<any>("release.recover", { app: e.decl.name })); e.cloud.store.audit("release.recover", { connection: e.conn, result: r.action }); emit(ctx, r, `${r.action}: ${r.note}`); return r.action === "needs-operator" ? 1 : 0; }),
  },
  "release:logs": {
    usage: "pso release:logs <environment> [--deployment <id>] [--service <name>] [--bytes 16000] [--json]", summary: "Sanitized logs from the server: a deployment's log (default: the latest) or the active release's application log of a service. Secrets known to the server are masked",
    run: (ctx) => wrap(async () => { const e = envContext(ctx, need(ctx, 0, "environment")); const r = await e.cloud.with(e.conn, (c) => c.call<any>("logs.read", { app: e.decl.name, ...(str(ctx.flags["deployment"]) ? { deployment: str(ctx.flags["deployment"]) } : {}), ...(str(ctx.flags["service"]) ? { service: str(ctx.flags["service"]) } : {}), bytes: Number(str(ctx.flags["bytes"]) ?? 16000) })); emit(ctx, r, `# ${r.source}\n${r.text}`); return 0; }),
  },
  "release:service": {
    usage: "pso release:service <environment> <status|restart|start|stop> [<service>] [--yes] [--json]", summary: "Inspect, restart, start or stop ONE service of the active release without touching the others (not allowed while a deployment is running)",
    args: 3,
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "environment")); const action = need(ctx, 1, "action (status|restart|start|stop)");
      if (action === "status") {
        const rt = await e.cloud.runtime(e.conn); const mine = rt.applications.filter((x: any) => x.app === e.decl.name);
        emit(ctx, { applications: mine, infrastructure: rt.infrastructure, host: rt.host }, [
          ...mine.map((x: any) => `${x.service}#${x.instance} ${x.running ? "running" : "NOT running"} ${x.health}  pid ${x.pid ?? "-"}  ${x.address}  ${x.supervisor}${x.unit ? ` ${x.unit}` : ""}  rss ${x.rssMb ?? "?"} MB  cpu ${x.cpuSeconds ?? "?"} s  restarts ${x.restarts}  since ${x.startedAt ?? "?"}  (${x.identity})`),
          ...(mine.length ? [] : ["no active release"]), "",
          `infrastructure of the host (not managed by PSO): ${rt.infrastructure.map((i: any) => `${i.unit} ${i.state}${i.memoryMb ? ` ${i.memoryMb} MB` : ""}`).join(", ") || "none seen"}`,
          `host: memory ${rt.host.memAvailableMb} of ${rt.host.memTotalMb} MB available, load ${rt.host.loadAverage}`].join("\n"));
        return 0;
      }
      if (!["restart", "start", "stop"].includes(action)) throw new CliError("action is status, restart, start or stop");
      yes(ctx, `${action} of a service`); const service = need(ctx, 2, "service name");
      const r = await e.cloud.with(e.conn, (c) => c.call<any>(`service.${action}`, { app: e.decl.name, service }), {}); e.cloud.store.audit(`service.${action}`, { connection: e.conn, service });
      emit(ctx, r, `${service}: ${action} done ${JSON.stringify(r.results)}`); return 0;
    }),
  },
  "release:audit": {
    usage: "pso release:audit <environment> [--limit 50] [--event <prefix>] [--verify] [--json]", summary: "The server's audit log (sanitized; hash-chained, so edits are detectable by --verify). It is evidence against accidents, not against a fully privileged server administrator",
    run: (ctx) => wrap(async () => {
      const e = envContext(ctx, need(ctx, 0, "environment"));
      if (ctx.flags["verify"] === true) { const v = await e.cloud.with(e.conn, (c) => c.call<any>("audit.verify")); emit(ctx, v, `audit chain ${v.ok ? "intact" : `BROKEN at entry ${v.brokenAt}`}: ${v.entries} entries, head ${String(v.head).slice(0, 16)}…`); return v.ok ? 0 : 1; }
      const a = await e.cloud.with(e.conn, (c) => c.call<any[]>("audit.read", { limit: Number(str(ctx.flags["limit"]) ?? 50), ...(str(ctx.flags["event"]) ? { event: str(ctx.flags["event"]) } : {}) })); emit(ctx, a, a.map((x) => `${x.ts} #${x.seq} ${x.outcome.padEnd(6)} ${x.event.padEnd(28)} ${x.actor?.name ?? ""} ${x.ids?.deployment ?? ""}`).join("\n")); return 0;
    }),
  },
};
