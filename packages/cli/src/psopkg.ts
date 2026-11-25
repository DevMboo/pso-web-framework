import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { walkFiles } from "@pso/core";

/**
 * The PSO package format (.psopkg).
 *
 *   "PSOPKG1\n" | u32 headerLen | header (JSON, UTF-8) | u64 payloadLen | payload | u16 sigLen | Ed25519 signature
 *
 *  - The header lists every file with its size and SHA-256, the components, platform/architecture, dependencies and install rules.
 *  - The payload is a zstd-compressed archive of regular files, optionally encrypted with AES-256-GCM. The content key is wrapped separately
 *    for each RECIPIENT with X25519 + HKDF-SHA256 + AES-256-GCM: there is no universal key, and an installer carries only public keys.
 *  - The signature covers the header and the payload as stored. It is checked, against keys the CALLER trusts (never keys found in the file),
 *    before anything is decrypted, decompressed or written.
 *  - Extraction is hostile-input safe: bounded sizes and compression ratio, regular files only, no absolute or traversing paths, no links
 *    followed, nothing outside the target, every file hashed against the header, and no file outside the header accepted.
 * Encryption protects the package in transit and at rest for the recipients. It does not stop a recipient who installed the software from
 * reading it.
 */
export class PsopkgError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "PsopkgError"; this.code = code; }
}

const MAGIC = Buffer.from("PSOPKG1\n", "latin1");
const FORMAT = 1;

export interface Limits { maxHeaderBytes: number; maxFiles: number; maxPathLength: number; maxUncompressedBytes: number; maxPackageBytes: number; maxCompressionRatio: number }
export const DEFAULT_LIMITS: Limits = { maxHeaderBytes: 4 * 1024 * 1024, maxFiles: 200_000, maxPathLength: 240, maxUncompressedBytes: 1024 * 1024 * 1024, maxPackageBytes: 1024 * 1024 * 1024, maxCompressionRatio: 200 };

export interface Component { name: string; version: string }
export interface PackageMeta {
  name: string; version: string; revision?: string; platform: string; arch: string;
  components: Component[]; dependencies?: Array<{ name: string; range: string }>; installRules?: Record<string, unknown>; createdAt?: string;
}
export interface FileEntry { path: string; size: number; sha256: string; component?: string }
export interface Header extends PackageMeta {
  format: number; createdAt: string; files: FileEntry[];
  archive: { compression: "zstd"; size: number; sha256: string; manifestDigest: string };
  encryption: null | { alg: "AES-256-GCM"; iv: string; tag: string; recipients: Array<{ id: string; ephemeralPublic: string; iv: string; tag: string; wrappedKey: string }> };
  signer: string;
}

export interface TrustedKey { id: string; publicKeyPem: string }

/** Never packed, whatever the allowlist says: credentials and developer-local material. */
export const DENY_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..*)?$/i, /(^|\/)\.git(\/|$)/, /(^|\/)\.pso(\/|$)/, /(^|\/)keys(\/|$)/, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /\.log$/i, /\.(sqlite|sqlite3|db|mv\.db)$/i, /(^|\/)node_modules\/\.cache(\/|$)/, /(^|\/)(Thumbs\.db|\.DS_Store)$/, /\.psopkg$/i,
];

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const keyId = (publicPem: string): string => sha256(createPublicKey(publicPem).export({ type: "spki", format: "der" })).slice(0, 16);

// ---------------------------------------------------------------- keys
export interface KeyPairPem { publicKeyPem: string; privateKeyPem: string; id: string }
/** kind "signing" = Ed25519, "recipient" = X25519 (for encryption). The private key is returned, not stored: the caller decides where it lives. */
export function generateKeyPair(kind: "signing" | "recipient"): KeyPairPem {
  const { publicKey, privateKey } = kind === "signing" ? generateKeyPairSync("ed25519") : generateKeyPairSync("x25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { publicKeyPem, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), id: keyId(publicKeyPem) };
}
export { keyId as fingerprintOf };

// ---------------------------------------------------------------- path rules
export function checkEntryPath(p: string, limits: Limits = DEFAULT_LIMITS): void {
  if (p.length === 0 || p.length > limits.maxPathLength) throw new PsopkgError("PSOPKG_PATH", "an entry path is empty or too long");
  if (/[\0\\]/.test(p) || /[\u0001-\u001f]/.test(p)) throw new PsopkgError("PSOPKG_PATH", "an entry path contains a forbidden character");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || isAbsolute(p)) throw new PsopkgError("PSOPKG_PATH", "an entry path is absolute");
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new PsopkgError("PSOPKG_PATH", "an entry path is not normalized (empty, . or .. segment)");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg) || /[. ]$/.test(seg)) throw new PsopkgError("PSOPKG_PATH", "an entry path uses a name that Windows treats specially");
  }
}

