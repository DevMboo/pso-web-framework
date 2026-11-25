import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { up, down, sweepStale, sessionEnv, ownedBy, inspect, containerName, sessionId, dockerAvailable } from "../../../scripts/dispatch-brokers.mjs";

/**
 * Ownership and isolation of the test infrastructure (ISO-01). The defect: a container was reused because its NAME matched, and a
 * test assumed fixed ports. Now a container is reused, started or removed only when its labels prove it belongs to the calling test
 * session, ports are assigned by the operating system, and cleanup removes what the session owns and nothing else.
 *
 * Every container this file creates is its own: the fixtures carry a random token and are removed by the id Docker returned for them.
 */
const SCRIPT = resolve(import.meta.dirname, "..", "..", "..", "scripts", "dispatch-brokers.mjs");
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8" });
const skip = dockerAvailable() ? false : "no Docker engine: real broker tests not run";
const rnd = () => Math.random().toString(16).slice(2, 10);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const token = `fixture-${rnd()}`;
const fixtures: string[] = [];
const sessions: string[] = [];
const session = (): string => { const s = `iso${rnd()}`; sessions.push(s); return s; };
after(() => {
  for (const s of sessions) down({ session: s });
  for (const id of fixtures) if (docker("inspect", "-f", '{{ index .Config.Labels "pso.test.fixture" }}', id).stdout.trim() === token) docker("rm", "-f", "-v", id); // only what this file created
});

type Up = (o: { session: string; kinds: string[]; ignoreEnv?: boolean }) => Promise<Record<string, string>>;
const start = up as unknown as Up;
const state = (id: string): string => docker("inspect", "-f", "{{.Id}} {{.State.Running}} {{.State.StartedAt}} {{.RestartCount}}", id).stdout.trim();
/** Someone else's container: created outside the helper, with whatever labels the scenario needs. */
function foreign(name: string, labels: string[]): string {
  const r = docker("run", "-d", "--name", name, "--label", `pso.test.fixture=${token}`, ...labels.flatMap((l) => ["--label", l]), "redis:7-alpine");
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim(); fixtures.push(id);
  return id;
}
const ping = (url: string) => new Promise<boolean>((res) => {
  const u = new URL(url); const s = net.connect(Number(u.port), u.hostname);
  s.setTimeout(3000, () => { s.destroy(); res(false); });
  s.once("error", () => res(false));
  s.once("connect", () => s.write("PING\r\n"));
  s.once("data", (d) => { s.destroy(); res(String(d).startsWith("+PONG")); });
});
/** every container on the machine that this test did not create: id -> state */
const others = (mine: (name: string) => boolean): Map<string, string> => new Map(docker("ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}").stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split(" ") as [string, string]).filter(([, n]) => !mine(n)).map(([id]) => [id, state(id)]));

test("a container with the session's name but without its labels is never reused, restarted or removed", { skip, timeout: 180_000 }, async () => {
  for (const [what, labels] of [
    ["no ownership label at all", []],
    ["the owner label of this project but another session", ["pso.test.owner=pso-web-framework", "pso.test.session=someone-else"]],
  ] as const) {
    const s = session();
    const name = containerName(s, "redis");
    const id = foreign(name, [...labels]);
    const before = state(id);
    assert.equal(ownedBy(name, s), false, what);
    // setup refuses: it neither adopts the container nor replaces it, and says what to do
    await assert.rejects(start({ session: s, kinds: ["redis"], ignoreEnv: true }), (e: Error) => {
      assert.match(e.message, new RegExp(`a container named ${name} already exists but was not created by test session "${s}"`), what);
      assert.match(e.message, /left untouched: not reused, not restarted, not removed/);
      assert.match(e.message, /PSO_TEST_SESSION=<id>/);
      return true;
    });
    // it is not offered to tests as infrastructure either
    const saved = process.env["PSO_TEST_REDIS_URL"]; delete process.env["PSO_TEST_REDIS_URL"];
    try { assert.deepEqual(sessionEnv(s, ["redis"]), {}, what); } finally { if (saved !== undefined) process.env["PSO_TEST_REDIS_URL"] = saved; }
    // cleanup of the session does not touch it
    assert.deepEqual(down({ session: s }), [], what);
    assert.deepEqual(sweepStale(s), []);
    assert.equal(state(id), before, `${what}: same container, still running, never restarted`);
  }
});

