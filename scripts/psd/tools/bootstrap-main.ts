// pso-bootstrap: the ONLY code the installer runs from plaintext. It contains no PSO CLI, deployment engine, Studio, policy engine or templates:
// just what is needed to verify a signed package, find the recipient identity, decrypt, extract safely and activate the installation.
//
//   node pso-bootstrap.mjs install --package <file.psopkg> --root <dir> --trust <release.public.pem> [--expect-signer <sha256 hex>] [--json]
//   node pso-bootstrap.mjs fingerprint <public.pem>
//
// Trust anchor: the signing key shipped inside an installer is NOT a trust anchor (whoever replaces the package can replace the key). The signer must
// be accepted by something established independently: a fingerprint the developer pinned when enrolling (pso-recipient pin-signer), or one given
// explicitly with --expect-signer, or the signer an existing installation already trusts (updates). With none of these, installation is refused.
// check-anchor tells the installer whether its fingerprint page can be skipped; --pin-signer remembers a fingerprint the person typed.
import { createPublicKey } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PsopkgError, fingerprintOf, readHeader, type TrustedKey } from "../../../packages/cli/src/psopkg.ts";
import { verifyAuthenticode } from "./authenticode.ts";
import { InstallError, installPackage } from "../../../packages/cli/src/install.ts";
import { RecipientError, defaultStoreDir, fullFingerprint, groupFingerprint, identityExists, loadPrivateKeyPem, normalizeFingerprint, pinSigner, pinnedSigners, readIdentity } from "../../../packages/cli/src/recipient-store.ts";

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const json = argv.includes("--json");
const say = (human: string, data: unknown): void => { console.log(json ? JSON.stringify(data) : human); };

class Refusal extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

type Anchor = "development" | "authenticode" | "typed" | "pinned" | "installed" | "none" | "mismatch" | "untrusted";
/**
 * Publisher trust backed by the operating system: the installer executable itself is Authenticode-signed by the expected publisher and Windows trusts the chain.
 * The package-signing key embedded in that executable is then authenticated as part of the signed artifact (any change to it breaks the signature). Only
 * evaluated when the installer names its own file and the expected publisher; an unsigned build never reaches it.
 */
function authenticodeOk(): boolean {
  const exe = flag("setup-exe"), publisher = flag("publisher");
  if (!exe || !publisher || !existsSync(exe)) return false;
  return verifyAuthenticode(exe, publisher).ok;
}
/** What independently vouches for `signerFp`: a fingerprint given now, a pin the developer made earlier, or the signer an existing installation already trusts. */
function anchorOf(signerFp: string, root: string, expected: string | undefined): Anchor {
  if (expected !== undefined) {
    const e = normalizeFingerprint(expected);
    if (!/^[0-9a-f]{64}$/.test(e)) throw new Refusal("FINGERPRINT_INVALID", "the signer fingerprint must be the 64 hexadecimal characters of the SHA-256 of the signing key (spaces and colons are fine)");
    return e === signerFp ? "typed" : "mismatch"; // an explicit statement that contradicts the key is never overridden by an older pin
  }
  if (pinnedSigners().some((p) => p.fingerprint === signerFp)) return "pinned";
  if (authenticodeOk()) return "authenticode";
  const dir = join(root, ".pso-install", "trust");
  let other = pinnedSigners().length > 0;
  try { for (const f of readdirSync(dir)) if (f.endsWith(".public.pem")) { if (fullFingerprint(readFileSync(join(dir, f), "utf8")) === signerFp) return "installed"; other = true; } } catch { /* no installation here */ }
  if (other) return "untrusted"; // a machine or installation that already trusts something is NEVER downgraded to an unauthenticated distribution
  return argv.includes("--dev-distribution") ? "development" : "none";
}

/**
 * Development-distribution mode (explicitly experimental, unsigned alpha): with no independent anchor at all and nothing already trusted, the key inside the
 * installer is accepted so that a developer can install by double-click. This is trust on first use from an unauthenticated file: it protects against corruption and
 * against a LATER package signed by another key (the installation then trusts exactly this key), NOT against a file that was replaced before the first install.
 * It is recorded in the installation (distribution.json) and never applies where any signer is already trusted.
 */
const DEV_NOTICE = "UNSIGNED DEVELOPER ALPHA: the publisher of this installer was not authenticated by Windows or by an independent fingerprint. The package signature proves integrity against corruption and against a different later signer, not who produced the first file you ran.";