// ---------------------------------------------------------------- pack
export interface PackOptions {
  stageDir: string; meta: PackageMeta;
  signingKeyPem: string;
  recipients?: Array<{ publicKeyPem: string }>;
  /** component of each file, by path prefix: [{ prefix: "cli/", component: "cli" }] */
  componentOf?: Array<{ prefix: string; component: string }>;
  limits?: Limits;
}

function archive(files: Array<{ path: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const p = Buffer.from(f.path, "utf8");
    const head = Buffer.alloc(2 + p.length + 1 + 8);
    head.writeUInt16BE(p.length, 0); p.copy(head, 2); head.writeUInt8(0, 2 + p.length); head.writeBigUInt64BE(BigInt(f.data.length), 3 + p.length);
    parts.push(head, f.data);
  }
  return Buffer.concat(parts);
}

export function packStage(o: PackOptions): Buffer {
  const limits = o.limits ?? DEFAULT_LIMITS;
  const root = realpathSync(o.stageDir);
  const walked = walkFiles(root, { symlinks: "skip" });
  const bad = walked.issues.filter((i) => i.code !== "PSO_FS_SYMLINK_SKIPPED");
  if (bad.length) throw new PsopkgError("PSOPKG_FORMAT", `the stage directory cannot be packed: ${bad[0]!.message}`);
  if (walked.issues.some((i) => i.code === "PSO_FS_SYMLINK_SKIPPED")) throw new PsopkgError("PSOPKG_FORMAT", "the stage directory contains symbolic links or junctions; a package holds regular files only");
  const entries: Array<{ path: string; data: Buffer; component?: string }> = [];
  for (const f of walked.files) {
    const rel = relative(root, f).split(sep).join("/");
    checkEntryPath(rel, limits);
    const denied = DENY_PATTERNS.find((re) => re.test(rel));
    if (denied) throw new PsopkgError("PSOPKG_DENIED", `"${rel}" must never be packed (it looks like a credential or a developer-local file); remove it from the stage`);
    const component = o.componentOf?.find((c) => rel.startsWith(c.prefix))?.component;
    entries.push({ path: rel, data: readFileSync(f), ...(component ? { component } : {}) });
  }
  if (entries.length === 0) throw new PsopkgError("PSOPKG_FORMAT", "nothing to pack: the stage directory is empty");
  if (entries.length > limits.maxFiles) throw new PsopkgError("PSOPKG_LIMIT", `more than ${limits.maxFiles} files`);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: FileEntry[] = entries.map((e) => ({ path: e.path, size: e.data.length, sha256: sha256(e.data), ...(e.component ? { component: e.component } : {}) }));
  const raw = archive(entries);
  if (raw.length > limits.maxUncompressedBytes) throw new PsopkgError("PSOPKG_LIMIT", "the uncompressed content exceeds the maximum");
  const compressed = zstdCompressSync(raw);
  const manifestDigest = sha256(JSON.stringify(files));

  const priv = createPrivateKey(o.signingKeyPem);
  if (priv.asymmetricKeyType !== "ed25519") throw new PsopkgError("PSOPKG_KEY", "the signing key must be an Ed25519 private key");
  const signerId = keyId(createPublicKey(priv).export({ type: "spki", format: "pem" }).toString());

  let payload = compressed;
  let encryption: Header["encryption"] = null;
  if (o.recipients?.length) {
    const contentKey = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
    cipher.setAAD(Buffer.from(`psopkg1:${manifestDigest}`));
    payload = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const recipients = o.recipients.map((r) => {
      const pub = createPublicKey(r.publicKeyPem);
      if (pub.asymmetricKeyType !== "x25519") throw new PsopkgError("PSOPKG_KEY", "recipient keys must be X25519 public keys");
      const eph = generateKeyPairSync("x25519");
      const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
      const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("psopkg1 key wrap"), 32));
      const wiv = randomBytes(12);
      const wc = createCipheriv("aes-256-gcm", wrapKey, wiv);
      const wrapped = Buffer.concat([wc.update(contentKey), wc.final()]);
      return { id: keyId(r.publicKeyPem), ephemeralPublic: eph.publicKey.export({ type: "spki", format: "der" }).toString("base64"), iv: wiv.toString("base64"), tag: wc.getAuthTag().toString("base64"), wrappedKey: wrapped.toString("base64") };
    });
    encryption = { alg: "AES-256-GCM", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), recipients };
  }
  const header: Header = {
    format: FORMAT, name: o.meta.name, version: o.meta.version, ...(o.meta.revision ? { revision: o.meta.revision } : {}), platform: o.meta.platform, arch: o.meta.arch,
    components: o.meta.components, dependencies: o.meta.dependencies ?? [], installRules: o.meta.installRules ?? {}, createdAt: o.meta.createdAt ?? new Date().toISOString(),
    files, archive: { compression: "zstd", size: raw.length, sha256: sha256(raw), manifestDigest }, encryption, signer: signerId,
  };
  const out = assemble(header, payload, o.signingKeyPem, limits);
  if (out.length > limits.maxPackageBytes) throw new PsopkgError("PSOPKG_LIMIT", "the package exceeds the maximum size");
  return out;
}

