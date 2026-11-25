import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

async function ws(withSpring = true) {
  const base = tmp("pso-ops-"); dirs.push(base);
  await pso(base, "create", "workspace", "w");
  const root = join(base, "w");
  if (withSpring) await pso(root, "create", "service", "users", "--structure", "legacy");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  return root;
}
const javaOk = spawnSync("java", ["-version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const compose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

test("docker:init generates hardened Dockerfiles, compose, env template and CI; idempotent; no secrets", async () => {
  const root = await ws();
  const r = await pso(root, "docker:init");
  assert.equal(r.code, 0, r.err);
  const again = JSON.parse((await pso(root, "docker:init", "--json")).out);
  assert.ok(again.files.every((f: { action: string }) => f.action === "unchanged"));

  const node = readFileSync(join(root, "gw/Dockerfile"), "utf8");
  const spring = readFileSync(join(root, "users/Dockerfile"), "utf8");
  for (const d of [node, spring]) { assert.match(d, /\nUSER (node|app|10001)\n/, "non-root"); assert.match(d, /HEALTHCHECK/); assert.ok((d.match(/\nFROM /g) ?? []).length + 1 >= 2, "multi-stage"); assert.ok(!/password|secret|BEGIN/i.test(d)); }
  const dc = readFileSync(join(root, "docker-compose.yml"), "utf8");
  assert.ok(!/PSO_JWT_ISSUER: [^$]/.test(dc), "JWT settings come from the environment");
  assert.match(dc, /127\.0\.0\.1:3000:3000/);
  assert.equal((dc.match(/ports:/g) ?? []).length, 1, "only the orchestrator publishes a port");
  assert.match(dc, /PSO_UPSTREAM_USERS: "users:8081"/);
  assert.ok(readFileSync(join(root, "users/.dockerignore"), "utf8").includes("*.pem"), "keys are never sent to the build context");
  assert.match(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), /\.\/mvnw -B -ntp verify/);
  assert.equal((await pso(root, "docker:init", "--dry-run")).code, 0);
  assert.equal((await pso(root, "security:check")).code, 0, "generated Docker files introduce no security findings");
});

test("docker-compose.yml is accepted by `docker compose config` and keeps its security posture", { skip: compose ? false : "docker CLI with compose plugin not installed" }, async () => {
  const root = await ws();
  await pso(root, "docker:init");
  const env = { ...process.env, PSO_JWT_ISSUER: "i", PSO_JWT_AUDIENCE: "a", PSO_JWT_JWKS_URI: "https://idp.test/jwks" };
  const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(r.stdout) as { services: Record<string, { ports?: unknown[]; cap_drop?: string[]; read_only?: boolean; depends_on?: Record<string, { condition: string }> }> };
  assert.deepEqual(Object.keys(cfg.services).sort(), ["gw", "users"]);
  for (const s of Object.values(cfg.services)) { assert.deepEqual(s.cap_drop, ["ALL"]); assert.equal(s.read_only, true); }
  assert.equal(cfg.services["users"]!.ports, undefined);
  assert.equal(cfg.services["gw"]!.depends_on!["users"]!.condition, "service_healthy");
  const missing = spawnSync("docker", ["compose", "config", "-q"], { cwd: root, env: { ...process.env, PSO_JWT_ISSUER: "", PSO_JWT_AUDIENCE: "", PSO_JWT_JWKS_URI: "" }, encoding: "utf8" });
  assert.notEqual(missing.status, 0, "missing JWT settings must fail loudly, not start insecurely");
});

test("docker:build reports a missing daemon honestly instead of pretending", async () => {
  const root = await ws();
  assert.equal((await pso(root, "docker:build")).code, 1, "no docker-compose.yml yet");
  await pso(root, "docker:init");
  const d = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (d.status === 0) return; // a daemon exists: the real build is exercised manually, not here
  const r = await pso(root, "docker:build");
  assert.equal(r.code, 1);
  assert.match(r.err, /daemon is not running|not installed/);
});

test("build -> deploy:plan -> deploy -> rollback (native target) with real artifacts", { skip: javaOk ? false : "JDK not found", timeout: 900_000 }, async () => {
  const root = await ws();
  assert.equal((await pso(root, "services:unregister", "gw")).code, 0, "build only the Spring service here; Node packaging is tested separately");
  const b = await pso(root, "build", "--json");
  assert.equal(b.code, 0, b.out + b.err);
  const man = JSON.parse(readFileSync(join(root, ".pso/artifacts/manifest.json"), "utf8")) as Array<{ service: string; file: string; sha256: string }>;
  assert.equal(man.length, 1);
  assert.match(man[0]!.file, /^users-0\.1\.0\.jar$/);

  const target = join(tmp("pso-target-"));
  dirs.push(target);
  // F-11: the service's own version (0.1.0) is fixed, but it builds against the PSO SNAPSHOT artifacts (<pso.version>). The check
  // used to read the Spring Boot parent's version and so never saw that: a release is refused, a development deployment says so.
  const refused = await pso(root, "deploy:plan", "--target", "native", "--dir", target, "--json");
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /Refusing to deploy a SNAPSHOT build/);
  assert.match(refused.err, /users: the PSO artifacts are \S+-SNAPSHOT \(<pso\.version>\)/);
  assert.match(refused.err, /--allow-snapshot/);
  assert.equal((await pso(root, "deploy", "--target", "native", "--dir", target, "--yes")).code, 1, "deploy applies the same rule");
  assert.ok(!existsSync(join(target, "releases")), "nothing was deployed");
  const savedEnv = process.env["PSO_ENV"];
  process.env["PSO_ENV"] = "production";
  try {
    const prod = await pso(root, "deploy:plan", "--target", "native", "--dir", target, "--allow-snapshot", "--json");
    assert.equal(prod.code, 1, "production never accepts a SNAPSHOT, even when asked");
    assert.match(prod.err, /--allow-snapshot is not accepted for the production environment/);
  } finally { if (savedEnv === undefined) delete process.env["PSO_ENV"]; else process.env["PSO_ENV"] = savedEnv; }
  const plan = await pso(root, "deploy:plan", "--target", "native", "--dir", target, "--allow-snapshot", "--json");
  assert.equal(plan.code, 0, plan.err);
  assert.equal(JSON.parse(plan.out).developmentDeployment, true, "the plan states that this is not a release");
  assert.ok(!existsSync(join(target, "releases")), "plan changes nothing");
  const id = JSON.parse(plan.out).release as string;
  assert.match(id, /^0\.1\.0\+[0-9a-f]{8}$/);

  assert.equal((await pso(root, "deploy", "--target", "native", "--dir", target, "--allow-snapshot")).code, 3, "no --yes -> refused");
  assert.ok(!existsSync(join(target, "releases")));

  // first release; health verification against a service that is up
  const up = createServer((_q, res) => { res.writeHead(200); res.end("ok"); }); servers.push(up);
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const healthy = `http://127.0.0.1:${(up.address() as { port: number }).port}/h`;
  const d1 = await pso(root, "deploy", "--target", "native", "--dir", target, "--allow-snapshot", "--yes", "--health-url", healthy, "--health-timeout", "5");
  assert.equal(d1.code, 0, d1.err + d1.out);
  assert.equal(JSON.parse(readFileSync(join(target, "current.json"), "utf8")).release, id);
  assert.ok(existsSync(join(target, "releases", id, "users", "users-0.1.0.jar")));
  assert.equal((await pso(root, "rollback", "--dir", target, "--yes")).code, 1, "no previous release yet");

  // second release (different version) with a failing health check -> automatic rollback to the first
  const bad = await pso(root, "deploy", "--target", "native", "--dir", target, "--allow-snapshot", "--yes", "--release", "0.2.0", "--health-url", "http://127.0.0.1:1/never", "--health-timeout", "1");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /rolled back/);
  assert.equal(JSON.parse(readFileSync(join(target, "current.json"), "utf8")).release, id, "still on the first release");

  // second release that is healthy, then manual rollback
  assert.equal((await pso(root, "deploy", "--target", "native", "--dir", target, "--allow-snapshot", "--yes", "--release", "0.2.0")).code, 0);
  const cur = JSON.parse(readFileSync(join(target, "current.json"), "utf8")) as { release: string; previous: string };
  assert.equal(cur.previous, id);
  assert.equal((await pso(root, "rollback", "--dir", target)).code, 3, "rollback also needs --yes");
  assert.equal((await pso(root, "rollback", "--dir", target, "--yes")).code, 0);
  assert.equal(JSON.parse(readFileSync(join(target, "current.json"), "utf8")).release, id);
  assert.equal(readdirSync(join(target, "releases")).length, 2);

  // tampering with an artifact is detected before anything is copied
  writeFileSync(join(root, ".pso/artifacts/users", man[0]!.file), "tampered");
  const t = await pso(root, "deploy:plan", "--target", "native", "--dir", target);
  assert.equal(t.code, 1);
  assert.match(t.err, /does not match its recorded checksum/);
});

