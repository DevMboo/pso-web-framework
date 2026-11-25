// PSD release pipeline: builds the protected Windows installer candidate. Every stage records PASSED / FAILED / NOT RUN; the build exits non-zero and the
// public release directory is NOT created when a mandatory stage fails. Nothing is published or uploaded.
//
//   node scripts/psd/build-release.mjs --label 0.1.0-alpha.1 --signing-key <ed25519 private pem> --recipients <dir with *.public.pem>
//   development alpha (unsigned, unencrypted, bundled Node.js):  --dev-alpha --runtime <node.exe> --runtime-license <file>   (no --recipients)
//   unsigned encrypted development build (labelled as such):     --unsigned-development --recipients <dir>
//   PRODUCTION (Authenticode-signed, release gate enforced):       --publisher "<certificate common name>" [--recipients <dir>] [--runtime <node.exe> --runtime-license <file>]
//        the signing identity comes from the environment (scripts/psd/codesign.mjs: PSO_SIGN_THUMBPRINT | PSO_SIGN_DLIB + PSO_SIGN_DLIB_METADATA | PSO_SIGN_PFX);
//        Inno Setup signs the uninstaller and the installer (SHA-256, RFC 3161 timestamp) BEFORE any manifest or checksum is computed, and the
//        build stops when any required executable is unsigned, untrusted, untimestamped or signed by another publisher.
//   PRODUCTION with a remote signing service (SignPath; every artifact is a separately approved signing request):
//        --publisher "<CN>" --remote-signing <exchange dir outside the repository and the work directory>
//        run 1 stops with exit 4: <dir>/request-uninstaller/ holds the uninstaller (also Setup's temporary self-copy) to sign; put the signed
//              file into <dir>/uninstaller/ under the same name and run the same command again;
//        run 2 verifies that signed uninstaller, builds the installer and the release directory WITHOUT checksums, and stops with exit 5:
//              <dir>/request-installer/ holds the installer to sign; scripts/psd/signpath-finalize.mjs then verifies the signed installer
//              is exactly that build, and only then writes the manifest hash, SHA256SUMS and its signature.
//        [--work <dir>] [--release <dir>] [--evidence <dir>] [--maven <maven repository dir>] [--denylist <file>] [--obfuscate] [--skip-docs]
//
// Directories: <work> holds the private intermediates (overlay, stage, tools, package) and must be outside the repository; <release> receives ONLY the
// approved public files; <evidence> receives the internal reports (never distributed).
import { createHash, createPublicKey, createPrivateKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { scan, summarize } from "./scan.mjs";
import { buildStage } from "./stage.mjs";

const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : "true"; };
const label = flag("label"), keyFile = flag("signing-key") ?? process.env.PSO_RELEASE_SIGNING_KEY_FILE, recipientsDir = flag("recipients");
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const work = resolve(flag("work") ?? join(home, ".pso-psd", "work", label ?? "x"));
const releaseDir = resolve(flag("release") ?? join(repo, "release-out", "psd", label ?? "x"));
const evidenceDir = resolve(flag("evidence") ?? join(repo, "docs", "implementation", "evidence", "psd", label ?? "x"));
const denylistFile = flag("denylist") ?? join(home, ".pso-psd", "denylist.txt");
const mavenRepo = flag("maven");
const devAlpha = flag("dev-alpha") === "true", runtimeExe = flag("runtime"), runtimeLicense = flag("runtime-license");
const publisher = flag("publisher");
const unsignedDev = devAlpha || flag("unsigned-development") === "true";
const production = !unsignedDev;
const encrypted = !devAlpha && recipientsDir !== undefined;
const bundled = runtimeExe !== undefined;
const remote = flag("remote-signing") ? resolve(flag("remote-signing")) : undefined;
const outside = (p) => { const r = relative(repo, p); return r.startsWith("..") || isAbsolute(r); };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const posix = (p) => p.split("\\").join("/");
const stages = [];
const stage = (name, status, detail) => { stages.push({ name, status, detail }); console.log(`${status.padEnd(8)} ${name}${detail ? ` - ${detail}` : ""}`); return status !== "FAILED"; };
const fail = (name, detail) => { stage(name, "FAILED", detail); finish(1); };
const run = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 900_000, windowsHide: true, ...opts });
const pso = join(repo, "packages", "cli", "bin", "pso.js");

