import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { InfraError } from "./contract.ts";

/** The system hosts file of this machine. */
export const systemHostsFile = (): string => (process.platform === "win32" ? `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\drivers\\etc\\hosts` : "/etc/hosts");

/**
 * Inserts, replaces or removes PSO's marked block in a hosts file. Lines outside the block are never changed. The previous file is kept
 * next to it (`<file>.pso-backup`). Writing the system file needs administrator rights; PSO never elevates by itself.
 */
export function applyHostsBlock(file: string, block: string, markers: { begin: string; end: string }, remove = false): { changed: boolean; backup?: string } {
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const nl = cur.includes("\r\n") ? "\r\n" : "\n";
  const lines = cur.split(/\r?\n/);
  const b = lines.findIndex((l) => l.trim() === markers.begin), e = lines.findIndex((l) => l.trim() === markers.end);
  if ((b < 0) !== (e < 0) || (b >= 0 && e < b)) throw new InfraError(`the PSO block in ${file} is damaged (one marker without the other)`, "PSO_HOSTS_DAMAGED", "Remove the PSO lines by hand, then retry");
  const kept = b >= 0 ? [...lines.slice(0, b), ...lines.slice(e + 1)] : lines;
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const next = remove ? kept : [...kept, ...block.trimEnd().split(/\r?\n/)];
  const text = next.join(nl) + nl;
  if (text === cur) return { changed: false };
  const backup = `${file}.pso-backup`;
  if (existsSync(file)) copyFileSync(file, backup);
  try { writeFileSync(file, text); }
  catch (err) { const c = (err as NodeJS.ErrnoException).code; throw new InfraError(`cannot write ${file} (${c ?? (err as Error).message})`, "PSO_HOSTS_PERMISSION", c === "EPERM" || c === "EACCES" ? "Writing the system hosts file needs administrator rights: run the command in an elevated terminal, or add the block shown by `pso infra:hosts` yourself" : undefined); }
  return { changed: true, ...(existsSync(backup) ? { backup } : {}) };
}

export function hostsBlockPresent(file: string, markers: { begin: string }): boolean {
  try { return readFileSync(file, "utf8").split(/\r?\n/).some((l) => l.trim() === markers.begin); } catch { return false; }
}
