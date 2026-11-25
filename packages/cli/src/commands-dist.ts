import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { walkFiles } from "@pso/core";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, type Command, type Ctx } from "./commands.ts";
import { DENY_PATTERNS, PsopkgError, extractPackage, fingerprintOf, generateKeyPair, packStage, readHeader, verifyPackage, type PackageMeta, type TrustedKey } from "./psopkg.ts";

/**
 * `pso dist`: build a stage from an explicit allowlist, pack it into a signed (and optionally encrypted) .psopkg, verify, inspect, extract.
 * Keys are never created implicitly and never printed: the signing key is read from a file (--sign-key or PSO_DIST_SIGNING_KEY_FILE), recipients
 * and trusted signers are public keys.
 */
const wrap = <T>(f: () => T): T => {
  try { return f(); }
  catch (e) { if (e instanceof PsopkgError) throw new CliError(`${e.code}: ${e.message}`); throw e; }
};
const list = (v: string | boolean | undefined): string[] => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const readPem = (file: string, what: string): string => {
  if (!existsSync(file)) throw new CliError(`${what} not found: ${file}`);
  return readFileSync(file, "utf8");
};

function trustedFrom(ctx: Ctx): TrustedKey[] {
  const files = list(ctx.flags["trust"]).concat(list(process.env["PSO_DIST_TRUST"]));
  if (files.length === 0) throw new CliError("no trusted signing key", "Pass --trust <public-key.pem[,more]> (or set PSO_DIST_TRUST): a package is only accepted when signed by a key you trust");
  return files.map((f) => { const pem = readPem(f, "trusted key"); return { id: wrap(() => fingerprintOf(pem)), publicKeyPem: pem }; });
}

interface DistConfig {
  name: string; version: string; platform: string; arch: string; revision?: string;
  components: Array<{ name: string; version: string; include: Array<{ from: string; to: string }> }>;
  dependencies?: Array<{ name: string; range: string }>; installRules?: Record<string, unknown>;
}

function loadConfig(ctx: Ctx): { cfg: DistConfig; root: string } {
  const file = resolve(ctx.cwd, str(ctx.flags["config"]) ?? "dist.config.json");
  if (!existsSync(file)) throw new CliError(`dist configuration not found: ${file}`, 'Create dist.config.json: { "name", "version", "platform", "arch", "components": [{ "name", "version", "include": [{ "from", "to" }] }] }');
  let cfg: DistConfig;
  try { cfg = JSON.parse(readFileSync(file, "utf8")) as DistConfig; } catch { throw new CliError("dist.config.json is not valid JSON"); }
  const problems: string[] = [];
  for (const k of ["name", "version", "platform", "arch"] as const) if (typeof cfg[k] !== "string" || !cfg[k]) problems.push(`${k} is required`);
  if (!Array.isArray(cfg.components) || cfg.components.length === 0) problems.push("at least one component is required");
  for (const c of cfg.components ?? []) {
    if (!c.name || !c.version || !Array.isArray(c.include) || c.include.length === 0) problems.push(`component "${c.name ?? "?"}" needs name, version and a non-empty include allowlist`);
    for (const i of c.include ?? []) if (!i.from || !i.to || i.to.startsWith("/") || i.to.includes("..")) problems.push(`component "${c.name}": include entries need "from" and a relative "to" without ".."`);
  }
  if (problems.length) throw new CliError(`invalid dist.config.json:\n - ${problems.join("\n - ")}`);
  return { cfg, root: dirname(file) };
}

export const DIST_COMMANDS: Record<string, Command> = {
  dist: {
    usage: "pso dist keygen --kind <signing|recipient> --out <dir> [--name <name>] | build [--config <file>] [--out <stage>] | pack --stage <dir> --sign-key <file> [--config <file>] [--out <file.psopkg>] [--encrypt --recipient <public.pem[,more]>] | verify <file> --trust <public.pem[,more]> [--key <recipient-private.pem>] | inspect <file> --trust <public.pem> | extract <file> --to <dir> --trust <public.pem> [--key <recipient-private.pem>] [--overwrite] | installer --platform windows --package <file.psopkg> --bootstrap <pso-bootstrap.mjs> --trust <release.public.pem> [--name <file name>] [--out <dir>] [--publisher <certificate common name> [--sign-command <command with $f> | --signed-uninstaller-dir <dir>] [--app-publisher <name>] | --dev-distribution] [--runtime <node.exe> --runtime-license <file>] [--json]",
    summary: "Build, sign, encrypt, verify and extract signed .psopkg distribution packages from an explicit allowlist",
    run(ctx) {
      const sub = ctx.positionals[0];
      switch (sub) {
        case "keygen": return keygen(ctx);
        case "build": return build(ctx);
        case "pack": return pack(ctx);
        case "verify": return verify(ctx);
        case "inspect": return inspect(ctx);
        case "extract": return extract(ctx);
        case "installer": return installer(ctx);
        default: throw new CliError(`Unknown dist command "${sub ?? ""}"`, "Use: keygen | build | pack | verify | inspect | extract | installer");
      }
    },
  },
};

