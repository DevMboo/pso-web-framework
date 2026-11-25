// Disposable Redis, RabbitMQ, Kafka and PostgreSQL containers for the integration tests.
//   node scripts/dispatch-brokers.mjs up     [--session <id>] [--kinds redis,rabbitmq,kafka,postgres]   start (or verify and reuse) the session's containers; prints the variables the tests read
//   node scripts/dispatch-brokers.mjs status [--session <id>]                                           what the session owns
//   node scripts/dispatch-brokers.mjs down   [--session <id>]                                           remove what the session owns, nothing else
// Requires a running Docker engine.
//
// Ownership (strict):
//  - A test SESSION has an identifier: PSO_TEST_SESSION or --session, otherwise one derived from the path of this checkout, so two
//    checkouts (or two agents with different identifiers) never share or disturb each other's containers.
//  - Every container created here is named pso-test-<session>-<kind>[...] and labelled pso.test.owner=pso-web-framework and
//    pso.test.session=<session>. A container is reused, started, restarted or removed ONLY after `docker inspect` confirmed both labels.
//    A name alone never proves ownership: a container that has the expected name but not the labels is left exactly as it is and the
//    helper stops with an explanation.
//  - Host ports are picked by the operating system (127.0.0.1 only) and read back from the container; nothing assumes a fixed port.
//  - Infrastructure you manage yourself is used as it is and never touched: set PSO_TEST_REDIS_URL, PSO_TEST_RABBITMQ_URL,
//    PSO_TEST_KAFKA_BROKERS or PSO_TEST_POSTGRES_URL and no container is created (or looked for) for that kind.
//  - A test that must restart or stop a broker starts its own with ownedBroker(); it is removed when the test ends, when the test
//    process exits, or, after a hard kill, by the next up()/down() of the same session (sweepStale).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
export const OWNER = "pso-web-framework";
export const OWNER_LABEL = `pso.test.owner=${OWNER}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The session identifier: explicit, PSO_TEST_SESSION, or derived from this checkout's path. */
export function sessionId(explicit) {
  const id = explicit ?? process.env["PSO_TEST_SESSION"] ?? `w${createHash("sha256").update(ROOT.toLowerCase().replace(/\\/g, "/")).digest("hex").slice(0, 8)}`;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error(`invalid test session identifier "${id}" (lower-case letters, digits and "-", at most 32 characters)`);
  return id;
}
export const containerName = (session, kind) => `pso-test-${session}-${kind}`;

const KINDS = {
  redis: { variable: "PSO_TEST_REDIS_URL", port: 6379, run: () => ["redis:7-alpine", "redis-server", "--appendonly", "yes"], url: (p) => `redis://127.0.0.1:${p}`,
    ready: (name) => docker("exec", name, "redis-cli", "ping").stdout.includes("PONG") },
  rabbitmq: { variable: "PSO_TEST_RABBITMQ_URL", port: 5672, run: () => ["rabbitmq:3.13-alpine"], url: (p) => `amqp://guest:guest@127.0.0.1:${p}`,
    ready: (_name, port) => amqpAnswers(port) },
  kafka: { variable: "PSO_TEST_KAFKA_BROKERS", port: 9092, url: (p) => `127.0.0.1:${p}`,
    run: (p) => ["-e", "KAFKA_NODE_ID=1", "-e", "KAFKA_PROCESS_ROLES=broker,controller", "-e", "KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093", "-e", `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${p}`, "-e", "KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER", "-e", "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT", "-e", "KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093", "-e", "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1", "-e", "KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1", "-e", "KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1", "-e", "KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0", "apache/kafka:3.8.0"],
    ready: (name) => { const l = docker("logs", name); return `${l.stdout}${l.stderr}`.includes("Kafka Server started"); } },
  postgres: { variable: "PSO_TEST_POSTGRES_URL", port: 5432, run: () => ["-e", "POSTGRES_USER=pso", "-e", "POSTGRES_PASSWORD=pso", "-e", "POSTGRES_DB=pso", "postgres:16-alpine"], url: (p) => `jdbc:postgresql://127.0.0.1:${p}/pso?user=pso&password=pso`,
    ready: (name) => docker("exec", name, "pg_isready", "-U", "pso").status === 0 },
};
export const ALL_KINDS = Object.keys(KINDS);
const kindsOf = (kinds) => { for (const k of kinds ?? ALL_KINDS) if (!(k in KINDS)) throw new Error(`unknown kind "${k}" (${ALL_KINDS.join(", ")})`); return kinds ?? ALL_KINDS; };