test("two sessions run side by side on ports the operating system assigned; each cleanup removes only its own containers", { skip, timeout: 240_000 }, async () => {
  const a = session(), b = session();
  // WHICH containers must survive the cleanup of these two sessions: sentinels this test creates itself (one with no labels, one claiming another session of this project).
  // A snapshot of every container on the machine was the previous check, and it failed whenever another test file (they run in parallel) legitimately started or
  // removed its own containers at the same time: shared machine state, not a framework defect. The sentinels keep the property and cannot be touched by anyone else.
  const sentinelA = foreign(`pso-sentinel-${rnd()}`, []), sentinelB = foreign(`pso-sentinel-${rnd()}`, ["pso.test.owner=pso-web-framework", "pso.test.session=someone-else"]);
  const untouched = new Map([[sentinelA, state(sentinelA)], [sentinelB, state(sentinelB)]]);
  const [ea, eb] = await Promise.all([start({ session: a, kinds: ["redis"], ignoreEnv: true }), start({ session: b, kinds: ["redis"], ignoreEnv: true })]);
  const ua = ea["PSO_TEST_REDIS_URL"]!, ub = eb["PSO_TEST_REDIS_URL"]!;
  assert.notEqual(ua, ub, "two sessions never share a broker");
  for (const u of [ua, ub]) { assert.match(u, /^redis:\/\/127\.0\.0\.1:\d+$/); assert.notEqual(new URL(u).port, "6379", "no well-known or fixed port"); assert.equal(await ping(u), true); }
  assert.equal(ownedBy(containerName(a, "redis"), a), true);
  assert.equal(ownedBy(containerName(a, "redis"), b), false, "one session does not own the other's container");
  // a second setup of the same session verifies the labels and reuses the same container (same address, not restarted)
  const before = state(containerName(a, "redis"));
  assert.equal((await start({ session: a, kinds: ["redis"], ignoreEnv: true }))["PSO_TEST_REDIS_URL"], ua);
  assert.equal(state(containerName(a, "redis")), before);
  // an address given by the developer is used as it is: nothing is created or looked up for that kind
  const mine = session();
  const saved = process.env["PSO_TEST_REDIS_URL"]; process.env["PSO_TEST_REDIS_URL"] = "redis://my-own-redis.internal:6379";
  try { assert.deepEqual(await start({ session: mine, kinds: ["redis"] }), { PSO_TEST_REDIS_URL: "redis://my-own-redis.internal:6379" }); }
  finally { if (saved === undefined) delete process.env["PSO_TEST_REDIS_URL"]; else process.env["PSO_TEST_REDIS_URL"] = saved; }
  assert.equal(inspect(containerName(mine, "redis")), undefined);
  // cleanup is per session
  assert.deepEqual(down({ session: a }), [containerName(a, "redis")]);
  assert.equal(inspect(containerName(a, "redis")), undefined);
  assert.equal(await ping(ub), true, "the other session keeps working");
  assert.deepEqual(down({ session: b }), [containerName(b, "redis")]);
  assert.deepEqual(down({ session: b }), [], "cleanup is idempotent");
  for (const [id, was] of untouched) assert.equal(state(id), was, "a container that belongs to neither session was not stopped, restarted or removed");
});

test("a test that is interrupted leaves nothing behind: its own broker goes with the process, or with the next sweep after a hard kill", { skip, timeout: 240_000 }, async () => {
  const s = session();
  const child = (ending: string) => {
    const code = `import { ownedBroker } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const b = await ownedBroker("redis", { session: ${JSON.stringify(s)} });
console.log("NAME=" + b.name);
${ending}`;
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; c.stdout.on("data", (d: Buffer) => { out += d; });
    const name = async (): Promise<string> => { for (let i = 0; i < 1200 && !/NAME=(\S+)/.test(out) && c.exitCode === null; i++) await sleep(100); const m = /NAME=(\S+)/.exec(out); assert.ok(m, `the child started its broker (exit ${c.exitCode})`); return m[1]!; };
    return { c, name, exited: new Promise<void>((r) => c.once("exit", () => r())) };
  };
  // 1. the test process ends without removing its broker (an uncaught error, a timeout that exits): the exit hook removes it
  const polite = child("process.exit(3);");
  const politeName = await polite.name();
  await polite.exited;
  assert.equal(inspect(politeName), undefined, "removed when the process exited");
  // 2. the test process is killed outright (no hook can run): the container stays, labelled with the dead process
  const killed = child("setInterval(() => {}, 1000);");
  const killedName = await killed.name();
  assert.equal(ownedBy(killedName, s), true);
  assert.deepEqual(sweepStale(s), [], "a broker whose test is still running is not swept");
  killed.c.kill("SIGKILL");
  await killed.exited;
  assert.equal(ownedBy(killedName, s), true, "a hard kill leaves the container");
  assert.deepEqual(sweepStale(s), [killedName], "the next sweep of the same session removes it");
  assert.equal(inspect(killedName), undefined);
  // a sweep never crosses sessions
  assert.deepEqual(sweepStale(sessionId(session())), []);
});
