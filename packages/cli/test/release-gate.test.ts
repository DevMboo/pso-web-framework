import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error plain ESM script (the gate must run without a build step of its own)
import { parseTap, parseSurefire, judge, deploymentTests, releaseApproval, PLATFORM_SKIPS } from "../../../scripts/release-gate.mjs";

/**
 * The release gate: a run in which infrastructure tests were skipped is green for a developer and NOT acceptable for a release.
 * These tests feed the gate real runner output (including a real child run) and check that a skip can never pass silently.
 */
const TAP = `TAP version 13
# Subtest: publishes and consumes
ok 1 - publishes and consumes
  ---
  duration_ms: 12.5
  ...
# Subtest: [redis] dead letter
ok 2 - [redis] dead letter # SKIP no Docker engine: real broker tests not run
# Subtest: an unreadable directory is reported
ok 3 - an unreadable directory is reported # SKIP POSIX permission bits do not apply on Windows
# Subtest: suite
    # Subtest: nested failure
    not ok 1 - nested failure
    # Subtest: nested skip without a reason
    ok 2 - nested skip without a reason # SKIP
not ok 4 - suite
# Subtest: later
ok 5 - later # TODO not written yet
1..5
`;

test("TAP: every test is read with its status and skip reason, nested ones included", () => {
  const tests = parseTap(TAP) as Array<{ name: string; status: string; reason?: string }>;
  assert.deepEqual(tests.map((t) => [t.name, t.status, t.reason]), [
    ["publishes and consumes", "passed", undefined],
    ["[redis] dead letter", "skipped", "no Docker engine: real broker tests not run"],
    ["an unreadable directory is reported", "skipped", "POSIX permission bits do not apply on Windows"],
    ["nested failure", "failed", undefined],
    ["nested skip without a reason", "skipped", "(no reason given)"],
    ["suite", "failed", undefined],
    ["later", "todo", "not written yet"],
  ]);
});

test("verdict: failures block; skipped infrastructure tests block; only platform-inapplicable skips are accepted; an empty run is not a pass", () => {
  const v = judge(parseTap(TAP));
  assert.equal(v.ok, false);
  assert.deepEqual(v.failed.map((t: { name: string }) => t.name), ["nested failure", "suite"]);
  assert.deepEqual(v.blockingSkips.map((t: { name: string }) => t.name), ["[redis] dead letter", "nested skip without a reason", "later"], "a skip without a reason, and a TODO, are not evidence either");
  assert.deepEqual(v.acceptedSkips.map((t: { name: string }) => t.name), ["an unreadable directory is reported"]);

  const green = "ok 1 - a\nok 2 - b # SKIP POSIX permission bits do not apply on Windows\n";
  assert.equal(judge(parseTap(green)).ok, true);
  const silentlySkipped = "ok 1 - a\nok 2 - [kafka] crash recovery # SKIP no Docker engine: real broker tests not run\n";
  assert.equal(judge(parseTap(silentlySkipped)).ok, false, "exit code 0 and all `ok` lines: still not a release");
  assert.equal(judge(parseTap(silentlySkipped), [...PLATFORM_SKIPS, /no Docker engine/]).ok, true, "an explicit, visible --allow-skip is the only way around it");
  assert.equal(judge([]).ok, false, "nothing ran");
  for (const reason of ["no local Redis (node scripts/dispatch-brokers.mjs up)", "JDK not found", "no Chromium-based browser found", "brokers unavailable: the Docker engine is not running", "PSO Java artifacts are not installed: run `pso java:install` first", "the PSO Java ecosystem is not next to the CLI"]) {
    assert.equal(judge([{ name: "x", status: "skipped", reason }]).ok, false, `"${reason}" must block a release`);
  }
});

