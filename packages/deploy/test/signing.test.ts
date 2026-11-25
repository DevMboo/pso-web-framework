import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentClient, CloudError, type Transport } from "../src/client.ts";
import { MemoryCredentialProvider } from "../src/credentials.ts";
import { generateIdentity } from "../src/crypto.ts";
import { LocalStore, type ConnectionRecord } from "../src/local-state.ts";
import type { Request } from "../src/protocol.ts";
import { Auth } from "../src/agent/auth.ts";
import { AgentServer } from "../src/agent/server.ts";
import { AgentState } from "../src/agent/state.ts";
import { Cloud } from "../src/cloud.ts";
import { generateSigner, signManifest, treeDigest, verifySigned, type ReleaseManifest, type TrustedSigner } from "../src/signing.ts";
import type { DeploymentDecl } from "../src/declare.ts";

/** Release signing: authenticity (a trusted signer) is separate from integrity (the bytes named), is enforced by the SERVER, and cannot be overridden by the project. */
const COMMIT = "a".repeat(40);
const trusted = (s: { keyId: string; publicKey: string }, name = "ci", extra: Partial<TrustedSigner> = {}): TrustedSigner => ({ keyId: s.keyId, name, publicKey: s.publicKey, addedAt: "2026-01-01T00:00:00Z", addedBy: "test", ...extra });
const manifest = (over: Partial<ReleaseManifest> = {}): ReleaseManifest => ({ v: 1, app: "shop", source: { kind: "git", commit: COMMIT }, sequence: 5, createdAt: "2026-01-01T00:00:00Z", ...over });
const expectGit = { app: "shop", source: { kind: "git" as const, commit: COMMIT } };

test("a valid signature by a trusted signer is authentic AND integral; every other state is named, never a pass", () => {
  const a = generateSigner(); const b = generateSigner();
  const signed = signManifest(manifest(), a.privateKey, a.publicKey);
  const ok = verifySigned(signed, [trusted(a)], expectGit); assert.equal(ok.authenticity, "verified"); assert.equal(ok.integrity, "verified"); assert.equal(ok.sequence, 5); assert.equal(ok.signer?.name, "ci");
  assert.equal(verifySigned(undefined, [trusted(a)], expectGit).authenticity, "unsigned");
  assert.equal(verifySigned(signed, [trusted(b)], expectGit).authenticity, "untrusted-signer", "a key this environment does not trust");
  assert.equal(verifySigned(signed, [], expectGit).authenticity, "untrusted-signer");
  assert.equal(verifySigned(signed, [trusted(a, "ci", { revokedAt: "2026-02-01T00:00:00Z", revokedReason: "key leaked" })], expectGit).authenticity, "revoked-signer");
  assert.equal(verifySigned(signed, [trusted(a, "ci", { notAfter: "2020-01-01T00:00:00Z" })], expectGit).authenticity, "expired-signer");
  assert.equal(verifySigned(signed, [trusted(a, "ci", { apps: ["other"] })], expectGit).authenticity, "signer-not-allowed-for-app");
  assert.equal(verifySigned(signed, [trusted(a, "ci", { apps: ["shop"] })], expectGit).authenticity, "verified");
});

test("tampering: a modified manifest, a signature from another key under a trusted id, a different release, a different app", () => {
  const a = generateSigner(); const b = generateSigner();
  const signed = signManifest(manifest(), a.privateKey, a.publicKey);
  // the manifest text is altered (a different commit) but the signature is kept
  const altered = { ...signed, manifest: signed.manifest.replace(COMMIT, "b".repeat(40)) };
  const t = verifySigned(altered, [trusted(a)], { app: "shop", source: { kind: "git", commit: "b".repeat(40) } }); assert.equal(t.authenticity, "invalid-signature"); assert.notEqual(t.integrity, "verified");
  // somebody else's signature presented under a's key id
  const forged = { manifest: signed.manifest, signatures: [{ keyId: a.keyId, sig: signManifest(manifest(), b.privateKey, b.publicKey).signatures[0]!.sig }] };
  assert.equal(verifySigned(forged, [trusted(a)], expectGit).authenticity, "invalid-signature");
  // a genuine signature, but over a different release than the one the server resolved
  const other = verifySigned(signed, [trusted(a)], { app: "shop", source: { kind: "git", commit: "c".repeat(40) } }); assert.equal(other.authenticity, "manifest-mismatch"); assert.equal(other.integrity, "failed");
  assert.equal(verifySigned(signed, [trusted(a)], { app: "another-app", source: { kind: "git", commit: COMMIT } }).authenticity, "manifest-mismatch");
  assert.equal(verifySigned(signed, [trusted(a)], { app: "shop", source: { kind: "artifact", sha256: "d".repeat(64) } }).authenticity, "manifest-mismatch");
  // non-canonical JSON (extra whitespace) is not what was signed
  assert.equal(verifySigned({ ...signed, manifest: JSON.stringify(JSON.parse(signed.manifest), null, 2) }, [trusted(a)], expectGit).authenticity, "invalid-signature");
});