function finish(code) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "release-report.json"), JSON.stringify({ label, generatedAt: new Date().toISOString(), node: process.version, approvedForDistribution: false, note: "A candidate is never approved by its own build: approval needs the independent assessment", stages }, null, 2));
  console.log(`\nreport: ${join(evidenceDir, "release-report.json")}\n${code === 0 ? "Candidate built. NOT approved for distribution (independent review pending). Nothing was published." : code === 4 ? "PENDING: the uninstaller must be signed (remote signing request 1 of 2); no release directory was produced." : code === 5 ? "PENDING: the installer must be signed (remote signing request 2 of 2); the release directory has NO checksums until signpath-finalize.mjs runs." : "BLOCKED: a mandatory stage failed; no release directory was produced."}`);
  process.exit(code);
}

if (!label || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(label)) { console.error("--label <semantic version, e.g. 0.1.0-alpha.1> is required"); process.exit(2); }
if (!keyFile || !existsSync(keyFile)) { console.error("--signing-key <ed25519 private pem> (or PSO_RELEASE_SIGNING_KEY_FILE) is required"); process.exit(2); }
if (!outside(resolve(keyFile))) { console.error("the signing key is inside the repository; refusing"); process.exit(2); }
if (devAlpha && (!runtimeExe || !runtimeLicense || !existsSync(runtimeExe) || !existsSync(runtimeLicense))) { console.error("--dev-alpha needs --runtime <node.exe> and --runtime-license <file>"); process.exit(2); }
if (devAlpha && recipientsDir) { console.error("--dev-alpha is unencrypted by design: do not combine it with --recipients"); process.exit(2); }
if (unsignedDev && publisher) { console.error("--publisher belongs to a production build: an unsigned development build (--dev-alpha, --unsigned-development) names no publisher"); process.exit(2); }
if (production && !publisher) { console.error("a production release is Authenticode-signed: pass --publisher \"<certificate common name>\" and configure the signing identity (node scripts/psd/codesign.mjs check), or build an explicitly labelled unsigned development build with --dev-alpha or --unsigned-development"); process.exit(2); }
if (!devAlpha && !production && (!recipientsDir || !existsSync(recipientsDir))) { console.error("--recipients <directory of *.public.pem> is required (an unsigned installer without recipients would be unencrypted)"); process.exit(2); }
if (recipientsDir && !existsSync(recipientsDir)) { console.error(`--recipients does not exist: ${recipientsDir}`); process.exit(2); }
if (production && !encrypted && !bundled) { console.error("an unencrypted production release bundles its runtime: pass --runtime <node.exe> --runtime-license <file> (or --recipients for an encrypted private release)"); process.exit(2); }
if (remote && !production) { console.error("--remote-signing belongs to a production build (--publisher)"); process.exit(2); }
if (remote && (!outside(remote) || !relative(work, remote).startsWith(".."))) { console.error("--remote-signing must be outside the repository and outside --work (the work directory is emptied at the start)"); process.exit(2); }
if (bundled && (!runtimeLicense || !existsSync(runtimeExe) || !existsSync(runtimeLicense))) { console.error("--runtime needs --runtime-license, and both must exist"); process.exit(2); }
if (!outside(work)) { console.error("--work must be outside the repository"); process.exit(2); }

// 0. Authenticode: a production build checks its signing identity, SignTool and the bundled runtime's own signature before building or removing anything
const codesignJs = join(repo, "scripts", "psd", "codesign.mjs");
const signLog = join(work, "authenticode-log.jsonl");
if (production) {
  if (remote) stage("Authenticode signing configuration", "PASSED", `remote signing service for "${publisher}" through ${remote}: the uninstaller and the installer are separate, manually approved signing requests`);
  else {
    const c = run(codesignJs, ["check"]);
    if (c.status !== 0) { stage("Authenticode signing configuration", "FAILED", (c.stdout + c.stderr).trim().slice(-400)); finish(c.status === 3 ? 3 : 1); }
    stage("Authenticode signing configuration", "PASSED", c.stdout.trim().replace(/^READY\s+/, ""));
  }
  if (bundled) {
    const v = run(codesignJs, ["verify", "--file", runtimeExe, "--publisher", "-"]);
    if (v.status !== 0) fail("bundled runtime signature", (v.stdout + v.stderr).trim().slice(-300));
    stage("bundled runtime signature", "PASSED", v.stdout.trim().replace(/^VERIFIED\s+/, ""));
  }
} else stage("Authenticode signing configuration", "NOT RUN", `UNSIGNED DEVELOPMENT BUILD (${devAlpha ? "--dev-alpha" : "--unsigned-development"}): no executable is Authenticode-signed and the production release gate does not apply`);

rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
rmSync(releaseDir, { recursive: true, force: true });
const pub = (p) => createPublicKey(createPrivateKey(readFileSync(p, "utf8"))).export({ type: "spki", format: "pem" }).toString();
const signerPem = pub(keyFile);
const signerFp = sha(createPublicKey(signerPem).export({ type: "spki", format: "der" }));

