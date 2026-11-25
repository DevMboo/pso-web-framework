import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  Dto, Required, Optional, StringField, IntegerField, BooleanField, ArrayOf, Nested, FileField, FilesField, PsoUploadedFile, ValidationError, DtoDeclarationError,
  validateDto, checkDeclaration, parseMultipart, MultipartError, boundaryOf, parseSize, sanitizeFilename, fileFieldsOf, type ParsedMultipart,
} from "../src/index.ts";
import { formInput, encodeMultipart, uploadLimitFor } from "../src/upload.ts";
import { DEFAULT_HTTP_LIMITS } from "../src/limits.ts";

// ------------------------------------------------------------------ helpers
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x61), Buffer.from("\n%%EOF\n")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const B = "----pso-test-boundary";
type Part = { name: string; value?: string; filename?: string; type?: string; data?: Buffer };
function body(parts: Part[], boundary = B, close = true): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}`;
    out.push(Buffer.from(`--${boundary}\r\ncontent-disposition: ${disp}\r\n${p.type ? `content-type: ${p.type}\r\n` : ""}\r\n`), p.data ?? Buffer.from(p.value ?? ""), Buffer.from("\r\n"));
  }
  if (close) out.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(out);
}
function fakeReq(data: Buffer, opts: { chunk?: number; boundary?: string; headers?: Record<string, string> } = {}): Readable & { headers: Record<string, string | undefined> } {
  const size = opts.chunk ?? 16384;
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  return Object.assign(Readable.from(chunks, { objectMode: false }), { headers: { "content-type": `multipart/form-data; boundary=${opts.boundary ?? B}`, "content-length": String(data.length), ...opts.headers } });
}
const LIMITS = { maxTotalBytes: 5_000_000, maxFieldBytes: 100_000, maxParts: 20, maxHeaderBytes: 8192 };
const accept = (name: string) => (name === "document" || name === "extras" ? { maxSize: 1_000_000, maxFiles: name === "extras" ? 3 : 1 } : undefined);
async function parse(data: Buffer, o: { chunk?: number; limits?: Partial<typeof LIMITS>; tempRoot: string; acceptFile?: typeof accept; headers?: Record<string, string> }): Promise<ParsedMultipart> {
  return parseMultipart(fakeReq(data, { ...(o.chunk ? { chunk: o.chunk } : {}), ...(o.headers ? { headers: o.headers } : {}) }), { limits: { ...LIMITS, ...o.limits }, acceptFile: o.acceptFile ?? accept, tempRoot: o.tempRoot });
}
const failure = async (p: Promise<unknown>): Promise<MultipartError> => { try { await p; } catch (e) { assert.ok(e instanceof MultipartError, String(e)); return e; } assert.fail("expected a MultipartError"); };
const sandbox = () => { const dir = mkdtempSync(join(tmpdir(), "pso-mp-test-")); return { dir, left: () => readdirSync(dir), done: () => rmSync(dir, { recursive: true, force: true }) }; };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// decorators are applied by call (the test runner strips types but does not transform decorator syntax)
type Dec = (target: object, key: string) => void;
function define(cls: new () => unknown, fields: Record<string, Dec[]>, unknown?: "reject" | "strip"): void {
  Dto(unknown ? { unknown } : {})(cls as never);
  for (const [name, decs] of Object.entries(fields)) for (const d of [...decs].reverse()) d(cls.prototype as object, name);
}
const errorsOf = async (cls: new () => unknown, input: unknown): Promise<Array<{ field?: string; message: string }>> => {
  try { await validateDto(cls, input); return []; } catch (e) { if (e instanceof ValidationError) return e.errors; throw e; }
};

class UploadDocument { document!: PsoUploadedFile; title!: string; pages?: number; confidential?: boolean; labels?: string[]; extras?: PsoUploadedFile[] }
define(UploadDocument, {
  document: [FileField({ required: true, maxSize: "1MB", mimeTypes: ["application/pdf"], extensions: [".pdf"] })],
  title: [Required(), StringField()],
  pages: [Optional(), IntegerField()],
  confidential: [Optional(), BooleanField()],
  labels: [Optional(), ArrayOf("string")],
  extras: [Optional(), FilesField({ maxFiles: 3, maxSize: "1MB", mimeTypes: ["image/*"] })],
});

// ------------------------------------------------------------------ parser
test("parses fields and files from one request, with exact content and a private temporary area", async () => {
  const sb = sandbox();
  const data = body([{ name: "title", value: "Contrato" }, { name: "document", filename: "contrato.pdf", type: "application/pdf", data: PDF }, { name: "pages", value: "3" }]);
  const parsed = await parse(data, { tempRoot: sb.dir });
  assert.deepEqual(parsed.fields.get("title"), ["Contrato"]);
  assert.deepEqual(parsed.fields.get("pages"), ["3"]);
  const f = parsed.files.get("document")![0]!;
  assert.equal(f.filename, "contrato.pdf"); assert.equal(f.contentType, "application/pdf"); assert.equal(f.detectedType, "application/pdf");
  assert.equal(f.size, PDF.length); assert.equal(f.sha256, sha(PDF));
  assert.deepEqual(await f.buffer(), PDF);
  const text = JSON.stringify(f);
  assert.ok(!text.includes(sb.dir) && !text.includes("pso-upload"), "the temporary path is never serialized");
  assert.ok(!Object.keys(f).some((k) => /path/i.test(k)));
  assert.equal(sb.left().length, 1, "one private temp directory exists while the request is alive");
  await parsed.dispose(); await parsed.dispose();
  assert.deepEqual(sb.left(), [], "dispose removes every temporary file and is idempotent");
  sb.done();
});

test("a boundary split across arbitrary chunk sizes (even one byte) parses identically", async () => {
  const sb = sandbox();
  const data = body([{ name: "title", value: "x\r\n--not-the-boundary" }, { name: "document", filename: "a.pdf", type: "application/pdf", data: Buffer.concat([PDF, Buffer.from("\r\n--"), PDF]) }]);
  for (const chunk of [1, 2, 7, 64, 100_000]) {
    const parsed = await parse(data, { chunk, tempRoot: sb.dir });
    assert.deepEqual(parsed.fields.get("title"), ["x\r\n--not-the-boundary"], `chunk ${chunk}`);
    assert.deepEqual(await parsed.files.get("document")![0]!.buffer(), Buffer.concat([PDF, Buffer.from("\r\n--"), PDF]), `chunk ${chunk}`);
    await parsed.dispose();
  }
  sb.done();
});

test("multiple files in one field, repeated text fields, and an empty browser file input", async () => {
  const sb = sandbox();
  const data = body([{ name: "extras", filename: "1.png", type: "image/png", data: PNG }, { name: "extras", filename: "2.png", type: "image/png", data: PNG }, { name: "labels", value: "a" }, { name: "labels", value: "b" }, { name: "document", filename: "", type: "application/octet-stream", data: Buffer.alloc(0) }]);
  const parsed = await parse(data, { tempRoot: sb.dir });
  assert.equal(parsed.files.get("extras")!.length, 2);
  assert.deepEqual(parsed.fields.get("labels"), ["a", "b"]);
  assert.equal(parsed.files.has("document"), false, 'filename="" with no content means "no file"');
  await parsed.dispose(); sb.done();
});

test("filenames: sanitized, percent-encoded quotes decoded, filename* honoured, path parts removed", async () => {
  const sb = sandbox();
  const data = body([{ name: "extras", filename: "..\\..\\etc/pass%22wd<>.png", type: "image/png", data: PNG }]);
  const parsed = await parse(data, { tempRoot: sb.dir });
  assert.equal(parsed.files.get("extras")![0]!.filename, 'pass"wd__.png'.replace('"', "_"));
  await parsed.dispose();
  assert.equal(sanitizeFilename("../../secret.txt"), "secret.txt");
  assert.equal(sanitizeFilename("C:\\Users\\x\\a.pdf"), "a.pdf");
  assert.equal(sanitizeFilename(".htaccess"), "htaccess");
  assert.equal(sanitizeFilename("nul.txt"), "_nul.txt");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename("a\u202egnp.exe"), "agnp.exe", "bidirectional override characters are removed");
  assert.equal(sanitizeFilename("x".repeat(400) + ".pdf").endsWith(".pdf"), true);
  assert.ok(Buffer.byteLength(sanitizeFilename("é".repeat(300) + ".pdf")) <= 255);
  sb.done();
});

test("malformed bodies are rejected and leave nothing behind", async () => {
  const sb = sandbox();
  const good = body([{ name: "document", filename: "a.pdf", type: "application/pdf", data: PDF }]);
  const cases: Array<[string, Buffer, Record<string, string>?]> = [
    ["truncated before the closing boundary", good.subarray(0, good.length - 20)],
    ["no boundary at all", Buffer.from("just some bytes that are not multipart at all")],
    ["part without content-disposition", Buffer.from(`--${B}\r\ncontent-type: text/plain\r\n\r\nx\r\n--${B}--\r\n`)],
    ["part that is not form-data", Buffer.from(`--${B}\r\ncontent-disposition: attachment; name="a"\r\n\r\nx\r\n--${B}--\r\n`)],
    ["field without a name", Buffer.from(`--${B}\r\ncontent-disposition: form-data\r\n\r\nx\r\n--${B}--\r\n`)],
    ["garbage after the boundary", Buffer.from(`--${B}XYZ\r\n`)],
    ["a text field that is not UTF-8", Buffer.concat([Buffer.from(`--${B}\r\ncontent-disposition: form-data; name="t"\r\n\r\n`), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from(`\r\n--${B}--\r\n`)])],
    ["invalid content-length", good, { "content-length": "abc" }],
  ];
  for (const [label, data, headers] of cases) {
    const e = await failure(parse(data, { tempRoot: sb.dir, ...(headers ? { headers } : {}) }));
    assert.equal(e.failure, "malformed", label);
    assert.deepEqual(sb.left(), [], `${label}: temporary files removed`);
  }
  for (const ct of [undefined, "multipart/form-data", "multipart/form-data; boundary=", `multipart/form-data; boundary=${"a".repeat(71)}`, "application/json"]) {
    const req = Object.assign(Readable.from([good]), { headers: { ...(ct ? { "content-type": ct } : {}) } });
    assert.equal((await failure(parseMultipart(req, { limits: LIMITS, acceptFile: accept, tempRoot: sb.dir }))).failure, "malformed", String(ct));
  }
  assert.equal(boundaryOf('multipart/form-data; boundary="abc def"'), "abc def");
  assert.equal(boundaryOf("multipart/form-data; boundary=ab "), "ab");
  sb.done();
});

test("limits are enforced while streaming: total, per file, part count, file count, field bytes", async () => {
  const sb = sandbox();
  const big = Buffer.concat([PDF, Buffer.alloc(1_100_000, 0x62)]);
  // declared length over the total: refused before reading a byte
  const declared = fakeReq(body([{ name: "title", value: "x" }]), { headers: { "content-length": "99999999" } });
  let touched = false; declared.on("data", () => { touched = true; });
  assert.equal((await failure(parseMultipart(declared, { limits: LIMITS, acceptFile: accept, tempRoot: sb.dir }))).failure, "too_large");
  assert.equal(touched, false);
  // a lying content-length does not help: the count is taken from the bytes received
  assert.equal((await failure(parse(body([{ name: "document", filename: "a.pdf", type: "application/pdf", data: big }]), { tempRoot: sb.dir, limits: { maxTotalBytes: 500_000 }, headers: { "content-length": "100" } }))).failure, "too_large");
  const f = await failure(parse(body([{ name: "document", filename: "a.pdf", type: "application/pdf", data: big }]), { tempRoot: sb.dir }));
  assert.equal(f.failure, "file_too_large"); assert.equal(f.field, "document");
  assert.equal((await failure(parse(body([1, 2, 3].map((n) => ({ name: `f${n}`, value: "x" }))), { tempRoot: sb.dir, limits: { maxParts: 2 } }))).failure, "too_many_parts");
  assert.equal((await failure(parse(body([1, 2, 3, 4].map((n) => ({ name: "extras", filename: `${n}.png`, type: "image/png", data: PNG }))), { tempRoot: sb.dir }))).failure, "too_many_files");
  assert.equal((await failure(parse(body([{ name: "title", value: "x".repeat(2000) }]), { tempRoot: sb.dir, limits: { maxFieldBytes: 1000 } }))).failure, "too_large");
  assert.deepEqual(sb.left(), [], "every refusal removed its temporary files");
  sb.done();
});

test("files in undeclared fields are discarded, never stored, and reported by name", async () => {
  const sb = sandbox();
  const parsed = await parse(body([{ name: "surprise", filename: "x.bin", type: "application/octet-stream", data: Buffer.alloc(1000, 7) }, { name: "title", value: "t" }]), { tempRoot: sb.dir });
  assert.deepEqual(parsed.unexpectedFiles, ["surprise"]);
  assert.equal(parsed.files.size, 0);
  assert.deepEqual(sb.left(), [], "no temp directory was even created");
  sb.done();
});

test("a client that disconnects mid-upload is reported as aborted and its partial file removed", async () => {
  const sb = sandbox();
  const head = body([{ name: "document", filename: "a.pdf", type: "application/pdf", data: PDF }], B, false).subarray(0, 600);
  async function* broken(): AsyncGenerator<Buffer> { yield head; await new Promise((r) => setTimeout(r, 20)); const e = new Error("aborted") as NodeJS.ErrnoException; e.code = "ECONNRESET"; throw e; }
  const req = Object.assign(Readable.from(broken(), { objectMode: false }), { headers: { "content-type": `multipart/form-data; boundary=${B}` } });
  const e = await failure(parseMultipart(req, { limits: LIMITS, acceptFile: accept, tempRoot: sb.dir }));
  assert.equal(e.failure, "aborted");
  assert.deepEqual(sb.left(), []);
  sb.done();
});

test("streaming with backpressure: a 400 MB upload never accumulates in memory", async () => {
  const sb = sandbox();
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  const total = 400 * 1024 * 1024;
  const head = Buffer.from(`--${B}\r\ncontent-disposition: form-data; name="document"; filename="big.bin"\r\ncontent-type: application/octet-stream\r\n\r\n`);
  let produced = 0, peak = 0;
  const base = process.memoryUsage().arrayBuffers;
  async function* gen(): AsyncGenerator<Buffer> {
    yield head;
    while (produced < total) { produced += chunk.length; peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); yield chunk; }
    yield Buffer.from(`\r\n--${B}--\r\n`);
  }
  const req = Object.assign(Readable.from(gen(), { objectMode: false, highWaterMark: 64 * 1024 }), { headers: { "content-type": `multipart/form-data; boundary=${B}` } });
  const parsed = await parseMultipart(req, { limits: { ...LIMITS, maxTotalBytes: 2000 * 1024 * 1024 }, acceptFile: () => ({ maxSize: 2000 * 1024 * 1024, maxFiles: 1 }), tempRoot: sb.dir });
  const f = parsed.files.get("document")![0]!;
  assert.equal(f.size, total);
  // the retained memory plateaus (garbage collection lag, ~40 MB measured at 120 MB and at 480 MB); buffering would grow to the full 400 MB
  assert.ok(peak < total / 4, `peak off-heap growth was ${(peak / 1048576).toFixed(1)} MB: the body must stream, not buffer`);
  await assert.rejects(f.buffer(), /Use stream\(\)/, "a large file cannot be pulled into memory by accident");
  await parsed.dispose(); sb.done();
});

// ------------------------------------------------------------------ DTO binding
async function bind(parts: Part[], cls: new () => unknown = UploadDocument): Promise<{ value?: Record<string, unknown>; errors: Array<{ field?: string; message: string }>; parsed: ParsedMultipart; sb: ReturnType<typeof sandbox> }> {
  const sb = sandbox();
  const specs = fileFieldsOf(cls);
  const parsed = await parseMultipart(fakeReq(body(parts)), { limits: LIMITS, acceptFile: (n) => { const s = specs.get(n); return s ? { maxSize: s.maxSize, maxFiles: s.maxFiles } : undefined; }, tempRoot: sb.dir });
  try { return { value: (await validateDto(cls, formInput(cls, parsed))) as unknown as Record<string, unknown>, errors: [], parsed, sb }; }
  catch (e) { if (e instanceof ValidationError) return { errors: e.errors, parsed, sb }; throw e; }
}
const pdfPart: Part = { name: "document", filename: "contrato.pdf", type: "application/pdf", data: PDF };

test("DTO binding: files and ordinary fields arrive typed in one validated object", async () => {
  const r = await bind([pdfPart, { name: "title", value: "Contrato" }, { name: "pages", value: "12" }, { name: "confidential", value: "true" }, { name: "labels", value: "a" }, { name: "labels", value: "b" }, { name: "extras", filename: "i.png", type: "image/png", data: PNG }]);
  assert.deepEqual(r.errors, []);
  const v = r.value!;
  assert.ok(v["document"] instanceof PsoUploadedFile);
  assert.equal(v["pages"], 12); assert.equal(v["confidential"], true); assert.deepEqual(v["labels"], ["a", "b"]);
  assert.equal((v["extras"] as PsoUploadedFile[]).length, 1);
  await r.parsed.dispose(); r.sb.done();
});

test("DTO binding: required and optional files, nothing coerced beyond declared types", async () => {
  let r = await bind([{ name: "title", value: "t" }]);
  assert.deepEqual(r.errors, [{ field: "document", message: "is required" }]);
  await r.parsed.dispose();
  r = await bind([pdfPart, { name: "title", value: "t" }]);
  assert.deepEqual(r.errors, [], "the optional extras may be absent");
  await r.parsed.dispose();
  r = await bind([pdfPart, { name: "title", value: "t" }, { name: "pages", value: "12abc" }, { name: "confidential", value: "yes" }]);
  assert.deepEqual(r.errors.map((e) => e.field).sort(), ["confidential", "pages"]);
  await r.parsed.dispose();
  r = await bind([{ name: "document", value: "not a file" }, { name: "title", value: "t" }]);
  assert.deepEqual(r.errors, [{ field: "document", message: "must be an uploaded file (send multipart/form-data)" }]);
  await r.parsed.dispose(); r.sb.done();
});

test("DTO binding: content type, signature and extension are checked against the real bytes", async () => {
  const cases: Array<[string, Part, RegExp]> = [
    ["declared type not accepted", { name: "document", filename: "a.pdf", type: "image/png", data: PNG }, /content type that is not accepted/],
    ["declared pdf, real png", { name: "document", filename: "a.pdf", type: "application/pdf", data: PNG }, /does not match its declared type/],
    ["declared pdf, plain text", { name: "document", filename: "a.pdf", type: "application/pdf", data: Buffer.from("hello, I am not a pdf") }, /does not match its declared type/],
    ["wrong extension", { name: "document", filename: "a.exe", type: "application/pdf", data: PDF }, /extensions: \.pdf/],
    ["no declared type", { name: "document", filename: "a.pdf", data: PDF }, /content type that is not accepted/],
    ["empty file", { name: "document", filename: "a.pdf", type: "application/pdf", data: Buffer.alloc(0) }, /must not be empty/],
  ];
  for (const [label, part, re] of cases) {
    const r = await bind([part, { name: "title", value: "t" }]);
    assert.equal(r.errors.length, 1, label); assert.equal(r.errors[0]!.field, "document", label); assert.match(r.errors[0]!.message, re, label);
    await r.parsed.dispose(); r.sb.done();
  }
  const r = await bind([pdfPart, { name: "title", value: "t" }, { name: "extras", filename: "x.png", type: "image/png", data: Buffer.from("MZ not an image") }]);
  assert.deepEqual(r.errors.map((e) => e.field), ["extras[0]"], "family wildcards are verified per file");
  await r.parsed.dispose(); r.sb.done();
});

test("DTO binding: a double extension, executable bytes behind a pdf name, and a zip posing as a pdf are all refused", async () => {
  const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 0)]);
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 0)]);
  for (const data of [exe, zip]) {
    const r = await bind([{ name: "document", filename: "invoice.pdf.exe", type: "application/pdf", data }, { name: "title", value: "t" }]);
    assert.ok(r.errors.some((e) => e.field === "document"));
    await r.parsed.dispose(); r.sb.done();
  }
  const r = await bind([{ name: "document", filename: "invoice.pdf", type: "application/pdf", data: zip }, { name: "title", value: "t" }]);
  assert.match(r.errors[0]!.message, /does not match/);
  await r.parsed.dispose(); r.sb.done();
});

test("DTO binding: unexpected fields follow the DTO policy (reject by default, strip on request); unexpected files too", async () => {
  let r = await bind([pdfPart, { name: "title", value: "t" }, { name: "admin", value: "1" }, { name: "shell", filename: "x.php", type: "text/plain", data: Buffer.from("<?php") }]);
  assert.deepEqual(r.errors.map((e) => e.field).sort(), ["admin", "shell"]);
  assert.ok(!JSON.stringify(r.errors).includes("<?php"));
  await r.parsed.dispose(); r.sb.done();
  class Lenient { document!: PsoUploadedFile }
  define(Lenient, { document: [FileField({ mimeTypes: ["application/pdf"] })] }, "strip");
  r = await bind([pdfPart, { name: "admin", value: "1" }, { name: "shell", filename: "x.php", type: "text/plain", data: Buffer.from("<?php") }], Lenient);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.value!), ["document"]);
  await r.parsed.dispose(); r.sb.done();
});

test("DTO binding: a JSON-shaped value is not a file", async () => {
  assert.deepEqual(await errorsOf(UploadDocument, { document: { path: "/etc/passwd" }, title: "t" }), [{ field: "document", message: "must be an uploaded file (send multipart/form-data)" }]);
});

test("declaration problems fail at start-up with a clear message", () => {
  const dec = (f: () => void) => assert.throws(f, DtoDeclarationError);
  class A { x!: unknown }
  dec(() => FileField({ mimeTypes: ["application/x-msdownload"] })(A.prototype, "x"));
  dec(() => FileField({ mimeTypes: ["*/*"] })(A.prototype, "x"));
  dec(() => FileField({ mimeTypes: [] })(A.prototype, "x"));
  dec(() => FileField({ maxSize: "ten megabytes" })(A.prototype, "x"));
  dec(() => FilesField({ maxFiles: 0 })(A.prototype, "x"));
  dec(() => FilesField({ maxFiles: 1000 })(A.prototype, "x"));
  dec(() => FileField({ extensions: ["../x"] })(A.prototype, "x"));
  assert.doesNotThrow(() => FileField({ mimeTypes: ["application/x-msdownload"], unverified: true })(A.prototype, "x"), "trusting the client is possible, but only explicitly");
  class Inner { f!: unknown }
  class Outer { inner!: unknown }
  define(Inner, { f: [FileField()] });
  define(Outer, { inner: [Optional(), Nested(Inner)] });
  assert.ok(checkDeclaration(Outer).some((p) => /only at the top level/.test(p)));
  assert.deepEqual(checkDeclaration(UploadDocument), []);
});

test("sizes: 10MB means 10 * 1024 * 1024 bytes, like Spring", () => {
  assert.equal(parseSize("10MB"), 10_485_760); assert.equal(parseSize("512KB"), 524_288); assert.equal(parseSize("1GB"), 1_073_741_824); assert.equal(parseSize(100), 100);
  assert.throws(() => parseSize("0")); assert.throws(() => parseSize("-1MB")); assert.throws(() => parseSize("1TB")); assert.throws(() => parseSize(1.5));
});

test("the byte limit of a route comes from its DTO, never above the global upload limit", () => {
  const n = uploadLimitFor(UploadDocument, { ...DEFAULT_HTTP_LIMITS, maxUploadBytes: 100_000_000 });
  assert.ok(n > 5_000_000 && n < 6_000_000, String(n)); // 3 files x 1MB + 1 file x 1MB + fields + overhead
  assert.equal(uploadLimitFor(UploadDocument, { ...DEFAULT_HTTP_LIMITS, maxUploadBytes: 1000 }), 1000);
});

// ------------------------------------------------------------------ the request sent to a Spring service
test("outgoing multipart: only validated data is re-encoded, with an exact content length, and the parser reads it back", async () => {
  const r = await bind([{ name: "document", filename: "relatório final.pdf", type: "application/pdf", data: PDF }, { name: "title", value: "Contrato ação" }, { name: "pages", value: "3" }, { name: "labels", value: "a" }, { name: "labels", value: "b" }, { name: "extras", filename: "i.png", type: "image/png", data: PNG }]);
  assert.deepEqual(r.errors, []);
  const out = encodeMultipart(r.value!);
  const chunks: Buffer[] = [];
  for await (const c of out.stream) chunks.push(c as Buffer);
  const wire = Buffer.concat(chunks);
  assert.equal(wire.length, out.length, "Content-Length is exact");
  assert.ok(!wire.toString("latin1").includes("pso-upload"), "no temporary path on the wire");
  const sb = sandbox();
  const back = await parseMultipart(Object.assign(Readable.from([wire]), { headers: { "content-type": out.contentType } }), { limits: LIMITS, acceptFile: accept, tempRoot: sb.dir });
  assert.deepEqual(back.fields.get("title"), ["Contrato ação"]); assert.deepEqual(back.fields.get("pages"), ["3"]); assert.deepEqual(back.fields.get("labels"), ["a", "b"]);
  const doc = back.files.get("document")![0]!;
  assert.equal(doc.filename, "relatório final.pdf", "filename* carries the non-ASCII name");
  assert.equal(doc.sha256, sha(PDF)); assert.equal(doc.contentType, "application/pdf");
  assert.equal(back.files.get("extras")![0]!.contentType, "image/png");
  await back.dispose(); await r.parsed.dispose(); sb.done(); r.sb.done();
});
