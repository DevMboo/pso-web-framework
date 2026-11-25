import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALL_COMMANDS } from "../src/registry.ts";
import { NOT_IMPLEMENTED } from "../src/unimplemented.ts";

/**
 * Documentation drift: what the documents say about environment variables, limits and commands must match what the code reads and registers.
 * The checks are two-way for environment variables (undocumented reads AND documented variables nobody reads).
 */
const root = resolve(import.meta.dirname, "..", "..", "..");
const walk = (dir: string, exts: string[], skip = /node_modules|[\\/]dist[\\/]|[\\/]target[\\/]|\.pso/): string[] => {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (skip.test(f)) continue;
    const st = statSync(f);
    if (st.isDirectory()) out.push(...walk(f, exts, skip)); else if (exts.some((x) => f.endsWith(x))) out.push(f);
  }
  return out;
};
const read = (f: string): string => readFileSync(f, "utf8");
const envPage = read(join(root, "packages/cli/docs/reference/environment-variables.md"));

const tsSources = ["core", "security", "dispatch", "http", "channels", "deploy", "cli", "infra"].flatMap((p) => walk(join(root, "packages", p, "src"), [".ts"]));
const envReads = (): Set<string> => {
  const s = new Set<string>();
  for (const f of tsSources) for (const m of read(f).matchAll(/\b(?:env|ENV)(?:\[\s*"|\??\.)(PSO_[A-Z0-9_]+)/g)) s.add(m[1]!);
  return s;
};

test("every PSO_* environment variable the TypeScript code reads is documented", () => {
  const missing = [...envReads()].filter((v) => !new RegExp(`\\b${v}\\b`).test(envPage));
  assert.deepEqual(missing, [], `undocumented in reference/environment-variables.md: ${missing.join(", ")}`);
});

test("every PSO_* variable the reference documents exists in the code, Spring configuration or templates", () => {
  const corpus = [
    ...tsSources,
    ...walk(join(root, "pso-java"), [".java", ".yml", ".yaml", ".properties", ".imports", ".json"]),
    ...walk(join(root, "packages/cli/templates"), [".yml", ".yaml", ".java", ".ts", ".json", ".xml"]),
    join(root, "packages/cli/src/docker-templates.ts"),
  ].map(read).join("\n");
  const documented = new Set([...envPage.matchAll(/`(PSO_[A-Z0-9_]+)(?:`|<)/g)].map((m) => m[1]!));
  const stale = [...documented].filter((v) => v !== "PSO_CFG_" && !v.endsWith("_") && !new RegExp(`\\b${v}\\b`).test(corpus));
  assert.deepEqual(stale, [], `documented but not used anywhere: ${stale.join(", ")}`);
});

test("every HTTP limit read from a short legacy variable is documented with its canonical key", async () => {
  const limits = read(join(root, "packages/http/src/limits.ts"));
  for (const m of limits.matchAll(/\{\s*env:\s*"([A-Z_]+)",\s*key:\s*"([A-Za-z]+)"/g)) {
    const row = new RegExp(`\\|\\s*\`${m[1]}\`\\s*\\|\\s*\`http\\.limits\\.${m[2]}\`\\s*\\|`);
    assert.match(envPage, row, `${m[1]} -> http.limits.${m[2]} must be listed in the limits table`);
  }
});

test("commands mentioned in the repository documents (docs/ and the CLI guides) exist and use known sub-commands", () => {
  const docs = [...walk(join(root, "docs"), [".md"]), ...walk(join(root, "packages/cli/docs"), [".md"])];
  const unknown: string[] = [];
  for (const f of docs) {
    for (const m of read(f).matchAll(/`pso ([a-z][a-z0-9:-]*)(?: ([a-z][a-z0-9:-]*))?/g)) {
      const name = m[1]!;
      if (name.endsWith(":") || (NOT_IMPLEMENTED as readonly string[]).includes(name)) continue; // a command family ("pso make:") or a command documented as not implemented
      if (!(name in ALL_COMMANDS)) unknown.push(`${f.slice(root.length + 1)}: pso ${name}`);
    }
  }
  assert.deepEqual([...new Set(unknown)], [], "documents mention commands that do not exist");
});

test("claims that the code has since made false do not appear: no stale 'not implemented' for shipped commands", () => {
  const status = read(join(root, "docs/status.md")); // the public status page (the internal history stays private)
  for (const cmd of ["deploy:init", "deploy:validate", "dist", "setup", "integrity", "repair", "update", "uninstall"]) {
    assert.ok(cmd in ALL_COMMANDS, `${cmd} must be registered`);
    const stale = new RegExp(`${cmd.replace(":", "[:]")}[^\\n]{0,40}(not implemented|NOT IMPLEMENTED|exits 2)`, "i");
    assert.ok(!stale.test(status), `status.md still calls ${cmd} unimplemented`);
  }
});

test("every PSO decorator used in the DTO validation documents is really exported by @pso/http", async () => {
  const http = (await import("@pso/http")) as Record<string, unknown>;
  const missing: string[] = [];
  for (const rel of ["orchestrator/dto-validation.md", "orchestrator/dtos.md"]) {
    for (const m of read(join(root, "packages/cli/docs", rel)).matchAll(/@([A-Z][A-Za-z]+)\(/g)) {
      if (!(m[1]! in http)) missing.push(`${rel}: @${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "documents use decorators that do not exist");
});

test("the commands and options used in the DTO and CRUD guides are accepted by the registered commands", () => {
  const needs: Array<[string, string]> = [["make:dto", "--fields"], ["make:route", "--dto"], ["create", "--port"], ["create", "--db"]];
  for (const [cmd, flag] of needs) assert.ok(ALL_COMMANDS[cmd]?.usage.includes(flag), `${cmd} usage must list ${flag}`);
});
