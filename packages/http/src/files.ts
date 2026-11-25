import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";

/**
 * File primitives of the orchestrator: the uploaded-file value a DTO receives, the declaration options of `@FileField` / `@FilesField`,
 * filename sanitization and content verification by signature. Nothing here trusts the client: the declared content type and the
 * extension are inputs to be checked against the real bytes, never proof of what a file is.
 */

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 10;
export const HARD_MAX_FILES = 100;
const SNIFF_BYTES = 4096;
export const HEAD_BYTES = SNIFF_BYTES;

/** Size such as `1048576`, `"512KB"`, `"10MB"`, `"1GB"` (binary multiples: 1MB = 1024*1024 bytes, like Spring's DataSize). */
export type SizeLike = number | string;
export function parseSize(v: SizeLike): number {
  if (typeof v === "number") { if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`invalid size ${String(v)}`); return v; }
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB)?$/i.exec(v.trim());
  if (!m) throw new RangeError(`invalid size "${v}" (use a number of bytes or a value such as "512KB", "10MB")`);
  const unit = (m[2] ?? "B").toUpperCase();
  const mult = unit === "B" ? 1 : unit.startsWith("K") ? 1024 : unit.startsWith("M") ? 1024 ** 2 : 1024 ** 3;
  const n = Math.floor(Number(m[1]) * mult);
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`invalid size "${v}"`);
  return n;
}

/** Declaration of a file field. */
export interface FileOptions {
  /** default true (like every DTO field); `false` makes the file optional */
  required?: boolean;
  /** largest accepted file; enforced WHILE the body streams (default 10MB) */
  maxSize?: SizeLike;
  /** accepted content types, exact (`application/pdf`) or by family (`image/*`). Verified against the file signature. */
  mimeTypes?: readonly string[];
  /** accepted extensions of the (sanitized) filename, e.g. `[".pdf"]` */
  extensions?: readonly string[];
  /** accept a zero-byte file (default false) */
  allowEmpty?: boolean;
  /**
   * Accept listed types for which the framework has no signature check (the declared type is then trusted). Off by default: a type that
   * cannot be verified is refused at start-up, so the decision to trust the client is always explicit.
   */
  unverified?: boolean;
}
export interface FilesOptions extends FileOptions {
  /** most files accepted in this field (default 10, at most 100) */
  maxFiles?: number;
  /** fewest files accepted when the field is present (default 1) */
  minFiles?: number;
}
/** Normalized declaration kept in the DTO metadata. */
export interface FileSpec {
  multiple: boolean; maxSize: number; maxFiles: number; minFiles: number;
  mimeTypes?: string[]; extensions?: string[]; allowEmpty: boolean; unverified: boolean;
}

// ------------------------------------------------------------------ the uploaded file value
interface UploadedInit { field: string; filename: string; contentType: string; detectedType: string | undefined; size: number; sha256: string; path: string }
const paths = new WeakMap<object, string>();

/**
 * One file received in a multipart request, already stored in the request's private temporary area (removed when the response ends).
 * The temporary path is deliberately unreachable: it is not a property, not enumerable and not serialized.
 */
export class PsoUploadedFile {
  /** the DTO field the file arrived in */
  readonly field: string;
  /** the client's filename after sanitization: safe to display and to use as a download name, never a path */
  readonly filename: string;
  /** the content type the client declared (lower case, no parameters) */
  readonly contentType: string;
  /** the type recognised from the file signature, when the format is one the framework knows */
  readonly detectedType: string | undefined;
  readonly size: number;
  /** hex SHA-256 of the content */
  readonly sha256: string;
  constructor(init: UploadedInit) {
    this.field = init.field; this.filename = init.filename; this.contentType = init.contentType; this.detectedType = init.detectedType; this.size = init.size; this.sha256 = init.sha256;
    paths.set(this, init.path);
  }
  /** A fresh stream over the content (each call opens its own). Valid until the response is finished. */
  stream(): Readable { return createReadStream(pathOf(this)); }
  /** The whole content in memory. Refused above `maxBytes` (default 1MB): large files must be streamed. */
  async buffer(maxBytes = 1_048_576): Promise<Buffer> {
    if (this.size > maxBytes) throw new RangeError(`file is ${this.size} bytes; buffer() accepts at most ${maxBytes}. Use stream().`);
    return readFile(pathOf(this));
  }
  toJSON(): { field: string; filename: string; contentType: string; size: number; sha256: string } {
    return { field: this.field, filename: this.filename, contentType: this.contentType, size: this.size, sha256: this.sha256 };
  }
}
/** Framework internal (not exported from the package index). */
export function pathOf(f: PsoUploadedFile): string {
  const p = paths.get(f);
  if (!p) throw new Error("not an uploaded file");
  return p;
}
export const isUploadedFile = (v: unknown): v is PsoUploadedFile => v instanceof PsoUploadedFile;

