import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud, LocalStore, MemoryCredentialProvider } from "../src/index.ts";
import { LinuxTarget, dockerAvailable } from "./target.ts";

/**
 * SSH-agent authentication over real SSH: the private key is held ONLY by a running ssh-agent; PSO never reads it, never stores a path to it
 * and never copies it. If the agent goes away, the connection fails (there is no silent fallback to another credential).
 * The OpenSSH `ssh-agent` of this machine is used; a Windows host whose `ssh` is the Windows build needs the Windows agent service instead,
 * which this test does not drive (it is skipped there when the agent socket cannot be used).
 */
const sshVersion = (() => { const v = spawnSync("ssh", ["-V"], { encoding: "utf8", windowsHide: true }); return `${v.stdout ?? ""}${v.stderr ?? ""}`; })();
const skip = (!dockerAvailable() && "Docker image pso-e2e-target:1 is not available")
  || (/for_Windows/i.test(sshVersion) && `the ssh on PATH is ${sshVersion.trim().split(",")[0]}: it uses the Windows ssh-agent service, which this test does not drive (run it from a shell whose ssh is OpenSSH, e.g. Git Bash)`);
const T = new LinuxTarget();
const cloud = new Cloud({ store: new LocalStore(mkdtempSync(join(tmpdir(), "pso-sa-home-"))), creds: new MemoryCredentialProvider() });
let agentPid = ""; const saved = { sock: process.env["SSH_AUTH_SOCK"], pid: process.env["SSH_AGENT_PID"] };

before(() => {
  if (skip) return;
  T.start();
  const a = spawnSync("ssh-agent", ["-s"], { encoding: "utf8", windowsHide: true });
  const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(a.stdout)?.[1]; agentPid = /SSH_AGENT_PID=(\d+);/.exec(a.stdout)?.[1] ?? "";
  assert.ok(sock && agentPid, `ssh-agent did not start: ${a.stdout}${a.stderr}`);
  process.env["SSH_AUTH_SOCK"] = sock; process.env["SSH_AGENT_PID"] = agentPid;
  const add = spawnSync("ssh-add", [T.keyFile], { encoding: "utf8", windowsHide: true, env: process.env }); assert.equal(add.status, 0, add.stderr);
});
after(() => {
  if (skip) return;
  if (agentPid) spawnSync("ssh-agent", ["-k"], { windowsHide: true, env: process.env });
  if (saved.sock === undefined) delete process.env["SSH_AUTH_SOCK"]; else process.env["SSH_AUTH_SOCK"] = saved.sock;
  if (saved.pid === undefined) delete process.env["SSH_AGENT_PID"]; else process.env["SSH_AGENT_PID"] = saved.pid;
  T.stop();
});

test("auth: agent: connects and installs through the key held by ssh-agent; no key path or key material is stored by PSO", { skip }, async () => {
  await T.waitSsh();
  const ed = cloud.hostKeys("127.0.0.1", T.sshPort).find((k) => k.type === "ed25519")!;
  cloud.add({ name: "viaagent", host: "127.0.0.1", port: T.sshPort, user: "pso", auth: "agent" }, ed.fingerprint);
  const rec = cloud.get("viaagent"); assert.equal(rec.auth.kind, "agent"); assert.equal(rec.auth.keyPath, undefined); assert.equal(rec.auth.passphraseRef, undefined);
  const installed = await cloud.installAgent("viaagent", { mode: "development", environment: "testing", yes: true }); assert.match(installed.fingerprint, /^SHA256:/);
  const t = await cloud.test("viaagent"); assert.equal(t.ok, true, JSON.stringify(t.steps));
  const files = [join(cloud.store.home, "connections.json")].map((f) => readFileSync(f, "utf8")).join("\n");
  assert.doesNotMatch(files, /PRIVATE KEY/); assert.doesNotMatch(files, new RegExp(T.keyFile.replace(/[\\.]/g, "\\$&")), "the key file's path is not recorded");
});

test("when the ssh-agent no longer holds the key, the connection FAILS: there is no fallback to another credential", { skip }, async () => {
  spawnSync("ssh-add", ["-D"], { windowsHide: true, env: process.env });
  const t = await cloud.test("viaagent"); assert.equal(t.ok, false);
  assert.match(t.steps[0]!.detail, /failed|denied|permission/i);
});
