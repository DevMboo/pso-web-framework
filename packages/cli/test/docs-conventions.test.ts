import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NODE_MODULAR_CONVENTION, SPRING_LAYERED_CONVENTION, type KindSpec } from "@pso/core";

// The directory tables of the official structures (pages and AI context) are the conventions @pso/core enforces, row for row.
const doc = (id: string) => readFileSync(resolve(import.meta.dirname, "..", "docs", id + ".md"), "utf8").replaceAll("\r\n", "\n");
const pat = (k: KindSpec) => (k.exact ? k.suffix : `*${k.suffix}`);
const dirs = (root: string, k: KindSpec) => (k.paths ?? [k.dir]).map((p) => `\`${root}/${p.replace(/\/\*\*$/, "/...").replace(/\*/g, "<module>")}/\``).join(", ");
const rows = (c: { kinds: KindSpec[] }, root: string) => c.kinds.map((k) => `| ${k.kind} | ${dirs(root, k)} | \`${pat(k)}\` |`);

test("the official directory tables in the documentation and the AI context match the enforced conventions", () => {
  for (const id of ["ai-context/scopes/orchestrator", "concepts/convention-over-configuration"]) for (const r of rows(NODE_MODULAR_CONVENTION, "src")) assert.ok(doc(id).includes(r), `${id}: ${r}`);
  for (const id of ["ai-context/scopes/microservices", "concepts/convention-over-configuration", "microservices/project-structure"]) for (const r of rows(SPRING_LAYERED_CONVENTION, "<package>")) assert.ok(doc(id).includes(r), `${id}: ${r}`);
  for (const id of ["ai-context/scopes/orchestrator", "ai-context/scopes/microservices", "concepts/convention-over-configuration", "microservices/project-structure"]) assert.doesNotMatch(doc(id), /\{\{facts:conventions/, `${id} renders the official tables, not the 0.1 conventions`);
});
