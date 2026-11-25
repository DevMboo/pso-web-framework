// Phase 1: enrollment with the SHIPPED utility inside an isolated profile, a rebuild encrypted for that identity, negative installs (every refusal),
// then the real silent installation. Evidence: docs/implementation/evidence/psd/<label>/validation-install.json
//   node scripts/psd/validate/phase1-install.mjs --label 0.1.0-alpha.1
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createPublicKey, verify as edVerify, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Evidence, makeIso, node, run, sha } from "./iso.mjs";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const label = a[a.indexOf("--label") + 1] ?? "0.1.0-alpha.1";
const K = join(process.env.USERPROFILE, ".pso-psd");
const releaseDir = join(repo, "release-out", "psd", label);
const evDir = join(repo, "docs", "implementation", "evidence", "psd", label);
const V = join(K, "validation");
const ev = new Evidence(join(evDir, "validation-install.json"));
const exeName = `PSO-Web-${label}-win-x64.exe`;
const read = (p) => readFileSync(p);

// ---- 1. what a developer receives: verify checksums, the signature and the fingerprint
const manifest = JSON.parse(read(join(releaseDir, "release-manifest.json"), "utf8"));
const sums = Object.fromEntries(read(join(releaseDir, "SHA256SUMS"), "utf8").toString().trim().split("\n").map((l) => { const [h, f] = l.split(" *"); return [f, h]; }));
const sigOk = edVerify(null, read(join(releaseDir, "SHA256SUMS")), createPublicKey(read(join(releaseDir, "release-signing-key.public.pem"))), Buffer.from(read(join(releaseDir, "SHA256SUMS.sig"), "utf8").toString().trim(), "base64"));
ev.check("SHA256SUMS signature verifies against the published signing key", sigOk);
const allMatch = Object.entries(sums).every(([f, h]) => sha(read(join(releaseDir, f))) === h);
ev.check("every release file matches SHA256SUMS", allMatch, `${Object.keys(sums).length} files`);
const fp = manifest.signing.fingerprintSha256;
const fpFromKey = sha(createPublicKey(read(join(releaseDir, "release-signing-key.public.pem"))).export({ type: "spki", format: "der" }));
const fpMaintainer = sha(createPublicKey(read(join(K, "keys", "release.public.pem"))).export({ type: "spki", format: "der" }));
ev.check("manifest fingerprint = published key = the maintainer's own key (the out-of-band value)", fp === fpFromKey && fp === fpMaintainer, fp.slice(0, 16) + "...");

// ---- 2. enrollment in a clean profile with the shipped utility
const iso = makeIso(join(V, "iso-dev"));
const dl = join(iso.work, "download"); mkdirSync(dl, { recursive: true });
copyFileSync(join(releaseDir, "pso-recipient.mjs"), join(dl, "pso-recipient.mjs"));
ev.check("the downloaded utility hash equals the signed SHA256SUMS entry", sha(read(join(dl, "pso-recipient.mjs"))) === sums["pso-recipient.mjs"]);
let r = node(iso, [join(dl, "pso-recipient.mjs"), "doctor", "--json"]);
ev.check("pso-recipient doctor: DPAPI works for this account in the isolated profile", r.status === 0 && /works/.test(r.out), r.err || r.out.slice(0, 160));
r = node(iso, [join(dl, "pso-recipient.mjs"), "init", "--label", "Validation Dev", "--store", "dpapi", "--out", iso.work, "--json"]);
const enr = r.status === 0 ? JSON.parse(r.out) : null;
ev.check("pso-recipient init creates a DPAPI identity under the isolated LOCALAPPDATA", !!enr && enr.store === "dpapi" && existsSync(join(iso.local, "PSO", "recipient", "identity.json")), r.err.slice(0, 200));
const identityText = existsSync(join(iso.local, "PSO", "recipient", "identity.json")) ? readFileSync(join(iso.local, "PSO", "recipient", "identity.json"), "utf8") : "";
ev.check("the identity file holds no plaintext private key; the enrollment file is public only", !/PRIVATE KEY|MC4CAQAw/.test(identityText) && !/PRIVATE KEY/.test(readFileSync(join(iso.work, "Validation_Dev.enrollment.json"), "utf8")));

