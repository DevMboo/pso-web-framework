/**
 * What a command accepts, checked BEFORE the command runs (and so before any file is touched).
 *
 * The usage line of a command is its declaration: every `--flag` written there is accepted, and whether it takes a value is read from
 * the same line (`--scopes a,b` takes one, `--public` does not). Help, documentation and validation therefore cannot disagree: a flag
 * that is not in the usage line does not exist for that command. A command may add `options` for flags it accepts without advertising
 * them (compatibility aliases), and `args` for how many positional arguments it takes.
 *
 * Nothing is ignored silently: an unknown flag, a value given to a switch, a missing value and an extra positional argument are
 * usage errors (exit code 2) that name the command, the offending argument and, when one is close, the flag that was probably meant.
 */

export type OptionKind = "boolean" | "value";

export interface CommandSpec {
  /** every flag the command accepts, without the leading dashes */
  options: ReadonlyMap<string, OptionKind>;
  /** largest number of positional arguments, or undefined when the command checks them itself */
  maxArgs: number | undefined;
}

export interface SpecSource {
  usage: string;
  /** flags accepted in addition to the ones in the usage line (for example a compatibility alias) */
  options?: Readonly<Record<string, OptionKind>>;
  /** largest number of positional arguments after the command name */
  args?: number;
}

/** Accepted by every command; `pso <command> --help` never reaches the command. */
const GLOBAL: ReadonlyArray<readonly [string, OptionKind]> = [["help", "boolean"]];

/** Flags that may be given several times; their values accumulate (see args.ts). */
export const REPEATABLE = new Set(["set", "health-url"]);

// a flag, then optionally its value: a placeholder (<...>), a quoted example, or a bare word that is not the start of another group
const FLAG = /--([a-z][a-z0-9-]*)(?:(?:=|[ \t]+)(<[^>]*>|"[^"]*"|[^\s[\]()|<"-][^\s[\]()]*))?/g;

/** Reads the accepted flags from a usage line. A flag that takes a value in any alternative of the line takes a value. */
export function optionsFromUsage(usage: string): Map<string, OptionKind> {
  const out = new Map<string, OptionKind>();
  for (const m of usage.matchAll(FLAG)) {
    const kind: OptionKind = m[2] !== undefined ? "value" : "boolean";
    if (kind === "value" || !out.has(m[1]!)) out.set(m[1]!, kind);
  }
  return out;
}

export function specOf(cmd: SpecSource): CommandSpec {
  const options = optionsFromUsage(cmd.usage);
  for (const [k, v] of Object.entries(cmd.options ?? {})) options.set(k, v);
  for (const [k, v] of GLOBAL) options.set(k, v);
  return { options, maxArgs: cmd.args };
}

/** Edit distance, bounded: used only to suggest the flag that was probably meant. */
export function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The closest accepted name: a prefix relation (`--scope` / `--scopes`) or at most two edits; undefined when nothing is close. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined, bestScore = Infinity;
  for (const c of candidates) {
    if (c === "help") continue;
    const score = c.startsWith(name) || name.startsWith(c) ? 0.5 : distance(name, c);
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

export interface ParsedCommand {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** usage errors, in the order they were found; empty when the invocation is acceptable */
  problems: string[];
}

/**
 * Parses the arguments that follow the command name against the command's own specification:
 * `--flag`, `--flag value`, `--flag=value`. A switch never consumes the next word; a flag that takes a value always needs one.
 */
export function parseForCommand(command: string, argv: readonly string[], spec: CommandSpec): ParsedCommand {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const problems: string[] = [];
  const known = [...spec.options.keys()].filter((k) => k !== "help").sort();
  const list = known.length ? `Accepted: ${known.map((k) => `--${k}`).join(", ")}` : "This command takes no options";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") { flags["help"] = true; continue; }
    if (!a.startsWith("--") || a === "--") {
      if (/^-[A-Za-z]/.test(a)) { problems.push(`Unknown option "${a}" for \`pso ${command}\`: short options are not supported. ${list}`); continue; }
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const kind = spec.options.get(key);
    if (kind === undefined) {
      const near = closest(key, known);
      problems.push(`Unknown option "--${key}" for \`pso ${command}\`.${near ? ` Did you mean --${near}?` : ""} ${list}`);
      // the word after an unknown flag is not interpreted: it could be its value, and guessing would hide the mistake
      if (inline === undefined && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (kind === "boolean") {
      if (inline !== undefined) { problems.push(`Option "--${key}" of \`pso ${command}\` is a switch and takes no value (got "--${key}=${inline}")`); continue; }
      flags[key] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { problems.push(`Option "--${key}" of \`pso ${command}\` needs a value`); continue; }
      value = next;
      i++;
    }
    if (value === "") { problems.push(`Option "--${key}" of \`pso ${command}\` needs a value (it is empty)`); continue; }
    const prev = flags[key];
    flags[key] = REPEATABLE.has(key) && typeof prev === "string" ? `${prev}\n${value}` : value;
  }
  if (spec.maxArgs !== undefined && positionals.length > spec.maxArgs) {
    const extra = positionals.slice(spec.maxArgs);
    problems.push(`Unexpected argument${extra.length > 1 ? "s" : ""} ${extra.map((x) => `"${x}"`).join(", ")} for \`pso ${command}\`: it takes ${spec.maxArgs === 0 ? "no positional argument" : `at most ${spec.maxArgs} positional argument${spec.maxArgs > 1 ? "s" : ""}`}`);
  }
  return { positionals, flags, problems };
}

/** The command name: the first word that is not a flag. Flags before it are returned as the rest, in order. */
export function splitCommand(argv: readonly string[]): { command: string | undefined; rest: string[] } {
  const i = argv.findIndex((a) => !a.startsWith("-"));
  if (i < 0) return { command: undefined, rest: [...argv] };
  return { command: argv[i], rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
}
