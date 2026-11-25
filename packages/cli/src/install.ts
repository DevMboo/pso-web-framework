import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { walkFiles } from "@pso/core";
import { PsopkgError, extractPackage, fingerprintOf, readHeader, verifyPackage, type FileEntry, type Header, type TrustedKey } from "./psopkg.ts";

/**
 * A PSO installation managed from authenticated .psopkg packages.
 *
 *   <root>/.pso-install/install.json            what is installed: current and previous version, one record per version
 *   <root>/.pso-install/inventory-<ver>.json    the signed package header (so the inventory is authenticated without keeping the payload)
 *   <root>/.pso-install/packages/<ver>.psopkg   the authenticated package, kept for repair
 *   <root>/.pso-install/trust/*.public.pem      public keys of the signers this installation accepts
 *   <root>/versions/<ver>/...                   the files of each version, side by side
 *   <root>/config, cache, logs                  owned by PSO but user data: standard uninstall and repair never touch them
 * Every destructive step works from the inventory: a path that is not in it is never removed. Nothing here follows links.
 */
export class InstallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "InstallError"; this.code = code; }
}

const META = ".pso-install";
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const lstatSafe = (p: string): ReturnType<typeof lstatSync> | undefined => { try { return lstatSync(p); } catch { return undefined; } };

export interface VersionRecord { version: string; installedAt: string; inventory: string; package: string; signer: string }
export interface InstallState { schema: 1; product: "pso"; current: string | null; previous: string | null; versions: VersionRecord[]; sequence: number }
interface Inventory { schema: 1; headerBase64: string; payloadSha256: string; signatureBase64: string; installedAt: string }

// ---------------------------------------------------------------- root safety
/** A root PSO may write to: an absolute directory that is not a drive root, the home directory, a system directory or a link. */
export function checkRoot(root: string, o: { mustExist: boolean }): string {
  const abs = resolve(root);
  const p = parsePath(abs);
  if (abs === p.root) throw new InstallError("INSTALL_ROOT", "refusing to use a file system root as the installation root");
  const home = resolve(homedir());
  const forbidden = [home, "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "/usr", "/bin", "/etc", "/var", "/opt"].map((x) => resolve(x).toLowerCase());
  if (forbidden.includes(abs.toLowerCase())) throw new InstallError("INSTALL_ROOT", "refusing to use a system or home directory as the installation root; choose a dedicated directory");
  const st = lstatSafe(abs);
  if (st?.isSymbolicLink()) throw new InstallError("INSTALL_ROOT", "the installation root is a link; refusing to operate through it");
  if (o.mustExist && !existsSync(join(abs, META, "install.json"))) throw new InstallError("INSTALL_NOT_FOUND", `no PSO installation at ${abs} (missing ${META}/install.json)`);
  return abs;
}

function readState(root: string): InstallState {
  try {
    const s = JSON.parse(readFileSync(join(root, META, "install.json"), "utf8")) as InstallState;
    if (s.schema !== 1 || s.product !== "pso" || !Array.isArray(s.versions)) throw new Error("shape");
    return s;
  } catch { throw new InstallError("INSTALL_STATE", "the installation state is missing or corrupted (install.json); repair needs a package: pso repair --package <file>"); }
}
function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
const writeState = (root: string, s: InstallState): void => atomicWrite(join(root, META, "install.json"), JSON.stringify(s, null, 2));

export function loadTrust(root: string): TrustedKey[] {
  const dir = join(root, META, "trust");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".public.pem")).map((f) => { const pem = readFileSync(join(dir, f), "utf8"); return { id: fingerprintOf(pem), publicKeyPem: pem }; });
}

// ---------------------------------------------------------------- install
// ---------------------------------------------------------------- interrupted operations
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/**
 * A killed or crashed installation or repair leaves a staging directory with DECRYPTED files behind. Removing those leftovers is the first
 * thing any later operation does, unless the process that owns one is still running. Deletion is not forensic erasure: file system journals,
 * backups and snapshots may still hold copies.
 */
