import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp } from "./helpers.ts";

// The CRUD pages show the generated code itself: every block titled with a generated file (catalog/... or gateway/...) must be that
// file's text, line for line and in order ("..." lines mark an omission). A template change that the pages do not follow fails here.
const PAGES = ["tutorials/crud-api", "spring/postgresql-crud", "architecture/reference-crud", "architecture/java-microservice", "architecture/typescript-orchestrator"];
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const doc = (id: string) => readFileSync(resolve(import.meta.dirname, "..", "docs", id + ".md"), "utf8").replaceAll("\r\n", "\n");
const norm = (l: string) => l.trim().replace(/\s+/g, " ");

test("code shown on the CRUD and architecture pages is the generated code", { timeout: 120_000 }, async () => {
  const base = tmp("pso-doccode-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const ws = join(base, "shop");
  assert.equal((await pso(ws, "create", "service", "catalog")).code, 0);
  assert.equal((await pso(ws, "create", "orchestrator", "gateway")).code, 0);
  let checked = 0;
  const problems: string[] = [];
  for (const id of PAGES) {
    for (const m of doc(id).matchAll(/```[a-z]+ title="((?:catalog|gateway)\/[^" ]+)[^"]*"[^\n]*\n([\s\S]*?)\n```/g)) {
      const [, file, body] = m as unknown as [string, string, string];
      const path = join(ws, ...file.split("/"));
      if (!existsSync(path)) { problems.push(`${id}: ${file} is not a generated file`); continue; }
      const real = readFileSync(path, "utf8").replaceAll("\r\n", "\n").split("\n").map(norm);
      let at = 0;
      for (const line of body.split("\n").map(norm).filter((l) => l !== "" && l !== "..." && !/^\/\/ \.\.\.$/.test(l))) {
        const k = real.findIndex((l, i) => i >= at && l === line);
        if (k < 0) { problems.push(`${id}: ${file}: "${line}" is not in the generated file (or out of order)`); break; }
        at = k + 1;
      }
      checked++;
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 10, `checked ${checked} code blocks`);
});