test("domain separation: a request signature can never pass as a release signature", async () => {
  const a = generateSigner(); const { signText } = await import("../src/crypto.ts");
  const text = manifest(); const { canonical } = await import("../src/crypto.ts");
  const bare = { manifest: canonical(text), signatures: [{ keyId: a.keyId, sig: signText(a.privateKey, canonical(text)) }] }; // signed WITHOUT the domain prefix
  assert.equal(verifySigned(bare, [trusted(a)], expectGit).authenticity, "invalid-signature");
});

test("treeDigest is platform independent and ignores .git; an artifact tree change is detected", () => {
  const d = mkdtempSync(join(tmpdir(), "pso-tree-")); mkdirSync(join(d, "sub")); mkdirSync(join(d, ".git")); writeFileSync(join(d, "a.txt"), "one"); writeFileSync(join(d, "sub", "b.txt"), "two"); writeFileSync(join(d, ".git", "HEAD"), "x");
  const h = treeDigest(d); writeFileSync(join(d, ".git", "HEAD"), "changed"); assert.equal(treeDigest(d), h, ".git is ignored");
  writeFileSync(join(d, "sub", "b.txt"), "tw0"); assert.notEqual(treeDigest(d), h);
});

test("private signing keys stay in the credential store: never in signers.json, never returned, never sent", () => {
  const home = mkdtempSync(join(tmpdir(), "pso-signers-")); const creds = new MemoryCredentialProvider(); const cloud = new Cloud({ store: new LocalStore(home), creds });
  const s = cloud.signerGenerate("release bot"); assert.match(s.keyId, /^SHA256:/);
  const file = readFileSync(join(home, "signers.json"), "utf8"); assert.doesNotMatch(file, /PRIVATE KEY/); assert.match(file, /PUBLIC KEY/);
  assert.doesNotMatch(JSON.stringify(cloud.signers()), /PRIVATE KEY|privateRef/);
  assert.throws(() => cloud.signerGenerate("release bot"), /already exists/, "rotation is a NEW key, never an overwrite");
  const m = manifest(); const signed = cloud.signRelease("release bot", m);
  assert.equal(verifySigned(signed, [trusted(s)], expectGit).authenticity, "verified");
  assert.doesNotMatch(JSON.stringify(signed), /PRIVATE KEY/);
  assert.equal(cloud.signerRemove("release bot").removed, true); assert.throws(() => cloud.signRelease("release bot", m), /no signer/);
});

// ---------------------------------------------------------------- the server decides (in-process agent)
class InProcess implements Transport { private readonly server: AgentServer; constructor(server: AgentServer) { this.server = server; } send(req: Request) { return this.server.handle(req); } close(): void { /* nothing */ } }
const noSpawn = () => ({ pid: undefined });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "pso-sign-agent-")); const state = new AgentState(home);
  const prov = Auth.provision(state, "development", { emitToken: true, environment: "testing" });
  const store = new LocalStore(mkdtempSync(join(tmpdir(), "pso-sign-local-"))); const creds = new MemoryCredentialProvider();
  const conn: ConnectionRecord = { name: "t", host: "h", port: 22, user: "u", auth: { kind: "agent" }, timeoutSeconds: 5, agentDir: ".x", createdAt: "", credentialVersion: 1, agentFingerprint: prov.fingerprint };
  const open = async (token: string, name: string) => {
    const keys = generateIdentity(); const c0 = await AgentClient.connect(conn, { store, creds }, { noSession: true, transport: () => new InProcess(new AgentServer(home, noSpawn, "src")) });
    const e = await c0.enroll(token, keys.publicKey, keys.privateKey, name); c0.close();
    const ref = `k-${createHash("sha256").update(e.clientId).digest("hex").slice(0, 16)}`; creds.set(ref, keys.privateKey);
    return AgentClient.connect({ ...conn, clientKeyRef: ref, clientId: e.clientId }, { store, creds }, { transport: () => new InProcess(new AgentServer(home, noSpawn, "src")) });
  };
  return { home, state, prov, open };
}
function gitRepo(): { url: string; commit: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pso-sign-repo-")); const g = (...a: string[]) => { const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.test"); g("config", "user.name", "t"); writeFileSync(join(dir, "server.js"), "console.log(1)"); g("add", "-A"); g("commit", "-q", "-m", "r1");
  return { url: pathToFileURL(dir).href, commit: g("rev-parse", "HEAD"), dir };
}
const decl = (url: string): DeploymentDecl => ({ name: "shop", environment: "testing", connection: { provider: "ssh", credentials: "c" }, source: { provider: "git", url, branch: "main" }, service: { name: "web", runtime: "node", start: ["node", "server.js"], port: 21777, shutdownGraceSeconds: 5 }, strategy: { type: "recreate", proxy: "none", downtimeAcknowledged: true } });
const signedBlockers = (b: string[]) => b.filter((x) => /signed|signature|replay|downgrade/i.test(x));
const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e: CloudError) => e.code);

