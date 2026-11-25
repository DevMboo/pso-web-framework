// Windows Authenticode signing for PSO release artifacts, with Windows SDK SignTool, and the production release gate.
//
// What is signed: only PSO-owned Windows executables (the Inno Setup installer and its uninstaller; any other PE file PSO builds).
// Third-party executables keep their own signature and are verified, never re-signed (today: the bundled node.exe, signed by the OpenJS
// Foundation). Every signature is SHA-256 with an RFC 3161 timestamp, and is verified the way the user's Windows verifies it
// (WinVerifyTrust through Get-AuthenticodeSignature: file hash, chain to a trusted root, code-signing EKU) plus SignTool's own policy check.
//
// The signing identity is provisioned OUTSIDE the repository and passed through the environment, never on the command line of this
// script and never in a file of the repository:
//   certificate store (includes hardware tokens, HSM-backed keys and cloud KSPs such as DigiCert KeyLocker or Google Cloud KMS CNG):
//     PSO_SIGN_THUMBPRINT=<40 hex SHA-1 thumbprint>   [PSO_SIGN_STORE=My] [PSO_SIGN_MACHINE_STORE=1]
//     [PSO_SIGN_CSP=<cryptographic provider> PSO_SIGN_KEY_CONTAINER=<key container>]   (a token that is not mapped to a store certificate)
//   cloud signing through a SignTool digest library (Azure Artifact Signing / Trusted Signing, or a vendor's dlib):
//     PSO_SIGN_DLIB=<path to the .dll>  PSO_SIGN_DLIB_METADATA=<path to its metadata .json>
//   a .pfx file, for TEST certificates only (publicly trusted code-signing keys must be hardware-backed since June 2023):
//     PSO_SIGN_PFX=<path>  PSO_SIGN_PFX_PASSWORD=<password, from a secret store>
//   PSO_TIMESTAMP_URL   RFC 3161 time-stamp authority (default http://timestamp.acs.microsoft.com); PSO_SIGNTOOL  path to signtool.exe
//
//   node scripts/psd/codesign.mjs check                                        configuration and SignTool, nothing signed (exit 3 = BLOCKED)
//   node scripts/psd/codesign.mjs sign --file <f> --publisher <CN> [--log <jsonl>]   sign one PSO-owned file, then verify it (Inno Setup calls this)
//   node scripts/psd/codesign.mjs verify --file <f> --publisher <CN>          verify one PSO-owned file
//   node scripts/psd/codesign.mjs gate --dir <dir> [--dir <dir>...] --publisher <CN> [--json]   every executable below the directories
//                                                                              (ZIP files are inspected too) must pass; exit 1 otherwise
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { commonName, judgeSignature, readAuthenticode } from "./tools/authenticode.ts";

export const DEFAULT_TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";

/** Third-party executables PSO redistributes: their own publisher signature is required and preserved. */
export const THIRD_PARTY = [
  { name: "Node.js runtime", match: /(^|\/)node\.exe$/i, publishers: ["OpenJS Foundation"] },
];

export class Blocked extends Error {}

