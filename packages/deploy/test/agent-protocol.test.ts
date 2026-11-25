import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient, CloudError, type Transport } from "../src/client.ts";
import { MemoryCredentialProvider } from "../src/credentials.ts";
import { generateIdentity, fingerprint } from "../src/crypto.ts";
import { LocalStore, type ConnectionRecord } from "../src/local-state.ts";
import { signRequest, type Request } from "../src/protocol.ts";
import { Auth } from "../src/agent/auth.ts";
import { AgentServer } from "../src/agent/server.ts";
import { AgentState, AuditLog } from "../src/agent/state.ts";

/** The management protocol, tested in process (no SSH): identity, enrollment, sessions, replay, roles, rate limiting, audit. */
class InProcess implements Transport {
  private readonly server: AgentServer;
  constructor(server: AgentServer) { this.server = server; }
  send(req: Request): Promise<import("../src/protocol.ts").Response> { return this.server.handle(req); }
  close(): void { /* nothing to close */ }
}
const noSpawn = () => ({ pid: undefined });

function setup(mode: "development" | "protected" = "development") {
  const home = mkdtempSync(join(tmpdir(), "pso-agent-test-"));
  const state = new AgentState(home);
  const prov = Auth.provision(state, mode, { emitToken: true, environment: "testing" });
  const store = new LocalStore(mkdtempSync(join(tmpdir(), "pso-local-test-")));
  const creds = new MemoryCredentialProvider();
  const factory = (src = "test-src") => () => new InProcess(new AgentServer(home, noSpawn, src));
  const conn: ConnectionRecord = { name: "t", host: "h", port: 22, user: "u", auth: { kind: "agent" }, timeoutSeconds: 5, agentDir: ".x", createdAt: "", credentialVersion: 1, agentFingerprint: prov.fingerprint };
  return { home, state, prov, store, creds, factory, conn };
}
async function enrollWith(s: ReturnType<typeof setup>, token: string, name = "alice") {
  const keys = generateIdentity(); const cl = await AgentClient.connect(s.conn, { store: s.store, creds: s.creds }, { noSession: true, transport: s.factory() });
  try { const e = await cl.enroll(token, keys.publicKey, keys.privateKey, name); return { ...e, keys }; } finally { cl.close(); }
}
async function login(s: ReturnType<typeof setup>, e: { clientId: string; keys: { privateKey: string } }, src?: string) {
  const ref = `k-${createHash("sha256").update(e.clientId).digest("hex").slice(0, 16)}`; s.creds.set(ref, e.keys.privateKey);
  return AgentClient.connect({ ...s.conn, clientKeyRef: ref, clientId: e.clientId }, { store: s.store, creds: s.creds }, { transport: s.factory(src) });
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: CloudError) => e.code);

test("the agent proves its identity by signing OUR challenge; a pinned fingerprint is enforced", async () => {
  const s = setup();
  const ok = await AgentClient.connect(s.conn, { store: s.store, creds: s.creds }, { noSession: true, transport: s.factory() }); assert.equal(ok.agent.fingerprint, s.prov.fingerprint); ok.close();
  assert.equal(await code(AgentClient.connect({ ...s.conn, agentFingerprint: "SHA256:" + "B".repeat(43) }, { store: s.store, creds: s.creds }, { noSession: true, transport: s.factory() })), "IDENTITY_CHANGED");
  const { agentFingerprint: _unused, ...unpinned } = s.conn; void _unused;
  assert.equal(await code(AgentClient.connect(unpinned as ConnectionRecord, { store: s.store, creds: s.creds }, { noSession: true, transport: s.factory() })), "NOT_PINNED");
  const pinned = await AgentClient.connect(unpinned as ConnectionRecord, { store: s.store, creds: s.creds }, { noSession: true, pinAgent: s.prov.fingerprint, transport: s.factory() }); pinned.close();
});

