import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud, LocalStore, MemoryCredentialProvider, type AddConnectionSpec, type ConnectionRecord } from "@pso/deploy";
import { ALL_COMMANDS } from "../src/registry.ts";
import { setCloudFactory, setInput, defaultInput } from "../src/commands-cloud.ts";
import { startStudio } from "../src/studio.ts";
import { pso, tmp } from "./helpers.ts";

/** The CLI and Studio side of Cloud Lifecycle and Operations: usage rules, secret handling, confirmations, the Studio gate. No server is contacted. */
const FP = "SHA256:" + "Q".repeat(43);
class FakeCloud extends Cloud {
  added: Array<{ spec: AddConnectionSpec; fp: string }> = [];
  override hostKeys(): ReturnType<Cloud["hostKeys"]> { return [{ type: "ed25519", fingerprint: FP, line: "x" }, { type: "rsa", fingerprint: "SHA256:" + "R".repeat(43), line: "y" }]; }
  override add(spec: AddConnectionSpec, fp: string): ConnectionRecord {
    this.added.push({ spec, fp });
    if (spec.password) this.creds().set("cred_fake", spec.password);
    const rec: ConnectionRecord = { name: spec.name, host: spec.host, port: spec.port ?? 22, user: spec.user, auth: { kind: spec.auth }, timeoutSeconds: 15, agentDir: ".pso-agent", createdAt: "", credentialVersion: 1, hostKeyFingerprint: fp };
    this.store.saveConnection(rec); return rec;
  }
}
const fake = (): FakeCloud => new FakeCloud({ store: new LocalStore(mkdtempSync(join(tmpdir(), "pso-cc-"))), creds: new MemoryCredentialProvider() });

const DECL = (extra = "") => `import { defineDeployment } from "@pso/deploy";\nexport default defineDeployment({ name: "shop", environment: "production", connection: { provider: "ssh", credentials: "prod" }, source: { provider: "git", url: "https://git.example.com/shop.git", branch: "main" }, service: { name: "web", runtime: "node", start: ["node", "server.js"], shutdownGraceSeconds: 20 }, strategy: { type: "blue-green", proxy: "nginx" }${extra} });\n`;

test("the local deploy commands keep their meaning; the remote lifecycle uses its own commands", async () => {
  assert.match(ALL_COMMANDS["deploy"]!.usage, /--target native/); assert.match(ALL_COMMANDS["deploy:plan"]!.usage, /--target native/); assert.match(ALL_COMMANDS["deploy:init"]!.usage, /--target <kubernetes\|ecs/); assert.match(ALL_COMMANDS["rollback"]!.usage, /--dir <path>/);
  const dir = tmp(); const r = await pso(dir, "deploy:init");
  assert.notEqual(r.code, 0, "deploy:init still behaves as before: it needs a workspace and --target");
  for (const c of ["connection:add", "agent:install", "environment:add", "pipeline:validate", "release:plan", "release:deploy", "release:rollback", "release:recover"]) assert.ok(ALL_COMMANDS[c], c);
});

test("environment:add scaffolds valid declarations without credentials and never overwrites silently", async () => {
  const dir = tmp("pso-env-");
  const dry = await pso(dir, "environment:add", "production", "--connection", "prod", "--repo", "https://git.example.com/shop.git", "--domain", "shop.example.com", "--dry-run");
  assert.equal(dry.code, 0, dry.err); assert.ok(!existsSync(join(dir, "deploy")), "a dry run writes nothing");
  const r = await pso(dir, "environment:add", "production", "--connection", "prod", "--repo", "https://git.example.com/shop.git", "--domain", "shop.example.com"); assert.equal(r.code, 0, r.err);
  const dep = readFileSync(join(dir, "deploy", "production.deployment.pso.ts"), "utf8"); assert.match(dep, /defineDeployment/); assert.match(dep, /"credentials": "prod"/); assert.match(dep, /shop\.example\.com/); assert.doesNotMatch(dep, /password|token|BEGIN/i);
  assert.ok(existsSync(join(dir, "deploy", "production.pipeline.pso.ts")));
  const v = await pso(dir, "pipeline:validate", "--json"); assert.equal(v.code, 0, v.out + v.err); assert.equal(JSON.parse(v.out).ok, true);
  writeFileSync(join(dir, "deploy", "production.deployment.pso.ts"), "// edited by hand\n" + dep);
  const again = await pso(dir, "environment:add", "production", "--connection", "prod", "--repo", "https://git.example.com/other.git"); assert.match(again.out, /exists \(kept/);
  assert.match(readFileSync(join(dir, "deploy", "production.deployment.pso.ts"), "utf8"), /edited by hand/, "an existing file is kept unless --force");
  const rec = await pso(dir, "environment:add", "stg", "--connection", "stg", "--repo", "https://git.example.com/shop.git", "--strategy", "recreate"); assert.equal(rec.code, 0, rec.err);
  assert.match(readFileSync(join(dir, "deploy", "stg.deployment.pso.ts"), "utf8"), /"downtimeAcknowledged": true/);
  const list = await pso(dir, "environment:list", "--json"); assert.equal(JSON.parse(list.out).length, 2);
});

test("pipeline:validate refuses computed values and credentials in declarations", async () => {
  const dir = tmp("pso-val-"); mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "production.deployment.pso.ts"), DECL().replace(`name: "shop"`, `name: process.env.APP`));
  let r = await pso(dir, "pipeline:validate"); assert.equal(r.code, 1); assert.match(r.out, /PSO-DEC-STATIC|not a literal/);
  writeFileSync(join(dir, "deploy", "production.deployment.pso.ts"), DECL().replace("https://git.example.com/shop.git", "https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@git.example.com/shop.git"));
  r = await pso(dir, "pipeline:validate"); assert.equal(r.code, 1); assert.match(r.out, /looks like a credential/); assert.match(r.out, /must not be embedded/);
  writeFileSync(join(dir, "deploy", "production.deployment.pso.ts"), DECL().replace(`strategy: { type: "blue-green", proxy: "nginx" }`, `strategy: { type: "blue-green", proxy: "none" }`));
  r = await pso(dir, "pipeline:validate"); assert.equal(r.code, 1); assert.match(r.out, /blue-green needs a reverse proxy/);
});

