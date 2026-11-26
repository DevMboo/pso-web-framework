// D3 regression: a Node service in the generated container topology receives its secrets as files (/run/secrets/<NAME>) and reads the
// ones named in PSO_SECRET_FILES into variables before any configuration is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecretFiles, SecretFilesError } from "../src/secret-files.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pso-secret-files-"));

test("the listed files become variables (trailing newline removed); a value the platform already set is kept", () => {
  const d = dir();
  writeFileSync(join(d, "REDIS_URL"), "redis://default:pw@redis:6379/0\n");
  writeFileSync(join(d, "PSO_CHANNELS_BUS_SECRET"), "x".repeat(40));
  const env: NodeJS.ProcessEnv = { PSO_SECRETS_DIR: d, PSO_SECRET_FILES: "REDIS_URL,PSO_CHANNELS_BUS_SECRET", PSO_CHANNELS_BUS_SECRET: "from-the-platform" };
  const r = loadSecretFiles(env);
  assert.deepEqual(r, { loaded: ["REDIS_URL"], kept: ["PSO_CHANNELS_BUS_SECRET"] });
  assert.equal(env["REDIS_URL"], "redis://default:pw@redis:6379/0");
  assert.equal(env["PSO_CHANNELS_BUS_SECRET"], "from-the-platform");
});

test("nothing listed: nothing read", () => {
  assert.deepEqual(loadSecretFiles({}), { loaded: [], kept: [] });
});

test("a missing or empty file, or a name that is not a variable, stops the start-up and names the problem, never a value", () => {
  const d = dir();
  writeFileSync(join(d, "EMPTY"), "");
  assert.throws(() => loadSecretFiles({ PSO_SECRETS_DIR: d, PSO_SECRET_FILES: "MISSING,EMPTY,../etc/passwd" }), (e: unknown) => e instanceof SecretFilesError && e.problems.length === 3 && /MISSING: .* cannot be read/.test(e.problems[0]!) && /EMPTY: .* is empty/.test(e.problems[1]!) && /is not a variable name/.test(e.problems[2]!));
});
