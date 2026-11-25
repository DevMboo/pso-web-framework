// Authenticode signing infrastructure and the production release gate, without a certificate: provider configuration, SignTool arguments,
// secret redaction, executable detection, judgement rules, and the gate run against REAL files on Windows (the OpenJS-signed node.exe, a
// tampered copy of it, an unsigned executable, a ZIP that hides one). A real signature by a publicly trusted certificate cannot be produced
// here; the gate's refusal of everything else is what these tests prove.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Blocked, DEFAULT_TIMESTAMP_URL, gate, gateDecision, isPortableExecutable, isPortableExecutableBuffer, judgeExecutable, redact, roleOf,
  signArguments, signFile, signingIdentity, timestampUrl,
} from "../codesign.mjs";

const codesign = resolve(import.meta.dirname, "..", "codesign.mjs");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pso-codesign-")); dirs.push(d); return d; };
const TP = "0123456789abcdef0123456789abcdef01234567";

/** a minimal PE image: "MZ", e_lfanew = 0x40, "PE\0\0" and a COFF header; Windows reads it as an executable without a signature */
function fakePe() { const b = Buffer.alloc(512); b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x40, 0x3c); b.write("PE\0\0", 0x40, "latin1"); b.writeUInt16LE(0x8664, 0x44); return b; }

test("signing identity: exactly one provider, from the environment; nothing configured is BLOCKED, not an error", () => {
  assert.throws(() => signingIdentity({}), Blocked);
  assert.throws(() => signingIdentity({ PSO_SIGN_THUMBPRINT: "abc" }), /40-hex-digit/);
  assert.deepEqual(signingIdentity({ PSO_SIGN_THUMBPRINT: TP }).args, ["/sha1", TP, "/s", "My"]);
  assert.deepEqual(signingIdentity({ PSO_SIGN_THUMBPRINT: TP, PSO_SIGN_MACHINE_STORE: "1", PSO_SIGN_STORE: "PSO" }).args, ["/sha1", TP, "/s", "PSO", "/sm"]);
  assert.deepEqual(signingIdentity({ PSO_SIGN_THUMBPRINT: TP, PSO_SIGN_CSP: "eToken Base Cryptographic Provider", PSO_SIGN_KEY_CONTAINER: "[{{pin}}]=p11#abc" }).args.slice(-4), ["/csp", "eToken Base Cryptographic Provider", "/kc", "[{{pin}}]=p11#abc"], "a hardware token's provider and key container");
  assert.throws(() => signingIdentity({ PSO_SIGN_THUMBPRINT: TP, PSO_SIGN_CSP: "x" }), /go together/);
  assert.throws(() => signingIdentity({ PSO_SIGN_THUMBPRINT: TP, PSO_SIGN_PFX: "a.pfx" }), /exactly one/);
  assert.throws(() => signingIdentity({ PSO_SIGN_DLIB: "x.dll" }), /PSO_SIGN_DLIB_METADATA/);
  assert.throws(() => signingIdentity({ PSO_SIGN_DLIB: "C:/nope/x.dll", PSO_SIGN_DLIB_METADATA: "C:/nope/m.json" }), Blocked);
  const d = tmp(); writeFileSync(join(d, "Azure.CodeSigning.Dlib.dll"), "x"); writeFileSync(join(d, "metadata.json"), "{}"); writeFileSync(join(d, "t.pfx"), "x");
  assert.deepEqual(signingIdentity({ PSO_SIGN_DLIB: join(d, "Azure.CodeSigning.Dlib.dll"), PSO_SIGN_DLIB_METADATA: join(d, "metadata.json") }).args, ["/dlib", join(d, "Azure.CodeSigning.Dlib.dll"), "/dmdf", join(d, "metadata.json")]);
  assert.match(signingIdentity({ PSO_SIGN_PFX: join(d, "t.pfx") }).description, /test certificates only/);
});

