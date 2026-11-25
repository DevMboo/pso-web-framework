import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..", "..");
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* temp */ } } });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "pso-relt-")); dirs.push(d); return d; };
const node = (script: string, ...a: string[]) => spawnSync(process.execPath, [join(root, "scripts", script), ...a], { encoding: "utf8", timeout: 280_000, cwd: root });
const keypair = (dir: string, name: string) => {
  const kp = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, `${name}.private.pem`), kp.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(dir, `${name}.public.pem`), kp.publicKey.export({ type: "spki", format: "pem" }));
};

test("npm release: pack, checksums, SBOM, signing with a disposable key, DSSE provenance, and verification that rejects every tamper", { timeout: 300_000 }, () => {
  const w = tmp(), keys = join(w, "keys"); mkdirSync(keys);
  keypair(keys, "release"); keypair(keys, "other");
  const out = join(w, "out");
  const r = node("release.mjs", "npm", "--out", out, "--sign-key", join(keys, "release.private.pem"), "--skip-install-test", "--skip-audit");
  assert.equal(r.status, 0, r.stdout.slice(-1500) + r.stderr.slice(-500));
  assert.match(r.stdout, /PASSED\s+signing/); assert.match(r.stdout, /PASSED\s+content policy/); assert.match(r.stdout, /PASSED\s+secret scan/);
  for (const f of ["SHA256SUMS", "SHA256SUMS.sig", "manifest.json", "manifest.json.sig", "provenance.intoto.json", "sbom.cdx.json", "licenses.json", "secret-scan.json"]) assert.ok(existsSync(join(out, f)), f);
  assert.equal(readdirSync(out).filter((f) => f.endsWith(".tgz")).length, 13, "eight framework packages, @pso/deploy (Cloud Lifecycle & Operations, with its bundled agent), the three frontend packages and @pso/infra (0.2.0)");
  assert.ok(readdirSync(out).some((f) => /^pso-deploy-/.test(f)), "the deploy package is part of the release");

  const trust = join(keys, "release.public.pem");
  const v = node("verify-release.mjs", out, "--trust", trust);
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /VERIFIED/); assert.match(v.stdout, /self-asserted/);

  assert.equal(node("verify-release.mjs", out, "--trust", join(keys, "other.public.pem")).status, 1, "a key you do not trust verifies nothing");
  // tamper 1: a tarball
  const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"))!;
  const copy = join(w, "tampered"); mkdirSync(copy);
  for (const f of readdirSync(out)) writeFileSync(join(copy, f), readFileSync(join(out, f)));
  appendFileSync(join(copy, tgz), "x");
  const t1 = node("verify-release.mjs", copy, "--trust", trust);
  assert.equal(t1.status, 1); assert.match(t1.stdout, /checksum mismatch/);
  // tamper 2: the checksum file itself (signature must fail)
  const copy2 = join(w, "tampered2"); mkdirSync(copy2);
  for (const f of readdirSync(out)) writeFileSync(join(copy2, f), readFileSync(join(out, f)));
  appendFileSync(join(copy2, "SHA256SUMS"), `${"0".repeat(64)} *evil.tgz\n`);
  const t2 = node("verify-release.mjs", copy2, "--trust", trust);
  assert.equal(t2.status, 1); assert.match(t2.stdout, /SHA256SUMS signature does not verify/);
  // tamper 3: provenance subject swapped
  const copy3 = join(w, "tampered3"); mkdirSync(copy3);
  for (const f of readdirSync(out)) writeFileSync(join(copy3, f), readFileSync(join(out, f)));
  const env = JSON.parse(readFileSync(join(copy3, "provenance.intoto.json"), "utf8"));
  const st = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")); st.subject[0].digest.sha256 = "0".repeat(64);
  env.payload = Buffer.from(JSON.stringify(st)).toString("base64");
  writeFileSync(join(copy3, "provenance.intoto.json"), JSON.stringify(env));
  const t3 = node("verify-release.mjs", copy3, "--trust", trust);
  assert.equal(t3.status, 1); assert.match(t3.stdout, /provenance envelope signature does not verify/);
  // unsigned releases are reported as such, never verified
  const unsigned = join(w, "unsigned");
  const u = node("release.mjs", "npm", "--out", unsigned, "--skip-install-test", "--skip-audit");
  assert.equal(u.status, 0); assert.match(u.stdout, /NOT RUN\s+signing/);
  assert.equal(node("verify-release.mjs", unsigned, "--trust", trust).status, 1);
  // a key inside the repository is refused
  const inRepo = join(root, "release-out", "test-key-do-not-use.pem");
  mkdirSync(join(root, "release-out"), { recursive: true }); writeFileSync(inRepo, readFileSync(join(keys, "release.private.pem")));
  try { const x = node("release.mjs", "npm", "--out", join(w, "o3"), "--sign-key", inRepo, "--skip-install-test", "--skip-audit"); assert.match(x.stdout, /FAILED\s+signing.*inside the repository/); }
  finally { rmSync(inRepo, { force: true }); }
});
