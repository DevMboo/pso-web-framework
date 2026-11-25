import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A guard against shallow documentation. It does not judge quality (that takes a reader); it fails when a page is thin or has no section about
 * what can go wrong, so a page cannot silently regress to "a snippet and a sentence". Pages that are generated or intentionally terse are listed
 * with the reason.
 */
const docs = resolve(import.meta.dirname, "..", "docs");
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".md") ? [f] : []; });
const EXEMPT = new Map<string, string>([]);
const FAILURE_HEADING = /^##+ .*(mistake|anti-pattern|troubleshoot|limit|not provided|not implemented|cost|diagnos|recover|failure|go wrong|revisit|what you will see|what is not|fix|wrong)/im;
const VERIFICATION_LABELS = /\*\(?(verified|expected|illustrative)|\bverified\b|\bexpected\b|\billustrative\b/i;

const pages = walk(docs).map((f) => ({ id: relative(docs, f).replace(/\\/g, "/").replace(/\.md$/, ""), text: readFileSync(f, "utf8") })).filter((p) => !p.id.startsWith("ai-context/") && !EXEMPT.has(p.id));
const bodyOf = (t: string): string => t.replace(/^---[\s\S]*?---/, "");

test(`every documentation page has real substance (at least 250 words of body text)`, () => {
  const thin = pages.map((p) => ({ id: p.id, words: bodyOf(p.text).split(/\s+/).filter(Boolean).length })).filter((p) => p.words < 250);
  assert.deepEqual(thin, [], "thin pages");
});

test("every documentation page says what can go wrong: mistakes, anti-patterns, troubleshooting, costs or limits", () => {
  const missing = pages.filter((p) => !FAILURE_HEADING.test(bodyOf(p.text))).map((p) => p.id);
  assert.deepEqual(missing, [], "pages without a failure/limits section");
});

test("pages that show command or HTTP output say whether it is verified, expected or illustrative", () => {
  // a page with a transcript of a pso command must label its provenance somewhere (one label is enough; the per-block labels are editorial)
  const unlabeled = pages.filter((p) => /^\$ pso /m.test(bodyOf(p.text)) && !VERIFICATION_LABELS.test(bodyOf(p.text))).map((p) => p.id);
  assert.deepEqual(unlabeled, [], "transcripts without any provenance label");
});

test("no page claims a capability is missing that the code now has (guard for known stale claims)", () => {
  const stale: Array<[RegExp, string]> = [
    [/shared observability starter[^.\n]*not implemented/i, "observability starter exists"],
    [/mutual TLS[^.\n]*not implemented/i, "mTLS exists for outbound calls (inbound termination is the exception: say so precisely)"],
    [/Dispatch provider starters are not implemented/i, "provider starters exist"],
    [/a client-supplied `?x-correlation-id`? is (never trusted|dropped)/i, "a well-formed correlation id is accepted"],
    [/DTO classes do not validate on their own/i, "@Body(Dto) validates"],
  ];
  const hits: string[] = [];
  for (const p of pages) for (const [re, why] of stale) if (re.test(p.text)) hits.push(`${p.id}: ${why}`);
  assert.deepEqual(hits, []);
});