test("build packages a Node orchestrator (real npm install, type-check and pack)", { timeout: 300_000 }, async () => {
  const root = await ws(false);
  const b = await pso(root, "build", "--json");
  assert.equal(b.code, 0, b.out + b.err);
  const a = JSON.parse(b.out).artifacts as Array<{ service: string; file: string; sha256: string }>;
  assert.equal(a[0]!.service, "gw");
  assert.match(a[0]!.file, /\.tgz$/);
  // type errors are surfaced, not swallowed
  writeFileSync(join(root, "gw/src/routes/oops.route.ts"), 'const x: number = "nope";\nexport default x;\n');
  const bad = await pso(root, "build");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Type errors/);
  mkdirSync(join(root, "gw/src/ok"), { recursive: true });
});

test("lint and test commands report real results", { timeout: 300_000 }, async () => {
  const root = await ws(false);
  assert.equal((await pso(root, "lint", "--json")).code, 1, "dependencies not installed -> reported as a problem, never a silent pass");
  const l = JSON.parse((await pso(root, "lint", "--json")).out) as { ok: boolean; problems: string[] };
  assert.equal(l.problems.length, 1);
  assert.match(l.problems[0]!, /not installed/);
  const t = JSON.parse((await pso(root, "test", "--json")).out) as Array<{ status: string }>;
  assert.equal(t[0]!.status, "no-tests", "no tests are reported as no-tests, never as passed");
});