// 1. tools
const tools = join(work, "tools");
let r = run(join(repo, "scripts", "psd", "build-tools.mjs"), ["--out", tools]);
if (r.status !== 0) fail("bootstrap and recipient tools", (r.stdout + r.stderr).slice(-300));
const toolsInfo = JSON.parse(readFileSync(join(tools, "tools-manifest.json"), "utf8")).tools;
const bootInfo = toolsInfo.find((t) => t.name === "pso-bootstrap");
stage("bootstrap and recipient tools", "PASSED", `pso-bootstrap.mjs ${bootInfo.bytes} bytes, ${bootInfo.modules.length} modules, no framework-internal modules`);

// 2. development build must be current (the protection works from compiled output)
r = spawnSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"), "-b", "packages/cli"], { cwd: repo, encoding: "utf8" });
stage("development build is current", r.status === 0 ? "PASSED" : "FAILED", r.status === 0 ? "tsc -b up to date" : (r.stdout + r.stderr).slice(-200));
if (r.status !== 0) finish(1);

// 3. protect
const overlay = join(work, "overlay");
r = run(join(repo, "scripts", "psd", "protect.mjs"), ["--out", overlay, "--report", join(work, "protect-report.json"), ...(flag("obfuscate") ? ["--obfuscate"] : [])]);
if (r.status !== 0) fail("javascript protection", (r.stdout + r.stderr).slice(-400));
const protectReport = JSON.parse(readFileSync(join(work, "protect-report.json"), "utf8"));
stage("javascript protection", "PASSED", `${Object.entries(protectReport.packages).map(([p, v]) => `${p}:${v.profile}`).join(" ")}${flag("obfuscate") ? " (selective obfuscation)" : ""}; agent ${protectReport.agent?.profile ?? "-"}`);

// 4. derived dist config: the release version label, and the compiled Maven repository when supplied
const baseCfg = JSON.parse(readFileSync(join(repo, "dist.config.json"), "utf8"));
baseCfg.version = label; for (const c of baseCfg.components) c.version = label;
const staged = join(work, "stage");
let mavenOverlayRoot;
if (mavenRepo) {
  mavenOverlayRoot = join(work, "maven-overlay");
  cpSync(resolve(mavenRepo), join(mavenOverlayRoot, "maven-repository"), { recursive: true });
  baseCfg.components.push({ name: "java", version: label, include: [{ from: "maven-repository", to: "maven-repository" }] });
}
const cfgFile = join(work, "dist.config.json");
writeFileSync(cfgFile, JSON.stringify(baseCfg, null, 2));
// the overlay may need both the protected JS and the Maven repository: merge into one overlay tree
if (mavenOverlayRoot) cpSync(join(mavenOverlayRoot, "maven-repository"), join(overlay, "maven-repository"), { recursive: true });
let st;
try { st = buildStage({ out: staged, config: cfgFile, overlay }); } catch (e) { fail("classified staging", e.message); }
if (!st.ok) fail("classified staging", st.problems.join("; "));
const m = st.manifest;
stage("classified staging", "PASSED", `${m.files} files (${Object.entries(m.byClass).map(([k, v]) => `${k}:${v.files}`).join(" ")}); ${m.dropped} restricted dropped; 0 unknown`);
copyFileSync(st.manifestFile, join(work, "stage-manifest.json"));

// 5. pre-encryption scan of the plaintext stage (this is the evidence that covers the encrypted payload)
const denylist = existsSync(denylistFile) ? readFileSync(denylistFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")) : [];
const exceptions = JSON.parse(readFileSync(join(repo, "scripts", "psd", "exceptions.json"), "utf8")).exceptions;
const pre = scan(staged, { denylist, exceptions });
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "scan-pre-encryption.json"), JSON.stringify({ stats: pre.stats, findings: pre.findings, uninspectable: pre.uninspectable, denylistEntries: denylist.length }, null, 2));
if (!pre.ok) fail("pre-encryption scan", `${pre.findings.length} finding(s) ${JSON.stringify(summarize(pre))}, ${pre.uninspectable.length} uninspectable (see scan-pre-encryption.json)`);
stage("pre-encryption scan", "PASSED", `${pre.stats.files} files, ${pre.stats.archives} archives, ${(pre.stats.bytes / 1048576).toFixed(1)} MB inspected; private deny-list ${denylist.length ? `${denylist.length} entries` : "NOT SUPPLIED"}`);
if (!denylist.length) stage("private deny-list", "FAILED", "no deny-list: internal indicators were not checked"), finish(1);

