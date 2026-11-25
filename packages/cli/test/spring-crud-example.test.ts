import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { psoJavaDir } from "../src/specs.ts";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const example = resolve(import.meta.dirname, "..", "docs", "examples", "spring-crud");

/** The PostgreSQL CRUD example in the documentation is these exact files: generated service + example files + two configuration snippets, then its own tests run. */
test("the documented Spring + PostgreSQL CRUD example compiles and its tests pass (real Flyway, real PostgreSQL, real JWT)", { timeout: 420_000, skip: psoJavaDir() === undefined ? "the PSO Java ecosystem is not next to the CLI" : false }, async () => {
  const base = tmp("pso-crud-"); dirs.push(base);
  assert.equal((await pso(base, "init")).code, 0);
  assert.equal((await pso(base, "create", "service", "catalog", "--structure", "legacy", "--db", "postgres", "--port", "18125")).code, 0);
  const svc = join(base, "catalog");
  cpSync(join(example, "src"), join(svc, "src"), { recursive: true });
  const yml = join(svc, "src/main/resources/application.yml");
  let text = readFileSync(yml, "utf8");
  const pool = readFileSync(join(example, "datasource-pool.yml"), "utf8"), jpa = readFileSync(join(example, "jpa.yml"), "utf8");
  assert.ok(text.includes("    password: ${DB_PASSWORD:}\n") && text.includes("  flyway:\n    enabled: true\n"), "the generated configuration has the anchors the documentation tells the reader to extend");
  text = text.replace("    password: ${DB_PASSWORD:}\n", `    password: \${DB_PASSWORD:}\n${pool}`).replace("  flyway:\n    enabled: true\n", `  flyway:\n    enabled: true\n${jpa}`);
  writeFileSync(yml, text);
  const validation = await pso(base, "validate");
  assert.equal(validation.code, 0, "the documented files respect the layout PSO validates (pso validate): " + validation.out + validation.err);
  const mvnw = join(psoJavaDir()!, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  const r = spawnSync(mvnw, ["-B", "-ntp", "-o", "test"], { cwd: svc, encoding: "utf8", shell: process.platform === "win32", timeout: 400_000, maxBuffer: 64 * 1024 * 1024 });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run:/.test(l)).slice(0, 25).join("\n"));
  const report = readFileSync(join(svc, "target/surefire-reports/com.pso.catalog.routes.ProductCrudTests.txt"), "utf8");
  assert.match(report, /Tests run: 6, Failures: 0, Errors: 0, Skipped: 0/);
  assert.ok(existsSync(join(svc, "src/main/resources/db/migration/V1__create_products.sql")));
});