test("SignTool arguments: SHA-256 file digest, RFC 3161 timestamp with SHA-256, and secrets never appear in what is printed", () => {
  const d = tmp(); writeFileSync(join(d, "t.pfx"), "x");
  const id = signingIdentity({ PSO_SIGN_PFX: join(d, "t.pfx"), PSO_SIGN_PFX_PASSWORD: "s3cret-Value" });
  const args = signArguments("C:\\out\\setup.exe", id, timestampUrl({}));
  const at = (k) => args[args.indexOf(k) + 1];
  assert.equal(at("/fd"), "SHA256"); assert.equal(at("/td"), "SHA256"); assert.equal(at("/tr"), DEFAULT_TIMESTAMP_URL);
  assert.ok(!args.includes("/t"), "the legacy Authenticode timestamp (/t) is never used: RFC 3161 only");
  assert.equal(args.at(-1), "C:\\out\\setup.exe");
  assert.ok(!redact(args, id).join(" ").includes("s3cret-Value"), "the password is redacted");
  assert.equal(timestampUrl({ PSO_TIMESTAMP_URL: "http://timestamp.digicert.com" }), "http://timestamp.digicert.com");
  assert.throws(() => timestampUrl({ PSO_TIMESTAMP_URL: "file:///x" }), /RFC 3161/);
});

test("executables are recognised by content; known third-party files keep their own publisher; everything else is PSO-owned", () => {
  assert.equal(isPortableExecutableBuffer(fakePe()), true);
  const noPe = fakePe(); noPe.write("XX", 0x40, "latin1"); assert.equal(isPortableExecutableBuffer(noPe), false, "MZ without a PE header");
  assert.equal(isPortableExecutableBuffer(Buffer.from("@echo off\r\n")), false);
  assert.equal(roleOf("runtime/node.exe").role, "third-party");
  assert.equal(roleOf("PSO-Web-1.0.0-win-x64.exe").role, "pso");
  assert.equal(roleOf("uninst.e32.tmp").role, "pso");
});

test("judgement: PSO files need the PSO publisher, a trusted chain and a timestamp; third-party files need their own publisher", () => {
  const sig = (status, cn, timestamped = true) => ({ status, subject: `CN=${cn}, O=x, C=BR`, thumbprint: "AB", timestamped });
  assert.equal(judgeExecutable("setup.exe", sig("Valid", "PSO Games"), "PSO Games").ok, true);
  assert.equal(judgeExecutable("setup.exe", { status: "NotSigned", subject: "", thumbprint: "", timestamped: false }, "PSO Games").ok, false);
  assert.equal(judgeExecutable("setup.exe", sig("UnknownError", "PSO Games"), "PSO Games").ok, false, "self-signed or untrusted root");
  assert.equal(judgeExecutable("setup.exe", sig("Valid", "PSO Games", false), "PSO Games").ok, false, "no timestamp");
  assert.equal(judgeExecutable("setup.exe", sig("Valid", "Someone Else"), "PSO Games").ok, false, "another publisher");
  assert.equal(judgeExecutable("setup.exe", undefined, "PSO Games").ok, false, "unreadable");
  assert.equal(judgeExecutable("runtime/node.exe", sig("Valid", "OpenJS Foundation"), "PSO Games").ok, true);
  assert.equal(judgeExecutable("runtime/node.exe", sig("Valid", "PSO Games"), "PSO Games").ok, false, "a re-signed third-party file is refused");
  assert.equal(judgeExecutable("runtime/node.exe", sig("HashMismatch", "OpenJS Foundation"), "PSO Games").ok, false);
  const d = gateDecision([judgeExecutable("setup.exe", sig("Valid", "PSO Games"), "PSO Games"), judgeExecutable("node.exe", sig("Valid", "OpenJS Foundation"), "PSO Games")]);
  assert.deepEqual([d.ok, d.executables, d.pso, d.thirdParty], [true, 2, 1, 1]);
});

const nodeExe = process.execPath;
const nodeSigned = process.platform === "win32" && spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${nodeExe}').Status`], { encoding: "utf8" }).stdout.trim() === "Valid";

