import { test } from "node:test";
import assert from "node:assert/strict";
import jwtGuard from "../src/.app/guards/jwt.guard";

// src/.app is compiled like the rest of src/ (tsconfig.json includes "src/.app/**/*": TypeScript skips dot-directories otherwise)
test("the application-wide components in src/.app are compiled", () => {
  assert.equal(typeof jwtGuard, "function", "the jwt guard is a function");
});
