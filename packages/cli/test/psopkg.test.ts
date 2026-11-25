import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { assemble, extractPackage, generateKeyPair, packStage, readHeader, verifyPackage, PsopkgError, type Header, type PackageMeta } from "../src/psopkg.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "pso-pkg-")); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { const f = join(root, ...rel.split("/")); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); };
const META: PackageMeta = { name: "pso", version: "1.2.3", platform: "win32", arch: "x64", components: [{ name: "cli", version: "1.2.3" }, { name: "studio", version: "1.2.3" }] };
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const code = (f: () => unknown): string | undefined => { try { f(); return undefined; } catch (e) { return e instanceof PsopkgError ? e.code : `other:${(e as Error).message}`; } };

const signer = generateKeyPair("signing"), other = generateKeyPair("signing");
const alice = generateKeyPair("recipient"), bob = generateKeyPair("recipient"), carol = generateKeyPair("recipient");
const trust = [{ id: signer.id, publicKeyPem: signer.publicKeyPem }];

function stage(): string {
  const s = tmp();
  put(s, "cli/bin/pso.js", "console.log('SECRET-LOOKING-BUT-PUBLIC-MARKER-12345');\n");
  put(s, "cli/package.json", '{"name":"cli"}');
  put(s, "studio/index.html", "<html></html>");
  return s;
}
const pack = (opts: { recipients?: Array<{ publicKeyPem: string }> } = {}): Buffer => packStage({ stageDir: stage(), meta: META, signingKeyPem: signer.privateKeyPem, componentOf: [{ prefix: "cli/", component: "cli" }, { prefix: "studio/", component: "studio" }], ...opts });

test("round trip: pack, verify every file, extract identical bytes", () => {
  const buf = pack();
  const v = verifyPackage(buf, { trustedKeys: trust });
  assert.deepEqual([v.header.name, v.header.version, v.header.files.length, v.encrypted, v.contentsVerified], ["pso", "1.2.3", 3, false, true]);
  assert.equal(v.header.files.find((f) => f.path === "cli/bin/pso.js")?.component, "cli");
  const dest = tmp();
  const r = extractPackage(buf, dest, { trustedKeys: trust });
  assert.equal(r.files, 3);
  assert.equal(readFileSync(join(dest, "cli", "bin", "pso.js"), "utf8"), "console.log('SECRET-LOOKING-BUT-PUBLIC-MARKER-12345');\n");
  assert.equal(readHeader(buf, trust).signer, signer.id);
});

test("encryption: only the listed recipients can read; there is no universal key; plaintext never appears in the file", () => {
  const buf = pack({ recipients: [{ publicKeyPem: alice.publicKeyPem }, { publicKeyPem: bob.publicKeyPem }] });
  assert.ok(!buf.includes("SECRET-LOOKING-BUT-PUBLIC-MARKER"), "the content is not in the clear");
  const noKey = verifyPackage(buf, { trustedKeys: trust });
  assert.deepEqual([noKey.encrypted, noKey.contentsVerified], [true, false], "without a key only the signature and header are verified, and it says so");
  for (const who of [alice, bob]) assert.equal(verifyPackage(buf, { trustedKeys: trust, recipientKeyPem: who.privateKeyPem }).contentsVerified, true);
  assert.equal(code(() => verifyPackage(buf, { trustedKeys: trust, recipientKeyPem: carol.privateKeyPem })), "PSOPKG_DECRYPT", "a key that was not a recipient");
  assert.equal(code(() => verifyPackage(buf, { trustedKeys: trust, recipientKeyPem: signer.privateKeyPem })), "PSOPKG_KEY", "a signing key is not a recipient key");
  assert.equal(code(() => extractPackage(buf, tmp(), { trustedKeys: trust })), "PSOPKG_DECRYPT", "extraction needs a key");
  const dest = tmp();
  assert.equal(extractPackage(buf, dest, { trustedKeys: trust, recipientKeyPem: bob.privateKeyPem }).files, 3);
});