test("secrets are never arguments; state-changing commands need --yes (exit 3); unknown options are usage errors (exit 2)", async () => {
  const dir = tmp("pso-sec-"); setCloudFactory(fake);
  for (const flag of ["--password", "--passphrase", "--token", "--secret", "--private-key"]) {
    const r = await pso(dir, "connection:add", "prod", "--host", "h.example", "--user", "u", flag, "hunter2-value"); assert.equal(r.code, 2, flag); assert.match(r.err, /Unknown option/); assert.ok(!r.out.includes("hunter2") );
  }
  assert.equal((await pso(dir, "connection:add", "prod", "--host", "h", "--user", "u", "--auth", "password")).code, 1, "password auth needs stdin, never a flag");
  mkdirSync(join(dir, "deploy")); writeFileSync(join(dir, "deploy", "production.deployment.pso.ts"), DECL());
  for (const argv of [["agent:install", "prod", "--mode", "protected", "--environment", "production"], ["connection:revoke", "prod"], ["connection:remove", "prod"], ["release:rollback", "production"], ["release:recover", "production"], ["release:deploy", "production", "--plan", "a".repeat(64)], ["environment:provision", "production"], ["agent:upgrade", "prod"], ["agent:uninstall", "prod"]]) {
    const r = await pso(dir, ...argv); assert.equal(r.code, 3, `${argv[0]} without --yes`); assert.match(r.err, /explicit authorization/);
  }
  assert.equal((await pso(dir, "agent:install", "prod", "--environment", "production", "--yes")).code, 1, "--mode is mandatory: remote management is disabled by default");
  assert.equal((await pso(dir, "release:plan", "production", "extra-word")).code, 2);
  assert.equal((await pso(dir, "release:plan", "production", "--branch", "a", "--tag", "b")).code, 1);
  assert.equal((await pso(dir, "release:service", "production", "frobnicate", "x")).code, 1);
});

test("connection:add: the host key must be approved by a person, the password goes through the secret reader only, and nothing secret is printed", async () => {
  const dir = tmp("pso-add-"); const cloud = fake(); setCloudFactory(() => cloud);
  setInput({ ...defaultInput, interactive: false, secret: async () => "Sup3r-Pass-Word-1234", confirm: async () => false });
  let r = await pso(dir, "connection:add", "prod", "--host", "203.0.113.5", "--user", "deploy", "--auth", "password", "--password-stdin");
  assert.equal(r.code, 3, "a non-interactive shell cannot approve a host key"); assert.match(r.err, new RegExp(FP)); assert.equal(cloud.added.length, 0);
  r = await pso(dir, "connection:add", "prod", "--host", "203.0.113.5", "--user", "deploy", "--auth", "password", "--password-stdin", "--accept-host-key", "SHA256:" + "Z".repeat(43));
  assert.equal(r.code, 1); assert.match(r.err, /does not present the host key/); assert.equal(cloud.added.length, 0);
  r = await pso(dir, "connection:add", "prod", "--host", "203.0.113.5", "--user", "deploy", "--auth", "password", "--password-stdin", "--accept-host-key", FP);
  assert.equal(r.code, 0, r.err); assert.equal(cloud.added[0]!.fp, FP); assert.equal(cloud.added[0]!.spec.password, "Sup3r-Pass-Word-1234");
  assert.ok(!(r.out + r.err).includes("Sup3r-Pass"), "the password is never printed"); assert.match(r.out, /host key pinned/);
  const list = await pso(dir, "connection:list", "--json"); assert.ok(!list.out.includes("Sup3r-Pass") && !list.out.includes("cred_fake"), "the list shows references only, not even the opaque ids");
  assert.equal(JSON.parse(list.out)[0].hasPassword, false); // the fake record carries no password reference: the real Cloud.add stores one
  setInput(defaultInput);
});

