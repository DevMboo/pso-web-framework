import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient, CloudError, type Transport } from "../src/client.ts";
import { MemoryCredentialProvider } from "../src/credentials.ts";
import { generateIdentity } from "../src/crypto.ts";
import { LocalStore, type ConnectionRecord } from "../src/local-state.ts";
import type { Request } from "../src/protocol.ts";
import { OPERATIONS } from "../src/protocol.ts";
import { Auth } from "../src/agent/auth.ts";
import { AgentServer } from "../src/agent/server.ts";
import { AgentState } from "../src/agent/state.ts";

/** Production management security: disabled by default, per-environment identities, single-use enrollment, a closed operation table, and a recovery that is not a remote bypass. */
class InProcess implements Transport { private readonly server: AgentServer; constructor(server: AgentServer) { this.server = server; } send(req: Request) { return this.server.handle(req); } close(): void { /* nothing */ } }
const MAIN = join(import.meta.dirname, "..", "src", "agent", "main.ts");
const agentCli = (home: string, ...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, PSO_AGENT_HOME: home }, windowsHide: true });

function environment(name: string) {
  const home = mkdtempSync(join(tmpdir(), `pso-prodsec-${name}-`)); const state = new AgentState(home);
  const prov = Auth.provision(state, "protected", { emitToken: true, environment: name });
  const store = new LocalStore(mkdtempSync(join(tmpdir(), "pso-prodsec-local-"))); const creds = new MemoryCredentialProvider();
  const conn: ConnectionRecord = { name: name, host: "h", port: 22, user: "u", auth: { kind: "agent" }, timeoutSeconds: 5, agentDir: ".x", createdAt: "", credentialVersion: 1, agentFingerprint: prov.fingerprint };
  const t = () => new InProcess(new AgentServer(home, () => ({ pid: undefined }), "src"));
  const enroll = async (token: string, who: string, c: ConnectionRecord = conn, tr = t) => {
    const keys = generateIdentity(); const c0 = await AgentClient.connect(c, { store, creds }, { noSession: true, transport: tr }); const e = await c0.enroll(token, keys.publicKey, keys.privateKey, who); c0.close();
    const ref = `k-${createHash("sha256").update(e.clientId + name).digest("hex").slice(0, 16)}`; creds.set(ref, keys.privateKey);
    return { ...e, ref, connect: (cc: ConnectionRecord = c, trr = tr) => AgentClient.connect({ ...cc, clientKeyRef: ref, clientId: e.clientId }, { store, creds }, { transport: trr }) };
  };
  return { home, state, prov, conn, t, enroll, store, creds };
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: CloudError) => e.code);

test("remote management is DISABLED unless the host administrator chooses a mode; a disabled agent refuses everything", async () => {
  const home = mkdtempSync(join(tmpdir(), "pso-prodsec-off-"));
  assert.notEqual(agentCli(home, "provision").status, 0, "provisioning without an explicit --mode is refused"); assert.match(agentCli(home, "provision").stderr, /--mode/);
  const state = new AgentState(home); const prov = Auth.provision(state, "protected", { emitToken: true }); // then the host administrator turns it off
  assert.equal(agentCli(home, "set-mode", "disabled").status, 0);
  const store = new LocalStore(mkdtempSync(join(tmpdir(), "pso-l-"))); const creds = new MemoryCredentialProvider();
  const conn: ConnectionRecord = { name: "x", host: "h", port: 22, user: "u", auth: { kind: "agent" }, timeoutSeconds: 5, agentDir: ".x", createdAt: "", credentialVersion: 1, agentFingerprint: prov.fingerprint };
  const c0 = await AgentClient.connect(conn, { store, creds }, { noSession: true, transport: () => new InProcess(new AgentServer(home, () => ({ pid: undefined }), "s")) });
  const k = generateIdentity(); assert.notEqual(await code(c0.enroll(prov.bootstrapToken!, k.publicKey, k.privateKey, "late")), "ok", "no enrollment while disabled"); c0.close();
});

test("the bootstrap superadministrator is generated per environment, single use and expiring; no permanent secret exists", async () => {
  const a = environment("staging"); const b = environment("production");
  assert.notEqual(a.prov.fingerprint, b.prov.fingerprint, "every environment has its own server identity"); assert.notEqual(a.state.env().id, b.state.env().id);
  assert.notEqual(a.prov.bootstrapToken, b.prov.bootstrapToken);
  const e = await a.enroll(a.prov.bootstrapToken!, "alice"); assert.equal(e.role, "superadmin");
  assert.equal(await code(a.enroll(a.prov.bootstrapToken!, "mallory")), "ENROLLMENT_REFUSED", "single use");
  // identity of environment A is worthless in environment B: separate server key, client list and sessions
  assert.notEqual(await code(e.connect(b.conn, b.t)), "ok", "a client enrolled in staging cannot open a session in production");
  assert.doesNotMatch(readFileSync(join(a.home, "state", "enroll.json"), "utf8"), new RegExp(a.prov.bootstrapToken!.split(".")[1]!), "only a hash of the token secret is stored");
});