/** Frames and signs a header and a payload. Used by packStage; tests use it to forge hostile but correctly signed packages. */
export function assemble(header: unknown, payload: Buffer, signingKeyPem: string, limits: Limits = DEFAULT_LIMITS): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > limits.maxHeaderBytes) throw new PsopkgError("PSOPKG_LIMIT", "the header is too large");
  const priv = createPrivateKey(signingKeyPem);
  if (priv.asymmetricKeyType !== "ed25519") throw new PsopkgError("PSOPKG_KEY", "the signing key must be an Ed25519 private key");
  const signature = edSign(null, signingInput(headerBytes, payload), priv);
  const hl = Buffer.alloc(4); hl.writeUInt32BE(headerBytes.length);
  const pl = Buffer.alloc(8); pl.writeBigUInt64BE(BigInt(payload.length));
  const sl = Buffer.alloc(2); sl.writeUInt16BE(signature.length);
  return Buffer.concat([MAGIC, hl, headerBytes, pl, payload, sl, signature]);
}

const signingInput = (headerBytes: Buffer, payload: Buffer): Buffer => Buffer.concat([Buffer.from("PSOPKG1\0"), createHash("sha256").update(headerBytes).digest(), createHash("sha256").update(payload).digest()]);

// ---------------------------------------------------------------- verify
export interface VerifyOptions { trustedKeys: TrustedKey[]; recipientKeyPem?: string; /** resolved only when the package is encrypted: lets a protected key store be opened lazily */ recipientKeyProvider?: () => string; limits?: Limits }
const recipientKeyOf = (o: { recipientKeyPem?: string; recipientKeyProvider?: () => string }): string | undefined => o.recipientKeyPem ?? o.recipientKeyProvider?.();
export interface Verified { header: Header; encrypted: boolean; /** every file was decompressed and hashed against the header */ contentsVerified: boolean; signer: string }

interface Parsed { header: Header; headerBytes: Buffer; payload: Buffer; signature: Buffer }

