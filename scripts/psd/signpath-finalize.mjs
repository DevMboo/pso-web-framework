// Last step of a release signed by a remote signing service (SignPath): after build-release.mjs --remote-signing stopped with exit 5 and the
// installer came back from its approved signing request. Nothing here signs anything; it proves and records.
//
//   node scripts/psd/signpath-finalize.mjs --remote-signing <exchange dir> --signed-installer <signed .exe> --signing-key <ed25519 private pem>
//        [--denylist <file>]
//
// 1. the signed installer is EXACTLY the build that was submitted (same bytes apart from the Authenticode signature) and carries a valid,
//    timestamped signature of the expected publisher that Windows trusts;
// 2. it replaces the unsigned installer in the release directory, and only then are the manifest hash, SHA256SUMS and its Ed25519
//    signature written;
// 3. the whole release directory passes the Authenticode release gate and the release scan.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gate, judgeExecutable, sameExceptSignature } from "./codesign.mjs";
import { readAuthenticode } from "./tools/authenticode.ts";
import { scan, summarize } from "./scan.mjs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const remote = flag("remote-signing") && resolve(flag("remote-signing")), signedFile = flag("signed-installer") && resolve(flag("signed-installer")), keyFile = flag("signing-key");
if (!remote || !signedFile || !keyFile || ![remote, signedFile, keyFile].every((p) => existsSync(p))) { console.error("usage: signpath-finalize.mjs --remote-signing <dir> --signed-installer <signed .exe> --signing-key <ed25519 private pem> [--denylist <file>]"); process.exit(2); }
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stage = (name, ok, detail) => { console.log(`${ok ? "PASSED" : "FAILED"}   ${name}${detail ? ` - ${detail}` : ""}`); if (!ok) process.exit(1); };

const pending = JSON.parse(readFileSync(join(remote, "pending.json"), "utf8"));
stage("pending installer signing request", pending.phase === "installer", `phase ${pending.phase}, release ${pending.label}`);
const unsigned = readFileSync(join(remote, "request-installer", `${pending.exeBase}.exe`));
stage("the submitted installer is unchanged", sha(unsigned) === pending.unsignedSha256);
const signed = readFileSync(signedFile);
stage("the signed installer is the submitted build", sameExceptSignature(unsigned, signed), "identical apart from the Authenticode signature");
const j = judgeExecutable(`${pending.exeBase}.exe`, readAuthenticode(signedFile), pending.publisher);
stage(`Authenticode signature of "${pending.publisher}"`, j.ok, j.reason);

// the signed installer replaces the unsigned one; manifest and checksums follow it
const releaseDir = pending.release;
const exe = join(releaseDir, `${pending.exeBase}.exe`);
stage("the release directory holds the submitted build", existsSync(exe) && sha(readFileSync(exe)) === pending.unsignedSha256);
copyFileSync(signedFile, exe);
const m = JSON.parse(readFileSync(join(releaseDir, "release-manifest.json"), "utf8"));
m.installer = { ...m.installer, bytes: signed.length, sha256: sha(signed), authenticode: { signed: true, publisher: pending.publisher, digest: "SHA-256", timestamp: "RFC 3161", uninstallerSigned: true, signedBy: "remote signing service (one manually approved signing request per artifact)", verifiedBy: "WinVerifyTrust (Get-AuthenticodeSignature); content identical to the submitted build" } };
writeFileSync(join(releaseDir, "release-manifest.json"), JSON.stringify(m, null, 2));
const files = readdirSync(releaseDir).filter((f) => statSync(join(releaseDir, f)).isFile() && !f.startsWith("SHA256SUMS")).sort();
const sums = files.map((f) => `${sha(readFileSync(join(releaseDir, f)))} *${f}`).join("\n") + "\n";
writeFileSync(join(releaseDir, "SHA256SUMS"), sums);
writeFileSync(join(releaseDir, "SHA256SUMS.sig"), sign(null, readFileSync(join(releaseDir, "SHA256SUMS")), createPrivateKey(readFileSync(keyFile, "utf8"))).toString("base64") + "\n");
stage("release checksums and signature", sums.includes(`${sha(signed)} *${pending.exeBase}.exe`), `${files.length} files; SHA256SUMS written after signing and records the signed installer`);

const g = gate([releaseDir], pending.publisher);
stage("Authenticode release gate", g.ok && g.pso >= 1, g.ok ? `${g.executables} executable(s) verified` : g.failures.map((x) => `${x.file}: ${x.reason}`).join("; "));
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const denylistFile = flag("denylist") ?? join(home, ".pso-psd", "denylist.txt");
const denylist = existsSync(denylistFile) ? readFileSync(denylistFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#")) : [];
const exceptions = JSON.parse(readFileSync(resolve(import.meta.dirname, "exceptions.json"), "utf8")).exceptions;
const fin = scan(releaseDir, { denylist, exceptions });
stage("release directory scan", fin.ok && denylist.length > 0, fin.ok ? `${fin.stats.files} files inspected; deny-list ${denylist.length ? `${denylist.length} entries` : "MISSING"}` : JSON.stringify(summarize(fin)));
writeFileSync(join(remote, "pending.json"), JSON.stringify({ ...pending, phase: "done", signedSha256: sha(signed), at: new Date().toISOString() }, null, 2));
console.log(`\nrelease ${pending.label} is complete in ${releaseDir}. NOT published: publishing is a separate, approved step.`);
