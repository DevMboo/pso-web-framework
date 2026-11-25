import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envelopeProblem } from "../src/index.ts";

/** fixtures/contracts/channels/envelope.json is the contract between the Java publisher and this hub; the Java tests read the same file. */
const fx = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/contracts/channels/envelope.json"), "utf8")) as {
  allowedKeys: string[]; valid: Array<{ name: string; envelope: unknown }>; invalid: Array<{ name: string; envelope: unknown }>;
};

test("shared fixture: every valid envelope is accepted and every invalid one refused", () => {
  for (const v of fx.valid) assert.equal(envelopeProblem(v.envelope, 65_536), undefined, v.name);
  for (const i of fx.invalid) assert.ok(envelopeProblem(i.envelope, 65_536), i.name);
  for (const v of fx.valid) for (const k of Object.keys(v.envelope as object)) assert.ok(fx.allowedKeys.includes(k), `${v.name}: ${k}`);
});