test("recover-admin: host-administrator only, single-use short token, optional revocation of everything; it is not an operation of the management plane", async () => {
  const a = environment("recover"); const old = await a.enroll(a.prov.bootstrapToken!, "lost-admin"); const session = await old.connect(); assert.ok(await session.call("whoami"));
  assert.equal("recover-admin" in OPERATIONS, false); assert.equal(await code(session.call("recover-admin" as never)), "UNKNOWN_OPERATION", "no remote recovery path");
  const r = agentCli(a.home, "recover-admin", "--revoke-all", "--minutes", "5"); assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout);
  assert.equal(out.role, "superadmin"); assert.equal(out.singleUse, true); assert.equal(out.clientsRevoked, 1); assert.ok(Date.parse(out.expiresAt) - Date.now() <= 5 * 60_000 + 2000);
  assert.notEqual(await code(session.call("whoami")), "ok", "the old session ended"); assert.notEqual(await code(old.connect()), "ok", "the old identity is revoked");
  const fresh = await a.enroll(out.token, "new-admin"); assert.equal(fresh.role, "superadmin");
  assert.equal(await code(a.enroll(out.token, "replay")), "ENROLLMENT_REFUSED", "the recovery token is single use");
  const audit = await (await fresh.connect()).call<any[]>("audit.read", {}); assert.ok(audit.some((x) => x.event === "admin.recovery"), "recovery is audited");
  assert.equal(agentCli(mkdtempSync(join(tmpdir(), "pso-unprov-")), "recover-admin").status, 1, "nothing to recover on a server that was never provisioned");
  assert.doesNotMatch(r.stdout, /PRIVATE KEY/);
});

test("the management plane is a closed table: no shell, no arbitrary path or argument injection, roles enforced per operation", async () => {
  const a = environment("closed"); const admin = await (await a.enroll(a.prov.bootstrapToken!, "admin")).connect();
  const viewer = await (await a.enroll(Auth.createToken(a.state, "viewer", 5, "t").token, "viewer")).connect();
  for (const op of ["exec", "shell", "sh", "run", "file.read", "file.write", "system.reboot", "../etc/passwd", "service.restart; rm -rf /"]) assert.equal(await code(admin.call(op as never)), "UNKNOWN_OPERATION", op);
  for (const bad of ["a;rm -rf /", "../../etc", "a b", "A", "a\n", "$(id)", "a".repeat(80), ""]) assert.notEqual(await code(admin.call("release.status", { app: bad })), "ok", `app name ${JSON.stringify(bad)}`);
  assert.equal(await code(viewer.call("secret.set", { name: "x", value: "y" })), "FORBIDDEN"); assert.equal(await code(viewer.call("release.start", { app: "x", planHash: "0".repeat(64) })), "FORBIDDEN");
  assert.equal(await code(viewer.call("trust.add", { publicKey: "x", name: "x" })), "FORBIDDEN"); assert.equal(await code(viewer.call("policy.set", { changes: {} })), "FORBIDDEN");
  const ops = Object.keys(OPERATIONS); assert.ok(ops.every((o) => /^[a-z]+(\.[a-z-]+)?$/.test(o)), "every operation is a plain name"); assert.equal(ops.some((o) => /exec|shell|eval|command/.test(o)), false);
});

test("the agent opens NO network listener: it speaks through stdin/stdout of an SSH-spawned process", () => {
  for (const f of ["server.ts", "main.ts", "auth.ts", "engine.ts", "state.ts", "git.ts", "nginx.ts", "inspect.ts", "plan.ts", "systemd.ts", "javascan.ts"]) {
    const t = readFileSync(join(import.meta.dirname, "..", "src", "agent", f), "utf8");
    assert.doesNotMatch(t, /\.listen\(|createServer\(/, `${f} must not listen on a socket`);
  }
  // the only listener-like code is the port PROBE of the runtime (binds loopback for an instant to test whether a port is free)
  const rt = readFileSync(join(import.meta.dirname, "..", "src", "agent", "runtime.ts"), "utf8"); assert.match(rt, /listen\(port, "127\.0\.0\.1"/);
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", "src", "agent", "nginx.ts"), "utf8"), /proxy_pass[^;]*(management|agent)/i, "nginx never proxies the management plane");
});
