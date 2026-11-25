import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ALL_COMMANDS } from "../src/registry.ts";
import { NOT_IMPLEMENTED, UNSUPPORTED_CAPABILITIES } from "../src/unimplemented.ts";
import { CLI_NOTES } from "../src/portal/cli-notes.ts";
import { optionsFromUsage, parseForCommand, specOf } from "../src/cli-spec.ts";
import { TEMPLATES_DIR } from "../src/templates.ts";

/**
 * Parity between what the framework says and what it does, in both directions:
 *   - no document, template or note names a command that does not exist, or an option its command does not accept;
 *   - every command is documented with at least one example that the argument parser accepts;
 *   - nothing is still listed as "not supported" once the sources implement it (F-05), and what is listed really is absent.
 * The human documentation and the AI contexts are generated from the same registries (commands, notes, unsupported list), so a
 * failure here is a failure of both.
 */
const docs = resolve(import.meta.dirname, "..", "docs");
const repo = resolve(import.meta.dirname, "..", "..", "..");
const walk = (d: string, ext: RegExp): string[] => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? (["node_modules", "target", "dist"].includes(e) ? [] : walk(f, ext)) : ext.test(f) ? [f] : []; });
const text = (f: string): string => readFileSync(f, "utf8").replaceAll("\r\n", "\n");