export function recoverInterrupted(rootArg: string): { removed: string[] } {
  const root = resolve(rootArg), removed: string[] = [];
  const sweep = (dir: string, re: RegExp): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const m = re.exec(n);
      if (!m || alive(Number(m[1]))) continue;
      const p = join(dir, n);
      if (lstatSafe(p)?.isSymbolicLink()) { try { unlinkSync(p); removed.push(n); } catch { /* leave it */ } continue; }
      rmTree(p);
      if (!existsSync(p)) removed.push(n);
    }
  };
  sweep(join(root, "versions"), /^\.staging-.+-(\d+)$/);
  sweep(join(root, META), /^repair-(\d+)-\d+$/);
  return { removed };
}

export interface InstallOptions { root: string; packageFile: string; trustedKeys: TrustedKey[]; recipientKeyPem?: string; recipientKeyProvider?: () => string; activate?: boolean }

/** Verifies completely, extracts into a staging directory, writes the inventory, then publishes the version with renames. Failure leaves the previous state untouched. */
export function installPackage(o: InstallOptions): { version: string; files: number; activated: boolean } {
  const root = checkRoot(o.root, { mustExist: false });
  recoverInterrupted(root);
  const buf = readFileSync(o.packageFile);
  const { header, signer } = readHeader(buf, o.trustedKeys); // signature first
  const dir = join(root, "versions", header.version);
  if (existsSync(dir)) throw new InstallError("INSTALL_EXISTS", `version ${header.version} is already installed (kept side by side); \`pso update rollback\` switches to it when it is the previous version, \`pso repair --full\` restores it when it is damaged`);
  mkdirSync(join(root, META, "trust"), { recursive: true });
  const staging = join(root, "versions", `.staging-${header.version}-${process.pid}`);
  try {
    extractPackage(buf, staging, { trustedKeys: o.trustedKeys, ...(o.recipientKeyPem ? { recipientKeyPem: o.recipientKeyPem } : {}), ...(o.recipientKeyProvider ? { recipientKeyProvider: o.recipientKeyProvider } : {}) });
    const full = o.trustedKeys.find((k) => k.id === signer);
    if (full) writeFileSync(join(root, META, "trust", `${signer}.public.pem`), full.publicKeyPem);
    mkdirSync(join(root, META, "packages"), { recursive: true });
    copyFileSync(o.packageFile, join(root, META, "packages", `${header.version}.psopkg`));
    atomicWrite(join(root, META, `inventory-${header.version}.json`), JSON.stringify(inventoryOf(buf), null, 2));
    renameSync(staging, dir);
  } catch (e) {
    rmTree(staging);
    throw e;
  }
  let state: InstallState;
  try { state = readState(root); } catch { state = { schema: 1, product: "pso", current: null, previous: null, versions: [], sequence: 0 }; }
  state.versions.push({ version: header.version, installedAt: new Date().toISOString(), inventory: `inventory-${header.version}.json`, package: `packages/${header.version}.psopkg`, signer });
  const activate = o.activate !== false;
  if (activate) { state.previous = state.current; state.current = header.version; }
  state.sequence++;
  writeState(root, state);
  return { version: header.version, files: header.files.length, activated: activate };
}

function inventoryOf(pkg: Buffer): Inventory {
  const headerLen = pkg.readUInt32BE(8);
  const headerBytes = pkg.subarray(12, 12 + headerLen);
  const payloadLen = Number(pkg.readBigUInt64BE(12 + headerLen));
  const payload = pkg.subarray(12 + headerLen + 8, 12 + headerLen + 8 + payloadLen);
  const signature = pkg.subarray(pkg.length - 64);
  return { schema: 1, headerBase64: headerBytes.toString("base64"), payloadSha256: sha256(payload), signatureBase64: signature.toString("base64"), installedAt: new Date().toISOString() };
}

