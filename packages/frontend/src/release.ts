/**
 * Frontend releases on a site root. The ONE implementation of publishing, activating, rolling back, retaining and recovering frontend
 * releases: `pso frontend:publish` calls it directly and the native cloud deployment (the runtime agent) calls the same functions.
 *
 * A MEI or FEI release is a directory of immutable, content-hashed files plus a manifest. Publishing never overwrites a released
 * version and never deletes one; activation is one atomic write of a small pointer file, so browsers that already hold the previous
 * version's chunks keep working while new page loads see the new version, and a rollback is the same write in the other direction.
 *
 *   fei/<version>/                    an FEI release (index.html, assets/, pso-fei.json)
 *   fei/current.json                  {"version": "..."}  the active FEI release  (+ `fei/current`, a symlink, on POSIX)
 *   fei/history.json                  every FEI activation
 *   _mei/<name>/v/<version>/          a MEI release: remoteEntry.js, assets/, pso-manifest.json (signed or not)
 *   _mei/<name>/active.json           pointer to the active release (written atomically)
 *   _mei/<name>/history.json          every activation, newest last
 *   pso-runtime-config.json           the FEI's runtime configuration (remotes resolve through the pointers above)
 *
 * Browser-safe modules are imported from `./manifest.ts`; this file uses only `node:` modules (no TypeScript compiler), so the runtime
 * agent can bundle it.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { checkRemoteCompatibility, canonicalManifest, b64u, parseManifest, type FrontendRuntimeConfig, type RemoteManifest } from "./manifest.ts";

export class ReleaseRefused extends Error {
  readonly reasons: string[];
  constructor(message: string, reasons: string[] = []) { super(message); this.name = "ReleaseRefused"; this.reasons = reasons; }
}

export const POINTER_KIND = "pso-mei-pointer";
export interface MeiPointer { schema: 1; kind: typeof POINTER_KIND; name: string; version: string; manifest: string; manifestSha256: string; activatedAt: string }
export interface HistoryEntry { at: string; action: "publish" | "rollback"; version: string; previous: string | null; by?: string }
export interface FeiRelease { schema: 1; kind: "pso-fei-release"; name: string; version: string; contract: string; shared: Record<string, string>; mounts: Array<{ name: string; path: string }>; basePath: string; files: Array<{ path: string; sha256: string; size: number }>; createdAt: string }

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const atomicWrite = (file: string, text: string): void => { mkdirSync(join(file, ".."), { recursive: true }); const tmp = `${file}.tmp-${process.pid}-${Date.now()}`; writeFileSync(tmp, text); renameSync(tmp, file); };
const readJson = <T>(file: string): T | undefined => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; } };
function walk(dir: string, base = ""): string[] { const out: string[] = []; for (const n of readdirSync(dir).sort()) { const p = join(dir, n), r = base ? `${base}/${n}` : n; if (statSync(p).isDirectory()) out.push(...walk(p, r)); else out.push(r); } return out; }
const SAFE_NAME = /^[a-z][a-z0-9-]*$/, SAFE_VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const cmpVersion = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** Every path of a release must stay inside its directory: no `..`, no absolute paths, no links out. */
function inside(root: string, rel: string): string {
  const full = resolve(root, rel);
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw new ReleaseRefused(`path "${rel}" leaves the release directory`);
  return full;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// concurrency: one writer per site root

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const STALE_MS = 5 * 60_000;

/**
 * Runs `fn` while holding the site's lock. The registry files (pointers, history) are read-modify-write: two concurrent publishers must
 * not interleave. The lock is a directory created exclusively; one left by a dead process, or older than five minutes, is taken over.
 */
export function withSiteLock<T>(site: string, fn: () => T, waitMs = 20_000): T {
  mkdirSync(site, { recursive: true });
  const dir = join(site, ".pso-lock");
  const until = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(dir); writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() })); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const o = readJson<{ pid: number; at: number }>(join(dir, "owner.json"));
      if (!o || !alive(o.pid) || Date.now() - o.at > STALE_MS) { rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > until) throw new ReleaseRefused("another publish or activation holds this site", [`held by process ${o.pid}`]);
      sleepSync(40);
    }
  }
  try { return fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// reading the site

/** Checks that the files on disk are exactly the files (and hashes) the manifest names. */
export function verifyDist(dist: string, m: Pick<RemoteManifest, "files">, ignore: readonly string[] = ["pso-manifest.json"]): string[] {
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const f of m.files) {
    listed.add(f.path);
    let full: string;
    try { full = inside(dist, f.path); } catch (e) { problems.push((e as Error).message); continue; }
    if (!existsSync(full)) { problems.push(`${f.path}: listed in the manifest but missing`); continue; }
    const b = readFileSync(full);
    if (sha(b) !== f.sha256) problems.push(`${f.path}: content does not match its recorded hash`);
    if (b.length !== f.size) problems.push(`${f.path}: size differs from the manifest`);
  }
  for (const f of walk(dist)) if (!ignore.includes(f) && !listed.has(f)) problems.push(`${f}: present in the release but not listed in the manifest`);
  return problems;
}
function copyTree(from: string, to: string): void {
  for (const f of walk(from)) { const dest = join(to, ...f.split("/")); mkdirSync(join(dest, ".."), { recursive: true }); copyFileSync(join(from, ...f.split("/")), dest); }
}
function sameContent(dir: string, files: Array<{ path: string; sha256: string }>): boolean {
  return files.every((f) => { const p = join(dir, ...f.path.split("/")); return existsSync(p) && sha(readFileSync(p)) === f.sha256; });
}

