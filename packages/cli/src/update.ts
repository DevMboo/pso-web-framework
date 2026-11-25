import { createHash, createPublicKey, sign as edSign, verify as edVerify, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { InstallError, checkRoot, installPackage, installState, integrityCheck, loadTrust } from "./install.ts";
import { fingerprintOf, readHeader, type TrustedKey } from "./psopkg.ts";

/**
 * Secure updates for a PSO installation.
 *  - A catalog is a JSON document signed with Ed25519. It carries an expiry and a monotonically increasing sequence number, so an old, signed
 *    catalog cannot be replayed to push someone back to a vulnerable release.
 *  - A package named by the catalog is accepted only if its size and SHA-256 match the (signed) catalog AND its own signature verifies against
 *    the installation's trusted keys. Nothing unsigned is ever installed.
 *  - The new version is installed side by side, fully verified, and only then activated by switching one pointer; the previous version stays
 *    for rollback. Projects and user data are never touched.
 */
export class UpdateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "UpdateError"; this.code = code; }
}

export type Channel = "stable" | "beta" | "dev";
export interface Release {
  version: string; channel: Channel; platform: string; arch: string;
  package: { file?: string; url?: string; sha256: string; size: number };
  requires?: { minInstalled?: string }; notes?: string;
}
export interface CatalogBody { schema: 1; product: "pso"; sequence: number; issuedAt: string; expiresAt: string; releases: Release[] }
export interface Catalog extends CatalogBody { signer: string; signature: string }

const bytesOf = (c: CatalogBody): Buffer => Buffer.from(JSON.stringify({ schema: c.schema, product: c.product, sequence: c.sequence, issuedAt: c.issuedAt, expiresAt: c.expiresAt, releases: c.releases }), "utf8");

export function signCatalog(body: CatalogBody, signingKeyPem: string): Catalog {
  const priv = createPrivateKey(signingKeyPem);
  const signer = fingerprintOf(createPublicKey(priv).export({ type: "spki", format: "pem" }).toString());
  return { ...body, signer, signature: edSign(null, bytesOf(body), priv).toString("base64") };
}

export function verifyCatalog(text: string, trusted: TrustedKey[], o: { now?: Date; lastSequence?: number } = {}): Catalog {
  let c: Catalog;
  try { c = JSON.parse(text) as Catalog; } catch { throw new UpdateError("CATALOG_FORMAT", "the update catalog is not valid JSON"); }
  if (c?.schema !== 1 || c.product !== "pso" || !Array.isArray(c.releases) || typeof c.signature !== "string" || !Number.isInteger(c.sequence)) throw new UpdateError("CATALOG_FORMAT", "the update catalog has an unexpected shape");
  const ok = trusted.some((k) => { try { return edVerify(null, bytesOf(c), createPublicKey(k.publicKeyPem), Buffer.from(c.signature, "base64")); } catch { return false; } });
  if (!ok) throw new UpdateError("CATALOG_SIGNATURE", "the update catalog is not signed by a trusted key; nothing was downloaded");
  const now = o.now ?? new Date();
  if (Date.parse(c.expiresAt) <= now.getTime()) throw new UpdateError("CATALOG_EXPIRED", `the update catalog expired on ${c.expiresAt}`);
  if (Date.parse(c.issuedAt) > now.getTime() + 5 * 60_000) throw new UpdateError("CATALOG_FORMAT", "the update catalog claims to be issued in the future");
  if (o.lastSequence !== undefined && c.sequence < o.lastSequence) throw new UpdateError("CATALOG_REPLAY", `the catalog (sequence ${c.sequence}) is older than one already seen (${o.lastSequence}); refusing to go back`);
  for (const r of c.releases) if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(r.version) || !["stable", "beta", "dev"].includes(r.channel) || !/^[0-9a-f]{64}$/.test(r.package?.sha256 ?? "") || !Number.isInteger(r.package?.size)) throw new UpdateError("CATALOG_FORMAT", `release entry "${r?.version}" is malformed`);
  return c;
}

// ---------------------------------------------------------------- versions and channels
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => { const [core, pre] = v.split("+")[0]!.split("-", 2) as [string, string | undefined]; return { n: core.split(".").map(Number), pre }; };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]! ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;      // a release is newer than its pre-releases
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
const ALLOWED: Record<Channel, Channel[]> = { stable: ["stable"], beta: ["stable", "beta"], dev: ["stable", "beta", "dev"] };

