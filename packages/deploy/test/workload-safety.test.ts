import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentClient, type Transport } from "../src/client.ts";
import { MemoryCredentialProvider } from "../src/credentials.ts";
import { generateIdentity } from "../src/crypto.ts";
import { LocalStore, type ConnectionRecord } from "../src/local-state.ts";
import type { Request } from "../src/protocol.ts";
import { Auth } from "../src/agent/auth.ts";
import { AgentServer } from "../src/agent/server.ts";
import { AgentState } from "../src/agent/state.ts";
import { validateDeployment, type DeploymentDecl, type ServiceDecl } from "../src/declare.ts";

/** Distributed workloads (section: overlap of old and new releases): PSO refuses what the project itself says is unsafe there, and states what rollback can and cannot undo. */
class InProcess implements Transport { private readonly server: AgentServer; constructor(server: AgentServer) { this.server = server; } send(req: Request) { return this.server.handle(req); } close(): void { /* nothing */ } }
async function open() {
  const home = mkdtempSync(join(tmpdir(), "pso-wl-agent-")); const state = new AgentState(home);
  const prov = Auth.provision(state, "development", { emitToken: true, environment: "testing" });
  const store = new LocalStore(mkdtempSync(join(tmpdir(), "pso-wl-local-"))); const creds = new MemoryCredentialProvider();
  const conn: ConnectionRecord = { name: "t", host: "h", port: 22, user: "u", auth: { kind: "agent" }, timeoutSeconds: 5, agentDir: ".x", createdAt: "", credentialVersion: 1, agentFingerprint: prov.fingerprint };
  const t = () => new InProcess(new AgentServer(home, () => ({ pid: undefined }), "src")); const keys = generateIdentity();
  const c0 = await AgentClient.connect(conn, { store, creds }, { noSession: true, transport: t }); const e = await c0.enroll(prov.bootstrapToken!, keys.publicKey, keys.privateKey, "admin"); c0.close();
  const ref = `k-${createHash("sha256").update(e.clientId).digest("hex").slice(0, 16)}`; creds.set(ref, keys.privateKey);
  return AgentClient.connect({ ...conn, clientKeyRef: ref, clientId: e.clientId }, { store, creds }, { transport: t });
}
function repo(): string { const dir = mkdtempSync(join(tmpdir(), "pso-wl-repo-")); const g = (...a: string[]) => { const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); }; g("init", "-q", "-b", "main"); g("config", "user.email", "t@e.test"); g("config", "user.name", "t"); writeFileSync(join(dir, "a.txt"), "x"); g("add", "-A"); g("commit", "-q", "-m", "r"); return pathToFileURL(dir).href; }
const decl = (url: string, over: { strategy?: DeploymentDecl["strategy"]; workload?: ServiceDecl["workload"]; migrations?: DeploymentDecl["migrations"] }): DeploymentDecl => ({
  name: "wl", environment: "testing", connection: { provider: "ssh", credentials: "c" }, source: { provider: "git", url, branch: "main" },
  service: { name: "api", runtime: "node", start: ["node", "a.js"], port: 21888, shutdownGraceSeconds: 5, ...(over.strategy?.type === "rolling" ? { instances: 2 } : {}), ...(over.workload ? { workload: over.workload } : {}) },
  strategy: over.strategy ?? { type: "blue-green", proxy: "nginx" }, ...(over.migrations ? { migrations: over.migrations } : {}),
});
const RECREATE: DeploymentDecl["strategy"] = { type: "recreate", proxy: "none", downtimeAcknowledged: true };
const mine = (b: string[]) => b.filter((x) => /scheduled jobs|ordered consumption|applies its own migrations|destructive migration at start/.test(x));

test("the workload declaration is validated", () => {
  const bad = validateDeployment({ ...decl("file:///x", {}), service: { name: "api", runtime: "node", start: ["node", "a.js"], workload: { scheduledJobs: "sometimes", consumers: ["pigeon"], channels: "yes", surprise: 1 } } });
  assert.ok(bad.some((d) => /scheduledJobs/.test(d.path))); assert.ok(bad.some((d) => /consumers/.test(d.path))); assert.ok(bad.some((d) => /channels/.test(d.path))); assert.ok(bad.some((d) => /surprise/.test(d.path)));
});

test("overlap strategies are refused for singleton jobs, ordered consumption and self-migration without expand-contract; recreate (no overlap) is not", async () => {
  const c = await open(); const url = repo(); const plan = (d: DeploymentDecl) => c.call<any>("release.propose", { declaration: d });
  assert.equal(mine((await plan(decl(url, { workload: { scheduledJobs: "singleton" } }))).blockers).length, 1, "singleton jobs + blue-green");
  assert.equal(mine((await plan(decl(url, { workload: { scheduledJobs: "singleton" }, strategy: { type: "rolling", proxy: "nginx" } }))).blockers).length >= 1, true, "…and rolling");
  assert.deepEqual(mine((await plan(decl(url, { workload: { scheduledJobs: "singleton" }, strategy: RECREATE }))).blockers), [], "recreate never overlaps");
  assert.deepEqual(mine((await plan(decl(url, { workload: { scheduledJobs: "leader-elected" } }))).blockers), [], "leader-elected jobs are fine");
  assert.equal(mine((await plan(decl(url, { workload: { orderedConsumption: true, consumers: ["kafka"] } }))).blockers).length, 1);
  assert.equal(mine((await plan(decl(url, { workload: { selfMigrates: true } }))).blockers).length, 1, "self-migration with no declared expand-contract");
  assert.deepEqual(mine((await plan(decl(url, { workload: { selfMigrates: true }, migrations: { mode: "expand-contract", command: ["true"] } }))).blockers), [], "…is allowed when the migration is declared additive");
  assert.equal(mine((await plan(decl(url, { workload: { selfMigrates: true }, migrations: { mode: "expand-contract", command: ["true"], destructive: true, approvedDestructive: true } }))).blockers).some((b) => /destructive migration at start/.test(b)), true, "a destructive migration cannot run under the still-serving release, even when approved");
});

test("rollback data safety is stated per plan; messaging semantics are never promised as exactly-once", async () => {
  const c = await open(); const url = repo(); const plan = (d: DeploymentDecl) => c.call<any>("release.propose", { declaration: d });
  assert.equal((await plan(decl(url, {}))).rollback.dataSafety, "code-only");
  const additive = await plan(decl(url, { migrations: { mode: "expand-contract", command: ["true"] } })); assert.equal(additive.rollback.dataSafety, "schema-ahead"); assert.ok(additive.migrations.notes.some((n: string) => /newer, additive schema/.test(n)));
  const destructive = await plan(decl(url, { migrations: { mode: "expand-contract", command: ["true"], destructive: true } })); assert.equal(destructive.rollback.dataSafety, "forward-only"); assert.ok(destructive.migrations.notes.some((n: string) => /forward-only/.test(n)));
  const p = await plan(decl(url, { workload: { consumers: ["dispatch", "rabbitmq"], outbox: true, channels: true } }));
  const text = p.distributed.notes.join(" | "); assert.match(text, /at-least-once/); assert.match(text, /does not provide exactly-once/); assert.match(text, /idempotent/); assert.match(text, /outbox/); assert.match(text, /reconnect/);
  assert.doesNotMatch(text, /exactly-once delivery is guaranteed|zero downtime is guaranteed/i);
  assert.equal(p.distributed.overlap, true); assert.equal((await plan(decl(url, { strategy: RECREATE }))).distributed.overlap, false);
});