/** The signing identity from the environment, as SignTool arguments. Secrets stay in the environment of the SignTool process only. */
export function signingIdentity(env = process.env) {
  const has = (k) => typeof env[k] === "string" && env[k].trim() !== "";
  const kinds = [has("PSO_SIGN_THUMBPRINT") && "store", has("PSO_SIGN_DLIB") && "dlib", has("PSO_SIGN_PFX") && "pfx"].filter(Boolean);
  if (kinds.length === 0) throw new Blocked("No signing identity is configured (PSO_SIGN_THUMBPRINT, PSO_SIGN_DLIB + PSO_SIGN_DLIB_METADATA, or PSO_SIGN_PFX for a test certificate)");
  if (kinds.length > 1) throw new Error(`several signing identities are configured (${kinds.join(", ")}): configure exactly one`);
  if (kinds[0] === "store") {
    const tp = env.PSO_SIGN_THUMBPRINT.replace(/\s/g, "");
    if (!/^[0-9a-fA-F]{40}$/.test(tp)) throw new Error("PSO_SIGN_THUMBPRINT must be the certificate's 40-hex-digit SHA-1 thumbprint");
    const args = ["/sha1", tp, "/s", env.PSO_SIGN_STORE || "My", ...(env.PSO_SIGN_MACHINE_STORE === "1" ? ["/sm"] : [])];
    if (has("PSO_SIGN_CSP") !== has("PSO_SIGN_KEY_CONTAINER")) throw new Error("PSO_SIGN_CSP and PSO_SIGN_KEY_CONTAINER go together");
    if (has("PSO_SIGN_CSP")) args.push("/csp", env.PSO_SIGN_CSP, "/kc", env.PSO_SIGN_KEY_CONTAINER);
    return { kind: "store", args, secretArgs: [], description: `certificate ${tp.slice(0, 8)}... in the ${env.PSO_SIGN_MACHINE_STORE === "1" ? "machine" : "user"} store "${env.PSO_SIGN_STORE || "My"}"${has("PSO_SIGN_CSP") ? ` (key in ${env.PSO_SIGN_CSP})` : ""}` };
  }
  if (kinds[0] === "dlib") {
    if (!has("PSO_SIGN_DLIB_METADATA")) throw new Error("PSO_SIGN_DLIB needs PSO_SIGN_DLIB_METADATA (the provider's metadata .json)");
    for (const k of ["PSO_SIGN_DLIB", "PSO_SIGN_DLIB_METADATA"]) if (!existsSync(env[k])) throw new Blocked(`${k} does not exist: ${env[k]}`);
    return { kind: "dlib", args: ["/dlib", env.PSO_SIGN_DLIB, "/dmdf", env.PSO_SIGN_DLIB_METADATA], secretArgs: [], description: `cloud signing through ${basename(env.PSO_SIGN_DLIB)}` };
  }
  if (!existsSync(env.PSO_SIGN_PFX)) throw new Blocked(`PSO_SIGN_PFX does not exist: ${env.PSO_SIGN_PFX}`);
  return { kind: "pfx", args: ["/f", env.PSO_SIGN_PFX], secretArgs: has("PSO_SIGN_PFX_PASSWORD") ? ["/p", env.PSO_SIGN_PFX_PASSWORD] : [], description: `PFX file ${basename(env.PSO_SIGN_PFX)} (test certificates only)` };
}

export function timestampUrl(env = process.env) {
  const url = env.PSO_TIMESTAMP_URL || DEFAULT_TIMESTAMP_URL;
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/\S*)?$/.test(url)) throw new Error(`PSO_TIMESTAMP_URL is not an http(s) URL of an RFC 3161 time-stamp authority: ${url}`);
  return url;
}

