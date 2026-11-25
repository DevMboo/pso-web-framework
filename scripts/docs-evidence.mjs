#!/usr/bin/env node
// Documentation evidence audit.
//   node scripts/docs-evidence.mjs audit    - classify every Verified block (replay of commands, demo transcripts, committed run transcripts, tests); prints the result
//   node scripts/docs-evidence.mjs apply    - downgrade Verified blocks that have no reproducible evidence to Expected, and write docs/implementation/evidence/registry.json
// A "Verified" block must be backed by evidence that can be re-checked: a test that asserts it, a transcript committed under docs/implementation/evidence, a demo script whose fresh output
// contains it, or a replay of its command in a disposable workspace. A prose label ("verified output") is not evidence.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(repo, "packages/cli/docs");
const evDir = join(repo, "docs/implementation/evidence");
const cli = join(repo, "packages/cli/bin/pso.js");
const mode = process.argv[2] ?? "audit";
const walk = (d) => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".md") ? [f] : []; });
const pagesList = () => walk(docs).map((f) => ({ f, id: relative(docs, f).replace(/\\/g, "/").replace(/\.md$/, "") })).filter((p) => !p.id.startsWith("ai-context/"));

/** every Verified block: page, 1-based line of its fence, body lines, and the lead-in lines before it */
function verifiedBlocks() {
  const out = [];
  for (const p of pagesList()) {
    const L = readFileSync(p.f, "utf8").replace(/\r\n/g, "\n").split("\n");
    let open = false;
    for (let i = 0; i < L.length; i++) {
      if (!L[i].startsWith("```")) continue;
      if (open) { open = false; continue; }
      open = true;
      if (!/evidence="verified"/.test(L[i])) continue;
      const body = []; for (let k = i + 1; k < L.length && !L[k].startsWith("```"); k++) body.push(L[k]);
      out.push({ id: p.id, file: p.f, line: i + 1, body });
    }
  }
  return out;
}
const norm = (l) => l.replace(/\r/g, "").replace(/\d{4}-\d\d-\d\d[ T][\d:.]+(Z|-\d\d:\d\d)?/g, "TS").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID").replace(/[0-9a-f]{12,}/g, "HEX").replace(/k-\d{8}-[0-9a-f]{8}/g, "KID").replace(/\[?\d+(\.\d+)? ?ms\]?/g, "N ms").replace(/"ms":[\d.]+/g, '"ms":N').replace(/\s+/g, " ").trim();

// pages whose Verified blocks are asserted by a committed test, or are taken from committed transcripts of real runs made for them
const PAGE_EVIDENCE = {
  "architecture/structure-migration": [["test", "packages/cli/test/docs-architecture.test.ts"]],
  "architecture/reference-crud": [["transcript", "docs/implementation/evidence/v020/crud-http-examples.json"]],
  "tutorials/first-application": [["test", "packages/cli/test/docs-architecture.test.ts"]],
  "tutorials/authentication": [["transcript", "docs/implementation/evidence/v020/crud-http-examples.json"]],
  "reference/diagnostics-catalog": [["test", "packages/cli/test/docs-diagnostics.test.ts"], ["transcript", "docs/implementation/evidence/diagnostics-lab.txt"]],
  "decisions/why-no-code-execution-in-discovery": [["test", "packages/cli/test/docs-diagnostics.test.ts"]],
  "concepts/deterministic-manifests": [["test", "packages/cli/test/docs-discovery.test.ts"]],
  "concepts/structural-discovery": [["test", "packages/cli/test/docs-discovery.test.ts"]],
  "microservices/service-contracts": [["test", "packages/cli/test/docs-contracts.test.ts"]],
  "spring/lombok": [["test", "packages/cli/test/docs-contracts.test.ts"]],
  "concepts/path-structure-working": [["test", "packages/cli/test/docs-cli-output.test.ts"]],
  "concepts/configuration": [["test", "packages/cli/test/docs-cli-output.test.ts"]],
  "concepts/declarative-architecture": [["test", "packages/cli/test/docs-cli-output.test.ts"]],
  "tutorials/event-driven": [["test", "packages/cli/test/docs-event-driven.test.ts"], ["transcript", "docs/implementation/evidence/event-driven-transcript.txt"]],
  "reference/startup-failures": [["test", "packages/cli/test/docs-startup.test.ts"]],
  "dispatch/diagnostics": [["test", "packages/cli/test/docs-dispatch.test.ts"], ["transcript", "docs/implementation/evidence/dispatch-lab.txt"]],
  "architecture/manual-crud-0-1": [["transcript", "docs/implementation/evidence/crud-transcript.txt"], ["transcript", "docs/implementation/evidence/crud-extensions-gateway-transcript.txt"], ["transcript", "docs/implementation/evidence/crud-extensions-maven-transcript.txt"], ["transcript", "docs/implementation/evidence/crud-outage-maven-transcript.txt"], ["transcript", "docs/implementation/evidence/crud-catalog-startup.log"], ["transcript", "docs/implementation/evidence/crud-401-gateway.log"], ["test", "packages/cli/test/spring-crud-example.test.ts"], ["test", "packages/cli/test/spring-crud-extensions.test.ts"], ["test", "packages/cli/test/docs-quality.test.ts"]],
};