// the launcher is version independent: it reads the active version from the installation state, so updates and rollbacks need no change to PATH
const BS = String.fromCharCode(92); // a backslash, spelled so no editor or template can turn it into an escape
const LAUNCH_CMD = ["@echo off", "setlocal", `"%~dp0..${BS}runtime${BS}node.exe" "%~dp0pso-launch.mjs" %*`, "exit /b %ERRORLEVEL%", ""].join(String.fromCharCode(13, 10));
// the same launcher for POSIX shells on Windows (Git Bash, MSYS2), which do not resolve pso.cmd when `pso` is typed
const LAUNCH_SH = ["#!/bin/sh", "# PSO launcher for POSIX shells (Git Bash): runs the active PSO version with the private runtime. Generated by the installer.", 'here=$(cd "$(dirname "$0")" && pwd)', 'exec "$here/../runtime/node.exe" "$here/pso-launch.mjs" "$@"', ""].join(String.fromCharCode(10));
const LAUNCH_MJS = `// PSO launcher: runs the active PSO version with the private runtime. Generated by the installer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let current = null;
try { current = JSON.parse(readFileSync(join(root, ".pso-install", "install.json"), "utf8")).current; } catch { /* reported below */ }
if (typeof current !== "string" || !/^[0-9A-Za-z.+-]+$/.test(current)) { console.error("PSO has no active version in " + root + ". Run the installer again, or: pso repair --root " + root); process.exit(1); }
// the installation this launcher belongs to: the maintenance commands (integrity, repair, update, uninstall) use it when neither --root nor PSO_HOME is given
process.env.PSO_LAUNCHED_FROM = root;
await import(pathToFileURL(join(root, "versions", current, "node_modules", "@pso", "cli", "bin", "pso.js")).href);
`;
function writeAtomic(file: string, data: string | Buffer): void { mkdirSync(join(file, ".."), { recursive: true }); const t = `${file}.${process.pid}.tmp`; writeFileSync(t, data); renameSync(t, file); }
/** the private runtime is the very node.exe that runs this bootstrap (shipped inside the installer); it is never placed on PATH or registered globally */
function provisionRuntimeAndLaunchers(root: string): string[] {
  const notes: string[] = [];
  writeAtomic(join(root, "bin", "pso.cmd"), LAUNCH_CMD);
  writeAtomic(join(root, "bin", "pso-launch.mjs"), LAUNCH_MJS);
  writeAtomic(join(root, "bin", "pso"), LAUNCH_SH);
  if (argv.includes("--bundle-runtime")) {
    const dest = join(root, "runtime", "node.exe");
    mkdirSync(join(root, "runtime"), { recursive: true });
    try { const t = `${dest}.${process.pid}.tmp`; copyFileSync(process.execPath, t); if (statSync(t).size !== statSync(process.execPath).size) throw new Error("size"); renameSync(t, dest); }
    catch (e) { if (!existsSync(dest)) throw new Refusal("RUNTIME_COPY", `the private Node.js runtime could not be installed (${(e as Error).message})`); notes.push("the existing private runtime is in use and was kept"); }
  }
  return notes;
}

