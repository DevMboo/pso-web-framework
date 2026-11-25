// The installation maintenance commands must keep working when another part of PSO is damaged: their entry point may only import
// node: built-ins, @pso/core and the install/package modules, never a command module or @pso/infra, @pso/deploy, @pso/frontend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ALLOWED_BARE = new Set(["@pso/core"]);

test("the maintenance entry point loads no command module and no infra/deploy/frontend engine", () => {
  const seen = new Set<string>(), bare = new Set<string>(), queue = [join(src, "maintenance.ts")];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^"']*?from\s+["']([^"']+)["']/gm)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) { const p = resolve(dirname(f), spec); assert.ok(existsSync(p), p); queue.push(p); } else bare.add(spec);
    }
  }
  const names = [...seen].map((f) => f.slice(src.length + 1).split("\\").join("/"));
  assert.deepEqual(names.filter((n) => /^commands(?!-install\.ts$)|registry|main\.ts$/.test(n)), [], `maintenance pulls in: ${names.join(", ")}`);
  assert.deepEqual([...bare].filter((b) => !ALLOWED_BARE.has(b)), []);
});

test("bin/pso.js routes the maintenance commands to their entry point", () => {
  const bin = readFileSync(join(src, "..", "bin", "pso.js"), "utf8");
  for (const c of ["setup", "integrity", "repair", "update", "uninstall"]) assert.match(bin, new RegExp(`"${c}"`));
  assert.match(bin, /dist\/maintenance\.js/);
});