// ---- 3. the maintainer authorizes the developer (and removes the throwaway key) and rebuilds
const recipients = join(K, "recipients");
rmSync(join(recipients, "psd-validation.public.pem"), { force: true });
writeFileSync(join(recipients, "validation-dev.public.pem"), JSON.parse(readFileSync(join(iso.work, "Validation_Dev.enrollment.json"), "utf8")).publicKeyPem);
const build = spawnSync(process.execPath, [join(repo, "scripts", "psd", "build-release.mjs"), "--label", label, "--signing-key", join(K, "keys", "release.private.pem"), "--recipients", recipients, "--maven", join(repo, "release-out", "maven", "repository"), "--obfuscate"], { encoding: "utf8", env: { ...process.env, TEMP: join(K, "tmp"), TMP: join(K, "tmp") }, timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
ev.check("candidate rebuilt for the enrolled developer: every pipeline stage passes", build.status === 0, build.stdout.split("\n").filter((l) => /FAILED|BLOCKED/.test(l)).join("; "));
if (build.status !== 0) { ev.save(); process.exit(1); }
const exe = join(releaseDir, exeName);
const exeBytes = read(exe);
ev.check("the shipped utility is byte-identical after the rebuild", sha(read(join(releaseDir, "pso-recipient.mjs"))) === sums["pso-recipient.mjs"]);

// ---- 4. negative installs against the REAL compiled installer: each must exit non-zero and leave nothing
const fresh = (n) => makeIso(join(V, `iso-neg-${n}`));
const silent = (iso2, dir, extra = [], env = {}) => run(iso2, exe, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${dir}`, `/LOG=${join(iso2.work, "setup.log")}`, ...extra], { env, timeout: 300_000 });
const logOf = (iso2) => existsSync(join(iso2.work, "setup.log")) ? readFileSync(join(iso2.work, "setup.log"), "latin1") : "";
const clean = (dir) => !existsSync(join(dir, "versions")) && !existsSync(join(dir, ".pso-install"));
const registryKey = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B2E1F6A3-7C34-4D0E-9A55-3C1D8A9F0001}_is1`;
const hasKey = () => spawnSync("reg", ["query", registryKey], { encoding: "utf8" }).status === 0;
{
  const n = fresh("noanchor"); const d = join(n.work, "pso");
  const x = silent(n, d);
  ev.check("refused with no pinned signer and no identity (no independent trust anchor)", x.status !== 0 && /NO_TRUST_ANCHOR/.test(logOf(n)) && clean(d), `exit ${x.status}`);
}
{
  const n = fresh("noidentity"); const d = join(n.work, "pso");
  const x = silent(n, d, [`/SIGNER=${fp}`]);
  ev.check("refused for a developer who has no recipient identity", x.status !== 0 && /NO_IDENTITY/.test(logOf(n)) && clean(d), `exit ${x.status}`);
}
{
  const n = fresh("wrongsigner"); const d = join(n.work, "pso");
  const x = silent(n, d, [`/SIGNER=${randomBytes(32).toString("hex")}`]);
  ev.check("refused when the signer is not the one the developer expects", x.status !== 0 && /SIGNER_NOT_TRUSTED/.test(logOf(n)) && clean(d), `exit ${x.status}`);
}
{
  const n = fresh("unauthorized"); const d = join(n.work, "pso");
  const x = silent(n, d, [`/SIGNER=${fp}`], { PSO_RECIPIENT_HOME: join(V, "identity") });
  ev.check("an enrolled developer who is NOT a recipient of this release cannot decrypt it", x.status !== 0 && /NOT_AUTHORIZED/.test(logOf(n)) && clean(d), `exit ${x.status}`);
}
{
  const n = fresh("tampered"); const d = join(n.work, "pso");
  const bad = Buffer.from(exeBytes); bad[Math.floor(bad.length * 0.6)] ^= 0xff;
  const tampered = join(n.work, "tampered.exe"); writeFileSync(tampered, bad);
  const x = run(n, tampered, ["/VERYSILENT", "/SUPPRESSMSGBOXES", `/DIR=${d}`, `/SIGNER=${fp}`], { env: { PSO_RECIPIENT_HOME: join(iso.local, "PSO", "recipient") }, timeout: 120_000 });
  ev.check("a modified installer executable is rejected (Inno checksum) and installs nothing", x.status !== 0 && clean(d), `exit ${x.status}`);
}
ev.check("none of the refusals left an uninstall entry in the registry", !hasKey());

// ---- 5. pin the signer as the developer would, then the real installation
r = node(iso, [join(dl, "pso-recipient.mjs"), "pin-signer", "--fingerprint", fp, "--label", "PSO release", "--json"]);
ev.check("pso-recipient pin-signer", r.status === 0, r.err);
const dir = join(iso.root, "pso");
const t0 = Date.now();
const inst = silent(iso, dir);
ev.check("silent installation as the enrolled developer (pinned signer, DPAPI identity)", inst.status === 0 && existsSync(join(dir, "versions", label)), `exit ${inst.status}, ${Date.now() - t0} ms; ${logOf(iso).split("\n").filter((l) => /fail|error/i.test(l)).slice(0, 2).join(" | ")}`);
ev.check("the installer left an uninstall entry and no staging or bootstrap material in the isolated TEMP", hasKey() && !readdirSync(iso.temp).some((n) => /psopkg|bootstrap|staging/i.test(n)) && !existsSync(join(dir, "versions", `.staging-${label}`)), readdirSync(iso.temp).join(","));
ev.save({ label, installer: { file: exeName, bytes: exeBytes.length, sha256: sha(exeBytes) }, installDir: dir, isolatedProfile: iso.root, installMs: Date.now() - t0 });
console.log(`\n${ev.checks.length - ev.failed}/${ev.checks.length} checks passed`);
process.exit(ev.failed ? 1 : 0);
