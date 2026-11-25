import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLogConfig, formatLine, redact, redactString, log, configureLogging, setLogSink, resetLogging, LogConfigError, REDACTED } from "../src/index.ts";

const ANSI = /\u001b\[/;
const at = new Date("2026-11-08T14:15:46.636Z");
const JWT_SAMPLE = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

test("configuration: defaults follow the terminal, NO_COLOR / FORCE_COLOR / CI / PSO_LOG_COLOR decide colour, JSON never has colour", () => {
  assert.deepEqual(loadLogConfig({}, true), { level: "info", format: "pretty", color: true, stack: false });
  assert.deepEqual(loadLogConfig({}, false), { level: "info", format: "json", color: false, stack: false });
  assert.equal(loadLogConfig({ NO_COLOR: "1" }, true).color, false, "NO_COLOR wins over a terminal");
  assert.equal(loadLogConfig({ CI: "true" }, true).color, false, "CI is not a colour terminal");
  assert.equal(loadLogConfig({ TERM: "dumb" }, true).color, false);
  assert.equal(loadLogConfig({ FORCE_COLOR: "1", PSO_LOG_FORMAT: "pretty" }, false).color, true, "FORCE_COLOR colours a redirect when the format is pretty");
  assert.equal(loadLogConfig({ FORCE_COLOR: "0", PSO_LOG_FORMAT: "pretty" }, true).color, false, "FORCE_COLOR=0 turns colour off");
  assert.equal(loadLogConfig({ PSO_LOG_COLOR: "always", PSO_LOG_FORMAT: "pretty", NO_COLOR: "1" }, false).color, true, "an explicit PSO_LOG_COLOR=always is the user's decision");
  assert.equal(loadLogConfig({ PSO_LOG_COLOR: "never" }, true).color, false);
  assert.equal(loadLogConfig({ PSO_LOG_COLOR: "detect" }, true).color, true, "detect is the Spring spelling of auto");
  assert.equal(loadLogConfig({ PSO_LOG_COLOR: "always", PSO_LOG_FORMAT: "json" }, true).color, false, "JSON output never contains escape codes");
  assert.equal(loadLogConfig({ PSO_LOG_LEVEL: "debug" }, true).stack, true);
  for (const bad of [{ PSO_LOG_LEVEL: "loud" }, { PSO_LOG_FORMAT: "xml" }, { PSO_LOG_COLOR: "sometimes" }]) assert.throws(() => loadLogConfig(bad), LogConfigError);
});

test("pretty output: timestamp, level, component, message, correlation id and structured context; colour only when enabled", () => {
  const plain = { level: "info", format: "pretty", color: false, stack: false } as const;
  const line = formatLine(plain, "info", "request", { component: "http", correlationId: "corr-1234", method: "GET", path: "/users/42", status: 200, ms: 3.2 }, at);
  assert.equal(line, "2026-11-08 14:15:46.636 INFO  [http] request (corr-1234)  method=GET path=/users/42 status=200 ms=3.2");
  assert.ok(!ANSI.test(line));
  const colour = formatLine({ ...plain, color: true }, "warn", "slow upstream", { component: "upstream", service: "users" }, at);
  assert.ok(colour.includes("\u001b[33mWARN \u001b[0m"), "warn is yellow");
  assert.ok(formatLine({ ...plain, color: true }, "error", "boom", {}, at).includes("\u001b[31mERROR\u001b[0m"));
  assert.ok(formatLine({ ...plain, color: true }, "info", "ok", {}, at).includes("\u001b[32mINFO \u001b[0m"));
  assert.ok(formatLine({ ...plain, color: true }, "debug", "d", {}, at).includes("\u001b[36mDEBUG\u001b[0m"));
  assert.ok(formatLine({ ...plain, color: true }, "trace", "t", {}, at).includes("\u001b[90mTRACE\u001b[0m"));
  assert.ok(formatLine({ ...plain, color: true }, "fatal", "f", {}, at).includes("\u001b[1;97;41mFATAL\u001b[0m"));
  assert.match(formatLine(plain, "info", "has spaces", { note: "two words", n: 1 }, at), /note="two words" n=1$/);
});

test("JSON output is one parseable object per line with ts, level, msg and the context, and no escape codes", () => {
  const cfg = { level: "info", format: "json", color: false, stack: false } as const;
  const o = JSON.parse(formatLine(cfg, "warn", "upstream slow", { component: "upstream", service: "users", ms: 812 }, at)) as Record<string, unknown>;
  assert.deepEqual(o, { ts: "2026-11-08T14:15:46.636Z", level: "warn", msg: "upstream slow", component: "upstream", service: "users", ms: 812 });
  assert.ok(!ANSI.test(formatLine({ ...cfg }, "error", "x", { a: 1 }, at)));
});

test("redaction: sensitive keys, bearer tokens, JWTs, URL credentials and key=value secrets never reach the output", () => {
  const ctx = { authorization: `Bearer ${JWT_SAMPLE}`, password: "hunter2", apiKey: "k-123", nested: { token: "t", safe: "visible", url: "postgresql://app:s3cret@db:5432/app" }, list: [{ Cookie: "sid=abc" }], note: `failed with token=abc123 and ${JWT_SAMPLE}` };
  for (const format of ["json", "pretty"] as const) {
    const out = formatLine({ level: "info", format, color: false, stack: false }, "info", `calling https://user:pw@host/path with Bearer ${JWT_SAMPLE}`, ctx, at);
    for (const secret of ["hunter2", "k-123", "s3cret", "sid=abc", "abc123", JWT_SAMPLE, "user:pw", "eyJhbGci"]) assert.ok(!out.includes(secret), `${format}: ${secret} must not appear\n${out}`);
    assert.ok(out.includes("visible") && out.includes(REDACTED));
  }
  assert.equal(redactString("Authorization: Basic dXNlcjpwYXNzd29yZA=="), `Authorization: Basic ${REDACTED}`);
  const circular: Record<string, unknown> = { a: 1 }; circular["self"] = circular;
  assert.doesNotThrow(() => redact(circular));
});

test("errors keep name, message and code; stack traces only at debug/trace and bounded; secrets in messages are redacted", () => {
  const err = Object.assign(new Error(`connect failed: redis://user:pw@host:6379 token=abc`), { code: "ECONNREFUSED" });
  const info = JSON.parse(formatLine({ level: "info", format: "json", color: false, stack: false }, "error", "broker failure", { error: err }, at)) as { error: Record<string, unknown> };
  assert.equal(info.error["name"], "Error"); assert.equal(info.error["code"], "ECONNREFUSED"); assert.equal(info.error["stack"], undefined);
  assert.ok(!JSON.stringify(info).includes("pw@") && !JSON.stringify(info).includes("token=abc"));
  const dbg = JSON.parse(formatLine({ level: "debug", format: "json", color: false, stack: true }, "error", "broker failure", { error: err }, at)) as { error: { stack: string[] } };
  assert.ok(Array.isArray(dbg.error.stack) && dbg.error.stack.length <= 8);
  const pretty = formatLine({ level: "debug", format: "pretty", color: false, stack: true }, "error", "broker failure", { error: err }, at);
  assert.match(pretty, /\n {4}at /);
});

test("the process logger filters by level, honours silent, keeps the existing log(level, msg, context) call shape and accepts unknown levels as info", () => {
  const lines: string[] = [];
  try {
    setLogSink((l) => lines.push(l));
    configureLogging({ PSO_LOG_LEVEL: "warn", PSO_LOG_FORMAT: "json" }, false);
    log("info", "hidden"); log("debug", "hidden"); log("warn", "shown", { component: "x" }); log("error", "shown too");
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as { msg: string }).msg), ["shown", "shown too"]);
    lines.length = 0;
    configureLogging({ PSO_LOG_LEVEL: "silent", PSO_LOG_FORMAT: "json" }, false);
    log("fatal", "nothing"); assert.deepEqual(lines, []);
    configureLogging({ PSO_LOG_LEVEL: "trace", PSO_LOG_FORMAT: "json" }, false);
    log("whatever", "as info"); assert.equal((JSON.parse(lines[0]!) as { level: string }).level, "info");
    assert.throws(() => configureLogging({ PSO_LOG_LEVEL: "nope" }, false), LogConfigError);
  } finally { resetLogging(); }
});
