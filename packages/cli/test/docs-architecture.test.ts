import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp } from "./helpers.ts";

// Evidence of the Verified blocks of the architecture pages and the first tutorial: the commands are run for real and the page must show
// exactly what they print (whole lines, in order).
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const doc = (id: string) => readFileSync(resolve(import.meta.dirname, "..", "docs", id + ".md"), "utf8").replaceAll("\r\n", "\n");
/** the Verified block of a page, as the lines of each `$ pso ...` transcript */
function transcripts(page: string): Map<string, string[]> {
  const at = page.indexOf('```text evidence="verified"');
  assert.ok(at >= 0, "the page has a Verified block");
  const start = page.indexOf("\n", at) + 1;
  const body = page.slice(start, page.indexOf("\n```", start)).split("\n");
  const out = new Map<string, string[]>();
  let cur: string[] | undefined;
  for (const l of body) {
    if (l.startsWith("$ pso ")) { cur = []; out.set(l.slice(6), cur); } else if (cur && l.trim() !== "") cur.push(l);
  }
  return out;
}
const norm = (l: string) => l.trimEnd().replace(/\s+/g, " ");
function sameLines(shown: string[], real: string, what: string) {
  assert.deepEqual(shown.map(norm), real.split("\n").map(norm).filter((l) => l !== ""), what);
}
const args = (cmd: string) => cmd.split(" ");

test("first application: validate, routes:list and routes:inspect print what the tutorial shows", { timeout: 120_000 }, async () => {
  const base = tmp("pso-docarch-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const ws = join(base, "shop");
  assert.equal((await pso(ws, "create", "service", "catalog")).code, 0);
  assert.equal((await pso(ws, "create", "orchestrator", "gateway")).code, 0);
  const blocks = transcripts(doc("tutorials/first-application"));
  assert.deepEqual([...blocks.keys()], ["validate", "routes:list", "routes:inspect /products"]);
  for (const [cmd, shown] of blocks) {
    const r = await pso(ws, ...args(cmd));
    assert.equal(r.code, 0, cmd);
    sameLines(shown, r.out, cmd);
  }
});

test("structure migration: structure:inspect prints the documented plan for a 0.1 orchestrator", { timeout: 120_000 }, async () => {
  const base = tmp("pso-docmig-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop", "--layout", "flat")).code, 0);
  const ws = join(base, "shop");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--structure", "legacy")).code, 0);
  assert.equal((await pso(ws, "make:resource", "product", "--service", "catalog", "--route", "/products", "--scopes", "products:read")).code, 0);
  const blocks = transcripts(doc("architecture/structure-migration"));
  assert.deepEqual([...blocks.keys()], ["structure:inspect --service gateway"]);
  const r = await pso(ws, "structure:inspect", "--service", "gateway");
  assert.equal(r.code, 0);
  sameLines(blocks.get("structure:inspect --service gateway")!, r.out, "structure:inspect");
});
