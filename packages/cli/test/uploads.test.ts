import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMultipart } from "@pso/http";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";

/**
 * The orchestrator side of PSO Storage, end to end: a real orchestrator process (compiled with the real TypeScript compiler, decorators
 * and all) receives multipart uploads, binds them to a DTO, and forwards the validated files to a fake upstream that records exactly what
 * it receives. The Spring side of the same flow is tested in pso-java (StorageEndToEndTests) with the real Spring stack.
 */
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(3000, 0x61), Buffer.from("\n%%EOF\n")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; fields: Record<string, string[]>; files: Array<{ field: string; filename: string; contentType: string; size: number; sha256: string }>; contentLengthMatches: boolean }
const seen: Seen[] = [];
let downloadBytes = 1024;
let downloadDisposition: string | undefined;
const scratch = mkdtempSync(join(tmpdir(), "pso-upl-e2e-"));
const upstream: Server = createServer(async (req, res) => {
  if (req.method === "POST") {
    let counted = 0;
    req.on("data", (c: Buffer) => { counted += c.length; });
    const dir = join(scratch, "up"); mkdirSync(dir, { recursive: true });
    try {
      const p = await parseMultipart(req, { limits: { maxTotalBytes: 50_000_000, maxFieldBytes: 1_000_000, maxParts: 50, maxHeaderBytes: 8192 }, acceptFile: () => ({ maxSize: 50_000_000, maxFiles: 10 }), tempRoot: dir });
      const files = [...p.files.values()].flat().map((f) => ({ field: f.field, filename: f.filename, contentType: f.contentType, size: f.size, sha256: f.sha256 }));
      seen.push({ method: req.method, url: req.url!, headers: req.headers, fields: Object.fromEntries(p.fields), files, contentLengthMatches: Number(req.headers["content-length"]) === counted });
      await p.dispose();
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ stored: files.length }));
    } catch (e) { res.writeHead(400).end(String(e)); }
    return;
  }
  seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, fields: {}, files: [], contentLengthMatches: true });
  if (req.url?.includes("/missing")) { res.writeHead(404, { "content-type": "application/problem+json" }).end(JSON.stringify({ title: "nope" })); return; }
  const headers: Record<string, string> = { "content-type": "text/html", "content-length": String(downloadBytes) };
  if (downloadDisposition) headers["content-disposition"] = downloadDisposition;
  res.writeHead(200, headers);
  let sent = 0;
  const pump = (): void => { while (sent < downloadBytes) { const n = Math.min(65536, downloadBytes - sent); sent += n; if (!res.write(Buffer.alloc(n, 0x3c))) { res.once("drain", pump); return; } } res.end(); };
  pump();
});
const upstreamPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as { port: number }).port)));

const DTO = `import { Dto, FileField, FilesField, Required, StringField, Optional, IntegerField, PsoUploadedFile } from "@pso/http";

@Dto()
export class UploadDocumentDto {
  @FileField({ required: true, maxSize: "1MB", mimeTypes: ["application/pdf"], extensions: [".pdf"] })
  document!: PsoUploadedFile;

  @FilesField({ required: false, maxFiles: 2, maxSize: "100KB", mimeTypes: ["image/png", "image/jpeg"] })
  attachments?: PsoUploadedFile[];

  @Required() @StringField()
  title!: string;

  @Optional() @IntegerField()
  version?: number;
}
`;
const CONTROLLER = `import { Controller, RestController, Get, Post, Body, Param, Req, Res, Upstream } from "@pso/http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UploadDocumentDto } from "./dto/upload-document.dto";

@Controller()
@RestController("/docs")
export class DocsController {
  constructor(private readonly upstream: Upstream) {}

  @Post("/employees/:id/documents")
  async upload(@Param("id") id: string, @Body(UploadDocumentDto) dto: UploadDocumentDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forwardUpload(req, res, "users", dto, { path: "/employees/" + id + "/documents" });
  }

  @Get("/employees/:id/documents/:fileId")
  async download(@Param("id") id: string, @Param("fileId") fileId: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forwardDownload(req, res, "users", { path: "/employees/" + id + "/documents/" + fileId, maxResponseBytes: 20_000_000 });
  }

  @Get("/plain/:fileId")
  async plain(@Param("fileId") fileId: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "users", { path: "/plain/" + fileId });
  }
}
`;
const MODULE = `import { defineModule } from "@pso/core";
import routes from "./ROUTES.pso";
import { DocsController } from "./docs.controller";

export default defineModule({ name: "docs", controllers: [DocsController], providers: [], routes, imports: [], exports: [] });
`;
const ROUTES = `import { defineRoutes } from "@pso/http";
import { DocsController } from "./docs.controller";

export default defineRoutes({
  routes: [
    { method: "POST", path: "/docs/employees/:id/documents", controller: DocsController, action: "upload", security: { guard: "jwt", scopes: ["documents:write"] }, metadata: { service: "users" } },
    { method: "GET", path: "/docs/employees/:id/documents/:fileId", controller: DocsController, action: "download", security: { guard: "jwt" }, metadata: { service: "users" } },
    { method: "GET", path: "/docs/plain/:fileId", controller: DocsController, action: "plain", security: { guard: "jwt" }, metadata: { service: "users" } },
  ],
});
`;

