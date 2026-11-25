/**
 * A small YAML reader for the subset PSO application files use: block mappings and sequences, scalars, quoted strings, flow
 * sequences/mappings on one line, and comments. It never executes anything, supports no anchors or tags, and reports
 * what it cannot understand by throwing, so callers can degrade to "unreadable" instead of guessing.
 */
type Line = { indent: number; text: string; no: number };

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === "\"") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith("\"") && v.endsWith("\"") && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) return splitFlow(v.slice(1, -1)).map((x) => scalar(x));
  if (v.startsWith("{") && v.endsWith("}")) {
    const o: Record<string, unknown> = {};
    for (const part of splitFlow(v.slice(1, -1))) {
      const i = part.indexOf(":");
      if (i < 0) throw new Error(`unsupported flow mapping entry "${part}"`);
      o[part.slice(0, i).trim()] = scalar(part.slice(i + 1));
    }
    return o;
  }
  return v;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", q: string | null = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === "\"") { q = c; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function splitKey(t: string): { key: string; rest: string } | null {
  let q: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === "\"") { q = c; continue; }
    if (c === "$" && t[i + 1] === "{") { const end = t.indexOf("}", i); if (end < 0) return null; i = end; continue; }
    if (c === ":" && (i === t.length - 1 || /\s/.test(t[i + 1]!))) return { key: t.slice(0, i).trim().replace(/^["']|["']$/g, ""), rest: t.slice(i + 1) };
  }
  return null;
}

export function parseYaml(text: string): unknown {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const s = stripComment(l);
    if (s.trim() === "" || s.trim() === "---") return;
    if (/^\t/.test(s)) throw new Error(`line ${i + 1}: tabs are not allowed for indentation`);
    lines.push({ indent: s.length - s.trimStart().length, text: s.trim(), no: i + 1 });
  });
  let pos = 0;

  const block = (indent: number): unknown => {
    const first = lines[pos];
    if (!first) return null;
    return first.text.startsWith("- ") || first.text === "-" ? list(first.indent) : map(first.indent);
  };

  const map = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (pos < lines.length && lines[pos]!.indent === indent && !lines[pos]!.text.startsWith("- ")) {
      const ln = lines[pos]!;
      const kv = splitKey(ln.text);
      if (!kv) throw new Error(`line ${ln.no}: expected "key: value"`);
      if (["__proto__", "constructor", "prototype"].includes(kv.key)) throw new Error(`line ${ln.no}: forbidden key "${kv.key}"`);
      pos++;
      if (kv.rest.trim() !== "") { out[kv.key] = scalar(kv.rest); continue; }
      const next = lines[pos];
      if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))) out[kv.key] = block(next.indent);
      else out[kv.key] = null;
    }
    return out;
  };

  const list = (indent: number): unknown[] => {
    const out: unknown[] = [];
    while (pos < lines.length && lines[pos]!.indent === indent && (lines[pos]!.text.startsWith("- ") || lines[pos]!.text === "-")) {
      const ln = lines[pos]!;
      const body = ln.text === "-" ? "" : ln.text.slice(2).trim();
      if (body === "") { pos++; const next = lines[pos]; out.push(next && next.indent > indent ? block(next.indent) : null); continue; }
      const kv = splitKey(body);
      if (kv && !body.startsWith("[") && !body.startsWith("{") && !body.startsWith("\"") && !body.startsWith("'")) {
        // "- key: value" starts a mapping whose further keys are indented to the key column
        const col = indent + 2;
        lines[pos] = { indent: col, text: body, no: ln.no };
        out.push(map(col));
      } else { pos++; out.push(scalar(body)); }
    }
    return out;
  };

  const result = lines.length ? block(lines[0]!.indent) : {};
  if (pos < lines.length) throw new Error(`line ${lines[pos]!.no}: unexpected indentation`);
  return result;
}

/** Resolves ${VAR:default} placeholders to their default (the value used when the variable is not set); ${VAR} without default stays unresolved. */
export function resolveDefaults(v: unknown): unknown {
  if (typeof v === "string") {
    const m = /^\$\{[A-Za-z0-9_.-]+:([^}]*)\}$/.exec(v.trim());
    return m ? scalar(m[1]!) : v;
  }
  if (Array.isArray(v)) return v.map(resolveDefaults);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolveDefaults(x)]));
  return v;
}

/** True for values that are still unresolved placeholders (their final value depends on the environment). */
export const isPlaceholder = (v: unknown): boolean => typeof v === "string" && /\$\{[^}]*\}/.test(v);

export function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}
