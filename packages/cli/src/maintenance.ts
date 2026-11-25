// Entry point of the installation maintenance commands (setup, integrity, repair, update, uninstall). It loads only what they need:
// no command module, no workspace engine, no @pso/infra, @pso/deploy or @pso/frontend. A damaged file in any of those must not prevent
// `pso integrity check` or `pso repair` from finding and restoring it.
import { CliError } from "./fsx.ts";
import { parseForCommand, specOf, splitCommand } from "./cli-spec.ts";
import { INSTALL_COMMANDS } from "./commands-install.ts";

/** argument limits of these commands (same values as registry.ts) */
const MAX_ARGS: Record<string, number> = { setup: 0, integrity: 1, repair: 0, update: 1, uninstall: 0 };
for (const [name, cmd] of Object.entries(INSTALL_COMMANDS)) if (cmd.args === undefined && MAX_ARGS[name] !== undefined) cmd.args = MAX_ARGS[name]!;

export const MAINTENANCE_COMMANDS: readonly string[] = Object.keys(INSTALL_COMMANDS);

export async function runMaintenance(argv: string[], cwd: string, print: (s: string) => void, printErr: (s: string) => void): Promise<number> {
  const { command, rest } = splitCommand(argv);
  const cmd = command ? INSTALL_COMMANDS[command] : undefined;
  if (!cmd) { printErr(`not a maintenance command: ${command ?? "(none)"}`); return 2; }
  const parsed = parseForCommand(command!, rest, specOf(cmd));
  if (parsed.flags["help"] === true) { print(`Usage: ${cmd.usage}\n${cmd.summary}`); return 0; }
  if (parsed.problems.length) {
    printErr(`error: ${parsed.problems.join("\nerror: ")}\nusage: ${cmd.usage}\nhint: nothing was changed. Run \`pso ${command} --help\` for the options of this command`);
    return 2;
  }
  try {
    return await cmd.run({ cwd, positionals: parsed.positionals, flags: parsed.flags, print });
  } catch (e) {
    if (e instanceof CliError) { printErr(`error: ${e.message}${e.hint ? `\nhint: ${e.hint}` : ""}`); return e.exitCode; }
    throw e;
  }
}
