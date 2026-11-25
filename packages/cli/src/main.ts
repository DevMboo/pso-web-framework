import { ALL_COMMANDS as COMMANDS } from "./registry.ts";
import { CliError } from "./fsx.ts";
import { CLI_VERSION } from "./portal/content.ts";
import { closest, parseForCommand, specOf, splitCommand } from "./cli-spec.ts";

import { NOT_IMPLEMENTED } from "./unimplemented.ts";
export { NOT_IMPLEMENTED };

/** Exit code of a usage error: an unknown command, an unknown or malformed option, an unexpected argument. Nothing was changed. */
export const EXIT_USAGE = 2;

export function helpText(): string {
  const rows = Object.entries(COMMANDS).sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, c]) => `  ${n.padEnd(18)} ${c.summary}`);
  return `PSO CLI (Path Structure Working)\n\nUsage: pso <command> [options]\n\nImplemented commands:\n${rows.join("\n")}\n\nNot implemented yet (exit code 2):\n  ${NOT_IMPLEMENTED.join(", ")}\n\nRun \`pso <command> --help\` for usage; \`pso --version\` prints the CLI version.`;
}

/** The help of one command: its usage line (which is also what it accepts), what it does and what each option expects. */
export function commandHelp(name: string): string {
  const cmd = COMMANDS[name]!;
  const spec = specOf(cmd);
  const options = [...spec.options].filter(([k]) => k !== "help").sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, kind]) => `  --${k}${kind === "value" ? " <value>" : ""}`);
  return `Usage: ${cmd.usage}\n${cmd.summary}${options.length ? `\n\nOptions:\n${options.join("\n")}` : ""}${cmd.next ? `\n\nNext: ${cmd.next}` : ""}`;
}

export async function run(argv: string[], cwd: string, print: (s: string) => void, printErr: (s: string) => void): Promise<number> {
  // `pso --version` and `pso -v` print the version of the installed CLI (package.json), when given alone
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) { print(CLI_VERSION); return 0; }
  const { command, rest } = splitCommand(argv);
  if (!command || command === "help") {
    // `pso help <command>` is `pso <command> --help`
    const topic = command === "help" ? rest.find((a) => !a.startsWith("-")) : undefined;
    if (topic && COMMANDS[topic]) { print(commandHelp(topic)); return 0; }
    print(helpText());
    return 0;
  }
  const cmd = COMMANDS[command];
  if (!cmd) {
    if (NOT_IMPLEMENTED.includes(command)) { printErr(`pso ${command}: not implemented yet`); return EXIT_USAGE; }
    const near = closest(command, Object.keys(COMMANDS));
    printErr(`Unknown command "${command}".${near ? ` Did you mean \`pso ${near}\`?` : ""} Run \`pso help\`.`);
    return EXIT_USAGE;
  }
  // every argument is checked against what THIS command accepts before the command runs: nothing is ignored and nothing is written
  // on a usage error (a mistyped --scopes must never produce a route without its authorization policy)
  const parsed = parseForCommand(command, rest, specOf(cmd));
  if (parsed.flags["help"] === true) { print(commandHelp(command)); return 0; }
  if (parsed.problems.length) {
    printErr(`error: ${parsed.problems.join("\nerror: ")}\nusage: ${cmd.usage}\nhint: nothing was changed. Run \`pso ${command} --help\` for the options of this command`);
    return EXIT_USAGE;
  }
  try {
    return await cmd.run({ cwd, positionals: parsed.positionals, flags: parsed.flags, print });
  } catch (e) {
    if (e instanceof CliError) { printErr(`error: ${e.message}${e.hint ? `\nhint: ${e.hint}` : ""}`); return e.exitCode; }
    throw e;
  }
}