test("server-side enforcement: an environment that requires signed releases refuses unsigned, untrusted, revoked, wrong-release and replayed ones, whatever the project declares", async () => {
  const s = setup(); const repo = gitRepo(); const admin = await s.open(s.prov.bootstrapToken!, "admin");
  const deployer = await s.open(Auth.createToken(s.state, "deployer", 5, "test").token, "dev");
  const signer = generateSigner(); const stranger = generateSigner();
  const sign = (k: ReturnType<typeof generateSigner>, over: Partial<ReleaseManifest> = {}) => signManifest(manifest({ app: "shop", source: { kind: "git", commit: repo.commit }, ...over }), k.privateKey, k.publicKey);
  const plan = (c: AgentClient, signed?: unknown, pipeline?: unknown) => c.call<any>("release.propose", { declaration: decl(repo.url), ...(signed ? { signed } : {}), ...(pipeline ? { pipeline } : {}) });

  // by default signing is optional: an unsigned release is allowed, with a warning
  const p0 = await plan(admin); assert.equal(p0.provenance.authenticity, "unsigned"); assert.deepEqual(signedBlockers(p0.blockers), []); assert.ok(p0.warnings.some((w: string) => /unsigned/.test(w)));

  // only a superadministrator changes trust; a deployer cannot make its own key trusted
  assert.equal(await errCode(deployer.call("trust.add", { publicKey: signer.publicKey, name: "ci" })), "FORBIDDEN");
  await admin.call("trust.add", { publicKey: signer.publicKey, name: "ci" });
  assert.equal(await errCode(admin.call("trust.add", { publicKey: signer.publicKey, name: "ci again" })), "CONFLICT");
  assert.equal((await deployer.call<any[]>("trust.list")).length, 1, "anyone with a session may SEE which signers are trusted");
  await admin.call("policy.set", { changes: { requireSignedReleases: true } });

  // required: unsigned is a blocker, and no pipeline setting (all stages disabled) changes that
  const lax = { name: "lax", stages: [{ type: "integrity", enabled: false }, { type: "security", enabled: false }, { type: "tests", enabled: false }] };
  const p1 = await plan(deployer, undefined, lax); assert.ok(signedBlockers(p1.blockers).some((b) => /requires releases signed/.test(b)), p1.blockers.join(" | "));
  // a signature by a key this environment does not trust, and one over a different commit
  assert.ok(signedBlockers((await plan(deployer, sign(stranger))).blockers).some((b) => /untrusted-signer/.test(b)));
  assert.ok(signedBlockers((await plan(deployer, signManifest(manifest({ app: "shop", source: { kind: "git", commit: "e".repeat(40) } }), signer.privateKey, signer.publicKey))).blockers).some((b) => /manifest-mismatch/.test(b)));
  // a trusted signer over THIS commit: accepted, and the plan records who vouched for it
  const good = sign(signer, { sequence: 7 }); const p2 = await plan(deployer, good);
  assert.equal(p2.provenance.authenticity, "verified"); assert.equal(p2.provenance.signer.name, "ci"); assert.deepEqual(signedBlockers(p2.blockers), []);
  // replay / downgrade: the application already deployed sequence 9
  mkdirSync(join(s.home, "apps", "shop"), { recursive: true });
  writeFileSync(join(s.home, "apps", "shop", "app.json"), JSON.stringify({ name: "shop", releases: [], stablePorts: {}, lastSignedSequence: 9 }));
  const old = await plan(deployer, good); assert.ok(signedBlockers(old.blockers).some((b) => /replay or a downgrade/.test(b)), old.blockers.join(" | "));
  assert.deepEqual(signedBlockers((await plan(deployer, sign(signer, { sequence: 10 }))).blockers), [], "a newer sequence is accepted");

  // the trust decision is taken AGAIN at start: a signer revoked after the plan was approved stops the deployment
  const p3 = await plan(deployer, sign(signer, { sequence: 11 })); assert.deepEqual(signedBlockers(p3.blockers), []);
  await admin.call("trust.revoke", { keyId: signer.keyId, reason: "key leaked" });
  assert.equal(await errCode(deployer.call("release.start", { app: "shop", planHash: p3.hash })), "POLICY");
  const p4 = await plan(deployer, sign(signer, { sequence: 12 })); assert.ok(signedBlockers(p4.blockers).some((b) => /revoked-signer/.test(b)));
  assert.equal(await errCode(admin.call("trust.add", { publicKey: signer.publicKey, name: "ci back" })), "CONFLICT", "a revoked key never becomes trusted again");
  // every trust change is audited
  const audit = await admin.call<any[]>("audit.read", {}); assert.ok(audit.some((e) => e.event === "trust.signer-added")); assert.ok(audit.some((e) => e.event === "trust.signer-revoked"));
});

test("a signature that is presented but unacceptable is refused even where signing is optional (no silent downgrade to unsigned)", async () => {
  const s = setup(); const repo = gitRepo(); const admin = await s.open(s.prov.bootstrapToken!, "admin"); const stranger = generateSigner();
  const signed = signManifest(manifest({ app: "shop", source: { kind: "git", commit: repo.commit } }), stranger.privateKey, stranger.publicKey);
  const p = await admin.call<any>("release.propose", { declaration: decl(repo.url), signed });
  assert.ok(signedBlockers(p.blockers).some((b) => /not acceptable/.test(b)), p.blockers.join(" | "));
});