function keygen(ctx: Ctx): number {
  const kind = str(ctx.flags["kind"]);
  if (kind !== "signing" && kind !== "recipient") throw new CliError("--kind must be signing or recipient");
  const out = resolve(ctx.cwd, str(ctx.flags["out"]) ?? "");
  if (!str(ctx.flags["out"])) throw new CliError("--out <directory> is required", "Choose a directory outside the repository (private keys must not be committed)");
  const name = str(ctx.flags["name"]) ?? kind;
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(name)) throw new CliError("--name may contain letters, digits, dot, underscore and hyphen");
  const priv = join(out, `${name}.private.pem`), pub = join(out, `${name}.public.pem`);
  if (existsSync(priv) || existsSync(pub)) throw new CliError(`${name}.private.pem or ${name}.public.pem already exists`, "Keys are never overwritten; choose another --name");
  const kp = generateKeyPair(kind);
  mkdirSync(out, { recursive: true });
  writeFileSync(priv, kp.privateKeyPem, { mode: 0o600 });
  try { chmodSync(priv, 0o600); } catch { /* Windows: ACLs are inherited from the directory */ }
  writeFileSync(pub, kp.publicKeyPem);
  emit(ctx, { kind, id: kp.id, privateKey: priv, publicKey: pub }, `${kind} key ${kp.id}\n  private: ${priv}  (keep it secret; it is never printed)\n  public:  ${pub}`);
  return 0;
}

function build(ctx: Ctx): number {
  const { cfg, root } = loadConfig(ctx);
  const stage = resolve(ctx.cwd, str(ctx.flags["out"]) ?? join("dist", "stage"));
  if (existsSync(stage) && walkFiles(stage).files.length > 0) throw new CliError(`the stage directory is not empty: ${stage}`, "Choose an empty --out so stale files can never end up in a package");
  mkdirSync(stage, { recursive: true });
  let copied = 0;
  const excluded: string[] = [];
  const links: string[] = [];
  for (const c of cfg.components) {
    for (const inc of c.include) {
      const from = resolve(root, inc.from);
      if (relative(root, from).startsWith("..")) throw new CliError(`"${inc.from}" is outside the project; only paths below ${root} can be included`);
      if (!existsSync(from)) throw new CliError(`allowlisted path not found: ${inc.from}`);
      const real = realpathSync(from);
      if (relative(realpathSync(root), real).startsWith("..")) throw new CliError(`"${inc.from}" resolves outside the project (a link?); refusing to include it`);
      const files = statSync(real).isDirectory() ? walkFiles(real, { ignore: new Set([".git", "node_modules", ".pso"]) }) : { files: [real], issues: [] };
      for (const i of files.issues) if (i.code === "PSO_FS_SYMLINK_SKIPPED") links.push(relative(root, i.path).split(sep).join("/"));
      for (const f of files.files) {
        const rel = statSync(real).isDirectory() ? relative(real, f).split(sep).join("/") : basename(f);
        const dest = `${inc.to.replace(/\/+$/, "")}/${rel}`.replace(/^\/+/, "");
        if (DENY_PATTERNS.some((re) => re.test(dest) || re.test(rel))) { excluded.push(dest); continue; }
        const target = join(stage, ...dest.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(f, target);
        copied++;
      }
    }
  }
  if (copied === 0) throw new CliError("nothing was staged: every allowlisted path was empty or excluded");
  emit(ctx, { stage, files: copied, excluded, skippedLinks: links }, `staged ${copied} file(s) into ${stage}${excluded.length ? `\nexcluded as sensitive: ${excluded.length} file(s)` : ""}${links.length ? `\nsymbolic links not followed: ${links.length}` : ""}`);
  return 0;
}

function pack(ctx: Ctx): number {
  const { cfg } = loadConfig(ctx);
  const stage = str(ctx.flags["stage"]);
  if (!stage) throw new CliError("--stage <directory> is required", "Run `pso dist build` first");
  const keyFile = str(ctx.flags["sign-key"]) ?? process.env["PSO_DIST_SIGNING_KEY_FILE"];
  if (!keyFile) throw new CliError("no signing key", "Pass --sign-key <private.pem> (or set PSO_DIST_SIGNING_KEY_FILE). Create one with `pso dist keygen --kind signing --out <dir>`; it must not live in the repository");
  const encrypt = ctx.flags["encrypt"] === true;
  const recipients = list(ctx.flags["recipient"]).map((f) => ({ publicKeyPem: readPem(f, "recipient key") }));
  if (encrypt && recipients.length === 0) throw new CliError("--encrypt needs at least one --recipient <public.pem>", "There is no universal key: the content key is wrapped for each recipient");
  if (!encrypt && recipients.length > 0) throw new CliError("--recipient given without --encrypt");
  const meta: PackageMeta = { name: cfg.name, version: cfg.version, ...(cfg.revision ? { revision: cfg.revision } : {}), platform: cfg.platform, arch: cfg.arch, components: cfg.components.map((c) => ({ name: c.name, version: c.version })), dependencies: cfg.dependencies ?? [], installRules: cfg.installRules ?? {} };
  const componentOf = cfg.components.flatMap((c) => c.include.map((i) => ({ prefix: `${i.to.replace(/\/+$/, "")}/`, component: c.name })));
  const buf = wrap(() => packStage({ stageDir: resolve(ctx.cwd, stage), meta, signingKeyPem: readPem(resolve(ctx.cwd, keyFile), "signing key"), ...(encrypt ? { recipients } : {}), componentOf }));
  const out = resolve(ctx.cwd, str(ctx.flags["out"]) ?? `${cfg.name}-${cfg.version}-${cfg.platform}-${cfg.arch}.psopkg`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  emit(ctx, { package: out, bytes: buf.length, encrypted: encrypt, recipients: recipients.length }, `wrote ${out} (${buf.length} bytes, ${encrypt ? `encrypted for ${recipients.length} recipient(s)` : "not encrypted"}, signed)`);
  return 0;
}

function loadPackage(ctx: Ctx): Buffer {
  const f = ctx.positionals[1];
  if (!f) throw new CliError("a package file is required");
  const p = resolve(ctx.cwd, f);
  if (!existsSync(p)) throw new CliError(`package not found: ${p}`);
  return readFileSync(p);
}
const recipientKey = (ctx: Ctx): string | undefined => { const k = str(ctx.flags["key"]); return k ? readPem(resolve(ctx.cwd, k), "recipient key") : undefined; };

function verify(ctx: Ctx): number {
  const buf = loadPackage(ctx);
  const rk = recipientKey(ctx);
  const v = wrap(() => verifyPackage(buf, { trustedKeys: trustedFrom(ctx), ...(rk ? { recipientKeyPem: rk } : {}) }));
  const h = v.header;
  emit(ctx, { ok: true, name: h.name, version: h.version, platform: h.platform, arch: h.arch, files: h.files.length, encrypted: v.encrypted, contentsVerified: v.contentsVerified, signer: v.signer },
    `OK  ${h.name} ${h.version} (${h.platform}/${h.arch}), ${h.files.length} file(s), signed by ${v.signer}\n${v.contentsVerified ? "every file was decompressed and its SHA-256 checked" : "encrypted: the signature and header are verified; the contents were NOT checked (pass --key <recipient private key> to verify them)"}`);
  return 0;
}

function inspect(ctx: Ctx): number {
  const { header: h, signer } = wrap(() => readHeader(loadPackage(ctx), trustedFrom(ctx)));
  emit(ctx, { name: h.name, version: h.version, revision: h.revision ?? null, platform: h.platform, arch: h.arch, createdAt: h.createdAt, signer, encrypted: !!h.encryption, recipients: h.encryption?.recipients.map((r) => r.id) ?? [], components: h.components, dependencies: h.dependencies ?? [], files: h.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, component: f.component ?? null })) },
    `${h.name} ${h.version} (${h.platform}/${h.arch}) signed by ${signer}\ncomponents: ${h.components.map((c) => `${c.name}@${c.version}`).join(", ")}\n${h.encryption ? `encrypted for ${h.encryption.recipients.length} recipient(s)` : "not encrypted"}\n${h.files.length} file(s)`);
  return 0;
}

