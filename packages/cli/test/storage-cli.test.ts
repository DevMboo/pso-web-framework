import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { psoJavaInstalled, psoJavaVersion } from "../src/specs.ts";
import { dtoSource } from "../src/http-gen.ts";
import { pso, tmp, prepare } from "./helpers.ts";

const javaOk = spawnSync("java", ["-version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const skipJava = !javaOk ? "JDK not found" : !psoJavaInstalled(psoJavaVersion()) ? "PSO Java artifacts are not installed: run `pso java:install` first" : false;
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

async function workspace() {
  const base = tmp("pso-sto-cli-"); dirs.push(base);
  await pso(base, "create", "workspace", "w");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "create", "service", "docs-service", "--structure", "legacy");
  return { root, gw: join(root, "gw"), svc: join(root, "docs-service") };
}
function mvnw(cwd: string, ...args: string[]) {
  const [cmd, base] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", ".\\mvnw.cmd"]] : ["./mvnw", []];
  return spawnSync(cmd!, [...(base as string[]), "-B", "-ntp", ...args], { cwd, encoding: "utf8", timeout: 800_000 });
}

test("make:dto --fields: file and files fields become @FileField / @FilesField with explicit limits, and unsafe declarations are refused", () => {
  const src = dtoSource("UploadDocumentDto", "document:file:mime=application/pdf:size=10MB:ext=.pdf,attachments?:files:mime=image/*:count=3:size=2MB,title:string:max=80");
  assert.match(src, /import \{ Dto, FileField, FilesField, PsoUploadedFile, Required, StringField, MaxLength \} from "@pso\/http";/);
  assert.match(src, /@FileField\(\{ required: true, maxSize: "10MB", extensions: \[".pdf"\], mimeTypes: \["application\/pdf"\] \}\)\n  document!: PsoUploadedFile;/);
  assert.match(src, /@FilesField\(\{ required: false, maxFiles: 3, maxSize: "2MB", mimeTypes: \["image\/\*"\] \}\)\n  attachments\?: PsoUploadedFile\[\];/);
  assert.throws(() => dtoSource("X", "document:file"), /needs mime=/);
  assert.throws(() => dtoSource("X", "document:file:mime=*/*"), /not an acceptable media type/);
  assert.throws(() => dtoSource("X", "document:file:mime=application/x-msdownload"), /cannot verify/);
  assert.throws(() => dtoSource("X", "document:file:mime=application/pdf:size=ten"), /Invalid size/);
  assert.throws(() => dtoSource("X", "document:file:mime=application/pdf:count=2"), /count applies/);
  assert.throws(() => dtoSource("X", "a:files:mime=application/pdf:count=500"), /between 1 and 100/);
});

test("orchestrator generators: upload DTO, upload route (forwardUpload), download route (forwardDownload); the result compiles with the real TypeScript compiler", { timeout: 400_000 }, async () => {
  const { root, gw } = await workspace();
  const run = async (...a: string[]) => { const r = await pso(root, ...a); assert.equal(r.code, 0, `${a.join(" ")}\n${r.out}${r.err}`); return r; };
  await run("make:module", "docs", "--service", "gw");
  await run("make:controller", "docs", "--service", "gw", "--prefix", "/employees");
  const bad = await pso(root, "make:dto", "docs", "upload-document", "--service", "gw", "--fields", "document:file");
  assert.equal(bad.code, 1); assert.match(bad.err + bad.out, /needs mime=/);
  await run("make:dto", "docs", "upload-document", "--service", "gw", "--fields", "document:file:mime=application/pdf:size=10MB:ext=.pdf,title:string:max=80");
  const refuse = await pso(root, "make:route", "docs", "upload", "--method", "POST", "--path", "/:id/documents", "--dto", "upload-document", "--service", "gw");
  assert.equal(refuse.code, 1); assert.match(refuse.err + refuse.out, /--upstream/, "a file DTO without an upstream is refused: the orchestrator forwards, the service stores");
  await run("make:route", "docs", "upload", "--method", "POST", "--path", "/:id/documents", "--scopes", "documents:write", "--upstream", "docs-service", "--dto", "upload-document", "--service", "gw");
  await run("make:route", "docs", "download", "--method", "GET", "--path", "/:id/documents/:fileId", "--scopes", "documents:read", "--upstream", "docs-service", "--download", "--max-download", "100MB", "--service", "gw");
  const plain = await pso(root, "make:route", "docs", "x", "--method", "POST", "--path", "/x", "--upstream", "docs-service", "--download", "--service", "gw");
  assert.equal(plain.code, 1, "--download is for GET");
  const ctl = read(gw, "src/routes/docs/docs.controller.ts");
  assert.match(ctl, /@Body\(UploadDocumentDto\) body: UploadDocumentDto/);
  assert.match(ctl, /this\.upstream\.forwardUpload\(req, res, "docs-service", body\)/);
  assert.match(ctl, /this\.upstream\.forwardDownload\(req, res, "docs-service", \{ maxResponseBytes: 104857600 \}\)/);
  assert.match(read(gw, "src/routes/docs/ROUTES.pso.ts"), /scopes: \["documents:write"\][\s\S]*scopes: \["documents:read"\]/);
  const v = await pso(root, "validate");
  assert.equal(v.code, 0, v.out + v.err);
  prepare(gw); // tsc with decorators and metadata: the generated code uses real, exported APIs
  assert.ok(existsSync(join(gw, "dist/routes/docs/docs.controller.js")));
});

test("storage:enable and storage:validate: starter, provider SDK, settings, safe local profiles; idempotent; misconfiguration is reported", { timeout: 120_000 }, async () => {
  const { root, svc } = await workspace();
  const none = await pso(root, "storage:enable", "ftp", "--service", "docs-service");
  assert.equal(none.code, 1);
  assert.equal((await pso(root, "storage:enable", "local", "--service", "docs-service", "--root", "../../etc")).code, 1, "a root outside the service is refused");
  assert.equal((await pso(root, "storage:enable", "s3", "--service", "docs-service", "--bucket", "Not_A_Bucket")).code, 1);
  const dry = await pso(root, "storage:enable", "s3", "--service", "docs-service", "--dry-run");
  assert.equal(dry.code, 0); assert.ok(!/pso-storage/.test(read(svc, "pom.xml")), "dry run changes nothing");
  const r = await pso(root, "storage:enable", "s3", "--service", "docs-service", "--bucket", "acme-hr-documents", "--region", "eu-west-1");
  assert.equal(r.code, 0, r.out + r.err);
  const pom = read(svc, "pom.xml");
  for (const a of ["pso-storage-spring-boot-starter", "<artifactId>s3</artifactId>"]) assert.ok(pom.includes(a), a);
  assert.ok(!/<artifactId>s3<\/artifactId>\s*<version>/.test(pom), "SDK versions come from the BOM");
  const yml = read(svc, "src/main/resources/application.yml");
  assert.match(yml, /storage:[^\n]*\n    provider: s3\n    s3:\n      bucket: acme-hr-documents\n      region: eu-west-1/);
  assert.match(yml, /multipart:\n      enabled: true/);
  assert.ok(!/secret|access-key|AKIA/i.test(yml.replace(/never put keys here/i, "")), "no credentials are ever written");
  assert.match(read(svc, "src/main/resources/application-local.yml"), /storage:[^\n]*\n    provider: local\n    local:\n      root: \.\/\.storage/);
  assert.match(read(svc, "src/main/resources/application-test.yml"), /provider: local\n    local:\n      root: \.\/target\/test-storage/);
  assert.match(read(svc, ".gitignore"), /\/\.storage\//);
  const again = await pso(root, "storage:enable", "s3", "--service", "docs-service");
  assert.match(again.out, /already uses s3/);
  const ok = await pso(root, "storage:validate");
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal((await pso(root, "validate")).code, 0, "the pso.storage keys are part of the strict schema");

  // misconfiguration
  const prod = join(svc, "src/main/resources/application-prod.yml");
  const base = read(prod);
  writeFileSync(prod, base + "\npso:\n  storage:\n    provider: azure\n    azure:\n      container: docs\n      connection-string: DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==\n    upload:\n      max-size: 50MB\n    signed-url:\n      enabled: true\n      max-ttl: 12h\n");
  const bad = await pso(root, "storage:validate", "--json");
  assert.equal(bad.code, 1);
  const ids = (JSON.parse(bad.out) as { services: Array<{ findings: Array<{ id: string }> }> }).services[0]!.findings.map((f) => f.id);
  for (const id of ["STO006", "STO008", "STO010"]) assert.ok(ids.includes(id), `${id} in ${ids.join(",")}`);
  assert.ok(!bad.out.includes("abcdefghijklmnopqrstuvwxyz"), "secret values are never printed");
  writeFileSync(prod, base);
  const typo = join(svc, "src/main/resources/application.yml");
  writeFileSync(typo, read(typo).replace("    provider: s3\n", "    provider: s3\n    bukket: x\n"));
  const t = await pso(root, "storage:validate");
  assert.equal(t.code, 1); assert.match(t.out, /SPR002[\s\S]*bukket/);
});

test("make:files + storage:enable generate a Spring files controller and test that compile and pass against the real framework (local provider)", { skip: skipJava, timeout: 900_000 }, async () => {
  const { root, svc } = await workspace();
  const pre = await pso(root, "make:files", "documents", "--service", "docs-service", "--mime", "application/pdf");
  assert.equal(pre.code, 1); assert.match(pre.out + pre.err, /storage:enable/);
  assert.equal((await pso(root, "storage:enable", "local", "--service", "docs-service")).code, 0);
  for (const [args, re] of [[["--mime", "application/x-msdownload"], /cannot verify/], [[], /--mime is required/], [["--mime", "application/pdf", "--route", "/"], /Invalid --route/], [["--mime", "application/pdf", "--ext", "../x"], /Invalid --ext/]] as const) {
    const r = await pso(root, "make:files", "documents", "--service", "docs-service", ...args);
    assert.equal(r.code, 1); assert.match(r.out + r.err, re);
  }
  const r = await pso(root, "make:files", "documents", "--service", "docs-service", "--mime", "application/pdf", "--ext", ".pdf", "--max-size", "4MB");
  assert.equal(r.code, 0, r.out + r.err);
  const ctl = read(svc, "src/main/java/com/pso/docs_service/routes/DocumentsFilesController.java".replace("docs_service", "docsservice") );
  assert.match(ctl, /UploadPolicy\.of\(4194304L\)\.withContentTypes\("application\/pdf"\)\.withExtensions\("\.pdf"\)/);
  assert.match(ctl, /@PreAuthorize\("hasAuthority\('SCOPE_documents:write'\)"\)/);
  assert.match(ctl, /FileDownloads\.response\(content, props\.getStorage\(\)\.getDownload\(\)\.getInlineContentTypes\(\)\)/);
  assert.equal((await pso(root, "storage:validate")).code, 0);
  const t = mvnw(svc, "test");
  const out = t.stdout + t.stderr;
  assert.equal(t.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run/.test(l)).slice(0, 25).join("\n"));
  assert.match(out, /DocumentsFilesControllerTests/);
  assert.ok([...out.matchAll(/Tests run: (\d+), Failures: 0, Errors: 0/g)].some((m) => Number(m[1]) >= 5), "the generated files tests ran and passed");
});
