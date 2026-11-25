import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { cmp } from "./diagnostics.ts";

/**
 * Secure, deterministic recursive file walk used by every static scan in PSO.
 *
 * Policy (explicit, not accidental):
 *  - symbolic links and Windows junctions are NEVER followed by default ("skip"): a link inside a project cannot make a scan read
 *    files that are not part of it. `symlinks: "internal"` follows a link only when its canonical target is inside the root and
 *    has not been visited yet (so aliases and cycles cannot duplicate or loop).
 *  - every directory is resolved to its canonical path, must stay inside the canonical root, and is visited at most once.
 *  - unreadable directories are reported, never thrown, and never abort the scan.
 *  - entries are visited in a fixed order (`cmp`), independent of the file system.
 *  - file contents are never read here and nothing is executed.
 */
export interface WalkOptions {
  /** directory names that are never entered (compared with the entry name) */
  ignore?: ReadonlySet<string>;
  symlinks?: "skip" | "internal";
  /** safety bound against pathological trees (default 64) */
  maxDepth?: number;
  /** safety bound on the number of files returned (default 200000) */
  maxFiles?: number;
}

export type WalkIssueCode = "PSO_FS_SYMLINK_SKIPPED" | "PSO_FS_OUTSIDE_ROOT" | "PSO_FS_UNREADABLE" | "PSO_FS_DEPTH_LIMIT" | "PSO_FS_FILE_LIMIT";
export interface WalkIssue { code: WalkIssueCode; path: string; message: string }
export interface WalkResult { files: string[]; issues: WalkIssue[] }

/** true when `child` is `root` or lies below it (both already canonical). Case-insensitive on Windows. */
export function isInside(root: string, child: string): boolean {
  const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function walkFiles(start: string, options: WalkOptions = {}): WalkResult {
  const ignore = options.ignore ?? new Set<string>();
  const maxDepth = options.maxDepth ?? 64;
  const maxFiles = options.maxFiles ?? 200_000;
  const files: string[] = [];
  const issues: WalkIssue[] = [];
  let root: string;
  try {
    root = realpathSync(start);
  } catch {
    issues.push({ code: "PSO_FS_UNREADABLE", path: start, message: "the scan root cannot be resolved" });
    return { files, issues };
  }
  const visited = new Set<string>([process.platform === "win32" ? root.toLowerCase() : root]);

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) { issues.push({ code: "PSO_FS_DEPTH_LIMIT", path: dir, message: `directory nesting exceeds ${maxDepth} levels; not scanned` }); return; }
    let names: string[];
    try { names = readdirSync(dir).sort(cmp); } catch { issues.push({ code: "PSO_FS_UNREADABLE", path: dir, message: "directory cannot be read (permissions or removed)" }); return; }
    for (const name of names) {
      if (files.length >= maxFiles) { if (!issues.some((i) => i.code === "PSO_FS_FILE_LIMIT")) issues.push({ code: "PSO_FS_FILE_LIMIT", path: dir, message: `more than ${maxFiles} files; the scan was truncated` }); return; }
      if (ignore.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; } // vanished or inaccessible entry
      if (st.isSymbolicLink()) {
        if ((options.symlinks ?? "skip") === "skip") { issues.push({ code: "PSO_FS_SYMLINK_SKIPPED", path: full, message: "symbolic link or junction not followed" }); continue; }
        let target: string;
        try { target = realpathSync(full); } catch { issues.push({ code: "PSO_FS_UNREADABLE", path: full, message: "broken or unresolvable link" }); continue; }
        if (!isInside(root, target)) { issues.push({ code: "PSO_FS_OUTSIDE_ROOT", path: full, message: "link resolves outside the authorized root; not followed" }); continue; }
        const key = process.platform === "win32" ? target.toLowerCase() : target;
        let tst;
        try { tst = lstatSync(target); } catch { continue; }
        if (tst.isDirectory()) { if (visited.has(key)) continue; visited.add(key); visit(full, depth + 1); }
        else if (tst.isFile()) files.push(full);
        continue;
      }
      if (st.isDirectory()) {
        let canonical: string;
        try { canonical = realpathSync(full); } catch { issues.push({ code: "PSO_FS_UNREADABLE", path: full, message: "directory cannot be resolved" }); continue; }
        if (!isInside(root, canonical)) { issues.push({ code: "PSO_FS_OUTSIDE_ROOT", path: full, message: "directory resolves outside the authorized root (a parent component is a link); not scanned" }); continue; }
        const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
        if (visited.has(key)) continue; // already scanned through another path
        visited.add(key);
        visit(full, depth + 1);
      } else if (st.isFile()) files.push(full);
    }
  };
  visit(start, 0);
  return { files, issues };
}

/** project-relative, forward-slash form used in diagnostics */
export const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join("/");