const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); upstream.close(); upstream.closeAllConnections(); rmSync(scratch, { recursive: true, force: true }); });

let gwTmp = "";
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const leftovers = (): string[] => readdirSync(gwTmp).filter((n) => n.startsWith("pso-upload-"));

/** A running orchestrator whose caller holds the given scopes; its temporary directory is private to the test. */
async function boot(scope: string, env: Record<string, string> = {}) {
  const { exportSPKI, generateKeyPair, SignJWT } = await import("jose");
  const g = await buildGateway("pso-upl-", ({ gw }) => {
    const dir = join(gw, "src/routes/docs");
    mkdirSync(join(dir, "dto"), { recursive: true });
    writeFileSync(join(dir, "dto/upload-document.dto.ts"), DTO);
    writeFileSync(join(dir, "docs.controller.ts"), CONTROLLER);
    writeFileSync(join(dir, "MODULE.pso.ts"), MODULE);
    writeFileSync(join(dir, "ROUTES.pso.ts"), ROUTES);
  });
  gateways.push(g);
  gwTmp = join(scratch, `gw-tmp-${gateways.length}`); mkdirSync(gwTmp, { recursive: true });
  const keys = await generateKeyPair("ES256", { extractable: true });
  const pub = join(g.root, "scoped-public.pem");
  writeFileSync(pub, await exportSPKI(keys.publicKey));
  const token = await new SignJWT({ scope }).setProtectedHeader({ alg: "ES256", kid: "k2" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject("hr-user").setIssuedAt().setExpirationTime("30m").sign(keys.privateKey);
  const started = await g.start({ PSO_UPSTREAM_USERS: `127.0.0.1:${upstreamPort}`, PSO_JWT_PUBLIC_KEY_FILE: pub, TEMP: gwTmp, TMP: gwTmp, TMPDIR: gwTmp, MAX_UPLOAD_BYTES: "5000000", ...env });
  return { ...started, auth: { authorization: `Bearer ${token}` } as Record<string, string> };
}
const form = (parts: Record<string, string | Blob | Array<string | Blob>>, names: Record<string, string> = {}): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(parts)) for (const x of Array.isArray(v) ? v : [v]) typeof x === "string" ? f.append(k, x) : f.append(k, x, names[k] ?? "file.bin");
  return f;
};
const pdf = (data: Buffer = PDF) => new Blob([new Uint8Array(data)], { type: "application/pdf" });
const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: "image/png" });