// ------------------------------------------------------------------ Studio
function call(port: number, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, cookie: `pso_studio=${token}`, ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers } }, (res) => {
      let raw = ""; res.on("data", (d: Buffer) => { raw += d; }); res.on("end", () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : {}, raw }));
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

test("Studio: remote management is off by default, mutations are CSRF-protected, and responses carry no secret", async () => {
  const dir = tmp("pso-st-"); mkdirSync(join(dir, "deploy")); writeFileSync(join(dir, "deploy", "production.deployment.pso.ts"), DECL());
  const off = await startStudio({ root: dir, remote: false, cloud: fake() });
  try {
    const ov = await call(off.port, off.token, "GET", "/api/cloud/overview"); assert.equal(ov.status, 200); assert.equal(ov.body.remoteEnabled, false); assert.equal(ov.body.environments[0].environment, "production");
    assert.equal(ov.body.environments[0].connectionState, "missing", "the page says the connection is missing instead of inventing a status");
    const gone = await call(off.port, off.token, "GET", "/api/cloud/env/production/status"); assert.equal(gone.status, 403); assert.equal(gone.body.code, "REMOTE_DISABLED");
    const post = await call(off.port, off.token, "POST", "/api/cloud/connections", { name: "x" }, { origin: `http://127.0.0.1:${off.port}`, "x-pso-studio": "1" }); assert.equal(post.status, 403); assert.equal(post.body.code, "REMOTE_DISABLED");
    assert.equal((await call(off.port, off.token, "POST", "/api/summary", {}, { origin: `http://127.0.0.1:${off.port}`, "x-pso-studio": "1" })).status, 405, "every other endpoint stays read-only");
  } finally { await off.close(); }
  const cloud = fake(); const on = await startStudio({ root: dir, remote: true, cloud });
  try {
    const good = { origin: `http://127.0.0.1:${on.port}`, "x-pso-studio": "1" };
    assert.equal((await call(on.port, on.token, "POST", "/api/cloud/connections", { name: "x" }, { "x-pso-studio": "1" })).status, 403, "no Origin: refused");
    assert.equal((await call(on.port, on.token, "POST", "/api/cloud/connections", { name: "x" }, { origin: "http://evil.example", "x-pso-studio": "1" })).status, 403, "foreign Origin: refused");
    assert.equal((await call(on.port, on.token, "POST", "/api/cloud/connections", { name: "x" }, { origin: good.origin })).status, 403, "no custom header: refused");
    assert.equal((await call(on.port, "wrong-token", "POST", "/api/cloud/connections", { name: "x" }, good)).status, 403, "no access cookie: refused");
    const keys = await call(on.port, on.token, "GET", "/api/cloud/hostkeys?host=203.0.113.5&port=22"); assert.equal(keys.status, 200); assert.equal(keys.body.keys[0].fingerprint, FP);
    const secret = "Studio-Typed-Passw0rd-9876";
    const add = await call(on.port, on.token, "POST", "/api/cloud/connections", { name: "prod", host: "203.0.113.5", user: "deploy", auth: "password", password: secret, acceptHostKey: FP }, good);
    assert.equal(add.status, 200, add.raw); assert.ok(!add.raw.includes(secret), "the typed password is never sent back"); assert.equal(cloud.added[0]!.fp, FP);
    const after = await call(on.port, on.token, "GET", "/api/cloud/overview"); assert.ok(!after.raw.includes(secret) && !after.raw.includes("cred_fake"));
    assert.equal(after.body.connections[0].name, "prod");
    const noConfirm = await call(on.port, on.token, "POST", "/api/cloud/env/production/deploy", { planHash: "a".repeat(64) }, good); assert.equal(noConfirm.status, 422); assert.equal(noConfirm.body.code, "CONFIRM", "production actions need the environment name typed");
    const big = await call(on.port, on.token, "POST", "/api/cloud/connections", { pad: "x".repeat(300_000) }, good); assert.equal(big.status, 413);
  } finally { await on.close(); }
});