// ------------------------------------------------------------------ filenames
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/**
 * Turns a client-supplied filename into a safe display/download name: no directories, no control or bidirectional-override
 * characters, no characters that are special in common filesystems, no leading dot, at most 255 bytes, never empty.
 * It is NOT used to build storage paths (storage keys are generated by the framework).
 */
export function sanitizeFilename(raw: string): string {
  let n = raw.normalize("NFC");
  n = n.slice(Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\")) + 1);
  n = n.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").replace(/[<>:"|?*\\/]/g, "_");
  n = n.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (n === "") return "file";
  if (WINDOWS_RESERVED.test(n)) n = `_${n}`;
  if (Buffer.byteLength(n) > 255) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
    let base = ext ? n.slice(0, dot) : n;
    while (Buffer.byteLength(base) + Buffer.byteLength(ext) > 255) base = base.slice(0, -1);
    n = base + ext;
  }
  return n;
}
export const extensionOf = (name: string): string => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i).toLowerCase() : ""; };
/** Lower-case media type without parameters; "" when absent. */
export const normalizeType = (t: string | undefined): string => (t ?? "").split(";")[0]!.trim().toLowerCase();

// ------------------------------------------------------------------ content verification by signature
const startsWith = (b: Buffer, sig: number[], at = 0): boolean => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, s: string, at = 0): boolean => b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;
const isZip = (b: Buffer): boolean => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
function looksLikeText(b: Buffer): boolean {
  for (const c of b) if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13 && c !== 27)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b.length === HEAD_BYTES ? b.subarray(0, b.length - 3) : b); return true; } catch { return false; } // a multi-byte character may be cut at the end of the sample
}
function looksLikeJson(b: Buffer): boolean {
  const s = b.toString("utf8").replace(/^﻿/, "").trimStart();
  return (s.startsWith("{") || s.startsWith("[")) && looksLikeText(b);
}

const ZIP_FAMILY = [
  "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation", "application/epub+zip",
];
/** Types the framework can verify, with the check applied to the first bytes of the file. */
const RULES: Record<string, (head: Buffer) => boolean> = {
  "application/pdf": (b) => ascii(b, "%PDF-"),
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => ascii(b, "GIF87a") || ascii(b, "GIF89a"),
  "image/webp": (b) => ascii(b, "RIFF") && ascii(b, "WEBP", 8),
  "application/gzip": (b) => startsWith(b, [0x1f, 0x8b]),
  "application/json": looksLikeJson,
  "text/plain": looksLikeText,
  "text/csv": looksLikeText,
  "text/markdown": looksLikeText,
  ...Object.fromEntries(ZIP_FAMILY.map((t) => [t, isZip])),
};
/** Content types for which `@FileField` can check the real content. */
export const VERIFIABLE_TYPES: readonly string[] = Object.keys(RULES);
const SIGNATURES: Array<[string, (b: Buffer) => boolean]> = [
  ["application/pdf", RULES["application/pdf"]!], ["image/png", RULES["image/png"]!], ["image/jpeg", RULES["image/jpeg"]!], ["image/gif", RULES["image/gif"]!],
  ["image/webp", RULES["image/webp"]!], ["application/gzip", RULES["application/gzip"]!], ["application/zip", isZip],
];
/** The type recognised from the signature, or undefined for formats without a signature (text, JSON) or unknown ones. */
export function detectType(head: Buffer): string | undefined {
  for (const [t, check] of SIGNATURES) if (check(head)) return t;
  return undefined;
}

