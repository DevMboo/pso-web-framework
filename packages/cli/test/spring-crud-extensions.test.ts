import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { psoJavaDir } from "../src/specs.ts";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const docs = resolve(import.meta.dirname, "..", "docs", "examples");

/** The CRUD tutorial's variations (search with pagination, filtering and sorting; PATCH; optimistic locking; database outage) are these files, compiled and executed. */
test("the CRUD extensions compile and their tests pass against a real PostgreSQL", { timeout: 480_000, skip: psoJavaDir() === undefined ? "the PSO Java ecosystem is not next to the CLI" : false }, async () => {
  const base = tmp("pso-crudx-"); dirs.push(base);
  assert.equal((await pso(base, "init")).code, 0);
  assert.equal((await pso(base, "create", "service", "catalog", "--structure", "legacy", "--db", "postgres", "--port", "18126")).code, 0);
  const svc = join(base, "catalog");
  cpSync(join(docs, "spring-crud", "src"), join(svc, "src"), { recursive: true });
  cpSync(join(docs, "spring-crud-extensions", "src"), join(svc, "src"), { recursive: true });
  const yml = join(svc, "src/main/resources/application.yml");
  writeFileSync(yml, readFileSync(join(docs, "spring-crud", "application.yml"), "utf8"));
  const validation = await pso(base, "validate");
  assert.equal(validation.code, 0, "the documented files respect the layout PSO validates (pso validate): " + validation.out + validation.err);
  const mvnw = join(psoJavaDir()!, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  const r = spawnSync(mvnw, ["-B", "-ntp", "-o", "test"], { cwd: svc, encoding: "utf8", shell: process.platform === "win32", timeout: 460_000, maxBuffer: 64 * 1024 * 1024 });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run:/.test(l)).slice(0, 30).join("\n"));
  for (const [name, n] of [["ProductExtensionsTests", 4], ["DatabaseOutageTests", 1], ["ProductCrudTests", 6]] as const) {
    const report = readFileSync(join(svc, `target/surefire-reports/com.pso.catalog.routes.${name}.txt`), "utf8");
    assert.match(report, new RegExp(`Tests run: ${n}, Failures: 0, Errors: 0, Skipped: 0`), name);
  }
  assert.ok(existsSync(join(svc, "target/extensions-transcript.txt")) && existsSync(join(svc, "target/outage-transcript.txt")));
  if (process.env["PSO_KEEP_TRANSCRIPTS"]) {
    for (const f of ["extensions-transcript.txt", "outage-transcript.txt"]) writeFileSync(join(process.env["PSO_KEEP_TRANSCRIPTS"], f), readFileSync(join(svc, "target", f)));
  }
});
