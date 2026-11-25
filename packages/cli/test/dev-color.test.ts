import assert from "node:assert/strict";
import { test } from "node:test";
import { devColor, stripAnsi, terminalLine } from "../src/dev.ts";

test("devColor: on for a terminal, off for pipes, NO_COLOR, CI and PSO_LOG_COLOR=never", () => {
  assert.equal(devColor({}, true), true);
  assert.equal(devColor({}, false), false);
  assert.equal(devColor({ NO_COLOR: "1" }, true), false);
  assert.equal(devColor({ CI: "true" }, true), false);
  assert.equal(devColor({ TERM: "dumb" }, true), false);
  assert.equal(devColor({ PSO_LOG_COLOR: "never" }, true), false);
  assert.equal(devColor({ PSO_LOG_COLOR: "always" }, false), true);
  assert.equal(devColor({ FORCE_COLOR: "1" }, false), true);
  assert.equal(devColor({ FORCE_COLOR: "0" }, true), false);
});

test("terminalLine: coloured prefix, JSON re-formatted for the terminal, plain when colour is off", () => {
  assert.equal(terminalLine("catalog", 0, "hello", false), "[catalog] hello");
  const spring = terminalLine("catalog", 0, "\u001b[32m INFO\u001b[0m started", true);
  assert.match(spring, /^\u001b\[36m\[catalog\]\u001b\[0m /);
  assert.ok(spring.includes("started"));
  const json = terminalLine("orchestrator", 1, JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", level: "error", msg: "boom", status: 500 }), true);
  assert.match(json, /^\u001b\[35m\[orchestrator\]/);
  assert.ok(!json.includes('"level"'));
  assert.ok(json.includes("boom") && json.includes("\u001b["));
});

test("stripAnsi removes escape codes so log files stay clean", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m text"), "red text");
});