test("Surefire: Java tests skipped by an assumption (no broker) are found in the reports", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.pso.it.dispatch.DispatchTests" tests="3" errors="0" skipped="1" failures="1">
  <testcase name="contractIsEnforced(String)[1]" classname="com.pso.it.dispatch.DispatchTests" time="0.5"/>
  <testcase name="publishConsume(String)[2]" classname="com.pso.it.dispatch.DispatchTests" time="0">
    <skipped message="Assumption failed: no real rabbitmq available (run: node scripts/dispatch-brokers.mjs up)"/>
  </testcase>
  <testcase name="retry(String)[3]" classname="com.pso.it.dispatch.DispatchTests" time="1.2">
    <failure message="expected &lt;3&gt;" type="java.lang.AssertionError">trace</failure>
  </testcase>
</testsuite>`;
  const tests = parseSurefire(xml) as Array<{ name: string; status: string; reason?: string }>;
  assert.deepEqual(tests.map((t) => [t.name, t.status]), [["DispatchTests.contractIsEnforced(String)[1]", "passed"], ["DispatchTests.publishConsume(String)[2]", "skipped"], ["DispatchTests.retry(String)[3]", "failed"]]);
  assert.match(tests[1]!.reason!, /no real rabbitmq available/);
  const v = judge(tests);
  assert.deepEqual([v.ok, v.failed.length, v.blockingSkips.length], [false, 1, 1]);
  // a JUnit 5 assumption is reported without a message attribute: the reason is read from the element's text, never "(no reason given)"
  const junit5 = parseSurefire(`<testsuite><testcase name="perms" classname="a.B"><skipped type="org.opentest4j.TestAbortedException"><![CDATA[org.opentest4j.TestAbortedException: Assumption failed: POSIX file permissions do not exist on this file system (Windows)
	at org.junit.jupiter.api.Assumptions.throwAssumptionFailed(Assumptions.java:339)]]></skipped></testcase>
<testcase name="redis" classname="a.B"><skipped type="org.opentest4j.TestAbortedException"><![CDATA[org.opentest4j.TestAbortedException: Assumption failed: no real redis available (run: node scripts/dispatch-brokers.mjs up)
	at x]]></skipped></testcase></testsuite>`) as Array<{ name: string; status: string; reason?: string }>;
  assert.deepEqual(junit5.map((t) => t.reason), ["POSIX file permissions do not exist on this file system (Windows)", "no real redis available (run: node scripts/dispatch-brokers.mjs up)"]);
  const w = judge(junit5);
  assert.deepEqual([w.acceptedSkips.length, w.blockingSkips.length, w.ok], [1, 1, false], "a platform skip is accepted, missing infrastructure still blocks");
});

test("the gate as a program: exit 0 only for a run with no failure and no disallowed skip; the report names every skip", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-gate-"));
  const gate = resolve(import.meta.dirname, "..", "..", "..", "scripts", "release-gate.mjs");
  const run = (file: string, body: string, ...extra: string[]) => {
    writeFileSync(join(dir, file), `import { test } from "node:test";\n${body}\n`);
    const report = join(dir, `${file}.json`);
    const r = spawnSync(process.execPath, [gate, "--files", join(dir, file), "--report", report, ...extra], { encoding: "utf8", timeout: 100_000 });
    return { code: r.status, out: r.stdout, report: JSON.parse(readFileSync(report, "utf8")) as { ok: boolean; total: number; passed: number; blockingSkips: Array<{ name: string; reason: string }>; acceptedSkips: unknown[]; failed: unknown[] } };
  };
  try {
    const green = run("green.test.mjs", `test("works", () => {});`);
    assert.equal(green.code, 0, green.out);
    assert.match(green.out, /RELEASE GATE: PASSED/);
    assert.deepEqual([green.report.ok, green.report.total, green.report.passed], [true, 1, 1]);

    const skipped = run("skipped.test.mjs", `test("works", () => {});\ntest("needs redis", { skip: "no local Redis (node scripts/dispatch-brokers.mjs up)" }, () => {});\ntest("needs a broker", (t) => t.skip("no Docker engine: real broker tests not run"));`);
    assert.equal(skipped.code, 1, "the runner itself exits 0 for this file; the gate does not");
    assert.match(skipped.out, /SKIPPED and NOT acceptable for a release \(2\)/);
    assert.match(skipped.out, /RELEASE GATE: FAILED/);
    assert.deepEqual(skipped.report.blockingSkips.map((s) => [s.name, s.reason]), [["needs redis", "no local Redis (node scripts/dispatch-brokers.mjs up)"], ["needs a broker", "no Docker engine: real broker tests not run"]]);

    const allowed = run("skipped.test.mjs", `test("works", () => {});\ntest("needs redis", { skip: "no local Redis (node scripts/dispatch-brokers.mjs up)" }, () => {});`, "--allow-skip", "no local Redis");
    assert.equal(allowed.code, 0);
    assert.equal(allowed.report.acceptedSkips.length, 1, "an allowed skip is still listed: the decision stays visible");

    const failing = run("failing.test.mjs", `test("breaks", () => { throw new Error("boom"); });`);
    assert.equal(failing.code, 1);
    assert.equal(failing.report.failed.length, 1);

    // a regression that passes is not a release approval: the last line says so, and why
    assert.match(green.out, /RELEASE APPROVAL: NOT GRANTED \(not every Node suite ran \(--suite all without --files is required\); the Java suites were not run \(--java\); the generated deployment was not validated \(--deployment\)\)/);
    assert.match(green.out, /generated deployment: not run \(--deployment\)/);
    assert.equal((green.report as unknown as { releaseApproval: { granted: boolean } }).releaseApproval.granted, false);
    const mixed = spawnSync(process.execPath, [gate, "--release", "--files", join(dir, "green.test.mjs")], { encoding: "utf8", timeout: 60_000 });
    assert.equal(mixed.status, 2, "--release accepts no narrowing");
    assert.match(mixed.stderr, /--release runs everything and accepts no exception/);

    const sawGate = run("env.test.mjs", `import assert from "node:assert/strict";\ntest("the run is marked as a release run", () => { assert.equal(process.env.PSO_RELEASE_GATE, "1"); });`);
    assert.equal(sawGate.code, 0, sawGate.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("GATE-01: the generated deployment is part of the release approval: a failed check fails it, an unreached part fails it, a validation that could not run blocks it", () => {
  const section = (checks: Array<[string, boolean, string?]>) => ({ ok: checks.every((c) => c[1]), checks: checks.map(([name, ok, detail]) => ({ name, ok, ...(detail ? { detail } : {}) })) });
  const good = { ok: true, durationMs: 400_000, notReached: [], sections: { build: section([["images built", true]]), authentication: section([["valid JWT", true], ["expired token refused", true]]), cleanup: section([["removed", true]]) } };
  const passed = deploymentTests({ exit: 0, report: good }) as Array<{ name: string; status: string; reason?: string; runtime: string }>;
  assert.deepEqual(passed.map((t) => [t.name, t.status, t.runtime]), [["build: images built", "passed", "deployment"], ["authentication: valid JWT", "passed", "deployment"], ["authentication: expired token refused", "passed", "deployment"], ["cleanup: removed", "passed", "deployment"]]);
  assert.equal(judge(passed).ok, true);

  const bad = { ...good, ok: false, sections: { ...good.sections, authentication: section([["valid JWT", false, "401 instead of 200"], ["expired token refused", true]]) } };
  const failed = deploymentTests({ exit: 1, report: bad }) as Array<{ name: string; status: string; reason?: string }>;
  assert.deepEqual(failed.filter((t) => t.status === "failed").map((t) => [t.name, t.reason]), [["authentication: valid JWT", "401 instead of 200"]], "the original failure and what was observed are reported");
  assert.equal(judge(failed).ok, false);

  const stopped = deploymentTests({ exit: 1, report: { ...good, ok: false, notReached: ["recovery", "shutdown"] } }) as Array<{ name: string; status: string }>;
  assert.deepEqual(stopped.filter((t) => t.status === "failed").map((t) => t.name), ["recovery: (not reached)", "shutdown: (not reached)"], "a part that never ran is not a pass");

  // nothing ran: a skip, and one a release cannot accept
  const noDocker = deploymentTests({ exit: 2, report: { ok: false, skipped: "the Docker engine is not running" } }) as Array<{ name: string; status: string; reason?: string }>;
  assert.deepEqual(noDocker.map((t) => [t.status, t.reason]), [["skipped", "generated deployment validation not run: the Docker engine is not running"]]);
  const verdict = judge(noDocker);
  assert.deepEqual([verdict.ok, verdict.blockingSkips.length, verdict.acceptedSkips.length], [false, 1, 0], "not a platform skip: it blocks");
  // no report, a time-out, or a report that contradicts its exit code are failures, never passes
  assert.equal((deploymentTests({ exit: 1, report: undefined }) as Array<{ status: string }>)[0]!.status, "failed");
  assert.match(String((deploymentTests({ exit: null, timedOut: true, report: undefined }) as Array<{ reason?: string }>)[0]!.reason), /did not finish within its time limit/);
  assert.equal(judge(deploymentTests({ exit: 1, report: good }) as never).ok, false, "exit 1 with an all-green report is still a failure");
  assert.equal(judge(deploymentTests({ exit: 0, report: { ...good, error: "TypeError: boom\n at x" } }) as never).ok, false);

  // the approval itself
  assert.deepEqual(releaseApproval({ ok: true, completeSuite: true, java: true, deployment: true }), { granted: true, reasons: [] });
  assert.equal(releaseApproval({ ok: true, completeSuite: true, java: true, deployment: false }).granted, false, "a green regression without the deployment is not an approval");
  assert.equal(releaseApproval({ ok: true, completeSuite: true, java: false, deployment: true }).granted, false);
  assert.equal(releaseApproval({ ok: true, completeSuite: false, java: true, deployment: true }).granted, false);
  assert.equal(releaseApproval({ ok: false, completeSuite: true, java: true, deployment: true }).granted, false);
});
