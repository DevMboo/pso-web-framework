import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Two adapters that only run on a Linux host, exercised for real in a disposable container (image built from
 * fixtures/linux-tools/Dockerfile when it is missing):
 *   - the Secret Service credential provider: `secret-tool` against a real gnome-keyring on a private D-Bus session;
 *   - the Java dependency scan: the official OSV-Scanner binary against the live osv.dev database.
 * Nothing is mocked. The scan needs the network; when osv.dev cannot be reached the adapter must say `unavailable`, and the test is skipped
 * with that reason instead of pretending.
 */
const IMAGE = "pso-e2e-linuxtools:1";
const here = import.meta.dirname;
const src = resolve(here, "..");
const docker = (args: string[], timeout = 600_000) => spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });

function image(): string | false {
  if (process.env["PSO_E2E_DOCKER"] === "0") return "PSO_E2E_DOCKER=0";
  if (docker(["version", "--format", "{{.Server.Version}}"], 30_000).status !== 0) return "Docker is not running";
  if (docker(["image", "inspect", IMAGE], 30_000).status === 0) return false;
  const b = docker(["build", "-q", "-t", IMAGE, resolve(here, "fixtures", "linux-tools")]);
  return b.status === 0 ? false : `could not build ${IMAGE}: ${b.stderr.slice(-300)}`;
}
const skip = image();
const run = (script: string, network = true) => docker(["run", "--rm", ...(network ? [] : ["--network", "none"]), "-v", `${src}:/src:ro`, IMAGE, "sh", "-c", script]);
const lastJson = (s: string): Record<string, any> => JSON.parse(s.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");

test("Secret Service: secrets round-trip through a real gnome-keyring, overwrite, removal, missing entries, invalid references", { skip, timeout: 300_000 }, () => {
  const r = run("dbus-run-session -- sh -c 'printf pso-test-keyring | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1 && node --experimental-strip-types --no-warnings /src/test/fixtures/linux-tools/probe-keyring.ts'", false);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const o = lastJson(r.stdout);
  assert.equal(o["provider"], "secret-service", "the native provider of Linux is chosen");
  assert.deepEqual(o["availability"], { ok: true });
  assert.deepEqual(o["roundTrip"], { "cred_plain": true, "cred_unicode.1": true, "cred:multi-line": true, "cred_quotes": true }, "every secret reads back byte for byte (stdin, never an argument)");
  assert.equal(o["overwrite"], true); assert.equal(o["removed"], true); assert.equal(o["afterRemove"], null); assert.equal(o["missing"], null);
  assert.equal(o["invalidRef"], "refused");
});

test("Secret Service: without a running keyring the write fails with instructions, never in plain text", { skip, timeout: 120_000 }, () => {
  const script = `node --experimental-strip-types --no-warnings -e 'import("/src/src/credentials.ts").then((m) => { const p = new m.SecretServiceProvider(); try { p.set("cred_x", "v"); console.log(JSON.stringify({ wrote: true })); } catch (e) { console.log(JSON.stringify({ wrote: false, error: e.constructor.name, message: e.message })); } })' ; ls -A /home/pso`;
  const r = run(script, false);
  const o = lastJson(r.stdout);
  assert.equal(o["wrote"], false); assert.equal(o["error"], "CredentialStoreError"); assert.match(String(o["message"]), /keyring/);
  assert.doesNotMatch(r.stdout, /credentials\.enc|\.pso-cloud/, "no fallback file was written");
});

test("Java dependency scan: the real OSV-Scanner finds Log4Shell, passes a patched version, reports without blocking, and says when there is nothing to scan", { skip, timeout: 600_000 }, (t) => {
  const r = run("node --experimental-strip-types --no-warnings /src/test/fixtures/linux-tools/probe-osv.ts");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const o = lastJson(r.stdout);
  if (o["vulnerable"]?.status === "unavailable" && /could not be reached/.test(o["vulnerable"].note)) { t.skip(`osv.dev unreachable: ${o["vulnerable"].note}`); return; }
  const v = o["vulnerable"];
  assert.equal(v.status, "failed", v.note); assert.match(String(v.version), /^2\.2\.4$/);
  assert.ok(v.aliases.some((id: string) => /CVE-2021-44228|GHSA-jfh8-c2jp-5v3q/.test(id)), `Log4Shell is reported: ${v.ids.join(", ")}`);
  assert.ok(v.counts.critical >= 1, JSON.stringify(v.counts)); assert.match(v.database, /osv\.dev/);
  const p = o["patched"];
  assert.equal(p.status, "passed", p.note); assert.equal(p.counts.critical, 0); assert.equal(p.counts.high, 0);
  assert.equal(o["reportOnly"].status, "passed", "with blockSeverity none the same findings are reported and nothing blocks"); assert.ok(o["reportOnly"].ids.length >= 1);
  assert.equal(o["empty"].status, "unavailable"); assert.match(o["empty"].note, /nothing it can scan/);
});
