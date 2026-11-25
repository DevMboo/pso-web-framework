import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, kebabName, type Command } from "./commands.ts";

export const DB_COMMANDS: Record<string, Command> = {
  "make:migration": {
    usage: "pso make:migration <name> --service <name> [--dry-run] [--json]",
    summary: "Create the next Flyway migration (V<n>__<name>.sql) in a PostgreSQL-backed service",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const name = kebabName(ctx.positionals[0], "migration");
      const svc = config.services.find((s) => s.name === str(ctx.flags["service"]));
      if (!svc) throw new CliError("--service must name a service of this workspace", `Known: ${config.services.map((s) => s.name).join(", ")}`);
      if (svc.db !== "postgres") throw new CliError(`Service "${svc.name}" has no database`, "Create it with `pso create service <name> --db postgres`");
      const dir = join(root, ...svc.path.split("/"), "src", "main", "resources", "db", "migration");
      mkdirSync(dir, { recursive: true });
      const versions = readdirSync(dir).map((f) => /^V(\d+)__/.exec(f)?.[1]).filter((v): v is string => !!v).map(Number);
      const next = (versions.length ? Math.max(...versions) : 0) + 1;
      const file = `V${next}__${name.replace(/-/g, "_")}.sql`;
      if (readdirSync(dir).some((f) => f.endsWith(`__${name.replace(/-/g, "_")}.sql`))) throw new CliError(`A migration named "${name}" already exists`);
      const rel = `${svc.path}/src/main/resources/db/migration/${file}`;
      const res = writeFiles(root, { [rel]: `-- ${name}\n-- Migrations are immutable once applied: add a new version instead of editing this one.\n` }, { dryRun: ctx.flags["dry-run"] === true });
      emit(ctx, { dryRun: ctx.flags["dry-run"] === true, files: res }, res.map((r) => `${ctx.flags["dry-run"] === true ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`).join("\n"));
      return existsSync(dir) ? 0 : 1;
    },
  },
};