test("authenticity: any modification, truncation, extension or foreign signer is refused before anything is decrypted or written", () => {
  const buf = pack({ recipients: [{ publicKeyPem: alice.publicKeyPem }] });
  const flip = (at: number): Buffer => { const c = Buffer.from(buf); c[at] = c[at]! ^ 0xff; return c; };
  const headerLen = buf.readUInt32BE(8);
  for (const [name, mutated] of [["header byte", flip(12 + 10)], ["payload byte", flip(12 + headerLen + 8 + 5)], ["signature byte", flip(buf.length - 3)], ["magic", flip(2)]] as const) {
    assert.ok(["PSOPKG_SIGNATURE", "PSOPKG_FORMAT"].includes(code(() => verifyPackage(mutated, { trustedKeys: trust, recipientKeyPem: alice.privateKeyPem }))!), name);
  }
  assert.equal(code(() => verifyPackage(buf.subarray(0, buf.length - 10), { trustedKeys: trust })), "PSOPKG_FORMAT", "truncated");
  assert.equal(code(() => verifyPackage(Buffer.concat([buf, Buffer.from("extra")]), { trustedKeys: trust })), "PSOPKG_FORMAT", "trailing bytes");
  assert.equal(code(() => verifyPackage(buf, { trustedKeys: [{ id: other.id, publicKeyPem: other.publicKeyPem }] })), "PSOPKG_SIGNATURE", "signed by someone the caller does not trust");
  assert.equal(code(() => verifyPackage(buf, { trustedKeys: [] })), "PSOPKG_SIGNATURE", "no trusted key at all");
  assert.equal(code(() => verifyPackage(Buffer.from("not a package at all, just some bytes"), { trustedKeys: trust })), "PSOPKG_FORMAT");
  // a package whose header names a different signer is still judged only by the keys the CALLER trusts
  const forged = assemble({ ...readHeader(buf, trust).header, signer: signer.id }, buf.subarray(0, 0), other.privateKeyPem);
  assert.equal(code(() => verifyPackage(forged, { trustedKeys: trust })), "PSOPKG_SIGNATURE");
});

/** a correctly signed package built by hand: the signature proves who wrote it, not that it is harmless */
function hostile(files: Array<{ path: string; data: Buffer }>, mutate: (h: Header) => void = () => undefined, payloadOverride?: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const p = Buffer.from(f.path, "utf8");
    const head = Buffer.alloc(2 + p.length + 1 + 8);
    head.writeUInt16BE(p.length, 0); p.copy(head, 2); head.writeUInt8(0, 2 + p.length); head.writeBigUInt64BE(BigInt(f.data.length), 3 + p.length);
    parts.push(head, f.data);
  }
  const raw = Buffer.concat(parts);
  const fileEntries = files.map((f) => ({ path: f.path, size: f.data.length, sha256: sha(f.data) }));
  const header: Header = { format: 1, ...META, createdAt: new Date().toISOString(), dependencies: [], installRules: {}, files: fileEntries, archive: { compression: "zstd", size: raw.length, sha256: sha(raw), manifestDigest: sha(Buffer.from(JSON.stringify(fileEntries))) }, encryption: null, signer: signer.id };
  mutate(header);
  return assemble(header, payloadOverride ?? zstdCompressSync(raw), signer.privateKeyPem);
}

test("hostile paths: traversal, absolute, backslashes, drive letters, reserved names and case-duplicates are rejected", () => {
  for (const bad of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/Windows/x.dll", "a\\b.txt", "a/./b.txt", "a//b.txt", "CON", "dir/NUL.txt", "trailing.", "x/\u0001y"]) {
    assert.equal(code(() => verifyPackage(hostile([{ path: bad, data: Buffer.from("x") }]), { trustedKeys: trust })), "PSOPKG_PATH", JSON.stringify(bad));
  }
  assert.equal(code(() => verifyPackage(hostile([{ path: "A.txt", data: Buffer.from("1") }, { path: "a.txt", data: Buffer.from("2") }]), { trustedKeys: trust })), "PSOPKG_FORMAT", "paths that collide on a case-insensitive file system");
  assert.equal(verifyPackage(hostile([{ path: "ok/file.txt", data: Buffer.from("fine") }]), { trustedKeys: trust }).contentsVerified, true, "a legitimate hand-built package passes");
});

