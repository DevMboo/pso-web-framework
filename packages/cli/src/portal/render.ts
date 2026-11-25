import { Marked, type Tokens, type TokensList } from "marked";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import java from "highlight.js/lib/languages/java";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import markdown from "highlight.js/lib/languages/markdown";
import ini from "highlight.js/lib/languages/ini";
import http from "highlight.js/lib/languages/http";
import { renderDiagram } from "./diagrams.ts";
import { slugify } from "./content.ts";
import { useIcon } from "./icons.ts";

for (const [n, l] of Object.entries({ typescript, javascript, java, bash, powershell, json, yaml, xml, sql, dockerfile, markdown, ini, http })) hljs.registerLanguage(n, l);
const ALIAS: Record<string, string> = { tsx: "typescript", jsx: "javascript", ts: "typescript", js: "javascript", sh: "bash", shell: "bash", ps1: "powershell", pwsh: "powershell", yml: "yaml", html: "xml", md: "markdown", properties: "ini", "pso-example": "bash", console: "bash", env: "ini", dotenv: "ini", pom: "xml", mjs: "javascript", cjs: "javascript" };
const LABEL: Record<string, string> = { typescript: "TypeScript", javascript: "JavaScript", java: "Java", bash: "Shell", powershell: "PowerShell", json: "JSON", yaml: "YAML", xml: "XML", sql: "SQL", dockerfile: "Dockerfile", markdown: "Markdown", ini: "Properties", http: "HTTP", text: "Text" };

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Splits highlight.js output into lines, closing and re-opening spans at line breaks. */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let cur = "", last = 0, m: RegExpExecArray | null;
  const re = /(<span[^>]*>|<\/span>|\n)/g;
  while ((m = re.exec(html))) {
    cur += html.slice(last, m.index);
    last = re.lastIndex;
    const t = m[0];
    if (t === "\n") { cur += "</span>".repeat(stack.length); lines.push(cur); cur = stack.join(""); }
    else if (t === "</span>") { stack.pop(); cur += t; }
    else { stack.push(t); cur += t; }
  }
  lines.push(cur + html.slice(last));
  return lines;
}

interface Info { lang: string; title?: string; highlight: Set<number>; tab?: string; group?: string; evidence?: string }
function parseInfo(info: string): Info {
  const m = /^(\S*)\s*(.*)$/.exec(info.trim())!;
  const lang = m[1] ?? "";
  const rest = m[2] ?? "";
  const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(rest)?.[1];
  const hl = new Set<number>();
  const spec = /\{([\d,\s-]+)\}/.exec(rest)?.[1];
  if (spec) for (const part of spec.split(",")) { const [a, b] = part.trim().split("-").map(Number); if (a) for (let i = a; i <= (b ?? a); i++) hl.add(i); }
  const out: Info = { lang, highlight: hl };
  const title = attr("title"), tab = attr("tab"), group = attr("group"), evidence = attr("evidence");
  if (evidence) out.evidence = evidence;
  if (title) out.title = title;
  if (tab) out.tab = tab;
  if (group) out.group = group;
  return out;
}

const EVIDENCE: Record<string, string> = { verified: "Verified output", expected: "Expected output", illustrative: "Illustrative" };
const OUTPUT_LANGS = new Set(["text", "output", "log", "jsonl", "txt", ""]);
const HTTP_REQUEST = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+/;

/** What a block is: a command to type, program output, an HTTP exchange, or source/configuration. Each kind is presented differently. */
export type BlockKind = "command" | "diagram" | "output" | "http-request" | "http-response" | "source";
export function classify(lang: string, body: string): BlockKind {
  if (lang === "bash" || lang === "powershell") return "command";
  if (lang === "diagram") return "diagram";
  if (lang === "http" || OUTPUT_LANGS.has(lang)) {
    const first = body.trimStart();
    if (/^HTTP\/\d/.test(first)) return "http-response";
    if (HTTP_REQUEST.test(first)) return "http-request";
    if (lang === "http") return "http-response";
    return "output";
  }
  return "source";
}
const KIND_LABEL: Record<BlockKind, string> = { command: "Terminal", diagram: "Diagram", output: "Output", "http-request": "HTTP request", "http-response": "HTTP response", source: "" };