function extract(ctx: Ctx): number {
  const to = str(ctx.flags["to"]);
  if (!to) throw new CliError("--to <directory> is required");
  const buf = loadPackage(ctx);
  const rk = recipientKey(ctx);
  const r = wrap(() => extractPackage(buf, resolve(ctx.cwd, to), { trustedKeys: trustedFrom(ctx), ...(rk ? { recipientKeyPem: rk } : {}), overwrite: ctx.flags["overwrite"] === true }));
  emit(ctx, { to: resolve(ctx.cwd, to), files: r.files, bytes: r.bytes }, `extracted ${r.files} file(s) (${r.bytes} bytes) into ${resolve(ctx.cwd, to)}`);
  return 0;
}

/** Locates ISCC.exe: $ISCC, then Inno Setup 7 and 6 in the usual per-machine locations. Any compatible version works. */
export function findIscc(): string | null {
  const pf = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"].filter((x): x is string => !!x);
  const cands = [process.env["ISCC"], ...["7", "6"].flatMap((v) => pf.map((p) => join(p, `Inno Setup ${v}`, "ISCC.exe")))];
  return cands.find((x): x is string => !!x && existsSync(x)) ?? null;
}
const iss = (s: string): string => s;

/** SHA-256 of the SPKI of a public key, 64 hex characters: what a person compares out of band. */
const signerFingerprint = (pem: string): string => createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");

/**
 * The Windows installer is produced with Inno Setup. It carries exactly three things: the signed (and, for a private release, encrypted)
 * .psopkg, the PUBLIC signing key, and `pso-bootstrap.mjs`, a single small file that verifies the package against an independently established signer,
 * finds the developer's recipient identity, decrypts, extracts safely and activates the installation. It does NOT carry the PSO CLI or any other
 * proprietary component outside the package: before PSD it copied the whole staged CLI in plaintext into a temporary folder, which made
 * the package encryption pointless. The installed layout is the one `pso integrity|repair|update|uninstall` manage. Node.js 24+ is required
 * on the target machine and is detected before anything is installed. The result is NOT code-signed.
 */
