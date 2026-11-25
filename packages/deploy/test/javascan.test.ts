import { test } from "node:test";
import assert from "node:assert/strict";
import { detectScanner, parseOsv, scanJava, type Exec } from "../src/agent/javascan.ts";

/** The Java dependency scan adapter: honest about every way the scan can fail to run, and never fabricates a result. */
const osv = (vulns: Array<{ id: string; sev?: string; score?: string; name?: string; version?: string }>) => JSON.stringify({ results: [{ source: { path: "/r/pom.xml", type: "lockfile" }, packages: vulns.length ? vulns.reduce((acc: any[], v) => { let p = acc.find((x) => x.package.name === (v.name ?? "org.example:lib")); if (!p) { p = { package: { name: v.name ?? "org.example:lib", version: v.version ?? "1.0.0", ecosystem: "Maven" }, vulnerabilities: [], groups: [] }; acc.push(p); } p.vulnerabilities.push({ id: v.id, summary: `advisory ${v.id}`, database_specific: v.sev ? { severity: v.sev } : {} }); p.groups.push({ ids: [v.id], max_severity: v.score ?? "" }); return acc; }, []) : [{ package: { name: "org.example:clean", version: "1.0.0", ecosystem: "Maven" } }] }] });
const exec = (over: Partial<ReturnType<Exec>> | ((a: string[]) => Partial<ReturnType<Exec>>)): Exec => (cmd, args) => { const o = typeof over === "function" ? over(args) : over; if (args[0] === "--version") return { status: 0, stdout: "osv-scanner version: 2.2.1\n", stderr: "" }; return { status: 0, stdout: "", stderr: "", ...o }; };

test("the scanner is detected, with its version; a missing scanner is reported as such", () => {
  assert.deepEqual(detectScanner(exec({})), { available: true, bin: "osv-scanner", version: "2.2.1" });
  const none = detectScanner(() => ({ status: null, stdout: "", stderr: "", error: "spawn osv-scanner ENOENT" })); assert.equal(none.available, false); assert.match(none.reason!, /not installed/);
});

test("not installed: the result is `unavailable`, not a pass, and it says what to do", () => {
  const r = scanJava("/r", { blockSeverity: "high", exec: () => ({ status: null, stdout: "", stderr: "", error: "ENOENT" }) });
  assert.equal(r.status, "unavailable"); assert.equal(r.findings.length, 0); assert.match(r.note, /NOT scanned/); assert.match(r.note, /Install OSV-Scanner/);
});

test("timeout, database unreachable, nothing to scan and unreadable output are four different `unavailable` reasons", () => {
  assert.match(scanJava("/r", { blockSeverity: "high", timeoutMs: 5000, exec: exec({ status: null, error: "spawnSync ETIMEDOUT", timedOut: true }) }).note, /exceeded 5s/);
  const net = scanJava("/r", { blockSeverity: "high", exec: exec({ status: 127, stderr: "Post https://api.osv.dev/v1/querybatch: dial tcp: lookup api.osv.dev: no such host" }) });
  assert.equal(net.status, "unavailable"); assert.match(net.note, /vulnerability database \(osv\.dev\) could not be reached/);
  assert.match(scanJava("/r", { blockSeverity: "high", exec: exec({ status: 128, stderr: "No package sources found" }) }).note, /nothing it can scan/);
  assert.match(scanJava("/r", { blockSeverity: "high", exec: exec({ status: 0, stdout: "{ not json" }) }).note, /could not be read/);
  assert.match(scanJava("/r", { blockSeverity: "high", exec: exec({ status: 0, stdout: "plain text" }) }).status, /unavailable/);
});

test("clean scan passes and states how many packages were inventoried and where the database comes from", () => {
  const r = scanJava("/r", { blockSeverity: "high", exec: exec({ status: 0, stdout: osv([]) }), now: () => new Date("2026-11-15T12:00:00Z") });
  assert.equal(r.status, "passed"); assert.equal(r.packages, 1); assert.equal(r.database?.queriedAt, "2026-11-15T12:00:00.000Z"); assert.match(r.database!.source, /osv\.dev/);
});

test("severity policy: findings at or above the server's block severity fail; below it they are reported but do not block; `none` only reports", () => {
  const out = osv([{ id: "GHSA-aaaa", score: "9.8", name: "a:b" }, { id: "GHSA-bbbb", score: "7.5", name: "c:d" }, { id: "GHSA-cccc", score: "5.0", name: "e:f" }, { id: "GHSA-dddd", sev: "LOW", name: "g:h" }]);
  const run = (b: "none" | "critical" | "high" | "medium" | "low") => scanJava("/r", { blockSeverity: b, exec: exec({ status: 1, stdout: out }) });
  assert.deepEqual(run("critical").counts, { critical: 1, high: 1, medium: 1, low: 1, unknown: 0 }); // exit 1 = vulnerabilities FOUND with valid output
  assert.equal(run("critical").status, "failed"); assert.equal(run("high").status, "failed"); assert.equal(run("none").status, "passed"); assert.match(run("none").note, /report only/);
  const onlyLow = osv([{ id: "GHSA-low", sev: "LOW" }]); assert.equal(scanJava("/r", { blockSeverity: "high", exec: exec({ status: 1, stdout: onlyLow }) }).status, "passed", "a LOW advisory does not block a `high` policy");
});

test("parsing: CVSS score beats the textual severity, duplicates collapse, summaries are bounded and sanitized", () => {
  const j = JSON.stringify({ results: [{ packages: [{ package: { name: "a:b", version: "1" }, vulnerabilities: [{ id: "X1", summary: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD " + "y".repeat(400), database_specific: { severity: "LOW" } }, { id: "X1" }], groups: [{ ids: ["X1"], max_severity: "9.1" }] }] }] });
  const { findings } = parseOsv(j); assert.equal(findings.length, 1); assert.equal(findings[0]!.severity, "critical"); assert.ok(findings[0]!.summary.length <= 160); assert.doesNotMatch(findings[0]!.summary, /ghp_[A-Za-z0-9]{20}/);
});
