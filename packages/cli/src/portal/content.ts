import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Documentation sources (the single source of truth for the portal, search, llms files and AI contexts). */
export const DOCS_ROOT = join(here, "..", "..", "docs");
export const PORTAL_ASSETS = join(here, "..", "..", "portal", "assets");
export const CLI_VERSION: string = (JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version: string }).version;

export type Status = "implemented" | "partial" | "planned";

export interface SectionDef { id: string; title: string; icon: string; blurb: string }
/** Navigation order. A page's section is its folder name. */
export const SECTIONS: SectionDef[] = [
  { id: "getting-started", title: "Getting Started", icon: "rocket", blurb: "Install PSO and ship your first endpoint." },
  { id: "downloads", title: "Downloads", icon: "download", blurb: "Preview availability, requirements and release verification." },
  { id: "tutorials", title: "Tutorials", icon: "book-open", blurb: "Build a workspace, APIs, security and events step by step." },
  { id: "concepts", title: "Core Concepts", icon: "layers", blurb: "The ideas behind Path Structure Working." },
  { id: "architecture", title: "Application Architecture", icon: "blocks", blurb: "Where every component goes: the modular TypeScript orchestrator, the layered Java microservice, and the reference CRUD both start with." },
  { id: "orchestrator", title: "Orchestrator", icon: "workflow", blurb: "Node.js + TypeScript modules, routes and controllers." },
  { id: "microservices", title: "Microservices", icon: "server", blurb: "Spring Boot services that stay independent." },
  { id: "spring", title: "Spring Boot", icon: "package", blurb: "Starters, YAML configuration and secure defaults for Java services." },
  { id: "security", title: "Security", icon: "shield-check", blurb: "Deny by default, from the first request." },
  { id: "dispatch", title: "Event Dispatch", icon: "network", blurb: "Optional events between services: Redis Streams, RabbitMQ and Kafka behind one contract." },
  { id: "frontend", title: "Frontend (FEI & MEI)", icon: "panels-top-left", blurb: "An application shell and independent React microfrontends, declared, validated, released and rolled back on their own." },
  { id: "infrastructure", title: "Infrastructure (0.2)", icon: "layers", blurb: "Declare environments, hosts, TLS, secrets and the identity provider once; PSO provisions, runs in containers, validates and deploys them." },
  { id: "cli", title: "CLI Reference", icon: "terminal", blurb: "Every implemented command." },
  { id: "devops", title: "DevOps", icon: "container", blurb: "Run, build, containerize and deploy." },
  { id: "cloud", title: "Cloud & Operations", icon: "cloud", blurb: "Connect servers, deploy with plans and pipelines, roll back and recover." },
  { id: "decisions", title: "Architecture Decisions", icon: "git-branch", blurb: "Why PSO works the way it does." },
  { id: "ai-context", title: "AI Context", icon: "bot", blurb: "Give coding assistants accurate PSO context." },
  { id: "reference", title: "Reference", icon: "book-open", blurb: "Configuration, diagnostics and decorators." },
];

export interface DocPage {
  /** e.g. "orchestrator/routes" (unique id; the URL is `${id}.html`) */
  id: string;
  section: string;
  title: string;
  description: string;
  order: number;
  status: Status;
  keywords: string[];
  related: string[];
  prerequisites: string[];
  /** Markdown body with directives still unexpanded */
  markdown: string;
  /** true when produced from code (CLI reference, config, diagnostics) rather than a file */
  generated: boolean;
  /** AI-context scope definition, when this page is a scope (docs/ai-context/scopes) */
  scope?: { id: string; base: boolean; requires: string[] };
}

export const pageUrl = (id: string): string => `${id}.html`;

/** Minimal front matter: `key: value`, `key: [a, b]`, optional quotes. No YAML dependency, no code execution. */
export function parseFrontMatter(text: string): { data: Record<string, string | string[] | number | boolean>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[] | number | boolean> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2]!.trim();
    const unq = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (raw.startsWith("[") && raw.endsWith("]")) data[kv[1]!] = raw.slice(1, -1).split(",").map(unq).filter(Boolean);
    else if (raw === "true" || raw === "false") data[kv[1]!] = raw === "true";
    else if (/^-?\d+$/.test(raw)) data[kv[1]!] = Number(raw);
    else data[kv[1]!] = unq(raw);
  }
  return { data, body: text.slice(m[0].length) };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "examples") walk(p, out); }
    else if (n.endsWith(".md")) out.push(p);
  }
  return out;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function loadWrittenPages(root = DOCS_ROOT): DocPage[] {
  const pages: DocPage[] = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join("/");
    const { data, body } = parseFrontMatter(readFileSync(file, "utf8").replace(/^﻿/, ""));
    const parts = rel.replace(/\.md$/, "").split("/");
    const id = parts.join("/");
    const section = parts.length > 1 ? parts[0]! : "root";
    const status = (["implemented", "partial", "planned"] as const).find((s) => s === data["status"]) ?? "implemented";
    const page: DocPage = {
      id, section, title: String(data["title"] ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? id), description: String(data["description"] ?? ""),
      order: typeof data["order"] === "number" ? data["order"] : 100, status, keywords: list(data["keywords"]), related: list(data["related"]),
      prerequisites: list(data["prerequisites"]), markdown: body.trim() + "\n", generated: false,
    };
    if (typeof data["scope"] === "string") page.scope = { id: data["scope"], base: data["base"] === true, requires: list(data["requires"]) };
    pages.push(page);
  }
  return pages;
}

export function sortPages(pages: DocPage[]): DocPage[] {
  const rank = (s: string) => { const i = SECTIONS.findIndex((x) => x.id === s); return i < 0 ? 99 : i; };
  return [...pages].sort((a, b) => rank(a.section) - rank(b.section) || a.order - b.order || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

export const slugify = (s: string): string => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*~]/g, "").replace(/[._]/g, "-").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
