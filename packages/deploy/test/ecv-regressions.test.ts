import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud, LocalStore, MemoryCredentialProvider } from "../src/index.ts";
import { validateDeployment } from "../src/declare.ts";

/** Defects found while validating on a real Azure server, each pinned by a test. */
test("a directory artifact is packed with whatever `tar` is on PATH, including GNU tar on Windows (an absolute C:\ output path was read as a remote host)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-pack-")); mkdirSync(join(dir, "app")); writeFileSync(join(dir, "app", "a.txt"), "hello");
  const calls: Array<{ op: string; args: any }> = [];
  const fake = { call: async (op: string, args: any) => { calls.push({ op, args }); return op === "artifact.begin" ? { uploadId: "u1" } : {}; } };
  const cloud = new Cloud({ store: new LocalStore(mkdtempSync(join(tmpdir(), "pso-pack-home-"))), creds: new MemoryCredentialProvider() });
  const r = await cloud.prepareSource(fake as never, { name: "x", environment: "testing", connection: { provider: "ssh", credentials: "c" }, source: { provider: "artifact", path: "app" }, strategy: { type: "recreate", proxy: "none", downtimeAcknowledged: true } } as never, dir);
  assert.ok(r && r.size > 20 && /^[0-9a-f]{64}$/.test(r.sha256), "the directory was packed and uploaded");
  assert.deepEqual(calls.map((c) => c.op).filter((o, i, a) => a.indexOf(o) === i), ["artifact.begin", "artifact.chunk", "artifact.commit"]);
});
const decl = (over: any) => ({ name: "app", environment: "testing", connection: { provider: "ssh", credentials: "c" }, source: { provider: "git", url: "file:///x.git", branch: "main" }, strategy: { type: "blue-green", proxy: "nginx" }, ...over });
const svc = (workload?: any) => ({ name: "web", runtime: "java", start: ["java", "-jar", "app.jar"], port: 21999, shutdownGraceSeconds: 5, ...(workload ? { workload } : {}) });
const errs = (d: unknown) => validateDeployment(d).filter((x) => x.level === "error").map((x) => x.code);
test("a self-migrating service declares expand-contract WITHOUT a command (the application runs its own Flyway); anything else still needs one", () => {
  assert.deepEqual(errs(decl({ service: svc({ selfMigrates: true }), migrations: { mode: "expand-contract" } })), []);
  assert.ok(errs(decl({ service: svc(), migrations: { mode: "expand-contract" } })).includes("PSO-DEC-MIGRATION"), "without selfMigrates PSO would have to run a command, so one is required");
});

test("the redactor keeps the NON-secret facts whose names contain 'credential' (which store is in use, a credential version) and still masks real secrets", async () => {
  const { redactValue } = await import("../src/redact.ts");
  const r = redactValue({ credentialStore: { id: "windows-credential-manager", available: true }, credentialVersion: 3, password: "hunter2-hunter2", authorization: "Bearer abc.def.ghi", nested: { apiToken: "t0k3n-value-xyz" } }) as any;
  assert.deepEqual(r.credentialStore, { id: "windows-credential-manager", available: true }); assert.equal(r.credentialVersion, 3);
  assert.equal(r.password, "[REDACTED]"); assert.equal(r.authorization, "[REDACTED]"); assert.equal(r.nested.apiToken, "[REDACTED]");
});
