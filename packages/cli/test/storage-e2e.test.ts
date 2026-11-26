import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";
import { randomPort } from "./helpers.ts";

/**
 * PSO Storage across BOTH runtimes, no fakes in between: a real Node orchestrator (multipart binding, validation, forwardUpload /
 * forwardDownload) in front of a real Spring Boot service (Tomcat multipart, PsoStorageService, local provider on a real directory, real
 * JWT validation against a JWKS served from here). The scenario is the fictional employee-documents flow of the specification.
 *
 * It needs a JDK 21+ and the compiled pso-integration-tests module (`./mvnw -pl pso-integration-tests test-compile`); without them the test
 * is SKIPPED and reported as such, never passed silently.
 */
const javaRoot = join(import.meta.dirname, "../../../pso-java");
const itDir = join(javaRoot, "pso-integration-tests");
const classes = join(itDir, "target", "test-classes");
const cpFile = join(itDir, "target", "it-classpath.txt");
const mvnw = join(javaRoot, process.platform === "win32" ? "mvnw.cmd" : "mvnw");

function classpath(): string | undefined {
  if (!existsSync(join(classes, "com/pso/it/docs/DocsApp.class")) || !existsSync(cpFile)) {
    if (!existsSync(mvnw) || spawnSync("java", ["-version"], { shell: process.platform === "win32" }).status !== 0) return undefined;
    const r = spawnSync(mvnw, ["-q", "-pl", "pso-integration-tests", "test-compile", "dependency:build-classpath", `-Dmdep.outputFile=${cpFile}`, "-Dmdep.includeScope=test"], { cwd: javaRoot, shell: process.platform === "win32", encoding: "utf8", timeout: 540_000 });
    if (r.status !== 0 || !existsSync(cpFile)) return undefined;
  }
  return `${classes}${delimiter}${readFileSync(cpFile, "utf8").trim()}`;
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("contrato de trabalho ".repeat(200)), Buffer.from("\n%%EOF\n")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const DTO = `import { Dto, FileField, Required, StringField, PsoUploadedFile } from "@pso/http";

@Dto()
export class UploadDocumentDto {
  @FileField({ required: true, maxSize: "1MB", mimeTypes: ["application/pdf"], extensions: [".pdf"] })
  document!: PsoUploadedFile;

  @Required() @StringField()
  title!: string;
}
`;
const CONTROLLER = `import { Controller, RestController, Get, Post, Delete, Body, Param, Req, Res, Upstream } from "@pso/http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UploadDocumentDto } from "./dto/upload-document.dto";

@Controller()
@RestController("/employees")
export class DocsController {
  constructor(private readonly upstream: Upstream) {}

  @Post("/:id/documents")
  async upload(@Param("id") id: string, @Body(UploadDocumentDto) dto: UploadDocumentDto, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forwardUpload(req, res, "users", dto, { path: "/employees/" + id + "/documents" });
  }

  @Get("/:id/documents/:fileId")
  async download(@Param("id") id: string, @Param("fileId") fileId: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forwardDownload(req, res, "users", { path: "/employees/" + id + "/documents/" + fileId, maxResponseBytes: 50_000_000 });
  }

  @Post("/:id/documents/:fileId/archive")
  async archive(@Param("id") id: string, @Param("fileId") fileId: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "users", { path: "/employees/" + id + "/documents/" + fileId + "/archive" });
  }

  @Delete("/:id/documents/:fileId")
  async remove(@Param("id") id: string, @Param("fileId") fileId: string, @Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.upstream.forward(req, res, "users", { path: "/employees/" + id + "/documents/" + fileId });
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

const guarded = { guard: "jwt" } as const;
export default defineRoutes({
  routes: [
    { method: "POST", path: "/employees/:id/documents", controller: DocsController, action: "upload", security: { ...guarded, scopes: ["documents:write"] }, metadata: { service: "users" } },
    { method: "GET", path: "/employees/:id/documents/:fileId", controller: DocsController, action: "download", security: { ...guarded, scopes: ["documents:read"] }, metadata: { service: "users" } },
    { method: "POST", path: "/employees/:id/documents/:fileId/archive", controller: DocsController, action: "archive", security: { ...guarded, scopes: ["documents:write"] }, metadata: { service: "users" } },
    { method: "DELETE", path: "/employees/:id/documents/:fileId", controller: DocsController, action: "remove", security: { ...guarded, scopes: ["documents:write"] }, metadata: { service: "users" } },
  ],
});
`;

const cleanup: Array<() => void> = [];
after(() => { for (const c of cleanup.reverse()) { try { c(); } catch { /* best effort */ } } });

test("employee documents across both runtimes: HR uploads a PDF, an authorized user downloads it, others are denied, HR moves and deletes it", { timeout: 600_000 }, async (t) => {
  const cp = classpath();
  if (!cp) { t.skip("no JDK / compiled pso-integration-tests: the cross-runtime storage flow was NOT verified in this run"); return; }

  // identity: one key pair; the orchestrator validates with the public key, Spring with a JWKS served from here
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const jwks: Server = createServer((_q, r) => r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] })));
  const jwksPort = await new Promise<number>((r) => jwks.listen(0, "127.0.0.1", () => r((jwks.address() as { port: number }).port)));
  cleanup.push(() => { jwks.close(); jwks.closeAllConnections(); });
  const token = (sub: string, scope: string, roles: string[] = []) => new SignJWT({ scope, roles }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject(sub).setIssuedAt().setExpirationTime("30m").sign(keys.privateKey);

  // the Spring service
  const work = mkdtempSync(join(tmpdir(), "pso-x-e2e-"));
  cleanup.push(() => rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const storageRoot = join(work, "data");
  const springPort = randomPort() + 1000;
  let springLogs = "";
  const spring: ChildProcess = spawn("java", [
    "-cp", cp, "com.pso.it.docs.DocsApp", `--server.port=${springPort}`, "--pso.service.name=hr-service", "--pso.limits.requests.per-minute=100000",
    "--pso.limits.multipart.enabled=true", "--pso.limits.multipart.max-file-size=2MB", "--pso.limits.multipart.max-request-size=3MB",
    "--pso.storage.provider=local", `--pso.storage.local.root=${storageRoot}`, "--pso.storage.upload.max-size=2MB",
    `--pso.security.jwt.jwks-uri=http://127.0.0.1:${jwksPort}/jwks`, "--pso.security.jwt.issuer=https://idp.test", "--pso.security.jwt.audience=pso-api", "--pso.security.jwt.algorithms=ES256",
    `--java.io.tmpdir=${work}`,
  ], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  spring.stdout!.on("data", (d: Buffer) => { springLogs += d; });
  spring.stderr!.on("data", (d: Buffer) => { springLogs += d; });
  cleanup.push(() => { spring.kill(); spring.stdout?.destroy(); spring.stderr?.destroy(); spring.unref(); });
  for (let i = 0; i < 300 && !/Started DocsApp/.test(springLogs) && spring.exitCode === null; i++) await new Promise((r) => setTimeout(r, 200));
  assert.match(springLogs, /Started DocsApp/, `the Spring service did not start:\n${springLogs.slice(-3000)}`);

  // the Node orchestrator in front of it
  const g: Gw = await buildGateway("pso-x-e2e-gw-", ({ gw }) => {
    const dir = join(gw, "src/routes/docs");
    mkdirSync(join(dir, "dto"), { recursive: true });
    writeFileSync(join(dir, "dto/upload-document.dto.ts"), DTO);
    writeFileSync(join(dir, "docs.controller.ts"), CONTROLLER);
    writeFileSync(join(dir, "MODULE.pso.ts"), MODULE);
    writeFileSync(join(dir, "ROUTES.pso.ts"), ROUTES);
  });
  cleanup.push(() => g.dispose());
  const pub = join(g.root, "x-public.pem");
  writeFileSync(pub, await exportSPKI(keys.publicKey));
  const gwTmp = join(work, "gw-tmp"); mkdirSync(gwTmp);
  const gwApp = await g.start({ PSO_UPSTREAM_USERS: `127.0.0.1:${springPort}`, PSO_UPSTREAM_USERS_PREFIX: "/hr", PSO_JWT_PUBLIC_KEY_FILE: pub, TEMP: gwTmp, TMP: gwTmp, TMPDIR: gwTmp, MAX_UPLOAD_BYTES: "5000000" });
  cleanup.push(() => { gwApp.child.kill(); gwApp.child.stdout?.destroy(); gwApp.child.stderr?.destroy(); gwApp.child.unref(); });

  const hr = await token("hr-1", "documents:write documents:read", ["HR"]);
  const emp42 = await token("42", "documents:read");
  const stranger = await token("someone-else", "documents:read");
  const hdr = (tk: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${tk}`, ...extra });
  const form = (name: string, data: Buffer, type: string, title = "Contrato") => { const f = new FormData(); f.append("title", title); f.append("document", new Blob([new Uint8Array(data)], { type }), name); return f; };
  const url = (p: string) => gwApp.url(`/employees${p}`);

  // 1-7: HR uploads a PDF through the orchestrator
  const up = await fetch(url("/42/documents"), { method: "POST", headers: hdr(hr, { "x-correlation-id": "corr-x-e2e-0001" }), body: form("..\\..\\Relatório Final.pdf", PDF, "application/pdf") });
  const upBody = await up.text();
  assert.equal(up.status, 201, `${upBody}\n--- spring ---\n${springLogs.slice(-2000)}`);
  assert.equal(up.headers.get("x-correlation-id"), "corr-x-e2e-0001", "the correlation id survives the whole chain");
  const file = JSON.parse(upBody) as Record<string, unknown>;
  const id = String(file["id"]);
  assert.match(id, /^f_[A-Za-z0-9_-]{22}$/, "an opaque identifier");
  assert.equal(file["filename"], "Relatório Final.pdf", "the non-ASCII name crossed Node -> Tomcat intact and sanitized (no directories)");
  assert.equal(file["size"], PDF.length);
  assert.equal(file["checksumSha256"], sha(PDF), "byte-exact end to end");
  assert.equal(file["ownerRef"], "employee:42");
  assert.ok(!/"key"|provider|pso-x-e2e|\\\\|data\//.test(upBody), "no storage key, provider or path in a public response");
  const stored = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); })(storageRoot);
  assert.ok(stored.some((p) => p.replaceAll("\\", "/").endsWith(`employees/42/documents/${id}`)), "stored under a generated key inside the configured root");
  assert.ok(!stored.some((p) => /Relat|\.pdf/i.test(p)), "the client's filename is never part of a path");
  // the runtime removes them when the response closes (runtime.ts: they live exactly as long as the response), asynchronously: the client
  // can read the response a moment before the removal completes, so wait for it (bounded) instead of racing it
  const leftovers = () => readdirSync(gwTmp).filter((n) => n.startsWith("pso-upload-"));
  for (const until = Date.now() + 5000; leftovers().length && Date.now() < until;) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(leftovers(), [], "the orchestrator's temporary upload files are gone");

  // 8: an authorized user downloads it through the orchestrator, streamed, with safe headers
  const dl = await fetch(url(`/42/documents/${id}`), { headers: hdr(emp42) });
  assert.equal(dl.status, 200);
  assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha(PDF), "downloaded bytes are identical");
  assert.equal(dl.headers.get("content-type"), "application/pdf");
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
  assert.match(dl.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.match(dl.headers.get("cache-control") ?? "", /no-store/);

  // 9: an unauthorized user receives a denial from the SERVICE's business policy, relayed as a PSO problem
  const denied = await fetch(url(`/42/documents/${id}`), { headers: hdr(stranger) });
  await expectProblem(denied, 403, "PSO_AUTH_FORBIDDEN");
  await expectProblem(await fetch(url(`/43/documents/${id}`), { headers: hdr(await token("43", "documents:read")) }), 403, "PSO_AUTH_FORBIDDEN");
  await expectProblem(await fetch(url(`/42/documents/${id}`)), 401, "PSO_AUTH_UNAUTHORIZED");

  // validation at the orchestrator edge: nothing reaches Spring
  const before = stored.length;
  await expectProblem(await fetch(url("/42/documents"), { method: "POST", headers: hdr(hr), body: form("a.pdf", Buffer.from("MZ" + "x".repeat(300)), "application/pdf") }), 400, "PSO_VALIDATION_FAILED");
  await expectProblem(await fetch(url("/42/documents"), { method: "POST", headers: hdr(hr), body: form("big.pdf", Buffer.concat([PDF, Buffer.alloc(1_200_000, 0x61)]), "application/pdf") }), 413, "PSO_FILE_TOO_LARGE");
  assert.equal((function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); })(storageRoot).length, before, "refused uploads stored nothing");
  // a caller with the scope but without the business role: the Spring service denies the STORE (the framework forwarded faithfully, the application decided)
  const clerk = await token("clerk", "documents:write documents:read");
  await expectProblem(await fetch(url("/42/documents"), { method: "POST", headers: hdr(clerk), body: form("a.pdf", PDF, "application/pdf") }), 403, "PSO_AUTH_FORBIDDEN");

  // 10: move and delete through authorized operations only
  await expectProblem(await fetch(url(`/42/documents/${id}/archive`), { method: "POST", headers: hdr(emp42) }), 403, "PSO_AUTH_FORBIDDEN");
  const moved = await fetch(url(`/42/documents/${id}/archive`), { method: "POST", headers: hdr(hr) });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(((await moved.json()) as Record<string, unknown>)["id"], id, "the identifier survives the move");
  const afterMove = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); })(storageRoot).map((p) => p.replaceAll("\\", "/"));
  assert.ok(afterMove.some((p) => p.endsWith(`archive/employees/42/${id}`)) && !afterMove.some((p) => p.endsWith(`employees/42/documents/${id}`)));
  assert.equal(sha(Buffer.from(await (await fetch(url(`/42/documents/${id}`), { headers: hdr(emp42) })).arrayBuffer())), sha(PDF), "still downloadable after the move");
  await expectProblem(await fetch(url(`/42/documents/${id}`), { method: "DELETE", headers: hdr(emp42) }), 403, "PSO_AUTH_FORBIDDEN");
  assert.equal((await fetch(url(`/42/documents/${id}`), { method: "DELETE", headers: hdr(hr) })).status, 204);
  await expectProblem(await fetch(url(`/42/documents/${id}`), { headers: hdr(hr) }), 404, "PSO_HTTP_NOT_FOUND");
  assert.ok(!(function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); })(storageRoot).some((p) => p.includes(id)), "object and record are gone");
});
