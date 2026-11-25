import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { askpassEnv } from "../src/ssh.ts";

/** The temporary SSH askpass helper: owner-only, no secret on disk, bounded by the ssh child's life, removed afterwards. */
test("the secret is only in the child's environment, never in a file; the helper is private and is removed by cleanup", () => {
  const secret = "Sup3r-S3cret-Passw0rd-xyz";
  const a = askpassEnv({ password: secret }); const launcher = a.env["SSH_ASKPASS"]!; const dir = dirname(launcher);
  assert.equal(a.env["PSO_SSH_SECRET"], secret); assert.equal(a.env["SSH_ASKPASS_REQUIRE"], "force");
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(`${dir}/${f}`, "utf8"), new RegExp(secret), `${f} must not contain the secret`);
  assert.doesNotMatch(readFileSync(launcher, "utf8"), /Passw0rd/);
  if (process.platform !== "win32") { assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(launcher).mode & 0o777, 0o700); for (const f of readdirSync(dir)) assert.equal(statSync(`${dir}/${f}`).mode & 0o077, 0, `${f} is not accessible to group/other`); }
  assert.ok(existsSync(dir)); a.cleanup(); assert.equal(existsSync(dir), false, "the directory is gone after cleanup"); a.cleanup(); // idempotent
});
test("no secret, no helper: nothing is created when ssh needs no password or passphrase", () => {
  const a = askpassEnv(undefined); assert.deepEqual(a.env, {}); a.cleanup();
  assert.deepEqual(askpassEnv({}).env, {});
});
