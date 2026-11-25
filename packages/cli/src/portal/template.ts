import { SECTIONS, type DocPage, type Status } from "./content.ts";
import { useIcon } from "./icons.ts";
import { esc } from "./render.ts";

// A fresh tag per static export prevents Pages/CDN caches from mixing old scripts
// with newly generated HTML and search data after a same-version docs update.
const ASSET_TAG = Date.now().toString(36);

/** Page descriptions and command summaries are plain text that may contain `code spans`: shown as code in the page, as plain text in meta tags. */
export const inlineCode = (text: string): string => esc(text).replace(/`([^`\n]+)`/g, "<code>$1</code>");
export const plainText = (text: string): string => text.replace(/`([^`\n]+)`/g, "$1");

export interface SiteVersion { version: string; label: string; current: boolean }
export interface PageModel {
  page: DocPage;
  bodyHtml: string;
  headings: Array<{ depth: number; id: string; text: string }>;
  root: string;
  pages: DocPage[];
  version: string;
  versions: SiteVersion[];
  repository?: string;
  relatedPages: DocPage[];
  prev?: DocPage;
  next?: DocPage;
}

const STATUS_LABEL: Record<Status, string> = { implemented: "Implemented", partial: "Partial", planned: "Not implemented" };
export const statusBadge = (s: Status): string => `<span class="badge badge-${s}">${STATUS_LABEL[s]}</span>`;

function head(m: { title: string; description: string; root: string; version: string }): string {
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(m.title)} · PSO Web ${esc(m.version)}</title><meta name="description" content="${esc(plainText(m.description))}"><meta name="color-scheme" content="dark light"><meta name="pso-docs-version" content="${esc(m.version)}"><link rel="icon" href="${m.root}favicon.svg" type="image/svg+xml"><link rel="icon" href="${m.root}favicon.ico" sizes="any"><link rel="apple-touch-icon" href="${m.root}favicon-180.png"><link rel="stylesheet" href="${m.root}assets/portal.css?v=${ASSET_TAG}"><script src="${m.root}assets/theme-init.js?v=${ASSET_TAG}"></script></head>`;
}

function header(root: string, version: string, versions: SiteVersion[], repository?: string): string {
  const opts = versions.map((v) => `<option value="${esc(v.version)}"${v.current ? " selected" : ""} data-href="${v.current ? "" : `${root}v/${esc(v.version)}/index.html`}">${esc(v.label)}</option>`).join("");
  return `<header class="top"><a class="skip" href="#main">Skip to content</a><button class="icon-btn menu-btn" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">${useIcon("menu")}</button><a class="brand" href="${root}index.html" aria-label="PSO Web documentation home"><img src="${root}favicon.svg" alt="" width="22" height="22"><span class="brand-name">PSO <b>Web</b></span></a>
<nav class="top-nav" aria-label="Product"><a href="${root}getting-started/introduction.html">Docs</a><a href="${root}downloads/index.html">Downloads</a><a href="${root}orchestrator/architecture.html">Orchestrator</a><a href="${root}cli/index.html">CLI</a><a href="${root}decisions/why-directory-conventions.html">Architecture</a><a class="top-ai" href="${root}ai-context/overview.html">${useIcon("bot")}AI Context</a></nav>
<div class="top-tools"><button class="search-btn" type="button" aria-keyshortcuts="Control+K" data-search-open>${useIcon("search")}<span class="search-btn-label">Search</span><kbd aria-hidden="true">Ctrl K</kbd></button><label class="visually-hidden" for="version-select">Documentation version</label><select id="version-select" class="version" data-version-select>${opts}</select>${repository ? `<a class="icon-btn" href="${esc(repository)}" rel="noopener noreferrer" aria-label="Source repository">${useIcon("git-branch")}</a>` : ""}<button class="icon-btn" type="button" id="theme-toggle" aria-label="Switch color theme" aria-pressed="false">${useIcon("sun")}${useIcon("moon")}</button></div></header>`;
}

function sidebar(m: PageModel): string {
  const bySection = new Map<string, DocPage[]>();
  for (const p of m.pages) if (!(bySection.get(p.section) ?? bySection.set(p.section, []).get(p.section)!).includes(p)) bySection.get(p.section)!.push(p);
  const groups = SECTIONS.filter((s) => bySection.has(s.id)).map((s) => {
    const items = bySection.get(s.id)!.filter((p) => !(p.scope && p.id.startsWith("ai-context/scopes/")) || p.section === m.page.section);
    const open = m.page.section === s.id;
    return `<details class="nav-section" data-section="${s.id}"${open ? " open" : ""}><summary>${useIcon(s.icon)}<span>${esc(s.title)}</span>${useIcon("chevron-right", "icon chev")}</summary><ul>${items.map((p) => `<li><a href="${m.root}${p.id}.html"${p.id === m.page.id ? ' aria-current="page"' : ""}>${esc(p.title.replace(/^pso /, "pso "))}${p.status !== "implemented" ? ` <span class="nav-status nav-${p.status}" title="${STATUS_LABEL[p.status]}">${p.status === "planned" ? "planned" : "partial"}</span>` : ""}</a></li>`).join("")}</ul></details>`;
  });
  return `<aside class="sidebar" id="sidebar" aria-label="Documentation navigation"><nav>${groups.join("")}</nav></aside>`;
}

function toc(m: PageModel): string {
  const items = m.headings.map((h) => `<li class="toc-${h.depth}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join("");
  const rel = m.relatedPages.length ? `<div class="toc-related"><p class="toc-title">Related concepts</p><ul>${m.relatedPages.map((p) => `<li><a href="${m.root}${p.id}.html">${esc(p.title)}</a></li>`).join("")}</ul></div>` : "";
  return `<aside class="toc" aria-label="On this page">${items ? `<p class="toc-title">On this page</p><ul>${items}</ul>` : ""}${rel}</aside>`;
}

