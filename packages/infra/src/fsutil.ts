import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { INFRA_DIR, InfraError } from "./contract.ts";

export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
export const toPosix = (p: string): string => p.split(sep).join("/");
export const relTo = (root: string, abs: string): string => toPosix(relative(root, abs));
export const abs = (root: string, rel: string): string => join(root, ...rel.split("/"));
export const readText = (f: string): string | undefined => { try { return readFileSync(f, "utf8"); } catch { return undefined; } };

const win = process.platform === "win32";

/**
 * Restricts a file holding key or secret material to its owner. POSIX: mode 0600. Windows: the inherited access list is removed and only
 * the current user (and SYSTEM, which every service of the OS runs as) keeps access, with `icacls`. A failure is reported, never ignored:
 * the caller decides whether the resource may still be used.
 */
export function protectFile(file: string): { ok: boolean; detail: string } {
  if (!win) {
    try { chmodSync(file, 0o600); return { ok: true, detail: "mode 0600" }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
  const user = process.env["USERNAME"];
  if (!user) return { ok: false, detail: "USERNAME is not set: cannot restrict the access list" };
  const domain = process.env["USERDOMAIN"];
  const who = domain ? `${domain}\\${user}` : user;
  const r = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${who}:F`, "/grant:r", "*S-1-5-18:F"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  return r.status === 0 ? { ok: true, detail: `access list: ${who} and SYSTEM only` } : { ok: false, detail: (r.stderr || r.stdout || "icacls failed").trim() };
}

/** Is a sensitive file readable by others? POSIX: group/other bits. Windows: an inherited or broad ACE (Everyone, Users, Authenticated Users). */
export function exposure(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  if (!win) { const m = statSync(file).mode & 0o077; return m ? `mode ${(statSync(file).mode & 0o777).toString(8)} allows group/other access` : undefined; }
  const r = spawnSync("icacls", [file], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (r.status !== 0) return "the access list cannot be read";
  const text = r.stdout;
  if (/\(I\)/.test(text)) return "inherits the access list of its directory";
  if (/(Everyone|\\Users|Authenticated Users|S-1-1-0|S-1-5-11|S-1-5-32-545):/i.test(text)) return "is readable by a broad group";
  return undefined;
}

/** Writes a file atomically: a temporary file in the same directory, then one rename. Readers never see a partial file. */
export function atomicWrite(file: string, content: string | Buffer, opts: { sensitive?: boolean } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", opts.sensitive ? 0o600 : 0o644);
  try { writeSync(fd, typeof content === "string" ? Buffer.from(content) : content); } finally { closeSync(fd); }
  if (opts.sensitive) { const p = protectFile(tmp); if (!p.ok) { rmSync(tmp, { force: true }); throw new InfraError(`cannot restrict access to ${file}: ${p.detail}`, "PSO_INFRA_PERMISSIONS", "Nothing was written. Fix the permissions of the .infra directory, then retry"); } }
  renameSync(tmp, file);
}

/** Removes temporary files left by an interrupted write. Returns their workspace-relative paths. */
export function cleanTemporaries(root: string): string[] {
  const base = join(root, INFRA_DIR);
  const out: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.\d+\.[0-9a-f]{8}\.tmp$/.test(n)) { rmSync(p, { force: true }); out.push(relTo(root, p)); } } };
  walk(base);
  return out;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * One provisioning at a time per workspace. A lock left by a process that no longer exists is taken over (and said so); a lock held by a
 * live process is a refusal, never a wait without end.
 */
export function withLock<T>(root: string, op: string, fn: (notes: string[]) => T): T {
  const { release, notes } = takeLock(root, op);
  try { return fn(notes); } finally { release(); }
}
/** The same lock around an asynchronous operation (held until the operation settles). */
export async function withLockAsync<T>(root: string, op: string, fn: (notes: string[]) => Promise<T>): Promise<T> {
  const { release, notes } = takeLock(root, op);
  try { return await fn(notes); } finally { release(); }
}
function takeLock(root: string, op: string): { release: () => void; notes: string[] } {
  const file = join(root, INFRA_DIR, "state.lock");
  mkdirSync(dirname(file), { recursive: true });
  const notes: string[] = [];
  const take = (): boolean => { try { writeFileSync(file, JSON.stringify({ pid: process.pid, op, at: new Date().toISOString() }), { flag: "wx" }); return true; } catch { return false; } };
  if (!take()) {
    let holder: { pid?: number; op?: string; at?: string } = {};
    try { holder = JSON.parse(readFileSync(file, "utf8")) as typeof holder; } catch { /* unreadable: treated as stale below */ }
    if (holder.pid && holder.pid !== process.pid && alive(holder.pid)) throw new InfraError(`another PSO process (pid ${holder.pid}, ${holder.op ?? "?"} since ${holder.at ?? "?"}) is changing this workspace's infrastructure`, "PSO_INFRA_LOCKED", "Wait for it to finish; nothing was changed");
    rmSync(file, { force: true });
    notes.push(`took over a stale lock left by pid ${holder.pid ?? "?"} (${holder.op ?? "unknown operation"}, ${holder.at ?? "unknown time"})`);
    if (!take()) throw new InfraError("the infrastructure lock could not be taken", "PSO_INFRA_LOCKED");
  }
  return { notes, release: () => rmSync(file, { force: true }) };
}

export interface JournalEntry { tx: string; op: string; resource: string; files: string[]; startedAt: string }
const journalDir = (root: string) => join(root, INFRA_DIR, "journal");

/** Records that a resource is being written; removed when the write completed. A leftover entry is an interrupted provisioning. */
export function journalBegin(root: string, e: Omit<JournalEntry, "startedAt">): () => void {
  const f = join(journalDir(root), `${e.tx}-${e.resource.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  atomicWrite(f, JSON.stringify({ ...e, startedAt: new Date().toISOString() }, null, 2));
  return () => rmSync(f, { force: true });
}
export function pendingJournal(root: string): JournalEntry[] {
  const d = journalDir(root);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => n.endsWith(".json")).flatMap((n) => { try { return [JSON.parse(readFileSync(join(d, n), "utf8")) as JournalEntry]; } catch { return []; } });
}
export function clearJournal(root: string): void { rmSync(journalDir(root), { recursive: true, force: true }); }
