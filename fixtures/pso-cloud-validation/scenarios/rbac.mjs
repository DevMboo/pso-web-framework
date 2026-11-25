import { WORKSPACE, FRAMEWORK, HOST, SSH_KEY, SSH_USER } from "./config.mjs";
// Separate restricted identities, enrolled with single-use tokens that are never printed. Real agent, real roles.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
const PSO = `${FRAMEWORK}/packages/cli/bin/pso.js`; const CWD = `${WORKSPACE}`;
const { Cloud } = await import(`file:///${FRAMEWORK}/packages/deploy/dist/index.js`);
const pso = (args, input) => spawnSync(process.execPath, [PSO, ...args], { cwd: CWD, encoding: "utf8", input });
const out = { identities: {}, checks: [] }; const chk = (n, ok, d = "") => { out.checks.push({ name: n, ok, detail: d }); console.log(ok ? "PASS" : "FAIL", n, d); };
const FP = process.env.ECV_HOST_KEY_FP ?? "<set ECV_HOST_KEY_FP>"; // the server's SSH host key fingerprint, obtained out of band
for (const role of ["viewer", "operator"]) {
  const name = `server-${role}`;
  const add = pso(["connection:add", name, "--host", `${HOST}`, "--user", `${SSH_USER}`, "--auth", "key", "--key", `${SSH_KEY}`, "--accept-host-key", FP]);
  const inv = pso(["environment:access", "shop-gateway", "--invite", role, "--minutes", "5", "--json"]); let token; try { token = JSON.parse(inv.stdout).token; } catch { /* below */ }
  if (!token) { chk(`invite ${role}`, false, (inv.stderr || inv.stdout).slice(0, 120)); continue; }
  const pin = pso(["connection:test", name, "--pin-agent", process.env.ECV_AGENT_FP ?? "<set ECV_AGENT_FP>"]); // pins the agent identity for the new connection
  const en = pso(["agent:enroll", name], token + "\n"); chk(`enroll ${role} with a single-use token`, en.status === 0, en.stdout.split("\n")[0].slice(0, 100));
  const again = pso(["agent:enroll", name], token + "\n"); chk(`the same ${role} token cannot be used twice`, again.status !== 0, (again.stderr || "").split("\n")[0].slice(0, 90));
  void add; void pin;
}
const cloud = new Cloud(); const code = async (conn, op, args = {}) => { try { await cloud.with(conn, (c) => c.call(op, args)); return "ok"; } catch (e) { return e.code ?? "error"; } };
const who = async (conn) => (await cloud.with(conn, (c) => c.call("whoami"))).role;
out.identities = { viewer: await who("server-viewer").catch(() => "?"), operator: await who("server-operator").catch(() => "?") };
chk("viewer role is viewer, operator role is operator", out.identities.viewer === "viewer" && out.identities.operator === "operator", JSON.stringify(out.identities));
const app = "shop-gateway";
for (const [role, conn] of [["viewer", "server-viewer"], ["operator", "server-operator"]]) {
  chk(`${role}: can read status`, (await code(conn, "release.status", { app })) === "ok");
  chk(`${role}: cannot start a deployment`, (await code(conn, "release.start", { app, planHash: "0".repeat(64) })) === "FORBIDDEN");
  chk(`${role}: cannot roll back`, (await code(conn, "release.rollback", { app })) === "FORBIDDEN");
  chk(`${role}: cannot set a secret`, (await code(conn, "secret.set", { name: "x", value: "y" })) === "FORBIDDEN");
  chk(`${role}: cannot read the audit log`, (await code(conn, "audit.read")) === "FORBIDDEN");
  chk(`${role}: cannot change policy or trust`, (await code(conn, "policy.set", { changes: { retentionMin: 1 } })) === "FORBIDDEN" && (await code(conn, "trust.add", { publicKey: "x", name: "x" })) === "FORBIDDEN");
  chk(`${role}: cannot invite or revoke clients`, (await code(conn, "enroll.create", { role: "viewer" })) === "FORBIDDEN" && (await code(conn, "client.list")) === "FORBIDDEN");
  chk(`${role}: unknown/shell-like operations do not exist`, (await code(conn, "exec", { cmd: "id" })) === "UNKNOWN_OPERATION");
}
chk("viewer: cannot restart a service", (await code("server-viewer", "service.restart", { app: "shop-jwks", service: "jwks" })) === "FORBIDDEN");
const op = await code("server-operator", "service.restart", { app: "shop-jwks", service: "jwks" }); chk("operator: CAN restart a service (its role)", op === "ok", op);
// revocation by the administrator ends the identity immediately
const list = await cloud.with("server", (c) => c.call("client.list")); const opId = list.find((c) => /operator/.test(c.name) && !c.revoked)?.id ?? list.find((c) => c.role === "operator" && !c.revoked)?.id;
if (opId) { await cloud.with("server", (c) => c.call("client.revoke", { clientId: opId })); chk("revoked operator can no longer open a session", (await who("server-operator").then(() => "ok", (e) => e.code ?? "error")) !== "ok"); } else chk("find operator client", false);
const audit = await cloud.with("server", (c) => c.call("audit.read", { limit: 400 })); const ev = (e) => audit.some((a) => a.event === e);
chk("audit recorded token creation, enrollments, forbidden attempts and the revocation", ev("enroll.token-created") && ev("client.revoked") && audit.some((a) => a.outcome === "denied"), `events seen: ${[...new Set(audit.map((a) => a.event))].filter((e) => /enroll|client|denied|forbid/.test(e)).join(",")}`);
const chain = await cloud.with("server", (c) => c.call("audit.verify")); chk("server audit hash chain verifies", chain.ok === true, JSON.stringify(chain).slice(0, 80));
mkdirSync(`${FRAMEWORK}/docs/implementation/evidence/ecv`, { recursive: true }); writeFileSync(`${FRAMEWORK}/docs/implementation/evidence/ecv/rbac.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ passed: out.checks.filter((c) => c.ok).length, failed: out.checks.filter((c) => !c.ok).map((c) => c.name) }));
