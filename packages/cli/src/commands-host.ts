import { plan, ps, composeTarget, dockerReady } from "@pso/infra";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command, type Ctx } from "./commands.ts";
import { INFRA_HOOKS, engine } from "./commands-infra.ts";
import { RemoteHost, inspectHost } from "./remote-host.ts";
import { remoteContext, remoteLogs, remoteStatus } from "./remote-deploy.ts";
import { currentRelease, releasesOf } from "./deploy-env.ts";

/**
 * Remote hosts (0.2.0). A host is registered once with `pso connection:add` (its SSH host key is approved and pinned; the credential is a
 * key file path, the SSH agent, or a reference in PSO's credential store). These commands only read the host; deployments are planned
 * and executed by `pso deploy:plan --env` and `pso deploy --env`.
 */
const envOf = (ctx: Ctx) => { const e = str(ctx.flags["env"]); if (!e) throw new CliError("--env <name> is required"); return e; };

export const HOST_COMMANDS: Record<string, Command> = {
  "host:inspect": {
    usage: "pso host:inspect <connection> [--root /srv/pso] [--json]",
    summary: "Inspect a registered Linux host over SSH (read-only): operating system and architecture, Docker and Compose available to the deploy user, free disk under the deployment root, listening ports, existing PSO-managed deployments and registry reachability",
    args: 1,
    run(ctx) {
      const name = ctx.positionals[0];
      if (!name) throw new CliError("Name the connection", "pso connection:list");
      const f = inspectHost(new RemoteHost(name), str(ctx.flags["root"]) ?? "/srv/pso");
      emit(ctx, f, [`${name}: ${f.host} (${f.user})`, `  system     ${f.os}, ${f.arch}, kernel ${f.kernel}`, `  docker     ${f.docker ?? "NOT available to this user"}   compose ${f.compose ?? "NOT available"}`,
        `  root       ${f.root}: ${f.rootWritable ? "writable" : "NOT writable"}, ${f.diskFreeMb ?? "?"} MB free`, `  listening  ${f.listening.join(", ") || "(none visible)"}`,
        `  managed    ${f.deployments.map((d) => `${d.project}${d.release ? ` (active ${d.release})` : ""}`).join(", ") || "no PSO deployment"}`, `  registry   ${f.registry === "reachable" ? "Docker Hub resolvable" : "not resolvable (images are transferred over SSH anyway)"}`].join("\n"));
      return 0;
    },
  },
  "host:check": {
    usage: "pso host:check --env <name> [--json]",
    summary: "Check that the host an environment deploys to (deploy.target \"ssh\") meets its prerequisites: Docker and Compose, a writable root with free space, the edge port, and every operator-supplied certificate (verified: authority, names, expiry; keys present) and secret file (present; never read). Exit 1 when something blocks a deployment",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envOf(ctx), INFRA_HOOKS));
      const rc = remoteContext(p);
      const errors = rc.findings.filter((f) => f.severity === "error");
      emit(ctx, { environment: p.environment, host: rc.host.name, facts: rc.facts, findings: rc.findings, ok: errors.length === 0 }, [...rc.findings.map((f) => `${f.severity.toUpperCase().padEnd(7)} ${f.check.padEnd(9)} ${f.message}`), errors.length ? `FAILED: ${errors.length} blocking problem(s) on ${rc.host.name}` : `OK: ${rc.host.name} can run "${p.environment}"`].join("\n"));
      return errors.length ? 1 : 0;
    },
  },
  "deploy:status": {
    usage: "pso deploy:status --env <name> [--json]",
    summary: "Show the active release of an environment, its recorded releases and history, and the state and health of its containers (on the remote host for an SSH target, on this machine for the docker target)",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envOf(ctx), INFRA_HOOKS));
      const t = p.topology;
      if (t.decl.deploy?.target === "ssh") {
        const rc = remoteContext(p);
        const s = remoteStatus(rc, t);
        emit(ctx, { environment: t.env, host: rc.host.name, ...s }, [`${t.env} on ${rc.host.name}: active ${s.current ?? "(none)"}${s.locked ? `   LOCKED by ${s.locked}` : ""}`, `  releases: ${s.releases.join(", ") || "(none)"}`, ...s.containers.map((c) => `  ${String(c["service"]).padEnd(16)} ${String(c["state"]).padEnd(9)} ${String(c["health"] || "-")}`)].join("\n"));
        return 0;
      }
      const cur = currentRelease(root, t.env);
      const rows = dockerReady().ok ? (() => { try { return ps(composeTarget(root, t)); } catch { return []; } })() : [];
      emit(ctx, { environment: t.env, current: cur ?? null, releases: releasesOf(root, t.env), containers: rows }, [`${t.env} on this machine: active ${cur?.release ?? "(none)"}`, `  releases: ${releasesOf(root, t.env).map((r) => r.id).join(", ") || "(none)"}`, ...rows.map((r) => `  ${r.service.padEnd(16)} ${r.state.padEnd(9)} ${r.health || "-"}`)].join("\n"));
      return 0;
    },
  },
  "deploy:logs": {
    usage: "pso deploy:logs <service> --env <name> [--tail 200]",
    summary: "Show a container's log from the environment's host (secrets, tokens and keys masked)",
    args: 1,
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const svc = ctx.positionals[0];
      if (!svc) throw new CliError("Name the container", "pso deploy:status --env <name> lists them");
      const p = engine(() => plan(root, envOf(ctx), INFRA_HOOKS));
      if (p.topology.decl.deploy?.target !== "ssh") throw new CliError(`"${p.environment}" runs on this machine`, `pso docker:logs ${svc} --env ${p.environment}`);
      ctx.print(remoteLogs(remoteContext(p), p.topology, svc, Number(str(ctx.flags["tail"]) ?? 200)));
      return 0;
    },
  },
  "deploy:unlock": {
    usage: "pso deploy:unlock --env <name> --yes [--json]",
    summary: "Remove the deployment lock an interrupted deployment left on the environment's host (only when no deployment is running)",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const p = engine(() => plan(root, envOf(ctx), INFRA_HOOKS));
      const rc = remoteContext(p);
      const s = remoteStatus(rc, p.topology);
      if (!s.locked) { emit(ctx, { locked: false }, `"${p.environment}" on ${rc.host.name} is not locked`); return 0; }
      if (ctx.flags["yes"] !== true) { emit(ctx, { locked: s.locked }, `"${p.environment}" on ${rc.host.name} is locked by ${s.locked}. Make sure that deployment is not running, then re-run with --yes.`); return 3; }
      const rm = rc.host.exec(`rm -rf '${rc.dir}/.deploy-lock' && ! test -e '${rc.dir}/.deploy-lock'`);
      if (rm.status !== 0) throw new CliError(`the lock could not be removed on ${rc.host.name}: ${rm.stderr.trim() || "permission denied"}`, "It was created by another user: remove it on the host as that user or an administrator");
      emit(ctx, { unlocked: true, was: s.locked }, `removed the lock of "${p.environment}" on ${rc.host.name} (was: ${s.locked})`);
      return 0;
    },
  },
};
