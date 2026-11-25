import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Every Studio browser module must parse: one syntax error stops the whole single-page application from rendering, which the browser
// tests would only report as timeouts.
const root = resolve(import.meta.dirname, "..", "studio");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : []; });

test("every Studio script parses as an ES module", () => {
  const files = walk(root);
  assert.ok(files.length > 5, `found ${files.length} scripts`);
  const bad: string[] = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: readFileSync(f, "utf8"), encoding: "utf8" });
    if (r.status !== 0) bad.push(`${relative(root, f)}: ${r.stderr.split("\n").find((l) => /Error/.test(l)) ?? r.stderr.slice(0, 200)}`);
  }
  assert.deepEqual(bad, []);
});