// 6. pack: sign + encrypt for every authorized recipient
const recipients = !encrypted ? [] : readdirSync(recipientsDir).filter((f) => f.endsWith(".public.pem")).map((f) => join(recipientsDir, f));
if (encrypted && recipients.length === 0) fail("recipients", "no *.public.pem in the recipients directory");
for (const f of recipients) if (/PRIVATE KEY/.test(readFileSync(f, "utf8"))) fail("recipients", `${f} contains a private key; only public keys may be used`);
const pkg = join(work, `pso-${label}-win32-x64.psopkg`);
const t0 = Date.now();
r = run(pso, ["dist", "pack", "--config", cfgFile, "--stage", staged, "--sign-key", keyFile, ...(!encrypted ? [] : ["--encrypt", "--recipient", recipients.join(",")]), "--out", pkg, "--json"]);
if (r.status !== 0) fail("sign and encrypt package", (r.stdout + r.stderr).slice(-300));
const pkgBytes = readFileSync(pkg);
stage(!encrypted ? `sign package (unencrypted${devAlpha ? " alpha" : ""})` : "sign and encrypt package", "PASSED", `${(pkgBytes.length / 1048576).toFixed(2)} MB, zstd${!encrypted ? ", NOT encrypted" : ` + AES-256-GCM, ${recipients.length} recipient(s)`}, Ed25519 signature ${signerFp.slice(0, 16)}..., ${Date.now() - t0} ms`);
const trustPem = join(work, "release.public.pem"); writeFileSync(trustPem, signerPem);
r = run(pso, ["dist", "verify", pkg, "--trust", trustPem, "--json"]);
const vj = r.status === 0 ? JSON.parse(r.stdout) : null;
stage("package signature", vj?.ok && (!encrypted ? !vj.encrypted : vj.encrypted) ? "PASSED" : "FAILED", vj ? `signature valid, ${!encrypted ? "unencrypted" : "encrypted"}, ${vj.files} files declared` : (r.stdout + r.stderr).slice(-200));
if (!vj) finish(1);

// 7. installer
const exeBase = `PSO-Web-${label}-win-x64`;
const instOut = join(work, "installer");
r = run(pso, ["dist", "installer", "--platform", "windows", "--package", pkg, "--bootstrap", join(tools, "pso-bootstrap.mjs"), "--trust", trustPem, "--name", exeBase, "--out", instOut, ...(devAlpha ? ["--dev-distribution"] : []), ...(bundled ? ["--runtime", runtimeExe, "--runtime-license", runtimeLicense] : []),
  ...(production && remote ? ["--publisher", publisher, "--signed-uninstaller-dir", join(remote, "uninstaller")] : production ? ["--publisher", publisher, "--sign-command", `"${process.execPath}" "${codesignJs}" sign --file $f --publisher "${publisher}" --log "${signLog}"`] : []), "--json"]);
if (remote && r.status === 2) {
  const p = (() => { try { return JSON.parse(r.stdout); } catch { return undefined; } })();
  if (p?.status === "NEEDS_SIGNED_UNINSTALLER") {
    const req = join(remote, "request-uninstaller"); rmSync(req, { recursive: true, force: true }); mkdirSync(req, { recursive: true });
    for (const file of p.toSign) copyFileSync(file, join(req, file.split(/[\\/]/).pop()));
    writeFileSync(join(remote, "pending.json"), JSON.stringify({ phase: "uninstaller", label, publisher, files: p.toSign.map((x) => x.split(/[\\/]/).pop()), at: new Date().toISOString() }, null, 2));
    stage("remote signing request: uninstaller", "PENDING", `sign ${p.toSign.map((x) => x.split(/[\\/]/).pop()).join(", ")} from ${req} (the uninstaller and Setup's temporary self-copy), store it signed in ${join(remote, "uninstaller")} under the same name, run this command again`);
    finish(4);
  }
}
if (r.status !== 0) fail("installer (Inno Setup)", (r.stdout + r.stderr).slice(-400));
const inst = JSON.parse(r.stdout);
stage("installer (Inno Setup)", "PASSED", `${exeBase}.exe ${(inst.bytes / 1048576).toFixed(2)} MB; ${production && remote ? `built with the remotely signed uninstaller; the installer itself is signed by the next signing request for "${publisher}"` : production ? `Authenticode signing of installer and uninstaller requested for "${publisher}"` : "NOT Authenticode-signed (unsigned development build)"}${devAlpha ? "; development-distribution mode with bundled Node.js" : bundled ? "; bundled Node.js" : ""}`);

