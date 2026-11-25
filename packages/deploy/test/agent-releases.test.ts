import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentReleaseId, checksum, runReleaseOp, uploadBuild, type AgentReleaseChange, type AgentReleases, type RemoteShell } from "../src/agent-releases.ts";

/**
 * Versioned agent releases in an isolated Linux environment (a disposable container: a real file system, real symbolic links, the node that
 * the agent requires): legacy adoption, side-by-side releases told apart by build, atomic activation, explicit rollback with re-verification,
 * retention, and the agent's own state left alone. Skipped when Docker or the image is missing.
 */
const IMAGE = "pso-e2e-target:1";
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 120_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const available = process.env["PSO_E2E_DOCKER"] !== "0" && docker("image", "inspect", IMAGE).status === 0;
const name = `pso-agent-rel-${process.pid}`;
after(() => { docker("rm", "-f", name); });
const DIR = '"$HOME/.pso-agent"';
const sh = (cmd: string): string => docker("exec", name, "sh", "-c", cmd).stdout.trim();
const run: RemoteShell = (cmd, input) => { const r = spawnSync("docker", ["exec", "-i", name, "sh", "-c", cmd], { input, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, timeout: 60_000 }); return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; };
/** a stand-in agent: it answers `version` like the real one; `salt` makes two builds of the same version differ */
const stub = (version: string, salt: string, broken = false): Buffer => Buffer.from(broken ? `process.exit(9) // ${salt}\n` : `if (process.argv[2] === "version") console.log(JSON.stringify({ agent: "${version}", protocol: [1], node: process.versions.node, home: process.env.PSO_AGENT_HOME })); // ${salt}\n`);
const install = (data: Buffer, source: "install" | "upgrade" = "upgrade", sha = checksum(data), retain = 5) => runReleaseOp<AgentReleaseChange>(run, DIR, { op: "install", dir: "__DIR__", file: uploadBuild(run, DIR, data), sha256: sha, by: "deploy", source, retain });
const list = () => runReleaseOp<AgentReleases>(run, DIR, { op: "list", dir: "__DIR__" });
const rollback = (to?: string) => runReleaseOp<AgentReleaseChange>(run, DIR, { op: "rollback", dir: "__DIR__", ...(to ? { to } : {}), by: "deploy" });
const running = (): { agent: string; build?: string; release?: string } => JSON.parse(sh(`PSO_AGENT_HOME="$HOME/.pso-agent" node "$HOME/.pso-agent/bin/pso-agent.mjs" version`));