function parse(buf: Buffer, limits: Limits): Parsed {
  if (buf.length > limits.maxPackageBytes) throw new PsopkgError("PSOPKG_LIMIT", "the package exceeds the maximum size");
  if (buf.length < MAGIC.length + 4 + 8 + 2 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new PsopkgError("PSOPKG_FORMAT", "not a PSO package (bad magic)");
  let o = MAGIC.length;
  const hl = buf.readUInt32BE(o); o += 4;
  if (hl > limits.maxHeaderBytes || o + hl + 8 > buf.length) throw new PsopkgError("PSOPKG_FORMAT", "the header length is invalid");
  const headerBytes = buf.subarray(o, o + hl); o += hl;
  const pl = buf.readBigUInt64BE(o); o += 8;
  if (pl > BigInt(buf.length) || o + Number(pl) + 2 > buf.length) throw new PsopkgError("PSOPKG_FORMAT", "the payload length is invalid");
  const payload = buf.subarray(o, o + Number(pl)); o += Number(pl);
  const sl = buf.readUInt16BE(o); o += 2;
  if (sl !== 64 || o + sl !== buf.length) throw new PsopkgError("PSOPKG_FORMAT", "the signature block is invalid (trailing bytes or wrong length)");
  const signature = buf.subarray(o, o + sl);
  let header: Header;
  try { header = JSON.parse(headerBytes.toString("utf8")) as Header; } catch { throw new PsopkgError("PSOPKG_FORMAT", "the header is not valid JSON"); }
  return { header, headerBytes, payload, signature };
}

function validateHeader(h: Header, limits: Limits): void {
  const bad = (m: string): never => { throw new PsopkgError("PSOPKG_FORMAT", `invalid header: ${m}`); };
  if (h?.format !== FORMAT) bad("unsupported format version");
  for (const k of ["name", "version", "platform", "arch", "signer"] as const) if (typeof h[k] !== "string" || h[k].length === 0 || h[k].length > 200) bad(`${k} is missing or invalid`);
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(h.version)) bad("version is not semantic");
  if (!Array.isArray(h.files) || h.files.length === 0 || h.files.length > limits.maxFiles) bad("files");
  if (!Array.isArray(h.components) || !h.components.every((c) => typeof c?.name === "string" && typeof c?.version === "string")) bad("components");
  if (Number.isInteger(h.archive?.size) && h.archive.size > limits.maxUncompressedBytes) throw new PsopkgError("PSOPKG_LIMIT", "the declared content exceeds the maximum");
  if (h.archive?.compression !== "zstd" || !Number.isInteger(h.archive.size) || h.archive.size < 0 || !/^[0-9a-f]{64}$/.test(h.archive.sha256) || !/^[0-9a-f]{64}$/.test(h.archive.manifestDigest)) bad("archive");
  const seen = new Set<string>();
  let total = 0;
  for (const f of h.files) {
    checkEntryPath(f?.path, limits);
    if (seen.has(f.path.toLowerCase())) bad("duplicate path (case-insensitively)");
    seen.add(f.path.toLowerCase());
    if (!Number.isInteger(f.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(f.sha256)) bad("file entry");
    total += f.size;
  }
  if (total > limits.maxUncompressedBytes) throw new PsopkgError("PSOPKG_LIMIT", "the declared content exceeds the maximum");
  if (sha256(JSON.stringify(h.files)) !== h.archive.manifestDigest) bad("the manifest digest does not match the file list");
  if (h.encryption !== null && (h.encryption?.alg !== "AES-256-GCM" || !Array.isArray(h.encryption.recipients) || h.encryption.recipients.length === 0)) bad("encryption");
}

/** Checks the signature against the CALLER's trusted keys. Everything else happens only after this succeeds. */
function authenticate(p: Parsed, trusted: TrustedKey[]): string {
  if (trusted.length === 0) throw new PsopkgError("PSOPKG_SIGNATURE", "no trusted signing key was provided");
  const input = signingInput(p.headerBytes, p.payload);
  for (const k of trusted) {
    try { if (edVerify(null, input, createPublicKey(k.publicKeyPem), p.signature)) return k.id || keyId(k.publicKeyPem); } catch { /* wrong key type: try the next */ }
  }
  throw new PsopkgError("PSOPKG_SIGNATURE", "the signature is not valid for any trusted key (corrupted, modified or signed by someone else)");
}

function decryptPayload(h: Header, payload: Buffer, recipientKeyPem: string): Buffer {
  const enc = h.encryption!;
  let priv: KeyObject;
  try { priv = createPrivateKey(recipientKeyPem); } catch { throw new PsopkgError("PSOPKG_KEY", "the recipient key is not a valid private key"); }
  if (priv.asymmetricKeyType !== "x25519") throw new PsopkgError("PSOPKG_KEY", "the recipient key must be an X25519 private key");
  const myId = keyId(createPublicKey(priv).export({ type: "spki", format: "pem" }).toString());
  const entry = enc.recipients.find((r) => r.id === myId);
  if (!entry) throw new PsopkgError("PSOPKG_DECRYPT", "this package was not encrypted for the provided key");
  try {
    const shared = diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: Buffer.from(entry.ephemeralPublic, "base64"), format: "der", type: "spki" }) });
    const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("psopkg1 key wrap"), 32));
    const wd = createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(entry.iv, "base64"));
    wd.setAuthTag(Buffer.from(entry.tag, "base64"));
    const contentKey = Buffer.concat([wd.update(Buffer.from(entry.wrappedKey, "base64")), wd.final()]);
    const d = createDecipheriv("aes-256-gcm", contentKey, Buffer.from(enc.iv, "base64"));
    d.setAAD(Buffer.from(`psopkg1:${h.archive.manifestDigest}`));
    d.setAuthTag(Buffer.from(enc.tag, "base64"));
    return Buffer.concat([d.update(payload), d.final()]);
  } catch { throw new PsopkgError("PSOPKG_DECRYPT", "the content could not be decrypted (wrong key or corrupted ciphertext)"); }
}