export function selectRelease(c: Catalog, o: { channel: Channel; current: string | null; platform: string; arch: string; allowDowngrade?: boolean }): { release: Release | null; reason: string } {
  const candidates = c.releases.filter((r) => ALLOWED[o.channel].includes(r.channel) && r.platform === o.platform && r.arch === o.arch);
  if (candidates.length === 0) return { release: null, reason: `the catalog has no release for ${o.platform}/${o.arch} on the ${o.channel} channel` };
  const best = candidates.sort((a, b) => compareVersions(b.version, a.version))[0]!;
  if (o.current && !o.allowDowngrade && compareVersions(best.version, o.current) <= 0) return { release: null, reason: `${o.current} is already the newest version on the ${o.channel} channel` };
  if (best.requires?.minInstalled && o.current && compareVersions(o.current, best.requires.minInstalled) < 0) return { release: null, reason: `${best.version} requires at least ${best.requires.minInstalled} to be installed first (installed: ${o.current})` };
  return { release: best, reason: `${best.version} is available` };
}

// ---------------------------------------------------------------- bounded fetch (file or https)
export async function fetchBytes(source: string, o: { maxBytes: number; timeoutMs?: number }): Promise<Buffer> {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    if (!existsSync(source)) throw new UpdateError("FETCH", `file not found: ${source}`);
    const b = readFileSync(source);
    if (b.length > o.maxBytes) throw new UpdateError("FETCH", "the file exceeds the maximum size");
    return b;
  }
  const u = new URL(source);
  const loopback = u.hostname === "localhost" || u.hostname.startsWith("127.") || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new UpdateError("FETCH", "only https URLs are accepted (plain http only for localhost)");
  if (u.username || u.password) throw new UpdateError("FETCH", "URLs with credentials are refused");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 30_000);
  try {
    const res = await fetch(u, { redirect: "error", signal: ctrl.signal });
    if (!res.ok) throw new UpdateError("FETCH", `the server answered HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > o.maxBytes) throw new UpdateError("FETCH", "the download exceeds the maximum size");
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) { size += c.length; if (size > o.maxBytes) throw new UpdateError("FETCH", "the download exceeds the maximum size"); chunks.push(Buffer.from(c)); }
    return Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError("FETCH", `download failed (${(e as Error).name})`);
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- operations
const META = ".pso-install";
const writeJson = (file: string, v: unknown): void => { mkdirSync(dirname(file), { recursive: true }); const t = `${file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v, null, 2)); renameSync(t, file); };
const lastSeq = (root: string): number | undefined => { try { return (JSON.parse(readFileSync(join(root, META, "catalog-sequence.json"), "utf8")) as { sequence: number }).sequence; } catch { return undefined; } };

export interface CheckResult { current: string | null; channel: Channel; available: Release | null; reason: string; catalogSequence: number }
export async function checkForUpdate(rootArg: string, o: { catalog: string; channel: Channel; trustedKeys?: TrustedKey[]; platform?: string; arch?: string; now?: Date }): Promise<CheckResult> {
  const root = checkRoot(rootArg, { mustExist: true });
  const trusted = o.trustedKeys?.length ? o.trustedKeys : loadTrust(root);
  const cat = verifyCatalog((await fetchBytes(o.catalog, { maxBytes: 4 * 1024 * 1024 })).toString("utf8"), trusted, { ...(o.now ? { now: o.now } : {}), ...(lastSeq(root) !== undefined ? { lastSequence: lastSeq(root)! } : {}) });
  const current = installState(root).current;
  const s = selectRelease(cat, { channel: o.channel, current, platform: o.platform ?? process.platform, arch: o.arch ?? process.arch });
  return { current, channel: o.channel, available: s.release, reason: s.reason, catalogSequence: cat.sequence };
}

export interface UpdateResult { from: string | null; to: string; activated: boolean }