export function typeAllowed(allowed: readonly string[], type: string): boolean {
  return allowed.some((a) => a === type || (a.endsWith("/*") && type.startsWith(a.slice(0, -1))));
}

/** Normalizes and validates a declaration. Throws RangeError with a message for the developer (start-up problems). */
export function normalizeFileSpec(o: FilesOptions, multiple: boolean): FileSpec {
  const maxSize = parseSize(o.maxSize ?? DEFAULT_MAX_FILE_BYTES);
  const maxFiles = multiple ? (o.maxFiles ?? DEFAULT_MAX_FILES) : 1;
  const minFiles = multiple ? (o.minFiles ?? 1) : 1;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > HARD_MAX_FILES) throw new RangeError(`maxFiles must be between 1 and ${HARD_MAX_FILES}`);
  if (!Number.isInteger(minFiles) || minFiles < 0 || minFiles > maxFiles) throw new RangeError("minFiles must be between 0 and maxFiles");
  const mimeTypes = o.mimeTypes?.map((t) => t.trim().toLowerCase());
  if (mimeTypes) {
    if (mimeTypes.length === 0) throw new RangeError("mimeTypes must not be empty (omit it to accept any type)");
    for (const t of mimeTypes) {
      if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/.test(t)) throw new RangeError(`"${t}" is not a media type`);
      if (t === "*/*") throw new RangeError('"*/*" accepts everything: omit mimeTypes instead');
      const verifiable = t.endsWith("/*") ? VERIFIABLE_TYPES.some((v) => v.startsWith(t.slice(0, -1))) : t in RULES;
      if (!verifiable && !o.unverified) throw new RangeError(`no signature check exists for "${t}", so its content cannot be verified. Verifiable types: ${VERIFIABLE_TYPES.join(", ")}. Set unverified: true to trust the client's declaration for it.`);
    }
  }
  const extensions = o.extensions?.map((e) => { const x = e.trim().toLowerCase(); return x.startsWith(".") ? x : `.${x}`; });
  if (extensions) for (const e of extensions) if (!/^\.[a-z0-9]{1,16}$/.test(e)) throw new RangeError(`"${e}" is not a file extension`);
  return { multiple, maxSize, maxFiles, minFiles, ...(mimeTypes ? { mimeTypes } : {}), ...(extensions ? { extensions } : {}), allowEmpty: o.allowEmpty === true, unverified: o.unverified === true };
}

/** Checks one received file against its declaration. Returns the problem text, or undefined when acceptable. Never echoes client data. */
export function checkFile(spec: FileSpec, f: { filename: string; contentType: string; size: number }, head: Buffer): string | undefined {
  if (f.size > spec.maxSize) return `must not be larger than ${spec.maxSize} bytes`;
  if (f.size === 0 && !spec.allowEmpty) return "must not be empty";
  if (spec.extensions && !spec.extensions.includes(extensionOf(f.filename))) return `must have one of the extensions: ${spec.extensions.join(", ")}`;
  if (spec.mimeTypes) {
    if (!typeAllowed(spec.mimeTypes, f.contentType)) return `has a content type that is not accepted (accepted: ${spec.mimeTypes.join(", ")})`;
    const rule = RULES[f.contentType];
    if (rule) { if (!rule(head)) return "has content that does not match its declared type"; }
    else if (!spec.unverified) return "has a content type whose content cannot be verified";
    // the real content must also not be a *different* known format hiding behind the declared type
    const real = detectType(head);
    if (real && !(f.contentType === real || (real === "application/zip" && ZIP_FAMILY.includes(f.contentType)))) return "has content that does not match its declared type";
  }
  return undefined;
}

/** The content type sent to an upstream for a validated file: the recognised type when the signature says one, otherwise what the client declared. */
export function forwardedContentType(f: { contentType: string; detectedType: string | undefined }): string {
  const d = f.detectedType;
  if (d && !(d === "application/zip" && ZIP_FAMILY.includes(f.contentType))) return d;
  return f.contentType || "application/octet-stream";
}
