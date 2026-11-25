import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PSO_JAVA_VERSION } from "../src/specs.ts";

// An installed CLI generates services for one fixed PSO Java release, never for "the newest one found" or a development SNAPSHOT.
test("the CLI is bound to a fixed PSO Java release, and the source has no fallback to a locally found version", () => {
  assert.match(PSO_JAVA_VERSION, /^\d+\.\d+\.\d+(-rc\.\d+)?$/);
  assert.doesNotMatch(PSO_JAVA_VERSION, /SNAPSHOT/i);
  const src = readFileSync(resolve(import.meta.dirname, "..", "src", "specs.ts"), "utf8");
  const fn = src.slice(src.indexOf("export function psoJavaVersion"), src.indexOf("export function psoJavaInstalled"));
  assert.doesNotMatch(fn, /newestBomVersion|\.m2|SNAPSHOT/, "psoJavaVersion() never picks a version from the machine");
  assert.match(fn, /return PSO_JAVA_VERSION;/);
});
