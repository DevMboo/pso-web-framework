/**
 * The payload schema language of PSO Dispatch: a small, closed subset of JSON Schema with identical semantics in TypeScript
 * and Java: type (string, number, integer, boolean, object, array, null; or a list), properties, required, additionalProperties
 * (boolean), enum, items, minimum, maximum, minLength, maxLength, minItems, maxItems, pattern. Anything else is rejected when the
 * schema is loaded, so a contract can never silently rely on a keyword the runtime ignores.
 */
export type Schema = {
  type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; items?: Schema;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; pattern?: string;
};

const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "enum", "items", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "description", "title"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export function schemaProblems(s: unknown, path = "$"): string[] {
  const p: string[] = [];
  if (!s || typeof s !== "object" || Array.isArray(s)) return [`${path}: a schema must be an object`];
  const o = s as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYWORDS.has(k)) p.push(`${path}: unsupported keyword "${k}"`);
  const types = o["type"] === undefined ? [] : Array.isArray(o["type"]) ? o["type"] : [o["type"]];
  for (const t of types) if (typeof t !== "string" || !TYPES.has(t)) p.push(`${path}: unknown type ${JSON.stringify(t)}`);
  if (o["properties"] !== undefined) {
    if (!o["properties"] || typeof o["properties"] !== "object" || Array.isArray(o["properties"])) p.push(`${path}.properties must be an object`);
    else for (const [k, v] of Object.entries(o["properties"] as object)) p.push(...schemaProblems(v, `${path}.${k}`));
  }
  if (o["items"] !== undefined) p.push(...schemaProblems(o["items"], `${path}[]`));
  if (o["required"] !== undefined && (!Array.isArray(o["required"]) || o["required"].some((x) => typeof x !== "string"))) p.push(`${path}.required must be a list of names`);
  if (o["pattern"] !== undefined) { try { new RegExp(String(o["pattern"])); } catch { p.push(`${path}.pattern is not a valid expression`); } }
  return p;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** @returns validation problems for `value` (empty when valid). Paths never include the offending values. */
export function validate(s: Schema, value: unknown, path = "$"): string[] {
  const p: string[] = [];
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? s.type : [s.type];
    const actual = typeOf(value);
    if (!ts.some((t) => t === actual || (t === "number" && actual === "integer"))) { p.push(`${path}: expected ${ts.join("|")}, got ${actual}`); return p; }
  }
  if (s.enum && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(value))) p.push(`${path}: not one of the allowed values`);
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) p.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > s.maxLength) p.push(`${path}: longer than ${s.maxLength}`);
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) p.push(`${path}: does not match the required pattern`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) p.push(`${path}: below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) p.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) p.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) p.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((x, i) => p.push(...validate(s.items!, x, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) p.push(`${path}.${r}: is required`);
    for (const [k, v] of Object.entries(o)) {
      const sub = s.properties?.[k];
      if (sub) p.push(...validate(sub, v, `${path}.${k}`));
      else if (s.additionalProperties === false) p.push(`${path}.${k}: is not allowed`);
    }
  }
  return p;
}

export type Compatibility = "backward" | "forward" | "full" | "none";

const widen = (t: Schema["type"]): string[] => (t === undefined ? ["*"] : Array.isArray(t) ? t : [t]);
const accepts = (writer: string[], reader: string[]): boolean => reader.includes("*") || writer.every((w) => reader.includes(w) || (w === "integer" && reader.includes("number")));

/**
 * Structural compatibility of two schema versions (reader = the side that validates, writer = the side that produced the data).
 * - backward: consumers on `next` can read data written under `prev`.
 * - forward: consumers on `prev` can read data written under `next`.
 * - full: both. A deliberately breaking change must bump the event version instead.
 * @returns the reasons the change is incompatible (empty when compatible)
 */
export function compatibilityProblems(prev: Schema, next: Schema, mode: Compatibility): string[] {
  if (mode === "none") return [];
  const out: string[] = [];
  const check = (writer: Schema, reader: Schema, label: string, path: string) => {
    if (!accepts(widen(writer.type), widen(reader.type))) out.push(`${label}: ${path} type ${widen(writer.type).join("|")} is not accepted by ${widen(reader.type).join("|")}`);
    const readerRequired = new Set(reader.required ?? []);
    const writerRequired = new Set(writer.required ?? []);
    for (const r of readerRequired) if (!writerRequired.has(r)) out.push(`${label}: ${path}.${r} is required by the reader but not guaranteed by the writer`);
    for (const [k, ws] of Object.entries(writer.properties ?? {})) {
      const rs = reader.properties?.[k];
      if (rs) check(ws, rs, label, `${path}.${k}`);
      else if (reader.additionalProperties === false) out.push(`${label}: ${path}.${k} is written but the reader forbids unknown properties`);
    }
    if (writer.enum && reader.enum && !writer.enum.every((x) => reader.enum!.some((y) => JSON.stringify(x) === JSON.stringify(y)))) out.push(`${label}: ${path} enum has values the reader does not accept`);
    if (writer.items && reader.items) check(writer.items, reader.items, label, `${path}[]`);
  };
  if (mode === "backward" || mode === "full") check(prev, next, "backward", "$");
  if (mode === "forward" || mode === "full") check(next, prev, "forward", "$");
  return out;
}
