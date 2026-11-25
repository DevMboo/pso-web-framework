#!/usr/bin/env node
// PSO release gate. A green run is only evidence when the tests that need real infrastructure actually ran. Day-to-day `npm test`
// skips them when Redis, the brokers, PostgreSQL, a JDK or a browser are missing (and says so); a RELEASE must not be approved on such
// a run. This script runs the suites, then fails when a test failed OR when a test was skipped for any reason other than
// "this does not apply to this operating system".
//
//   node scripts/release-gate.mjs                         every Node suite (packages/*/test/*.test.ts)
//   node scripts/release-gate.mjs --suite fast            core, security, http, dispatch, channels (no generated projects, no Maven)
//   node scripts/release-gate.mjs --files "<glob>" ...    explicit test files
//   node scripts/release-gate.mjs --java                  also run the Java suites (pso-java: ./mvnw test) and read their reports
//   node scripts/release-gate.mjs --allow-skip "<regex>"  one more accepted skip reason (repeatable; reported in the summary)
//   node scripts/release-gate.mjs --report <file.json>    write the machine-readable result
//   node scripts/release-gate.mjs --deployment            also validate the generated deployment (scripts/validate-generated-deployment.mjs:
//                                                         real images, real containers, authenticated requests; several minutes)
//   node scripts/release-gate.mjs --release               the release approval run: every Node suite, the Java suites and the generated
//                                                         deployment. Only this run can end with "RELEASE APPROVAL: GRANTED"
//
// Three levels, on purpose: `npm test` (fast, may skip), this gate without --release (the complete regression: nothing failed, nothing
// that matters skipped) and --release (the regression plus a deployment that was built, started and used). A regression that passes
// is reported as such and never as a release approval: the last line says whether the approval was granted and, if not, why.
//
// Exit 0: nothing failed and nothing that matters was skipped. Exit 1: failures or disallowed skips (each one is listed with its reason).
// Exit 2: the gate itself could not run. It starts nothing: bring the infrastructure up first (node scripts/dispatch-brokers.mjs up);
// the gate then finds this checkout's session containers by their ownership labels (or uses the PSO_TEST_* variables you set).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionEnv, sessionId } from "./dispatch-brokers.mjs";

/** Skips that say "not applicable on this operating system": the only ones a release may contain. */
export const PLATFORM_SKIPS = [/POSIX permission bits do not apply on Windows/i, /links cannot be created here/i, /drive letters exist on Windows only/i,
  /this platform\/user cannot create symbolic links/i, /POSIX file permissions do not exist on this file system/i];

/** Reads node:test TAP output. Returns every reported test with its status and, for a skip, the reason. */
export function parseTap(text) {
  const tests = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(not ok|ok) \d+ - (.*)$/.exec(raw);
    if (!m) continue;
    let name = m[2], status = m[1] === "ok" ? "passed" : "failed", reason;
    const d = /^(.*?) # (SKIP|TODO)\b ?(.*)$/i.exec(name);
    if (d) { name = d[1]; reason = d[3] || "(no reason given)"; status = d[2].toUpperCase() === "SKIP" ? "skipped" : "todo"; }
    tests.push({ name, status, ...(reason !== undefined ? { reason } : {}) });
  }
  return tests;
}

