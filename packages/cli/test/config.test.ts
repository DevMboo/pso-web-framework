import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, setIn } from "@pso/core";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

async function ws() {
  const base = tmp("pso-cfg-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  return root;
}
const json = (p: string, o: unknown) => writeFileSync(p, JSON.stringify(o));
const val = (out: string, key: string) => (JSON.parse(out)[0].values as Array<{ key: string; value: unknown; origin: string }>).find((v) => v.key === key)!;

test("precedence: defaults < workspace < service < environment file < env vars < CLI", async () => {
  const root = await ws();
  const cfg = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "pso.workspace.json"), "utf8"));
  cfg.config = { logging: { level: "warn" }, server: { maxBodyBytes: 2048 } };
  json(join(root, "pso.workspace.json"), cfg);
  json(join(root, "gw", "pso.config.json"), { logging: { level: "debug" }, server: { upstreamTimeoutMs: 100 } });
  json(join(root, "gw", "pso.config.production.json"), { server: { upstreamTimeoutMs: 200 } });

  const show = async (...extra: string[]) => (await pso(root, "config:show", "--service", "gw", "--json", ...extra)).out;
  let o = await show();
  assert.deepEqual([val(o, "server.host").origin, val(o, "server.maxBodyBytes").origin, val(o, "logging.level").origin], ["defaults", "workspace", "service"]);
  assert.equal(val(o, "server.port").value, 3000, "port comes from the declaration");

  o = await show("--env", "production");
  assert.deepEqual([val(o, "server.upstreamTimeoutMs").value, val(o, "server.upstreamTimeoutMs").origin], [200, "environment-file"]);

  process.env["PSO_CFG_server__upstreamTimeoutMs"] = "300";
  try {
    o = await show("--env", "production");
    assert.deepEqual([val(o, "server.upstreamTimeoutMs").value, val(o, "server.upstreamTimeoutMs").origin], [300, "environment-variables"]);
    o = await show("--env", "production", "--set", "server.upstreamTimeoutMs=400", "--set", "logging.level=error");
    assert.deepEqual([val(o, "server.upstreamTimeoutMs").value, val(o, "server.upstreamTimeoutMs").origin], [400, "cli"]);
    assert.equal(val(o, "logging.level").value, "error");
  } finally { delete process.env["PSO_CFG_server__upstreamTimeoutMs"]; }
});

test("plaintext secrets are rejected; references are accepted; output is always redacted", async () => {
  const root = await ws();
  json(join(root, "gw", "pso.config.json"), { security: { jwt: { jwksUri: "https://idp.test/jwks" } }, db: { password: "hunter2" } });
  const v = await pso(root, "config:validate", "--service", "gw", "--json");
  assert.equal(v.code, 1);
  const codes = JSON.parse(v.out).diagnostics.map((d: { code: string }) => d.code);
  assert.ok(codes.includes("PSO_CONFIG_PLAINTEXT_SECRET"));
  assert.ok(codes.includes("PSO_CONFIG_UNKNOWN_KEY"), "unknown keys are reported");
  assert.ok(!v.out.includes("hunter2"), "secret value never printed");

  json(join(root, "gw", "pso.config.json"), { server: { port: 4000 } });
  json(join(root, "pso.workspace.json"), { ...JSON.parse((await import("node:fs")).readFileSync(join(root, "pso.workspace.json"), "utf8")), config: { security: { jwt: { publicKeyFile: "${env:PSO_PUBKEY}" } } } });
  assert.equal((await pso(root, "config:validate", "--service", "gw")).code, 0);

  // a secret-named key supplied via env is still redacted when displayed
  process.env["PSO_CFG_security__rateLimit__token"] = "supersecretvalue";
  try {
    const shown = await pso(root, "config:show", "--service", "gw");
    assert.ok(!shown.out.includes("supersecretvalue"));
    assert.ok(shown.out.includes("${env:PSO_PUBKEY}"), "references are shown as references");
  } finally { delete process.env["PSO_CFG_security__rateLimit__token"]; }
});

test("schema violations and bad environments are reported with actionable errors", async () => {
  const root = await ws();
  json(join(root, "gw", "pso.config.json"), { server: { maxBodyBytes: "big" }, logging: { level: "loud" } });
  const v = await pso(root, "config:validate", "--service", "gw", "--json");
  assert.equal(v.code, 1);
  assert.equal(JSON.parse(v.out).diagnostics.filter((d: { code: string }) => d.code === "PSO_CONFIG_INVALID_VALUE").length, 2);
  assert.equal((await pso(root, "config:show", "--env", "prod")).code, 1);
  assert.equal((await pso(root, "config:show", "--set", "novalue")).code, 1);
  json(join(root, "gw", "pso.config.json"), "[1]");
  assert.match((await pso(root, "config:validate", "--service", "gw")).out, /PSO_CONFIG_UNREADABLE/);
  const l = await pso(root, "config:list", "--json");
  assert.equal(l.code, 0);
  assert.equal(JSON.parse(l.out).scopes.length, 2);
});

test("core: prototype-polluting configuration paths are rejected", () => {
  assert.throws(() => setIn({}, "__proto__.polluted", true), /Invalid configuration path/);
  assert.throws(() => setIn({}, "a.constructor.b", true), /Invalid configuration path/);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  const r = resolveConfig({ cli: { source: "--set", values: { "server": { "port": 80 } } } });
  assert.ok(r.diagnostics.some((d) => d.code === "PSO_CONFIG_INVALID_VALUE"));
  void mkdirSync;
});