test("the gate on real files: the signed node.exe passes, a tampered copy, an unsigned executable and one hidden in a ZIP are refused", { skip: !nodeSigned && "needs Windows and an Authenticode-signed node.exe" }, () => {
  const ok = tmp(); mkdirSync(join(ok, "runtime")); copyFileSync(nodeExe, join(ok, "runtime", "node.exe")); writeFileSync(join(ok, "pso.cmd"), "@echo off\r\n");
  const good = gate([ok], "PSO Games");
  assert.equal(good.ok, true, JSON.stringify(good.failures)); assert.equal(good.thirdParty, 1); assert.equal(good.pso, 0, "scripts are not executables");

  const tampered = tmp(); const b = readFileSync(nodeExe); b[b.length >> 1] ^= 0xff; writeFileSync(join(tampered, "node.exe"), b);
  const t = gate([tampered], "PSO Games");
  assert.equal(t.ok, false); assert.match(t.failures[0].reason, /HashMismatch|does not accept/);

  const unsigned = tmp(); writeFileSync(join(unsigned, "pso-helper.exe"), fakePe());
  const u = gate([unsigned], "PSO Games");
  assert.equal(u.ok, false); assert.equal(u.failures[0].role, "pso");

  const zipped = tmp(); const inner = join(zipped, "inner"); mkdirSync(inner); writeFileSync(join(inner, "tool.exe"), fakePe());
  assert.equal(spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", join(zipped, "p.zip"), "-C", zipped, "inner"]).status, 0);
  rmSync(inner, { recursive: true });
  const z = gate([zipped], "PSO Games");
  assert.equal(z.ok, false); assert.match(z.failures[0].file, /p\.zip!\/inner\/tool\.exe$/, "executables inside ZIP files are inspected");
});

test("signing refuses before touching anything: third-party files are never re-signed, and without an identity it is BLOCKED (exit 3)", { skip: !nodeSigned && "needs Windows" }, () => {
  const d = tmp(); copyFileSync(nodeExe, join(d, "node.exe")); const before = readFileSync(join(d, "node.exe"));
  assert.throws(() => signFile(join(d, "node.exe"), "PSO Games", { env: { PSO_SIGN_THUMBPRINT: TP } }), /third-party/);
  assert.deepEqual(readFileSync(join(d, "node.exe")), before, "untouched");
  copyFileSync(nodeExe, join(d, "renamed.exe"));
  assert.throws(() => signFile(join(d, "renamed.exe"), "PSO Games", { env: { PSO_SIGN_THUMBPRINT: TP } }), /already signed by "OpenJS Foundation"/, "a signed file is recognised by its signature, not its name");
  writeFileSync(join(d, "setup.exe"), fakePe());
  assert.throws(() => signFile(join(d, "setup.exe"), "PSO Games", { env: {} }), Blocked);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PSO_SIGN")));
  const r = spawnSync(process.execPath, [codesign, "sign", "--file", join(d, "setup.exe"), "--publisher", "PSO Games"], { encoding: "utf8", env });
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.match(r.stderr, /^BLOCKED: No signing identity/);
  assert.equal(spawnSync(process.execPath, [codesign, "check"], { encoding: "utf8", env }).status, 3);
  assert.equal(isPortableExecutable(join(d, "setup.exe")), true);
});

test("release pipeline modes: production needs a publisher; an unsigned build must say so; a production build without an identity stops BLOCKED before it removes anything", { timeout: 120_000 }, async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const d = tmp();
  const key = join(d, "release.private.pem");
  writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(d, "LICENSE-node.txt"), "MIT\n");
  const release = join(d, "release"); mkdirSync(release); writeFileSync(join(release, "previous-release.txt"), "must survive");
  const work = join(d, "work"); mkdirSync(work); writeFileSync(join(work, "previous-work.txt"), "must survive");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PSO_SIGN")));
  const build = (...extra) => spawnSync(process.execPath, [resolve(import.meta.dirname, "..", "build-release.mjs"), "--label", "9.9.9-test.1", "--signing-key", key, "--work", work, "--release", release, "--evidence", join(d, "evidence"), ...extra], { encoding: "utf8", env, timeout: 120_000 });
  let r = build();
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /a production release is Authenticode-signed/);
  r = build("--dev-alpha", "--runtime", process.execPath, "--runtime-license", join(d, "LICENSE-node.txt"), "--publisher", "PSO Games");
  assert.equal(r.status, 2); assert.match(r.stderr, /--publisher belongs to a production build/);
  r = build("--publisher", "PSO Games");
  assert.equal(r.status, 2); assert.match(r.stderr, /unencrypted production release bundles its runtime/);
  r = build("--publisher", "PSO Games", "--runtime", process.execPath, "--runtime-license", join(d, "LICENSE-node.txt"));
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /FAILED\s+Authenticode signing configuration - BLOCKED: No signing identity/);
  assert.ok(readFileSync(join(release, "previous-release.txt"), "utf8") === "must survive" && readFileSync(join(work, "previous-work.txt"), "utf8") === "must survive", "nothing was removed or built");
  const report = JSON.parse(readFileSync(join(d, "evidence", "release-report.json"), "utf8"));
  assert.equal(report.stages[0].name, "Authenticode signing configuration");
});