/** The authenticated header of an installed version: the signature is checked against the installation's trusted keys every time. */
export function loadInventory(root: string, version: string, trusted: TrustedKey[]): Header {
  const rec = readState(root).versions.find((v) => v.version === version);
  if (!rec) throw new InstallError("INSTALL_VERSION", `version ${version} is not installed`);
  let inv: Inventory;
  try { inv = JSON.parse(readFileSync(join(root, META, rec.inventory), "utf8")) as Inventory; } catch { throw new InstallError("INVENTORY_MISSING", `the inventory of ${version} is missing or unreadable`); }
  const headerBytes = Buffer.from(inv.headerBase64, "base64");
  const input = Buffer.concat([Buffer.from("PSOPKG1\0"), createHash("sha256").update(headerBytes).digest(), Buffer.from(inv.payloadSha256, "hex")]);
  const ok = trusted.some((k) => { try { return edVerify(null, input, createPublicKey(k.publicKeyPem), Buffer.from(inv.signatureBase64, "base64")); } catch { return false; } });
  if (!ok) throw new InstallError("INVENTORY_SIGNATURE", `the inventory of ${version} is not signed by a trusted key (it was modified, or the trust store changed)`);
  return JSON.parse(headerBytes.toString("utf8")) as Header;
}

// ---------------------------------------------------------------- integrity
export type FileState = "ok" | "missing" | "size-mismatch" | "hash-mismatch" | "not-a-file";
export interface IntegrityReport {
  root: string; version: string | null; mode: "quick" | "full"; ok: boolean;
  checks: Array<{ name: string; status: "ok" | "failed" | "not-checked"; detail: string }>;
  files: { total: number; ok: number; damaged: Array<{ path: string; state: FileState }>; unexpected: string[] };
}

export function integrityCheck(rootArg: string, o: { full: boolean; trustedKeys?: TrustedKey[]; version?: string }): IntegrityReport {
  const root = checkRoot(rootArg, { mustExist: true });
  const state = readState(root);
  const trusted = o.trustedKeys?.length ? o.trustedKeys : loadTrust(root);
  const checks: IntegrityReport["checks"] = [];
  const target = o.version ?? state.current;
  const report: IntegrityReport = { root, version: target, mode: o.full ? "full" : "quick", ok: false, checks, files: { total: 0, ok: 0, damaged: [], unexpected: [] } };
  checks.push({ name: "installation state", status: "ok", detail: `install.json lists ${state.versions.length} version(s)` });
  if (!target) { checks.push({ name: "current version", status: "failed", detail: "no version is active" }); return report; }
  let header: Header;
  try { header = loadInventory(root, target, trusted); checks.push({ name: "inventory signature", status: "ok", detail: `signed by a trusted key; ${header.files.length} file(s)` }); }
  catch (e) { checks.push({ name: "inventory signature", status: "failed", detail: (e as Error).message }); return report; }
  if (header.version !== target) checks.push({ name: "version", status: "failed", detail: `the inventory is for ${header.version} but ${target} was checked` });
  else checks.push({ name: "version", status: "ok", detail: target });
  const dir = join(root, "versions", target);
  const known = new Set<string>();
  for (const f of header.files) {
    known.add(f.path);
    report.files.total++;
    const s = fileState(dir, f, o.full);
    if (s === "ok") report.files.ok++; else report.files.damaged.push({ path: f.path, state: s });
  }
  if (existsSync(dir)) {
    const walked = walkFiles(dir, { symlinks: "skip" });
    for (const f of walked.files) { const rel = relative(dir, f).split(sep).join("/"); if (!known.has(rel)) report.files.unexpected.push(rel); }
  }
  checks.push({ name: o.full ? "file hashes (SHA-256)" : "file presence and size", status: report.files.damaged.length ? "failed" : "ok", detail: report.files.damaged.length ? `${report.files.damaged.length} of ${report.files.total} file(s) damaged` : `${report.files.ok} of ${report.files.total} file(s) intact` });
  checks.push({ name: "unexpected files", status: report.files.unexpected.length ? "not-checked" : "ok", detail: report.files.unexpected.length ? `${report.files.unexpected.length} file(s) in the version directory are not in the inventory (informational; reported, never deleted)` : "none" });
  const rec = state.versions.find((v) => v.version === target);
  const cached = rec ? join(root, META, rec.package) : "";
  checks.push({ name: "repair source", status: rec && existsSync(cached) ? "ok" : "failed", detail: rec && existsSync(cached) ? "the authenticated package is cached" : "no cached package: repair will need --package" });
  for (const integ of ((header.installRules as { integrations?: Array<{ type: string; value: string }> }).integrations ?? [])) {
    if (integ.type === "shim") checks.push({ name: `shim ${integ.value}`, status: existsSync(join(dir, integ.value)) ? "ok" : "failed", detail: existsSync(join(dir, integ.value)) ? "present in the version directory" : "missing" });
    else if (integ.type === "path") {
      const entry = resolve(dir, integ.value).toLowerCase();
      const inPath = (process.env["PATH"] ?? "").split(process.platform === "win32" ? ";" : ":").some((p) => p && resolve(p).toLowerCase() === entry);
      checks.push({ name: `PATH entry ${integ.value}`, status: inPath ? "ok" : "not-checked", detail: inPath ? "present in this process's PATH" : "not visible in this process's PATH (a new terminal may be needed; the persistent value is not read)" });
    } else checks.push({ name: `${integ.type} ${integ.value}`, status: "not-checked", detail: "this check type is not implemented" });
  }
  report.ok = checks.every((c) => c.status !== "failed");
  return report;
}