/** `pso <command> ...` invocations inside fenced code blocks, inline code and comments. */
function invocations(source: string): Array<{ command: string; rest: string }> {
  const out: Array<{ command: string; rest: string }> = [];
  for (const m of source.matchAll(/(?:^|[`\s(>$])pso ([a-z][a-z-]*(?::[a-z-]+)?)((?: +[^\n`|;&)#]*)?)/gm)) out.push({ command: m[1]!, rest: (m[2] ?? "").trim() });
  return out;
}

test("no page, generated template or reference note names a command that does not exist", () => {
  const sources = [...walk(docs, /\.md$/), ...walk(TEMPLATES_DIR, /\.(ts|md|yml|java|json|xml)$/), ...walk(join(repo, "docs"), /\.md$/)];
  const unknown: string[] = [];
  // words that follow "pso" in prose and are not commands
  const PROSE = new Set(["make", "command", "dev", "docs", "studio", "help", "web", "is", "cli", "games", "java", "config", "bom", "parent", "test", "spring", "starter", "outbox", "dispatch", "security", "channels", "storage", "http", "data", "observability", "ratelimit", "integration", "home", "env", "types"]);
  for (const f of sources) {
    for (const { command } of invocations(text(f))) {
      if (ALL_COMMANDS[command] || NOT_IMPLEMENTED.includes(command)) continue;
      if (!command.includes(":") && PROSE.has(command)) continue;
      // the one place an obsolete name may appear: the table that says it never existed
      if (command === "security:inspect" && /never existed/.test(text(f))) continue;
      // historical records of earlier work describe what was true then
      if (relative(repo, f).replace(/\\/g, "/").startsWith("docs/implementation/")) continue;
      unknown.push(`${relative(repo, f).replace(/\\/g, "/")}: pso ${command}`);
    }
  }
  assert.deepEqual([...new Set(unknown)], [], "documents must not name commands that do not exist");
  assert.ok(!text(join(TEMPLATES_DIR, "orchestrator", "src", "guards", "jwt.guard.ts")).includes("security:inspect"), "F-16: the generated guard names an existing command");
});

test("every command has reference notes whose examples its own argument parser accepts", () => {
  const problems: string[] = [];
  for (const [name, cmd] of Object.entries(ALL_COMMANDS)) {
    const note = CLI_NOTES[name];
    if (!note?.examples?.length) { problems.push(`${name}: no example`); continue; }
    const spec = specOf(cmd);
    for (const example of note.examples) {
      const line = example.split("#")[0]!.trim();
      if (!line.startsWith(`pso ${name}`)) continue; // a preparatory shell line (cd, docker compose, another pso command)
      // split like a shell would, keeping quoted values together
      const argv = [...line.slice(`pso ${name}`.length).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
      const parsed = parseForCommand(name, argv, spec);
      if (parsed.problems.length) problems.push(`${name}: \`${example}\` -> ${parsed.problems.join("; ")}`);
    }
    for (const flag of Object.keys(note.flags ?? {})) if (!spec.options.has(flag.replace(/^--/, ""))) problems.push(`${name}: the notes describe ${flag}, which the command does not accept`);
  }
  assert.deepEqual(problems, []);
});

test("commands shown in the documentation use options their command accepts", () => {
  const problems: string[] = [];
  for (const f of walk(docs, /\.md$/)) {
    const id = relative(docs, f).replace(/\\/g, "/");
    for (const block of text(f).matchAll(/```(?:bash|powershell|sh|console|pso-example)[^\n]*\n([\s\S]*?)```/g)) {
      for (const raw of block[1]!.split("\n")) {
        const line = raw.replace(/^\s*[$>]\s*/, "").split(" #")[0]!.trim();
        const m = /^pso ([a-z][a-z-]*(?::[a-z-]+)?)(?:\s+(.*))?$/.exec(line);
        if (!m || !ALL_COMMANDS[m[1]!]) continue;
        if (/[|<>]|\$\(|`|\\$/.test(m[2] ?? "")) continue; // pipes, substitutions and continued lines are shell, not arguments
        const argv = [...(m[2] ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((x) => x[1] ?? x[2] ?? x[3]!);
        const known = optionsFromUsage(ALL_COMMANDS[m[1]!]!.usage);
        for (const a of argv) if (a.startsWith("--")) { const flag = a.slice(2).split("=")[0]!; if (flag !== "help" && !known.has(flag)) problems.push(`${id}: \`${line}\`: --${flag} is not an option of pso ${m[1]}`); }
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("nothing implemented is still listed as unsupported, and what is listed is really absent (F-05)", () => {
  const list = UNSUPPORTED_CAPABILITIES.join("\n");
  const has = (...p: string[]): boolean => existsSync(join(repo, ...p));
  const src = (...p: string[]): string => text(join(repo, ...p));
  // implemented: must not be claimed as missing
  const implemented: Array<[what: string, exists: boolean, staleClaim: RegExp]> = [
    ["DTO validation in the orchestrator", /export (async )?function validateDto/.test(src("packages", "http", "src", "validation.ts")), /DTO (schema )?validation in the orchestrator/i],
    ["OpenTelemetry export in the orchestrator", has("packages", "http", "src", "otel.ts"), /CORS handling, OpenTelemetry export|OpenTelemetry export (and|,) [^.]*in the orchestrator/i],
    ["the observability starter", has("pso-java", "pso-observability-starter", "pom.xml"), /pso-observability-starter/],
    ["distributed rate limiting", /class RedisRateLimiter/.test(src("packages", "http", "src", "ratelimit.ts")) && has("pso-java", "pso-ratelimit-redis-starter", "pom.xml"), /distributed rate-limiter/i],
    ["service identity", has("pso-java", "pso-http-spring-boot-starter", "src", "main", "java", "com", "pso", "spring", "http", "ServiceIdentity.java") && /certFile/.test(src("packages", "http", "src", "upstream-security.ts")), /service-to-service identit/i],
    ["the Compose deployment target", /target === "compose"/.test(src("packages", "cli", "src", "commands-devops.ts")), /compose target needs Docker and is unverified/i],
    ["response composition in the orchestrator", has("packages", "http", "src", "client.ts"), /composing responses|no service client/i],
  ];
  for (const [what, exists, stale] of implemented) {
    assert.ok(exists, `${what}: expected to be implemented (the check itself is out of date)`);
    assert.doesNotMatch(list, stale, `${what} is implemented and must not be listed as unsupported`);
  }
  // listed as absent: must really be absent from the orchestrator runtime
  const http = walk(join(repo, "packages", "http", "src"), /\.ts$/).map(text).join("\n");
  assert.match(list, /Inbound TLS termination in the orchestrator/);
  assert.doesNotMatch(http, /createSecureServer|https\.createServer|from "node:https";\s*\n[^\n]*createServer/, "the orchestrator has no HTTPS listener");
  assert.match(list, /CORS handling in the orchestrator/);
  assert.doesNotMatch(http, /access-control-allow-origin/i, "the orchestrator has no CORS handling");
  assert.match(list, /circuit breakers/);
  assert.doesNotMatch(http, /circuit/i);
  assert.match(list, /token revocation/);
  assert.match(list, /Published packages/);
  for (const name of ["core", "http", "cli"]) assert.equal((JSON.parse(src("packages", name, "package.json")) as { publishConfig?: unknown }).publishConfig, undefined, `@pso/${name} is not configured for publication`);
  // the AI contexts take the list from the same constant: a hand-written copy would drift
  for (const f of walk(join(docs, "ai-context"), /\.md$/)) assert.doesNotMatch(text(f), /DTO schema validation in the orchestrator|pso-observability-starter, a distributed/, relative(docs, f));
});
