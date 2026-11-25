import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planShutdownMigration } from "../src/commands-migrate.ts";
import { pso, tmp, prepare } from "./helpers.ts";

/**
 * MIG-01: orchestrators generated before 2026-11-13 carry a fixed 10 s exit timer in src/main.ts. `pso migrate` recognises the exact
 * block that was generated, shows what it would change, and with --apply replaces that block only, keeping the previous file.
 * Anything it does not recognise is left alone and reported.
 */
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

/** src/main.ts exactly as `pso create orchestrator` wrote it before the shutdown correction */
const legacyMain = (port: number): string => `import "reflect-metadata";
import { resolve } from "node:path";
import { bootstrap, log, StartupError } from "@pso/http";

// The runtime activates an endpoint only if it is declared in a module's ROUTES.pso.ts, the module is valid
// (MODULE.pso.ts) and the controller action is compatible. Nothing is exposed implicitly.
bootstrap({ appDir: __dirname, workspaceFile: process.env["PSO_WORKSPACE"] ?? resolve(__dirname, "..", "..", "pso.workspace.json"), port: Number(process.env["PORT"] ?? ${port}) })
  .then((app) => {
    const shutdown = (sig: string) => {
      log("info", "shutting down", { sig });
      void app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((e: Error) => {
    log("error", "startup failed", { error: e.message, diagnostics: e instanceof StartupError ? e.diagnostics.map((d) => d.code) : undefined });
    process.exit(1);
  });
`;

async function workspace(): Promise<{ root: string; main: string }> {
  const base = tmp("pso-migrate-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "w", "--layout", "flat")).code, 0);
  const root = join(base, "w");
  assert.equal((await pso(root, "create", "orchestrator", "gw", "--structure", "legacy")).code, 0);
  return { root, main: join(root, "gw", "src", "main.ts") };
}

test("an unmodified legacy main.ts becomes exactly what the current generator writes; preview first, --apply keeps a backup, twice is a no-op", async () => {
  const { root, main } = await workspace();
  const current = readFileSync(main, "utf8");
  assert.equal(planShutdownMigration(current).state, "current");
  const upToDate = await pso(root, "migrate");
  assert.equal(upToDate.code, 0); assert.match(upToDate.out, /up to date {2}gw\/src\/main\.ts {2}\[shutdown-on-signals\]/);

  const port = Number(/"PORT"\] \?\? (\d+)/.exec(current)![1]);
  writeFileSync(main, legacyMain(port));
  const preview = await pso(root, "migrate");
  assert.equal(preview.code, 1, "something is pending");
  assert.match(preview.out, /would update gw\/src\/main\.ts/);
  assert.match(preview.out, /replace the generated shutdown block \(fixed 10 s exit timer\) with shutdownOnSignals\(app\)/);
  assert.match(preview.out, /Nothing was written\. Run `pso migrate --apply`/);
  assert.equal(readFileSync(main, "utf8"), legacyMain(port), "a preview changes nothing");
  assert.equal(existsSync(`${main}.bak`), false);

  const applied = await pso(root, "migrate", "--apply");
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /updated {5}gw\/src\/main\.ts/); assert.match(applied.out, /previous file kept as gw\/src\/main\.ts\.bak/);
  assert.equal(readFileSync(main, "utf8").replaceAll("\r\n", "\n"), current.replaceAll("\r\n", "\n"), "the migrated file is the file the current generator creates");
  assert.equal(readFileSync(`${main}.bak`, "utf8"), legacyMain(port));
  const again = JSON.parse((await pso(root, "migrate", "--apply", "--json")).out) as { migrations: Array<{ state: string; action: string }> };
  assert.deepEqual(again.migrations.map((m) => [m.state, m.action]), [["current", "none"]], "idempotent");
  // the migrated application compiles with the real TypeScript compiler
  prepare(join(root, "gw"));
  assert.ok(existsSync(join(root, "gw", "dist", "main.js")));
  assert.match(readFileSync(join(root, "gw", "dist", "main.js"), "utf8"), /shutdownOnSignals\)\(app\)|shutdownOnSignals\(app\)/);
});

