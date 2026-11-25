import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Auth } from "./auth.ts";
import { Engine } from "./engine.ts";
import { identityMatches, type SlotState } from "./runtime.ts";
import { serve } from "./server.ts";
import { AgentState, AuditLog, P, agentHome, nowIso, readJson, writeJson, type Policy } from "./state.ts";
import { AGENT_VERSION, PROTOCOL_VERSIONS, ROLES, type Role } from "../protocol.ts";

/**
 * `pso-agent`: the runtime agent installed on the target server (a single bundled file, `pso-agent.mjs`).
 *
 *   serve                         the management protocol on stdin/stdout (started by the client through SSH; no network port)
 *   worker <app> <deployment>     runs one deployment, detached from any session (started by the agent itself)
 *   provision --mode <m> ...      first-time setup by the HOST ADMINISTRATOR: server identity, policy, bootstrap enrollment token
 *   set-mode <m>                  host-administrator control of the management mode (the only way to re-enable a disabled agent)
 *   enroll-token [--role r]       host-administrator creation of a single-use enrollment token
 *   status | version | uninstall
 */
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (n: string): boolean => args.includes(`--${n}`);
const out = (v: unknown): void => { process.stdout.write(JSON.stringify(v) + "\n"); };
const die = (m: string, code = 1): never => { process.stderr.write(`pso-agent: ${m}\n`); process.exit(code); };

async function main(): Promise<void> {
  const state = new AgentState();
  switch (cmd) {
    case "version": {
      // which BUILD this is: two builds of one semantic version differ by checksum (the release id on the server is "<version>+<build>")
      let build: string | undefined; let release: string | undefined;
      try { const file = realpathSync(process.argv[1]!); build = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12); const dir = basename(dirname(file)); release = dirname(dirname(file)).endsWith("releases") ? dir : undefined; } catch { /* a bundle run from memory has no file */ }
      out({ agent: AGENT_VERSION, ...(build ? { build } : {}), ...(release ? { release } : {}), protocol: [...PROTOCOL_VERSIONS], node: process.versions.node, home: agentHome() }); return;
    }
    case "serve": await serve(); return;
    case "worker": {
      const [, app, id] = args; if (!app || !id) die("worker needs <app> <deployment>");
      await new Engine(state, new AuditLog(state.home)).work(app!, id!);
      return;
    }
    case "provision": {
      const mode = (flag("mode") ?? "") as Policy["mode"];
      if (!["development", "protected"].includes(mode)) die("provision needs --mode development|protected (remote management stays DISABLED unless you choose one explicitly)", 2);
      const r = Auth.provision(state, mode, { emitToken: has("emit-token"), environment: flag("environment") });
      out(r); return;
    }
    case "set-mode": {
      const m = args[1] as Policy["mode"]; if (!["disabled", "development", "protected"].includes(m)) die("set-mode needs disabled|development|protected", 2);
      if (!state.provisioned()) die("not provisioned");
      const p = state.policy(); const before = p.mode; p.mode = m; if (m === "protected" && p.approvalsRequired < 1) p.approvalsRequired = 1; state.setPolicy(p);
      new AuditLog(state.home).append("policy.mode", "ok", { name: "host-administrator" }, { environment: state.env().id }, { from: before, to: m });
      out({ mode: m }); return;
    }
    case "enroll-token": {
      if (!state.provisioned()) die("not provisioned");
      const role = (flag("role") ?? "deployer") as Role; if (!ROLES.includes(role)) die("invalid role", 2);
      const t = Auth.createToken(state, role, Number(flag("minutes") ?? 15), "host-administrator");
      new AuditLog(state.home).append("enroll.token-created", "ok", { name: "host-administrator" }, { environment: state.env().id }, { role, expiresAt: t.expiresAt, tokenId: t.id });
      out({ token: t.token, role, expiresAt: t.expiresAt }); return;
    }
    case "recover-admin": {
      // Administrative recovery for a HOST ADMINISTRATOR who has a shell on the server as the agent's user (the same trust as owning the
      // agent's files). It is NOT reachable through the management plane, so it cannot become a remote bypass: a lost superadministrator
      // is replaced by a NEW single-use, short-lived enrollment token; nothing about an existing identity is read, shown or reset.
      // --revoke-all additionally ends every client and session (use it when a client key may be compromised).
      if (!state.provisioned()) die("not provisioned");
      const log = new AuditLog(state.home); const minutes = Math.min(Math.max(Number(flag("minutes") ?? 15), 1), 60);
      let revoked = 0;
      if (has("revoke-all")) { const cl = state.clients().map((c) => { if (!c.revoked) revoked++; return { ...c, revoked: true, revokedAt: c.revokedAt ?? nowIso() }; }); state.saveClients(cl); state.saveSessions(state.sessions().map((s) => ({ ...s, revoked: true }))); }
      const t = Auth.createToken(state, "superadmin", minutes, "host-administrator-recovery");
      log.append("admin.recovery", "ok", { name: "host-administrator" }, { environment: state.env().id }, { tokenId: t.id, expiresAt: t.expiresAt, clientsRevoked: revoked });
      out({ token: t.token, role: "superadmin", expiresAt: t.expiresAt, singleUse: true, clientsRevoked: revoked, next: "enroll a NEW client key with this token (pso agent:enroll), then rotate or revoke the old identities" }); return;
    }
    case "status": {
      const apps = existsSync(P.apps(state.home)) ? readdirSync(P.apps(state.home)) : [];
      out({ provisioned: state.provisioned(), mode: state.provisioned() ? state.policy().mode : null, environment: state.env(), clients: state.clients().filter((c) => !c.revoked).length, apps, version: AGENT_VERSION });
      return;
    }
    case "uninstall": {
      // Removes the management tooling only. Applications, their data and their processes are never touched unless explicitly authorized.
      const purgeApps = has("purge-applications");
      const running: string[] = [];
      if (existsSync(P.apps(state.home))) for (const a of readdirSync(P.apps(state.home))) {
        const sd = join(P.app(a, state.home), "slots");
        if (existsSync(sd)) for (const r of readdirSync(sd)) for (const f of readdirSync(join(sd, r))) { const s = readJson<SlotState | undefined>(join(sd, r, f), undefined); if (s && identityMatches(s).match) running.push(`${a}/${s.service}`); }
      }
      if (purgeApps && running.length && !has("stop-running-confirmed")) die(`refusing to purge applications while services are running: ${[...new Set(running)].join(", ")}`);
      const entry = process.argv[1]!;
      writeJson(join(state.home, "uninstalled.json"), { at: nowIso(), purgeApplications: purgeApps });
      if (purgeApps) rmSync(state.home, { recursive: true, force: true });
      else { rmSync(P.identity(state.home), { recursive: true, force: true }); rmSync(state.file("clients.json"), { force: true }); rmSync(state.file("sessions.json"), { force: true }); rmSync(state.file("enroll.json"), { force: true }); rmSync(dirname(entry) + "/pso-agent.prev.mjs", { force: true }); }
      out({ removed: purgeApps ? "everything, including applications" : "management identity and clients; applications, data and the audit log were kept", runningServicesLeftAlone: [...new Set(running)] });
      return;
    }
    default: die(`unknown command "${cmd ?? ""}". Commands: serve, worker, provision, set-mode, enroll-token, recover-admin, status, version, uninstall`, 2);
  }
}

main().catch((e) => { process.stderr.write(`pso-agent: ${(e as Error).message}\n`); process.exit(1); });
