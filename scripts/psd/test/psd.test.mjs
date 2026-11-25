import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { scan } from "../scan.mjs";
import { buildStage } from "../stage.mjs";
import { classify } from "../policy.mjs";
import { generateKeyPair, packStage } from "../../../packages/cli/src/psopkg.ts";

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* OS reaps temp */ } });

// a throwaway private-key header and token, assembled at run time so this test file itself never contains a matchable literal
const PRIV = ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\nMC4CAQAwBQYDK2VwBCIEIA==\n" + ["-----END", "PRIVATE KEY-----"].join(" ") + "\n";
const JWT = ["eyJhbGciOiJFUzI1NiJ9", "eyJzdWIiOiJhbmEiLCJyb2xlIjoiYWRtaW4ifQ", "c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc"].join(".");

function zip(entries, method = 8) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name), raw = Buffer.from(data), comp = method === 8 ? deflateRawSync(raw) : raw, crc = crc32(raw) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
function tar(entries) {
  const parts = [];
  for (const [name, data] of entries) {
    const raw = Buffer.from(data), h = Buffer.alloc(512);
    h.write(name, 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116); h.write(raw.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156); h.write("ustar\0" + "00", 257);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, raw, Buffer.alloc((512 - (raw.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const put = (root, rel, data) => { const f = join(root, ...rel.split("/")); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, data); };
const rules = (r) => new Set(r.findings.map((f) => f.rule));

test("a clean tree passes and reports what it inspected", () => {
  const d = tmp("psd-clean-");
  put(d, "node_modules/@pso/core/dist/index.js", "export const a = 1;\n");
  put(d, "node_modules/@pso/cli/docs/a.md", "# hello\n");
  const r = scan(d);
  assert.equal(r.ok, true); assert.equal(r.stats.files, 2);
});

test("a private key two archive levels deep (npm tarball inside a jar) is found, located, and never printed", () => {
  const d = tmp("psd-nested-");
  const tgz = gzipSync(tar([["package/index.js", "ok\n"], ["package/secret/id.txt", PRIV]]));
  put(d, "lib/vendor.jar", zip([["META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n"], ["inner/pkg.tgz", tgz]]));
  const r = scan(d);
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.rule === "private-key");
  assert.ok(f, "found");
  assert.match(f.path, /vendor\.jar!\/inner\/pkg\.tgz!\/package\/secret\/id\.txt/);
  assert.equal(r.stats.maxDepth, 2);
  const text = JSON.stringify(r);
  assert.ok(!text.includes("MC4CAQAw") && !text.includes("BEGIN PRIVATE"), "the report never contains the matched value");
});

test("encoded secrets: a base64 JWT inside a bundle is decoded and found", () => {
  const d = tmp("psd-b64-");
  put(d, "app/bundle.js", `var x = "${Buffer.from(`Authorization: Bearer ${JWT}`).toString("base64")}";\n`);
  const r = scan(d);
  assert.ok(rules(r).has("jwt") || rules(r).has("bearer-literal"), JSON.stringify(r.findings));
});

test("fixture references, developer paths and the private deny-list are findings; waivers need a reason", () => {
  const d = tmp("psd-ref-");
  put(d, "docs/a.md", "see fixtures/pso-commerce for the demo and C:\\Users\\someone\\work\\x\n");
  put(d, "docs/b.md", "host corp-internal-7 is where it runs\n");
  const r = scan(d, { denylist: ["corp-internal-7"] });
  assert.deepEqual([...rules(r)].sort(), ["denylist", "dev-path-windows", "fixture-reference"]);
  const w1 = scan(d, { denylist: ["corp-internal-7"], exceptions: [{ rule: "denylist", pathPrefix: "docs/", reason: "" }] });
  assert.ok(rules(w1).has("denylist"), "a waiver without a reason is ignored");
  const w2 = scan(d, { denylist: ["corp-internal-7"], exceptions: [{ rule: "denylist", pathPrefix: "docs/", reason: "test" }] });
  assert.ok(!rules(w2).has("denylist"));
});

test("name rules: fixtures directory, source maps, env files, key files and sources jars are findings", () => {
  const d = tmp("psd-names-");
  for (const f of ["fixtures/x/readme.txt", "dist/a.js.map", "cfg/.env", "keys/server.pem", "lib/pso-http-0.1.0-sources.jar"]) put(d, f, "x");
  put(d, "keys/release.public.pem", "-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----\n"); // a public key is fine
  const r = scan(d);
  const names = new Set(r.findings.filter((f) => f.rule.startsWith("name-")).map((f) => f.path));
  for (const f of ["fixtures/x/readme.txt", "dist/a.js.map", "cfg/.env", "keys/server.pem", "lib/pso-http-0.1.0-sources.jar"]) assert.ok(names.has(f), f);
  assert.ok(!names.has("keys/release.public.pem"));
});

test("bounds: a compression bomb and over-deep nesting are uninspectable, which fails the scan", () => {
  const d = tmp("psd-bomb-");
  put(d, "bomb.zip", zip([["zeros.bin", Buffer.alloc(8 * 1024 * 1024)]]));
  const r = scan(d, { limits: { maxRatio: 50 } });
  assert.equal(r.ok, false); assert.ok(r.uninspectable.some((u) => /ratio/.test(u.reason)));
  let inner = zip([["leaf.txt", "x"]]);
  for (let i = 0; i < 4; i++) inner = zip([[`l${i}.zip`, inner]]);
  put(d, "deep.zip", inner);
  const deep = scan(join(d, "deep.zip"), { limits: { maxDepth: 2 } });
  assert.equal(deep.ok, false); assert.ok(deep.uninspectable.some((u) => /nesting/.test(u.reason)));
});

test("a link or junction in the tree is a finding and is never followed", () => {
  const d = tmp("psd-link-"), outside = tmp("psd-outside-");
  put(outside, "secret.txt", PRIV);
  try { symlinkSync(outside, join(d, "linked"), "junction"); } catch { return; /* cannot create links here */ }
  const r = scan(d);
  assert.ok(rules(r).has("symlink-or-junction")); assert.ok(!rules(r).has("private-key"), "the link target was not read");
});

test("encrypted package: uninspectable without evidence, covered by pre-encryption evidence; an unencrypted package is opened and scanned", () => {
  const d = tmp("psd-pkg-"), stage = tmp("psd-pkg-stage-");
  put(stage, "app/run.js", "console.log(1);\n");
  const sign = generateKeyPair("signing"), rcpt = generateKeyPair("recipient");
  const meta = { name: "t", version: "1.0.0", platform: "win32", arch: "x64", components: [{ name: "c", version: "1.0.0" }] };
  const enc = packStage({ stageDir: stage, meta, signingKeyPem: sign.privateKeyPem, recipients: [{ publicKeyPem: rcpt.publicKeyPem }] });
  put(d, "t.psopkg", enc);
  const r = scan(d);
  assert.equal(r.ok, false); assert.ok(r.uninspectable[0].encrypted);
  const covered = scan(d, { preEncryptionEvidence: new Set([createHash("sha256").update(enc).digest("hex")]) });
  assert.equal(covered.ok, true); assert.equal(covered.coveredByPreEncryptionEvidence, 1);
  const plain = packStage({ stageDir: stage, meta, signingKeyPem: sign.privateKeyPem });
  put(d, "plain.psopkg", plain);
  assert.ok(scan(join(d, "plain.psopkg")).stats.files >= 1, "an unencrypted package is opened and its files scanned");
});

test("classification: unknown files fail the stage, restricted files are dropped, links are refused, nothing leaves the workspace", () => {
  assert.equal(classify("node_modules/@pso/core/dist/index.js").cls, "B");
  assert.equal(classify("node_modules/@pso/cli/dist/main.js").cls, "A");
  assert.equal(classify("node_modules/@pso/cli/templates/fei/src/x.ts").cls, "C");
  assert.equal(classify("node_modules/@pso/cli/dist/main.js.map").cls, "E");
  assert.equal(classify("fixtures/pso-commerce/x.js").cls, "E");
  assert.equal(classify("node_modules/@pso/core/src/x.ts").cls, "E", "original TypeScript sources are restricted");
  assert.equal(classify("something/unlisted.txt"), null);

  const ws = tmp("psd-ws-"), out = tmp("psd-out-");
  put(ws, "p/core/dist/index.js", "export {}\n"); put(ws, "p/core/dist/index.js.map", "{}"); put(ws, "p/core/package.json", "{}");
  const cfg = (extra = []) => { const f = join(ws, "dist.config.json"); writeFileSync(f, JSON.stringify({ name: "t", version: "1.0.0", platform: "win32", arch: "x64", components: [{ name: "c", version: "1.0.0", include: [{ from: "p/core/dist", to: "node_modules/@pso/core/dist" }, { from: "p/core/package.json", to: "node_modules/@pso/core" }, ...extra] }] })); return f; };
  const s1 = join(out, "s1");
  const ok = buildStage({ out: s1, config: cfg(), sourceRoot: ws });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.manifest.dropped, 1); assert.ok(!existsSync(join(s1, "node_modules/@pso/core/dist/index.js.map")));
  put(ws, "p/extra/notes.txt", "x");
  const bad = buildStage({ out: join(out, "s2"), config: cfg([{ from: "p/extra", to: "misc" }]), sourceRoot: ws });
  assert.equal(bad.ok, false); assert.match(bad.problems.join(" "), /no classification rule/); assert.ok(!existsSync(join(out, "s2")), "a failed stage is removed");
  const esc = buildStage({ out: join(out, "s3"), config: cfg([{ from: "../outside", to: "x" }]), sourceRoot: ws });
  assert.equal(esc.ok, false); assert.match(esc.problems.join(" "), /outside the workspace/);
  assert.throws(() => buildStage({ out: join(ws, "stage-inside"), config: cfg(), sourceRoot: ws }), /outside the repository/);
});