export function pageHtml(m: PageModel): string {
  const p = m.page, sec = SECTIONS.find((s) => s.id === p.section);
  const prereq = p.prerequisites.length ? `<section class="prereq" aria-label="Prerequisites"><h2 class="prereq-title">${useIcon("circle-check")}Prerequisites</h2><ul>${p.prerequisites.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : "";
  const planned = p.status === "planned" ? `<aside class="callout callout-status" role="note"><div class="callout-title">${useIcon("circle-dashed")}<span>Not implemented in PSO Web ${esc(m.version)}</span></div><div class="callout-body"><p>This page describes the intended design. The feature does not exist yet: there are no commands or APIs to call, and AI contexts exported by PSO tell assistants not to use it.</p></div></aside>` : p.status === "partial" ? `<aside class="callout callout-warning" role="note"><div class="callout-title">${useIcon("triangle-alert")}<span>Partially implemented</span></div><div class="callout-body"><p>Read the limitations on this page before relying on it.</p></div></aside>` : "";
  const pn = `<nav class="prevnext" aria-label="Previous and next page">${m.prev ? `<a class="prev" href="${m.root}${m.prev.id}.html" rel="prev">${useIcon("arrow-left")}<span><small>Previous</small>${esc(m.prev.title)}</span></a>` : "<span></span>"}${m.next ? `<a class="next" href="${m.root}${m.next.id}.html" rel="next"><span><small>Next</small>${esc(m.next.title)}</span>${useIcon("arrow-right")}</a>` : ""}</nav>`;
  const aiCopy = p.scope ? `<div class="page-actions"><button class="btn btn-ghost" type="button" data-copy-scope="${esc(p.scope.id)}">${useIcon("copy")}<span class="copy-label">Copy this context for an AI assistant</span></button></div>` : "";
  return `<!doctype html><html lang="en" data-theme="dark">${head({ title: p.title, description: p.description, root: m.root, version: m.version })}<body>${"__SPRITE__"}${header(m.root, m.version, m.versions, m.repository)}<div class="shell">${sidebar(m)}<main id="main" class="content" tabindex="-1"><article><nav class="crumbs" aria-label="Breadcrumb"><a href="${m.root}index.html">Docs</a>${sec ? `<span aria-hidden="true">/</span><span>${esc(sec.title)}</span>` : ""}</nav><div class="article-head"><h1>${esc(p.title)}</h1>${p.status !== "implemented" ? statusBadge(p.status) : ""}</div>${p.description ? `<p class="lead">${inlineCode(p.description)}</p>` : ""}${prereq}${planned}${aiCopy}<div class="prose">${m.bodyHtml}</div>${pn}</article></main>${toc(m)}</div>${footer(m)}<div id="sr-status" class="visually-hidden" role="status" aria-live="polite"></div>${scripts(m.root)}</body></html>`;
}

const footer = (m: { version: string; root: string }) => `<footer class="foot"><span>PSO Web documentation ${esc(m.version)}</span><span>Structure declares. Modules compose. Contracts validate. The framework executes.</span><a href="${m.root}downloads/code-signing-policy.html">Code signing policy</a><a href="${m.root}downloads/privacy-policy.html">Privacy policy</a><a href="${m.root}llms.txt">llms.txt</a></footer>`;
const scripts = (root: string) => `<script src="${root}search-index.js?v=${ASSET_TAG}" defer></script><script src="${root}ai-data.js?v=${ASSET_TAG}" defer></script><script src="${root}assets/portal.js?v=${ASSET_TAG}" defer></script>`;

export interface HomeModel { root: string; version: string; versions: SiteVersion[]; repository?: string; pages: DocPage[]; codeHtml: string; diagrams: { discovery: string; lifecycle: string; distributed: string } }

export function homeHtml(h: HomeModel): string {
  const r = h.root;
  const card = (icon: string, title: string, text: string, href: string, status: Status = "implemented") => `<a class="card" href="${r}${href}.html"><span class="card-icon">${useIcon(icon)}</span><span class="card-title">${esc(title)} ${status !== "implemented" ? statusBadge(status) : ""}</span><span class="card-text">${esc(text)}</span></a>`;
  const features = [
    card("terminal", "CLI-driven development", "Create workspaces, orchestrators, services, modules and routes with generators that edit your code through the TypeScript AST and re-validate it.", "cli/index"),
    card("layers", "Structural discovery", "The tree is parsed, never executed: files are classified by name and place, validated and turned into a deterministic manifest.", "concepts/structural-discovery"),
    card("blocks", "Module composition", "MODULE.pso.ts composes controllers and providers. ROUTES.pso.ts declares what is exposed. Decorators alone expose nothing.", "orchestrator/module"),
    card("shield-check", "Secure routing", "Deny by default. JWT/JWKS guards fail closed, scopes are enforced twice, and an inconsistent registry stops start-up.", "security/secure-routing"),
    card("network", "Microservice communication", "One public orchestrator forwards to declared Spring Boot services with hygienic headers. Services validate tokens themselves.", "orchestrator/upstream-clients"),
    card("workflow", "Optional event dispatch", "One event contract for TypeScript and Java with independent Redis Streams, RabbitMQ and Kafka adapters. At-least-once, disabled by default.", "dispatch/overview"),
    card("container", "Integrated DevOps", "pso dev, build, Docker/Compose/CI generation and release-based deployment with rollback. Running containers is not yet verified here.", "devops/development-environment", "partial"),
  ].join("");
  const sections = SECTIONS.filter((s) => h.pages.some((p) => p.section === s.id)).map((s) => { const first = h.pages.filter((p) => p.section === s.id).sort((a, b) => a.order - b.order)[0]!; return `<a class="section-link" href="${r}${first.id}.html">${useIcon(s.icon)}<span><strong>${esc(s.title)}</strong><small>${esc(s.blurb)}</small></span></a>`; }).join("");
  const trio = [["MODULE.pso.ts", "Composition", "Which controllers and providers belong together."], ["ROUTES.pso.ts", "Declaration", "Which endpoints exist, and under which security policy."], ["*.controller.ts", "Implementation", "What each endpoint does. Never exposed on its own."]].map(([f, t, d]) => `<div class="trio-item"><code>${f}</code><strong>${t}</strong><span>${d}</span></div>`).join('<span class="trio-plus" aria-hidden="true">+</span>');
  const m = { root: r, version: h.version };
  return `<!doctype html><html lang="en" data-theme="dark">${head({ title: "PSO Web Framework", description: "Build distributed applications through structure, conventions and declarative contracts.", ...m })}<body class="home">${"__SPRITE__"}${header(r, h.version, h.versions, h.repository)}<main id="main" tabindex="-1">
<section class="hero"><div class="hero-copy"><p class="eyebrow">PSO Web — Cloud Ecosystem Framework</p><h1>PSO Web Framework</h1><p class="hero-tag">One ecosystem. Independent teams. Unified architecture.</p><p class="hero-tag">Build independently. Integrate seamlessly. Operate securely.</p><p class="hero-text">A declarative, cloud-oriented ecosystem framework for the entire lifecycle of distributed web applications: development, integration, security, infrastructure, deployment and operations. Create Node.js orchestrators and Spring Boot microservices through structure, conventions and declarative contracts, then deploy and operate them with plans, pipelines, blue-green releases and rollback, so independent teams keep one consistent architecture.</p>
<div class="hero-actions"><a class="btn btn-primary" href="${r}getting-started/introduction.html">${useIcon("rocket")}Get Started</a><a class="btn" href="${r}downloads/index.html">${useIcon("download")}Downloads</a><a class="btn" href="${r}decisions/why-directory-conventions.html">${useIcon("layers")}Explore Architecture</a><a class="btn" href="${r}cli/index.html">${useIcon("terminal")}CLI Reference</a><a class="btn" href="${r}ai-context/overview.html">${useIcon("bot")}AI Context</a></div></div>
<div class="hero-code"><div class="hero-code-title">src/main.ts</div>${h.codeHtml}<p class="hero-code-note">That is the whole entry point. <code>bootstrap()</code> discovers the compiled modules, validates them with the same rules as <code>pso validate</code>, resolves dependencies and activates only the routes declared in <code>ROUTES.pso.ts</code>.</p></div></section>
<section class="philosophy" aria-label="Philosophy"><p><span>Structure declares.</span> <span>Modules compose.</span> <span>Contracts validate.</span> <span>The framework executes.</span></p></section>
<section class="block"><h2>What PSO gives you</h2><p class="block-lead">Every card links to the page that explains it, including what is not finished.</p><div class="cards">${features}</div></section>
<section class="block"><h2>Three files, one invariant</h2><p class="block-lead">An endpoint exists if and only if it is declared in the route registry, belongs to a valid module, references a compatible decorated action and passes validation.</p><div class="trio">${trio}</div></section>
<section class="block"><h2>See how it works</h2><p class="block-lead">Select any step to read its responsibility. These diagrams describe the implemented behavior.</p>${h.diagrams.discovery}${h.diagrams.lifecycle}${h.diagrams.distributed}</section>
<section class="block"><h2>Explore the documentation</h2><div class="section-links">${sections}</div></section>
</main>${footer(m)}<div id="sr-status" class="visually-hidden" role="status" aria-live="polite"></div>${scripts(r)}</body></html>`;
}
