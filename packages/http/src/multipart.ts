import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { HEAD_BYTES, PsoUploadedFile, detectType, normalizeType, sanitizeFilename } from "./files.ts";

/**
 * Streaming multipart/form-data parser (RFC 7578 / RFC 2046). The request body is consumed chunk by chunk; file parts go straight to a
 * private temporary file (mode 0600 in a 0700 directory), so memory use is bounded by the chunk size no matter how large the upload is.
 * Backpressure is real: the next chunk is not read until the previous one has been accepted by the file system. Every limit is enforced
 * while streaming, and every failure path (limit, malformed body, client disconnect) removes what was written.
 */
export type MultipartFailure = "malformed" | "too_large" | "file_too_large" | "too_many_parts" | "too_many_files" | "aborted";
export class MultipartError extends Error {
  readonly failure: MultipartFailure;
  readonly field: string | undefined;
  constructor(failure: MultipartFailure, message: string, field?: string) { super(message); this.failure = failure; this.field = field; }
}

export interface MultipartLimits {
  /** the whole body, counted while streaming */
  maxTotalBytes: number;
  /** all ordinary (non-file) fields together */
  maxFieldBytes: number;
  maxParts: number;
  maxHeaderBytes: number;
}
/** What the binding layer accepts for a file field name; undefined = not a declared file field. */
export type FileAcceptance = (field: string) => { maxSize: number; maxFiles: number } | undefined;

export interface ParsedMultipart {
  /** ordinary fields: every value received, in order */
  fields: Map<string, string[]>;
  files: Map<string, PsoUploadedFile[]>;
  /** names of files received in fields that are not declared as file fields (their content was discarded) */
  unexpectedFiles: string[];
  /** removes every temporary file; safe to call more than once */
  dispose(): Promise<void>;
}