function installer(ctx: Ctx): number {
  if (str(ctx.flags["platform"]) !== "windows") throw new CliError("--platform windows is the only supported installer platform");
  if (ctx.flags["stage"] !== undefined) throw new CliError("--stage is no longer accepted: the installer does not carry a staged CLI", "The installer carries the signed package and the small bootstrap only. Pass --bootstrap <pso-bootstrap.mjs> (scripts/psd/build-tools.mjs builds it)");
  const out = resolve(ctx.cwd, str(ctx.flags["out"]) ?? join("dist", "installer"));
  const pkg = str(ctx.flags["package"]), bootstrap = str(ctx.flags["bootstrap"]);
  const trustFiles = list(ctx.flags["trust"]);
  const version = pkg ? wrap(() => readHeader(readFileSync(resolve(ctx.cwd, pkg)), trustedFrom(ctx)).header.version) : "0.0.0";
  const name = "PSO Web Framework";
  const baseName = str(ctx.flags["name"]) ?? `pso-setup-${version}-unsigned`;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(baseName)) throw new CliError("--name may contain letters, digits, dot, underscore and hyphen");
  if (trustFiles.length !== 1) throw new CliError("exactly one --trust <public.pem> is required: the release signing key the installer verifies", "The developer's pinned signer must match it; the installer shows its fingerprint");
  mkdirSync(join(out, "trust"), { recursive: true });
  const trustPem = readPem(resolve(ctx.cwd, trustFiles[0]!), "trusted key");
  if (/PRIVATE KEY/.test(trustPem)) throw new CliError("the --trust file contains a private key; refusing to embed it in an installer");
  writeFileSync(join(out, "trust", "release.public.pem"), trustPem);
  const fingerprint = wrap(() => signerFingerprint(trustPem));
  const grouped = fingerprint.replace(/(.{4})/g, "$1 ").trim();
  const pkgAbs = pkg ? resolve(ctx.cwd, pkg) : join(out, "pso.psopkg"), bootAbs = bootstrap ? resolve(ctx.cwd, bootstrap) : join(out, "pso-bootstrap.mjs");
  const pkgFile = basename(pkgAbs);
  // the expected Authenticode publisher: when the finished installer is signed by it and Windows trusts the chain, no fingerprint page is needed
  const publisher = str(ctx.flags["publisher"]);
  if (publisher !== undefined && !/^[A-Za-z0-9 .,&_-]{2,80}$/.test(publisher)) throw new CliError("--publisher must be the certificate's common name (letters, digits, space and . , & _ -)");
  // development distribution (unsigned alpha): no publisher authentication, explicit notice, never applies where a signer is already trusted
  const devMode = ctx.flags["dev-distribution"] === true;
  if (devMode && publisher !== undefined) throw new CliError("--dev-distribution and --publisher exclude each other: a development distribution is not publisher-authenticated");
  // Authenticode: Inno Setup runs this command (its "$f" is the quoted file) on the uninstaller while compiling and on the finished installer,
  // before the file is written; the command must sign with SHA-256 and an RFC 3161 timestamp (scripts/psd/codesign.mjs sign). The publisher it
  // signs for is the one the bootstrap requires, so a signed installer needs --publisher; a development distribution is never signed.
  const signCommand = str(ctx.flags["sign-command"]);
  if (signCommand !== undefined) {
    if (devMode) throw new CliError("--sign-command and --dev-distribution exclude each other: a development distribution is unsigned by design");
    if (publisher === undefined) throw new CliError("--sign-command needs --publisher <certificate common name>: the installer verifies that publisher at run time");
    if (!signCommand.includes("$f")) throw new CliError("--sign-command must contain $f (Inno Setup replaces it with the quoted file to sign)");
    if (/[\r\n]/.test(signCommand)) throw new CliError("--sign-command must be one line");
  }
  // Remote signing (SignPath and similar services, one approved request per artifact): Inno Setup does not call a local sign tool. Its
  // uninstaller, which is also the temporary self-copy Setup runs from TEMP, is taken already signed from this directory. When it is not
  // there yet, Inno writes the unsigned file to sign (uninst-<version>-<hash>.e32.tmp) and stops; the signed file, renamed without ".tmp",
  // is reused by every later build with the same Inno Setup version. The finished installer is then signed as a second artifact.
  const signedUninstallerDir = str(ctx.flags["signed-uninstaller-dir"]);
  if (signedUninstallerDir !== undefined) {
    if (signCommand !== undefined) throw new CliError("--signed-uninstaller-dir and --sign-command exclude each other: the uninstaller is either signed by a local sign tool while compiling or supplied already signed");
    if (devMode) throw new CliError("--signed-uninstaller-dir and --dev-distribution exclude each other: a development distribution is unsigned by design");
    if (publisher === undefined) throw new CliError("--signed-uninstaller-dir needs --publisher <certificate common name>: the installer verifies that publisher at run time");
  }
  const signedUninstallerAbs = signedUninstallerDir ? resolve(ctx.cwd, signedUninstallerDir) : undefined;
  if (signedUninstallerAbs) mkdirSync(signedUninstallerAbs, { recursive: true });
  // version metadata of the installer, its uninstaller and self-copies: the same product name and version in every file (code-signing services
  // enforce it). The numeric file version is major.minor.patch.0; the text versions carry the full label (0.2.0-rc.3).
  const appPublisher = str(ctx.flags["app-publisher"]) ?? "DevMboo";
  if (!/^[A-Za-z0-9 .,&()_-]{2,80}$/.test(appPublisher)) throw new CliError("--app-publisher may contain letters, digits, space and . , & ( ) _ -");
  const numericVersion = `${(/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0", "0"]).slice(1).join(".")}.0`;
  const runtimeFlag = str(ctx.flags["runtime"]), runtimeLicenseFlag = str(ctx.flags["runtime-license"]);
  if ((runtimeFlag === undefined) !== (runtimeLicenseFlag === undefined)) throw new CliError("--runtime and --runtime-license go together: the runtime's licence is installed with it");
  const runtimeAbs = runtimeFlag ? resolve(ctx.cwd, runtimeFlag) : undefined, runtimeLicAbs = runtimeLicenseFlag ? resolve(ctx.cwd, runtimeLicenseFlag) : undefined;
  if (runtimeAbs && (!existsSync(runtimeAbs) || !existsSync(runtimeLicAbs!))) throw new CliError("--runtime or --runtime-license does not exist");
  const bundled = runtimeAbs !== undefined;
  const script = String.raw`; Generated by pso dist installer. Compatible with Inno Setup 6 and 7 (ISCC.exe). Carries the signed .psopkg, ONE public key and the small bootstrap only. ${signCommand ? `Authenticode-signed (installer and uninstaller) for the publisher "${publisher}" through the sign tool "psosign"` : "NOT code-signed"}.
#define AppVer "${version}"
[Setup]
AppId={{B2E1F6A3-7C34-4D0E-9A55-3C1D8A9F0001}
AppName=${name}
AppVersion={#AppVer}
AppPublisher=${appPublisher}
VersionInfoProductName=${name}
VersionInfoProductVersion=${numericVersion}
VersionInfoProductTextVersion={#AppVer}
VersionInfoVersion=${numericVersion}
VersionInfoTextVersion={#AppVer}
VersionInfoCompany=${appPublisher}
VersionInfoDescription=${name} Setup
VersionInfoCopyright=Copyright 2026 DevMboo. Licensed under the Apache License 2.0
AppPublisherURL=https://devmboo.github.io/pso-web-docs/
AppSupportURL=https://devmboo.github.io/pso-web-docs/
DefaultDirName={autopf}\PSO
DefaultGroupName=${name}
OutputDir=${iss(out)}
OutputBaseFilename=${baseName}
; per-user on purpose: the developer's recipient key is protected for ONE Windows account (DPAPI), so the installer must run as that account
PrivilegesRequired=lowest
Compression=lzma2/max
SolidCompression=yes
DisableProgramGroupPage=yes
UninstallDisplayName=${name} {#AppVer}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes${signCommand ? "\nSignTool=psosign\nSignedUninstaller=yes\nSignToolRetryCount=2" : ""}${signedUninstallerAbs ? `\nSignedUninstaller=yes\nSignedUninstallerDir=${iss(signedUninstallerAbs)}` : ""}
[Tasks]
Name: "addpath"; Description: "Add PSO to my PATH (current user only) so that pso works in new terminals"
[Files]
; nothing is copied into the installation by Inno itself: the three files are extracted to the temporary folder on demand (dontcopy), the bootstrap
; verifies and installs from there, and PSO keeps its own authenticated copy of the package under .pso-install. The package is already compressed
; (zstd) and possibly encrypted: compressing it again only costs time.
Source: "${iss(pkgAbs)}"; DestDir: "{tmp}"; Flags: dontcopy nocompression
Source: "${iss(join(out, "trust", "release.public.pem"))}"; DestDir: "{tmp}"; Flags: dontcopy
Source: "${iss(bootAbs)}"; DestDir: "{tmp}"; Flags: dontcopy
${bundled ? String.raw`; the private Node.js runtime: extracted to the temporary folder to run the bootstrap, which then copies that very executable to {app}\runtime (never to PATH, never global); its licence is installed beside it
Source: "${iss(runtimeAbs!)}"; DestDir: "{tmp}"; DestName: "node.exe"; Flags: dontcopy
Source: "${iss(runtimeLicAbs!)}"; DestDir: "{app}\runtime"; DestName: "LICENSE-node.txt"` : ""}
[UninstallDelete]
; the launcher and the private runtime are created by the bootstrap, so Inno does not know them
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\runtime"
[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Tasks: addpath; Check: NeedsPath('{app}\bin')
[UninstallRun]
Filename: "{cmd}"; Parameters: "/D /S /C """"{code:UninstallNode}"" ""{code:CurrentCli}"" uninstall --complete --yes --root ""{app}"""""; Flags: runhidden waituntilterminated; RunOnceId: "PsoUninstall"
; the active version's CLI may itself be damaged and unable to uninstall: the previous version (kept side by side) can, because uninstall works from the signed inventories of every version
Filename: "{cmd}"; Parameters: "/D /S /C """"{code:UninstallNode}"" ""{code:PreviousCli}"" uninstall --complete --yes --root ""{app}"""""; Flags: runhidden waituntilterminated; Check: HasPreviousCli; RunOnceId: "PsoUninstallFallback"
[Code]
const SignerFingerprintRaw = '${fingerprint}';
      PublisherName = '${publisher ?? ""}';
      DevDistribution = '${devMode ? "1" : "0"}';
      BundledRuntime = '${bundled ? "1" : "0"}';
var
  FingerprintPage: TInputQueryWizardPage;
  RememberBox: TNewCheckBox;
  TypedFingerprint: string;
  NoticePage: TOutputMsgWizardPage;
  NoticeAccepted: Boolean;

{ the Node.js that runs the bootstrap: the private runtime inside the installer, or node on PATH for builds without one }
function NodeExe: string;
begin
  if BundledRuntime = '1' then
  begin
    ExtractTemporaryFile('node.exe');
    Result := ExpandConstant('{tmp}\node.exe');
  end
  else Result := 'node';
end;

{ at uninstall time: the private runtime of the installation, when there is one }
function UninstallNode(Param: string): string;
begin
  if FileExists(ExpandConstant('{app}\runtime\node.exe')) then Result := ExpandConstant('{app}\runtime\node.exe') else Result := 'node';
end;

{ keeps only hexadecimal characters, lower case: spaces, colons and line breaks from a copy/paste are ignored, and nothing else can reach the command line }
function NormalizeFp(S: string): string;
var I: Integer; C: Char;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if ((C >= '0') and (C <= '9')) or ((C >= 'a') and (C <= 'f')) then Result := Result + C
    else if (C >= 'A') and (C <= 'F') then Result := Result + Chr(Ord(C) + 32);
  end;
end;

function BootstrapExe(Args: string): Integer;
var Code: Integer;
begin
  ExtractTemporaryFile('release.public.pem');
  ExtractTemporaryFile('pso-bootstrap.mjs');
  if not Exec(ExpandConstant('{cmd}'), '/D /S /C ""' + NodeExe + '" "' + ExpandConstant('{tmp}\pso-bootstrap.mjs') + '" ' + Args + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then Code := 255;
  Result := Code;
end;

{ true when something independent of this installer already vouches for its signing key: a signer the developer pinned earlier, or the signer the existing installation trusts }
{ the publisher check is made by the bootstrap itself (Windows verifies this very file); it is only requested when this build names an expected publisher }
function PublisherArgs: string;
begin
  Result := '';
  if PublisherName <> '' then Result := ' --setup-exe "' + ExpandConstant('{srcexe}') + '" --publisher "' + PublisherName + '"';
end;

function AlreadyTrusted: Boolean;
begin
  Result := BootstrapExe('check-anchor --trust "' + ExpandConstant('{tmp}\release.public.pem') + '" --root "' + WizardDirValue + '"' + PublisherArgs) = 0;
end;

function NeedsPath(Param: string): Boolean;
var OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then begin Result := True; exit; end;
  Result := Pos(';' + Uppercase(ExpandConstant(Param)) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

function InitializeSetup(): Boolean;
var Code: Integer;
begin
  if BundledRuntime = '1' then begin Result := True; exit; end;
  Result := Exec(ExpandConstant('{cmd}'), '/C node -e "process.exit(Number(process.versions.node.split(''.'')[0])>=24?0:1)"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Result then SuppressibleMsgBox('PSO needs Node.js 24 or newer on PATH. Install it from https://nodejs.org and run this installer again. Nothing was installed.', mbCriticalError, MB_OK, IDOK);
end;

procedure InitializeWizard;
begin
  { First installation on a computer: nothing on this machine knows who the real publisher is, and the key inside this file proves nothing (whoever replaced the file could replace the key).
    So the person supplies the fingerprint they received from the maintainer through a different channel; the installer only checks that it matches. The fingerprint is deliberately NOT shown here. }
  FingerprintPage := CreateInputQueryPage(wpSelectDir, 'Confirm the publisher key', 'Check that this installer is the one the maintainer gave you',
    'PSO cannot tell by itself who made this installer. Enter the signing key fingerprint that the PSO maintainer gave you through a DIFFERENT channel than this download ' +
    '(the release page, a call or a message). It has 64 hexadecimal characters; spaces and colons are fine. If you do not have it, cancel and ask the maintainer: do not install without it.');
  if DevDistribution = '1' then
    NoticePage := CreateOutputMsgPage(wpWelcome, 'Unsigned developer alpha', 'Please read before you continue',
      'This is an EXPERIMENTAL, UNSIGNED developer alpha of PSO Web Framework, free and open-source software maintained by DevMboo (https://github.com/DevMboo).' + #13#10#13#10 +
      'Windows has NOT verified who published this installer: it has no Authenticode signature, so Windows may show an unknown-publisher warning. Do not dismiss that warning unless you obtained this file from the official PSO release page.' + #13#10#13#10 +
      'The installer still checks that the package is intact and signed, but the signing key travels inside this same file, so that check can NOT prove who made it. If this file was replaced before you ran it, nothing here would detect it. Compare the SHA-256 on the release page with the file you downloaded.' + #13#10#13#10 +
      'Once installed, PSO trusts only that key for its updates. Do not use this alpha on machines that need verified software. Click Next only if you accept these limits.');
  FingerprintPage.Add('Signing key fingerprint (SHA-256):', False);
  RememberBox := TNewCheckBox.Create(FingerprintPage);
  RememberBox.Parent := FingerprintPage.Surface;
  RememberBox.Left := 0;
  RememberBox.Top := FingerprintPage.Edits[0].Top + FingerprintPage.Edits[0].Height + ScaleY(14);
  RememberBox.Width := FingerprintPage.SurfaceWidth;
  RememberBox.Height := ScaleY(20);
  RememberBox.Caption := 'Remember this publisher key on this computer (later installers signed by it will not ask again)';
  RememberBox.Checked := False;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { silent installs never show the page: they are judged by /SIGNER=, a pin or the existing installation, in PrepareToInstall }
  if (PageID = FingerprintPage.ID) and (WizardSilent or (DevDistribution = '1') or AlreadyTrusted) then Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var Typed: string;
begin
  Result := True;
  if (DevDistribution = '1') and (not WizardSilent) and (CurPageID = NoticePage.ID) then NoticeAccepted := True;
  if (CurPageID <> FingerprintPage.ID) or WizardSilent then exit;
  Typed := NormalizeFp(FingerprintPage.Values[0]);
  if Length(Typed) <> 64 then
  begin
    MsgBox('The fingerprint must have exactly 64 hexadecimal characters (0-9, a-f). Copy it again from the message the maintainer sent you.', mbError, MB_OK);
    Result := False;
  end
  else if Typed <> SignerFingerprintRaw then
  begin
    MsgBox('The fingerprint you entered is NOT the signing key of this installer.' + #13#10#13#10 + 'Either this file was replaced or modified, or the fingerprint was copied wrongly. Do not install: download the installer again from the official release and ask the maintainer to confirm the fingerprint.', mbCriticalError, MB_OK);
    Result := False;
  end
  else TypedFingerprint := Typed;
end;

{ The installation is done HERE, before Inno installs anything: a refusal (untrusted signer, not authorized, damaged package) returns a message, Setup stops with a
  non-zero exit code and nothing is left behind, not even an uninstall entry. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; LogFile, Signer, Pin, Cmd: string; Tail: AnsiString; GivenOnCommandLine: Boolean;
begin
  Result := '';
  ExtractTemporaryFile('${pkgFile}');
  ExtractTemporaryFile('release.public.pem');
  ExtractTemporaryFile('pso-bootstrap.mjs');
  LogFile := ExpandConstant('{tmp}\pso-bootstrap.log');
  { the fingerprint comes from the wizard page, or from /SIGNER= for silent installs; both are reduced to hex digits before they reach the command line }
  Signer := TypedFingerprint;
  GivenOnCommandLine := (Signer = '') and (ExpandConstant('{param:SIGNER|}') <> '');
  if GivenOnCommandLine then Signer := NormalizeFp(ExpandConstant('{param:SIGNER|}'));
  if (Signer <> '') or GivenOnCommandLine then Signer := ' --expect-signer "' + Signer + '"';
  Pin := '';
  { the unsigned-alpha mode is only used after an explicit acknowledgement (the notice page, or /ACCEPTUNSIGNEDALPHA=1 for silent installs), and never together with a typed fingerprint }
  if (DevDistribution = '1') and (Signer = '') then
  begin
    if NoticeAccepted or (ExpandConstant('{param:ACCEPTUNSIGNEDALPHA|}') = '1') then Pin := ' --dev-distribution'
    else begin Result := 'This unsigned developer alpha needs your explicit acknowledgement of its security limits. Run the installer interactively and read the notice page, or pass /ACCEPTUNSIGNEDALPHA=1 (silent installs). PSO was not installed.'; exit; end;
  end;
  if BundledRuntime = '1' then Pin := Pin + ' --bundle-runtime';
  if ((TypedFingerprint <> '') and RememberBox.Checked) or (GivenOnCommandLine and (ExpandConstant('{param:PINSIGNER|}') = '1')) then Pin := Pin + ' --pin-signer';
  Cmd := '/D /S /C ""' + NodeExe + '" "' + ExpandConstant('{tmp}\pso-bootstrap.mjs') + '" install --package "' + ExpandConstant('{tmp}\') + '${pkgFile}' + '" --root "' + ExpandConstant('{app}') + '" --trust "' + ExpandConstant('{tmp}\release.public.pem') + '"' + Signer + Pin + PublisherArgs + ' > "' + LogFile + '" 2>&1"';
  if not Exec(ExpandConstant('{cmd}'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
  begin
    Result := 'PSO was not installed (the check stopped with code ' + IntToStr(Code) + ').';
    if LoadStringFromFile(LogFile, Tail) then Result := Result + #13#10#13#10 + Copy(string(Tail), 1, 1200);
    Log('PSO bootstrap failed: ' + Result);
  end;
  DeleteFile(LogFile);
end;

{ removes only this installation's entry from the current user's PATH; every other entry is left exactly as it is }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var P, Entry: string;
begin
  if CurUninstallStep <> usPostUninstall then exit;
  Entry := ExpandConstant('{app}\bin');
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', P) then exit;
  P := ';' + P + ';';
  StringChangeEx(P, ';' + Entry + ';', ';', True);
  { only the two separators added above are taken away: empty entries the user's PATH already had (such as a trailing ';') are kept, so the value is restored exactly }
  if Length(P) > 0 then Delete(P, 1, 1);
  if Length(P) > 0 then Delete(P, Length(P), 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', P);
end;

{ Reads a version key ("current" or "previous") from install.json so uninstall works after updates and rollbacks. A null value yields ''. }
function CliOfKey(Key: string): string;
var Json: AnsiString; P, Q: Integer; V: string;
begin
  Result := '';
  if not LoadStringFromFile(ExpandConstant('{app}\.pso-install\install.json'), Json) then exit;
  P := Pos('"' + Key + '"', string(Json));
  if P = 0 then exit;
  V := Copy(string(Json), P + Length(Key) + 2, 200);
  P := Pos(':', V); if P = 0 then exit;
  V := TrimLeft(Copy(V, P + 1, 200));
  if (Length(V) = 0) or (V[1] <> '"') then exit;
  V := Copy(V, 2, 200); Q := Pos('"', V); if Q = 0 then exit;
  Result := ExpandConstant('{app}\versions\') + Copy(V, 1, Q - 1) + '\node_modules\@pso\cli\bin\pso.js';
end;

function CurrentCli(Param: string): string;
begin
  Result := CliOfKey('current');
end;

function PreviousCli(Param: string): string;
begin
  Result := CliOfKey('previous');
end;

function HasPreviousCli: Boolean;
begin
  Result := (CliOfKey('previous') <> '') and FileExists(CliOfKey('previous'));
end;
`;
  writeFileSync(join(out, "pso-setup.iss"), script);
  const isccPath = findIscc();
  const issFile = join(out, "pso-setup.iss");
  if (!isccPath) {
    emit(ctx, { script: issFile, built: false, status: "BLOCKED", reason: "Inno Setup (ISCC.exe) is not installed; the installer was NOT built or tested" }, `BLOCKED: the Inno Setup script was generated at ${issFile}, but ISCC.exe was not found (Inno Setup 6 or 7, or set ISCC), so no installer was built or tested.`);
    return 2;
  }
  if (!pkg || !bootstrap) { emit(ctx, { script: issFile, built: false, status: "INCOMPLETE" }, "the script was generated but --package and --bootstrap are required to compile a real installer"); return 1; }
  if (!existsSync(bootAbs)) throw new CliError(`bootstrap not found: ${bootAbs}`);
  const r = spawnSync(isccPath, ["/Q", ...(signCommand ? [`/Spsosign=${signCommand.replaceAll("\"", "$q")}`] : []), issFile], { encoding: "utf8", timeout: 900_000 });
  if (r.status !== 0 && signedUninstallerAbs) {
    // remote signing, first pass: Inno wrote the unsigned uninstaller it needs signed (Inno 7: uninst-<inno version>-<hash>.e32, signed in
    // place; Inno 6: the same name with ".tmp", renamed without it once signed) and stopped. Its own message names the file.
    const out = `${r.stdout}${r.stderr}`;
    const named = [...out.matchAll(/(uninst-[0-9.]+-[0-9a-f]+\.e32(?:\.tmp)?)/gi)].map((m) => m[1]!);
    const pending = [...new Set(named)].filter((f) => existsSync(join(signedUninstallerAbs, f)));
    if (pending.length) {
      const files = pending.map((f) => join(signedUninstallerAbs, f));
      emit(ctx, { script: issFile, built: false, status: "NEEDS_SIGNED_UNINSTALLER", toSign: files, signedUninstallerDir: signedUninstallerAbs, iscc: out.split(/\r?\n/).filter((l) => /sign|uninst/i.test(l)).join(" ").slice(0, 600) },
        `NEEDS_SIGNED_UNINSTALLER: Authenticode-sign ${files.join(", ")} (it is the uninstaller and the temporary copy Setup runs from TEMP), keep it in ${signedUninstallerAbs}${pending.some((f) => f.endsWith(".tmp")) ? ' without the ".tmp" suffix' : ""}, and run the same command again. No installer was written.`);
      return 2;
    }
  }
  if (r.status !== 0) throw new CliError(`ISCC failed (exit ${r.status}): ${(r.stdout + r.stderr).split("\n").slice(-6).join(" ").slice(0, 600)}`);
  const exe = join(out, `${baseName}.exe`);
  if (!existsSync(exe)) throw new CliError(`ISCC reported success but ${exe} does not exist`);
  const bytes = readFileSync(exe);
  const info = { script: issFile, built: true, status: "BUILT", signed: signCommand !== undefined, ...(signCommand ? { publisher, signedBy: "Inno Setup SignTool (installer and uninstaller)" } : {}), installer: exe, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), iscc: isccPath, package: pkgAbs, packageSha256: createHash("sha256").update(readFileSync(pkgAbs)).digest("hex"), bootstrap: bootAbs, bootstrapSha256: createHash("sha256").update(readFileSync(bootAbs)).digest("hex"), signerFingerprint: fingerprint, requires: "Node.js >=24 on PATH" };
  writeFileSync(`${exe}.manifest.json`, JSON.stringify(info, null, 2));
  emit(ctx, info, `built ${exe} (${bytes.length} bytes, sha256 ${info.sha256}).\nsigner fingerprint ${grouped}\n${signCommand ? `Authenticode signing was requested for "${publisher}" (installer and uninstaller): verify it before publishing (scripts/psd/codesign.mjs gate).` : "This installer is NOT code-signed: Authenticode signing needs a certificate that this command does not have."}`);
  return 0;
}