/** Marks which lines of a command block start a command (they get a prompt); continuation lines and comments do not. */
function commandStarts(lines: string[], lang: string): boolean[] {
  let continued = false;
  const cont = lang === "powershell" ? /`\s*$/ : /\\\s*$/;
  return lines.map((l) => {
    const t = l.trim();
    const start = !continued && t !== "" && !t.startsWith("#");
    continued = t !== "" && cont.test(t);
    return start;
  });
}

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
function logLevel(line: string): { level: LogLevel; start: number; length: number } | undefined {
  const json = /"level"\s*:\s*"(fatal|error|warn|warning|info|debug|trace)"/i.exec(line);
  const token = json ?? /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/.exec(line);
  if (!token) return undefined;
  const raw = token[1]!;
  const level = raw.toLowerCase().replace("warning", "warn") as LogLevel;
  return { level, start: token.index + token[0].indexOf(raw), length: raw.length };
}

export function codeBlock(code: string, infoStr: string, extra: { title?: string } = {}): string {
  const info = parseInfo(infoStr);
  let lang = ALIAS[info.lang] ?? info.lang;
  if (lang === "tree") return fileTree(code, extra.title ?? info.title);
  if (lang === "architecture") return architecture(code, extra.title ?? info.title);
  if (lang === "flow") return flow(code, extra.title ?? info.title);
  if (lang === "diagram") throw new Error("a ```diagram fence is not a component: use ```architecture (who talks to whom, as a connected hierarchy), ```flow (an ordered execution path) or ```tree (files), or `:::diagram name=...` for the built-in interactive diagrams");
  const body = code.replace(/\n$/, "");
  const kind = classify(lang, body);
  if (kind === "http-request" || kind === "http-response") lang = "http";
  const known = kind !== "output" && kind !== "diagram" && hljs.getLanguage(lang) !== undefined;
  const raw = body.split("\n");
  const lines = known ? splitHighlighted(hljs.highlight(body, { language: lang, ignoreIllegals: true }).value) : raw.map(esc);
  const langLabel = LABEL[known ? lang : "text"] ?? lang;
  const label = kind === "source" ? langLabel : kind === "command" ? "Terminal · " + langLabel : kind === "output" && (lang === "log" || lang === "jsonl") ? "Log output" : KIND_LABEL[kind];
  const title = extra.title ?? info.title;
  const starts = kind === "command" ? commandStarts(raw, lang) : [];
  const html = lines.map((l, i) => {
    const severity = kind === "output" ? logLevel(raw[i]!) : undefined;
    const content = severity ? esc(raw[i]!.slice(0, severity.start)) + `<span class="log-level log-level-${severity.level}">` + esc(raw[i]!.slice(severity.start, severity.start + severity.length)) + "</span>" + esc(raw[i]!.slice(severity.start + severity.length)) : l;
    return '<span class="line' + (info.highlight.has(i + 1) ? " hl" : "") + (starts[i] ? " cmd" : "") + (severity ? ` log-${severity.level}` : "") + '">' + (content || " ") + "</span>";
  }).join("");
  const evidence = info.evidence !== undefined && EVIDENCE[info.evidence] ? '<span class="code-evidence ev-' + info.evidence + '">' + EVIDENCE[info.evidence] + "</span>" : "";
  const shell = lang === "powershell" ? " ps" : lang === "log" || lang === "jsonl" ? " log" : "";
  return '<figure class="code k-' + kind + shell + '"><figcaption>' + (title ? '<span class="code-file">' + esc(title) + "</span>" : "") + evidence + '<span class="code-lang">' + esc(label) + '</span><button class="copy" type="button" aria-label="Copy ' + (kind === "command" ? "command" : "code") + (title ? " of " + esc(title) : "") + '" data-code="' + esc(body) + '">' + useIcon("copy") + '<span class="copy-label">Copy</span></button></figcaption><pre tabindex="0" aria-label="' + esc((title ?? label) + (kind === "output" ? " (program output, not a command)" : "")) + '"><code class="hljs language-' + esc(known ? lang : "text") + '">' + html + "</code></pre></figure>";
}

type FileKind = "dir" | "ts" | "java" | "json" | "yaml" | "sql" | "xml" | "md" | "sh" | "docker" | "env" | "other";
const FILE_KINDS: Array<[RegExp, FileKind, string]> = [
  [/\.tsx?$|\.mts$|\.cts$/i, "ts", "TS"], [/\.java$/i, "java", "JV"], [/\.jsonc?$/i, "json", "{}"], [/\.ya?ml$/i, "yaml", "YML"], [/\.sql$/i, "sql", "SQL"],
  [/\.xml$/i, "xml", "XML"], [/\.md$/i, "md", "MD"], [/\.(sh|ps1|cmd|bat)$|^mvnw$/i, "sh", "SH"], [/^dockerfile(\..*)?$/i, "docker", "DKR"],
  [/^\.env(\..*)?$|\.env$|\.properties$|\.pem$|\.key$/i, "env", "ENV"],
];
const FILE_KIND_NAME: Record<FileKind, string> = { dir: "folder", ts: "TypeScript file", java: "Java file", json: "JSON file", yaml: "YAML file", sql: "SQL file", xml: "XML file", md: "Markdown file", sh: "shell script", docker: "Dockerfile", env: "environment or key file", other: "file" };
const ORIGIN: Record<string, string> = { generated: "Generated", manual: "You create", optional: "Optional", env: "Per environment", changed: "You change" };

interface TreeNode { name: string; note: string; origin: string; children: TreeNode[]; dir: boolean }
/** Renders an indented listing as an accessible tree. Indent with two spaces; a trailing "/" marks a folder; "# generated: text" (or manual, optional, env, changed) adds a badge and a note. */
export function fileTree(src: string, title?: string): string {
  const root: TreeNode = { name: "", note: "", origin: "", children: [], dir: true };
  const stack: Array<{ depth: number; node: TreeNode }> = [{ depth: -1, node: root }];
  for (const rawLine of src.replace(/\n$/, "").split("\n")) {
    if (rawLine.trim() === "") continue;
    const indent = /^ */.exec(rawLine)![0].length;
    const depth = Math.floor(indent / 2);
    const m = /^(.*?)(?:\s+#\s+(.*))?$/.exec(rawLine.trim())!;
    const name = m[1]!.trim();
    let note = m[2] ?? "", origin = "";
    const o = /^(generated|manual|optional|env|changed):\s*(.*)$/.exec(note) ?? /^(generated|manual|optional|env|changed)$/.exec(note);
    if (o) { origin = o[1]!; note = o[2] ?? ""; }
    const node: TreeNode = { name: name.replace(/\/$/, ""), note, origin, children: [], dir: name.endsWith("/") };
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ depth, node });
  }
  const kindOf = (n: TreeNode): [FileKind, string] => {
    if (n.dir || n.children.length) return ["dir", ""];
    const base = n.name.split("/").pop()!;
    for (const [re, k, tag] of FILE_KINDS) if (re.test(base)) return [k, tag];
    return ["other", ""];
  };
  const item = (n: TreeNode): string => {
    const [k, tag] = kindOf(n);
    const dir = k === "dir";
    const badge = n.origin ? '<span class="ft-origin o-' + n.origin + '">' + ORIGIN[n.origin] + "</span>" : "";
    const label = '<span class="ft-label"><span class="ft-ico ft-' + k + '" aria-hidden="true">' + (dir ? useIcon("folder") : tag || useIcon("file")) + '</span><span class="visually-hidden">' + FILE_KIND_NAME[k] + ' </span><span class="ft-name">' + esc(n.name) + (dir ? "/" : "") + "</span>" + badge + "</span>" + (n.note ? '<span class="ft-note">' + noteHtml(n.note) + "</span>" : "");
    const kids = n.children.length ? '<ul role="group">' + n.children.map(item).join("") + "</ul>" : "";
    return '<li role="treeitem" aria-expanded="' + (dir ? "true" : "false") + '">' + label + kids + "</li>";
  };
  const t = title ?? "Project structure";
  return '<figure class="filetree"><figcaption><span class="code-file">' + esc(t) + '</span><span class="code-lang">File tree</span></figcaption><div class="ft-scroll" tabindex="0" role="region" aria-label="' + esc(t) + '"><ul role="tree" aria-label="' + esc(t) + '">' + root.children.map(item).join("") + "</ul></div></figure>";
}

/** Notes are plain text that may contain `code spans`. */
const noteHtml = (t: string): string => esc(t).replace(/`([^`\n]+)`/g, "<code>$1</code>");

// ---- architecture and flow: the same visual language as the file tree (frame, connector lines, icon chips, notes), for components and paths -----

const ARCH_KINDS: Record<string, { icon: string; label: string }> = {
  client: { icon: "monitor", label: "Client" }, shell: { icon: "panels-top-left", label: "Application shell" }, microfrontend: { icon: "puzzle", label: "Microfrontend" },
  library: { icon: "package", label: "Library" }, proxy: { icon: "network", label: "Proxy" }, orchestrator: { icon: "server-cog", label: "Orchestrator" },
  service: { icon: "server", label: "Service" }, database: { icon: "database", label: "Database" }, broker: { icon: "radio-tower", label: "Broker" }, security: { icon: "shield-check", label: "Security" },
};
interface ArchNode { name: string; kind: string; relation: string; note: string; children: ArchNode[] }
/**
 * Renders a connected hierarchy of components. Indent with two spaces: a child is something its parent calls or contains.
 * `Name (kind) # relation | description` — the kind picks the icon (client, shell, microfrontend, library, proxy, orchestrator, service,
 * database, broker, security; default service); the text before `|` after `#` labels the connection from the parent (shown on the connector),
 * the text after it describes the component. `# description` alone is a description. Several top-level nodes are allowed.
 */
export function architecture(src: string, title?: string): string {
  const root: ArchNode = { name: "", kind: "", relation: "", note: "", children: [] };
  const stack: Array<{ depth: number; node: ArchNode }> = [{ depth: -1, node: root }];
  for (const rawLine of src.replace(/\n$/, "").split("\n")) {
    if (rawLine.trim() === "") continue;
    const depth = Math.floor(/^ */.exec(rawLine)![0].length / 2);
    const m = /^(.*?)(?:\s+#\s+(.*))?$/.exec(rawLine.trim())!;
    const k = /^(.*?)\s*\((\w+)\)$/.exec(m[1]!.trim());
    const kind = k ? k[2]! : "service";
    if (!ARCH_KINDS[kind]) throw new Error(`architecture: unknown kind "${kind}" (one of ${Object.keys(ARCH_KINDS).join(", ")})`);
    const text = m[2] ?? "";
    const bar = /\s\|(\s|$)/.exec(text);
    const relation = bar ? text.slice(0, bar.index).trim() : "", note = bar ? text.slice(bar.index + bar[0].length).trim() : text.trim();
    const node: ArchNode = { name: (k ? k[1]! : m[1]!).trim(), kind, relation, note, children: [] };
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ depth, node });
  }
  const item = (n: ArchNode): string => {
    const kd = ARCH_KINDS[n.kind]!;
    const edge = n.relation ? '<span class="ar-edge">' + useIcon("arrow-right") + '<span class="visually-hidden">connects through </span>' + esc(n.relation) + "</span>" : "";
    const label = '<span class="ft-label">' + edge + '<span class="ft-ico ar-' + n.kind + '" aria-hidden="true">' + useIcon(kd.icon) + '</span><span class="visually-hidden">' + kd.label + ' </span><span class="ft-name ar-name">' + esc(n.name) + "</span></span>" + (n.note ? '<span class="ft-note">' + noteHtml(n.note) + "</span>" : "");
    return '<li role="treeitem" aria-expanded="true">' + label + (n.children.length ? '<ul role="group">' + n.children.map(item).join("") + "</ul>" : "") + "</li>";
  };
  const t = title ?? "Architecture";
  return '<figure class="filetree archtree"><figcaption><span class="code-file">' + esc(t) + '</span><span class="code-lang">Architecture</span></figcaption><div class="ft-scroll" tabindex="0" role="region" aria-label="' + esc(t) + '"><ul role="tree" aria-label="' + esc(t) + '">' + root.children.map(item).join("") + "</ul></div></figure>";
}

/**
 * Renders ordered paths. One line is one path; steps are separated by `->`; a step may have a second line of text after `|`;
 * `[Name]` at the start of a line names the path; `# text` at the end adds a note under it. A line that starts with `->` continues the
 * previous path. Steps wrap on narrow screens; the order is always exposed to assistive technology as a list.
 */
export function flow(src: string, title?: string): string {
  const lanes: Array<{ name: string; steps: Array<{ label: string; sub: string }>; note: string }> = [];
  for (const raw of src.replace(/\n$/, "").split("\n")) {
    const line = raw.trim(); if (line === "") continue;
    const m = /^(?:\[([^\]]+)\]\s*)?(.*?)(?:\s+#\s+(.*))?$/.exec(line)!;
    const body = m[2]!;
    const cont = body.startsWith("->") && lanes.length > 0 && !m[1];
    const parts = body.replace(/^->\s*/, "").split(/\s+->\s+|\s*->\s+/).map((p) => p.trim()).filter(Boolean);
    const steps = parts.map((p) => { const [l, s] = p.split(/\s+\|\s+/, 2); return { label: (l ?? "").trim(), sub: (s ?? "").trim() }; });
    if (cont) { const last = lanes[lanes.length - 1]!; last.steps.push(...steps); if (m[3]) last.note = last.note ? last.note + " " + m[3] : m[3]; }
    else lanes.push({ name: m[1] ?? "", steps, note: m[3] ?? "" });
  }
  const t = title ?? "Flow";
  const lane = (l: (typeof lanes)[number], i: number): string => '<li class="flow-lane">' + (l.name ? '<span class="flow-name">' + esc(l.name) + "</span>" : "") + '<ol class="flow-steps" aria-label="' + esc(l.name || `${t}, path ${i + 1}`) + '">' + l.steps.map((s, j) => '<li class="flow-step">' + (j > 0 ? '<span class="flow-arrow" aria-hidden="true">' + useIcon("arrow-right") + "</span>" : "") + '<span class="flow-node"><span class="flow-label">' + esc(s.label) + "</span>" + (s.sub ? '<span class="flow-sub">' + noteHtml(s.sub) + "</span>" : "") + "</span></li>").join("") + "</ol>" + (l.note ? '<span class="ft-note flow-note">' + noteHtml(l.note) + "</span>" : "") + "</li>";
  return '<figure class="filetree flowfig"><figcaption><span class="code-file">' + esc(t) + '</span><span class="code-lang">Flow</span></figcaption><div class="ft-scroll" tabindex="0" role="region" aria-label="' + esc(t) + '"><ul class="flow-lanes">' + lanes.map(lane).join("") + "</ul></div></figure>";
}

const ALERTS: Record<string, { title: string; icon: string; cls: string }> = {
  NOTE: { title: "Note", icon: "info", cls: "note" }, TIP: { title: "Tip", icon: "lightbulb", cls: "tip" },
  WARNING: { title: "Warning", icon: "triangle-alert", cls: "warning" }, DANGER: { title: "Danger", icon: "octagon-alert", cls: "danger" },
  STATUS: { title: "Status", icon: "circle-dashed", cls: "status" },
};

export interface RenderContext {
  pageId: string;
  /** reads docs/examples/<file> */
  include(file: string): string;
  /** relative href from this page to a doc id (throws on unknown ids) */
  href(targetId: string, anchor?: string): string;
  /** relative prefix from this page to the site root ("", "../", ...) */
  root: string;
  vars: Record<string, string>;
}
export interface Rendered { assets: string[]; html: string; headings: Array<{ depth: number; id: string; text: string }>; links: Array<{ target: string; anchor?: string }>; text: string }

export function renderMarkdown(source: string, ctx: RenderContext): Rendered {
  const md = source.replace(/\{\{(\w+)\}\}/g, (m, k: string) => ctx.vars[k] ?? m);
  const headings: Rendered["headings"] = [];
  const links: Rendered["links"] = [];
  const assets: string[] = [];
  const seen = new Map<string, number>();
  const m = new Marked({ gfm: true });

  m.use({
    extensions: [{ name: "pso", renderer: (t) => (t as unknown as { html: string }).html }],
    renderer: {
      html({ text }) { return esc(text); }, // raw HTML in documentation is never passed through
      heading({ tokens, depth }) {
        const inline = this.parser.parseInline(tokens);
        const text = inline.replace(/<[^>]+>/g, "");
        let id = slugify(text) || "section";
        const n = seen.get(id) ?? 0; seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth >= 2 && depth <= 3) headings.push({ depth, id, text: text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"') });
        return `<h${depth} id="${id}">${inline}${depth >= 2 ? `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ""}</h${depth}>`;
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        if (href.startsWith("/")) {
          const [target, anchor] = href.slice(1).split("#") as [string, string | undefined];
          links.push({ target, ...(anchor ? { anchor } : {}) });
          return `<a href="${esc(ctx.href(target, anchor))}">${text}</a>`;
        }
        if (/^https?:\/\//.test(href)) return `<a href="${esc(href)}" rel="noopener noreferrer">${text}</a>`;
        if (href.startsWith("@/")) { assets.push(href.slice(2)); return `<a href="${esc(ctx.root + href.slice(2))}">${text}</a>`; }
        if (href.startsWith("#")) return `<a href="${esc(href)}">${text}</a>`;
        throw new Error(`${ctx.pageId}: unsupported link "${href}" (use /section/page for internal links)`);
      },
      image({ href, text, title }) {
        if (!href.startsWith("@/assets/") || !/\.(?:png|jpe?g|webp|svg)$/i.test(href)) {
          throw new Error(`${ctx.pageId}: unsupported image "${href}" (use @/assets/... for local images)`);
        }
        if (!text.trim()) throw new Error(`${ctx.pageId}: image "${href}" needs descriptive alt text`);
        assets.push(href.slice(2));
        return `<img src="${esc(ctx.root + href.slice(2))}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy" decoding="async">`;
      },
      code({ text, lang }) { return codeBlock(text, lang ?? ""); },
      table(token: Tokens.Table) {
        const head = token.header.map((c) => `<th${c.align ? ` align="${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("");
        const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");
        return `<div class="table-scroll" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
      },
    },
  });

  const tokens = m.lexer(md) as TokensList;
  const out: unknown[] = [];
  const pso = (html: string, raw: string) => ({ type: "pso", raw, html });
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "paragraph" && t.text.startsWith(":::")) {
      const dm = /^:::([\w-]+)\s*(.*)$/.exec(t.text)!;
      const attrs = Object.fromEntries([...dm[2]!.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!]));
      if (dm[1] === "diagram") out.push(pso(renderDiagram(attrs["name"]!), t.raw));
      else if (dm[1] === "ai-builder") out.push(pso(`<div id="ai-builder" class="ai-builder" data-ai-builder><p class="muted">The context builder needs JavaScript. Without it, use the ready-made files: <a href="${ctx.root}ai/complete.md">complete context</a>, <a href="${ctx.root}llms-full.txt">llms-full.txt</a>.</p></div>`, t.raw));
      else if (dm[1] === "include") { const f = attrs["file"]!; out.push(pso(codeBlock(ctx.include(f), f.split(".").pop() ?? "", { title: attrs["title"] ?? f.replace(/^examples\//, "") }), t.raw)); }
      else if (dm[1] === "download-button") {
        const url = attrs["url"] ?? "";
        const label = attrs["label"] ?? "";
        if (!/^https:\/\/github\.com\/DevMboo\/pso-web-(framework|releases)\/releases\/download\/[\w.-]+\/[\w.-]+$/.test(url) || !label) {
          throw new Error(`${ctx.pageId}: invalid release download button (only GitHub releases of DevMboo/pso-web-framework)`);
        }
        out.push(pso(`<p><a class="btn btn-primary" href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a></p>`, t.raw));
      }
      else throw new Error(`${ctx.pageId}: unknown directive :::${dm[1]}`);
      continue;
    }
    if (t.type === "blockquote") {
      const first = (t.tokens?.[0] as Tokens.Paragraph | undefined);
      const am = first && first.type === "paragraph" ? /^\[!(NOTE|TIP|WARNING|DANGER|STATUS)\]\s*\n?/.exec(first.text) : null;
      if (am) {
        const a = ALERTS[am[1]!]!;
        first!.text = first!.text.slice(am[0].length);
        first!.tokens = m.Lexer.lexInline(first!.text) as Tokens.Paragraph["tokens"];
        const inner = m.parser(t.tokens as never);
        out.push(pso(`<aside class="callout callout-${a.cls}" role="note"><div class="callout-title">${useIcon(a.icon)}<span>${a.title}</span></div><div class="callout-body">${inner}</div></aside>`, t.raw));
        continue;
      }
    }
    if (t.type === "code" && /\btab="/.test(t.lang ?? "")) {
      const group = parseInfo(t.lang!).group ?? "g";
      const items: Tokens.Code[] = [t as Tokens.Code];
      for (;;) {
        let j = i + 1;
        while (tokens[j]?.type === "space") j++; // blank lines between fences are separate tokens
        const nx = tokens[j] as Tokens.Code | undefined;
        if (!nx || nx.type !== "code" || !/\btab="/.test(nx.lang ?? "") || (parseInfo(nx.lang!).group ?? "g") !== group) break;
        items.push(nx);
        i = j;
      }
      const uid = `tabs-${slugify(ctx.pageId)}-${out.length}`;
      const tabs = items.map((c, k) => `<button role="tab" type="button" id="${uid}-t${k}" aria-controls="${uid}-p${k}" aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}">${esc(parseInfo(c.lang!).tab!)}</button>`).join("");
      const panels = items.map((c, k) => `<div role="tabpanel" id="${uid}-p${k}" aria-labelledby="${uid}-t${k}"${k === 0 ? "" : " hidden"}>${codeBlock(c.text, c.lang!)}</div>`).join("");
      out.push(pso(`<div class="tabs" data-tabs><div role="tablist" aria-label="Examples">${tabs}</div>${panels}</div>`, items.map((c) => c.raw).join("")));
      continue;
    }
    out.push(t);
  }
  const html = m.parser(out as never) as string;
  const text = md.replace(/^:::.*$/gm, "").replace(/```[\w-]*[^\n]*\n/g, "\n").replace(/[#>*_`|]/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return { html, headings, links, text, assets };
}
