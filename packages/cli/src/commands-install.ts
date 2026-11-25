import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import type { Command, Ctx } from "./commands.ts";
import { emit } from "./emit.ts";
import { InstallError, installPackage, integrityCheck, repair, uninstall, type UninstallMode } from "./install.ts";
import { PsopkgError, fingerprintOf, type TrustedKey } from "./psopkg.ts";
import { UpdateError, checkForUpdate, installUpdate, rollback, type Channel } from "./update.ts";
import { RecipientError, identityExists, loadPrivateKeyPem } from "./recipient-store.ts";

/**
 * Lifecycle of an installation managed from signed .psopkg packages: setup, integrity, repair, uninstall, update. Every command needs an
 * explicit installation root (--root, PSO_HOME, or the installation whose launcher started the process) so nothing ever operates on a directory by accident; destructive ones need --yes.
 */
const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
  try { return await f(); }
  catch (e) {
    if (e instanceof PsopkgError || e instanceof InstallError || e instanceof UpdateError) throw new CliError(`${e.code}: ${e.message}`);
    throw e;
  }
};
const list = (v: string | boolean | undefined): string[] => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function rootOf(ctx: Ctx): string {
  // --root, then PSO_HOME, then the installation whose own launcher started this process (set by bin/pso-launch.mjs, never by a guess)
  const r = str(ctx.flags["root"]) ?? process.env["PSO_HOME"] ?? process.env["PSO_LAUNCHED_FROM"];
  if (!r) throw new CliError("no installation root", "Pass --root <dir> (or set PSO_HOME). PSO never guesses which directory to operate on; an installed `pso` uses the installation it runs from");
  return resolve(ctx.cwd, r);
}
function trustFlag(ctx: Ctx): TrustedKey[] | undefined {
  const files = list(ctx.flags["trust"]);
  if (files.length === 0) return undefined; // the installation's own trust store
  return files.map((f) => { if (!existsSync(f)) throw new CliError(`trusted key not found: ${f}`); const pem = readFileSync(f, "utf8"); return { id: fingerprintOf(pem), publicKeyPem: pem }; });
}
/** The developer's own protected recipient identity (see `pso-recipient`), opened only when an encrypted package actually has to be decrypted. An explicit --key wins. */
function keyProvider(ctx: Ctx): (() => string) | undefined {
  if (str(ctx.flags["key"]) || !identityExists()) return undefined;
  return () => { try { return loadPrivateKeyPem(); } catch (e) { if (e instanceof RecipientError) throw new CliError(`${e.code}: ${e.message}`); throw e; } };
}
const recipientKey = (ctx: Ctx): string | undefined => { const k = str(ctx.flags["key"]); if (!k) return undefined; if (!existsSync(k)) throw new CliError(`recipient key not found: ${k}`); return readFileSync(k, "utf8"); };