/** the unsigned form of a signed PE: certificate table removed, its directory entry and the checksum zeroed (what the signer received) */
function stripSignature(b) {
  const pe = b.readUInt32LE(0x3c), opt = pe + 24, dirs = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96), sec = dirs + 32;
  const off = b.readUInt32LE(sec), u = Buffer.from(b.subarray(0, off)); u.fill(0, opt + 64, opt + 68); u.fill(0, sec, sec + 8);
  let end = u.length; while (end > 0 && u[end - 1] === 0 && u.length - end < 7) end--;   // the signer padded to 8 bytes
  return u.subarray(0, end);
}

test("a remotely signed file is accepted only when it is exactly the submitted build plus a signature", { skip: !nodeSigned && "needs an Authenticode-signed node.exe" }, async () => {
  const { sameExceptSignature } = await import("../codesign.mjs");
  const signed = readFileSync(nodeExe), unsigned = stripSignature(signed);
  assert.ok(unsigned.length < signed.length);
  assert.equal(sameExceptSignature(unsigned, signed), true, "same build, signature added");
  const changed = Buffer.from(unsigned); changed[changed.length >> 1] ^= 1;
  assert.equal(sameExceptSignature(changed, signed), false, "one changed byte in the submitted build");
  const otherSigned = Buffer.from(signed); otherSigned[1024] ^= 1;
  assert.equal(sameExceptSignature(unsigned, otherSigned), false, "one changed byte in what came back");
  assert.throws(() => sameExceptSignature(Buffer.from("not a PE"), signed));
});

test("remote signing mode: only for production, never inside the work directory", { timeout: 60_000 }, async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const d = tmp(); const key = join(d, "k.pem"); writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(d, "L.txt"), "MIT\n");
  const b = (...extra) => spawnSync(process.execPath, [resolve(import.meta.dirname, "..", "build-release.mjs"), "--label", "9.9.9-test.2", "--signing-key", key, "--work", join(d, "work"), "--release", join(d, "rel"), "--evidence", join(d, "ev"), ...extra], { encoding: "utf8", timeout: 60_000 });
  let r = b("--dev-alpha", "--runtime", process.execPath, "--runtime-license", join(d, "L.txt"), "--remote-signing", join(d, "x"));
  assert.equal(r.status, 2); assert.match(r.stderr, /--remote-signing belongs to a production build/);
  r = b("--publisher", "SignPath Foundation", "--runtime", process.execPath, "--runtime-license", join(d, "L.txt"), "--remote-signing", join(d, "work", "x"));
  assert.equal(r.status, 2); assert.match(r.stderr, /outside --work/);
});
