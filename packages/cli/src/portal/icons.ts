import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, "..", "..", "..", "..", "node_modules", "lucide-static", "icons"), // a framework checkout (packages/cli/dist/portal -> <repo>/node_modules)
  join(here, "..", "..", "node_modules", "lucide-static", "icons"),             // a dependency installed next to the CLI package
  join(here, "..", "..", "..", "..", "lucide-static", "icons"),                 // an installed distribution (node_modules/@pso/cli/dist/portal -> node_modules/lucide-static)
];
const ICON_DIR = candidates.find((d) => existsSync(d));

/** Inline reference to a symbol of the page's sprite. Decorative unless a label is given. */
export const icon = (name: string, cls = "icon"): string => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

const used = new Set<string>();
export const useIcon = (name: string, cls = "icon"): string => { used.add(name); return icon(name, cls); };

/** Lucide (ISC) symbols for every icon the site uses. A missing icon fails the build instead of rendering blank. */
export function spriteFor(names: Iterable<string>): string {
  if (!ICON_DIR) throw new Error("lucide-static is not installed");
  const symbols = [...new Set(names)].sort().map((n) => {
    const f = join(ICON_DIR, `${n}.svg`);
    if (!existsSync(f)) throw new Error(`icon "${n}" does not exist in lucide-static`);
    const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(readFileSync(f, "utf8"))![1]!.trim();
    return `<symbol id="i-${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`;
  });
  return `<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>${symbols.join("")}</defs></svg>`;
}
export const usedIcons = (): string[] => [...used];