function unpack(h: Header, compressed: Buffer, limits: Limits): Array<{ path: string; data: Buffer }> {
  if (h.archive.size > limits.maxUncompressedBytes) throw new PsopkgError("PSOPKG_LIMIT", "the declared size exceeds the maximum");
  if (h.archive.size > 64 * 1024 * 1024 && h.archive.size / Math.max(1, compressed.length) > limits.maxCompressionRatio) throw new PsopkgError("PSOPKG_LIMIT", "the compression ratio is implausible (archive bomb)");
  let raw: Buffer;
  try { raw = zstdDecompressSync(compressed, { maxOutputLength: h.archive.size }); } // never produces more than the (already bounded) declared size
  catch (e) { throw new PsopkgError("PSOPKG_INTEGRITY", (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "the content is larger than declared (archive bomb)" : "the content cannot be decompressed"); }
  if (raw.length !== h.archive.size || sha256(raw) !== h.archive.sha256) throw new PsopkgError("PSOPKG_INTEGRITY", "the archive does not match its declared size and hash");
  const out: Array<{ path: string; data: Buffer }> = [];
  let o = 0;
  while (o < raw.length) {
    if (o + 2 > raw.length) throw new PsopkgError("PSOPKG_FORMAT", "truncated archive");
    const pl = raw.readUInt16BE(o); o += 2;
    if (pl === 0 || pl > limits.maxPathLength || o + pl + 9 > raw.length) throw new PsopkgError("PSOPKG_FORMAT", "invalid archive entry");
    const path = raw.subarray(o, o + pl).toString("utf8"); o += pl;
    const kind = raw.readUInt8(o); o += 1;
    if (kind !== 0) throw new PsopkgError("PSOPKG_FORMAT", "only regular files are allowed in a package");
    const size = raw.readBigUInt64BE(o); o += 8;
    if (size > BigInt(raw.length - o)) throw new PsopkgError("PSOPKG_FORMAT", "an entry is larger than the archive");
    out.push({ path, data: raw.subarray(o, o + Number(size)) }); o += Number(size);
    if (out.length > limits.maxFiles) throw new PsopkgError("PSOPKG_LIMIT", "too many entries");
  }
  if (out.length !== h.files.length) throw new PsopkgError("PSOPKG_INTEGRITY", "the archive holds a different set of files than the header lists");
  for (let i = 0; i < out.length; i++) {
    const e = out[i]!, f = h.files[i]!;
    checkEntryPath(e.path, limits);
    if (e.path !== f.path || e.data.length !== f.size || sha256(e.data) !== f.sha256) throw new PsopkgError("PSOPKG_INTEGRITY", `file "${f.path}" does not match the header (size or hash)`);
  }
  return out;
}

/** Authenticates (signature first), validates and, when a key is available for an encrypted package, verifies every file. */
export function verifyPackage(buf: Buffer, o: VerifyOptions): Verified {
  const limits = o.limits ?? DEFAULT_LIMITS;
  const p = parse(buf, limits);
  const signer = authenticate(p, o.trustedKeys);
  validateHeader(p.header, limits);
  if (p.header.encryption && !o.recipientKeyPem && !o.recipientKeyProvider) return { header: p.header, encrypted: true, contentsVerified: false, signer };
  const compressed = p.header.encryption ? decryptPayload(p.header, p.payload, recipientKeyOf(o)!) : p.payload;
  unpack(p.header, compressed, limits);
  return { header: p.header, encrypted: !!p.header.encryption, contentsVerified: true, signer };
}

// ---------------------------------------------------------------- extract
export interface ExtractOptions extends VerifyOptions { overwrite?: boolean }

function realDirInside(root: string, dir: string): void {
  // every existing component must be a real directory (never a link) and the resolved path must stay below root
  let cur = root;
  for (const part of relative(root, dir).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    if (!existsSync(cur)) return;
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PsopkgError("PSOPKG_PATH", "an existing path component is a link or not a directory; refusing to write through it");
    const real = realpathSync(cur);
    if (relative(root, real).startsWith("..")) throw new PsopkgError("PSOPKG_PATH", "a path component resolves outside the target");
  }
}

/** Verifies completely, then writes. Nothing is written when verification fails. Files are written to a temporary name and renamed. */
export function extractPackage(buf: Buffer, dest: string, o: ExtractOptions): { files: number; bytes: number; header: Header } {
  const limits = o.limits ?? DEFAULT_LIMITS;
  const p = parse(buf, limits);
  authenticate(p, o.trustedKeys);
  validateHeader(p.header, limits);
  if (p.header.encryption && !o.recipientKeyPem && !o.recipientKeyProvider) throw new PsopkgError("PSOPKG_DECRYPT", "this package is encrypted: a recipient key is required to extract it");
  const compressed = p.header.encryption ? decryptPayload(p.header, p.payload, recipientKeyOf(o)!) : p.payload;
  const entries = unpack(p.header, compressed, limits); // complete verification BEFORE the first byte is written
  mkdirSync(dest, { recursive: true });
  const root = realpathSync(dest);
  const targets = entries.map((e) => ({ e, full: resolve(root, ...e.path.split("/")) }));
  for (const t of targets) {
    if (relative(root, t.full).startsWith("..") || isAbsolute(relative(root, t.full))) throw new PsopkgError("PSOPKG_PATH", "an entry resolves outside the target");
    realDirInside(root, dirname(t.full));
    if (existsSync(t.full) && !o.overwrite) throw new PsopkgError("PSOPKG_EXISTS", `"${t.e.path}" already exists; nothing was written (use overwrite explicitly to replace files)`);
    if (existsSync(t.full) && lstatSync(t.full).isSymbolicLink()) throw new PsopkgError("PSOPKG_PATH", `"${t.e.path}" is a link on disk; refusing to replace it`);
  }
  let bytes = 0;
  const written: string[] = [];
  try {
    for (const t of targets) {
      mkdirSync(dirname(t.full), { recursive: true });
      realDirInside(root, dirname(t.full));
      const tmp = `${t.full}.psopkg-${randomBytes(4).toString("hex")}.tmp`;
      const fd = openSync(tmp, "wx");
      try { writeSync(fd, t.e.data); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, t.full);
      written.push(t.full); bytes += t.e.data.length;
    }
  } catch (e) {
    for (const f of written) { try { rmSync(f, { force: true }); } catch { /* best effort */ } } // do not leave a half-installed set behind
    throw e;
  }
  return { files: entries.length, bytes, header: p.header };
}

export function readHeader(buf: Buffer, trusted: TrustedKey[], limits: Limits = DEFAULT_LIMITS): { header: Header; signer: string } {
  const p = parse(buf, limits);
  const signer = authenticate(p, trusted);
  validateHeader(p.header, limits);
  return { header: p.header, signer };
}