// 7b. the production release gate: every required executable signed, verified as Windows verifies it, before any checksum is computed
const signedInstaller = join(instOut, `${exeBase}.exe`);
let signedInstallerSha;
if (production && remote) {
  // the signed uninstaller Inno embedded, and the runtime, are verified now; the installer is the next signing request
  const g = run(codesignJs, ["gate", "--dir", join(remote, "uninstaller"), ...(bundled ? ["--dir", dirname(runtimeExe)] : []), "--publisher", publisher, "--json"]);
  const gj = (() => { try { return JSON.parse(g.stdout); } catch { return undefined; } })();
  if (!gj || !gj.ok || gj.pso < 1) fail("Authenticode release gate (uninstaller and runtime)", gj ? (gj.failures.map((x) => `${x.file}: ${x.reason}`).join("; ") || "no signed uninstaller was inspected") : (g.stdout + g.stderr).slice(-300));
  stage("Authenticode release gate (uninstaller and runtime)", "PASSED", `${gj.pso} remotely signed uninstaller by "${publisher}", ${gj.thirdParty} third-party executable(s) with their own publisher`);
} else if (production) {
  const log = existsSync(signLog) ? readFileSync(signLog, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const g = run(codesignJs, ["gate", "--dir", instOut, ...(bundled ? ["--dir", dirname(runtimeExe)] : []), "--publisher", publisher, "--json"]);
  const gj = (() => { try { return JSON.parse(g.stdout); } catch { return undefined; } })();
  signedInstallerSha = sha(readFileSync(signedInstaller));
  const problems = [
    ...(log.length < 2 ? [`Inno Setup signed ${log.length} file(s); the installer and the uninstaller (2) are required`] : []),
    ...log.filter((e) => !e.ok).map((e) => `${e.file}: ${e.reason}`),
    ...(!gj ? [`gate did not run: ${(g.stdout + g.stderr).slice(-200)}`] : gj.failures.map((x) => `${x.file}: ${x.reason}`)),
    ...(gj && gj.pso < 1 ? ["no PSO-owned executable was inspected"] : []),
    ...(inst.sha256 !== signedInstallerSha ? ["the installer changed after its manifest was written"] : []),
  ];
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "authenticode-gate.json"), JSON.stringify({ publisher, signed: log, gate: gj, installerSha256: signedInstallerSha }, null, 2));
  if (problems.length) fail("Authenticode release gate", problems.join("; "));
  stage("Authenticode release gate", "PASSED", `${log.length} file(s) signed during compilation (installer + uninstaller), ${gj.executables} executable(s) verified (${gj.pso} PSO-owned by "${publisher}", ${gj.thirdParty} third-party with their own publisher); SHA-256 + RFC 3161 timestamp`);
} else stage("Authenticode release gate", "NOT RUN", "unsigned development build: executables are NOT Authenticode-signed");

// 8. post-packaging scan of the installer itself: no private keys, no developer indicators, no plaintext CLI
const post = scan(join(instOut, `${exeBase}.exe`), { denylist, exceptions });
writeFileSync(join(evidenceDir, "scan-installer.json"), JSON.stringify({ stats: post.stats, findings: post.findings, uninspectable: post.uninspectable }, null, 2));
stage("installer scan", post.ok ? "PASSED" : "FAILED", post.ok ? `${post.stats.bytes} bytes scanned as binary (executable strings, UTF-16)` : `${post.findings.length} finding(s) ${JSON.stringify(summarize(post))}`);
if (!post.ok) finish(1);
// the compressed Inno payload cannot be read from outside; this check proves the intended design instead: only three sources, all dontcopy
const iss = readFileSync(join(instOut, "pso-setup.iss"), "utf8");
const sources = iss.split(/\r?\n/).filter((l) => /^Source:/.test(l));
const designOk = sources.length === (bundled ? 5 : 3) && sources.filter((l) => !/dontcopy/.test(l)).length === (bundled ? 1 : 0) && !/recursesubdirs/.test(iss) && !/PRIVATE KEY/.test(iss);
stage("installer carries no staged CLI", designOk ? "PASSED" : "FAILED", `${sources.length} Inno sources: ${sources.map((l) => /\.psopkg/.test(l) ? "package(encrypted)" : /\.pem/.test(l) ? "public key" : /bootstrap/.test(l) ? "bootstrap" : "?").join(", ")}`);
if (!designOk) finish(1);