export const runtimeConfigPath = (site: string): string => join(site, "pso-runtime-config.json");
export const readRuntimeConfig = (site: string): FrontendRuntimeConfig | undefined => readJson<FrontendRuntimeConfig>(runtimeConfigPath(site));
export function activeFei(site: string): FeiRelease | undefined {
  const cur = readJson<{ version: string }>(join(site, "fei", "current.json"));
  return cur ? readJson<FeiRelease>(join(site, "fei", cur.version, "pso-fei.json")) : undefined;
}
export const feiVersions = (site: string): string[] => { const d = join(site, "fei"); return existsSync(d) ? readdirSync(d).filter((v) => SAFE_VERSION.test(v)).sort(cmpVersion) : []; };
export const feiHistory = (site: string): HistoryEntry[] => readJson<HistoryEntry[]>(join(site, "fei", "history.json")) ?? [];
export const meiDir = (site: string, name: string): string => join(site, "_mei", name);
export const activePointer = (site: string, name: string): MeiPointer | undefined => readJson<MeiPointer>(join(meiDir(site, name), "active.json"));
export const history = (site: string, name: string): HistoryEntry[] => readJson<HistoryEntry[]>(join(meiDir(site, name), "history.json")) ?? [];
export function versions(site: string, name: string): string[] {
  const d = join(meiDir(site, name), "v");
  return existsSync(d) ? readdirSync(d).filter((v) => SAFE_VERSION.test(v)).sort(cmpVersion) : [];
}

function verifySignatureSync(m: RemoteManifest, keys: ReadonlyArray<{ keyId: string; publicKey: string }>): string | undefined {
  if (!m.signature) return "the release is not signed";
  const k = keys.find((x) => x.keyId === m.signature!.keyId);
  if (!k) return `signed with key "${m.signature.keyId}", which this site does not trust`;
  try {
    const raw = Buffer.from(b64u.decode(k.publicKey));
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const ok = edVerify(null, Buffer.from(canonicalManifest(m)), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(b64u.decode(m.signature.value)));
    return ok ? undefined : "the signature does not match the manifest";
  } catch (e) { return `signature check failed: ${(e as Error).message}`; }
}

