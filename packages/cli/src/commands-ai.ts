import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findWorkspaceRoot } from "@pso/core";
import { CliError, isInside } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command, type Ctx } from "./commands.ts";
import { DEFAULT_PATH, FORMATS, applyManaged, buildScopes, composeContext, estimateTokens, hasManagedBlock, projectFacts, resolveSelection, wrapFormat, type Format, type Scope } from "./portal/ai.ts";
import { aiMeta, collectPages } from "./portal/build.ts";
import { CLI_VERSION } from "./portal/content.ts";

async function load(): Promise<{ meta: ReturnType<typeof aiMeta>; scopes: Scope[] }> {
  const { ALL_COMMANDS } = await import("./registry.ts"); // lazy: the registry imports this module
  const pages = collectPages(ALL_COMMANDS);
  const meta = aiMeta(ALL_COMMANDS, pages);
  return { meta, scopes: buildScopes(meta) };
}

function selection(ctx: Ctx, scopes: Scope[]): { chosen: Scope[]; ids: string[] } {
  const raw = str(ctx.flags["scope"]);
  const want = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : "complete" as const;
  try {
    const chosen = resolveSelection(scopes, want);
    return { chosen, ids: chosen.map((s) => s.id) };
  } catch (e) {
    throw new CliError((e as Error).message, "Run `pso ai:context --list` to see the available scopes");
  }
}

const formatOf = (ctx: Ctx): Format => {
  const f = str(ctx.flags["format"]) ?? "markdown";
  if (!(FORMATS as readonly string[]).includes(f)) throw new CliError(`Unknown format "${f}"`, `Use one of: ${FORMATS.join(", ")}`);
  return f as Format;
};

/** Only structured, sanitized facts about the project (no file contents, no secrets). Never throws for a missing workspace. */
function project(ctx: Ctx, meta: ReturnType<typeof aiMeta>): { root?: string; text: string } {
  if (ctx.flags["no-project"] === true) return { text: "" };
  const root = findWorkspaceRoot(ctx.cwd);
  return root ? { root, text: projectFacts(root, meta) } : { text: "" };
}

export const AI_COMMANDS: Record<string, Command> = {
  "ai:context": {
    usage: "pso ai:context [--list] [--scope a,b] [--format markdown|json|agents|claude|copilot] [--output <file>] [--no-project] [--dry-run] [--force] [--json]",
    summary: "Generate AI-assistant context from the installed framework and the current project (never includes secrets)",
    async run(ctx) {
      const { meta, scopes } = await load();
      if (ctx.flags["list"] === true) {
        const rows = scopes.map((s) => ({ id: s.id, base: s.base, title: s.title, description: s.description, requires: s.requires, estimatedTokens: estimateTokens(s.body) }));
        emit(ctx, { version: CLI_VERSION, scopes: rows }, [`PSO ${CLI_VERSION} AI context scopes (token counts are estimates: characters / 4)`, ...rows.map((r) => `${r.id.padEnd(22)} ${r.base ? "framework" : "task     "}  ~${String(r.estimatedTokens).padStart(5)}  ${r.title}`)].join("\n"));
        return 0;
      }
      const { chosen, ids } = selection(ctx, scopes);
      const format = formatOf(ctx);
      const proj = project(ctx, meta);
      const body = composeContext(chosen, meta, proj.text);
      const text = wrapFormat(format, body, CLI_VERSION, ids);
      const out = str(ctx.flags["output"]);
      if (!out) { ctx.print(text.replace(/\n$/, "")); return 0; }

      const target = isAbsolute(out) ? out : resolve(ctx.cwd, out);
      if (existsSync(target) && statSync(target).isDirectory()) throw new CliError(`${out} is a directory`);
      const dry = ctx.flags["dry-run"] === true, force = ctx.flags["force"] === true;
      let action: string, final = text;
      if (!existsSync(target)) action = "created";
      else {
        const cur = readFileSync(target, "utf8");
        const managed = format === "agents" || format === "claude" || format === "copilot";
        if (managed && hasManagedBlock(cur)) { final = applyManaged(cur, body, CLI_VERSION).text; action = "updated the managed block"; }
        else if (cur === text) action = "unchanged";
        else if (!force) throw new CliError(`${out} already exists and was not modified`, managed ? "It has no PSO block; use --force to append a managed block (your text is kept) or choose another file" : "Use --force to overwrite it, or choose another file");
        else if (managed) { final = applyManaged(cur, body, CLI_VERSION).text; action = "appended a managed block"; }
        else action = "overwritten";
      }
      if (!dry && action !== "unchanged") { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, final); }
      emit(ctx, { dryRun: dry, file: relative(ctx.cwd, target) || out, action, scopes: ids, characters: final.length, estimatedTokens: estimateTokens(final) }, `${dry ? "[dry-run] " : ""}${action}: ${out} (${final.length} characters, about ${estimateTokens(final)} tokens)`);
      return 0;
    },
  },

  "ai:init": {
    usage: "pso ai:init [--target all|agents,claude,copilot] [--scope a,b] [--no-project] [--dry-run] [--force] [--json]",
    summary: "Inspect the workspace and create AGENTS.md, CLAUDE.md and Copilot instructions with project-specific PSO guidance",
    async run(ctx) {
      const { root } = requireWorkspace(ctx);
      const { meta, scopes } = await load();
      const t = (str(ctx.flags["target"]) ?? "all").split(",").map((x) => x.trim()).filter(Boolean);
      const targets = (t.includes("all") ? ["agents", "claude", "copilot"] : t) as Array<keyof typeof DEFAULT_PATH>;
      for (const x of targets) if (!(x in DEFAULT_PATH)) throw new CliError(`Unknown target "${x}"`, "Use all, agents, claude or copilot");
      const { chosen, ids } = selection(ctx, scopes);
      const facts = ctx.flags["no-project"] === true ? "" : projectFacts(root, meta);
      const body = composeContext(chosen, meta, facts);
      const dry = ctx.flags["dry-run"] === true, force = ctx.flags["force"] === true;
      const rows: Array<{ file: string; action: string }> = [];
      for (const target of targets) {
        const rel = DEFAULT_PATH[target];
        const abs = join(root, ...rel.split("/"));
        if (!isInside(root, abs)) throw new CliError(`Refusing to write outside the workspace: ${rel}`);
        const fresh = wrapFormat(target, body, CLI_VERSION, ids);
        let action: string, final = fresh;
        if (!existsSync(abs)) action = "created";
        else {
          const cur = readFileSync(abs, "utf8");
          if (hasManagedBlock(cur)) { final = applyManaged(cur, body, CLI_VERSION).text; action = final === cur ? "unchanged" : "updated the managed block"; }
          else if (!force) { rows.push({ file: rel, action: "skipped: exists without a PSO block (use --force to append one; your text is kept)" }); continue; }
          else { final = applyManaged(cur, body, CLI_VERSION).text; action = "appended a managed block"; }
        }
        if (!dry && action !== "unchanged") { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, final); }
        rows.push({ file: rel, action });
      }
      emit(ctx, { dryRun: dry, version: CLI_VERSION, scopes: ids, files: rows }, rows.map((r) => `${dry ? "[dry-run] " : ""}${r.action.padEnd(28)} ${r.file}`).join("\n"));
      return 0;
    },
  },
};
