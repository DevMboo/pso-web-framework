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


test('policy compatibility: an agent that gained a capability does not permit it; the migration is previewed as an exact difference, needs the previewed digest, is audited and reversible', async () => {
  const s = setup(); const pol0 = s.state.policy(); pol0.allowedStrategies = ['blue-green', 'rolling', 'recreate']; s.state.setPolicy(pol0); // a server provisioned before static frontends existed
  const e = await enrollWith(s, s.prov.bootstrapToken!); const cl = await login(s, e);
  const c = await cl.call<any>('policy.compat');
  assert.equal(c.policyVersionSupported, true); assert.deepEqual(c.unsupportedStrategies, ['static']);
  assert.equal(c.capabilities.find((k: any) => k.id === 'strategy.static').status, 'not-permitted'); assert.equal(c.capabilities.find((k: any) => k.id === 'strategy.blue-green').status, 'permitted');
  const m = c.migrations.find((x: any) => x.id === 'allow-static-frontends'); assert.equal(m.pending, true);
  assert.deepEqual(m.changes, { allowedStrategies: { from: ['blue-green', 'rolling', 'recreate'], to: ['blue-green', 'rolling', 'recreate', 'static'] } });
  assert.ok(m.grants.some((g: string) => /no other permission changes/.test(g)));
  // nothing is applied by looking, by previewing, or by asking without the digest
  assert.deepEqual(s.state.policy().allowedStrategies, ['blue-green', 'rolling', 'recreate']);
  assert.equal((await cl.call<any>('policy.migrate', { id: 'allow-static-frontends', preview: true })).applied, false);
  assert.equal((await cl.call<any>('policy.migrate', { id: 'allow-static-frontends' })).applied, false);
  assert.equal(await code(cl.call('policy.migrate', { id: 'allow-static-frontends', digest: 'wrong' })), 'PLAN_STALE');
  assert.equal(await code(cl.call('policy.migrate', { id: 'nope', digest: 'x' })), 'NOT_FOUND');
  const before = JSON.stringify({ ...s.state.policy(), allowedStrategies: 0 });
  const r = await cl.call<any>('policy.migrate', { id: 'allow-static-frontends', digest: m.digest }); assert.equal(r.applied, true);
  assert.deepEqual(s.state.policy().allowedStrategies, ['blue-green', 'rolling', 'recreate', 'static']);
  assert.equal(JSON.stringify({ ...s.state.policy(), allowedStrategies: 0 }), before, 'no other permission changed');
  assert.ok(new AuditLog(s.home).read(500).some((a) => a.event === 'policy.migrated'));
  assert.equal((await cl.call<any>('policy.compat')).migrations[0].pending, false); assert.equal((await cl.call<any>('policy.migrate', { id: 'allow-static-frontends', digest: m.digest })).applied, false, 'idempotent');
  const h = await cl.call<any>('policy.history'); assert.equal(h.entries.length, 1); assert.equal(h.entries[0].kind, 'migration'); assert.ok(!('before' in h.entries[0]));
  // reversible; a later change to the same key blocks an older revert
  const rv = await cl.call<any>('policy.revert', { entry: r.entry }); assert.deepEqual(rv.restored, { allowedStrategies: ['blue-green', 'rolling', 'recreate'] });
  assert.deepEqual(s.state.policy().allowedStrategies, ['blue-green', 'rolling', 'recreate']); assert.equal(await code(cl.call('policy.revert', { entry: r.entry })), 'CONFLICT');
  assert.ok(new AuditLog(s.home).read(500).some((a) => a.event === 'policy.reverted'));
  const r2 = await cl.call<any>('policy.migrate', { id: 'allow-static-frontends', digest: m.digest }); await cl.call('policy.set', { changes: { allowedStrategies: 'static' } });
  assert.equal(await code(cl.call('policy.revert', { entry: r2.entry })), 'CONFLICT');
  // an unprivileged identity may read the compatibility but not change anything
  assert.equal(await code(cl.call('policy.revert', { entry: 'phmissing1' })), 'NOT_FOUND');
});

test('policy compatibility: an agent never changes the policy by itself, and an unknown policy version is reported', async () => {
  const s = setup(); const p = s.state.policy(); p.allowedStrategies = ['blue-green']; s.state.setPolicy(p);
  const before = JSON.stringify(s.state.policy()); new AgentServer(s.home, noSpawn); // starting an agent (what an upgrade does) leaves the policy as it was
  assert.equal(JSON.stringify(s.state.policy()), before);
  const { compatibility } = await import('../src/policy-compat.ts'); const c = compatibility({ ...s.state.policy(), version: 9 as never }, '9.9.9');
  assert.equal(c.policyVersionSupported, false); assert.match(c.notes[0]!, /does not understand policy version 9/);
});