/** The checks that must pass BEFORE a MEI release becomes active. Throws ReleaseRefused naming every reason. */
export function checkActivation(site: string, m: RemoteManifest, dir: string): void {
  const reasons: string[] = [];
  reasons.push(...verifyDist(dir, m));
  const fei = activeFei(site);
  if (!fei) reasons.push("no FEI release is active on this site: publish the FEI first (a MEI is checked against the host it will run in)");
  else reasons.push(...checkRemoteCompatibility(m, { name: m.name, host: fei.name }, { contract: fei.contract, shared: fei.shared }));
  const cfg = readRuntimeConfig(site);
  if (cfg?.requireSignature) { const r = verifySignatureSync(m, cfg.trustedKeys ?? []); if (r) reasons.push(r); }
  else if (m.signature && cfg?.trustedKeys?.length) { const r = verifySignatureSync(m, cfg.trustedKeys); if (r) reasons.push(r); }
  if (fei && cfg && cfg.fei !== fei.name) reasons.push(`the runtime configuration is for "${cfg.fei}" but the active FEI is "${fei.name}"`);
  if (reasons.length) throw new ReleaseRefused(`${m.name} ${m.version} was not activated`, reasons);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// MEI

function writePointer(site: string, name: string, version: string, action: HistoryEntry["action"], by?: string): MeiPointer {
  const vdir = join(meiDir(site, name), "v", version);
  const manifestText = readFileSync(join(vdir, "pso-manifest.json"));
  const prev = activePointer(site, name);
  const pointer: MeiPointer = { schema: 1, kind: POINTER_KIND, name, version, manifest: `v/${version}/pso-manifest.json`, manifestSha256: sha(manifestText), activatedAt: new Date().toISOString() };
  atomicWrite(join(meiDir(site, name), "active.json"), JSON.stringify(pointer, null, 2) + "\n"); // the one write that changes what users get
  const h = history(site, name);
  h.push({ at: pointer.activatedAt, action, version, previous: prev?.version ?? null, ...(by ? { by } : {}) });
  atomicWrite(join(meiDir(site, name), "history.json"), JSON.stringify(h, null, 2) + "\n");
  return pointer;
}

/** Copies a verified MEI release into its immutable version directory. Does not activate. Call inside the site lock. */
function stageMeiLocked(site: string, dist: string): RemoteManifest {
  const mpath = join(dist, "pso-manifest.json");
  if (!existsSync(mpath)) throw new ReleaseRefused(`${mpath} not found`, ["build the MEI first: pso frontend:build <mei>"]);
  const parsed = parseManifest(JSON.parse(readFileSync(mpath, "utf8")));
  if (!parsed.manifest) throw new ReleaseRefused("the release manifest is invalid", parsed.problems);
  const m = parsed.manifest;
  if (!SAFE_NAME.test(m.name) || !SAFE_VERSION.test(m.version)) throw new ReleaseRefused("invalid name or version in the manifest");
  const vdir = join(meiDir(site, m.name), "v", m.version);
  if (existsSync(vdir)) {
    const staged = readJson<RemoteManifest>(join(vdir, "pso-manifest.json"));
    if (!staged || !sameContent(vdir, m.files) || canonicalManifest(staged) !== canonicalManifest(m)) throw new ReleaseRefused(`${m.name} ${m.version} is already published with different content`, ["a published version is immutable: increase the version"]);
  } else {
    checkActivation(site, m, dist); // verify the SOURCE before anything is copied into the site
    const tmp = `${vdir}.staging-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    copyTree(dist, tmp);
    mkdirSync(join(vdir, ".."), { recursive: true });
    renameSync(tmp, vdir);
  }
  return m;
}

export interface PublishMeiOptions { site: string; dist: string; /** do not activate: stage the release only */ stage?: boolean; by?: string }
/** Stages (and, unless `stage`, activates) a built MEI release. Immutable: a published version never changes. */
export function publishMei(o: PublishMeiOptions): { manifest: RemoteManifest; activated: boolean; previous: string | null } {
  return withSiteLock(o.site, () => {
    const m = stageMeiLocked(o.site, o.dist);
    const previous = activePointer(o.site, m.name)?.version ?? null;
    if (o.stage) return { manifest: m, activated: false, previous };
    const vdir = join(meiDir(o.site, m.name), "v", m.version);
    checkActivation(o.site, m, vdir);
    writePointer(o.site, m.name, m.version, "publish", o.by);
    return { manifest: m, activated: true, previous };
  });
}

/** Activates an already staged version (the step after `publishMei({ stage: true })`), after the same checks. */
export function activateMei(site: string, name: string, version: string, by?: string): MeiPointer {
  return withSiteLock(site, () => {
    const vdir = join(meiDir(site, name), "v", version);
    const parsed = parseManifest(readJson(join(vdir, "pso-manifest.json")));
    if (!parsed.manifest) throw new ReleaseRefused(`${name} ${version} is not staged on this site`, parsed.problems);
    checkActivation(site, parsed.manifest, vdir);
    return writePointer(site, name, version, "publish", by);
  });
}

/** Re-points a MEI to an earlier published version, after the same checks (it must still be compatible with the active FEI). */
export function rollbackMei(site: string, name: string, to?: string, by?: string): { from: string | null; to: string } {
  return withSiteLock(site, () => {
    const cur = activePointer(site, name);
    const have = versions(site, name);
    let target = to;
    if (!target) target = [...history(site, name)].reverse().find((h) => h.version !== cur?.version && have.includes(h.version))?.version;
    if (!target) throw new ReleaseRefused(`${name} has no earlier release to return to`, [`published versions: ${have.join(", ") || "(none)"}`]);
    if (!have.includes(target)) throw new ReleaseRefused(`${name} ${target} is not published on this site`, [`published versions: ${have.join(", ") || "(none)"}`]);
    if (target === cur?.version) throw new ReleaseRefused(`${name} ${target} is already active`);
    const vdir = join(meiDir(site, name), "v", target);
    const parsed = parseManifest(readJson(join(vdir, "pso-manifest.json")));
    if (!parsed.manifest) throw new ReleaseRefused("the stored manifest is invalid", parsed.problems);
    checkActivation(site, parsed.manifest, vdir);
    writePointer(site, name, target, "rollback", by);
    return { from: cur?.version ?? null, to: target };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// FEI

/** Reads and verifies `pso-fei.json` of a built FEI (written by `pso frontend:build`): every file listed, with its hash. */
export function readFeiDist(dist: string): FeiRelease {
  const f = join(dist, "pso-fei.json");
  if (!existsSync(f)) throw new ReleaseRefused(`${f} not found`, ["build the FEI first: pso frontend:build <fei>"]);
  const rel = readJson<FeiRelease>(f);
  if (!rel || rel.kind !== "pso-fei-release" || !SAFE_NAME.test(rel.name) || !SAFE_VERSION.test(rel.version) || !Array.isArray(rel.files)) throw new ReleaseRefused("pso-fei.json is not a valid FEI release manifest");
  const problems = verifyDist(dist, rel, ["pso-fei.json"]);
  if (problems.length) throw new ReleaseRefused(`${rel.name} ${rel.version} does not match its manifest`, problems);
  return rel;
}

/**
 * Hashed assets of every shell release live in ONE content-addressed pool (`fei/assets/`) that nginx serves under the base path. A tab
 * that still runs the previous shell keeps resolving its lazy chunks after a new shell is activated, and one URL can never resolve to
 * two different contents (a name that exists with other bytes is refused, so only content-hashed names are accepted).
 */
function poolAssets(site: string, dist: string, rel: FeiRelease): void {
  const pool = join(site, "fei", "assets");
  for (const f of rel.files) {
    if (!f.path.startsWith("assets/")) continue;
    const dest = join(pool, f.path.slice("assets/".length));
    if (existsSync(dest)) { if (sha(readFileSync(dest)) !== f.sha256) throw new ReleaseRefused(`${f.path} already exists in the shared asset pool with different content`, ["shell assets must have content-hashed names (the production build produces them)"]); continue; }
    mkdirSync(join(dest, ".."), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`; copyFileSync(join(dist, ...f.path.split("/")), tmp); renameSync(tmp, dest);
  }
}

function stageFeiLocked(site: string, dist: string): FeiRelease {
  const rel = readFeiDist(dist);
  poolAssets(site, dist, rel);
  const vdir = join(site, "fei", rel.version);
  if (existsSync(vdir)) {
    const old = readJson<FeiRelease>(join(vdir, "pso-fei.json"));
    if (!old || !sameContent(vdir, rel.files)) throw new ReleaseRefused(`${rel.name} ${rel.version} is already published with different content`, ["a published version is immutable: increase the version"]);
  } else {
    const tmp = `${vdir}.staging-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    copyTree(dist, tmp);
    mkdirSync(join(vdir, ".."), { recursive: true });
    renameSync(tmp, vdir);
  }
  return rel;
}

function writeFeiPointer(site: string, version: string, action: HistoryEntry["action"], by?: string): void {
  const prev = readJson<{ version: string }>(join(site, "fei", "current.json"))?.version ?? null;
  atomicWrite(join(site, "fei", "current.json"), JSON.stringify({ version, activatedAt: new Date().toISOString() }, null, 2) + "\n");
  // POSIX: also keep the `current` symlink the generated nginx configuration serves from (create-then-rename, so it is never absent)
  try { const link = join(site, "fei", "current"), tmp = `${link}.tmp-${process.pid}`; rmSync(tmp, { force: true }); symlinkSync(version, tmp, "dir"); renameSync(tmp, link); } catch { /* Windows without privilege: current.json is the pointer */ }
  const h = feiHistory(site); h.push({ at: new Date().toISOString(), action, version, previous: prev, ...(by ? { by } : {}) });
  atomicWrite(join(site, "fei", "history.json"), JSON.stringify(h, null, 2) + "\n");
}

/** Copies a verified FEI release into `fei/<version>` without activating it. */
export function stageFei(site: string, dist: string): FeiRelease { return withSiteLock(site, () => stageFeiLocked(site, dist)); }
/** Makes a staged FEI version the active one (also the way back after a failed verification or a rollback). */
export function activateFei(site: string, version: string, action: HistoryEntry["action"] = "publish", by?: string): void {
  withSiteLock(site, () => {
    if (!SAFE_VERSION.test(version) || !existsSync(join(site, "fei", version, "pso-fei.json"))) throw new ReleaseRefused(`FEI ${version} is not staged on this site`);
    writeFeiPointer(site, version, action, by);
  });
}
export interface PublishFeiOptions { site: string; dist: string; by?: string }
/** Stages and activates a built FEI release. */
export function publishFei(o: PublishFeiOptions): FeiRelease {
  return withSiteLock(o.site, () => { const rel = stageFeiLocked(o.site, o.dist); writeFeiPointer(o.site, rel.version, "publish", o.by); return rel; });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// retention and recovery

/**
 * Removes old MEI versions, keeping the newest `keep` plus the active version and the one it replaced (the rollback target), always.
 * Browsers that loaded a version a moment ago may still need its files, so the minimum is two. Returns the versions removed.
 */
export function pruneMei(site: string, name: string, keep: number): string[] {
  return withSiteLock(site, () => {
    const n = Math.max(2, Math.floor(keep));
    const have = versions(site, name);
    const active = activePointer(site, name)?.version;
    const h = history(site, name);
    const previous = [...h].reverse().find((x) => x.version !== active)?.version;
    const protectedSet = new Set([active, previous].filter((x): x is string => !!x));
    const newest = [...have].reverse().slice(0, n);
    const keepSet = new Set([...protectedSet, ...newest]);
    const removed: string[] = [];
    for (const v of have) if (!keepSet.has(v)) { rmSync(join(meiDir(site, name), "v", v), { recursive: true, force: true }); removed.push(v); }
    return removed;
  });
}
export function pruneFei(site: string, keep: number): string[] {
  return withSiteLock(site, () => {
    const n = Math.max(2, Math.floor(keep));
    const have = feiVersions(site);
    const active = readJson<{ version: string }>(join(site, "fei", "current.json"))?.version;
    const previous = [...feiHistory(site)].reverse().find((x) => x.version !== active)?.version;
    const keepSet = new Set([active, previous, ...[...have].reverse().slice(0, n)].filter((x): x is string => !!x));
    const removed: string[] = [];
    for (const v of have) if (!keepSet.has(v)) { rmSync(join(site, "fei", v), { recursive: true, force: true }); removed.push(v); }
    // the pool keeps what any retained release still references, and nothing else
    const referenced = new Set<string>();
    for (const v of feiVersions(site)) for (const f of readJson<FeiRelease>(join(site, "fei", v, "pso-fei.json"))?.files ?? []) if (f.path.startsWith("assets/")) referenced.add(f.path.slice("assets/".length));
    const pool = join(site, "fei", "assets");
    if (existsSync(pool)) for (const f of walk(pool)) if (!referenced.has(f) && !/\.tmp-\d+-\d+$/.test(f)) rmSync(join(pool, ...f.split("/")), { force: true });
    return removed;
  });
}

export interface SiteReport { removed: string[]; problems: string[] }
/**
 * Brings a site root back to a consistent state after an interrupted publish or activation: leftover staging directories and temporary
 * files are removed, and every pointer is checked against the files it names. Pointers are never edited here: they only change through
 * an activation, so a problem is reported for the operator rather than papered over.
 */
export function recoverSite(site: string): SiteReport {
  return withSiteLock(site, () => {
    const removed: string[] = [], problems: string[] = [];
    const sweep = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (/\.staging-\d+$/.test(n) || /\.tmp-\d+-\d+$/.test(n)) { rmSync(p, { recursive: true, force: true }); removed.push(p.slice(site.length + 1).split(sep).join("/")); continue; }
        if (statSync(p).isDirectory() && n !== "node_modules") sweep(p);
      }
    };
    sweep(join(site, "fei")); sweep(join(site, "_mei"));
    for (const name of existsSync(join(site, "_mei")) ? readdirSync(join(site, "_mei")) : []) problems.push(...checkMei(site, name));
    const cur = readJson<{ version: string }>(join(site, "fei", "current.json"));
    if (cur && !existsSync(join(site, "fei", cur.version, "pso-fei.json"))) problems.push(`fei/current.json names ${cur.version}, which is not on the site`);
    return { removed, problems };
  });
}

/** Consistency of one MEI: pointer, manifest hash, files and history agree. */
export function checkMei(site: string, name: string): string[] {
  const out: string[] = [];
  const p = activePointer(site, name);
  if (!p) return existsSync(join(meiDir(site, name), "v")) && versions(site, name).length ? [`${name}: published versions exist but there is no active pointer`] : [];
  const mpath = join(meiDir(site, name), p.manifest);
  if (!existsSync(mpath)) return [`${name}: the active pointer names ${p.version}, whose manifest is missing`];
  if (sha(readFileSync(mpath)) !== p.manifestSha256) out.push(`${name}: the manifest of ${p.version} does not match the hash its pointer records`);
  const parsed = parseManifest(readJson(mpath));
  if (!parsed.manifest) out.push(`${name}: the manifest of ${p.version} is invalid`);
  else for (const prob of verifyDist(join(meiDir(site, name), "v", p.version), parsed.manifest)) out.push(`${name} ${p.version}: ${prob}`);
  const last = history(site, name).at(-1);
  if (last && last.version !== p.version) out.push(`${name}: the history ends at ${last.version} but ${p.version} is active (an activation was interrupted between its two writes)`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// runtime configuration and nginx

export interface RuntimeConfigOptions { site: string; fei: string; auth: NonNullable<FrontendRuntimeConfig["auth"]>; orchestratorBasePath: string; channelsPath?: string; requireSignature?: boolean; trustedKeys?: Array<{ keyId: string; publicKey: string }>; meis: string[] }
/** The runtime configuration the FEI loads at start: where each approved remote's pointer is, who may sign them, how users sign in. */
export function writeRuntimeConfig(o: RuntimeConfigOptions): FrontendRuntimeConfig {
  const cfg: FrontendRuntimeConfig = {
    schema: 1, fei: o.fei, mode: "production",
    orchestrator: { basePath: o.orchestratorBasePath, ...(o.channelsPath ? { channelsPath: o.channelsPath } : {}) },
    remotes: Object.fromEntries(o.meis.map((n) => [n, { manifest: `/_mei/${n}/active.json` }])),
    ...(o.trustedKeys?.length ? { trustedKeys: o.trustedKeys } : {}), ...(o.requireSignature ? { requireSignature: true } : {}), auth: o.auth,
  };
  atomicWrite(runtimeConfigPath(o.site), JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

export * from "./nginx.ts";
export { SHARED_SINGLETONS, installedVersions } from "./shared-versions.ts";

/**
 * Completes an activation that was interrupted between its two writes (the pointer moved, the history entry was not appended). The pointer is
 * the truth: only the history is brought in line with it, and only when the active version itself verifies (hash, manifest and files).
 * Returns true when a history entry was added.
 */
export function repairMeiHistory(site: string, name: string, by?: string): boolean {
  return withSiteLock(site, () => {
    const p = activePointer(site, name); if (!p) return false;
    const last = history(site, name).at(-1);
    if (last?.version === p.version) return false;
    const other = checkMei(site, name).filter((x) => !x.includes("the history ends at"));
    if (other.length) throw new ReleaseRefused(`${name}: the active version does not verify, so the history is not repaired (${other[0]})`);
    const h = history(site, name);
    h.push({ at: new Date().toISOString(), action: "publish", version: p.version, previous: last?.version ?? null, ...(by ? { by } : {}) });
    atomicWrite(join(meiDir(site, name), "history.json"), JSON.stringify(h, null, 2) + "\n");
    return true;
  });
}

/** The same for the shell: `fei/current.json` is the truth, `fei/history.json` is brought in line when its last entry is not the active version. */
export function repairFeiHistory(site: string, by?: string): boolean {
  return withSiteLock(site, () => {
    const cur = readJson<{ version: string }>(join(site, "fei", "current.json")); if (!cur) return false;
    if (!existsSync(join(site, "fei", cur.version, "pso-fei.json"))) throw new ReleaseRefused(`fei/current.json names ${cur.version}, which is not on the site: the history is not repaired`);
    const h = feiHistory(site); const last = h.at(-1);
    if (last?.version === cur.version) return false;
    h.push({ at: new Date().toISOString(), action: "publish", version: cur.version, previous: last?.version ?? null, ...(by ? { by } : {}) });
    atomicWrite(join(site, "fei", "history.json"), JSON.stringify(h, null, 2) + "\n");
    return true;
  });
}
