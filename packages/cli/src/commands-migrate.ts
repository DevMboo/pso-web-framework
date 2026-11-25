import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceDecl } from "@pso/core";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command } from "./commands.ts";

/**
 * Migrations of files PSO generated in the past and the application now owns. A migration never guesses: it recognises the exact
 * text an earlier version generated, changes that text only, and leaves everything else in the file as it is. `pso migrate` shows
 * what it would do; `--apply` does it and keeps the previous file next to the new one.
 *
 * shutdown-on-signals: orchestrators generated before 2026-11-13 end the process 10 seconds after a signal, whatever
 * http.shutdown.graceMs says. The generated block is replaced by shutdownOnSignals(app), whose deadline follows the configuration.
 */
const LEGACY_BLOCK = `  .then((app) => {
    const shutdown = (sig: string) => {
      log("info", "shutting down", { sig });
      void app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })`;
const CURRENT_BLOCK = `  // SIGINT / SIGTERM: stop accepting, let running requests finish within http.shutdown.graceMs, release the dependents, exit 0.
  // The process is ended with exit code 1 only after app.shutdown.deadlineMs (grace period + cleanup time), never earlier.
  .then((app) => { shutdownOnSignals(app); })`;
const HTTP_IMPORT = /^import \{([^}]*)\} from "@pso\/http";[ \t]*$/m;

export type ShutdownState = "current" | "legacy" | "custom" | "none" | "absent";
export interface ShutdownMigration { state: ShutdownState; next?: string; changes: string[]; reason?: string }