export const INSTALL_COMMANDS: Record<string, Command> = {
  setup: {
    usage: "pso setup --package <file.psopkg> --root <dir> --trust <public.pem[,more]> [--key <recipient-private.pem>] [--no-activate] [--json]",
    summary: "Install a signed .psopkg into an installation root (verified completely before anything is written; side by side with other versions)",
    async run(ctx) {
      const pkg = str(ctx.flags["package"]);
      if (!pkg) throw new CliError("--package <file.psopkg> is required");
      const trusted = trustFlag(ctx);
      if (!trusted) throw new CliError("--trust <public key> is required for the first installation", "The installation records the signer it trusts; later commands use that record");
      const r = await wrap(() => installPackage({ root: rootOf(ctx), packageFile: resolve(ctx.cwd, pkg), trustedKeys: trusted, ...(recipientKey(ctx) ? { recipientKeyPem: recipientKey(ctx)! } : {}), ...(keyProvider(ctx) ? { recipientKeyProvider: keyProvider(ctx)! } : {}), activate: ctx.flags["no-activate"] !== true }));
      emit(ctx, { root: rootOf(ctx), ...r }, `installed ${r.version} (${r.files} file(s)) into ${rootOf(ctx)}${r.activated ? "" : " (not activated)"}`);
      return 0;
    },
  },

  integrity: {
    usage: "pso integrity check [--full] [--root <dir>] [--trust <public.pem>] [--json] | report [--full] [--root <dir>] [--json]",
    summary: "Verify the installed files against the signed inventory (read-only: nothing is ever modified)",
    async run(ctx) {
      const sub = ctx.positionals[0];
      if (sub !== "check" && sub !== "report") throw new CliError(`Unknown integrity command "${sub ?? ""}"`, "Use: check | report");
      const rep = await wrap(() => integrityCheck(rootOf(ctx), { full: ctx.flags["full"] === true, ...(trustFlag(ctx) ? { trustedKeys: trustFlag(ctx)! } : {}) }));
      const text = [`${rep.ok ? "OK" : "PROBLEMS"}  ${rep.root}  version ${rep.version ?? "(none)"}  (${rep.mode} check)`, ...rep.checks.map((c) => `  ${c.status === "ok" ? "ok  " : c.status === "failed" ? "FAIL" : "n/a "} ${c.name}: ${c.detail}`), ...rep.files.damaged.slice(0, 20).map((d) => `  damaged: ${d.path} (${d.state})`), ...(rep.ok ? [] : ["Run `pso repair` to restore damaged files from the authenticated package."])].join("\n");
      emit(ctx, rep, text);
      return rep.ok ? 0 : 1;
    },
  },

  repair: {
    usage: "pso repair [--quick | --full] [--dry-run] [--package <file.psopkg>] [--key <recipient-private.pem>] [--root <dir>] [--trust <public.pem>] [--json]",
    summary: "Restore damaged or missing files of the installed version from an authenticated package (never upgrades; user data is never touched)",
    async run(ctx) {
      if (ctx.flags["quick"] === true && ctx.flags["full"] === true) throw new CliError("--quick and --full are exclusive");
      const pkg = str(ctx.flags["package"]);
      const r = await wrap(() => repair(rootOf(ctx), { full: ctx.flags["full"] === true, dryRun: ctx.flags["dry-run"] === true, ...(pkg ? { packageFile: resolve(ctx.cwd, pkg) } : {}), ...(recipientKey(ctx) ? { recipientKeyPem: recipientKey(ctx)! } : {}), ...(keyProvider(ctx) ? { recipientKeyProvider: keyProvider(ctx)! } : {}), ...(trustFlag(ctx) ? { trustedKeys: trustFlag(ctx)! } : {}) }));
      emit(ctx, r, r.repaired.length === 0 ? `nothing to repair in ${r.version} (${r.mode} check)` : `${r.dryRun ? "[dry-run] would restore" : "restored"} ${r.repaired.length} file(s) of ${r.version} from ${r.source}:\n  ${r.repaired.slice(0, 20).join("\n  ")}${r.unexpected.length ? `\n${r.unexpected.length} unexpected file(s) were left alone` : ""}`);
      return 0;
    },
  },

  uninstall: {
    usage: "pso uninstall [--complete | --purge --project <dir> --confirm <same dir>] --root <dir> --yes [--trust <public.pem>] [--json]",
    summary: "Remove an installation using its inventory: standard keeps config/cache/logs, --complete removes everything PSO owns, --purge also deletes projects you name and confirm",
    async run(ctx) {
      if (ctx.flags["yes"] !== true) throw new CliError("uninstall is destructive and needs --yes", "Review the mode first: standard keeps user data, --complete removes all PSO-owned data, --purge also deletes the projects you name");
      if (ctx.flags["complete"] === true && ctx.flags["purge"] === true) throw new CliError("--complete and --purge are exclusive (--purge includes everything --complete removes)");
      const mode: UninstallMode = ctx.flags["purge"] === true ? "purge" : ctx.flags["complete"] === true ? "complete" : "standard";
      const r = await wrap(() => uninstall(rootOf(ctx), { mode, purgeProjects: list(ctx.flags["project"]), confirmPaths: list(ctx.flags["confirm"]), ...(trustFlag(ctx) ? { trustedKeys: trustFlag(ctx)! } : {}) }));
      emit(ctx, r, `${mode} uninstall: removed ${r.removedFiles} file(s) and ${r.removedDirs} director(ies)${r.preserved.length ? `; kept ${r.preserved.join(", ")}` : ""}${r.purgedProjects.length ? `; deleted project(s) ${r.purgedProjects.join(", ")}` : ""}${r.residual.length ? `\nresidual (not removed):\n  ${r.residual.map((x) => `${x.path}: ${x.reason}`).join("\n  ")}` : ""}`);
      return r.residual.length ? 1 : 0;
    },
  },

  update: {
    usage: "pso update check --catalog <file|https url> [--channel <stable|beta|dev>] [--root <dir>] [--trust <public.pem>] | install [--catalog <file|https url> | --package <file.psopkg>] [--channel <stable|beta|dev>] [--key <recipient-private.pem>] [--allow-downgrade] [--root <dir>] [--trust <public.pem>] | rollback [--root <dir>] [--json]",
    summary: "Check for, install (side by side, verified, atomically activated) and roll back signed updates; offline packages are supported",
    async run(ctx) {
      const sub = ctx.positionals[0];
      const channel = (str(ctx.flags["channel"]) ?? "stable") as Channel;
      if (!["stable", "beta", "dev"].includes(channel)) throw new CliError("--channel must be stable, beta or dev");
      const trusted = trustFlag(ctx);
      if (sub === "check") {
        const cat = str(ctx.flags["catalog"]);
        if (!cat) throw new CliError("--catalog <file|https url> is required");
        const r = await wrap(() => checkForUpdate(rootOf(ctx), { catalog: /^[a-z]+:\/\//i.test(cat) ? cat : resolve(ctx.cwd, cat), channel, ...(trusted ? { trustedKeys: trusted } : {}) }));
        emit(ctx, r, r.available ? `update available: ${r.current ?? "(none)"} -> ${r.available.version} (${r.channel})` : `no update: ${r.reason}`);
        return 0;
      }
      if (sub === "install") {
        const cat = str(ctx.flags["catalog"]), pkg = str(ctx.flags["package"]);
        const r = await wrap(() => installUpdate(rootOf(ctx), { channel, ...(cat ? { catalog: /^[a-z]+:\/\//i.test(cat) ? cat : resolve(ctx.cwd, cat) } : {}), ...(pkg ? { packageFile: resolve(ctx.cwd, pkg) } : {}), ...(trusted ? { trustedKeys: trusted } : {}), ...(recipientKey(ctx) ? { recipientKeyPem: recipientKey(ctx)! } : {}), ...(keyProvider(ctx) ? { recipientKeyProvider: keyProvider(ctx)! } : {}), ...(ctx.flags["allow-downgrade"] === true ? { allowDowngrade: true } : {}) }));
        emit(ctx, r, `updated ${r.from ?? "(none)"} -> ${r.to}. The previous version is kept: \`pso update rollback\` returns to it.`);
        return 0;
      }
      if (sub === "rollback") {
        const r = await wrap(() => rollback(rootOf(ctx)));
        emit(ctx, r, `rolled back ${r.from} -> ${r.to}`);
        return 0;
      }
      throw new CliError(`Unknown update command "${sub ?? ""}"`, "Use: check | install | rollback");
    },
  },
};
