import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainSshFailure, inspectKeyFile, parseIcacls, repairKeyFile } from "../src/keyaccess.ts";

test("OpenSSH's own refusal is recognized and turned into the next step", () => {
  const e = explainSshFailure("@@@@ WARNING: UNPROTECTED PRIVATE KEY FILE! @@@@\nPermissions for 'C:\k.pem' are too open.\nThis private key will be ignored.", "azure");
  assert.equal(e?.code, "KEY_PERMISSIONS"); assert.match(e!.advice, /pso connection:key azure/); assert.match(e!.advice, /changes only that file/);
  assert.equal(explainSshFailure("Load key \"/k\": invalid format")?.code, "KEY_UNREADABLE");
  assert.equal(explainSshFailure("Permission denied (publickey)."), undefined, "an authentication failure is not a key-permission problem");
});

test("icacls output is parsed into principals and rights", () => {
  const out = "C:\k\key.pem BUILTIN\Users:(I)(R)\n              NT AUTHORITY\SYSTEM:(I)(F)\n              LAB\ana:(I)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n";
  assert.deepEqual(parseIcacls(out, "C:\k\key.pem").map((r) => r.principal), ["BUILTIN\Users", "NT AUTHORITY\SYSTEM", "LAB\ana"]);
});

test("a missing key file is reported, never created", () => { const k = inspectKeyFile(join(tmpdir(), "pso-no-such-key.pem")); assert.equal(k.verdict, "missing"); assert.deepEqual(k.plan, []); });

test("diagnosis changes nothing; repair needs confirmation, touches only that file and is measured afterwards", { skip: process.platform === "linux" || process.platform === "darwin" ? false : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-keyaccess-")); const key = join(dir, "test.pem"); const other = join(dir, "other.txt");
  try {
    writeFileSync(key, "not a real key\n"); writeFileSync(other, "x\n");
    if (process.platform === "win32") { assert.equal(spawnSync("icacls", [key, "/grant", "*S-1-5-32-545:(R)"]).status, 0); } else chmodSync(key, 0o644);
    const before = inspectKeyFile(key); assert.equal(before.verdict, "too-open"); assert.ok(before.unsafe.length > 0); assert.ok(before.plan.length > 0);
    assert.equal(inspectKeyFile(key).verdict, "too-open", "inspecting twice changed nothing");
    assert.throws(() => repairKeyFile(key, { confirm: false }), /explicit confirmation/);
    assert.equal(inspectKeyFile(key).verdict, "too-open", "a refused repair changed nothing");
    const r = repairKeyFile(key, { confirm: true }); assert.equal(r.repaired, true); assert.ok(r.ran.length > 0); assert.equal(r.after.verdict, "ok");
    assert.equal(repairKeyFile(key, { confirm: true }).repaired, false, "a second repair has nothing to do");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