test("user code around the generated block is preserved: only the block and the import change", async () => {
  const { root, main } = await workspace();
  const custom = legacyMain(3000)
    .replace('import { bootstrap, log, StartupError } from "@pso/http";', 'import { bootstrap, log, StartupError } from "@pso/http";\nimport { warmCaches } from "./services/warm";\n\nconst STARTED = Date.now(); // application code')
    .replace("bootstrap({ appDir: __dirname,", "void warmCaches();\nbootstrap({ appDir: __dirname,")
    .replace('log("error", "startup failed",', 'log("error", `startup failed after ${Date.now() - STARTED} ms`,')
    .replace(/\n/g, "\r\n"); // and the file's own line endings
  writeFileSync(main, custom);
  assert.equal((await pso(root, "migrate", "--apply")).code, 0);
  const out = readFileSync(main, "utf8");
  assert.ok(out.includes("\r\n") && !/[^\r]\n/.test(out), "line endings are kept");
  const text = out.replaceAll("\r\n", "\n");
  for (const kept of ['import { warmCaches } from "./services/warm";', "const STARTED = Date.now(); // application code", "void warmCaches();", "startup failed after ${Date.now() - STARTED} ms"]) assert.ok(text.includes(kept), kept);
  assert.ok(text.includes('import { bootstrap, log, shutdownOnSignals, StartupError } from "@pso/http";'));
  assert.ok(text.includes(".then((app) => { shutdownOnSignals(app); })"));
  assert.doesNotMatch(text, /10_000|process\.on\("SIGTERM"/);
  // everything outside the two changed places is byte for byte what the user had
  const strip = (s: string) => s.replaceAll("\r\n", "\n").replace(/  \.then\(\(app\) => \{[\s\S]*?\n  \}\)\n  \.catch/, "  .catch").replace(/  \/\/ SIGINT[\s\S]*?shutdownOnSignals\(app\); \}\)\n  \.catch/, "  .catch").replace("shutdownOnSignals, ", "");
  assert.equal(strip(out), strip(custom));
});

test("signal handling that is not the generated block is never rewritten: it is reported with what to do, and nothing is written", async () => {
  const { root, main } = await workspace();
  const edited = legacyMain(3000).replace("setTimeout(() => process.exit(1), 10_000).unref();", "setTimeout(() => process.exit(1), 10_000).unref();\n      void flushMetrics();");
  writeFileSync(main, edited);
  assert.equal(planShutdownMigration(edited).state, "custom");
  for (const argv of [["migrate"], ["migrate", "--apply"]]) {
    const r = await pso(root, ...argv);
    assert.equal(r.code, 1);
    assert.match(r.out, /MANUAL {6}gw\/src\/main\.ts/);
    assert.match(r.out, /is not the block PSO generated \(it was edited\), so it is not rewritten automatically\. Replace your handlers with `shutdownOnSignals\(app\)`/);
    assert.equal(readFileSync(main, "utf8"), edited);
    assert.equal(existsSync(`${main}.bak`), false);
  }
  // other shapes
  assert.equal(planShutdownMigration(undefined).state, "absent");
  assert.equal(planShutdownMigration('import { bootstrap } from "@pso/http";\nvoid bootstrap({ appDir: __dirname });\n').state, "none");
  assert.equal(planShutdownMigration(legacyMain(3000) + legacyMain(3001)).state, "custom", "the block twice is not something PSO generated");
  // a different import shape still gets a working import
  const split = legacyMain(3000).replace('import { bootstrap, log, StartupError } from "@pso/http";', 'import * as pso from "@pso/http";\nconst { bootstrap, log, StartupError } = pso;');
  const plan = planShutdownMigration(split);
  assert.equal(plan.state, "legacy");
  assert.ok(plan.next!.includes('import { shutdownOnSignals } from "@pso/http";') && plan.next!.includes("shutdownOnSignals(app)"));
  assert.match((await pso(root, "migrate", "--service", "nope")).err, /Unknown Node service "nope"/);
});
