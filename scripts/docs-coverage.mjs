#!/usr/bin/env node
// Regenerates docs/implementation/documentation-coverage.md.
// The matrix records the REVIEW of each page, not its size or its headings: whether it was read against the implementation, what was found,
// and what backs its Verified output blocks (docs/implementation/evidence/registry.json). Word counts and section headings are deliberately not measured.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(repo, "packages/cli/docs");
const out = join(repo, "docs/implementation/documentation-coverage.md");
const registry = JSON.parse(readFileSync(join(repo, "docs/implementation/evidence/registry.json"), "utf8")).pages;

/** page -> review outcome. Edit this table when a page is reviewed; the log (page-review-log.md) holds the details. */
const CHANGED = {
  "decisions/gateway-or-service-validation": "added that message text is locale-dependent (clients rely on field and code); linked the end-to-end example",
  "decisions/why-routes-pso-mandatory": "added what validation reports; empty registry validates OK",
  "decisions/why-module-pso": "linked the reproduced PSO_MODULE_* diagnostics",
  "decisions/why-decorators": "removed an unsupported claim; added how decorators and registry are cross-checked",
  "decisions/why-deny-by-default": "qualified the guard claim; linked the reproduced start-up refusals",
  "decisions/why-no-code-execution-in-discovery": "replaced an unshown claim with its reproduction",
  "decisions/why-spring-independent": "removed an unreproducible test count",
  "decisions/pretty-or-json-logs": "added what `pso dev` does to colour and log files",
  "decisions/why-minimal-bootstrap": "corrected a caption that called Expected output verified",
  "decisions/why-dispatch-optional": "corrected a caption that called Expected output verified",
  "concepts/contracts": "removed an unsupported label in a title",
  "concepts/deterministic-manifests": "replaced guessed output with real output; determinism claims now tested",
  "concepts/structural-discovery": "replaced guessed `inspect` output with real output",
  "concepts/configuration": "output blocks proven by test; corrected a pointer to output that was not on the page",
  "concepts/path-structure-working": "output block proven by test",
  "concepts/security-by-default": "removed a duplicate of the diagnostics page; made the header claim precise",
  "concepts/module-composition": "replaced an unsupported label",
  "concepts/declarative-architecture": "output block proven by test",
  "spring/lombok": "real `make:service` output replaces an unsupported claim",
  "microservices/service-contracts": "real `make:resource` output and drift message",
  "reference/troubleshooting": "removed 12 unsupported claims; corrected PSO_ROUTE_007; stated which page owns what",
  "tutorials/production-deployment": "stated that `security:check` fails until JWT settings exist and that deploy needs a build",
  "tutorials/local-debugging": "404 row now distinguishes gateway from service answers",
  "architecture/manual-crud-0-1": "written and run end to end; variations executed",
  "spring/postgresql-crud": "example files moved to the layout `pso validate` accepts; locale note",
  "reference/diagnostics-catalog": "written from reproduced runs; every mistake is a test",
  "reference/startup-failures": "written from reproduced runs; every refusal is a test",
  "dispatch/diagnostics": "written from reproduced runs; broker connection checks are a test",
};
const NO_CHANGE = {
  "decisions/controller-or-service": "read against the generated controllers and the CRUD example; accurate",
  "decisions/why-cli-manages-infrastructure": "read against the CLI; accurate",
  "decisions/why-directory-conventions": "read against discovery; accurate",
  "decisions/why-no-typescript-outbox": "read; accurate and consistent with `dispatch:outbox`",
  "concepts/convention-over-configuration": "read; accurate (`{{facts}}` tables are generated from the sources)",
  "concepts/runtime-lifecycle": "read against `dev.ts` (5 s probe) and `close()`; accurate",
  "concepts/dependency-injection": "read against `runtime.ts`/`model.ts`; accurate",
  "spring/maven-bom": "read; accurate",
  "microservices/maven-dependencies": "read; accurate (release stages are labelled Expected)",
};
const CAPTIONS_ONLY = ["devops/build-and-deploy", "devops/distribution-and-installation", "devops/environment-configuration", "getting-started/first-orchestrator", "getting-started/first-workspace", "getting-started/philosophy", "microservices/security-integration", "orchestrator/routes"];