function install(): number {
  const pkg = flag("package"), root = flag("root"), trust = flag("trust");
  if (!pkg || !root || !trust) throw new Refusal("USAGE", "install needs --package, --root and --trust");
  if (!existsSync(pkg)) throw new Refusal("PACKAGE_MISSING", `package not found: ${pkg}`);
  if (!existsSync(trust)) throw new Refusal("TRUST_MISSING", `signing key not found: ${trust}`);
  const pem = readFileSync(trust, "utf8");
  let signerFp: string;
  try { createPublicKey(pem); signerFp = fullFingerprint(pem); } catch { throw new Refusal("TRUST_INVALID", "the signing key in the installer is not a valid public key"); }

  // 1. the independent anchor (never the key that travels inside the installer)
  const expected = flag("expect-signer");
  const anchor = anchorOf(signerFp, resolve(root), expected);
  if (anchor === "none") throw new Refusal("NO_TRUST_ANCHOR", `PSO could not verify who published this installer (it is not signed by a publisher Windows trusts, and no fingerprint was given), so it will not install it. The signing key inside this installer is ${groupFingerprint(signerFp)}. Get the signing fingerprint from the maintainer through a DIFFERENT channel than the one that delivered this installer (the release notes page, a call, a message) and then either: type it into the installer's "Publisher key" page; or run the installer with /SIGNER=<fingerprint>; or pin it first with "node pso-recipient.mjs pin-signer --fingerprint <fingerprint>". Nothing was installed.`);
  if (anchor === "mismatch") throw new Refusal("SIGNER_MISMATCH", `the fingerprint you gave (${groupFingerprint(normalizeFingerprint(expected ?? ""))}) is not the one of this installer's signing key (${groupFingerprint(signerFp)}). Either the installer was replaced or modified, or the fingerprint was copied wrongly. Do not install; ask the maintainer. Nothing was installed.`);
  if (anchor === "untrusted") throw new Refusal("SIGNER_NOT_TRUSTED", `this installer is signed by ${groupFingerprint(signerFp)}, which is not a signer you pinned, that your installation already trusts, or that you gave. It may have been tampered with or replaced, or the maintainer rotated the signing key: if the maintainer announced a new fingerprint through a separate channel, give that one. Nothing was installed.`);
  const trusted: TrustedKey[] = [{ id: fingerprintOf(pem), publicKeyPem: pem }];

  // 2. the signed envelope, before anything is decrypted
  const buf = readFileSync(pkg);
  const { header } = readHeader(buf, trusted);

  // 3. authorization: is this identity one of the recipients?
  let provider: (() => string) | undefined;
  if (header.encryption) {
    if (!identityExists()) throw new Refusal("NO_IDENTITY", `this release is encrypted for specific developers and you have no recipient identity (${defaultStoreDir()}). Run pso-recipient init, send the enrollment file to the maintainer and ask for a release that includes you.`);
    const id = readIdentity();
    if (!header.encryption.recipients.some((r) => r.id === id.keyId)) throw new Refusal("NOT_AUTHORIZED", `this release was not encrypted for your key (${groupFingerprint(id.fingerprint)}). Ask the maintainer to authorize it for the release you are installing. Nothing was decrypted.`);
    provider = () => loadPrivateKeyPem();
  }

  // 4. decrypt, extract and activate (verification of every file happens before the first byte is written)
  // a refusal or failure must not leave a half-made installation root behind: remove it when this run is the one that created it
  const rootAbs = resolve(root), rootExisted = existsSync(rootAbs);
  let r: ReturnType<typeof installPackage>;
  let notes: string[] = [];
  try {
    r = installPackage({ root: rootAbs, packageFile: resolve(pkg), trustedKeys: trusted, ...(provider ? { recipientKeyProvider: provider } : {}) });
    notes = provisionRuntimeAndLaunchers(rootAbs);
    if (anchor === "development") writeAtomic(join(rootAbs, ".pso-install", "distribution.json"), JSON.stringify({ schema: 1, mode: "development-unsigned", publisherClaim: "PSO Web Framework (maintainer DevMboo), NOT verified", signer: signerFp, notice: DEV_NOTICE, installedAt: new Date().toISOString() }, null, 2));
  } catch (e) { if (!rootExisted) { try { rmSync(rootAbs, { recursive: true, force: true }); } catch { /* reported by the caller's failure anyway */ } } throw e; }
  // remembering the signer is an explicit request (a ticked box or --pin-signer), and only for a fingerprint the person gave
  if (argv.includes("--pin-signer") && anchor === "typed") pinSigner({ fingerprint: signerFp, label: "PSO release signer (confirmed at install)" });
  say(`installed ${r.version} (${r.files} file(s)) into ${resolve(root)}${r.activated ? "" : " (not activated)"}`, { ok: true, ...r, root: resolve(root), signer: signerFp, encrypted: !!header.encryption, anchor, ...(notes.length ? { notes } : {}) });
  return 0;
}

function main(): number {
  switch (argv[0]) {
    case "install": return install();
    case "check-anchor": {
      // note: the development mode is deliberately NOT an anchor here (a page that skips itself must rest on something independent)
      // exit 0 when this installer's key is already vouched for independently (a pin or the existing installation); the installer then skips the fingerprint page
      const trust = flag("trust"), root = flag("root");
      if (!trust || !root || !existsSync(trust)) return 1;
      let fp: string;
      try { fp = fullFingerprint(readFileSync(trust, "utf8")); } catch { return 1; }
      const a = anchorOf(fp, resolve(root), undefined);
      return a === "pinned" || a === "installed" || a === "authenticode" ? 0 : 1;
    }
    case "fingerprint": {
      const f = argv[1];
      if (!f || !existsSync(f)) throw new Refusal("USAGE", "fingerprint <public.pem>");
      const fp = fullFingerprint(readFileSync(f, "utf8"));
      say(groupFingerprint(fp), { fingerprint: fp });
      return 0;
    }
    default: console.log("pso-bootstrap install --package <file> --root <dir> --trust <public.pem> [--expect-signer <fp>] [--pin-signer] [--dev-distribution] [--bundle-runtime] [--json] | check-anchor --trust <public.pem> --root <dir> | fingerprint <public.pem>"); return 2;
  }
}

try { process.exitCode = main(); }
catch (e) {
  const code = e instanceof Refusal || e instanceof PsopkgError || e instanceof InstallError || e instanceof RecipientError ? (e as { code: string }).code : "UNEXPECTED";
  const msg = (e as Error).message;
  if (json) console.error(JSON.stringify({ ok: false, code, message: msg }));
  else console.error(`error: ${code}: ${msg}`);
  process.exitCode = code === "UNEXPECTED" ? 3 : 1;
}
