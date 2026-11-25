import { test, after } from "node:test";
import { sessionEnv } from "../../../scripts/dispatch-brokers.mjs";
import assert from "node:assert/strict";
import net from "node:net";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { psoJavaDir } from "../src/specs.ts";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const example = resolve(import.meta.dirname, "..", "docs", "examples", "spring-outbox");
const REDIS = (sessionEnv(undefined, ["redis"]) as Record<string, string | undefined>)["PSO_TEST_REDIS_URL"] ?? "redis://127.0.0.1:1";
const redisUp = await new Promise<boolean>((r) => { const u = new URL(REDIS); const s = net.connect(Number(u.port), u.hostname); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });

/** The transactional-outbox tutorial's files, generated with the CLI, compiled and run against real PostgreSQL and real Redis. */
test("the outbox tutorial's example commits, rolls back and delivers twice exactly as described", { timeout: 480_000, skip: psoJavaDir() === undefined ? "the PSO Java ecosystem is not next to the CLI" : redisUp ? false : "no local Redis (node scripts/dispatch-brokers.mjs up)" }, async () => {
  const base = tmp("pso-outbox-"); dirs.push(base);
  assert.equal((await pso(base, "init")).code, 0);
  assert.equal((await pso(base, "create", "service", "orders", "--structure", "legacy", "--db", "postgres", "--port", "18127")).code, 0);
  const installed = await pso(base, "dispatch:install", "redis", "--service", "orders");
  assert.equal(installed.code, 0);
  const outboxCmd = await pso(base, "dispatch:outbox", "--service", "orders");
  assert.equal(outboxCmd.code, 0);
  assert.ok(outboxCmd.out.includes("src/main/resources/db/migration/V1__pso_outbox.sql: the pso_outbox table"));
  assert.equal((await pso(base, "make:migration", "create-orders", "--service", "orders")).code, 0);

  const svc = join(base, "orders");
  assert.ok(existsSync(join(svc, "src/main/resources/db/migration/V2__create_orders.sql")), "make:migration creates V2__create_orders.sql, which the example replaces");
  cpSync(join(example, "src"), join(svc, "src"), { recursive: true }); // business code, events and one test class; the generated profiles (dispatch disabled by default) and generated tests are kept as they are
  const validation = await pso(base, "validate");
  assert.equal(validation.code, 0, validation.out + validation.err);
  const dv = await pso(base, "dispatch:validate");
  assert.equal(dv.code, 0, dv.out + dv.err);

  const mvnw = join(psoJavaDir()!, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  const r = spawnSync(mvnw, ["-B", "-ntp", "-o", "test"], { cwd: svc, encoding: "utf8", shell: process.platform === "win32", timeout: 460_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PSO_TEST_REDIS_URL: REDIS } });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run:/.test(l)).slice(0, 30).join("\n"));
  const report = readFileSync(join(svc, "target/surefire-reports/com.pso.orders.application.OrderOutboxTests.txt"), "utf8");
  assert.match(report, /Tests run: 3, Failures: 0, Errors: 0, Skipped: 0/);
  if (process.env["PSO_KEEP_TRANSCRIPTS"]) writeFileSync(join(process.env["PSO_KEEP_TRANSCRIPTS"], "outbox-transcript.txt"), readFileSync(join(svc, "target", "outbox-transcript.txt")));
});