function fileState(dir: string, f: FileEntry, full: boolean): FileState {
  const p = join(dir, ...f.path.split("/"));
  const st = lstatSafe(p);
  if (!st) return "missing";
  if (!st.isFile()) return "not-a-file";
  if (st.size !== f.size) return "size-mismatch";
  if (full && sha256(readFileSync(p)) !== f.sha256) return "hash-mismatch";
  return "ok";
}

// ---------------------------------------------------------------- repair
export interface RepairResult { version: string; mode: "quick" | "full"; dryRun: boolean; repaired: string[]; unchanged: number; unexpected: string[]; source: string }

/** Restores damaged files of the INSTALLED version from an authenticated package of the same version. It never upgrades and never touches user data. */
export function repair(rootArg: string, o: { full: boolean; dryRun: boolean; packageFile?: string; recipientKeyPem?: string; recipientKeyProvider?: () => string; trustedKeys?: TrustedKey[] }): RepairResult {
  const root = checkRoot(rootArg, { mustExist: true });
  const state = readState(root);
  if (!state.current) throw new InstallError("INSTALL_STATE", "no active version to repair");
  const trusted = o.trustedKeys?.length ? o.trustedKeys : loadTrust(root);
  const header = loadInventory(root, state.current, trusted);
  const dir = join(root, "versions", state.current);
  const damaged = header.files.map((f) => ({ f, s: fileState(dir, f, o.full) })).filter((x) => x.s !== "ok");
  const unexpected = existsSync(dir) ? walkFiles(dir, { symlinks: "skip" }).files.map((f) => relative(dir, f).split(sep).join("/")).filter((r) => !header.files.some((f) => f.path === r)) : [];
  const rec = state.versions.find((v) => v.version === state.current)!;
  const source = o.packageFile ?? join(root, META, rec.package);
  const result: RepairResult = { version: state.current, mode: o.full ? "full" : "quick", dryRun: o.dryRun, repaired: damaged.map((d) => d.f.path), unchanged: header.files.length - damaged.length, unexpected, source: o.packageFile ? "the package given" : "the cached package" };
  if (damaged.length === 0 || o.dryRun) return result;
  if (!existsSync(source)) throw new InstallError("REPAIR_SOURCE", "there is no authenticated package to repair from: pass --package <file>");
  const buf = readFileSync(source);
  const srcHeader = readHeader(buf, trusted).header; // authenticity first
  if (srcHeader.version !== state.current) throw new InstallError("REPAIR_VERSION", `the package is version ${srcHeader.version} but ${state.current} is installed; repair restores the installed version and never upgrades`);
  if (sha256(Buffer.from(JSON.stringify(srcHeader.files))) !== sha256(Buffer.from(JSON.stringify(header.files)))) throw new InstallError("REPAIR_SOURCE", "the package does not contain the same files as the installed inventory");
  // complete verification and extraction into a scratch directory next to the installation (same volume), then swap file by file with backups
  const scratch = join(root, META, `repair-${process.pid}-${Date.now()}`);
  const backup = join(scratch, "backup");
  try {
    extractPackage(buf, join(scratch, "new"), { trustedKeys: trusted, ...(o.recipientKeyPem ? { recipientKeyPem: o.recipientKeyPem } : {}), ...(o.recipientKeyProvider ? { recipientKeyProvider: o.recipientKeyProvider } : {}) });
    mkdirSync(backup, { recursive: true });
    atomicWrite(join(root, META, "journal.json"), JSON.stringify({ operation: "repair", version: state.current, scratch: relative(root, scratch), startedAt: new Date().toISOString() }));
    const swapped: Array<{ target: string; saved: string | null }> = [];
    try {
      for (const d of damaged) {
        const target = join(dir, ...d.f.path.split("/"));
        const fresh = join(scratch, "new", ...d.f.path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        const st = lstatSafe(target);
        let saved: string | null = null;
        if (st) {
          if (st.isSymbolicLink() || st.isDirectory()) throw new InstallError("REPAIR_BLOCKED", `"${d.f.path}" is a link or a directory; refusing to replace it automatically`);
          saved = join(backup, `${swapped.length}.bak`);
          renameSync(target, saved);
        }
        swapped.push({ target, saved });
        renameSync(fresh, target);
      }
    } catch (e) {
      for (const s of swapped.reverse()) { try { rmSync(s.target, { force: true }); if (s.saved) renameSync(s.saved, s.target); } catch { /* best effort */ } } // roll back
      throw e;
    }
  } finally {
    rmTree(scratch);
    try { unlinkSync(join(root, META, "journal.json")); } catch { /* none */ }
  }
  return result;
}

// ---------------------------------------------------------------- uninstall
export type UninstallMode = "standard" | "complete" | "purge";
export interface UninstallResult { mode: UninstallMode; removedFiles: number; removedDirs: number; residual: Array<{ path: string; reason: string }>; preserved: string[]; purgedProjects: string[] }

/** Removes exactly what the inventories list (and, in complete mode, the directories PSO owns). Anything else is reported as residual, never deleted. */
export function uninstall(rootArg: string, o: { mode: UninstallMode; purgeProjects?: string[]; confirmPaths?: string[]; trustedKeys?: TrustedKey[] }): UninstallResult {
  const root = checkRoot(rootArg, { mustExist: true });
  const state = readState(root);
  const trusted = o.trustedKeys?.length ? o.trustedKeys : loadTrust(root);
  const res: UninstallResult = { mode: o.mode, removedFiles: 0, removedDirs: 0, residual: [], preserved: [], purgedProjects: [] };
  // projects are validated BEFORE anything is removed, so a refused purge leaves the installation intact
  const projects: string[] = [];
  if (o.mode === "purge") {
    for (const p of o.purgeProjects ?? []) projects.push(validatePurgeTarget(p, root, o.confirmPaths ?? []));
    if (projects.length === 0) throw new InstallError("PURGE_NONE", "--purge removes projects only when each one is named with --project <dir> and confirmed with --confirm <exact same path>");
  }
  atomicWrite(join(root, META, "journal.json"), JSON.stringify({ operation: "uninstall", mode: o.mode, startedAt: new Date().toISOString() }));
  const dirs = new Set<string>();
  for (const v of state.versions) {
    let files: FileEntry[] = [];
    try { files = loadInventory(root, v.version, trusted).files; }
    catch (e) { res.residual.push({ path: `versions/${v.version}`, reason: `not removed: its inventory cannot be authenticated (${(e as Error).message.slice(0, 80)})` }); continue; }
    for (const f of files) {
      const p = join(root, "versions", v.version, ...f.path.split("/"));
      removeOwned(p, res);
      dirs.add(dirname(p));
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) removeEmptyDirsUpTo(d, join(root, "versions"), res);
  for (const v of state.versions) removeEmptyDirsUpTo(join(root, "versions", v.version), root, res);
  removeEmptyDirsUpTo(join(root, "versions"), root, res);
  if (o.mode === "standard") {
    for (const keep of ["config", "cache", "logs"]) if (existsSync(join(root, keep))) res.preserved.push(keep);
    atomicWrite(join(root, META, "install.json"), JSON.stringify({ ...state, current: null, previous: null, versions: [] }, null, 2));
  } else {
    for (const owned of ["config", "cache", "logs"]) removeTreeFileByFile(join(root, owned), res);
    removeTreeFileByFile(join(root, META), res); // inventories, trust store, cached packages, state
    removeEmptyDirsUpTo(root, dirname(root), res, true);
  }
  for (const p of projects) { removeTreeFileByFile(p, res); res.purgedProjects.push(p); }
  try { unlinkSync(join(root, META, "journal.json")); } catch { /* removed with META or never written */ }
  return res;
}

function validatePurgeTarget(p: string, root: string, confirmed: string[]): string {
  const abs = resolve(p);
  const st = lstatSafe(abs);
  if (!st) throw new InstallError("PURGE_PATH", `project path does not exist: ${abs}`);
  if (st.isSymbolicLink()) throw new InstallError("PURGE_PATH", `${abs} is a link; refusing to delete through it`);
  if (!st.isDirectory()) throw new InstallError("PURGE_PATH", `${abs} is not a directory`);
  if (!confirmed.some((c) => resolve(c).toLowerCase() === abs.toLowerCase())) throw new InstallError("PURGE_CONFIRM", `confirm the exact path to delete: --confirm ${abs}`);
  const real = realpathSafe(abs);
  const home = resolve(homedir()).toLowerCase();
  const r = root.toLowerCase();
  if (real === parsePath(real).root || real.toLowerCase() === home || r.startsWith(real.toLowerCase() + sep) || real.toLowerCase().startsWith(r + sep) || real.toLowerCase() === r) throw new InstallError("PURGE_PATH", `${abs} is the file system root, the home directory, or contains / is inside the PSO installation`);
  if (!existsSync(join(abs, "pso.workspace.json")) && !existsSync(join(abs, "pso.config.json"))) throw new InstallError("PURGE_PATH", `${abs} does not look like a PSO project (no pso.workspace.json or pso.config.json); refusing to delete it`);
  return abs;
}
function realpathSafe(p: string): string { try { return realpathSync(p); } catch { return resolve(p); } }

function removeOwned(p: string, res: UninstallResult): void {
  const st = lstatSafe(p);
  if (!st) return;
  try {
    if (st.isSymbolicLink() || st.isFile()) { unlinkSync(p); res.removedFiles++; }   // a link is removed itself, never followed
    else res.residual.push({ path: p, reason: "listed as a file but is a directory on disk; left in place" });
  } catch (e) { res.residual.push({ path: p, reason: (e as NodeJS.ErrnoException).code === "EBUSY" || (e as NodeJS.ErrnoException).code === "EPERM" ? "locked by a running process" : `could not be removed (${(e as NodeJS.ErrnoException).code ?? "error"})` }); }
}
function removeEmptyDirsUpTo(dir: string, stop: string, res: UninstallResult, includeStop = false): void {
  let cur = dir;
  while (cur.toLowerCase().startsWith(stop.toLowerCase()) && (includeStop || cur.toLowerCase() !== stop.toLowerCase())) {
    const st = lstatSafe(cur);
    if (!st) { cur = dirname(cur); continue; }
    if (st.isSymbolicLink()) { try { unlinkSync(cur); } catch { try { rmdirSync(cur); } catch { /* leave it */ } } return; }
    try { rmdirSync(cur); res.removedDirs++; } catch { return; } // not empty: stop (whatever is inside is not ours to delete)
    cur = dirname(cur);
  }
}
/** Deletes a directory tree one entry at a time with lstat, so a link inside it is removed as a link and never followed. */
function removeTreeFileByFile(dir: string, res: UninstallResult): void {
  const st = lstatSafe(dir);
  if (!st) return;
  if (st.isSymbolicLink()) { try { unlinkSync(dir); res.removedFiles++; } catch { try { rmdirSync(dir); res.removedDirs++; } catch { res.residual.push({ path: dir, reason: "link could not be removed" }); } } return; }
  if (!st.isDirectory()) { removeOwned(dir, res); return; }
  for (const name of readdirSync(dir)) removeTreeFileByFile(join(dir, name), res);
  try { rmdirSync(dir); res.removedDirs++; } catch { res.residual.push({ path: dir, reason: "directory not empty or in use" }); }
}
function rmTree(dir: string): void { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on our own scratch/staging */ } }

export { readState as installState };