test("authorization comes first: a caller without the route's scope is refused before a byte of the body is read", { timeout: 300_000 }, async () => {
  const a = await boot("customers:read");
  try {
    seen.length = 0;
    const r = await fetch(a.url("/docs/employees/42/documents"), { method: "POST", headers: a.auth, body: form({ document: pdf(), title: "x" }, { document: "a.pdf" }) });
    await expectProblem(r, 403, "PSO_AUTH_FORBIDDEN");
    const anon = await fetch(a.url("/docs/employees/42/documents"), { method: "POST", body: form({ document: pdf(), title: "x" }, { document: "a.pdf" }) });
    await expectProblem(anon, 401, "PSO_AUTH_UNAUTHORIZED");
    assert.equal(seen.length, 0, "an unauthorized upload reaches nobody");
    assert.deepEqual(leftovers(), [], "nothing was written to disk");
  } finally { a.child.kill(); }
});

test("a documents:write holder uploads; the forwarded request is rebuilt from validated data, nothing of the client's framing or identity is relayed", { timeout: 300_000 }, async () => {
  const a = await boot("documents:write");
  try {
    seen.length = 0;
    const r = await fetch(a.url("/docs/employees/42/documents"), {
      method: "POST",
      headers: { ...a.auth, "x-correlation-id": "corr-upload-0001", "x-pso-user": "root", "x-pso-roles": "admin", "x-forwarded-for": "6.6.6.6" },
      body: form({ document: pdf(), title: "Contrato 2026", version: "3", attachments: [png(), png()] }, { document: "..\\..\\etc/relatório contrato.pdf", attachments: "foto.png" }),
    });
    assert.equal(r.status, 201, await r.clone().text());
    assert.deepEqual(await r.json(), { stored: 3 });
    assert.equal(r.headers.get("x-correlation-id"), "corr-upload-0001");
    assert.equal(seen.length, 1);
    const s = seen[0]!;
    assert.equal(s.url, "/employees/42/documents", "the upstream path chosen by the controller, not the client's");
    assert.match(String(s.headers["content-type"]), /^multipart\/form-data; boundary=pso-[0-9a-f]{32}$/, "a new boundary: the client's body was re-encoded, not relayed");
    assert.equal(s.contentLengthMatches, true, "the exact Content-Length is sent");
    assert.equal(s.headers["x-correlation-id"], "corr-upload-0001");
    assert.match(String(s.headers["traceparent"]), /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    assert.equal(s.headers["authorization"], a.auth["authorization"], "the caller's bearer travels (guarded route, policy inherit)");
    assert.ok(!Object.keys(s.headers).some((h) => h.startsWith("x-pso-")), "client-supplied identity headers are never forwarded");
    assert.notEqual(s.headers["x-forwarded-for"], "6.6.6.6");
    assert.deepEqual(s.fields, { title: ["Contrato 2026"], version: ["3"] });
    const doc = s.files.find((f) => f.field === "document")!;
    assert.deepEqual({ filename: doc.filename, contentType: doc.contentType, size: doc.size, sha256: doc.sha256 }, { filename: "relatório contrato.pdf", contentType: "application/pdf", size: PDF.length, sha256: sha(PDF) }, "sanitized name (no path), exact bytes");
    assert.equal(s.files.filter((f) => f.field === "attachments").length, 2);
    await settle();
    assert.deepEqual(leftovers(), [], "temporary files are removed when the response ends");
  } finally { a.child.kill(); }
});

test("refusals: validation, size, signature, malformed bodies, wrong media type - none reach the upstream, none leave files", { timeout: 300_000 }, async () => {
  const a = await boot("documents:write");
  try {
    seen.length = 0;
    const url = a.url("/docs/employees/7/documents");
    const post = (body: BodyInit, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { ...a.auth, ...headers }, body });
    const fieldsOf = (p: Record<string, unknown>) => (p["errors"] as Array<{ field: string }>).map((e) => e.field);
    let p = await expectProblem(await post(form({ document: pdf(), title: "t", surprise: "1" }, { document: "a.pdf" })), 400, "PSO_VALIDATION_FAILED");
    assert.deepEqual(fieldsOf(p), ["surprise"], "unexpected fields follow the DTO policy");
    p = await expectProblem(await post(form({ title: "t" })), 400, "PSO_VALIDATION_FAILED");
    assert.deepEqual(p["errors"], [{ field: "document", message: "is required" }]);
    p = await expectProblem(await post(form({ document: new Blob([new Uint8Array(PDF)], { type: "image/png" }), title: "t" }, { document: "a.pdf" })), 400, "PSO_VALIDATION_FAILED");
    assert.match(JSON.stringify(p["errors"]), /not accepted/);
    p = await expectProblem(await post(form({ document: new Blob([new Uint8Array(Buffer.from("MZ" + "x".repeat(500)))], { type: "application/pdf" }), title: "t" }, { document: "invoice.pdf" })), 400, "PSO_VALIDATION_FAILED");
    assert.match(JSON.stringify(p["errors"]), /does not match its declared type/, "an executable labelled application/pdf is refused by signature");
    p = await expectProblem(await post(form({ document: pdf(), title: "t", version: "abc" }, { document: "a.pdf" })), 400, "PSO_VALIDATION_FAILED");
    assert.deepEqual(fieldsOf(p), ["version"]);
    p = await expectProblem(await post(form({ document: pdf(), title: "t", attachments: [png(), png(), png()] }, { document: "a.pdf", attachments: "a.png" })), 400, "PSO_VALIDATION_FAILED");
    assert.deepEqual(fieldsOf(p), ["attachments"], "more files than maxFiles");
    const big = Buffer.concat([PDF, Buffer.alloc(1_200_000, 0x62)]);
    await expectProblem(await post(form({ document: pdf(big), title: "t" }, { document: "big.pdf" })), 413, "PSO_FILE_TOO_LARGE");
    await expectProblem(await post("this is not multipart", { "content-type": "multipart/form-data; boundary=xx" }), 400, "PSO_HTTP_MALFORMED_MULTIPART");
    await expectProblem(await post('--xx\r\ncontent-disposition: form-data; name="title"\r\n\r\nabc', { "content-type": "multipart/form-data; boundary=xx" }), 400, "PSO_HTTP_MALFORMED_MULTIPART");
    await expectProblem(await post("x", { "content-type": "multipart/form-data" }), 400, "PSO_HTTP_MALFORMED_MULTIPART");
    p = await expectProblem(await post(JSON.stringify({ title: "t" }), { "content-type": "application/json" }), 415, "PSO_HTTP_UNSUPPORTED_MEDIA_TYPE");
    assert.equal(seen.length, 0, "no refused upload reached the upstream");
    await settle();
    assert.deepEqual(leftovers(), [], "no refused upload left a temporary file");
    assert.ok(!JSON.stringify(p).includes(gwTmp), "no host path in a response");
  } finally { a.child.kill(); }
});

