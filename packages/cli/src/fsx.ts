import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class CliError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;
  constructor(message: string, hint?: string, exitCode = 1) {
    super(message);
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export interface WriteResult {
  path: string;
  action: "created" | "unchanged" | "conflict" | "overwritten";
}

/** True when `target` is inside `root` (after resolution), never equal to a sibling prefix like root-evil. */
export const isInside = (root: string, target: string): boolean => {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Writes generated files. Idempotent (identical content = unchanged) and never silently overwrites
 * user code: differing existing files are reported as conflicts unless `force` is set.
 */
export function writeFiles(root: string, files: Record<string, string>, opts: { dryRun?: boolean; force?: boolean }): WriteResult[] {
  const results: WriteResult[] = [];
  for (const rel of Object.keys(files).sort()) {
    const abs = join(root, ...rel.split("/"));
    if (!isInside(root, abs)) throw new CliError(`Refusing to write outside the project: ${rel}`);
    const content = files[rel]!;
    let action: WriteResult["action"] = "created";
    if (existsSync(abs)) {
      if (readFileSync(abs, "utf8") === content) action = "unchanged";
      else action = opts.force ? "overwritten" : "conflict";
    }
    if (!opts.dryRun && (action === "created" || action === "overwritten")) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, { mode: /(^|\/)mvnw$/.test(rel) ? 0o755 : 0o644 });
    }
    results.push({ path: rel, action });
  }
  return results;
}

export const posix = (p: string): string => p.split(sep).join("/");