/** signtool.exe: PSO_SIGNTOOL, then the newest Windows SDK (x64), then the Windows SDK build tools NuGet layout under PSO_SIGNTOOL_DIR. */
export function findSigntool(env = process.env) {
  if (env.PSO_SIGNTOOL) return existsSync(env.PSO_SIGNTOOL) ? env.PSO_SIGNTOOL : undefined;
  const roots = [join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin"), ...(env.PSO_SIGNTOOL_DIR ? [env.PSO_SIGNTOOL_DIR] : [])];
  for (const root of roots) {
    try {
      for (const v of readdirSync(root).sort().reverse()) {
        for (const p of [join(root, v, "x64", "signtool.exe"), join(root, v, "bin", v, "x64", "signtool.exe")]) if (existsSync(p)) return p;
      }
    } catch { /* not there */ }
  }
  return undefined;
}

/** The complete SignTool argument list for one file: SHA-256 file digest, RFC 3161 timestamp with a SHA-256 digest. */
export function signArguments(file, identity, tsUrl) {
  return ["sign", "/v", "/fd", "SHA256", "/tr", tsUrl, "/td", "SHA256", ...identity.args, ...identity.secretArgs, file];
}

/** For logs and error messages: the arguments with every secret value replaced. */
export function redact(args, identity) {
  const secrets = new Set(identity.secretArgs.filter((_, i) => i % 2 === 1));
  return args.map((a) => (secrets.has(a) ? "<redacted>" : a));
}

/** A Windows PE image ("MZ" header whose e_lfanew points at "PE\0\0"), recognised by content, not by name. */
export function isPortableExecutableBuffer(b) {
  if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return false;
  const off = b.readUInt32LE(0x3c);
  return off + 4 <= b.length && b[off] === 0x50 && b[off + 1] === 0x45 && b[off + 2] === 0 && b[off + 3] === 0;
}
export function isPortableExecutable(file) {
  const fd = openSync(file, "r");
  try { const b = Buffer.alloc(4096); const n = readSync(fd, b, 0, b.length, 0); return isPortableExecutableBuffer(b.subarray(0, n)); } finally { closeSync(fd); }
}

/**
 * The bytes Authenticode covers, made comparable: the PE image without its certificate table, with the checksum and the certificate-table
 * directory entry zeroed. Signing appends the table (after padding the image to 8 bytes) and sets those two fields; nothing else changes.
 */
function authenticodeContent(b) {
  if (!isPortableExecutableBuffer(b)) throw new Error("not a Windows executable");
  const pe = b.readUInt32LE(0x3c), opt = pe + 24, magic = b.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  if (Number.isNaN(dirs)) throw new Error("unknown optional header");
  const sec = dirs + 4 * 8, certOff = b.readUInt32LE(sec), certLen = b.readUInt32LE(sec + 4);
  const end = certLen && certOff ? certOff : b.length;
  if (certLen && certOff + certLen !== b.length) throw new Error("the certificate table is not at the end of the file");
  const c = Buffer.from(b.subarray(0, end));
  c.fill(0, opt + 64, opt + 68); c.fill(0, sec, sec + 8);
  return c;
}

/** true when `signed` is exactly `unsigned` plus an Authenticode signature (a remote signing service returned the build that was submitted). */
export function sameExceptSignature(unsigned, signed) {
  const u = authenticodeContent(unsigned), s = authenticodeContent(signed);
  if (s.length < u.length || s.length - u.length >= 8) return false;
  return s.subarray(0, u.length).equals(u) && s.subarray(u.length).every((x) => x === 0);
}

/** The role of an executable in the release: a known third-party file keeps its own publisher, everything else is PSO-owned. */
export function roleOf(relPath) {
  const p = relPath.split(sep).join("/");
  const tp = THIRD_PARTY.find((t) => t.match.test(p));
  return tp ? { role: "third-party", name: tp.name, publishers: tp.publishers } : { role: "pso" };
}

/** The judgement of one executable: PSO-owned files must carry the PSO publisher, third-party files their own allowed publisher. */
export function judgeExecutable(relPath, info, publisher, thumbprints = []) {
  const r = roleOf(relPath);
  if (r.role === "pso") return { file: relPath, role: "pso", ...summary(info), ...judgeSignature(info, publisher, thumbprints) };
  const allowed = r.publishers.map((p) => judgeSignature(info, p)).find((j) => j.ok);
  const j = allowed ?? { ok: false, reason: info?.status === "Valid" ? `${r.name}: signed by "${commonName(info.subject) ?? info.subject}", expected ${r.publishers.join(" or ")}` : `${r.name}: ${judgeSignature(info, r.publishers[0]).reason}` };
  return { file: relPath, role: "third-party", ...summary(info), ...j };
}
const summary = (info) => ({ status: info?.status ?? "unreadable", signer: info ? (commonName(info.subject) ?? "") : "", timestamped: !!info?.timestamped });

/** The gate's decision over judged executables: every one must be accepted, and the PSO publisher must be present when PSO files exist. */
export function gateDecision(entries) {
  const failures = entries.filter((e) => !e.ok);
  return { ok: failures.length === 0, executables: entries.length, pso: entries.filter((e) => e.role === "pso").length, thirdParty: entries.filter((e) => e.role === "third-party").length, failures };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** Every executable below the directories, ZIP archives expanded into a temporary folder (with Windows' own tar). */
export function inventory(dirs) {
  const found = [], temps = [];
  const visit = (root, label) => {
    for (const f of walk(root)) {
      const rel = `${label}${relative(root, f).split(sep).join("/")}`;
      if (/\.zip$/i.test(f)) {
        const t = mkdtempSync(join(tmpdir(), "pso-gate-")); temps.push(t);
        const r = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", f, "-C", t], { encoding: "utf8", windowsHide: true });
        if (r.status !== 0) throw new Error(`cannot inspect ${rel}: ${(r.stderr || r.stdout).slice(0, 200)}`);
        visit(t, `${rel}!/`);
      } else if (isPortableExecutable(f)) found.push({ path: f, rel });
    }
  };
  for (const d of dirs) visit(resolve(d), `${basename(resolve(d))}/`);
  return { found, cleanup: () => { for (const t of temps) rmSync(t, { recursive: true, force: true }); } };
}

export function gate(dirs, publisher, thumbprints = []) {
  const inv = inventory(dirs);
  try { return gateDecision(inv.found.map((f) => judgeExecutable(f.rel, readAuthenticode(f.path), publisher, thumbprints))); } finally { inv.cleanup(); }
}

/** Signs ONE PSO-owned file and verifies it. A file that already carries another publisher's signature is never re-signed. */
export function signFile(file, publisher, { env = process.env, log } = {}) {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const identity = signingIdentity(env);   // BLOCKED first: what is missing to sign at all
  if (!isPortableExecutable(file)) throw new Error(`${file} is not a Windows executable`);
  if (roleOf(basename(file)).role === "third-party") throw new Error(`${basename(file)} is a third-party executable: its own signature is kept, PSO never signs it`);
  const before = readAuthenticode(file);
  if (before && before.status !== "NotSigned" && commonName(before.subject) !== publisher) throw new Error(`${basename(file)} is already signed by "${commonName(before.subject) ?? before.subject}" (${before.status}); it is not re-signed`);
  const signtool = findSigntool(env);
  if (!signtool) throw new Blocked("signtool.exe (Windows SDK) was not found: install the Windows SDK signing tools or set PSO_SIGNTOOL");
  const args = signArguments(file, identity, timestampUrl(env));
  const r = spawnSync(signtool, args, { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  const scrub = (t) => identity.secretArgs.filter((_, i) => i % 2 === 1).reduce((s, v) => s.split(v).join("<redacted>"), t ?? "");
  if (r.status !== 0) throw new Error(`signtool sign failed (exit ${r.status}) for ${basename(file)}: ${scrub(r.stdout + r.stderr).slice(-800)}\ncommand: signtool ${redact(args, identity).join(" ")}`);
  const pv = spawnSync(signtool, ["verify", "/pa", "/tw", "/v", file], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  const info = readAuthenticode(file);
  const j = judgeSignature(info, publisher);
  const entry = { file: basename(file), path: file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), identity: identity.kind, signer: info ? commonName(info.subject) : null, thumbprint: info?.thumbprint ?? null, status: info?.status ?? "unreadable", timestamped: !!info?.timestamped, signtoolVerify: pv.status === 0, ok: j.ok && pv.status === 0, reason: pv.status === 0 ? j.reason : `signtool verify /pa refused it: ${(pv.stdout + pv.stderr).slice(-300)}`, at: new Date().toISOString() };
  if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
  if (!entry.ok) throw new Error(`${basename(file)} was signed but does not verify: ${entry.reason}`);
  return entry;
}

// ---------------------------------------------------------------- command line
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2), cmd = argv[0];
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const all = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]] : []));
  const publisher = flag("publisher");
  try {
    if (cmd === "check") {
      const id = signingIdentity(); const st = findSigntool(); timestampUrl();
      if (!st) throw new Blocked("signtool.exe (Windows SDK) was not found: install the Windows SDK signing tools or set PSO_SIGNTOOL");
      console.log(`READY    signing identity: ${id.description}; signtool: ${st}; timestamp: ${timestampUrl()} (RFC 3161, SHA-256)`);
    } else if (cmd === "sign") {
      if (!flag("file") || !publisher) throw new Error("usage: codesign.mjs sign --file <file> --publisher <certificate common name> [--log <file.jsonl>]");
      const e = signFile(resolve(flag("file")), publisher, { log: flag("log") && resolve(flag("log")) });
      console.log(`SIGNED   ${e.file}: ${e.reason}; timestamped; sha256 ${e.sha256}`);
    } else if (cmd === "verify") {
      if (!flag("file") || !publisher) throw new Error("usage: codesign.mjs verify --file <file> --publisher <certificate common name>");
      const j = judgeExecutable(basename(flag("file")), readAuthenticode(resolve(flag("file"))), publisher);
      console.log(`${j.ok ? "VERIFIED" : "REFUSED "} ${flag("file")}: ${j.reason}`); process.exitCode = j.ok ? 0 : 1;
    } else if (cmd === "gate") {
      const dirs = all("dir");
      if (!dirs.length || !publisher) throw new Error("usage: codesign.mjs gate --dir <dir> [--dir <dir>...] --publisher <certificate common name> [--json]");
      const d = gate(dirs, publisher);
      if (argv.includes("--json")) console.log(JSON.stringify(d, null, 2));
      else {
        console.log(`${d.ok ? "PASSED" : "FAILED"}   Authenticode gate: ${d.executables} executable(s) (${d.pso} PSO-owned, ${d.thirdParty} third-party)`);
        for (const f of d.failures) console.log(`  REFUSED ${f.file}: ${f.reason}`);
      }
      process.exitCode = d.ok ? 0 : 1;
    } else throw new Error("usage: codesign.mjs check | sign --file <f> --publisher <CN> | verify --file <f> --publisher <CN> | gate --dir <d> --publisher <CN>");
  } catch (e) {
    console.error(`${e instanceof Blocked ? "BLOCKED" : "ERROR"}: ${e.message}`);
    process.exitCode = e instanceof Blocked ? 3 : 1;
  }
}
