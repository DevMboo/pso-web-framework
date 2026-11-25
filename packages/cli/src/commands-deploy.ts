import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command } from "./commands.ts";
import { DEPLOY_TARGETS, checkDescriptor, generate, type DeployTarget, type Finding } from "./deploy-templates.ts";

const targetOf = (v: string | boolean | undefined): DeployTarget => {
  if (typeof v !== "string" || !DEPLOY_TARGETS.includes(v as DeployTarget)) throw new CliError(`--target must be one of: ${DEPLOY_TARGETS.join(", ")}`);
  return v as DeployTarget;
};

export const DEPLOY_COMMANDS: Record<string, Command> = {
  "deploy:init": {
    usage: "pso deploy:init --target <kubernetes|ecs|container-apps|cloud-run> [--registry <registry/path>] [--tag <version>] [--dry-run] [--force] [--json]",
    summary: "Generate hardened deployment descriptors for Kubernetes, AWS ECS (Fargate), Azure Container Apps or Google Cloud Run (nothing is ever applied to a cloud)",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      if (!config.services.length) throw new CliError("The workspace has no services");
      const target = targetOf(ctx.flags["target"]);
      const tag = str(ctx.flags["tag"]) ?? "0.1.0";
      if (tag === "latest" || !/^[A-Za-z0-9._-]{1,128}$/.test(tag)) throw new CliError("--tag must be a fixed version, not 'latest'");
      const registry = str(ctx.flags["registry"]) ?? "CHANGE_ME";
      if (!/^[A-Za-z0-9._:/-]+$/.test(registry)) throw new CliError("--registry may contain letters, digits and . _ : / - only");
      const files: Record<string, string> = {};
      for (const [name, text] of Object.entries(generate(target, config, { registry, tag }))) files[`deploy/${target}/${name}`] = text;
      const dry = ctx.flags["dry-run"] === true;
      const res = writeFiles(root, files, { dryRun: dry, force: ctx.flags["force"] === true });
      emit(ctx, { target, dryRun: dry, files: res }, `${res.map((r) => `${dry ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`).join("\n")}\nNothing was applied anywhere. Replace the CHANGE_ME values, then run \`pso deploy:validate --target ${target}\`.`);
      return res.some((r) => r.action === "conflict") ? 1 : 0;
    },
  },

  "deploy:validate": {
    usage: "pso deploy:validate [--target <kubernetes|ecs|container-apps|cloud-run>] [--strict] [--json]",
    summary: "Statically check the deployment descriptors (security posture, probes, limits, inline secrets, unfilled placeholders); no cloud is contacted",
    run(ctx) {
      const { root } = requireWorkspace(ctx);
      const only = ctx.flags["target"] === undefined ? undefined : targetOf(ctx.flags["target"]);
      const targets = only ? [only] : DEPLOY_TARGETS.filter((t) => existsSync(join(root, "deploy", t)));
      if (targets.length === 0) throw new CliError("no deployment descriptors found", "Run `pso deploy:init --target <target>` first");
      const findings: Finding[] = [];
      const checked: Array<{ target: string; file: string }> = [];
      for (const t of targets) {
        const dir = join(root, "deploy", t);
        if (!existsSync(dir)) throw new CliError(`no descriptors for ${t}`, `Run \`pso deploy:init --target ${t}\``);
        for (const f of readdirSync(dir).sort()) {
          const abs = join(dir, f);
          checked.push({ target: t, file: `deploy/${t}/${f}` });
          findings.push(...checkDescriptor(t, `deploy/${t}/${f}`, readFileSync(abs, "utf8")));
        }
      }
      const errors = findings.filter((f) => f.level === "error"), warnings = findings.filter((f) => f.level === "warning");
      const strict = ctx.flags["strict"] === true;
      const ok = errors.length === 0 && (!strict || warnings.length === 0);
      emit(ctx, { ok, checked: checked.length, errors, warnings, note: "static validation only: no cloud account was contacted and nothing was deployed" },
        `${ok ? "OK" : "PROBLEMS"}  ${checked.length} descriptor file(s) in ${targets.join(", ")}\n${[...errors, ...warnings].map((f) => `  ${f.level.toUpperCase().padEnd(7)} ${f.file} [${f.rule}] ${f.message}`).join("\n")}\nStatic validation only: no cloud account was contacted and nothing was deployed.${warnings.length && !strict ? " Warnings (placeholders) block deployment but not this check; use --strict to fail on them." : ""}`);
      return ok ? 0 : 1;
    },
  },
};