/** What the shutdown migration would do to one main.ts. Pure: reads nothing but the text. */
export function planShutdownMigration(source: string | undefined): ShutdownMigration {
  if (source === undefined) return { state: "absent", changes: [], reason: "src/main.ts does not exist" };
  const crlf = source.includes("\r\n");
  const text = source.replace(/\r\n/g, "\n");
  if (/\bshutdownOnSignals\s*\(/.test(text) && !/process\.exit\(1\),\s*10_000/.test(text)) return { state: "current", changes: [] };
  if (!text.includes(LEGACY_BLOCK)) {
    if (/process\.exit\(1\),\s*10_?000/.test(text) || /process\.on\(\s*["']SIG(TERM|INT)["']/.test(text))
      return { state: "custom", changes: [], reason: "the signal handling in this file is not the block PSO generated (it was edited), so it is not rewritten automatically. Replace your handlers with `shutdownOnSignals(app)` from @pso/http, or keep them and make sure nothing ends the process before app.shutdown.deadlineMs" };
    return { state: "none", changes: [], reason: "no signal handling was found in this file" };
  }
  if (text.split(LEGACY_BLOCK).length !== 2) return { state: "custom", changes: [], reason: "the generated shutdown block appears more than once" };
  let next = text.replace(LEGACY_BLOCK, () => CURRENT_BLOCK);
  const changes = ["replace the generated shutdown block (fixed 10 s exit timer) with shutdownOnSignals(app)"];
  const imp = HTTP_IMPORT.exec(next);
  if (imp) {
    const names = imp[1]!.split(",").map((n) => n.trim()).filter(Boolean);
    if (!names.includes("shutdownOnSignals")) {
      const at = names.indexOf("StartupError");
      names.splice(at >= 0 ? at : names.length, 0, "shutdownOnSignals");
      next = next.replace(HTTP_IMPORT, () => `import { ${names.join(", ")} } from "@pso/http";`);
      changes.push('add shutdownOnSignals to the import from "@pso/http"');
    }
  } else {
    const firstImport = /^import .*$/m.exec(next);
    next = firstImport ? next.replace(firstImport[0], () => `${firstImport[0]}\nimport { shutdownOnSignals } from "@pso/http";`) : `import { shutdownOnSignals } from "@pso/http";\n${next}`;
    changes.push('add `import { shutdownOnSignals } from "@pso/http"`');
  }
  return { state: "legacy", next: crlf ? next.replace(/\n/g, "\r\n") : next, changes };
}

/**
 * template-outbox-table: PostgreSQL services created before 2026-11-14 contain V1__outbox.sql, which creates a table named
 * outbox_event. Nothing in PSO reads or writes it (the transactional outbox of PSO Dispatch is the pso_outbox table that
 * `pso dispatch:outbox` adds). New services no longer get it. In an existing service it is REPORTED, never changed: a migration that
 * was applied must stay as it is (Flyway checks its checksum), and a table is data that only its owner may drop.
 */
export function templateOutboxNote(serviceDir: string, servicePath: string): string | undefined {
  const dir = join(serviceDir, "src", "main", "resources", "db", "migration");
  if (!existsSync(dir)) return undefined;
  const file = readdirSync(dir).find((f) => /^V\d+__outbox\.sql$/.test(f) && /CREATE TABLE outbox_event\b/.test(readFileSync(join(dir, f), "utf8")));
  if (!file) return undefined;
  return `${servicePath}/src/main/resources/db/migration/${file} creates the table outbox_event, a leftover of an earlier service template that PSO does not use `
    + `(the PSO Dispatch outbox is pso_outbox, added by \`pso dispatch:outbox\`). Keep the migration file: it was applied and Flyway verifies it. `
    + `If your own code does not use the table either, remove it with a NEW migration of your own (pso make:migration drop-outbox-event --service <name>, containing DROP TABLE outbox_event;). `
    + "PSO never drops a table.";
}

export const MIGRATE_COMMANDS: Record<string, Command> = {
  "migrate": {
    usage: "pso migrate [--apply] [--service name] [--json]",
    summary: "Bring files generated by an earlier PSO version up to date without touching your own code: shows what would change (the fixed 10 s shutdown timer of older orchestrators becomes shutdownOnSignals); --apply writes it and keeps the previous file as <file>.bak",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const only = str(ctx.flags["service"]);
      const targets: ServiceDecl[] = config.services.filter((s) => s.runtime === "node" && (!only || s.name === only));
      if (only && !config.services.some((s) => s.name === only)) throw new CliError(`Unknown Node service "${only}"`, `Known: ${config.services.filter((s) => s.runtime === "node").map((s) => s.name).join(", ") || "(none)"}`);
      const apply = ctx.flags["apply"] === true;
      const rows: Array<{ service: string; file: string; migration: string; state: ShutdownState; action: "none" | "would-update" | "updated" | "manual"; changes: string[]; reason?: string; backup?: string }> = [];
      for (const s of targets) {
        const rel = `${s.path}/src/main.ts`;
        const file = join(root, ...rel.split("/"));
        const plan = planShutdownMigration(existsSync(file) ? readFileSync(file, "utf8") : undefined);
        if (plan.state === "legacy" && plan.next !== undefined) {
          if (apply) {
            copyFileSync(file, `${file}.bak`); // the previous file is kept; nothing is lost if the result is not what you wanted
            writeFileSync(file, plan.next);
            rows.push({ service: s.name, file: rel, migration: "shutdown-on-signals", state: plan.state, action: "updated", changes: plan.changes, backup: `${rel}.bak` });
          } else rows.push({ service: s.name, file: rel, migration: "shutdown-on-signals", state: plan.state, action: "would-update", changes: plan.changes });
        } else rows.push({ service: s.name, file: rel, migration: "shutdown-on-signals", state: plan.state, action: plan.state === "custom" ? "manual" : "none", changes: [], ...(plan.reason ? { reason: plan.reason } : {}) });
      }
      // information about Spring services: reported, never changed, and never a reason for a non-zero exit code
      const notes = config.services.filter((s) => s.runtime === "spring-boot" && (!only || s.name === only))
        .flatMap((s) => { const n = templateOutboxNote(join(root, ...s.path.split("/")), s.path); return n ? [{ service: s.name, migration: "template-outbox-table", note: n }] : []; });
      const pending = rows.filter((r) => r.action === "would-update").length, manual = rows.filter((r) => r.action === "manual").length;
      emit(ctx, { applied: apply, migrations: rows, notes }, [
        ...rows.flatMap((r) => [
          `${({ none: r.state === "current" ? "up to date " : "nothing    ", "would-update": "would update", updated: "updated    ", manual: "MANUAL     " })[r.action]} ${r.file}  [${r.migration}]`,
          ...r.changes.map((c) => `             - ${c}`),
          ...(r.backup ? [`             previous file kept as ${r.backup}`] : []),
          ...(r.reason && r.state !== "current" ? [`             ${r.reason}`] : []),
        ]),
        ...(rows.length === 0 ? ["no Node service in this workspace"] : []),
        ...notes.map((n) => `note         ${n.service}  [${n.migration}]\n             ${n.note}`),
        ...(pending ? [`\n${pending} file(s) would change. Nothing was written. Run \`pso migrate --apply\` to apply.`] : []),
        ...(manual ? [`\n${manual} file(s) need a manual change (see above).`] : []),
      ].join("\n"));
      // exit code: 0 nothing left to do; 1 something is pending (a preview with changes, or a file only you can change)
      return pending || manual ? 1 : 0;
    },
  },
};
