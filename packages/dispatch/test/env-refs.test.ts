// D3 regression: the pso.config.json that `pso dispatch:install redis` writes references ${env:REDIS_URL}. With Dispatch switched off the
// orchestrator must start whether or not that variable exists (rc.6 refused with PSO_DISPATCH_ENV_MISSING); switched on, the missing
// address is still an error, reported before anything connects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDispatchConfig, DispatchConfigError } from "../src/index.ts";

const project = (dispatch: Record<string, unknown>) => { const d = mkdtempSync(join(tmpdir(), "pso-dispatch-refs-")); writeFileSync(join(d, "pso.config.json"), JSON.stringify({ dispatch })); return d; };
const installed = { enabled: false, provider: "redis", redis: { url: "${env:REDIS_URL}" } };

test("Dispatch switched off: an unset ${env:...} reference does not stop the start-up", () => {
  const c = loadDispatchConfig({ projectDir: project(installed), source: "gateway", env: {} });
  assert.equal(c.enabled, false);
});

test("Dispatch switched on: the unset reference is reported (with the key that uses it), nothing connects", () => {
  assert.throws(() => loadDispatchConfig({ projectDir: project(installed), source: "gateway", env: { PSO_DISPATCH_ENABLED: "true" } }), (e: unknown) => e instanceof DispatchConfigError && e.issues.some((i) => i.code === "PSO_DISPATCH_ENV_MISSING" && i.key === "dispatch.redis.url"));
});

test("Dispatch switched on with the variable set: the reference resolves", () => {
  const c = loadDispatchConfig({ projectDir: project(installed), source: "gateway", env: { PSO_DISPATCH_ENABLED: "true", REDIS_URL: "redis://default:pw@redis:6379/0" } });
  assert.equal(c.enabled, true);
  assert.equal(c.redis.url, "redis://default:pw@redis:6379/0");
});
