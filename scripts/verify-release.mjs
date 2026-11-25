#!/usr/bin/env node
// Verifies a release directory produced by scripts/release.mjs or scripts/release-maven.mjs against a public key YOU trust.
//   node scripts/verify-release.mjs <release-dir> --trust <ed25519 public pem>
// Checks: SHA256SUMS signature, every listed file's SHA-256, manifest.json signature (npm), and the DSSE provenance envelope (signature and
// subject digests). Exit 0 only when everything that exists verifies; a missing signature is a failure, never a pass.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? "");
const ti = args.indexOf("--trust");
if (!args[0] || ti < 0 || !args[ti + 1]) { console.error("usage: node scripts/verify-release.mjs <release-dir> --trust <public.pem>"); process.exit(2); }
const pub = createPublicKey(readFileSync(args[ti + 1], "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const problems = [];
const ok = (m) => console.log(`ok       ${m}`);
const bad = (m) => { problems.push(m); console.log(`FAILED   ${m}`); };
const sigOk = (file, sigFile) => { try { return verify(null, readFileSync(file), pub, Buffer.from(readFileSync(sigFile, "utf8").trim(), "base64")); } catch { return false; } };

const sums = join(dir, "SHA256SUMS");
if (!existsSync(sums)) { bad("SHA256SUMS is missing"); }
else {
  if (!existsSync(`${sums}.sig`)) bad("SHA256SUMS.sig is missing (unsigned release)");
  else sigOk(sums, `${sums}.sig`) ? ok("SHA256SUMS signature") : bad("SHA256SUMS signature does not verify with the trusted key");
  let n = 0;
  for (const line of readFileSync(sums, "utf8").split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) \*(.+)$/.exec(line);
    if (!m) { bad(`malformed checksum line: ${line.slice(0, 60)}`); continue; }
    if (m[2].includes("..") || m[2].startsWith("/")) { bad(`unsafe path in SHA256SUMS: ${m[2]}`); continue; }
    const f = join(dir, m[2]);
    if (!existsSync(f)) { bad(`listed file is missing: ${m[2]}`); continue; }
    sha(readFileSync(f)) === m[1] ? n++ : bad(`checksum mismatch: ${m[2]}`);
  }
  if (!problems.some((p) => /checksum|listed file/.test(p))) ok(`${n} file checksum(s)`);
}
const man = join(dir, "manifest.json");
if (existsSync(`${man}.sig`)) sigOk(man, `${man}.sig`) ? ok("manifest.json signature") : bad("manifest.json signature does not verify");
const prov = join(dir, "provenance.intoto.json");
if (existsSync(prov)) {
  try {
    const env = JSON.parse(readFileSync(prov, "utf8"));
    const body = Buffer.from(env.payload, "base64");
    const pae = Buffer.concat([Buffer.from(`DSSEv1 ${env.payloadType.length} ${env.payloadType} ${body.length} `), body]);
    env.signatures.some((s) => verify(null, pae, pub, Buffer.from(s.sig, "base64"))) ? ok("provenance envelope signature") : bad("provenance envelope signature does not verify");
    const st = JSON.parse(body.toString("utf8"));
    for (const s of st.subject) { const f = join(dir, s.name); existsSync(f) && sha(readFileSync(f)) === s.digest.sha256 ? null : bad(`provenance subject does not match: ${s.name}`); }
    if (!problems.some((p) => /provenance subject/.test(p))) ok(`provenance subjects (${st.subject.length}) match the files`);
    console.log("note     provenance is self-asserted by the build machine; it is not an attested SLSA build");
  } catch (e) { bad(`provenance envelope unreadable: ${e.message}`); }
}
console.log(problems.length ? `\n${problems.length} problem(s): NOT VERIFIED` : "\nVERIFIED");
process.exit(problems.length ? 1 : 0);