test("a client that disconnects mid-upload leaves nothing behind and the server keeps serving", { timeout: 300_000 }, async () => {
  const a = await boot("documents:write");
  try {
    seen.length = 0;
    const B = "xx-abort";
    const head = `--${B}\r\ncontent-disposition: form-data; name="document"; filename="a.pdf"\r\ncontent-type: application/pdf\r\n\r\n`;
    await new Promise<void>((resolve) => {
      const sock = connect(a.port, "127.0.0.1", () => {
        sock.write(`POST /docs/employees/9/documents HTTP/1.1\r\nhost: x\r\nauthorization: ${a.auth["authorization"]}\r\ncontent-type: multipart/form-data; boundary=${B}\r\ncontent-length: 500000\r\n\r\n${head}`);
        sock.write(PDF);
        setTimeout(() => { sock.destroy(); resolve(); }, 300);
      });
    });
    await settle(800);
    assert.deepEqual(leftovers(), [], "the partial file of the abandoned upload was removed");
    assert.equal(seen.length, 0);
    assert.equal((await fetch(a.url("/health/live"))).status, 200, "the server is healthy after the abort");
  } finally { a.child.kill(); }
});

test("an unreachable upstream is a 503 problem and the temporary files are still removed", { timeout: 300_000 }, async () => {
  const { unusedPort } = await import("./helpers.ts");
  const a = await boot("documents:write", { PSO_UPSTREAM_USERS: `127.0.0.1:${await unusedPort()}` });
  try {
    const res = await fetch(a.url("/docs/employees/1/documents"), { method: "POST", headers: a.auth, body: form({ document: pdf(), title: "t" }, { document: "a.pdf" }) });
    await expectProblem(res, 503, "PSO_UPSTREAM_UNAVAILABLE");
    await settle();
    assert.deepEqual(leftovers(), []);
  } finally { a.child.kill(); }
});