/** Installs a newer version from a catalog release or from an offline package, verifies it completely, then activates it. */
export async function installUpdate(rootArg: string, o: { catalog?: string; channel: Channel; packageFile?: string; trustedKeys?: TrustedKey[]; recipientKeyPem?: string; recipientKeyProvider?: () => string; platform?: string; arch?: string; allowDowngrade?: boolean; now?: Date }): Promise<UpdateResult> {
  const root = checkRoot(rootArg, { mustExist: true });
  recoverInterrupted(root);
  const trusted = o.trustedKeys?.length ? o.trustedKeys : loadTrust(root);
  const state = installState(root);
  const downloads = join(root, META, "downloads");
  let file: string;
  let seq: number | undefined;
  writeJson(join(root, META, "journal.json"), { operation: "update", startedAt: new Date().toISOString(), from: state.current });
  try {
    if (o.packageFile) file = o.packageFile; // offline package: judged by its own signature below
    else {
      if (!o.catalog) throw new UpdateError("UPDATE_SOURCE", "give --catalog <file|https url> or --package <file> (offline)");
      const cat = verifyCatalog((await fetchBytes(o.catalog, { maxBytes: 4 * 1024 * 1024 })).toString("utf8"), trusted, { ...(o.now ? { now: o.now } : {}), ...(lastSeq(root) !== undefined ? { lastSequence: lastSeq(root)! } : {}) });
      seq = cat.sequence;
      const sel = selectRelease(cat, { channel: o.channel, current: state.current, platform: o.platform ?? process.platform, arch: o.arch ?? process.arch, ...(o.allowDowngrade ? { allowDowngrade: true } : {}) });
      if (!sel.release) throw new UpdateError("NO_UPDATE", sel.reason);
      const src = sel.release.package.url ?? sel.release.package.file;
      if (!src) throw new UpdateError("CATALOG_FORMAT", "the release names neither a url nor a file");
      const bytes = await fetchBytes(catalogRelative(o.catalog, src), { maxBytes: Math.min(1024 * 1024 * 1024, sel.release.package.size + 1024) });
      if (bytes.length !== sel.release.package.size || createHash("sha256").update(bytes).digest("hex") !== sel.release.package.sha256) throw new UpdateError("PACKAGE_HASH", "the downloaded package does not match the size and SHA-256 in the signed catalog; it was discarded");
      mkdirSync(downloads, { recursive: true });
      file = join(downloads, `${sel.release.version}.psopkg`);
      writeFileSync(file, bytes);
    }
    const { header } = readHeader(readFileSync(file), trusted); // authenticity of the package itself
    if (state.current && !o.allowDowngrade && compareVersions(header.version, state.current) <= 0) throw new UpdateError("NO_UPDATE", `${header.version} is not newer than the installed ${state.current}`);
    installPackage({ root, packageFile: file, trustedKeys: trusted, ...(o.recipientKeyPem ? { recipientKeyPem: o.recipientKeyPem } : {}), ...(o.recipientKeyProvider ? { recipientKeyProvider: o.recipientKeyProvider } : {}), activate: false });
    const rep = integrityCheck(root, { full: true, trustedKeys: trusted, version: header.version });
    if (!rep.ok) { removeVersion(root, header.version); throw new UpdateError("VERIFY_FAILED", `the new version failed verification after installation (${rep.checks.filter((c) => c.status === "failed").map((c) => c.name).join(", ")}); it was removed and ${state.current ?? "nothing"} stays active`); }
    const s2 = installState(root);
    s2.previous = s2.current; s2.current = header.version; s2.sequence++; // the single pointer switch is the activation
    writeJson(join(root, META, "install.json"), s2);
    if (seq !== undefined) writeJson(join(root, META, "catalog-sequence.json"), { sequence: seq });
    return { from: state.current, to: header.version, activated: true };
  } finally {
    try { unlinkSync(join(root, META, "journal.json")); } catch { /* none */ }
  }
}

function catalogRelative(catalog: string, src: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) || /^[A-Za-z]:[\\/]/.test(src) || src.startsWith("/")) return src;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(catalog) ? new URL(src, catalog).href : join(dirname(catalog), src);
}

export function rollback(rootArg: string): { from: string; to: string } {
  const root = checkRoot(rootArg, { mustExist: true });
  const state = installState(root);
  if (!state.current || !state.previous) throw new UpdateError("NO_PREVIOUS", "there is no previous version to roll back to");
  const rep = integrityCheck(root, { full: true, version: state.previous });
  if (!rep.ok) throw new UpdateError("PREVIOUS_DAMAGED", `the previous version ${state.previous} failed verification; repair or reinstall it before rolling back`);
  const from = state.current, to = state.previous;
  state.current = to; state.previous = from; state.sequence++;
  writeJson(join(root, META, "install.json"), state);
  return { from, to };
}

/** An update that was interrupted leaves a journal, staging directories and downloads: clean them. The active version is never changed here. */
export function recoverInterrupted(rootArg: string): { recovered: boolean } {
  const root = checkRoot(rootArg, { mustExist: true });
  const journal = join(root, META, "journal.json");
  if (!existsSync(journal)) return { recovered: false };
  const vdir = join(root, "versions");
  if (existsSync(vdir)) for (const d of readdirSync(vdir)) if (d.startsWith(".staging-")) rmSync(join(vdir, d), { recursive: true, force: true });
  const known = new Set(installState(root).versions.map((v) => v.version));
  if (existsSync(vdir)) for (const d of readdirSync(vdir)) if (!d.startsWith(".") && !known.has(d)) rmSync(join(vdir, d), { recursive: true, force: true }); // extracted but never recorded
  rmSync(join(root, META, "downloads"), { recursive: true, force: true });
  for (const d of existsSync(join(root, META)) ? readdirSync(join(root, META)) : []) if (d.startsWith("repair-")) rmSync(join(root, META, d), { recursive: true, force: true });
  unlinkSync(journal);
  return { recovered: true };
}

function removeVersion(root: string, version: string): void {
  const s = installState(root);
  s.versions = s.versions.filter((v) => v.version !== version);
  writeJson(join(root, META, "install.json"), s);
  rmSync(join(root, "versions", version), { recursive: true, force: true });
  rmSync(join(root, META, `inventory-${version}.json`), { force: true });
  rmSync(join(root, META, "packages", `${version}.psopkg`), { force: true });
}

export { InstallError };