/** Reads Maven Surefire XML reports: [{ name, status, reason }]. */
export function parseSurefire(xml) {
  const out = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]) ?? [])[1] ?? "";
    const body = m[3] ?? "";
    const name = `${attr("classname").split(".").pop()}.${attr("name")}`;
    const skipped = /<skipped\b(?:[^>]*\bmessage="([^"]*)")?/.exec(body);
    // JUnit 5 assumptions are reported without a message attribute: the reason is the first line of the element's text
    const inText = /<skipped\b[^>]*>\s*(?:<!\[CDATA\[)?\s*(?:[\w.$]+Exception:\s*)?(?:Assumption failed:\s*)?([^\r\n\]<]+)/.exec(body);
    if (skipped) out.push({ name, status: "skipped", reason: (skipped[1] ?? inText?.[1]?.trim() ?? "(no reason given)").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") });
    else out.push({ name, status: /<(failure|error)\b/.test(body) ? "failed" : "passed" });
  }
  return out;
}

/** The verdict: a release needs zero failures and zero skips outside the accepted reasons. */
export function judge(tests, allowed = PLATFORM_SKIPS) {
  const failed = tests.filter((t) => t.status === "failed");
  const skipped = tests.filter((t) => t.status === "skipped" || t.status === "todo");
  const accepted = skipped.filter((t) => allowed.some((re) => re.test(t.reason ?? "")));
  const blocking = skipped.filter((t) => !accepted.includes(t));
  return { total: tests.length, passed: tests.filter((t) => t.status === "passed").length, failed, acceptedSkips: accepted, blockingSkips: blocking, ok: tests.length > 0 && failed.length === 0 && blocking.length === 0 };
}

/**
 * The checks of a generated-deployment validation as gate results. A check that failed, a section that was never reached, a run that
 * crashed or timed out are failures; a validation that could not run at all (no Docker engine) is a skip, and a blocking one.
 */
export function deploymentTests(result) {
  const one = (status, reason) => [{ name: "generated deployment validation", status, reason, runtime: "deployment" }];
  const r = result.report;
  if (result.exit === 2 || r?.skipped) return one("skipped", `generated deployment validation not run: ${r?.skipped ?? "the Docker engine is not running"}`);
  if (!r || !r.sections) return one("failed", result.timedOut ? "the validation did not finish within its time limit" : `the validation produced no report (exit ${result.exit})`);
  const out = [];
  for (const [section, s] of Object.entries(r.sections)) for (const c of s.checks) out.push({ name: `${section}: ${c.name}`, status: c.ok ? "passed" : "failed", runtime: "deployment", ...(!c.ok && c.detail ? { reason: c.detail } : {}) });
  for (const section of r.notReached ?? []) out.push({ name: `${section}: (not reached)`, status: "failed", reason: "the validation stopped before this part", runtime: "deployment" });
  if (r.error) out.push({ name: "generated deployment validation", status: "failed", reason: String(r.error).split("\n")[0], runtime: "deployment" });
  if ((result.exit !== 0 || r.ok !== true) && !out.some((t) => t.status === "failed")) out.push({ name: "generated deployment validation", status: "failed", reason: `exit ${result.exit}, report ok=${r.ok}`, runtime: "deployment" });
  return out;
}

/** A release is approved by one kind of run only: the whole regression, the Java suites and the generated deployment, all green. */
export function releaseApproval(o) {
  const reasons = [];
  if (!o.completeSuite) reasons.push("not every Node suite ran (--suite all without --files is required)");
  if (!o.java) reasons.push("the Java suites were not run (--java)");
  if (!o.deployment) reasons.push("the generated deployment was not validated (--deployment)");
  if (!o.ok) reasons.push("the run did not pass");
  return { granted: reasons.length === 0, reasons };
}

const SUITES = {
  fast: ["packages/core/test/*.test.ts", "packages/security/test/*.test.ts", "packages/http/test/*.test.ts", "packages/dispatch/test/*.test.ts", "packages/channels/test/*.test.ts"],
  all: ["packages/*/test/*.test.ts"],
};

async function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const args = process.argv.slice(2);
  const values = (n) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] !== undefined ? [args[i + 1]] : []));
  const release = args.includes("--release");
  if (release && (values("files").length || (values("suite")[0] ?? "all") !== "all" || values("allow-skip").length)) { console.error("--release runs everything and accepts no exception: it cannot be combined with --files, --suite fast or --allow-skip"); process.exit(2); }
  const withJava = release || args.includes("--java"), withDeployment = release || args.includes("--deployment");
  const suite = values("suite")[0] ?? "all";
  if (!(suite in SUITES)) { console.error(`unknown --suite "${suite}" (fast, all)`); process.exit(2); }
  const files = (values("files").length ? values("files") : SUITES[suite]).map((f) => f.replace(/\\/g, "/")); // the runner reads its arguments as globs: a backslash would be an escape
  let allowed;
  try { allowed = [...PLATFORM_SKIPS, ...values("allow-skip").map((s) => new RegExp(s, "i"))]; } catch (e) { console.error(`invalid --allow-skip: ${e.message}`); process.exit(2); }

  console.log(`release gate: ${files.join(" ")}${withJava ? " + pso-java" : ""}${withDeployment ? " + generated deployment" : ""}`);
  if (!existsSync(join(root, "packages", "core", "dist", "index.js"))) { console.error("the packages are not built: run `npm run build` first"); process.exit(2); }
  // the gate states that it IS a release run; tests may use this to refuse to skip, and the brokers script is never started implicitly
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env; // the gate is always a top-level run, even when something else started it from inside a test
  // where the infrastructure is: the PSO_TEST_* variables that are set, else the verified containers of this test session (their
  // ports are assigned by the operating system). The gate still starts nothing; what is missing shows up as a blocking skip.
  const infra = sessionEnv();
  for (const k of ["PSO_TEST_REDIS_URL", "PSO_TEST_RABBITMQ_URL", "PSO_TEST_KAFKA_BROKERS", "PSO_TEST_POSTGRES_URL"]) {
    console.log(`infrastructure: ${k} = ${infra[k] ? `${infra[k].replace(/\/\/[^@/]*@/, "//***@").replace(/password=[^&]*/, "password=***")}${process.env[k] ? " (from the environment)" : ` (test session ${sessionId()})`}` : "not available (node scripts/dispatch-brokers.mjs up)"}`);
    if (infra[k]) env[k] = infra[k];
  }
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", `--test-concurrency=${values("concurrency")[0] ?? "4"}`, "--test-timeout=600000", ...files], { cwd: root, env: { ...env, PSO_RELEASE_GATE: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  let tap = "";
  child.stdout.on("data", (d) => { tap += d; });
  const code = await new Promise((r) => child.on("close", r));
  const tests = parseTap(tap).map((t) => ({ ...t, runtime: "node" }));

  let javaNote = "not requested (--java)";
  if (withJava) {
    const dir = join(root, "pso-java");
    const win = process.platform === "win32";
    const r = spawnSync(win ? "cmd.exe" : "./mvnw", win ? ["/d", "/c", ".\\mvnw.cmd", "-B", "-ntp", "-o", "test"] : ["-B", "-ntp", "-o", "test"], { cwd: dir, env, encoding: "utf8", timeout: 3_600_000, maxBuffer: 512 * 1024 * 1024 });
    let n = 0;
    for (const mod of readdirSync(dir, { withFileTypes: true })) {
      const reports = join(dir, mod.name, "target", "surefire-reports");
      if (!mod.isDirectory() || !existsSync(reports)) continue;
      for (const f of readdirSync(reports)) if (/^TEST-.*\.xml$/.test(f)) for (const t of parseSurefire(readFileSync(join(reports, f), "utf8"))) { tests.push({ ...t, runtime: "java" }); n++; }
    }
    javaNote = `mvnw test exit ${r.status}; ${n} test case(s) read from the Surefire reports`;
    if (r.status !== 0 && !tests.some((t) => t.runtime === "java" && t.status === "failed")) tests.push({ name: "pso-java: ./mvnw test", status: "failed", runtime: "java" });
  }

  // the generated deployment: built, started and used for real. Its own report is kept next to the gate's.
  let deploymentNote = "not run (--deployment)";
  let deployment;
  if (withDeployment) {
    const out = values("report")[0] ? resolve(values("report")[0]).replace(/(\.json)?$/, ".deployment.json") : join(root, "node_modules", ".cache", "pso-deployment-report.json");
    try { mkdirSync(dirname(out), { recursive: true }); rmSync(out, { force: true }); } catch { /* reported below as a missing report */ }
    console.log("generated deployment validation: started (images are built and a compose stack is run; this takes several minutes)");
    const r = spawnSync(process.execPath, [join(root, "scripts", "validate-generated-deployment.mjs"), "--report", out, "--log", out.replace(/\.json$/, ".log")], { cwd: root, env, encoding: "utf8", timeout: 3_600_000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
    let report; try { report = JSON.parse(readFileSync(out, "utf8")); } catch { /* no report */ }
    deployment = { exit: r.status, timedOut: r.error?.code === "ETIMEDOUT", report };
    const dt = deploymentTests(deployment);
    tests.push(...dt);
    deploymentNote = `${report?.ok === true && r.status === 0 ? "VALIDATED" : dt.some((t) => t.status === "skipped") ? "NOT RUN" : "NOT VALIDATED"}; ${dt.filter((t) => t.status === "passed").length}/${dt.length} check(s) passed${report?.durationMs ? ` in ${Math.round(report.durationMs / 1000)} s` : ""}; report: ${out}`;
  }

  const v = judge(tests, allowed);
  const line = (t) => `  [${t.runtime}] ${t.name}${t.reason ? `\n      reason: ${t.reason}` : ""}`;
  console.log(`\nran ${v.total} test(s): ${v.passed} passed, ${v.failed.length} failed, ${v.acceptedSkips.length + v.blockingSkips.length} skipped (node --test exit ${code}; java: ${javaNote})`);
  console.log(`generated deployment: ${deploymentNote}`);
  if (v.failed.length) console.log(`\nFAILED (${v.failed.length}):\n${v.failed.map(line).join("\n")}`);
  if (v.blockingSkips.length) console.log(`\nSKIPPED and NOT acceptable for a release (${v.blockingSkips.length}): these tests need infrastructure that was missing, so this run proves nothing about them\n${v.blockingSkips.map(line).join("\n")}`);
  if (v.acceptedSkips.length) console.log(`\nskipped, accepted (does not apply to this operating system, or allowed explicitly) (${v.acceptedSkips.length}):\n${v.acceptedSkips.map(line).join("\n")}`);
  if (v.total === 0) console.log("\nno test ran: that is not a pass");
  const ok = v.ok && code === 0;
  console.log(`\nRELEASE GATE: ${ok ? "PASSED" : "FAILED"}`);
  const approval = releaseApproval({ ok, completeSuite: suite === "all" && !values("files").length && !values("allow-skip").length, java: withJava, deployment: withDeployment });
  console.log(`RELEASE APPROVAL: ${approval.granted ? "GRANTED" : `NOT GRANTED (${approval.reasons.join("; ")})`}`);
  const report = values("report")[0];
  if (report) writeFileSync(resolve(report), JSON.stringify({ at: new Date().toISOString(), suite: files, ok, total: v.total, passed: v.passed, failed: v.failed, blockingSkips: v.blockingSkips, acceptedSkips: v.acceptedSkips, nodeExit: code, java: javaNote, deployment: withDeployment ? { note: deploymentNote, exit: deployment?.exit ?? null, ok: deployment?.report?.ok === true, durationMs: deployment?.report?.durationMs ?? null, timings: deployment?.report?.timings ?? null, sections: Object.fromEntries(Object.entries(deployment?.report?.sections ?? {}).map(([k, s]) => [k, { ok: s.ok, checks: s.checks.length }])) } : null, releaseApproval: approval }, null, 2) + "\n");
  process.exit(release ? (approval.granted ? 0 : 1) : ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
