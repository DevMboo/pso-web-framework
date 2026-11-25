import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const doc = (id: string) => readFileSync(resolve(import.meta.dirname, "..", "docs", id + ".md"), "utf8").replaceAll("\r\n", "\n");
const blockAfter = (page: string, marker: string): string[] => {
  const i = page.indexOf(marker);
  assert.ok(i >= 0, `marker not found: ${marker}`);
  const start = page.indexOf("\n", page.indexOf("```", i)) + 1;
  return page.slice(start, page.indexOf("\n```", start)).split("\n");
};
/** the lines shown in a documented block must all appear, in order, in the real output */
function assertExcerpt(shown: string[], real: string, what: string) {
  const lines = real.split("\n").map((l) => l.trimEnd());
  let at = 0;
  for (const s of shown.filter((x) => x.trim() !== "")) {
    const k = lines.findIndex((l, idx) => idx >= at && l.replace(/\s+/g, " ") === s.trimEnd().replace(/\s+/g, " "));
    assert.ok(k >= 0, `${what}: the documented line is not in the real output (or out of order): "${s}"`);
    at = k + 1;
  }
}

/** Pages reviewed against the CLI: the documented output is an excerpt of what the commands print. */
test("routes:inspect and config:show print what the concept pages show", { timeout: 120_000 }, async () => {
  const base = tmp("pso-cliout-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const ws = join(base, "shop");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--template", "empty")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--template", "empty")).code, 0);
  assert.equal((await pso(ws, "make:resource", "product", "--service", "catalog", "--route", "/products", "--scopes", "products:read")).code, 0);

  const inspect = await pso(ws, "routes:inspect", "product.findAll");
  assert.equal(inspect.code, 0);
  assertExcerpt(blockAfter(doc("concepts/path-structure-working"), "`pso routes:inspect product.findAll` prints the whole chain"), inspect.out, "routes:inspect");

  const cfg = doc("concepts/configuration");
  const shown = await pso(ws, "config:show", "--service", "catalog");
  assertExcerpt(blockAfter(cfg, "`config:show` prints every effective value with its origin."), shown.out, "config:show");
  assert.match(shown.out, /security\.authentication\.maxTokenBytes\s+"\*\*\*REDACTED\*\*\*"/, "redaction goes by key name, even for a number");
  const overridden = await pso(ws, "config:show", "--service", "catalog", "--env", "production", "--set", "logging.level=debug");
  assert.ok(overridden.out.startsWith("# catalog (production)"));
  assertExcerpt(blockAfter(cfg, "pso config:show --service catalog --env production --set logging.level=debug"), overridden.out, "config:show --set");

  const policy = await pso(ws, "security:policy");
  assert.equal(policy.code, 0);
  const decl = doc("concepts/declarative-architecture");
  const at = decl.indexOf("```text evidence=\"verified\"\n$ pso security:policy");
  assert.ok(at >= 0, "the page shows the security:policy block as verified");
  const shownPolicy = decl.slice(decl.indexOf("\n", at + 3) + 1, decl.indexOf("\n```", at + 3)).split("\n").slice(1);
  assertExcerpt(shownPolicy, policy.out, "security:policy");

  // a later layer wins: --set beats an environment variable
  const prev = process.env["PSO_CFG_logging__level"];
  process.env["PSO_CFG_logging__level"] = "warn";
  try {
    const both = await pso(ws, "config:show", "--service", "catalog", "--set", "logging.level=debug");
    assert.match(both.out, /logging\.level\s+"debug"\s+<- cli/);
    const envOnly = await pso(ws, "config:show", "--service", "catalog");
    assert.match(envOnly.out, /logging\.level\s+"warn"\s+<- environment-variables/);
  } finally { if (prev === undefined) delete process.env["PSO_CFG_logging__level"]; else process.env["PSO_CFG_logging__level"] = prev; }
});
