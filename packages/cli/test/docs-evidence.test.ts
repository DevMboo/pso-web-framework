import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const docs = resolve(import.meta.dirname, "..", "docs");
const repo = resolve(import.meta.dirname, "..", "..", "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".md") ? [f] : []; });
const pages = () => walk(docs).map((f) => ({ id: relative(docs, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8").replaceAll("\r\n", "\n") })).filter((p) => !p.id.startsWith("ai-context/"));

test("every command, HTTP or output block carries an evidence label (verified, expected or illustrative)", () => {
  const missing: string[] = [];
  for (const p of pages()) {
    let open = false;
    for (const [i, line] of p.text.split("\n").entries()) {
      if (!line.startsWith("```")) continue;
      if (open) { open = false; continue; }
      open = true;
      if (/^```(text|http|console|output)\b/.test(line) && !/evidence="(verified|expected|illustrative)"/.test(line)) missing.push(`${p.id}:${i + 1}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every PSO_* diagnostic or problem code named in the documentation exists in the framework sources", () => {
  const corpus: string[] = [];
  const collect = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", "target", ".git", "docs"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) collect(p);
      else if (/\.(ts|java|yml|yaml|json)$/.test(e.name) && statSync(p).size < 2_000_000) corpus.push(readFileSync(p, "utf8"));
    }
  };
  for (const d of ["packages/core/src", "packages/http/src", "packages/security/src", "packages/dispatch/src", "packages/cli/src", "packages/cli/templates", "packages/frontend/src", "packages/infra/src", "pso-java"]) if (existsSync(join(repo, d))) collect(join(repo, d));
  const all = corpus.join("\n");
  const codes = new Set<string>();
  for (const p of pages()) for (const m of p.text.matchAll(/\bPSO_(?:MODULE|ROUTE|AUTH|HTTP|VALIDATION|DISPATCH|CONFIG|SEC|DTO|GUARD|RATE|TLS)_[A-Z0-9_]+\b/g)) codes.add(m[0]);
  assert.ok(codes.size > 20, `found ${codes.size} codes`);
  const unknown = [...codes].filter((c) => !all.includes(c) && !(c.startsWith("PSO_HTTP_ERROR_") && all.includes("PSO_HTTP_ERROR")));
  assert.deepEqual(unknown, []);
});

test("every Verified block is backed by reproducible evidence recorded in docs/implementation/evidence/registry.json", () => {
  const registry = JSON.parse(readFileSync(join(repo, "docs/implementation/evidence/registry.json"), "utf8")) as { pages: Record<string, { verified: number; evidence: Array<{ kind: string; artifact: string }> }> };
  const counts: Record<string, number> = {};
  for (const p of pages()) {
    let open = false;
    for (const line of p.text.split("\n")) {
      if (!line.startsWith("```")) continue;
      if (open) { open = false; continue; }
      open = true;
      if (/evidence="verified"/.test(line)) { const k = p.id.replace(/.md$/, ""); counts[k] = (counts[k] ?? 0) + 1; }
    }
  }
  const problems: string[] = [];
  for (const [id, n] of Object.entries(counts)) {
    const e = registry.pages[id];
    if (!e) { problems.push(`${id}: ${n} Verified block(s) with no evidence entry (add evidence, or label them Expected)`); continue; }
    if (e.verified !== n) problems.push(`${id}: ${n} Verified blocks but the registry covers ${e.verified}`);
    if (e.evidence.length === 0) problems.push(`${id}: empty evidence list`);
    for (const ev of e.evidence) {
      if (!["test", "transcript", "replay", "demo-script"].includes(ev.kind)) problems.push(`${id}: unknown evidence kind ${ev.kind}`);
      const target = ev.artifact.includes("*") ? undefined : join(repo, ev.artifact);
      if (target !== undefined && !existsSync(target)) problems.push(`${id}: evidence file missing: ${ev.artifact}`);
    }
  }
  for (const id of Object.keys(registry.pages)) if (!counts[id]) problems.push(`${id}: in the registry but has no Verified block`);
  assert.deepEqual(problems, []);
});

test("a caption next to an Expected or Illustrative block never calls it verified", () => {
  const bad: string[] = [];
  for (const p of pages()) {
    const L = p.text.split("\n");
    let open = false, start = -1;
    for (let i = 0; i < L.length; i++) {
      if (!L[i]!.startsWith("```")) continue;
      if (!open) { open = true; start = i; continue; }
      open = false;
      if (!/evidence="(expected|illustrative)"/.test(L[start]!)) continue;
      for (let k = i + 1, c = 0; k < L.length && c < 2; k++) {
        if (!L[k]!.trim()) continue;
        c++;
        if (L[k]!.startsWith("```") || L[k]!.startsWith("#")) break;
        if (/\bverified\b|real output/i.test(L[k]!)) bad.push(`${p.id}:${k + 1}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("an HTTP example that shows a correlation id in the header and in the body shows the same id (one exchange, one id)", () => {
  const bad: string[] = [];
  for (const p of pages()) {
    for (const m of p.text.matchAll(/```http[^\n]*\n([\s\S]*?)\n```/g)) {
      const header = /^x-correlation-id: (\S+)/im.exec(m[1]!)?.[1];
      const body = /"correlationId":"([^"]+)"/.exec(m[1]!)?.[1];
      if (header && body && header !== body) bad.push(`${p.id}: header ${header} but body ${body}`);
    }
  }
  assert.deepEqual(bad, []);
});