test("the server's identity key never leaves it: nothing the agent returns contains private key material", async () => {
  const s = setup(); const e = await enrollWith(s, s.prov.bootstrapToken!); const cl = await login(s, e);
  const all = JSON.stringify([await cl.call("whoami"), await cl.call("inspect"), await cl.call("policy.get"), await cl.call("client.list"), await cl.call("audit.read")]);
  assert.doesNotMatch(all, /PRIVATE KEY/); assert.ok(!all.includes(readFileSync(join(s.home, "identity", "server.key"), "utf8").split("\n")[1]!));
});

test("bootstrap enrollment: single use, expiring, possession of the key is proven, and no permanent secret exists", async () => {
  const s = setup(); const token = s.prov.bootstrapToken!;
  assert.match(token, /^pso-enroll-/);
  const e = await enrollWith(s, token); assert.equal(e.role, "superadmin"); assert.equal(e.clientId, fingerprint(e.keys.publicKey));
  assert.equal(await code(enrollWith(s, token, "mallory")), "ENROLLMENT_REFUSED", "a used token is refused");
  // the agent stores only a HASH of the secret part
  const stored = readFileSync(join(s.home, "state", "enroll.json"), "utf8"); assert.ok(!stored.includes(token.split(".")[1]!), "the token secret is not stored");
  // an expired token is refused
  const t2 = Auth.createToken(s.state, "viewer", 5, "test"); const toks = s.state.tokens(); toks.find((t) => t.id === t2.id)!.expiresAt = new Date(Date.now() - 1000).toISOString(); s.state.saveTokens(toks);
  assert.equal(await code(enrollWith(s, t2.token)), "ENROLLMENT_REFUSED");
  // the bootstrap token is only created when asked and only while no administrator exists
  const again = Auth.provision(s.state, "development", { emitToken: true }); assert.equal(again.bootstrapToken, undefined, "an administrator already exists");
});

test("a wrong enrollment secret is refused and repeated failures lock the source out (rate limiting)", async () => {
  const s = setup(); const id = s.prov.bootstrapToken!.split(".")[0]!;
  const results: string[] = [];
  for (let i = 0; i < 7; i++) results.push(await code(enrollWith(s, `${id}.${"x".repeat(32)}`)));
  assert.equal(results[0], "ENROLLMENT_REFUSED"); assert.equal(results[6], "RATE_LIMITED", results.join(","));
  // the lock-out also protects the real token for that source, which is the point
  assert.equal(await code(enrollWith(s, s.prov.bootstrapToken!)), "RATE_LIMITED");
  const audit = new AuditLog(s.home).read(); assert.ok(audit.filter((a) => a.event === "auth.failure").length >= 5);
});

test("requests are authenticated per request: replays, edited arguments and foreign sessions are refused", async () => {
  const s = setup(); const e = await enrollWith(s, s.prov.bootstrapToken!);
  const server = new AgentServer(s.home, noSpawn, "src-1");
  const hello = (await server.handle({ v: 1, id: 1, op: "hello", args: { versions: [1], challenge: "c".repeat(24) } })) as any;
  const { signText } = await import("../src/crypto.ts"); const { sessionPayload } = await import("../src/protocol.ts");
  const nonce = "n".repeat(20);
  const sess = (await server.handle({ v: 1, id: 2, op: "session.open", args: { clientId: e.clientId, clientNonce: nonce, signature: signText(e.keys.privateKey, sessionPayload(e.clientId, hello.result.serverNonce, nonce)) } })) as any;
  assert.equal(sess.ok, true);
  const sid = sess.result.sessionId; const args = { app: "x" };
  const req: Request = { v: 1, id: 3, op: "release.list", args, auth: signRequest(e.keys.privateKey, sid, 1, "release.list", args) };
  assert.equal(((await server.handle(req)) as any).ok, true); // the first use of sequence 1 is accepted
  const replay = (await server.handle({ ...req, id: 4 })) as any; assert.equal(replay.error.code, "REPLAY", "the same sequence number cannot be used twice");
  const edited = (await server.handle({ ...req, id: 5, args: { app: "other" }, auth: { ...req.auth!, seq: 2 } })) as any; assert.equal(edited.error.code, "UNAUTHENTICATED", "changing the arguments breaks the signature");
  const other = generateIdentity(); const forged = (await server.handle({ v: 1, id: 6, op: "release.list", args, auth: signRequest(other.privateKey, sid, 9, "release.list", args) })) as any; assert.equal(forged.error.code, "UNAUTHENTICATED");
  const noAuth = (await server.handle({ v: 1, id: 7, op: "release.list", args })) as any; assert.equal(noAuth.error.code, "UNAUTHENTICATED");
  const wrongNonce = (await new AgentServer(s.home, noSpawn, "src-2").handle({ v: 1, id: 8, op: "session.open", args: { clientId: e.clientId, clientNonce: nonce, signature: signText(e.keys.privateKey, sessionPayload(e.clientId, hello.result.serverNonce, nonce)) } })) as any;
  assert.equal(wrongNonce.error.code, "UNAUTHENTICATED", "a recorded session handshake is not valid on another connection");
});

