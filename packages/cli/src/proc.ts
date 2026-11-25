import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * How the CLI starts other programs: always an executable and an argument array, never a command string handed to a shell.
 *
 * On Windows `npm`, `npx` and `mvn` are batch wrappers (`npm.cmd`), which Node refuses to start directly, and `spawn(..., { shell: true })`
 * with arguments concatenates them into one unescaped command line (Node reports it as DEP0190). Two explicit forms replace it:
 *   - npm and npx are JavaScript programs shipped next to `node.exe`: they are run with the current Node binary, no wrapper involved;
 *   - any other wrapper (`mvn`, `mvnw.cmd`, an npm that is not next to node) is run by `cmd.exe /d /s /c` with every argument passed as
 *     its own array element. The arguments are still an array for Node, and the ones the CLI passes are fixed words, paths and
 *     validated names; an argument that cmd.exe would interpret (`&`, `|`, `<`, `>`, `^`, `%`, `"`, a line break) is refused.
 * POSIX systems execute the program directly.
 */
export interface Invocation { command: string; args: string[] }

const CMD_UNSAFE = /[&|<>^%"\r\n]/;

/** A batch wrapper or a bare program name that Windows resolves through PATHEXT, run by cmd.exe with an explicit argument array. */
export function viaCmd(program: string, args: readonly string[]): Invocation {
  for (const a of [program, ...args]) if (CMD_UNSAFE.test(a)) throw new Error(`refusing to pass an argument containing a shell metacharacter to cmd.exe: ${JSON.stringify(a)}`);
  return { command: process.env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c", program, ...args] };
}

/** The JavaScript entry point of the npm that ships with the running Node, when it is where a standard installation puts it. */
function npmScript(name: "npm" | "npx", execPath: string): string | undefined {
  const bin = dirname(execPath);
  for (const root of [join(bin, "node_modules", "npm", "bin"), join(bin, "..", "lib", "node_modules", "npm", "bin")]) {
    const file = join(root, `${name}-cli.js`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** `npm <args>` / `npx <args>` without a shell on every platform. */
export function npmInvocation(name: "npm" | "npx", args: readonly string[], platform: NodeJS.Platform = process.platform, execPath: string = process.execPath): Invocation {
  if (platform !== "win32") return { command: name, args: [...args] };
  const script = npmScript(name, execPath);
  return script ? { command: execPath, args: [script, ...args] } : viaCmd(name, args);
}

/** A program that is a native executable on POSIX and may be a batch wrapper on Windows (`mvn`, `java`, `docker`). */
export function programInvocation(program: string, args: readonly string[], platform: NodeJS.Platform = process.platform): Invocation {
  if (program === "npm" || program === "npx") return npmInvocation(program, args, platform);
  // java.exe and docker.exe are real executables; only wrappers need cmd.exe
  return platform === "win32" && program === "mvn" ? viaCmd(program, args) : { command: program, args: [...args] };
}