function replayCorpus() {
  const base = mkdtempSync(join(tmpdir(), "pso-evidence-"));
  const run = (cwd, ...a) => { const r = spawnSync(process.execPath, [cli, ...a], { cwd, encoding: "utf8", timeout: 90_000 }); return (r.stdout + r.stderr).replace(/\(node:\d+\)[^\n]*\n?(\(Use[^\n]*\n?)?/g, ""); };
  const corpus = new Set();
  const feed = (t) => t.split("\n").forEach((l) => { const n = norm(l); if (n) corpus.add(n); });
  feed(run(base, "create", "workspace", "shop")); const ws = join(base, "shop");
  feed(run(ws, "create", "orchestrator", "gateway")); feed(run(ws, "create", "service", "catalog"));
  feed(run(base, "create", "workspace", "my-platform"));
  feed(run(ws, "security:keys", "--generate"));
  const SKIP = /^(pso (uninstall|setup|update|integrity|dist|repair)|npm|\.\/mvnw|docker|node|curl|git)/;
  const cmds = new Set();
  for (const b of verifiedBlocks()) for (const l of b.body) { const m = /^\$ (pso .+?)(\s+#.*)?$/.exec(l); if (m) cmds.add(m[1]); }
  for (const c of cmds) {
    if (SKIP.test(c)) continue;
    const args = c.replace(/^pso /, "").split(/\s+/).filter(Boolean).map((a) => a.replace(/^"|"$/g, ""));
    if (args.some((a) => /[<>]/.test(a))) continue;
    feed(run(ws, ...args));
  }
  for (const a of [["validate"], ["routes:list"], ["doctor"], ["services:list"], ["services:graph"], ["security:policy"], ["security:check"]]) feed(run(ws, ...a));
  return corpus;
}

function classify() {
  const blocks = verifiedBlocks();
  const replay = replayCorpus();
  const demo = existsSync(evDir) ? readdirSync(evDir).filter((f) => /^demo-.*\.txt$/.test(f)).map((f) => readFileSync(join(evDir, f), "utf8").split("\n").map(norm).join("\n")).join("\n") : "";
  const results = [];
  for (const b of blocks) {
    const lines = b.body.map((l) => l.replace(/^\$ .*$/, "")).map(norm).filter(Boolean);
    const rr = lines.length ? lines.filter((l) => replay.has(l)).length / lines.length : 0;
    const dd = lines.length ? lines.filter((l) => l.length > 20 && demo.includes(l)).length / Math.max(1, lines.filter((l) => l.length > 20).length) : 0;
    let kind = null, artifact = null;
    if (PAGE_EVIDENCE[b.id]) { kind = "page-evidence"; }
    else if (rr >= 0.95) { kind = "replay"; artifact = "scripts/docs-evidence.mjs"; }
    else if (dd >= 0.6) { kind = "demo-script"; artifact = "docs/implementation/evidence/demo-*.txt"; }
    results.push({ ...b, kind, artifact, replay: +rr.toFixed(2), demo: +dd.toFixed(2) });
  }
  return results;
}

const results = classify();
const kept = results.filter((r) => r.kind), dropped = results.filter((r) => !r.kind);
console.log(`Verified blocks: ${results.length}; with reproducible evidence: ${kept.length}; without: ${dropped.length}`);
const byKind = {}; for (const r of kept) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
console.log(JSON.stringify(byKind));
if (mode === "audit") { console.log("WITHOUT EVIDENCE:\n" + dropped.map((r) => `${r.id}:${r.line}`).join("\n")); process.exit(0); }

// apply: downgrade the unsupported blocks to Expected and fix the lead-in wording
const byFile = new Map();
for (const r of dropped) (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)).push(r);
for (const [file, rs] of byFile) {
  const raw = readFileSync(file, "utf8"); const crlf = raw.includes("\r\n");
  const L = raw.replace(/\r\n/g, "\n").split("\n");
  for (const r of rs) {
    const i = r.line - 1;
    L[i] = L[i].replace('evidence="verified"', 'evidence="expected"');
    for (let k = i - 1, n = 0; k >= 0 && n < 3; k--) {
      if (!L[k].trim()) continue; n++;
      L[k] = L[k].replace(/[Rr]eal output \(verified\)/g, "Expected output").replace(/[Vv]erified output/g, "Expected output").replace(/\(verified[^)]*\)/g, "(expected)").replace(/\bverified\b/g, "expected").replace(/[Rr]eal output/g, "Expected output");
    }
  }
  writeFileSync(file, L.join(crlf ? "\r\n" : "\n"));
}
const registry = {};
for (const r of kept) {
  const e = (registry[r.id] ??= { verified: 0, evidence: [] });
  e.verified++;
  const add = r.kind === "page-evidence" ? PAGE_EVIDENCE[r.id] : [[r.kind, r.artifact]];
  for (const [k, a] of add) if (!e.evidence.some((x) => x.kind === k && x.artifact === a)) e.evidence.push({ kind: k, artifact: a });
}
writeFileSync(join(evDir, "registry.json"), JSON.stringify({ generatedBy: "scripts/docs-evidence.mjs apply", note: "Every Verified block of a page must be backed by the listed evidence. Adding a Verified block requires evidence and an update of this file.", pages: registry }, null, 1) + "\n");
console.log("downgraded", dropped.length, "blocks to Expected; registry written");