test("downloads stream through the orchestrator with hardened headers; the size cap is per call", { timeout: 300_000 }, async () => {
  const a = await boot("documents:write");
  try {
    seen.length = 0;
    downloadBytes = 12 * 1024 * 1024; downloadDisposition = undefined;
    const ok = await fetch(a.url("/docs/employees/42/documents/f-1"), { headers: { ...a.auth, "x-correlation-id": "corr-download-01" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ok.headers.get("content-security-policy"), "sandbox");
    assert.equal(ok.headers.get("cache-control"), "private, no-store");
    assert.equal(ok.headers.get("content-disposition"), "attachment", "no disposition from the service: never inline");
    assert.equal(ok.headers.get("x-correlation-id"), "corr-download-01");
    assert.equal((await ok.arrayBuffer()).byteLength, downloadBytes, "12 MB streamed although the default upstream limit is 10 MB: this route raised its own cap");
    assert.equal(seen[0]!.url, "/employees/42/documents/f-1");
    downloadDisposition = 'attachment; filename="contrato.pdf"';
    const named = await fetch(a.url("/docs/employees/42/documents/f-2"), { headers: a.auth });
    assert.equal(named.headers.get("content-disposition"), 'attachment; filename="contrato.pdf"', "the service's choice is preserved");
    await named.arrayBuffer();
    const plain = await fetch(a.url("/docs/plain/f-3"), { headers: a.auth });
    assert.equal(plain.status, 502, "a plain forward() keeps the global response cap");
    await plain.arrayBuffer();
    const missing = await fetch(a.url("/docs/employees/42/documents/missing"), { headers: a.auth });
    assert.equal(missing.status, 404); assert.match(missing.headers.get("content-type") ?? "", /problem\+json/); assert.equal(missing.headers.get("content-disposition"), null, "an upstream error is relayed untouched");
    await missing.arrayBuffer();
  } finally { a.child.kill(); downloadBytes = 1024; }
});

test("MAX_CONCURRENT_UPLOADS sheds load with 503 instead of queueing without bound", { timeout: 300_000 }, async () => {
  const a = await boot("documents:write", { MAX_CONCURRENT_UPLOADS: "1" });
  try {
    const B = "xx-slow";
    const sock = connect(a.port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.on("error", () => undefined);
    // occupy the only slot: headers and the start of a file, then silence
    sock.write(`POST /docs/employees/9/documents HTTP/1.1\r\nhost: x\r\nauthorization: ${a.auth["authorization"]}\r\ncontent-type: multipart/form-data; boundary=${B}\r\ncontent-length: 400000\r\n\r\n--${B}\r\ncontent-disposition: form-data; name="document"; filename="a.pdf"\r\ncontent-type: application/pdf\r\n\r\n${PDF.toString("latin1")}`, "latin1");
    await settle(500);
    const second = await fetch(a.url("/docs/employees/9/documents"), { method: "POST", headers: a.auth, body: form({ document: pdf(), title: "t" }, { document: "a.pdf" }) });
    await expectProblem(second, 503, "PSO_SERVER_BUSY");
    assert.equal(second.headers.get("retry-after"), "1");
    sock.destroy();
    await settle(600);
    const third = await fetch(a.url("/docs/employees/9/documents"), { method: "POST", headers: a.auth, body: form({ document: pdf(), title: "t" }, { document: "a.pdf" }) });
    assert.equal(third.status, 201, "the slot was released when the slow client went away");
  } finally { a.child.kill(); }
});
