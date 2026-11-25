import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { walkFiles, discover } from "../src/index.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const base = (): string => { const d = mkdtempSync(join(tmpdir(), "pso-walk-")); dirs.push(d); return d; };
const put = (root: string, rel: string, body = "x"): void => { const f = join(root, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); };
const rels = (root: string, files: string[]): string[] => files.map((f) => relative(root, f).split("\\").join("/"));
/** a directory link that works without elevation on Windows (junction) and on POSIX (symlink) */
function link(target: string, path: string): boolean {
  try { symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir"); return true; } catch { return false; }
}

test("ordinary nested directories are walked in a deterministic order", () => {
  const r = base();
  for (const f of ["b/two.ts", "a/one.ts", "a/deep/er/three.ts", "z.ts"]) put(r, f);
  const first = walkFiles(r);
  assert.deepEqual(rels(r, first.files), ["a/deep/er/three.ts", "a/one.ts", "b/two.ts", "z.ts"]);
  assert.deepEqual(first.issues, []);
  assert.deepEqual(walkFiles(r).files, first.files);
});

test("ignored directory names are never entered", () => {
  const r = base();
  put(r, "src/a.ts"); put(r, "node_modules/x/evil.ts"); put(r, "dist/b.js");
  assert.deepEqual(rels(r, walkFiles(r, { ignore: new Set(["node_modules", "dist"]) }).files), ["src/a.ts"]);
});

test("a link to a directory OUTSIDE the root is never followed (default policy)", (t) => {
  const r = base(), outside = base();
  put(outside, "secret.ts", "SECRET"); put(r, "src/ok.ts");
  if (!link(outside, join(r, "src", "escape"))) return t.skip("directory links cannot be created here");
  const w = walkFiles(r);
  assert.deepEqual(rels(r, w.files), ["src/ok.ts"]);
  assert.ok(w.issues.some((i) => i.code === "PSO_FS_SYMLINK_SKIPPED" && i.path.endsWith("escape")));
});

test("with policy 'internal' a link inside the root is followed once, a link outside is still refused", (t) => {
  const r = base(), outside = base();
  put(r, "real/a.ts"); put(outside, "secret.ts");
  if (!link(join(r, "real"), join(r, "alias")) || !link(outside, join(r, "escape"))) return t.skip("directory links cannot be created here");
  const w = walkFiles(r, { symlinks: "internal" });
  const names = rels(r, w.files);
  assert.equal(names.filter((n) => n.endsWith("a.ts")).length, 1, "the same canonical directory is not scanned twice");
  assert.ok(!names.some((n) => n.includes("secret")));
  assert.ok(w.issues.some((i) => i.code === "PSO_FS_OUTSIDE_ROOT"));
});

test("circular links terminate (both policies) and do not duplicate files", (t) => {
  const r = base();
  put(r, "a/file.ts");
  if (!link(r, join(r, "a", "loop"))) return t.skip("directory links cannot be created here");
  for (const symlinks of ["skip", "internal"] as const) {
    const w = walkFiles(r, { symlinks });
    assert.deepEqual(rels(r, w.files), ["a/file.ts"], symlinks);
  }
});

test("a nested directory that is reached through a linked PARENT cannot escape the root", (t) => {
  const r = base(), outside = base();
  put(outside, "inner/secret.ts");
  if (!link(outside, join(r, "ext"))) return t.skip("directory links cannot be created here");
  // scanning below the link directly: the canonical start is the outside directory, so it is the authorized root of that scan
  assert.deepEqual(rels(join(r, "ext"), walkFiles(join(r, "ext")).files), ["inner/secret.ts"]);
  // scanning the project never reaches it
  assert.deepEqual(walkFiles(r).files, []);
});

test("an unreadable directory is reported and the rest of the scan continues", (t) => {
  if (process.platform === "win32") return t.skip("POSIX permission bits do not apply on Windows");
  const r = base();
  put(r, "ok/a.ts"); put(r, "locked/b.ts");
  chmodSync(join(r, "locked"), 0o000);
  try {
    const w = walkFiles(r);
    assert.deepEqual(rels(r, w.files), ["ok/a.ts"]);
    assert.ok(w.issues.some((i) => i.code === "PSO_FS_UNREADABLE"));
  } finally { chmodSync(join(r, "locked"), 0o755); }
});

test("a missing root is reported, not thrown", () => {
  const w = walkFiles(join(base(), "does-not-exist"));
  assert.deepEqual(w.files, []);
  assert.equal(w.issues[0]?.code, "PSO_FS_UNREADABLE");
});

test("depth and file-count limits stop pathological trees with a diagnostic", () => {
  const r = base();
  put(r, "a/b/c/d/e/f.ts"); for (let i = 0; i < 5; i++) put(r, `many/${i}.ts`);
  assert.ok(walkFiles(r, { maxDepth: 2 }).issues.some((i) => i.code === "PSO_FS_DEPTH_LIMIT"));
  const limited = walkFiles(r, { maxFiles: 3 });
  assert.equal(limited.files.length, 3);
  assert.ok(limited.issues.some((i) => i.code === "PSO_FS_FILE_LIMIT"));
});

test("discover(): modules are found, a link in the source tree is a warning and never contributes resources", (t) => {
  const r = base(), outside = base();
  put(r, "src/routes/users/MODULE.pso.ts", "export default {}");
  put(outside, "routes/evil/MODULE.pso.ts", "export default {}");
  const d0 = discover(r, "node");
  assert.deepEqual(d0.resources.map((x) => x.key), ["module:users"]);
  if (!link(join(outside, "routes"), join(r, "src", "routes", "linked"))) return t.skip("directory links cannot be created here");
  const d = discover(r, "node");
  assert.deepEqual(d.resources.map((x) => x.key), ["module:users"], "nothing outside the project becomes a resource");
  assert.ok(d.diagnostics.some((x) => x.code === "PSO_FS_SYMLINK_SKIPPED" && x.severity === "warning"));
});