// 9. public release directory: ONLY approved files
mkdirSync(releaseDir, { recursive: true });
const exeOut = join(releaseDir, `${exeBase}.exe`);
copyFileSync(join(instOut, `${exeBase}.exe`), exeOut);
const exeBytes = readFileSync(exeOut);
if (production && !remote && sha(exeBytes) !== signedInstallerSha) fail("signed installer copied unchanged", "the installer in the release directory differs from the verified signed file");
// third-party notices: the licence file of every staged third-party package
const notices = [];
for (const e of m.entries.filter((x) => x.class === "T" && /(^|\/)(licen[cs]e|notice|thirdpartynotice)[^/]*$/i.test(x.path) && x.path.split("/").length <= 4)) notices.push(`===== ${e.path} =====\n${readFileSync(join(staged, ...e.path.split("/")), "utf8")}`);
writeFileSync(join(releaseDir, "THIRD-PARTY-NOTICES.txt"), `PSO Web ${label} - third-party notices\nThe distribution includes the following third-party components under their own licences.\n\n${notices.join("\n\n")}\n`);
// SBOM (CycloneDX) from the actual staged content
const comps = new Map();
for (const e of m.entries) {
  const mm = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(e.path);
  if (!mm) continue;
  const j = JSON.parse(readFileSync(join(staged, ...e.path.split("/")), "utf8"));
  comps.set(j.name, { type: "library", name: j.name, version: j.version, "bom-ref": `${j.name}@${j.version}`, licenses: j.license && j.license !== "UNLICENSED" ? [{ license: { id: String(j.license) } }] : [{ license: { name: j.name.startsWith("@pso/") ? "MISSING (a PSO package must declare Apache-2.0)" : "unknown" } }], purl: `pkg:npm/${encodeURIComponent(j.name).replace("%40", "@")}@${j.version}`, scope: "required", "x-pso-class": e.class });
}
const mvnComps = [...new Set(m.entries.filter((e) => /^maven-repository\/.*\.pom$/.test(e.path)).map((e) => e.path))].map((p) => { const mm = /maven-repository\/com\/pso\/([^/]+)\/([^/]+)\//.exec(p); return mm ? { type: "library", name: mm[1], group: "com.pso", version: mm[2], "bom-ref": `com.pso:${mm[1]}@${mm[2]}`, licenses: [{ license: { id: "Apache-2.0" } }], purl: `pkg:maven/com.pso/${mm[1]}@${mm[2]}` } : null; }).filter(Boolean);
writeFileSync(join(releaseDir, "sbom.cdx.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: "PSO Web Framework", version: label, licenses: [{ license: { id: "Apache-2.0" } }], supplier: { name: "DevMboo", url: ["https://github.com/DevMboo"] } }, tools: [{ name: "scripts/psd/build-release.mjs" }] }, components: [...comps.values(), ...mvnComps] }, null, 2));
const lic = {}; for (const c of comps.values()) for (const l of c.licenses) { const k = l.license.id ?? l.license.name; lic[k] = (lic[k] ?? 0) + 1; }
writeFileSync(join(releaseDir, "dependency-inventory.json"), JSON.stringify({ scope: "everything that is installed by this release", npmPackages: comps.size, mavenArtifacts: mvnComps.length, licenseCounts: lic, packages: [...comps.values()].map(({ name, version, licenses }) => ({ name, version, licenses: licenses.map((l) => l.license.id ?? l.license.name) })) }, null, 2));
// the compiled Java starters depend on third-party libraries that the developer's Maven resolves from Maven Central: their inventory ships too
if (mavenRepo) {
  const mavenOut = dirname(resolve(mavenRepo));
  for (const [from, to] of [["sbom.cdx.json", "sbom-java.cdx.json"], ["licenses.json", "licenses-java.json"]]) if (existsSync(join(mavenOut, from))) copyFileSync(join(mavenOut, from), join(releaseDir, to));
  stage("Java third-party inventory", existsSync(join(releaseDir, "sbom-java.cdx.json")) ? "PASSED" : "FAILED", existsSync(join(releaseDir, "sbom-java.cdx.json")) ? "CycloneDX SBOM and licence counts of the Java dependencies (resolved from Maven Central by the developer's build, not redistributed)" : "the Maven release did not produce an SBOM");
  if (!existsSync(join(releaseDir, "sbom-java.cdx.json"))) finish(1);
}
const unknownLic = [...comps.values()].filter((c) => c.licenses.some((l) => l.license.name === "unknown"));
stage("SBOM and notices", unknownLic.length ? "FAILED" : "PASSED", unknownLic.length ? `unknown licence: ${unknownLic.map((c) => c.name).join(", ")}` : `${comps.size} npm packages + ${mvnComps.length} Maven artifacts; licences ${Object.entries(lic).map(([k, v]) => `${k}=${v}`).join(", ")}`);
if (unknownLic.length) finish(1);
writeFileSync(join(releaseDir, "release-signing-key.public.pem"), signerPem);
// the license of PSO Web Framework and its NOTICE travel with every release (Apache-2.0, section 4)
for (const n of ["LICENSE", "NOTICE"]) copyFileSync(join(repo, n), join(releaseDir, n));
// instructions, notes and the developer's key utility (the utility is a readable single file: its SHA-256 is in the signed SHA256SUMS)
const runtimeSha = bundled ? sha(readFileSync(runtimeExe)) : undefined;
for (const name of ["INSTALL.md", "RELEASE-NOTES.md"]) writeFileSync(join(releaseDir, name), readFileSync(join(repo, "scripts", "psd", "release-files", devAlpha ? name.replace(".md", "-ALPHA.md") : production && !encrypted ? name.replace(".md", "-SIGNED.md") : name), "utf8").replaceAll("{{LABEL}}", label).replaceAll("{{PUBLISHER}}", publisher ?? "").replaceAll("{{FINGERPRINT}}", signerFp).replaceAll("{{NODE_SHA256}}", runtimeSha ?? ""));
if (encrypted) copyFileSync(join(tools, "pso-recipient.mjs"), join(releaseDir, "pso-recipient.mjs"));
if (bundled) {
  const nodeVersion = JSON.parse(spawnSync(runtimeExe, ["-p", "JSON.stringify({v:process.version,a:process.arch})"], { encoding: "utf8" }).stdout || "{}");
  const nl = readFileSync(runtimeLicense, "utf8");
  writeFileSync(join(releaseDir, "THIRD-PARTY-NOTICES.txt"), readFileSync(join(releaseDir, "THIRD-PARTY-NOTICES.txt"), "utf8") + `\n===== Node.js runtime ${nodeVersion.v ?? ""} (bundled privately in the installation, never on PATH) =====\n${nl}\n`);
  const sb = JSON.parse(readFileSync(join(releaseDir, "sbom.cdx.json"), "utf8"));
  sb.components.push({ type: "application", name: "node", version: String(nodeVersion.v ?? "").replace(/^v/, ""), "bom-ref": "node-runtime", licenses: [{ license: { id: "MIT" } }], hashes: [{ alg: "SHA-256", content: runtimeSha }], purl: `pkg:generic/nodejs@${String(nodeVersion.v ?? "").replace(/^v/, "")}`, scope: "required", description: "private runtime, signed by OpenJS Foundation" });
  writeFileSync(join(releaseDir, "sbom.cdx.json"), JSON.stringify(sb, null, 2));
}
// public release manifest
const publicManifest = { schema: 1, product: "PSO Web Framework", shortName: "PSO Web", license: "Apache-2.0", maintainer: { name: "DevMboo", url: "https://github.com/DevMboo" }, distribution: "Free and Open Source Software", release: label, designation: devAlpha ? "Unsigned Developer Alpha (development distribution)" : production ? `Authenticode-signed release (${publisher})` : "Unsigned development build (private, encrypted)", publisherVerification: devAlpha ? "NOT verified by Windows or by an independent fingerprint: unsigned development build" : undefined, platform: "win32", arch: "x64", installer: { file: `${exeBase}.exe`, bytes: exeBytes.length, sha256: sha(exeBytes), authenticode: production ? { signed: true, publisher, digest: "SHA-256", timestamp: "RFC 3161", uninstallerSigned: true, verifiedBy: "WinVerifyTrust (Get-AuthenticodeSignature) and signtool verify /pa" } : "NOT SIGNED (unsigned development build); verify the SHA-256 and the Ed25519 signature below", requires: bundled ? "Windows 10/11 x64; no Node.js needed (private runtime bundled)" : "Node.js 24 or newer on PATH; Windows 10/11 x64", ...(bundled ? { bundledRuntime: { name: "Node.js", sha256: runtimeSha, signedBy: "OpenJS Foundation (Authenticode, verified when bundled)" } } : {}) }, signing: { algorithm: "Ed25519", publicKey: "release-signing-key.public.pem", fingerprintSha256: signerFp, note: devAlpha ? "Integrity only: this key travels with the installer and does NOT authenticate the publisher of an unsigned alpha." : production ? `Package and checksum integrity; the publisher is authenticated by the Authenticode signature of ${publisher}.` : "Compare this fingerprint with the one the maintainer gave you through a different channel before you pin it (pso-recipient pin-signer)." }, payload: !encrypted ? { format: "psopkg v1", compression: "zstd", encryption: `none (unencrypted${devAlpha ? " alpha" : ""})`, files: vj.files } : { format: "psopkg v1", compression: "zstd", encryption: "AES-256-GCM, content key wrapped per recipient (X25519 + HKDF-SHA256)", files: vj.files }, generatedAt: new Date().toISOString() };
writeFileSync(join(releaseDir, "release-manifest.json"), JSON.stringify(publicManifest, null, 2));
// checksums over every release file, signed - with a remote signing service only after the installer is signed (signpath-finalize.mjs)
if (remote) {
  const req = join(remote, "request-installer"); rmSync(req, { recursive: true, force: true }); mkdirSync(req, { recursive: true });
  copyFileSync(exeOut, join(req, `${exeBase}.exe`));
  writeFileSync(join(remote, "pending.json"), JSON.stringify({ phase: "installer", label, publisher, exeBase, unsignedSha256: sha(exeBytes), release: releaseDir, at: new Date().toISOString() }, null, 2));
}
const files = remote ? [] : readdirSync(releaseDir).filter((f) => statSync(join(releaseDir, f)).isFile() && !f.startsWith("SHA256SUMS")).sort();
const sums = remote ? "" : files.map((f) => `${sha(readFileSync(join(releaseDir, f)))} *${f}`).join("\n") + "\n";
if (remote) stage("release checksums and signature", "PENDING", `not written yet: they are computed after the installer is signed (sign ${join(remote, "request-installer", `${exeBase}.exe`)}, then scripts/psd/signpath-finalize.mjs)`);
else {
  writeFileSync(join(releaseDir, "SHA256SUMS"), sums);
  const priv = createPrivateKey(readFileSync(keyFile, "utf8"));
  writeFileSync(join(releaseDir, "SHA256SUMS.sig"), sign(null, readFileSync(join(releaseDir, "SHA256SUMS")), priv).toString("base64") + "\n");
  stage("release checksums and signature", "PASSED", `${files.length} files; SHA256SUMS signed with Ed25519 key ${signerFp.slice(0, 16)}...`);
}
if (production && !remote) {
  const line = sums.split("\n").find((l) => l.endsWith(` *${exeBase}.exe`));
  if (!line || !line.startsWith(signedInstallerSha)) fail("checksums cover the signed installer", "SHA256SUMS does not record the verified signed installer");
  const again = run(codesignJs, ["gate", "--dir", releaseDir, "--publisher", publisher]);
  if (again.status !== 0) fail("checksums cover the signed installer", (again.stdout + again.stderr).trim().slice(-300));
  stage("checksums cover the signed installer", "PASSED", "SHA256SUMS was computed after signing and records the verified signed installer; the release directory passes the gate");
}

// 10. public documentation build (same generator as the portal), scanned with the same rules
if (!flag("skip-docs")) {
  const docsOut = join(releaseDir, "docs-site");
  r = run(pso, ["docs", "--build", docsOut]);
  stage("public documentation build", r.status === 0 ? "PASSED" : "FAILED", r.status === 0 ? `${readdirSync(docsOut).length} top-level entries` : (r.stdout + r.stderr).slice(-300));
  if (r.status !== 0) finish(1);
}
// 11. final gate: scan the whole public release directory
const fin = scan(releaseDir, { denylist, exceptions });
writeFileSync(join(evidenceDir, "scan-release-dir.json"), JSON.stringify({ stats: fin.stats, findings: fin.findings, uninspectable: fin.uninspectable }, null, 2));
stage("release directory scan", fin.ok ? "PASSED" : "FAILED", fin.ok ? `${fin.stats.files} files inspected` : `${fin.findings.length} finding(s) ${JSON.stringify(summarize(fin))}`);
if (!fin.ok) { rmSync(releaseDir, { recursive: true, force: true }); finish(1); }

// handover for the pre-encryption evidence: digest of the package the scan covers
writeFileSync(join(evidenceDir, "package-digest.json"), JSON.stringify({ package: `pso-${label}-win32-x64.psopkg`, sha256: sha(pkgBytes), bytes: pkgBytes.length, stageManifestSha256: sha(readFileSync(join(work, "stage-manifest.json"))), preEncryptionScan: "scan-pre-encryption.json", toolSha256: Object.fromEntries(toolsInfo.map((t) => [t.name, t.sha256])) }, null, 2));
copyFileSync(join(work, "protect-report.json"), join(evidenceDir, "protect-report.json"));
copyFileSync(join(work, "stage-manifest.json"), join(evidenceDir, "stage-manifest.json"));
if (remote) { stage("remote signing request: installer", "PENDING", `sign ${join(remote, "request-installer", `${exeBase}.exe`)}, then: node scripts/psd/signpath-finalize.mjs --remote-signing ${remote} --signed-installer <signed file> --signing-key <key>`); finish(5); }
finish(0);