test("no shell: unknown operations do not exist, and every known operation is in the role table", async () => {
  const s = setup(); const e = await enrollWith(s, s.prov.bootstrapToken!); const cl = await login(s, e);
  for (const op of ["exec", "shell", "run", "sh", "system", "eval", "file.read", "file.write"]) assert.equal(await code(cl.call(op, { cmd: "id" })), "UNKNOWN_OPERATION", op);
  const { OPERATIONS } = await import("../src/protocol.ts");
  assert.ok(!Object.keys(OPERATIONS).some((k) => /exec|shell|^run$|eval/.test(k)));
});

test("roles: a viewer can read but not change; tokens cannot grant more than their creator; the last superadmin is protected", async () => {
  const s = setup(); const root = await enrollWith(s, s.prov.bootstrapToken!); const admin = await login(s, root);
  const vt = await admin.call<{ token: string }>("enroll.create", { role: "viewer", minutes: 5 }); const v = await enrollWith(s, vt.token, "vera"); const viewer = await login(s, v);
  assert.equal((await viewer.call<any>("whoami")).role, "viewer"); await viewer.call("release.history", { app: "x" });
  for (const op of ["release.rollback", "service.restart", "secret.set", "audit.read", "client.list", "policy.set", "enroll.create", "provision.apply", "artifact.begin"]) assert.equal(await code(viewer.call(op, { app: "x" })), "FORBIDDEN", op);
  const dt = await admin.call<{ token: string }>("enroll.create", { role: "deployer", minutes: 5 }); const d = await enrollWith(s, dt.token, "dan"); const dep = await login(s, d);
  assert.equal(await code(dep.call("enroll.create", { role: "admin" })), "FORBIDDEN"); assert.equal(await code(dep.call("policy.set", { changes: {} })), "FORBIDDEN");
  assert.equal(await code(admin.call("client.revoke", { clientId: root.clientId })), "POLICY", "the last superadministrator cannot be revoked");
  // revocation ends sessions immediately
  await admin.call("client.revoke", { clientId: v.clientId }); assert.equal(await code(viewer.call("whoami")), "SESSION_EXPIRED", "its open session ended at once");
  assert.equal(await code(login(s, v)), "UNAUTHENTICATED", "a revoked client cannot sign in again");
});

test("modes: disabled refuses everything but the handshake; protected defaults demand approvals; only the host can re-enable", async () => {
  const s = setup("protected"); assert.equal(s.state.policy().approvalsRequired, 1); assert.equal(s.state.policy().mode, "protected");
  const e = await enrollWith(s, s.prov.bootstrapToken!); const cl = await login(s, e);
  const pol = s.state.policy(); pol.mode = "disabled"; s.state.setPolicy(pol);
  assert.equal(await code(cl.call("whoami")), "FORBIDDEN"); assert.equal(await code(login(s, e)), "FORBIDDEN");
  const hello = await AgentClient.connect(s.conn, { store: s.store, creds: s.creds }, { noSession: true, transport: s.factory() }); assert.equal(hello.agent.mode, "disabled"); hello.close();
  const fresh = new AgentState(mkdtempSync(join(tmpdir(), "pso-unprov-"))); const srv = new AgentServer(fresh.home, noSpawn);
  const h = (await srv.handle({ v: 1, id: 1, op: "hello", args: { versions: [1], challenge: "z".repeat(20) } })) as any; assert.equal(h.result.provisioned, false);
  const u = (await srv.handle({ v: 1, id: 2, op: "enroll", args: { token: "pso-enroll-aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbb" } })) as any; assert.equal(u.error.code, "NOT_PROVISIONED");
});

