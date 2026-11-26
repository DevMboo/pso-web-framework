import { existsSync } from "node:fs";
import { join } from "node:path";
import { discover, hasErrors, formatDiagnostic, validateWorkspaceShape, type ServiceDecl, type WorkspaceConfig } from "@pso/core";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { explainEnvironment, startDev, type DevOptions } from "./dev.ts";
import { emit, requireWorkspace, saveWorkspace, kebabName, validateAll, type Command } from "./commands.ts";
import { hasInfraContract } from "./commands-infra.ts";

export async function liveHealth(s: ServiceDecl): Promise<{ name: string; url: string; status: "UP" | "DOWN"; httpStatus: number | null; ms: number | null }> {
  const url = `http://127.0.0.1:${s.port}${s.health ?? "/actuator/health"}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await r.arrayBuffer();
    return { name: s.name, url, status: r.status === 200 ? "UP" : "DOWN", httpStatus: r.status, ms: Date.now() - t0 };
  } catch {
    return { name: s.name, url, status: "DOWN", httpStatus: null, ms: null };
  }
}

const dry = (flags: Record<string, string | boolean>) => flags["dry-run"] === true;

export const SERVICE_COMMANDS: Record<string, Command> = {
  "dev": {
    usage: "pso dev [--only a,b] [--service <name>] [--with-dependencies] [--fei <name>] [--docker] [--env <name>] [--install] [--timeout 120] [--smoke]",
    summary: "Validate, start, monitor and gracefully stop the workspace (Ctrl+C stops). Local processes by default; --docker runs the environment's containers instead. --service starts one service (and with --with-dependencies what it depends on: other services, its database and the identity provider), --fei also starts that frontend's development servers",
    async run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const v = validateAll(ctx);
      if (hasErrors(v.diagnostics)) {
        ctx.print(v.diagnostics.map(formatDiagnostic).join("\n"));
        throw new CliError("Workspace validation failed; not starting", "Run `pso validate` for details");
      }
      const svcFlag = str(ctx.flags["service"]);
      if (svcFlag !== undefined && str(ctx.flags["only"]) !== undefined) throw new CliError("--service and --only select services in two ways: use one of them");
      if (svcFlag !== undefined && !config.services.some((s) => s.name === svcFlag)) throw new CliError(`Unknown service "${svcFlag}"`, `Known: ${config.services.map((s) => s.name).join(", ")}`);
      const withDeps = ctx.flags["with-dependencies"] === true;
      const infra = hasInfraContract(root);
      if ((ctx.flags["docker"] === true || withDeps || str(ctx.flags["env"]) !== undefined) && !infra) throw new CliError("--docker, --with-dependencies and --env use the infrastructure contract (pso.infra.json)", "Create it with `pso infra:init` (or migrate a 0.1 workspace with `pso workspace:migrate`)");

      // containers: the same topology as `pso docker:up`, followed until Ctrl+C, then stopped (data volumes are kept)
      if (ctx.flags["docker"] === true) {
        const { DOCKER_COMMANDS } = await import("./commands-docker.ts");
        const sub = { ...ctx, flags: { ...ctx.flags, ...(svcFlag ? { service: svcFlag } : {}) } };
        delete (sub.flags as Record<string, unknown>)["docker"]; delete (sub.flags as Record<string, unknown>)["with-dependencies"];
        const code = await DOCKER_COMMANDS["docker:up"]!.run({ ...sub, flags: Object.fromEntries(Object.entries(sub.flags).filter(([k]) => ["env", "service", "timeout"].includes(k))) });
        if (code !== 0 || ctx.flags["smoke"] === true) return code;
        ctx.print("\nPress Ctrl+C to stop the containers (data volumes are kept).");
        await new Promise<void>((done) => { const h = () => { ctx.print("\nstopping containers..."); void Promise.resolve(DOCKER_COMMANDS["docker:down"]!.run({ ...ctx, flags: Object.fromEntries(Object.entries(ctx.flags).filter(([k]) => k === "env")) })).then(() => done(), () => done()); }; process.once("SIGINT", h); process.once("SIGTERM", h); });
        return 0;
      }

      // selection: --only (as before), or one --service plus, with --with-dependencies, everything it depends on
      let only = str(ctx.flags["only"])?.split(",").map((x) => x.trim()).filter(Boolean);
      if (svcFlag) {
        const need = new Set<string>();
        const walk = (n: string) => { if (need.has(n)) return; need.add(n); if (withDeps) for (const d of config.services.find((s) => s.name === n)?.dependsOn ?? []) walk(d); };
        walk(svcFlag);
        only = [...need];
      }
      const timeoutSec = Number(str(ctx.flags["timeout"]) ?? 120);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new CliError("--timeout must be a positive number of seconds");
      // infrastructure dependencies (databases, identity provider) run as containers next to the local processes
      let depsStop: (() => Promise<void>) | undefined;
      if (withDeps) {
        const infraMod = await import("@pso/infra");
        const { preparedPlan } = await import("./commands-docker.ts");
        const p = preparedPlan(ctx, root);
        const t = p.topology;
        const wanted = new Set(only ?? config.services.map((s) => s.name));
        const deps = [...t.services.filter((s) => s.db && wanted.has(s.name)).map((s) => `${s.name}-db`), ...(infraMod.managedIdentity(t) ? ["idp"] : []), ...(t.redis?.provider === "container" && t.services.some((s) => wanted.has(s.name) && s.redisVariables.length) ? ["redis"] : [])];
        if (deps.length) {
          const d = infraMod.dockerReady(); if (!d.ok) throw new CliError(`--with-dependencies needs Docker: ${d.reason}`);
          const c = infraMod.composeTarget(root, t, "dependencies");
          const conflicts = await infraMod.portConflicts(c, t, "dependencies", deps);
          if (conflicts.length) throw new CliError(`host port(s) already in use: ${conflicts.map((x) => `${x.port} (${x.container})`).join(", ")}`, "Another process (or the container stack of this environment, pso docker:down) listens there. Nothing was started");
          ctx.print(`starting infrastructure dependencies: ${deps.join(", ")} ...`);
          const code = await infraMod.compose(c, ["up", "-d", "--wait", "--wait-timeout", "300", ...deps], { onLine: (l) => ctx.print(`  ${l}`) });
          if (code !== 0) throw new CliError("an infrastructure dependency did not become healthy", `pso docker:logs <name> --env ${t.env}   (dependencies stack: ${t.project}-deps)`);
          depsStop = async () => { await infraMod.compose(c, ["stop"]); };
        }
      }
      const opts: DevOptions = { root, config, readyTimeoutMs: timeoutSec * 1000, install: ctx.flags["install"] === true, log: ctx.print, ...(infra ? { infraEnv: str(ctx.flags["env"]) ?? "" } : {}) };
      if (only) opts.only = only;
      ctx.print(`Starting ${(only ?? config.services).length} service(s)...`);
      let session;
      try { session = await startDev(opts); } catch (e) { if (depsStop) await depsStop(); throw e; }
      ctx.print("\nReady:\n" + session.registry().map((e) => `  ${e.name.padEnd(18)} ${e.url.padEnd(26)} ${e.state}/${e.status}`).join("\n"));
      // the frontend development servers of one FEI (its shell and the MEIs it mounts), with the same lifecycle as the services
      // (frontend:dev stops its own servers on the same Ctrl+C)
      const feiFlag = str(ctx.flags["fei"]);
      if (feiFlag !== undefined && ctx.flags["smoke"] !== true) {
        const { FRONTEND_COMMANDS } = await import("./commands-frontend.ts");
        void Promise.resolve(FRONTEND_COMMANDS["frontend:dev"]!.run({ ...ctx, flags: { fei: feiFlag } })).catch((e: Error) => ctx.print(`frontend: ${e.message}`));
      }
      if (ctx.flags["smoke"] === true) {
        await session.stop();
        if (depsStop) await depsStop();
        ctx.print("smoke run complete; all services stopped");
        return 0;
      }
      ctx.print("\nPress Ctrl+C to stop.");
      await new Promise<void>((done) => {
        let stopping = false;
        const handler = (sig: string) => {
          if (stopping) return;
          stopping = true;
          ctx.print(`\n${sig}: stopping services...`);
          session.stop().then(async () => { if (depsStop) await depsStop(); }).then(done, done);
        };
        process.once("SIGINT", () => handler("SIGINT"));
        process.once("SIGTERM", () => handler("SIGTERM"));
      });
      ctx.print("all services stopped");
      return 0;
    },
  },

  "dev:env": {
    usage: "pso dev:env [--service <name>] [--env <name>] [--json]",
    summary: "Show where every variable of a service comes from when `pso dev` starts it (its files, the environment of pso dev, the workspace, the infrastructure environment) and which infrastructure settings are not applied and why. Names and sources only: no value is ever shown, secrets are only reported as resolved",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const svcFlag = str(ctx.flags["service"]);
      if (svcFlag !== undefined && !config.services.some((s) => s.name === svcFlag)) throw new CliError(`Unknown service "${svcFlag}"`, `Known: ${config.services.map((s) => s.name).join(", ")}`);
      const infra = hasInfraContract(root);
      if (str(ctx.flags["env"]) !== undefined && !infra) throw new CliError("--env uses the infrastructure contract (pso.infra.json)");
      const rows = config.services.filter((s) => !svcFlag || s.name === svcFlag).map((s) => explainEnvironment(root, s, process.env, infra ? str(ctx.flags["env"]) ?? "" : undefined));
      const text = rows.flatMap((r) => [
        `${r.service}${r.infrastructure ? `   (infrastructure environment "${r.infrastructure.env}": ${r.infrastructure.file})` : ""}`,
        ...r.variables.map((v) => `  ${v.name.padEnd(34)} ${v.source}${v.secret ? "   [secret, resolved at start; value not shown]" : ""}`),
        ...r.notApplied.map((x) => `  not applied from ${x.from}: ${x.names.join(", ")}\n    because ${x.reason}`),
        ...(r.missingSecrets.length ? [`  MISSING secret(s): ${r.missingSecrets.join(", ")} (pso infra:apply)`] : []),
        "",
      ]);
      emit(ctx, { services: rows }, text.join("\n").trimEnd());
      return rows.some((r) => r.missingSecrets.length) ? 1 : 0;
    },
  },

  "services:health": {
    usage: "pso services:health [--json]",
    summary: "Probe every declared service live (exit 1 if any is DOWN)",
    async run(ctx) {
      const { config } = requireWorkspace(ctx);
      const rows = await Promise.all([...config.services].sort((a, b) => (a.name < b.name ? -1 : 1)).map(liveHealth));
      emit(ctx, rows, rows.map((r) => `${r.status.padEnd(5)} ${r.name.padEnd(18)} ${r.url}${r.ms !== null ? `  ${r.ms}ms` : ""}`).join("\n"));
      return rows.every((r) => r.status === "UP") ? 0 : 1;
    },
  },

  "services:inspect": {
    usage: "pso services:inspect <name> [--json]",
    summary: "Show declaration, discovered resources and live health of one service",
    async run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const name = ctx.positionals[0];
      const s = config.services.find((x) => x.name === name);
      if (!s) throw new CliError(`Unknown service "${name ?? ""}"`, `Known: ${config.services.map((x) => x.name).join(", ")}`);
      const d = discover(join(root, ...s.path.split("/")), s.runtime);
      const health = await liveHealth(s);
      const dependents = config.services.filter((x) => (x.dependsOn ?? []).includes(s.name)).map((x) => x.name);
      emit(ctx, { service: s, dependents, resources: d.resources, health }, [
        `${s.name} (${s.role ?? "service"}, ${s.runtime}) :${s.port}  health: ${health.status}`,
        `depends on: ${(s.dependsOn ?? []).join(", ") || "-"}   used by: ${dependents.join(", ") || "-"}`,
        ...d.resources.map((r) => `  ${r.kind.padEnd(11)} ${r.id.padEnd(26)} ${r.file}`),
      ].join("\n"));
      return 0;
    },
  },

  "services:register": {
    usage: "pso services:register <name> --port N --runtime node|spring-boot [--path dir] [--depends-on a,b] [--health /path] [--dry-run] [--json]",
    summary: "Declare an existing project as a workspace service (validated before saving)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const name = kebabName(ctx.positionals[0], "service");
      const port = Number(str(ctx.flags["port"]));
      const runtime = str(ctx.flags["runtime"]);
      if (runtime !== "node" && runtime !== "spring-boot") throw new CliError("--runtime must be node or spring-boot");
      const decl: ServiceDecl = { name, path: str(ctx.flags["path"]) ?? name, runtime, role: "service", port };
      const deps = str(ctx.flags["depends-on"]);
      if (deps) decl.dependsOn = deps.split(",").map((x) => x.trim()).filter(Boolean);
      const health = str(ctx.flags["health"]);
      if (health) decl.health = health;
      const next: WorkspaceConfig = { ...config, services: [...config.services, decl] };
      const ds = validateWorkspaceShape(next);
      if (hasErrors(ds)) throw new CliError(ds.map(formatDiagnostic).join("\n"), "Nothing was saved");
      if (!existsSync(join(root, ...decl.path.split("/")))) throw new CliError(`Path "${decl.path}" does not exist in the workspace`);
      if (!dry(ctx.flags)) saveWorkspace(root, next);
      emit(ctx, { dryRun: dry(ctx.flags), registered: decl }, `${dry(ctx.flags) ? "[dry-run] " : ""}registered ${name} on :${port}`);
      return 0;
    },
  },

  "services:unregister": {
    usage: "pso services:unregister <name> [--dry-run] [--json]",
    summary: "Remove a service declaration (refused while others depend on it; files are never deleted)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const name = ctx.positionals[0];
      const s = config.services.find((x) => x.name === name);
      if (!s) throw new CliError(`Unknown service "${name ?? ""}"`);
      const users = config.services.filter((x) => (x.dependsOn ?? []).includes(s.name)).map((x) => x.name);
      if (users.length) throw new CliError(`Cannot unregister "${s.name}": required by ${users.join(", ")}`, "Remove those dependencies first");
      if (!dry(ctx.flags)) saveWorkspace(root, { ...config, services: config.services.filter((x) => x.name !== s.name) });
      emit(ctx, { dryRun: dry(ctx.flags), unregistered: s.name }, `${dry(ctx.flags) ? "[dry-run] " : ""}unregistered ${s.name} (project files untouched)`);
      return 0;
    },
  },
};
