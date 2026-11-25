import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./fsx.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** works from src/ (tests) and dist/ (published): templates sit next to both */
export const TEMPLATES_DIR = join(here, "..", "templates");

export type Vars = Record<string, string | number>;

export function render(text: string, vars: Vars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new CliError(`Template variable "${k}" has no value`);
    return String(v);
  });
}

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    if (n === "target" || n === "node_modules") continue; // build output never belongs in a template
    const rel = base ? `${base}/${n}` : n;
    if (statSync(join(dir, n)).isDirectory()) out.push(...walk(join(dir, n), rel));
    else out.push(rel);
  }
  return out;
}

/** Renders a template directory to { relativePath: content }. `__var__` in path segments is substituted too. */
export function renderTemplate(name: string, vars: Vars, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const root = join(TEMPLATES_DIR, name);
  const out: Record<string, string> = {};
  for (const rel of walk(root)) {
    if (skip(rel)) continue;
    const target = rel.replace(/__(\w+)__/g, (_m, k: string) => String(vars[k] ?? `__${k}__`));
    out[target] = render(readFileSync(join(root, ...rel.split("/")), "utf8"), vars);
  }
  return out;
}

export const pascal = (kebab: string): string => kebab.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
export const camel = (kebab: string): string => { const p = pascal(kebab); return p.charAt(0).toLowerCase() + p.slice(1); };