test("policy changes are superadmin-only, validated and audited; versions are negotiated", async () => {
  const s = setup(); const e = await enrollWith(s, s.prov.bootstrapToken!); const cl = await login(s, e);
  const r = await cl.call<any>("policy.set", { changes: { approvalsRequired: 2, selfApproval: false } }); assert.deepEqual(Object.keys(r.changed).sort(), ["approvalsRequired", "selfApproval"]);
  assert.equal(await code(cl.call("policy.set", { changes: { nginxManagedDir: "relative/dir" } })), "BAD_REQUEST"); assert.equal(await code(cl.call("policy.set", { changes: { evil: true } })), "BAD_REQUEST");
  assert.ok(new AuditLog(s.home).read(500).some((a) => a.event === "policy.changed"));
  const srv = new AgentServer(s.home, noSpawn); const bad = (await srv.handle({ v: 1, id: 1, op: "hello", args: { versions: [7], challenge: "c".repeat(20) } })) as any; assert.equal(bad.error.code, "UNSUPPORTED_VERSION"); assert.match(bad.error.message, /upgrade the older side/);
});

test("audit: hash-chained, sanitized, tamper-evident; secrets never reach it or any response", async () => {
  const s = setup(); const e = await enrollWith(s, s.prov.bootstrapToken!); const cl = await login(s, e);
  const value = "Sup3r-S3cret-Value-12345";
  await cl.call("secret.set", { name: "db-password", value }); const list = await cl.call<string[]>("secret.list"); assert.deepEqual(list, ["db-password"]);
  const audit = readFileSync(join(s.home, "audit", "audit.log"), "utf8"); assert.ok(!audit.includes(value)); assert.match(audit, /secret\.set/);
  assert.equal((await cl.call<any>("audit.verify")).ok, true);
  assert.equal(readFileSync(join(s.home, "secrets", "db-password"), "utf8"), value, "the value lives only in the secret store");
  const lines = audit.trimEnd().split("\n"); const tampered = JSON.parse(lines[1]!); tampered.outcome = "ok-edited"; lines[1] = JSON.stringify(tampered);
  writeFileSync(join(s.home, "audit", "audit.log"), lines.join("\n") + "\n");
  const v = await cl.call<any>("audit.verify"); assert.equal(v.ok, false); assert.equal(v.brokenAt, 2);
  assert.ok(existsSync(join(s.home, "identity", "server.key")));
});

test("artifact transfer is checksum-verified and bound to the uploader", async () => {
  const s = setup(); const e = await enrollWith(s, s.prov.bootstrapToken!); const cl = await login(s, e);
  const { sha256 } = await import("../src/crypto.ts"); const data = Buffer.from("hello artifact"); const sum = sha256(data);
  const { uploadId } = await cl.call<any>("artifact.begin", { size: data.length, sha256: sum });
  await cl.call("artifact.chunk", { uploadId, index: 0, data: data.toString("base64") });
  const c = await cl.call<any>("artifact.commit", { uploadId }); assert.equal(c.sha256, sum); assert.match(c.verified, /not who built/);
  const bad = await cl.call<any>("artifact.begin", { size: 3, sha256: sha256(Buffer.from("abc")) }); await cl.call("artifact.chunk", { uploadId: bad.uploadId, index: 0, data: Buffer.from("xyz").toString("base64") });
  assert.equal(await code(cl.call("artifact.commit", { uploadId: bad.uploadId })), "PRECONDITION", "a corrupted transfer is discarded");
  assert.equal(await code(cl.call("artifact.chunk", { uploadId, index: 5, data: "AA==" })), "BAD_REQUEST");
});
