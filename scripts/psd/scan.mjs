// PSD distribution scanner (maintainer tooling: it is NOT part of any distributed artifact, because it names the indicators it searches for).
//
// Inspects a directory tree or a single artifact recursively: ZIP/JAR, TAR, TAR.GZ/TGZ, .gz, unencrypted .psopkg (and encrypted ones when
// the recipient key and a trusted signer are supplied), base64 segments inside text, source maps, and executable string tables.
// Every step is bounded (nesting depth, entries, bytes per entry, total bytes, compression ratio). Findings are REDACTED: they carry the rule,
// the location and a short digest of the match, never the matched value. Anything the scanner cannot inspect is reported as `uninspectable`
// and counts as a failure unless it is explicitly covered by pre-encryption evidence.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, sep } from "node:path";
import { gunzipSync, inflateRawSync, zstdDecompressSync } from "node:zlib";

export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 5,                 // nested archives
  maxEntriesPerArchive: 100_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxRatio: 400,               // uncompressed / compressed for a single entry
  maxBase64Segments: 200,      // decoded per file
  maxTextBytes: 64 * 1024 * 1024,
});

const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- rules
// "block" findings fail the gate. A finding can only be waived by an exception that names rule + path + the digest of the match and gives a reason.
export const CONTENT_RULES = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, why: "private key material" },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, why: "AWS access key id" },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, why: "GitHub token" },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, why: "Slack token" },
  { id: "api-secret-key", re: /\bsk-[A-Za-z0-9_-]{32,}\b/g, why: "API secret key" },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, why: "JSON Web Token" },
  { id: "bearer-literal", re: /\bAuthorization["'\s:=,]{1,12}Bearer\s+[A-Za-z0-9._~+/=-]{24,}/gi, why: "bearer credential literal" },
  { id: "cloud-connection-secret", re: /\b(?:AccountKey|SharedAccessSignature|client_secret)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{20,}/gi, why: "cloud connection secret" },
  { id: "dev-path-windows", re: /\b[A-Za-z]:[\\/]{1,4}Users[\\/]{1,4}(?!Public\b|Default\b|All Users\b|<|%|\$|\{|user\b|you\b|name\b|me\b|developer\b|example\b|your)[A-Za-z0-9._ -]{2,40}[\\/]/g, why: "developer-specific Windows profile path" },
  { id: "dev-path-repo", re: /\b[A-Za-z]:[\\/]{1,4}(?:(?!\.+[\\/])[^\\/\s"'`]+[\\/]{1,4}){0,3}pso-web-framework\b|\/mnt\/[a-z]\/(?:(?!\.+\/)[^\\/\s"'`]+\/){0,3}pso-web-framework\b/gi, why: "absolute path of a developer's framework checkout" },
  { id: "fixture-reference", re: /\bfixtures[\\/](?:pso-commerce|pso-cloud-validation|contracts|real-pso|static-site)\b|\bpso-commerce\b|\bpso-cloud-validation\b/g, why: "reference to an internal validation fixture" },
  { id: "internal-docs-reference", re: /\bdocs[\\/]implementation[\\/]|\bdocs[\\/]implementation\b/g, why: "reference to internal implementation reports" },
  { id: "sourcemap-url", re: /\/\/[#@]\s*sourceMappingURL=(?!data:)\S+/g, why: "source map reference" },
];

/** File-name rules, applied to every path including paths inside archives. */
export const NAME_RULES = [
  { id: "name-fixtures", re: /(^|\/)fixtures(\/|$)/i, why: "fixtures directory" },
  { id: "name-source-map", re: /\.(?:js|mjs|cjs|css)\.map$|\.map$/i, why: "source map" },
  { id: "name-tsbuildinfo", re: /\.tsbuildinfo$/i, why: "TypeScript incremental build state" },
  { id: "name-env-file", re: /(^|\/)\.env(\..*)?$/i, why: "environment file" },
  { id: "name-private-key", re: /(^|\/)id_(rsa|ed25519|ecdsa)$|\.(?:key|p12|pfx|jks|keystore)$|(?<!\.public)\.pem$/i, why: "key or certificate store" },
  { id: "name-vcs", re: /(^|\/)\.git(\/|$|ignore$|attributes$)|(^|\/)\.svn(\/|$)/i, why: "version control metadata" },
  { id: "name-pso-state", re: /(^|\/)\.pso(\/|$)/, why: "local PSO state" },
  { id: "name-log-db", re: /\.(?:log|sqlite3?|mv\.db|bak|dump)$/i, why: "log, database or backup" },
  { id: "name-internal-docs", re: /(^|\/)docs\/implementation(\/|$)/i, why: "internal implementation documentation" },
  { id: "name-evidence", re: /(^|\/)evidence(\/|$)/i, why: "test evidence" },
  { id: "name-sources-jar", re: /-sources\.jar$|-javadoc\.jar$/i, why: "source or javadoc jar (not part of the binary distribution)" },
  { id: "name-ai-history", re: /(^|\/)(CLAUDE\.md|\.claude(\/|$)|\.codex(\/|$)|AGENTS\.md)/i, why: "AI assistant context" },
  { id: "name-os-junk", re: /(^|\/)(Thumbs\.db|\.DS_Store|desktop\.ini)$/i, why: "operating system metadata" },
];

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".htm", ".css", ".md", ".txt", ".yml", ".yaml", ".xml", ".properties", ".ts", ".tsx", ".jsx", ".cmd", ".ps1", ".sh", ".svg", ".iss", ".toml", ".ini", ".conf", ".cfg", ".csv", ".pom", ".mf", ".sql", ".map", ".d.ts", ""]);
const BINARY_STRING_EXT = new Set([".exe", ".dll", ".node", ".class", ".so", ".dylib", ".bin"]);

// ---------------------------------------------------------------- archive readers (bounded)
class Budget {
  constructor(limits) { this.limits = limits; this.total = 0; }
  take(n) { this.total += n; if (this.total > this.limits.maxTotalBytes) throw new ScanLimit("the total uncompressed budget was exceeded (archive bomb or an unexpectedly large distribution)"); }
}
class ScanLimit extends Error {}

function readZip(buf, limits) {
  const entries = [];
  const minEocd = 22;
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ScanLimit("not a readable ZIP (no end-of-central-directory record)");
  let count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new ScanLimit("ZIP64 archives are not inspected");
  if (count > limits.maxEntriesPerArchive) throw new ScanLimit(`more than ${limits.maxEntriesPerArchive} entries`);
  let o = cdOff;
  for (let n = 0; n < count; n++) {
    if (o + 46 > buf.length || buf.readUInt32LE(o) !== 0x02014b50) throw new ScanLimit("corrupt ZIP central directory");
    const flags = buf.readUInt16LE(o + 8), method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), usize = buf.readUInt32LE(o + 24);
    const nl = buf.readUInt16LE(o + 28), el = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32), lho = buf.readUInt32LE(o + 42);
    const name = buf.subarray(o + 46, o + 46 + nl).toString((flags & 0x800) ? "utf8" : "latin1");
    o += 46 + nl + el + cl;
    entries.push({ name, flags, method, csize, usize, lho });
  }
  return entries.map((e) => ({
    name: e.name,
    dir: e.name.endsWith("/"),
    read() {
      if (e.flags & 1) throw new ScanLimit(`encrypted ZIP entry "${e.name}" cannot be inspected`);
      if (e.usize > limits.maxEntryBytes) throw new ScanLimit(`entry "${e.name}" is larger than ${limits.maxEntryBytes} bytes`);
      if (e.csize > 0 && e.usize / e.csize > limits.maxRatio) throw new ScanLimit(`entry "${e.name}" has an implausible compression ratio (archive bomb)`);
      const lh = e.lho;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new ScanLimit("corrupt ZIP local header");
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return raw;
      if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: Math.max(e.usize, 1) });
      throw new ScanLimit(`ZIP compression method ${e.method} is not supported`);
    },
  }));
}

function readTar(buf, limits) {
  const out = [];
  let o = 0, longName = null, paxPath = null;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    let name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(h.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = h.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (Number.isNaN(size) || size < 0) throw new ScanLimit("corrupt TAR header");
    const dataStart = o + 512, dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new ScanLimit("truncated TAR");
    if (size > limits.maxEntryBytes) throw new ScanLimit(`TAR entry "${name}" is larger than ${limits.maxEntryBytes} bytes`);
    if (type === "L") longName = buf.subarray(dataStart, dataEnd).toString("utf8").replace(/\0.*$/, "");
    else if (type === "x") { const m = /\d+ path=([^\n]+)\n/.exec(buf.subarray(dataStart, dataEnd).toString("utf8")); if (m) paxPath = m[1]; }
    else if (type === "g") { /* global pax header: ignore */ }
    else {
      if (prefix && !longName && !paxPath) name = `${prefix}/${name}`;
      name = paxPath ?? longName ?? name;
      longName = null; paxPath = null;
      if (type === "2" || type === "1") out.push({ name, link: true, dir: false, read: () => Buffer.alloc(0) });
      else out.push({ name, dir: type === "5" || name.endsWith("/"), read: () => buf.subarray(dataStart, dataEnd) });
      if (out.length > limits.maxEntriesPerArchive) throw new ScanLimit(`more than ${limits.maxEntriesPerArchive} entries`);
    }
    o = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

function gunzipBounded(buf, limits) {
  try { return gunzipSync(buf, { maxOutputLength: limits.maxEntryBytes * 4 }); }
  catch (e) { throw new ScanLimit(e?.code === "ERR_BUFFER_TOO_LARGE" ? "gzip content exceeds the size bound (archive bomb)" : "gzip cannot be decompressed"); }
}

// PSOPKG1 container: "PSOPKG1\n" | u32 headerLen | header | u64 payloadLen | payload | u16 sigLen | signature
function readPsopkg(buf, limits) {
  const MAGIC = "PSOPKG1\n";
  if (buf.subarray(0, 8).toString("latin1") !== MAGIC) throw new ScanLimit("not a PSO package");
  const hl = buf.readUInt32BE(8);
  const header = JSON.parse(buf.subarray(12, 12 + hl).toString("utf8"));
  const pl = Number(buf.readBigUInt64BE(12 + hl));
  const payload = buf.subarray(12 + hl + 8, 12 + hl + 8 + pl);
  return { header, payload };
}
function unpackPsoArchive(raw, limits) {
  const out = [];
  let o = 0;
  while (o < raw.length) {
    const pl = raw.readUInt16BE(o); o += 2;
    const name = raw.subarray(o, o + pl).toString("utf8"); o += pl + 1;
    const size = Number(raw.readBigUInt64BE(o)); o += 8;
    const data = raw.subarray(o, o + size); o += size;
    out.push({ name, dir: false, read: () => data });
    if (out.length > limits.maxEntriesPerArchive) throw new ScanLimit("too many entries");
  }
  return out;
}

// ---------------------------------------------------------------- scanner
/**
 * @param {string} target  directory or file
 * @param {object} [opts]
 * @param {string[]} [opts.denylist]            literal strings that must never occur (internal hosts, user names, tenant ids...). Kept OUTSIDE the repository.
 * @param {Array<{rule:string,path:string,digest:string,reason:string}>} [opts.exceptions]
 * @param {(buf:Buffer,name:string)=>Buffer|null} [opts.decryptPackage]  returns the decrypted compressed payload for an encrypted .psopkg, or null
 * @param {Set<string>} [opts.preEncryptionEvidence]  names of artifacts whose plaintext was scanned before encryption (sha256 of the artifact)
 */
export function scan(target, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const budget = new Budget(limits);
  const denylist = (opts.denylist ?? []).filter(Boolean);
  const findings = [], uninspectable = [];
  const stats = { files: 0, archives: 0, bytes: 0, nested: 0, base64Decoded: 0, maxDepth: 0 };

  const waived = (rule, path, digest) => (opts.exceptions ?? []).some((x) => x.rule === rule && (x.path === path || (x.pathPrefix && path.startsWith(x.pathPrefix))) && (!x.digest || x.digest === digest) && x.reason);
  const report = (rule, why, path, evidence) => {
    const digest = evidence === undefined ? "" : sha(Buffer.from(evidence)).slice(0, 12);
    if (waived(rule, path, digest)) return;
    findings.push({ rule, why, path, digest, length: evidence === undefined ? undefined : evidence.length });
  };

  function scanText(text, path) {
    for (const r of CONTENT_RULES) {
      r.re.lastIndex = 0;
      let m, n = 0;
      while ((m = r.re.exec(text)) && n++ < 20) report(r.id, r.why, path, m[0]);
    }
    for (let i = 0; i < denylist.length; i++) if (text.includes(denylist[i])) report("denylist", `private deny-list entry #${i + 1}`, path, denylist[i]);
  }

  function scanSourceMap(text, path) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (Array.isArray(j.sourcesContent) && j.sourcesContent.some((s) => typeof s === "string" && s.length)) report("sourcemap-embeds-source", "source map embeds original source text", path, "sourcesContent");
  }

  function decodeBase64Segments(text, path) {
    const re = /[A-Za-z0-9+/_-]{48,}={0,2}/g;
    let m, n = 0;
    while ((m = re.exec(text)) && n < limits.maxBase64Segments) {
      let b; try { b = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64"); } catch { continue; }
      if (b.length < 24) continue;
      const s = b.toString("latin1");
      const printable = (s.match(/[\x20-\x7e\r\n\t]/g) ?? []).length / s.length;
      if (printable < 0.9) continue; // not text: skip (random bytes, hashes, binary blobs)
      n++; stats.base64Decoded++;
      scanText(s, `${path}#base64`);
    }
  }

  function scanFile(buf, path, depth) {
    stats.files++; stats.bytes += buf.length; budget.take(buf.length);
    for (const r of NAME_RULES) if (r.re.test(path)) report(r.id, r.why, path, path);
    const ext = extname(path).toLowerCase(), name = basename(path).toLowerCase();
    // nested archives
    const isTgz = /\.(tgz|tar\.gz)$/i.test(path), isGz = ext === ".gz" && !isTgz, isTar = ext === ".tar", isZip = /\.(zip|jar|war|nupkg|vsix|whl)$/i.test(path), isPso = ext === ".psopkg";
    if (isTgz || isGz || isTar || isZip || isPso) {
      if (depth >= limits.maxDepth) { uninspectable.push({ path, reason: `nesting deeper than ${limits.maxDepth}` }); return; }
      stats.archives++; stats.nested = Math.max(stats.nested, depth + 1); stats.maxDepth = Math.max(stats.maxDepth, depth + 1);
      try {
        let entries;
        if (isZip) entries = readZip(buf, limits);
        else if (isTgz) entries = readTar(gunzipBounded(buf, limits), limits);
        else if (isGz) { const inner = gunzipBounded(buf, limits); scanFile(inner, path.replace(/\.gz$/i, ""), depth + 1); return; }
        else if (isTar) entries = readTar(buf, limits);
        else {
          const { header, payload } = readPsopkg(buf, limits);
          let compressed = payload;
          if (header.encryption) {
            const d = opts.decryptPackage ? opts.decryptPackage(buf, path) : null;
            if (!d) { uninspectable.push({ path, reason: "encrypted package: inspect the plaintext BEFORE encryption, or pass the recipient key and a trusted signer", encrypted: true, sha256: sha(buf) }); return; }
            compressed = d;
          }
          const raw = zstdDecompressSync(compressed, { maxOutputLength: Math.min(header.archive.size, limits.maxTotalBytes) });
          entries = unpackPsoArchive(raw, limits);
        }
        for (const e of entries) {
          if (e.dir) continue;
          const inner = `${path}!/${e.name}`;
          if (e.link) { report("archive-link-entry", "link inside an archive", inner, e.name); continue; }
          if (/(^|\/)\.\.(\/|$)|^\/|^[A-Za-z]:/.test(e.name)) report("archive-path-traversal", "archive entry path escapes its root", inner, e.name);
          let data; try { data = e.read(); } catch (err) { uninspectable.push({ path: inner, reason: err.message }); continue; }
          scanFile(data, inner, depth + 1);
        }
      } catch (err) { uninspectable.push({ path, reason: err instanceof ScanLimit ? err.message : `unreadable archive (${err.message.slice(0, 80)})` }); }
      return;
    }
    // text and binary content
    if (BINARY_STRING_EXT.has(ext)) {
      const latin = buf.toString("latin1");
      scanText(latin, path);
      // Windows resources and .NET-style strings are UTF-16LE
      const u16 = buf.toString("utf16le");
      scanText(u16, `${path}#utf16`);
      return;
    }
    if (buf.length > limits.maxTextBytes) { uninspectable.push({ path, reason: `larger than ${limits.maxTextBytes} bytes` }); return; }
    const looksText = TEXT_EXT.has(ext) || ext === ".ts" || name === "license" || name === "notice" || !buf.subarray(0, 4096).includes(0);
    if (!looksText) {
      // unknown binary: still search byte strings so an embedded secret in a blob is not missed
      scanText(buf.toString("latin1"), path);
      return;
    }
    const text = buf.toString("utf8");
    scanText(text, path);
    if (ext === ".map") scanSourceMap(text, path);
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".json" || ext === ".html" || ext === ".css") decodeBase64Segments(text, path);
  }

  const st = lstatSync(target);
  if (st.isSymbolicLink()) throw new Error(`refusing to scan through a link: ${target}`);
  if (st.isFile()) scanFile(readFileSync(target), basename(target), 0);
  else {
    const walk = (dir) => {
      for (const n of readdirSync(dir).sort()) {
        const full = join(dir, n), s = lstatSync(full), rel = relative(target, full).split(sep).join("/");
        if (s.isSymbolicLink()) { report("symlink-or-junction", "symbolic link or junction in the distribution", rel, rel); continue; }
        if (s.isDirectory()) { for (const r of NAME_RULES) if (r.re.test(rel + "/")) report(r.id, r.why, rel + "/", rel); walk(full); }
        else if (s.isFile()) {
          if (s.size > limits.maxEntryBytes * 4) { uninspectable.push({ path: rel, reason: `file larger than ${limits.maxEntryBytes * 4} bytes` }); continue; }
          scanFile(readFileSync(full), rel, 0);
        }
      }
    };
    walk(target);
  }
  const uncovered = uninspectable.filter((u) => !(u.sha256 && opts.preEncryptionEvidence?.has(u.sha256)));
  return { ok: findings.length === 0 && uncovered.length === 0, findings, uninspectable: uncovered, coveredByPreEncryptionEvidence: uninspectable.length - uncovered.length, stats, limits };
}

/** Counts by rule, for a compact summary. */
export const summarize = (r) => {
  const by = {};
  for (const f of r.findings) by[f.rule] = (by[f.rule] ?? 0) + 1;
  return by;
};

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("scan.mjs")) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
  const target = a.find((x) => !x.startsWith("--") && a[a.indexOf(x) - 1]?.startsWith("--") === false || a.indexOf(x) === 0);
  if (!target || target.startsWith("--")) { console.error("usage: node scripts/psd/scan.mjs <dir|file> [--denylist <file>] [--exceptions <json>] [--json <report.json>] [--max 40]"); process.exit(2); }
  const denylist = flag("denylist") ? readFileSync(flag("denylist"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")) : [];
  const exceptions = flag("exceptions") ? JSON.parse(readFileSync(flag("exceptions"), "utf8")).exceptions ?? [] : [];
  const r = scan(target, { denylist, exceptions });
  if (flag("json")) { await import("node:fs").then((fs) => fs.writeFileSync(flag("json"), JSON.stringify(r, null, 2))); }
  console.log(`${r.ok ? "PASSED" : "FAILED"}  ${r.stats.files} files, ${r.stats.archives} archives (max nesting ${r.stats.maxDepth}), ${(r.stats.bytes / 1048576).toFixed(1)} MB inspected, ${r.stats.base64Decoded} base64 segments decoded`);
  const sum = summarize(r);
  for (const [k, v] of Object.entries(sum).sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
  const max = Number(flag("max") ?? 25);
  for (const f of r.findings.slice(0, max)) console.log(`  - [${f.rule}] ${f.path}  (match digest ${f.digest}, ${f.length} chars; value withheld)`);
  if (r.findings.length > max) console.log(`  ... ${r.findings.length - max} more (use --json for the full redacted list)`);
  for (const u of r.uninspectable.slice(0, 10)) console.log(`  ? uninspectable: ${u.path}: ${u.reason}`);
  process.exit(r.ok ? 0 : 1);
}