const BOUNDARY_CHARS = /^[0-9A-Za-z'()+_,./:=? -]{1,70}$/;
export function boundaryOf(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const m = /^\s*multipart\/form-data\s*;(.*)$/is.exec(contentType);
  if (!m) return undefined;
  const p = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(`;${m[1]}`);
  const b = p?.[1] ?? p?.[2];
  return b !== undefined && BOUNDARY_CHARS.test(b) && !b.endsWith(" ") ? b : undefined;
}
export const isMultipart = (contentType: string | undefined): boolean => /^\s*multipart\/form-data\s*(;|$)/i.test(contentType ?? "");

interface Disposition { name: string; filename: string | undefined }
/** Parses the part headers (CRLF separated). Names and filenames are bounded; anything unexpected is a malformed body. */
function parseHeaders(text: string): { disposition: Disposition; contentType: string | undefined } {
  let disposition: string | undefined, contentType: string | undefined;
  for (const line of text.split("\r\n")) {
    const i = line.indexOf(":");
    if (i <= 0) throw new MultipartError("malformed", "invalid part header");
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "content-disposition") { if (disposition !== undefined) throw new MultipartError("malformed", "duplicate content-disposition"); disposition = v; }
    else if (k === "content-type") contentType = v;
  }
  if (disposition === undefined) throw new MultipartError("malformed", "part without content-disposition");
  const m = /^form-data\s*((?:;.*)?)$/is.exec(disposition);
  if (!m) throw new MultipartError("malformed", "part is not form-data");
  const params = new Map<string, string>();
  const re = /;\s*([A-Za-z0-9*_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/gy;
  let pos = 0;
  const rest = m[1]!;
  for (let r = re.exec(rest); r; r = re.exec(rest)) { pos = re.lastIndex; params.set(r[1]!.toLowerCase(), (r[2] ?? r[3] ?? "").replace(/\\(.)/g, "$1")); }
  if (rest.slice(pos).trim() !== "") throw new MultipartError("malformed", "invalid content-disposition");
  const name = params.get("name");
  if (name === undefined || name.length === 0 || name.length > 256) throw new MultipartError("malformed", "part without a usable name");
  let filename = params.get("filename");
  const star = params.get("filename*");
  if (star !== undefined) {
    const e = /^([A-Za-z0-9-]+)'[^']*'(.*)$/.exec(star);
    if (e && /^utf-?8$/i.test(e[1]!)) { try { filename = decodeURIComponent(e[2]!); } catch { throw new MultipartError("malformed", "invalid filename*"); } }
  }
  if (filename !== undefined && filename.length > 1024) throw new MultipartError("malformed", "filename too long");
  // browsers percent-encode a double quote inside a name (WHATWG HTML): undo only that, it is not a general decoder
  const unq = (s: string): string => s.replace(/%22/g, '"').replace(/%0D%0A|%0A|%0D/gi, " ");
  return { disposition: { name: unq(name), filename: filename === undefined ? undefined : unq(filename) }, contentType };
}

interface Sink { write(b: Buffer): Promise<void>; end(): Promise<void>; abort(): Promise<void> }

/**
 * Parses a multipart request body. `acceptFile` says which fields are declared file fields and their limits.
 * Throws MultipartError; in that case every temporary file is already removed.
 */
export async function parseMultipart(req: Readable & { headers: IncomingHttpHeaders }, opts: { limits: MultipartLimits; acceptFile: FileAcceptance; tempRoot?: string }): Promise<ParsedMultipart> {
  const boundary = boundaryOf(req.headers["content-type"]);
  if (!boundary) throw new MultipartError("malformed", "missing or invalid multipart boundary");
  const L = opts.limits;
  const declared = req.headers["content-length"] === undefined ? undefined : Number(req.headers["content-length"]);
  if (declared !== undefined && (!Number.isFinite(declared) || declared < 0)) throw new MultipartError("malformed", "invalid content-length");
  if (declared !== undefined && declared > L.maxTotalBytes) throw new MultipartError("too_large", "declared body exceeds the limit");

  const fields = new Map<string, string[]>();
  const files = new Map<string, PsoUploadedFile[]>();
  const unexpected: string[] = [];
  let dir: string | undefined;
  const open: WriteStream[] = [];
  const dispose = async (): Promise<void> => {
    for (const s of open.splice(0)) s.destroy();
    const d = dir; dir = undefined;
    if (d) await rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  };
  const result: ParsedMultipart = { fields, files, unexpectedFiles: unexpected, dispose };

  const dash = Buffer.from(`--${boundary}`, "latin1");
  const delim = Buffer.from(`\r\n--${boundary}`, "latin1");
  type State = "preamble" | "after" | "headers" | "body" | "done";
  let state: State = "preamble";
  let buf: Buffer = Buffer.alloc(0);
  let total = 0, parts = 0, textBytes = 0, preamble = 0;
  let sink: Sink | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  /** a part's receiver, chosen from its headers */
  const startPart = async (h: { disposition: Disposition; contentType: string | undefined }): Promise<Sink> => {
    if (++parts > L.maxParts) throw new MultipartError("too_many_parts", "too many parts");
    const { name, filename } = h.disposition;
    if (filename === undefined) { // ordinary field
      const chunks: Buffer[] = [];
      return {
        async write(b) { textBytes += b.length; if (textBytes > L.maxFieldBytes) throw new MultipartError("too_large", "form fields exceed the limit", name); chunks.push(b); },
        async end() {
          let v: string;
          try { v = decoder.decode(Buffer.concat(chunks)); } catch { throw new MultipartError("malformed", "field is not valid UTF-8", name); }
          const list = fields.get(name); if (list) list.push(v); else fields.set(name, [v]);
        },
        async abort() { chunks.length = 0; },
      };
    }
    const discard: Sink = { async write() {}, async end() {}, async abort() {} };
    if (filename === "") return discard; // a browser sends an empty file input as filename="" with no content: "no file"
    const policy = opts.acceptFile(name);
    if (!policy) { unexpected.push(name); return discard; } // never stored; the binding layer reports it as an unexpected field
    const already = files.get(name)?.length ?? 0;
    if (already >= policy.maxFiles) throw new MultipartError("too_many_files", "too many files", name);
    dir ??= await mkdtemp(join(opts.tempRoot ?? tmpdir(), "pso-upload-"));
    const path = join(dir, randomBytes(16).toString("hex")); // never derived from client input
    const ws = createWriteStream(path, { flags: "wx", mode: 0o600 });
    open.push(ws);
    const failed = new Promise<never>((_, rej) => ws.once("error", rej)); failed.catch(() => undefined);
    const hash = createHash("sha256");
    let size = 0;
    let head: Buffer = Buffer.alloc(0);
    return {
      async write(b) {
        size += b.length;
        if (size > policy.maxSize) throw new MultipartError("file_too_large", "file exceeds its limit", name);
        hash.update(b);
        if (head.length < HEAD_BYTES) head = Buffer.concat([head, b.subarray(0, HEAD_BYTES - head.length)]);
        if (!ws.write(b)) await Promise.race([once(ws, "drain"), failed]); // backpressure: wait for the file system
      },
      async end() {
        ws.end();
        await Promise.race([once(ws, "close"), failed]);
        const declaredType = normalizeType(h.contentType);
        const f = new PsoUploadedFile({ field: name, filename: sanitizeFilename(filename), contentType: declaredType, detectedType: detectType(head), size, sha256: hash.digest("hex"), path });
        heads.set(f, head);
        const list = files.get(name); if (list) list.push(f); else files.set(name, [f]);
      },
      async abort() { ws.destroy(); },
    };
  };

  const feed = async (chunk: Buffer): Promise<void> => {
    total += chunk.length;
    if (total > L.maxTotalBytes) throw new MultipartError("too_large", "body exceeds the limit");
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === "done") { buf = Buffer.alloc(0); return; } // epilogue: ignored (still counted above)
      if (state === "preamble") {
        const i = buf.indexOf(dash);
        if (i < 0) { preamble += buf.length; if (preamble > 8192) throw new MultipartError("malformed", "no multipart boundary found"); buf = Buffer.from(buf.subarray(Math.max(0, buf.length - (dash.length - 1)))); return; }
        buf = buf.subarray(i + dash.length); state = "after";
      } else if (state === "after") {
        if (buf.length < 2) return;
        if (buf[0] === 0x2d && buf[1] === 0x2d) { state = "done"; continue; }
        let k = 0;
        while (k < buf.length && (buf[k] === 0x20 || buf[k] === 0x09)) k++; // transport padding
        if (buf.length < k + 2) return;
        if (buf[k] !== 0x0d || buf[k + 1] !== 0x0a) throw new MultipartError("malformed", "invalid boundary line");
        buf = buf.subarray(k + 2); state = "headers";
      } else if (state === "headers") {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) { if (buf.length > L.maxHeaderBytes) throw new MultipartError("malformed", "part headers too large"); return; }
        if (i > L.maxHeaderBytes) throw new MultipartError("malformed", "part headers too large");
        sink = await startPart(parseHeaders(buf.toString("utf8", 0, i)));
        buf = buf.subarray(i + 4); state = "body";
      } else {
        const i = buf.indexOf(delim);
        if (i >= 0) {
          if (i > 0) await sink!.write(buf.subarray(0, i));
          await sink!.end(); sink = undefined;
          buf = buf.subarray(i + delim.length); state = "after";
          continue;
        }
        const safe = buf.length - (delim.length - 1);
        if (safe > 0) { await sink!.write(buf.subarray(0, safe)); buf = Buffer.from(buf.subarray(safe)); }
        return;
      }
    }
  };

  try {
    // destroyOnReturn:false - leaving the loop early must not destroy the socket, or the client could never read why it was refused
    for await (const chunk of req.iterator({ destroyOnReturn: false })) await feed(chunk as Buffer);
    if ((state as State) !== "done") throw new MultipartError("malformed", "the multipart body ended before its closing boundary");
    return result;
  } catch (e) {
    await sink?.abort().catch(() => undefined);
    await dispose();
    if (e instanceof MultipartError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED" || req.destroyed) throw new MultipartError("aborted", "the client closed the request");
    throw e;
  }
}

/** first bytes of each received file, kept for content verification (not part of the public value) */
const heads = new WeakMap<PsoUploadedFile, Buffer>();
export const headOf = (f: PsoUploadedFile): Buffer => heads.get(f) ?? Buffer.alloc(0);
