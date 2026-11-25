import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud, LocalStore, MemoryCredentialProvider } from "@pso/deploy";
import { StudioCloud } from "../src/studio-cloud.ts";

/** The Studio backend is the trusted side: signing keys stay in the credential store, and paths from the browser never leave the workspace. */
function studio(enabled: boolean) {
  const root = mkdtempSync(join(tmpdir(), "pso-studio-sign-")); writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "w", services: [] }));
  mkdirSync(join(root, "deploy"), { recursive: true });
  const decl = { name: "shop", environment: "staging", connection: { provider: "ssh", credentials: "c" }, source: { provider: "git", url: "file:///x.git", branch: "main" }, service: { name: "web", runtime: "node", start: ["node", "a.js"], port: 21999, shutdownGraceSeconds: 5 }, strategy: { type: "recreate", proxy: "none", downtimeAcknowledged: true } };
  writeFileSync(join(root, "deploy", "staging.deployment.pso.ts"), `import { defineDeployment } from "@pso/deploy";\nexport default defineDeployment(${JSON.stringify(decl)});\n`);
  const cloud = new Cloud({ store: new LocalStore(mkdtempSync(join(tmpdir(), "pso-studio-sign-home-"))), creds: new MemoryCredentialProvider() });
  return { s: new StudioCloud({ root, enabled, cloud }), cloud, root };
}

test("signer endpoints: private keys are never returned, listed or logged; removal is local only", async () => {
  const { s, cloud } = studio(true);
  const made = await s.post("/api/cloud/signers", { name: "bot" }); assert.equal(made.status, 200);
  const all = JSON.stringify(made.body); assert.match(all, /SHA256:/); assert.doesNotMatch(all, /PRIVATE KEY|privateRef|private/i);
  const ov = await s.get("/api/cloud/overview", new URLSearchParams()); const text = JSON.stringify(ov.body); assert.match(text, /"signers":\[\{"name":"bot"/); assert.doesNotMatch(text, /PRIVATE KEY|privateRef/);
  assert.equal((await s.post("/api/cloud/signers", { name: "bot" })).status, 422, "no overwrite: rotation is a new key");
  assert.equal(((await s.post("/api/cloud/signers", { name: "bot", remove: true })).body as { removed: boolean }).removed, true); assert.equal(cloud.signers().length, 0);
});

test("with remote management off, the signing endpoints refuse (the browser cannot create keys or change trust)", async () => {
  const { s } = studio(false);
  assert.equal((await s.post("/api/cloud/signers", { name: "bot" })).status, 403);
  assert.equal((await s.post("/api/cloud/env/staging/trust-add", { signer: "bot", confirm: "staging" })).status, 403);
  assert.equal((await s.get("/api/cloud/env/staging/trust", new URLSearchParams())).status, 403);
});

test("a path from the browser is read and written only inside the workspace", async () => {
  const { s } = studio(true);
  for (const p of ["../../etc/passwd", "/etc/passwd", "..\\..\\secret.json", "C:\\Windows\\win.ini"]) {
    const r = await s.post("/api/cloud/env/staging/verify", { signedFile: p, confirm: "staging" }); assert.equal(r.status, 422, p); assert.match(JSON.stringify(r.body), /outside the workspace|cannot read/);
  }
  const r = await s.post("/api/cloud/env/staging/sign", { signer: "nobody", sequence: 1, path: "../..", confirm: "staging" }); assert.equal(r.status, 422); assert.match(JSON.stringify(r.body), /outside the workspace/);
});

test("changing trust or policy needs the typed environment name", async () => {
  const { s } = studio(true);
  for (const [what, body] of [["trust-add", { signer: "bot" }], ["trust-revoke", { keyId: "SHA256:x" }], ["policy-set", { changes: { requireSignedReleases: true } }], ["sign", { signer: "bot", sequence: 1 }]] as const) {
    const r = await s.post(`/api/cloud/env/staging/${what}`, { ...body, confirm: "wrong" }); assert.equal(r.status, 422, what); assert.match(JSON.stringify(r.body), /CONFIRM|type the environment name/);
  }
});
