export interface Parsed {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal, predictable parser: `--flag`, `--flag value`, `--flag=value`. Unknown flags are kept for the command to validate. */
export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { setFlag(flags, a.slice(2, eq), a.slice(eq + 1)); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(key)) { setFlag(flags, key, next); i++; }
      else flags[key] = true;
    } else positionals.push(a);
  }
  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export const BOOLEAN_FLAGS = new Set(["json", "dry-run", "force", "help", "yes", "no-install", "public", "install", "smoke", "mermaid", "write-manifest", "generate", "strict", "no-open", "list", "no-project", "vendor", "dev", "apply", "passphrase-stdin", "password-stdin", "ssh-secret", "purge-applications", "approve", "no-follow", "remove", "verify", "remote"]);

export const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** Repeatable flags (--set) accumulate, newline separated; everything else is last-wins. */
function setFlag(flags: Record<string, string | boolean>, key: string, value: string): void {
  const prev = flags[key];
  flags[key] = (key === "set" || key === "health-url") && typeof prev === "string" ? `${prev}
${value}` : value;
}