const walk = (d) => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".md") ? [f] : []; });
const rows = [];
for (const f of walk(docs).sort()) {
  const id = relative(docs, f).replace(/\\/g, "/").replace(/\.md$/, "");
  if (id.startsWith("ai-context/")) continue;
  const text = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const ev = { verified: 0, expected: 0, illustrative: 0 };
  for (const m of text.matchAll(/^```\S*[^\n]*evidence="(verified|expected|illustrative)"/gm)) ev[m[1]]++;
  const status = CHANGED[id] ? "reviewed, corrected" : NO_CHANGE[id] ? "reviewed, no change needed" : CAPTIONS_ONLY.includes(id) ? "evidence captions only" : "not reviewed";
  const backing = ev.verified ? (registry[id] ? [...new Set(registry[id].evidence.map((e) => e.kind))].join(", ") : "MISSING") : "no verified blocks";
  rows.push({ id, status, note: CHANGED[id] ?? NO_CHANGE[id] ?? "", ev, backing });
}
const count = (s) => rows.filter((r) => r.status === s).length;
let md = `# Documentation review matrix

Regenerated by \`node scripts/docs-coverage.mjs\`. It records **review**, not size: whether each page was read against the implementation, what was found, and what backs its Verified output blocks. Word counts and section headings are not measured, because neither says whether a page is right. Details and the exact queue are in [page-review-log.md](page-review-log.md); the previous matrices are in [documentation-coverage-history.md](documentation-coverage-history.md).

## Summary

| Review status | Pages |
|---|---:|
| reviewed, corrected | ${count("reviewed, corrected")} |
| reviewed, no change needed | ${count("reviewed, no change needed")} |
| evidence captions only (the page's Verified/Expected labelling was audited; the text was not otherwise reviewed) | ${count("evidence captions only")} |
| **not reviewed** | ${count("not reviewed")} |
| total (excluding 26 generated \`ai-context/\` fragments) | ${rows.length} |

Output blocks across all pages: ${rows.reduce((a, r) => a + r.ev.verified, 0)} verified, ${rows.reduce((a, r) => a + r.ev.expected, 0)} expected, ${rows.reduce((a, r) => a + r.ev.illustrative, 0)} illustrative. Every verified block is listed in [evidence/registry.json](evidence/registry.json) with the test, transcript, replay or demo script that backs it; \`docs-evidence.test.ts\` enforces that.

"Not reviewed" means exactly that: the page may be accurate, but nobody has compared it with the code in this campaign. Passing the mechanical checks (commands and flags exist, \`PSO_*\` codes exist, links resolve, languages are supported, output blocks are labelled) shows consistency with the code, not that an explanation is right.

## Pages

| Page | Review status | Result | Output V/E/I | What backs the verified blocks |
|---|---|---|---|---|
`;
for (const r of rows) md += `| ${r.id} | ${r.status} | ${r.note} | ${r.ev.verified}/${r.ev.expected}/${r.ev.illustrative} | ${r.backing} |\n`;
md += `
## Known limits of the evidence

- Dispatch: connection checks ran against Redis, RabbitMQ and Kafka; a publish-and-consume transcript exists for Redis only.
- The CRUD variations ran as tests; the pooled production datasource under an outage did not.
- The Windows uninstaller is blocked by the host's application-control policy.
- Runtime behaviours that look like defects are recorded in [runtime-defects.md](runtime-defects.md), not changed.
`;
writeFileSync(out, md);
console.log(JSON.stringify({ pages: rows.length, corrected: count("reviewed, corrected"), noChange: count("reviewed, no change needed"), captions: count("evidence captions only"), notReviewed: count("not reviewed") }));
writeFileSync(join(repo, "docs/implementation/review-queue.txt"), rows.filter((r) => r.status === "not reviewed").map((r) => r.id).join("\n") + "\n");
