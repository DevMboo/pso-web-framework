import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as http from "@pso/http";
import { SCHEMA, LAYERS, ENVIRONMENTS } from "@pso/core";
import type { Command } from "../commands.ts";
import { NOT_IMPLEMENTED } from "../unimplemented.ts";
import { API_DOCS, FORMAT_HEADERS, BLOCK_END, BLOCK_START, buildScopes, composeContext, estimateTokens, expandFacts, resolveSelection, wrapFormat, type AiMeta, type Scope } from "./ai.ts";
import { CLI_NOTES } from "./cli-notes.ts";
import { CLI_VERSION, DOCS_ROOT, PORTAL_ASSETS, SECTIONS, loadWrittenPages, slugify, sortPages, type DocPage } from "./content.ts";
import { DIAGRAMS, renderDiagram } from "./diagrams.ts";
import { codeBlock, esc, renderMarkdown, type RenderContext } from "./render.ts";
import { spriteFor, usedIcons } from "./icons.ts";
import { homeHtml, pageHtml, type SiteVersion } from "./template.ts";

export class PortalError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`documentation build failed:\n - ${problems.join("\n - ")}`); this.problems = problems; }
}

const cliSlug = (name: string) => name.replace(/:/g, "-");

/**
 * Diagnostic codes for the reference. A distribution ships them as `diagnostic-codes.json`, generated at build time by `scripts/gen-diagnostic-codes.mjs`
 * from the compiled sources (so the reference cannot drift from the implementation). A protected build collapses the compiled sources into one
 * minified file, where a scan cannot work and where module names would disclose internal structure, so the data file is the source of truth there.
 * Without it (a framework checkout that has not been built) the compiled sources are scanned.
 */
export function diagnosticCodes(): Array<{ code: string; message: string; where: string }> {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "diagnostic-codes.json");
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as { schema: number; codes: Array<{ code: string; message: string }> };
      if (j.schema === 1 && Array.isArray(j.codes) && j.codes.length > 0) return j.codes.map((c) => ({ code: c.code, message: c.message, where: "" }));
    } catch { /* fall through to the scan */ }
  }
  return scanDiagnosticCodes();
}

