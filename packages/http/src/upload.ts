import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { PsoUploadedFile, forwardedContentType, pathOf } from "./files.ts";
import type { ParsedMultipart } from "./multipart.ts";
import { fileFieldsOf, formFieldsOf, unknownPolicyOf } from "./validation.ts";
import type { HttpLimits } from "./limits.ts";

/** Binding of a parsed multipart form to a DTO, and re-encoding of a validated DTO as the multipart request sent to an upstream service. */
type DtoClass = abstract new (...args: never[]) => unknown;

const INT = /^-?(0|[1-9]\d*)$/, NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;
/** Strict conversion of a form text value to the type the field declares. A value that does not fit stays a string, so validation reports it. */
function convert(kind: string | undefined, raw: string, values?: ReadonlyArray<string | number>): unknown {
  switch (kind) {
    case "integer": return INT.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : raw;
    case "number": return NUM.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    case "boolean": return raw === "true" ? true : raw === "false" ? false : raw;
    case "enum": return values?.includes(raw) ? raw : values?.find((v) => typeof v === "number" && String(v) === raw) ?? raw;
    case "object": try { return JSON.parse(raw) as unknown; } catch { return raw; }
    default: return raw;
  }
}

/** The object `validateDto` receives for a multipart request: declared form fields converted, files attached, unexpected names kept so the DTO policy applies. */
export function formInput(cls: DtoClass, parsed: ParsedMultipart): Record<string, unknown> {
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const declared = new Map(formFieldsOf(cls).map((f) => [f.name, f]));
  for (const [name, list] of parsed.fields) {
    const f = declared.get(name);
    if (!f) { input[name] = list.length === 1 ? list[0] : list; continue; }
    if (f.kind === "array") {
      let items: unknown[] = list;
      if (list.length === 1 && list[0]!.trimStart().startsWith("[")) { try { const j = JSON.parse(list[0]!) as unknown; if (Array.isArray(j)) items = j; } catch { /* keep as text */ } }
      const itemKind = typeof f.item === "function" ? "object" : f.item;
      input[name] = items.map((x) => (typeof x === "string" ? convert(itemKind, x) : x));
    } else input[name] = list.length === 1 ? convert(f.kind, list[0]!, f.values) : list;
  }
  const fileSpecs = fileFieldsOf(cls);
  for (const [name, list] of parsed.files) { const s = fileSpecs.get(name); input[name] = s?.multiple ? list : list.length === 1 ? list[0] : list; }
  if (unknownPolicyOf(cls) === "reject") for (const name of parsed.unexpectedFiles) input[name] = "(file)";
  return input;
}

/** Largest body a DTO's declaration can legitimately produce, never more than the global upload limit. */
export function uploadLimitFor(cls: DtoClass, limits: HttpLimits): number {
  let n = limits.maxBodyBytes + 64 * 1024;
  for (const s of fileFieldsOf(cls).values()) n += s.maxSize * s.maxFiles + 1024 * s.maxFiles;
  return Math.min(n, limits.maxUploadBytes);
}

// ------------------------------------------------------------------ outgoing multipart (to a Spring service)
const CRLF = Buffer.from("\r\n");
const ascii = (s: string): string => s.replace(/[^\x20-\x7e]|["\\]/g, "_");
const quote = (s: string): string => s.replace(/"/g, "%22").replace(/[\r\n]/g, " ");
type Part = { head: Buffer; body: Buffer } | { head: Buffer; file: PsoUploadedFile };

function textOf(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Re-encodes a VALIDATED DTO instance as multipart/form-data: only declared, valid fields are sent (nothing from the client's raw body or
 * headers survives), file parts are streamed from the temporary files, and the exact Content-Length is known up front.
 */
export function encodeMultipart(dto: object): { contentType: string; length: number; stream: Readable } {
  const boundary = `pso-${randomBytes(16).toString("hex")}`;
  const parts: Part[] = [];
  const text = (name: string, value: string): void => { parts.push({ head: Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${quote(name)}"\r\n\r\n`), body: Buffer.from(value, "utf8") }); };
  const file = (name: string, f: PsoUploadedFile): void => {
    const star = /[^\x20-\x7e]/.test(f.filename) ? `; filename*=UTF-8''${encodeURIComponent(f.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}` : "";
    parts.push({ head: Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${quote(name)}"; filename="${ascii(f.filename)}"${star}\r\ncontent-type: ${forwardedContentType(f)}\r\n\r\n`), file: f });
  };
  for (const [name, v] of Object.entries(dto)) {
    if (v instanceof PsoUploadedFile) file(name, v);
    else if (Array.isArray(v) && v.length > 0 && v.every((x) => x instanceof PsoUploadedFile)) for (const f of v as PsoUploadedFile[]) file(name, f);
    else if (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) { for (const x of v) { const t = textOf(x); if (t !== undefined) text(name, t); } }
    else { const t = textOf(v); if (t !== undefined) text(name, t); }
  }
  const tail = Buffer.from(`--${boundary}--\r\n`);
  let length = tail.length;
  for (const p of parts) length += p.head.length + ("body" in p ? p.body.length : p.file.size) + CRLF.length;
  async function* chunks(): AsyncGenerator<Buffer> {
    for (const p of parts) {
      yield p.head;
      if ("body" in p) yield p.body; else for await (const c of createReadStream(pathOf(p.file))) yield c as Buffer;
      yield CRLF;
    }
    yield tail;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, length, stream: Readable.from(chunks(), { objectMode: false }) };
}
