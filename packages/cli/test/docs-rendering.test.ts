import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { architecture, codeBlock, fileTree, flow } from "../src/portal/render.ts";
import { buildSite } from "../src/portal/build.ts";
import { ALL_COMMANDS } from "../src/registry.ts";

/**
 * Rendering standards of the documentation: one component per kind of representation (file tree, architecture, flow, command, output,
 * source), nothing hand-drawn. The source rules below fail on a manually formatted tree, an ASCII box or arrow diagram, an escaped
 * character or a visible entity in prose; they look only at fences that are NOT source code, so legitimate examples are untouched.
 */
const docs = resolve(import.meta.dirname, "..", "docs");
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".md") ? [f] : []; });
const lines = (f: string): string[] => readFileSync(f, "utf8").replaceAll("\r\n", "\n").split("\n");
const out = join(tmpdir(), `pso-docs-rendering-${process.pid}`);
after(() => { try { rmSync(out, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* temp */ } });

interface Fence { file: string; line: number; lang: string; info: string; body: string[] }
function fences(): Fence[] {
  const res: Fence[] = [];
  for (const f of walk(docs)) {
    let inF = false, cur: Fence | undefined;
    lines(f).forEach((l, i) => {
      const m = /^\s*(```+|~~~+)\s*([\w-]*)(.*)$/.exec(l);
      if (m) { if (!inF) { inF = true; cur = { file: relative(docs, f).replaceAll("\\", "/"), line: i + 1, lang: m[2] ?? "", info: m[3] ?? "", body: [] }; } else { inF = false; res.push(cur!); } }
      else if (inF) cur!.body.push(l);
    });
  }
  return res;
}
const PLAIN = /^(text|output|log|txt|diagram|)$/;
const BOX_DRAWING = /[├└┌┐┘┬┴┼│─╭╮╯╰▼▲►◄]/;
const ASCII_BOX = /^\s*\+[-=]{3,}\+?\s*$|^\s*\|.*\|\s*$/;
const PATHLIKE = /^\s*[\w.@<>-]+(\/[\w.@<>-]*)*\/\s*(#.*)?$|^\s+[\w.<>-]+\.(ts|tsx|java|json|ya?ml|md|sql|xml|sh)\b/;

test("source rules: no hand-drawn tree, box, arrow diagram or ```diagram fence in a block that is not source code", () => {
  const bad: string[] = [];
  for (const b of fences().filter((x) => PLAIN.test(x.lang))) {
    const where = `${b.file}:${b.line}`;
    if (b.lang === "diagram") bad.push(`${where}: a \`\`\`diagram fence: use \`\`\`architecture, \`\`\`flow or \`\`\`tree`);
    if (b.body.some((l) => BOX_DRAWING.test(l)) && !/\bascii="allowed"/.test(b.info)) bad.push(`${where}: box-drawing characters: use \`\`\`tree (files), \`\`\`architecture (components) or \`\`\`flow (paths)`);
    if (b.body.filter((l) => ASCII_BOX.test(l)).length >= 2) bad.push(`${where}: an ASCII box: use \`\`\`architecture`);
    if (b.body.filter((l) => PATHLIKE.test(l)).length >= 3) bad.push(`${where}: an indented list of paths: use \`\`\`tree`);
    const arrows = b.body.filter((l) => /(-->|──>|─▶|\s->\s)/.test(l) && !/^\s*(\$|GET|POST|PUT|PATCH|DELETE|HTTP\/)/.test(l) && !/\b[1-5]\d\d\b/.test(l) && !/\bPSO_[A-Z_]+\b/.test(l)).length;
    const transcript = b.body.some((l) => /^\$ \S/.test(l)); // a terminal session: the arrows are the program's own output
    if (arrows >= 2 && b.lang !== "output" && !transcript) bad.push(`${where}: arrows drawn in text: use \`\`\`flow or \`\`\`architecture`);
  }
  assert.deepEqual(bad, [], "use the documentation components (see 'Documentation components' in the contributor notes)");
});

test("source rules: no escaped backtick, visible entity or escaped Markdown character in prose (code fences and code spans are exempt)", () => {
  const bad: string[] = [];
  for (const f of walk(docs)) {
    let inF = false;
    lines(f).forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) { inF = !inF; return; }
      if (inF) return;
      const prose = l.replace(/`[^`]*`/g, "");
      if (/\\`/.test(l)) bad.push(`${relative(docs, f)}:${i + 1}: escaped backtick`);
      if (/&(amp|lt|gt|quot|nbsp|#\d+);/.test(prose)) bad.push(`${relative(docs, f)}:${i + 1}: visible entity`);
      if (/\\[_*]/.test(prose) && !/^\s*\|/.test(l)) bad.push(`${relative(docs, f)}:${i + 1}: escaped character`);
    });
  }
  assert.deepEqual(bad, []);
});

test("the file tree, architecture and flow components share one frame and escape everything", () => {
  const t = fileTree("app/\n  main.ts # generated: entry <script>alert(1)</script>", "Project");
  assert.match(t, /class="filetree"/); assert.doesNotMatch(t, /<script>/); assert.match(t, /&lt;script&gt;/);
  const a = architecture("internet (client)\n  gateway (orchestrator) # HTTPS | declared in `pso.workspace.json`\n    catalog (service) # forwards |", "Request path");
  assert.match(a, /class="filetree archtree"/); assert.match(a, /<span class="code-lang">Architecture<\/span>/); assert.match(a, /role="tree"/);
  assert.match(a, /<code>pso\.workspace\.json<\/code>/, "a code span in a note is code, not backticks");
  assert.equal((a.match(/class="ar-edge"/g) ?? []).length, 2, "relations from the parent are shown on the connectors");
  assert.match(a, /connects through <\/span>HTTPS/, "the relation is also available to assistive technology");
  assert.throws(() => architecture("x (spaceship)"), /unknown kind/);
  const f = flow("[request] a -> b | second line -> c # a note\n[forward] c -> d\n  -> e", "Path");
  assert.match(f, /class="filetree flowfig"/); assert.equal((f.match(/class="flow-step"/g) ?? []).length, 3 + 3, "a line starting with -> continues the previous path");
  assert.match(f, /<ol class="flow-steps" aria-label="request">/); assert.match(f, /class="flow-sub">second line/); assert.match(f, /flow-note">a note/);
  assert.throws(() => codeBlock("a -> b", "diagram"), /not a component/);
  assert.match(codeBlock("a -> b", "flow title=\"X\""), /flowfig/); assert.match(codeBlock("a (client)", "architecture"), /archtree/);
});

test("the generated site: the reported pages use the components, no page shows hand-drawn diagrams, raw backticks, entities or broken tables", () => {
  buildSite(out, ALL_COMMANDS, {});
  const html = (p: string): string => readFileSync(join(out, p), "utf8");
  const intro = html("getting-started/introduction.html");
  assert.match(intro, /class="filetree archtree"/); assert.doesNotMatch(intro, /k-diagram/); assert.doesNotMatch(intro, /[+]-{4,}[+]/);
  for (const n of ["internet", "gateway, the Node orchestrator", "catalog, Spring Boot", "orders, Spring Boot"]) assert.ok(intro.includes(`>${n}</span>`), n);
  assert.match(intro, /forwards, token checked again downstream/);
  const ov = html("frontend/overview.html");
  assert.match(ov, /class="filetree archtree"/); for (const n of ["Browser", "MEI customers", "MEI catalog", "MEI orders", "PSO API client", "PSO orchestrator", "services"]) assert.ok(ov.includes(n), n);
  assert.doesNotMatch(ov, /[├└│]/);
  assert.match(html("tutorials/first-application.html"), /class="filetree"/, "the reference page still uses the file tree");
  assert.match(html("orchestrator/architecture.html"), /class="filetree flowfig"/);

  const problems: string[] = [];
  const walkHtml = (d: string): string[] => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? (e === "assets" || e === "ai" ? [] : walkHtml(f)) : f.endsWith(".html") ? [f] : []; });
  for (const f of walkHtml(out)) {
    const rel = relative(out, f).replaceAll("\\", "/"); const h = readFileSync(f, "utf8");
    const main = /<main[\s\S]*<\/main>/.exec(h)?.[0] ?? h;
    const prose = main.replace(/<figure[\s\S]*?<\/figure>/g, "").replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<code[\s\S]*?<\/code>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
    const text = prose.replace(/<[^>]+>/g, " ");
    if (/(^|\s)`[^`\s][^`]{0,80}`(\s|$)/.test(text)) problems.push(`${rel}: literal backticks in prose`);
    if (/&amp;(lt|gt|amp|quot|nbsp);/.test(prose)) problems.push(`${rel}: double-escaped entity`);
    if (/\|\s*:?-{3,}:?\s*\|/.test(text)) problems.push(`${rel}: unrendered table`);
    if (/:::\w+|\[!(NOTE|TIP|WARNING|DANGER|STATUS)\]|\{\{\w+\}\}/.test(text)) problems.push(`${rel}: unrendered directive, alert or variable`);
    if (/<meta name="description" content="[^"]*`/.test(h)) problems.push(`${rel}: backticks in the meta description`);
    for (const fig of main.match(/<figure class="code[^"]*"[\s\S]*?<\/figure>/g) ?? []) {
      const body = fig.replace(/<[^>]+>/g, "");
      // real program output may contain drawing characters (a command that prints a tree); hand-drawn ones are caught in the sources
      if (/^\s*[+][-=]{3,}[+]?\s*$/m.test(body)) problems.push(`${rel}: an ASCII box in a code block`);
      if (/k-diagram/.test(fig)) problems.push(`${rel}: a raw diagram block`);
    }
    for (const t of main.match(/<table[\s\S]*?<\/table>/g) ?? []) {
      const counts = [...t.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => (r[0].match(/<t[hd][\s>]/g) ?? []).length);
      if (new Set(counts).size > 1) problems.push(`${rel}: a table whose rows have different cell counts (${counts.join(",")})`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(existsSync(join(out, "search-index.json")) || readdirSync(out).some((e) => /search/.test(e)), "the search index is still generated");
});

test("the stylesheet defines the architecture and flow components for both themes and narrow screens", () => {
  const css = readFileSync(resolve(import.meta.dirname, "..", "portal", "assets", "portal.css"), "utf8");
  for (const sel of [".archtree", ".ar-edge", ".ar-client", ".ar-orchestrator", ".ar-service", ".ar-database", ".flow-steps", ".flow-node", ".flow-arrow"]) assert.ok(css.includes(sel), sel);
  assert.match(css, /\.flow-steps \{[^}]*flex-wrap: wrap/, "flows wrap on narrow screens instead of overflowing");
  assert.doesNotMatch(css.slice(css.indexOf("architecture and flow components")), /#[0-9a-f]{3,6}\b/i, "colors come from the existing theme tokens, none are hard-coded");
});