/** Scans the compiled framework sources for diagnostic codes (the generator's input; also the fallback in a checkout). */
export function scanDiagnosticCodes(): Array<{ code: string; message: string; where: string }> {
  const out = new Map<string, { code: string; message: string; where: string }>();
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [join(here, "..", "..", "..", "core", "dist"), join(here, "..", "..", "dist")];
  const literal = /(`[^`]*`|"[^"]*")/.source;
  const forms = [new RegExp(`"(PSO_[A-Z_0-9]+)",\\s*${literal}`, "g"), new RegExp(`code: "(PSO_[A-Z_0-9]+)",\\s*severity: "[a-z]+",\\s*message: ${literal}`, "g")];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!n.endsWith(".js")) continue;
      const text = readFileSync(p, "utf8");
      for (const m of forms.flatMap((re) => [...text.matchAll(re)])) {
        if (!out.has(m[1]!)) out.set(m[1]!, { code: m[1]!, message: m[2]!.slice(1, -1).replace(/\$\{[^}]*\}/g, "…").split("\\n")[0]!, where: n.replace(/\.js$/, "") });
      }
    }
  };
  roots.forEach(walk);
  return [...out.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
}

const flagsOf = (usage: string): string[] => [...new Set([...usage.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))];

function generatedPages(commands: Record<string, Command>): DocPage[] {
  const gen = (id: string, title: string, description: string, markdown: string, order: number, extra: Partial<DocPage> = {}): DocPage => ({ id, section: id.split("/")[0]!, title, description, order, status: "implemented", keywords: [], related: [], prerequisites: [], markdown, generated: true, ...extra });
  const names = Object.keys(commands).sort();
  const pages: DocPage[] = [];
  pages.push(gen("cli/index", "CLI overview", "Every implemented pso command, with usage, flags, examples and failure cases.", [
    "The `pso` CLI is how you create, validate, run, secure, build and document a PSO workspace. This reference is generated from the command registry of the installed CLI, so every command listed here exists and nothing else does.", "",
    "Start with [the CLI workflow](/cli/workflow) to see which commands write files, which inspect declarations, and which contact running processes. Return to a command page for its exact usage and failure cases.", "",
    "> [!TIP]", "> Every command supports `--help`. Most support `--json` for machine output, and every command that writes files supports `--dry-run`.", "",
    "## Exit codes", "", "| Code | Meaning |", "|---|---|", "| 0 | Success |", "| 1 | The command ran and failed: validation errors, conflicts, a refused unsafe request |", "| 2 | Unknown command, or a command from the specification that is not implemented |", "| 3 | Explicit authorization required (`--yes`) for `deploy` or `rollback` |", "| 70 | Internal error |", "",
    "## Commands", "", "| Command | Summary |", "|---|---|", ...names.map((n) => `| [\`pso ${n}\`](/cli/${cliSlug(n)}) | ${(CLI_NOTES[n]?.summary ?? commands[n]!.summary).replace(/\|/g, "\\|")} |`), "",
    "## Not implemented", "", `These exist in the specification but exit with code 2 in this version: ${NOT_IMPLEMENTED.map((c) => `\`pso ${c}\``).join(", ")}. See [Event dispatch](/dispatch/overview).`,
  ].join("\n"), 0));
  for (const [i, n] of names.entries()) {
    const c = commands[n]!, note = CLI_NOTES[n] ?? CLI_NOTES[n.split(":")[0]!];
    const flags = flagsOf(c.usage);
    const summary = note?.summary ?? c.summary;
    const md = [
      summary + ".", "", "## Usage", "", "```text", c.usage.replace(/\s+/g, " ").trim(), "```", "",
      ...(flags.length ? ["## Flags", "", ...(note?.flags ? ["| Flag | What it does |", "|---|---|", ...flags.map((f) => `| \`${f}\` | ${note.flags?.[f] ?? "See the usage line and the task guide for this option."} |`)] : [flags.map((f) => `\`${f}\``).join(", ") + "."]), ""] : []),
      "## Examples", "", "```bash", ...(note?.examples.length ? note.examples : [`pso ${n} --help`]), "```", "",
      ...(note?.effects?.length ? ["## What it changes", "", ...note.effects.map((x) => `- ${x}`), ""] : []),
      ...(note?.output ? ["## Illustrative output", "", "This sample shows the shape of the result. Names, ports, digests and timings may differ in your workspace.", "", "```text evidence=\"illustrative\"", note.output, "```", ""] : []),
      ...(note?.checks?.length ? ["## Verify the result", "", ...note.checks.map((x) => `- ${x}`), ""] : []),
      ...(note?.failures?.length ? ["## Failure cases", "", ...note.failures.map((f) => `- ${f}`), ""] : []),
      "## Exit codes", "", "`0` on success, `1` when the command ran and failed. See the [exit code table](/cli/index#exit-codes).", "",
      ...(note?.see?.length ? ["## See also", "", ...note.see.map((s) => `- [${s}](/${s})`), ""] : []),
    ].join("\n");
    pages.push(gen(`cli/${cliSlug(n)}`, `pso ${n}`, summary, md, 10 + i, { keywords: [n, ...flags] }));
  }
  const codes = diagnosticCodes();
  pages.push(gen("reference/diagnostics", "Diagnostics reference", "Stable diagnostic codes raised by PSO, extracted from the compiled sources.", ["Every diagnostic has a stable code. `pso validate` prints them with the file; the orchestrator logs them at start-up and refuses to start when any is an error.", "", ...codes.flatMap((c) => [`### ${c.code}`, "", `${c.message}`, "", ...(c.where ? [`Raised in \`${c.where}\`.`, ""] : [""])])].join("\n"), 30, { keywords: codes.map((c) => c.code) }));
  pages.push(gen("reference/config", "Configuration reference", "Typed configuration keys, defaults and constraints.", [`Layers, lowest to highest precedence: ${LAYERS.join(", ")}. Environments: ${ENVIRONMENTS.join(", ")}. See [Configuration resolution](/concepts/configuration).`, "", ...Object.entries(SCHEMA).flatMap(([k, s]) => [`### ${k}`, "", `Type \`${s.kind}\`${s.default !== undefined ? `, default \`${JSON.stringify(s.default)}\`` : ""}${s.enum ? `, one of ${s.enum.join(", ")}` : ""}${s.min !== undefined ? `, min ${s.min}` : ""}${s.max !== undefined ? `, max ${s.max}` : ""}.`, ""])].join("\n"), 20, { keywords: Object.keys(SCHEMA) }));
  pages.push(gen("reference/decorators", "Decorators and API reference", "The decorators and functions of @pso/http and @pso/core with exact semantics.", ["Decorators describe code; they never expose an endpoint. Exposure is decided by `ROUTES.pso.ts` (see [Routing](/orchestrator/routes)).", "", ...Object.entries(API_DOCS).flatMap(([k, d]) => [`### ${k}`, "", d, ""])].join("\n"), 10, { keywords: Object.keys(API_DOCS) }));
  return pages;
}

export function collectPages(commands: Record<string, Command>): DocPage[] {
  const all = [...loadWrittenPages(), ...generatedPages(commands)];
  const ids = new Set<string>();
  const dups = all.filter((p) => (ids.has(p.id) ? true : (ids.add(p.id), false)));
  if (dups.length) throw new PortalError(dups.map((d) => `duplicate page id ${d.id}`));
  return sortPages(all);
}

export function aiMeta(commands: Record<string, Command>, pages: DocPage[]): AiMeta {
  return { version: CLI_VERSION, commands, pages, apiNames: Object.keys(http), diagnostics: diagnosticCodes().map(({ code, message }) => ({ code, message })) };
}

/** Plain Markdown of a page for LLM consumption: variables, facts and directives expanded; links point at .md files. */
export function plainMarkdown(page: DocPage, meta: AiMeta): string {
  let md = expandFacts(page.markdown.replace(/\{\{version\}\}/g, meta.version), meta);
  const assetRoot = "../".repeat(page.id.split("/").length);
  md = md.replace(/^:::include\s+(.*)$/gm, (_m, a: string) => { const f = /file="([^"]+)"/.exec(a)![1]!; return "```" + (f.split(".").pop() ?? "") + "\n// " + f.replace(/^examples\//, "") + "\n" + readFileSync(join(DOCS_ROOT, f), "utf8").trimEnd() + "\n```"; });
  md = md.replace(/^:::diagram\s+name="([^"]+)"\s*$/gm, (_m, n: string) => { const d = DIAGRAMS[n]!; return `**${d.title}.** ${d.summary}\n\n${d.nodes.map((x, i) => `${i + 1}. **${x.label}**${x.sub ? ` (${x.sub})` : ""}: ${x.detail}`).join("\n")}`; });
  md = md.replace(/^:::ai-builder.*$/gm, "");
  md = md.replace(/\]\(\/([a-z0-9\-/]+)(#[^)]*)?\)/g, (_m, id: string, a?: string) => `](${id}.md${a ?? ""})`).replace(/\]\(@\/([^)]+)\)/g, (_m, asset: string) => `](${assetRoot}${asset})`);
  const status = page.status === "implemented" ? "" : `> Status: ${page.status === "planned" ? "NOT IMPLEMENTED in this version — do not use or generate code for it." : "PARTIALLY implemented — read the limitations."}\n\n`;
  return `# ${page.title}\n\n${page.description ? `> ${page.description}\n\n` : ""}${status}${md.replace(/^#\s+.*\n+/, "").trim()}\n`;
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const write = (root: string, rel: string, data: string | Buffer, files: string[]) => { const p = join(root, ...rel.split("/")); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); files.push(rel); };

function readVersions(): SiteVersion[] {
  const f = join(DOCS_ROOT, "versions.json");
  const listed = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Array<{ version: string }>).map((v) => v.version) : [CLI_VERSION];
  const set = [...new Set([CLI_VERSION, ...listed])];
  return set.map((v) => ({ version: v, current: v === CLI_VERSION, label: `v${v}` }));
}

export interface BuildResult { files: string[]; pages: string[]; version: string }

export function buildSite(outDir: string, commands: Record<string, Command>, opts: { repository?: string } = {}): BuildResult {
  const pages = collectPages(commands);
  const meta = aiMeta(commands, pages);
  const ids = new Set(pages.map((p) => p.id));
  const problems: string[] = [];
  const files: string[] = [];
  const versions = readVersions();
  const rendered = new Map<string, ReturnType<typeof renderMarkdown>>();
  const assetLinks: Array<{ page: string; asset: string }> = [];
  const vars = { version: CLI_VERSION, cliVersion: CLI_VERSION };

  const ctxFor = (p: DocPage): RenderContext => {
    const root = "../".repeat(p.id.split("/").length - 1);
    return {
      pageId: p.id, root, vars,
      include: (f) => { const abs = resolve(DOCS_ROOT, f); if (!abs.startsWith(resolve(DOCS_ROOT) + sep) || !existsSync(abs)) throw new Error(`${p.id}: include "${f}" not found`); return readFileSync(abs, "utf8"); },
      href: (t, a) => { if (!ids.has(t)) { problems.push(`${p.id}: link to unknown page "/${t}"`); return "#"; } return `${root}${t}.html${a ? `#${a}` : ""}`; },
    };
  };

  // 1. render every page (the facts in scope pages are expanded first so AI pages show exactly what assistants receive)
  for (const p of pages) {
    try {
      const md = expandFacts(p.markdown, meta);
      const r = renderMarkdown(md, ctxFor(p));
      rendered.set(p.id, r);
      for (const a of r.assets) assetLinks.push({ page: p.id, asset: a });
    } catch (e) { problems.push(`${p.id}: ${(e as Error).message}`); }
  }
  for (const p of pages) for (const rid of p.related) if (!ids.has(rid)) problems.push(`${p.id}: related page "${rid}" does not exist`);
  // 2. anchors must exist
  for (const p of pages) for (const l of rendered.get(p.id)?.links ?? []) {
    if (l.anchor && ids.has(l.target) && !rendered.get(l.target)?.headings.some((h) => h.id === l.anchor)) problems.push(`${p.id}: link to /${l.target}#${l.anchor} but that heading does not exist`);
  }
  if (problems.length) throw new PortalError(problems);

  // 3. HTML
  const bySection = (id: string) => pages.filter((x) => x.section === id);
  const htmlPages: Array<{ rel: string; html: string }> = [];
  for (const p of pages) {
    const r = rendered.get(p.id)!;
    const sib = bySection(p.section).filter((x) => !(x.id.startsWith("ai-context/scopes/")) || p.id.startsWith("ai-context/scopes/"));
    const i = sib.findIndex((x) => x.id === p.id);
    const html = pageHtml({ page: p, bodyHtml: r.html, headings: r.headings, root: "../".repeat(p.id.split("/").length - 1), pages, version: CLI_VERSION, versions, ...(opts.repository ? { repository: opts.repository } : {}),
      relatedPages: p.related.map((id) => pages.find((x) => x.id === id)).filter((x): x is DocPage => !!x), ...(sib[i - 1] ? { prev: sib[i - 1]! } : {}), ...(sib[i + 1] ? { next: sib[i + 1]! } : {}) });
    htmlPages.push({ rel: `${p.id}.html`, html });
  }
  const homeCode = codeBlock(`import "reflect-metadata";\nimport { bootstrap } from "@pso/http";\n\nbootstrap({ appDir: __dirname });`, "ts", { title: "src/main.ts" });
  htmlPages.push({ rel: "index.html", html: homeHtml({ root: "", version: CLI_VERSION, versions, ...(opts.repository ? { repository: opts.repository } : {}), pages, codeHtml: homeCode, diagrams: { discovery: renderDiagram("discovery"), lifecycle: renderDiagram("lifecycle"), distributed: renderDiagram("distributed") } }) });
  const sprite = spriteFor([...usedIcons(), ...SECTIONS.map((s) => s.icon), "search", "menu", "sun", "moon", "chevron-right", "copy", "check", "arrow-left", "arrow-right", "bot", "download", "x", "circle-check", "circle-dashed", "info", "lightbulb", "triangle-alert", "octagon-alert", "git-branch", "rocket", "layers", "terminal", "blocks", "shield-check", "network", "workflow", "container"]);
  for (const h of htmlPages) write(outDir, h.rel, h.html.replace("__SPRITE__", sprite), files);

  // 4. assets, favicon, JS data
  const copyAssets = (dir: string, rel = "") => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const asset = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) copyAssets(path, asset);
      else write(outDir, !rel && /^favicon/.test(name) ? name : `assets/${asset}`, readFileSync(path), files);
    }
  };
  copyAssets(PORTAL_ASSETS);
  const scopes = buildScopes(meta);
  const aiData = { version: CLI_VERSION, method: "characters/4 (heuristic estimate, not a tokenizer count)", blockStart: BLOCK_START("{version}"), blockEnd: BLOCK_END, headers: FORMAT_HEADERS, scopes: scopes.map((s) => ({ id: s.id, title: s.title, description: s.description, base: s.base, requires: s.requires, body: s.body, tokens: estimateTokens(s.body) })), order: scopes.map((s) => s.id) };
  write(outDir, "ai-data.js", `window.PSO_AI=${JSON.stringify(aiData)};\n`, files);

  const entries: Array<Record<string, unknown>> = [];
  const secTitle = (id: string) => SECTIONS.find((s) => s.id === id)?.title ?? id;
  for (const p of pages) { const r = rendered.get(p.id)!; entries.push({ k: p.generated && p.section === "cli" ? "Command" : p.section === "reference" ? "Reference" : "Guide", t: p.title, s: secTitle(p.section), u: `${p.id}.html`, d: p.description, h: r.headings.map((h) => [h.text, h.id]), x: r.text.slice(0, 2500), w: p.keywords.join(" "), st: p.status }); }
  for (const [n, c] of Object.entries(commands)) entries.push({ k: "Command", t: `pso ${n}`, s: "CLI Reference", u: `cli/${cliSlug(n)}.html`, d: CLI_NOTES[n]?.summary ?? c.summary, h: [], x: c.usage, w: n });
  for (const [n, d] of Object.entries(API_DOCS)) entries.push({ k: "Decorator", t: n, s: "Reference", u: `reference/decorators.html#${slugify(n)}`, d, h: [], x: "", w: "decorator api" });
  for (const c of diagnosticCodes()) entries.push({ k: "Error code", t: c.code, s: "Diagnostics", u: `reference/diagnostics.html#${slugify(c.code)}`, d: c.message, h: [], x: "", w: "error diagnostic" });
  for (const [k, s] of Object.entries(SCHEMA)) entries.push({ k: "Configuration", t: k, s: "Configuration", u: `reference/config.html#${slugify(k)}`, d: `${s.kind}${s.default !== undefined ? `, default ${JSON.stringify(s.default)}` : ""}`, h: [], x: "", w: "config option" });
  write(outDir, "search-index.js", `window.PSO_SEARCH=${JSON.stringify(entries)};\n`, files);

  // 5. LLM-friendly artifacts (generated from the same sources)
  const real = pages.filter((p) => !p.scope);
  for (const p of pages) write(outDir, `md/${p.id}.md`, plainMarkdown(p, meta), files);
  const lines = [`# PSO Web`, "", `> PSO Web Framework ${CLI_VERSION}: build distributed applications through structure, conventions and declarative contracts (Node.js + TypeScript orchestrator, Spring Boot microservices).`, "", `Version: ${CLI_VERSION}. Features marked "not implemented" in a page are design notes, not available functionality.`, ""];
  for (const s of SECTIONS) { const ps = real.filter((p) => p.section === s.id); if (!ps.length) continue; lines.push(`## ${s.title}`, "", ...ps.map((p) => `- [${p.title}](md/${p.id}.md)${p.description ? `: ${p.description}` : ""}${p.status === "planned" ? " (NOT IMPLEMENTED)" : ""}`), ""); }
  lines.push("## AI context", "", ...[["complete", "Complete context"], ...scopes.filter((s) => s.id !== "core").map((s) => [s.id, s.title])].map(([id, t]) => `- [${t}](ai/${id}.md)`), "- [Manifest with versions and checksums](ai/manifest.json)", "", "## Optional", "", "- [Full documentation in one file](llms-full.txt)", "");
  write(outDir, "llms.txt", lines.join("\n"), files);
  write(outDir, "llms-full.txt", [`# PSO Web ${CLI_VERSION} — full documentation`, "", ...real.map((p) => plainMarkdown(p, meta)), ""].join("\n---\n\n"), files);

  const aiFiles: Array<{ file: string; sha256: string; scopes: string[] }> = [];
  const aiOut = (rel: string, text: string, sc: string[]) => { write(outDir, rel, text, files); aiFiles.push({ file: rel, sha256: sha(text), scopes: sc }); };
  const complete = composeContext(resolveSelection(scopes, "complete"), meta);
  aiOut("ai/complete.md", complete, resolveSelection(scopes, "complete").map((s) => s.id));
  for (const s of scopes.filter((x) => x.id !== "core")) { const sel = resolveSelection(scopes, [s.id]); aiOut(`ai/${s.id}.md`, composeContext(sel, meta), sel.map((x) => x.id)); }
  aiOut("ai/AGENTS.md", wrapFormat("agents", complete, CLI_VERSION, ["complete"]), ["complete"]);
  aiOut("ai/CLAUDE.md", wrapFormat("claude", complete, CLI_VERSION, ["complete"]), ["complete"]);
  aiOut("ai/copilot-instructions.md", wrapFormat("copilot", complete, CLI_VERSION, ["complete"]), ["complete"]);
  write(outDir, "ai/manifest.json", JSON.stringify({ name: "pso-ai-context", version: CLI_VERSION, tokenEstimate: "characters/4 heuristic", files: aiFiles }, null, 2) + "\n", files);
  write(outDir, "version.json", JSON.stringify({ name: "pso-web-docs", version: CLI_VERSION, versions: versions.map((v) => v.version) }) + "\n", files);

  // 6. artifacts linked from pages must exist
  const missing = assetLinks.filter((a) => !files.includes(a.asset)).map((a) => `${a.page}: links to missing artifact @/${a.asset}`);
  if (missing.length) throw new PortalError(missing);
  return { files, pages: pages.map((p) => p.id), version: CLI_VERSION };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

/** Static server for a built site. Loopback only, GET only, Host-checked (DNS-rebinding), path-contained. */
export async function serveSite(dir: string, port = 0): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const base = resolve(dir);
  let bound = port;
  const server: Server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) { res.writeHead(403).end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
    let path: string;
    try { path = decodeURIComponent(new URL(req.url ?? "/", `http://${host}`).pathname); } catch { res.writeHead(400).end(); return; }
    if (path === "/__pso/version") { res.writeHead(200, { "content-type": TYPES[".json"]!, "cache-control": "no-store" }).end(JSON.stringify({ version: CLI_VERSION })); return; }
    if (path.endsWith("/")) path += "index.html";
    const abs = normalize(join(base, path));
    if (abs !== base && !abs.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    if (!existsSync(abs) || !statSync(abs).isFile()) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[abs.slice(abs.lastIndexOf("."))] ?? "application/octet-stream", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    if (req.method === "HEAD") { res.end(); return; }
    // A page served by `pso docs` says so. The page then asks this server for the installed CLI version (to warn about a mismatch);
    // the same files on plain static hosting carry no marker and make no such request, so they never log a failed request (F-29).
    if (abs.endsWith(".html")) res.end(readFileSync(abs, "utf8").replace("<head>", () => '<head><meta name="pso-docs-server" content="pso-cli">'));
    else res.end(readFileSync(abs));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  bound = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${bound}/`, port: bound, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export { esc, copyFileSync };
