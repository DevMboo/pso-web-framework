/**
 * Channel names and patterns. A concrete channel name is dot-separated segments `[a-z0-9][a-z0-9_-]*` (case sensitive values for
 * parameters, see PARAM_VALUE). A pattern may contain `{param}` segments: `employee.{employeeId}`. Matching is by segment count
 * and literal equality, so it is deterministic; two patterns that could match the same name are rejected at start-up (ambiguity).
 * A leading "/" (`/recruitment`) is accepted and ignored. A channel name is NOT a secret and NOT an access-control boundary.
 */
const LITERAL = /^[a-z][a-z0-9_-]{0,63}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** values substituted into a parameter: no dots (segment separator), no whitespace, bounded */
export const PARAM_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SEGMENTS = 8;

export interface Pattern { source: string; segments: ReadonlyArray<{ literal: string } | { param: string }>; params: readonly string[] }

export const normalizeName = (name: string): string => (name.startsWith("/") ? name.slice(1) : name);

export function parsePattern(raw: string): Pattern {
  if (typeof raw !== "string") throw new Error("channel pattern must be a string");
  const name = normalizeName(raw);
  if (name === "" || name.length > 200) throw new Error(`invalid channel pattern "${raw}"`);
  const parts = name.split(".");
  if (parts.length > MAX_SEGMENTS) throw new Error(`channel pattern "${raw}" has more than ${MAX_SEGMENTS} segments`);
  const segments: Pattern["segments"][number][] = [];
  const params: string[] = [];
  for (const p of parts) {
    const m = /^\{([^{}]*)\}$/.exec(p);
    if (m) {
      if (!PARAM_NAME.test(m[1]!)) throw new Error(`invalid parameter name in channel pattern "${raw}"`);
      if (params.includes(m[1]!)) throw new Error(`duplicate parameter "${m[1]}" in channel pattern "${raw}"`);
      params.push(m[1]!); segments.push({ param: m[1]! });
    } else {
      if (!LITERAL.test(p)) throw new Error(`invalid segment "${p}" in channel pattern "${raw}" (lower-case letters, digits, _ and -; parameters are written {name})`);
      segments.push({ literal: p });
    }
  }
  return { source: name, segments, params };
}

/** Resolves a concrete channel name against a pattern. Returns the parameters, or undefined when it does not match or a value is malformed. */
export function matchPattern(pattern: Pattern, channel: string): Record<string, string> | undefined {
  if (typeof channel !== "string" || channel.length > 200) return undefined;
  const parts = normalizeName(channel).split(".");
  if (parts.length !== pattern.segments.length) return undefined;
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [i, seg] of pattern.segments.entries()) {
    const v = parts[i]!;
    if ("literal" in seg) { if (v !== seg.literal) return undefined; }
    else { if (!PARAM_VALUE.test(v)) return undefined; params[seg.param] = v; }
  }
  return params;
}

/** True when some channel name could match both patterns. */
export function overlaps(a: Pattern, b: Pattern): boolean {
  if (a.segments.length !== b.segments.length) return false;
  return a.segments.every((s, i) => { const t = b.segments[i]!; return "param" in s || "param" in t || s.literal === t.literal; });
}

export const canonical = (name: string): string => normalizeName(name);