test("agent releases: adoption of the legacy file, builds of one version told apart, atomic switching, retention and rollback, state untouched", { skip: available ? false : "Docker or the pso-e2e-target:1 image is not available", timeout: 180_000 }, async () => {
  assert.equal(docker("run", "-d", "--name", name, "--entrypoint", "sleep", IMAGE, "600").status, 0);
  // the server as it is today: one plain file, plus the agent's own state
  const legacy = stub("0.1.0", "original");
  sh(`mkdir -p "$HOME/.pso-agent/bin" "$HOME/.pso-agent/identity" "$HOME/.pso-agent/apps/shop" && echo -n "server-key" > "$HOME/.pso-agent/identity/server.key" && echo '{"allowedStrategies":["blue-green"]}' > "$HOME/.pso-agent/policy.json" && echo '{"x":1}' > "$HOME/.pso-agent/apps/shop/state.json"`);
  run(`cat > "$HOME/.pso-agent/bin/pso-agent.mjs"`, legacy);
  const stateBefore = sh(`cd "$HOME/.pso-agent" && cat identity/server.key policy.json apps/shop/state.json | sha256sum`);
  assert.equal(list().layout, "legacy");

  // first versioned upgrade: the legacy file is ADOPTED as a release, then the new one is activated
  const b = stub("0.2.0", "build-b"); const r1 = install(b);
  assert.equal(r1.changed, true); assert.equal(r1.to, agentReleaseId("0.2.0", checksum(b))); assert.equal(r1.from, agentReleaseId("0.1.0", checksum(legacy)), "the original is a release now, with its checksum");
  assert.equal(r1.previous, r1.from); assert.equal(list().layout, "releases");
  assert.equal(sh(`readlink "$HOME/.pso-agent/bin/pso-agent.mjs"`), `../releases/${r1.to}/pso-agent.mjs`, "the file the server runs is a link to the active release");
  assert.equal(running().agent, "0.2.0");
  const adopted = r1.releases.find((x) => x.id === r1.from)!; assert.equal(adopted.source, "adopted"); assert.equal(adopted.sha256, checksum(legacy)); assert.equal(adopted.version, "0.1.0");
  const active = r1.releases.find((x) => x.id === r1.to)!; assert.equal(active.sha256, checksum(b)); assert.equal(active.installedBy, "deploy"); assert.match(active.installedAt, /^\d{4}-/); assert.deepEqual(active.compat.protocol, [1]);

  // two builds of the same semantic version are two releases; an identical re-install changes nothing
  const c = stub("0.2.0", "build-c"); const r2 = install(c);
  assert.notEqual(r2.to, r1.to); assert.equal(r2.to.split("+")[0], "0.2.0"); assert.equal(r2.previous, r1.to, "the previous build is exactly the one that was active");
  assert.equal(install(c).changed, false, "installing the same bytes again is a no-op");
  assert.deepEqual(list().releases.map((x) => x.version).sort(), ["0.1.0", "0.2.0", "0.2.0"]);

  // the agent's state is outside the releases: nothing of it moved
  assert.equal(sh(`cd "$HOME/.pso-agent" && cat identity/server.key policy.json apps/shop/state.json | sha256sum`), stateBefore);
  assert.equal(sh(`ls "$HOME/.pso-agent/bin" "$HOME/.pso-agent/releases" | grep -c "tmp\\|new\\|upload" || true`), "0", "no temporary or half-installed file is left behind");

  // refusals leave the running agent exactly as it was
  const activeBefore = list().active;
  assert.throws(() => install(stub("0.3.0", "x"), "upgrade", "0".repeat(64)), /checksum mismatch/); assert.equal(list().active, activeBefore);
  assert.throws(() => install(stub("0.3.0", "dies", true)), /did not start/); assert.equal(list().active, activeBefore); assert.equal(running().agent, "0.2.0");

  // explicit rollback: to the previous build, then to the adopted original, each re-verified first
  const rb1 = rollback(); assert.equal(rb1.to, r1.to); assert.equal(running().agent, "0.2.0"); assert.equal(list().active, r1.to);
  const rb2 = rollback(r1.from!); assert.equal(rb2.to, r1.from); assert.equal(running().agent, "0.1.0", "the ORIGINAL 0.1.0 is back (it was adopted, so it is a real rollback point)");
  assert.throws(() => rollback(r1.from!), /already the active/); assert.throws(() => rollback("9.9.9+deadbeefdead"), /unknown release/);
  assert.deepEqual(list().history.map((h) => h.action), ["adopt", "upgrade", "upgrade", "rollback", "rollback"]);
  rollback(r2.to);
  // a release whose bytes changed on disk is refused, never activated
  sh(`echo "// tampered" >> "$HOME/.pso-agent/releases/${r1.to}/pso-agent.mjs"`);
  assert.throws(() => rollback(r1.to), /no longer matches its recorded checksum/); assert.equal(list().active, r2.to);

  // retention: the active and the previous release are always kept, older ones beyond the limit are removed
  for (let i = 0; i < 6; i++) install(stub("0.2.0", `bulk-${i}`), "upgrade", undefined, 3);
  const after = list(); assert.equal(after.releases.length, 3); assert.ok(after.releases.some((x) => x.id === after.active) && after.releases.some((x) => x.id === after.previous));
  assert.equal(running().agent, "0.2.0");
});

test("agent releases: the real agent bundle reports its build, its release and its protocol, and runs through the link", { skip: available ? false : "Docker or the pso-e2e-target:1 image is not available", timeout: 120_000 }, () => {
  const bundle = readFileSync(resolve(import.meta.dirname, "..", "agent", "pso-agent.mjs"));
  const r = install(bundle, "install");
  const v = running();
  assert.equal(v.agent, r.to.split("+")[0]); assert.equal(v.build, checksum(bundle).slice(0, 12)); assert.equal(v.release, r.to); assert.equal(r.to, agentReleaseId(v.agent, checksum(bundle)));
  void mkdtempSync; void tmpdir; void join; void writeFileSync;
});