/** What Docker says about a container: undefined when there is none with that name or id. */
export function inspect(nameOrId) {
  const r = docker("inspect", "--type", "container", "-f", "{{json .Config.Labels}}\t{{.State.Running}}\t{{.Id}}\t{{.Name}}", nameOrId);
  if (r.status !== 0) return undefined;
  const [labels, running, id, name] = r.stdout.trim().split("\t");
  let parsed = {}; try { parsed = JSON.parse(labels) ?? {}; } catch { /* no labels */ }
  return { labels: parsed, running: running === "true", id, name: (name ?? "").replace(/^\//, "") };
}
/** Ownership is the two labels, verified on the container itself; never the name. */
const belongs = (info, session) => !!info && info.labels["pso.test.owner"] === OWNER && info.labels["pso.test.session"] === session;
/** true: exists and belongs to the session; false: exists and does not; undefined: absent */
export const ownedBy = (name, session) => { const i = inspect(name); return i === undefined ? undefined : belongs(i, session); };

const conflict = (name, session) => new Error(
  `a container named ${name} already exists but was not created by test session "${session}" (it does not carry the labels ${OWNER_LABEL} and pso.test.session=${session}). `
  + `It was left untouched: not reused, not restarted, not removed. Use another session (PSO_TEST_SESSION=<id> or --session <id>), `
  + `or point the tests at infrastructure you manage with PSO_TEST_REDIS_URL, PSO_TEST_RABBITMQ_URL, PSO_TEST_KAFKA_BROKERS and PSO_TEST_POSTGRES_URL.`);

/** Removes one container, only after confirming on the container that it belongs to the session. */
function removeVerified(nameOrId, session) {
  const info = inspect(nameOrId);
  if (info === undefined) return true;
  if (!belongs(info, session)) return false;
  return docker("rm", "-f", "-v", info.id).status === 0;
}
const listSession = (session, ...filters) => {
  const r = docker("ps", "-aq", "--no-trunc", "--filter", `label=${OWNER_LABEL}`, "--filter", `label=pso.test.session=${session}`, ...filters.flatMap((f) => ["--filter", f]));
  return r.status === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
};

/** The host port Docker published for a container port. */
export function hostPort(name, containerPort) {
  const r = docker("port", name, `${containerPort}/tcp`);
  const m = r.status === 0 ? /:(\d+)\s*$/m.exec(r.stdout.trim().split(/\r?\n/)[0] ?? "") : null;
  return m ? Number(m[1]) : undefined;
}

const open = (port) => new Promise((r) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

/**
 * True when an AMQP 0-9-1 server answers the protocol header on the port. Asked from the host, never with `docker exec`: a CLI run
 * inside the container before the server created its Erlang cookie creates one the server then cannot read, and the broker dies.
 */
const amqpAnswers = (port) => new Promise((res) => {
  const s = net.connect(port, "127.0.0.1");
  const done = (ok) => { s.destroy(); res(ok); };
  s.setTimeout(2000, () => done(false));
  s.once("error", () => done(false));
  s.once("close", () => res(false));
  s.once("connect", () => s.write(Buffer.from([0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1]))); // "AMQP" 0 0 9 1
  s.once("data", (d) => done(d.length > 0 && d[0] === 1)); // a method frame (Connection.Start)
});

export const dockerAvailable = () => docker("info", "--format", "{{.ServerVersion}}").status === 0;

/**
 * The variables the tests read, WITHOUT starting anything: a variable that is already set wins (your own infrastructure); otherwise the
 * address of the session's running, verified container; a kind with neither is absent from the result. Synchronous on purpose.
 */
export function sessionEnv(session, kinds) {
  const out = {};
  let id;
  for (const k of kindsOf(kinds)) {
    const spec = KINDS[k];
    const given = process.env[spec.variable];
    if (given) { out[spec.variable] = given; continue; }
    try { id ??= sessionId(session); } catch { continue; }
    const name = containerName(id, k);
    const info = inspect(name);
    if (!belongs(info, id) || !info.running) continue;
    const port = hostPort(name, spec.port);
    if (port) out[spec.variable] = spec.url(port);
  }
  return out;
}

/** Starts one labelled container of the session on a free local port; returns the port. Retries when the port was taken meanwhile. */
async function create(name, session, kind, extraLabels = []) {
  const spec = KINDS[kind];
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await freePort();
    const r = docker("run", "-d", "--name", name, "--label", OWNER_LABEL, "--label", `pso.test.session=${session}`, "--label", `pso.test.kind=${kind}`, ...extraLabels.flatMap((l) => ["--label", l]), "-p", `127.0.0.1:${port}:${spec.port}`, ...spec.run(port));
    if (r.status === 0) return port;
    last = r.stderr.trim();
    const info = inspect(name);
    if (/is already in use by container/i.test(last)) { // the name is taken: by a sibling process of this session (fine) or by something else (never touched)
      if (!belongs(info, session)) throw conflict(name, session);
      return undefined; // the caller adopts the verified container
    }
    // a failed start (the port was taken between the probe and the bind) can leave the container created: it is ours, verified, removed
    if (info && belongs(info, session) && !info.running) removeVerified(name, session);
    if (!/port is already allocated|address already in use|bind/i.test(last)) break;
  }
  throw new Error(`cannot start ${name}: ${last}`);
}

async function waitReady(name, kind, port, ms = 120_000) {
  for (let t = 0; t < ms; t += 500) { if ((await open(port)) && (await KINDS[kind].ready(name, port))) return; await sleep(500); }
  throw new Error(`${name} did not become ready on 127.0.0.1:${port}`);
}

/**
 * Makes the session's infrastructure available and returns the variables the tests read. A kind whose variable is already set is used
 * as it is. A container is reused only when its labels prove it belongs to this session; anything else with the same name stops the
 * call (see `conflict`), untouched.
 */
export async function up(opts = {}) {
  const kinds = kindsOf(opts.kinds);
  const env = {};
  const mine = [];
  for (const k of kinds) { const given = process.env[KINDS[k].variable]; if (given && !opts.ignoreEnv) env[KINDS[k].variable] = given; else mine.push(k); }
  if (!mine.length) return env;
  if (!dockerAvailable()) throw new Error("the Docker engine is not running");
  const session = sessionId(opts.session);
  sweepStale(session);
  const started = [];
  for (const k of mine) {
    const name = containerName(session, k);
    let info = inspect(name);
    if (info === undefined) { await create(name, session, k, ["pso.test.role=shared"]); info = inspect(name); }
    if (!belongs(info, session)) throw conflict(name, session);
    if (!info.running) { // ours (verified) and stopped, or still being started by a sibling process
      await sleep(300);
      if (!inspect(name)?.running) { const s = docker("start", name); if (s.status !== 0) throw new Error(`cannot start ${name}: ${s.stderr.trim()}`); }
    }
    started.push(k);
  }
  for (const k of started) {
    const name = containerName(session, k);
    let port;
    for (let i = 0; i < 40 && !(port = hostPort(name, KINDS[k].port)); i++) await sleep(250);
    if (!port) throw new Error(`${name} publishes no port`);
    await waitReady(name, k, port);
    env[KINDS[k].variable] = KINDS[k].url(port);
  }
  return env;
}

/** Removes every container of the session (shared and per-test), each one only after its labels were confirmed. Returns the names removed. */
export function down(opts = {}) {
  const session = sessionId(opts.session);
  const removed = [];
  for (const id of listSession(session)) { const info = inspect(id); if (info && removeVerified(id, session)) removed.push(info.name); }
  return removed;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** Removes the per-test containers of the session whose creating process no longer exists (a test that was killed before it could clean up). */
export function sweepStale(session = sessionId()) {
  const removed = [];
  for (const id of listSession(session, "label=pso.test.role=test")) {
    const info = inspect(id);
    const pid = Number(info?.labels["pso.test.pid"]);
    if (info && Number.isInteger(pid) && pid > 0 && !alive(pid) && removeVerified(id, session)) removed.push(info.name);
  }
  return removed;
}

const exitCleanup = new Map();
let exitHooked = false;
function onExit() { for (const [name, session] of exitCleanup) removeVerified(name, session); exitCleanup.clear(); }

/**
 * A broker that belongs to ONE test: unique name, the session's labels plus the creating process, its own free local port, removed
 * (with its volumes) by remove(), by the exit of the test process, or by sweepStale() after a hard kill. This is what a test uses when
 * it needs to restart or stop a broker, so the session's shared containers (and anything else on the machine) are never disturbed.
 */
export async function ownedBroker(kind, opts = {}) {
  if (kind !== "redis" && kind !== "rabbitmq") throw new Error(`ownedBroker: unsupported kind "${kind}" (redis, rabbitmq)`);
  if (!dockerAvailable()) throw new Error("the Docker engine is not running");
  const session = sessionId(opts.session);
  const name = `${containerName(session, kind)}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const port = await create(name, session, kind, ["pso.test.role=test", `pso.test.pid=${process.pid}`]);
  if (port === undefined) throw conflict(name, session);
  exitCleanup.set(name, session);
  if (!exitHooked) { exitHooked = true; process.once("exit", onExit); }
  const act = (verb) => { if (!ownedBy(name, session)) throw new Error(`${name} is not a container of this test session`); const x = docker(verb, name); if (x.status !== 0) throw new Error(`docker ${verb} ${name} failed: ${x.stderr}`); };
  const remove = () => { removeVerified(name, session); exitCleanup.delete(name); };
  try { await waitReady(name, kind, port); } catch (e) { remove(); throw e; }
  return { name, port, session, url: KINDS[kind].url(port), waitReady: (ms) => waitReady(name, kind, port, ms), restart: () => act("restart"), stop: () => act("stop"), start: () => act("start"), remove };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const cmd = args[0];
  try {
    const session = sessionId(value("session"));
    if (cmd === "up") {
      const env = await up({ session, ...(value("kinds") ? { kinds: value("kinds").split(",") } : {}) });
      console.log(`# test session ${session}`);
      for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
    } else if (cmd === "down") {
      const removed = down({ session });
      console.log(removed.length ? `removed (session ${session}): ${removed.join(", ")}` : `session ${session} owns no containers; nothing was removed`);
    } else if (cmd === "status") {
      const ids = listSession(session);
      console.log(`# test session ${session}: ${ids.length} container(s)`);
      for (const id of ids) { const i = inspect(id); if (i) console.log(`${i.name}  ${i.running ? "running" : "stopped"}  role=${i.labels["pso.test.role"] ?? "?"}`); }
      for (const [k, v] of Object.entries(sessionEnv(session))) console.log(`${k}=${v}`);
    } else console.log("usage: node scripts/dispatch-brokers.mjs up|status|down [--session <id>] [--kinds redis,rabbitmq,kafka,postgres]\n  down removes only containers labelled for the session; a container it did not create is never removed, whatever its name");
  } catch (e) { console.error(e.message); process.exit(1); }
}