test("archive bombs and lying headers are stopped by declared, bounded sizes", () => {
  const big = Buffer.alloc(40 * 1024 * 1024, 0);
  // header declares 1000 bytes, the compressed payload expands to 40 MiB
  const lie = hostile([{ path: "a.bin", data: Buffer.alloc(1000, 1) }], () => undefined, zstdCompressSync(big));
  assert.equal(code(() => verifyPackage(lie, { trustedKeys: trust })), "PSOPKG_INTEGRITY", "decompression never produces more than the declared size");
  // honest but implausible ratio on a large declaration
  const ratio = hostile([{ path: "z.bin", data: Buffer.alloc(70 * 1024 * 1024, 0) }]);
  assert.equal(code(() => verifyPackage(ratio, { trustedKeys: trust })), "PSOPKG_LIMIT", "a 70 MiB archive that is a few KiB compressed");
  assert.equal(code(() => verifyPackage(ratio, { trustedKeys: trust, limits: { maxHeaderBytes: 4 << 20, maxFiles: 10, maxPathLength: 240, maxUncompressedBytes: 1 << 20, maxPackageBytes: 1 << 30, maxCompressionRatio: 200 } })), "PSOPKG_LIMIT", "configured maximum size");
  assert.equal(code(() => verifyPackage(hostile([{ path: "a", data: Buffer.from("1") }, { path: "b", data: Buffer.from("2") }]), { trustedKeys: trust, limits: { maxHeaderBytes: 4 << 20, maxFiles: 1, maxPathLength: 240, maxUncompressedBytes: 1 << 30, maxPackageBytes: 1 << 30, maxCompressionRatio: 200 } })), "PSOPKG_FORMAT", "too many files");
  // payload that does not match the hashes recorded in the (signed) header
  assert.equal(code(() => verifyPackage(hostile([{ path: "a.txt", data: Buffer.from("real") }], (h) => { h.files[0]!.sha256 = sha(Buffer.from("different")); h.archive.manifestDigest = sha(Buffer.from(JSON.stringify(h.files))); }), { trustedKeys: trust })), "PSOPKG_INTEGRITY");
  // an extra file hidden in the archive that the header does not list
  assert.equal(code(() => verifyPackage(hostile([{ path: "a.txt", data: Buffer.from("x") }, { path: "b.txt", data: Buffer.from("y") }], (h) => { h.files.pop(); h.archive.manifestDigest = sha(Buffer.from(JSON.stringify(h.files))); }), { trustedKeys: trust })), "PSOPKG_INTEGRITY");
});

test("extraction never writes outside the target, never through links, never over existing files without consent, and writes nothing on failure", (t) => {
  const buf = pack();
  // existing file: refused, nothing at all is written
  const dest = tmp();
  put(dest, "cli/package.json", "ORIGINAL");
  assert.equal(code(() => extractPackage(buf, dest, { trustedKeys: trust })), "PSOPKG_EXISTS");
  assert.equal(readFileSync(join(dest, "cli", "package.json"), "utf8"), "ORIGINAL");
  assert.ok(!existsSync(join(dest, "studio")) && !existsSync(join(dest, "cli", "bin")), "all-or-nothing: no partial extraction");
  extractPackage(buf, dest, { trustedKeys: trust, overwrite: true });
  assert.equal(readFileSync(join(dest, "cli", "package.json"), "utf8"), '{"name":"cli"}', "replaced only because overwrite was explicit");
  // a directory in the target that is really a link pointing outside
  const outside = tmp(), target = tmp();
  try { symlinkSync(outside, join(target, "cli"), process.platform === "win32" ? "junction" : "dir"); } catch { return t.skip("links cannot be created here"); }
  assert.equal(code(() => extractPackage(buf, target, { trustedKeys: trust })), "PSOPKG_PATH", "refuses to write through a link");
  assert.deepEqual(existsSync(join(outside, "bin")), false, "nothing was written outside the target");
  assert.equal(code(() => extractPackage(hostile([{ path: "a.txt", data: Buffer.from("x") }]), tmp(), { trustedKeys: [{ id: other.id, publicKeyPem: other.publicKeyPem }] })), "PSOPKG_SIGNATURE", "an unauthenticated package writes nothing");
});

test("packing refuses secrets, links and empty stages, and signing keys must be Ed25519", () => {
  for (const secret of [".env", "config/.env.production", "keys/dev.pem", "cert/server.key", "ssl/id.p12", "home/.ssh/id_rsa", "debug.log", ".git/config", ".pso/state.json", "data/app.sqlite", "old/previous.psopkg"]) {
    const s = stage(); put(s, secret, "x");
    assert.equal(code(() => packStage({ stageDir: s, meta: META, signingKeyPem: signer.privateKeyPem })), "PSOPKG_DENIED", secret);
  }
  assert.equal(code(() => packStage({ stageDir: tmp(), meta: META, signingKeyPem: signer.privateKeyPem })), "PSOPKG_FORMAT", "empty stage");
  const linked = stage(), elsewhere = tmp();
  try { symlinkSync(elsewhere, join(linked, "ext"), process.platform === "win32" ? "junction" : "dir"); assert.equal(code(() => packStage({ stageDir: linked, meta: META, signingKeyPem: signer.privateKeyPem })), "PSOPKG_FORMAT", "links are never packed"); } catch { /* links unavailable */ }
  assert.equal(code(() => packStage({ stageDir: stage(), meta: META, signingKeyPem: alice.privateKeyPem })), "PSOPKG_KEY", "an X25519 key cannot sign");
  assert.equal(code(() => packStage({ stageDir: stage(), meta: META, signingKeyPem: signer.privateKeyPem, recipients: [{ publicKeyPem: signer.publicKeyPem }] })), "PSOPKG_KEY", "an Ed25519 key cannot be a recipient");
});
