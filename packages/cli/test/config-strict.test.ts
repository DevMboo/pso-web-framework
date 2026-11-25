import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA, OPEN_NAMESPACES, isStrictConfig, nearestKey, resolveConfig } from "@pso/core";
import { pso, tmp } from "./helpers.ts";

/**
 * Strict configuration validation (audit finding D3): an unknown key is a warning in development and an error in production / CI,
 * so a misspelled setting can no longer be silently ignored where it matters. Existing valid configurations keep validating.
 */
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
async function ws(): Promise<string> {
  const base = tmp("pso-cfg-strict-"); dirs.push(base);
  await pso(base, "create", "workspace", "w");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  return root;
}
const json = (p: string, o: unknown): void => writeFileSync(p, JSON.stringify(o));
type Diag = { code: string; severity: string; message: string; hint?: string; file?: string };
const validate = async (root: string, ...extra: string[]): Promise<{ code: number; out: string; diagnostics: Diag[] }> => {
  const r = await pso(root, "config:validate", "--service", "gw", "--json", ...extra);
  return { code: r.code, out: r.out, diagnostics: (JSON.parse(r.out) as { diagnostics: Diag[] }).diagnostics };
};

test("policy: strict in production, on demand elsewhere, and explicitly switchable off", () => {
  assert.equal(isStrictConfig({}, "production"), true);
  for (const e of ["development", "test", "staging"]) assert.equal(isStrictConfig({}, e), false, e);
  assert.equal(isStrictConfig({ PSO_CONFIG_STRICT: "true" }, "development"), true, "CI opts in");
  assert.equal(isStrictConfig({ PSO_CONFIG_STRICT: "false" }, "production"), false, "the documented compatibility switch");
  assert.equal(isStrictConfig({ PSO_CONFIG_STRICT: "yes" }, "development"), false, "only the exact value true enables it");
});

test("unknown keys: a warning by default (the value is kept as before), an error under strict (the key never becomes effective)", () => {
  const layers = { service: { source: "pso.config.json", values: { http: { rateLimit: { perMinuet: 5 } }, logging: { level: "warn" } } } };
  const lax = resolveConfig(layers);
  assert.deepEqual(lax.diagnostics.map((d) => [d.code, d.severity]), [["PSO_CONFIG_UNKNOWN_KEY", "warning"]]);
  assert.equal(lax.values.get("http.rateLimit.perMinuet")?.value, 5, "unchanged behaviour outside strict mode");
  const strict = resolveConfig(layers, { strict: true });
  assert.deepEqual(strict.diagnostics.map((d) => [d.code, d.severity, d.file]), [["PSO_CONFIG_UNKNOWN_KEY", "error", "pso.config.json"]]);
  assert.match(strict.diagnostics[0]!.hint!, /^Did you mean "http\.rateLimit\.perMinute"\? Check the spelling; known keys: server\.host, /);
  assert.equal(strict.values.has("http.rateLimit.perMinuet"), false);
  assert.equal(strict.values.get("logging.level")?.value, "warn", "valid keys are unaffected");
});

test("misspelled security settings are caught with a suggestion, in every layer, and values are never printed", () => {
  const r = resolveConfig({
    service: { source: "pso.config.json", values: { security: { authentication: { issuerr: "https://tenant-4711.idp.example", jwks: { trustedHost: ["idp.internal.example"] } }, propagation: { foward: "none" } } } },
    "environment-variables": { source: "PSO_CFG_*", values: { "security.authentication.audiense": "api-internal-9" } },
    cli: { source: "--set", values: { security: { authorization: { defaultPolcy: "authenticated" } } } },
  }, { strict: true });
  const got = r.diagnostics.filter((d) => d.code === "PSO_CONFIG_UNKNOWN_KEY").map((d) => `${d.file}: ${d.message} ${d.hint!.split("?")[0]}?`).sort();
  assert.deepEqual(got, [
    '--set: Unknown configuration key "security.authorization.defaultPolcy" Did you mean "security.authorization.defaultPolicy"?',
    'PSO_CFG_*: Unknown configuration key "security.authentication.audiense" Did you mean "security.authentication.audience"?',
    'pso.config.json: Unknown configuration key "security.authentication.issuerr" Did you mean "security.authentication.issuer"?',
    'pso.config.json: Unknown configuration key "security.authentication.jwks.trustedHost" Did you mean "security.authentication.jwks.trustedHosts"?',
    'pso.config.json: Unknown configuration key "security.propagation.foward" Did you mean "security.propagation.forward"?',
  ]);
  const text = JSON.stringify(r.diagnostics);
  for (const secret of ["tenant-4711", "idp.internal.example", "api-internal-9"]) assert.ok(!text.includes(secret), `${secret} is not echoed`);
  assert.equal(nearestKey("completely.unrelated.thing"), undefined, "no suggestion is invented for a key that resembles nothing");
});

test("invalid types and ranges are errors in both modes; a secret's wrong-typed value is not echoed", () => {
  const r = resolveConfig({
    service: { source: "pso.config.json", values: { server: { port: "eighty" }, http: { limits: { maxBodyBytes: -1 }, rateLimit: { provider: "memcached" } }, logging: { format: "xml" } } },
    "environment-variables": { source: "PSO_CFG_*", values: { "dispatch.kafka.sasl.password": 123456789 } },
  });
  const errors = r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).sort();
  assert.deepEqual(errors, [
    '"dispatch.kafka.sasl.password" must be a string (got a number)',
    '"http.limits.maxBodyBytes" must be >= 1',
    '"http.rateLimit.provider" must be one of local, redis',
    '"logging.format" must be one of pretty, json',
    '"server.port" must be a string (got "eighty")'.replace("a string", "a number"),
  ]);
  assert.ok(!JSON.stringify(r.diagnostics).includes("123456789"));
});

test("contradictory settings are reported with what to do (the owning package still refuses them at start-up)", () => {
  const r = resolveConfig({ service: { source: "pso.config.json", values: {
    dispatch: { enabled: true, kafka: { sasl: { mechanism: "plain" } } }, http: { rateLimit: { provider: "redis" } },
    security: { authentication: { jwks: { uri: "https://idp.test/jwks" }, publicKey: { file: "keys/public.pem" } } },
  } } });
  const c = r.diagnostics.filter((d) => d.code === "PSO_CONFIG_CONTRADICTION");
  assert.deepEqual(c.map((d) => d.message).sort(), [
    '"dispatch.enabled" is true but "dispatch.provider" is "none"',
    '"dispatch.kafka.sasl.mechanism" is set but "dispatch.kafka.ssl" is not true',
    '"http.rateLimit.provider" is "redis" but "http.rateLimit.redisUrl" is not set',
    'both "security.authentication.jwks.uri" and "security.authentication.publicKey.file" are set',
  ]);
  assert.ok(c.every((d) => d.severity === "warning" && d.hint && d.file === "pso.config.json"));
  // a consistent configuration reports nothing
  const ok = resolveConfig({ service: { source: "pso.config.json", values: { dispatch: { enabled: true, provider: "redis", redis: { url: "${env:REDIS_URL}" } }, http: { rateLimit: { provider: "redis", redisUrl: "${env:RL_URL}" } } } } }, { strict: true });
  assert.deepEqual(ok.diagnostics, []);
});

test("every key the framework documents validates under strict mode, including the namespaces other packages own", () => {
  const values: Record<string, unknown> = {
    server: { host: "0.0.0.0", port: 8080 },
    http: { limits: { maxBodyBytes: 1024, maxUploadBytes: 2048, maxMultipartParts: 10, maxConcurrentUploads: 2 }, rateLimit: { perMinute: 60, routes: [{ route: "POST /login", limit: 5 }] },
      upstreams: { "users-service": { tls: { caFile: "ca.pem", serverName: "users.internal" }, forward: "bearer", audience: "users" } }, readiness: { optional: ["dispatch"], intervalMs: 1000, timeoutMs: 500 }, diagnostics: { token: "${env:DIAG}" } },
    logging: { level: "info", format: "json", color: "never" },
    channels: { path: "/rt", allowedOrigins: ["https://app.example.com"], bus: "redis", trustedSources: ["gateway-eu"] },
    app: { featureFlags: { newCheckout: true }, anything: 1 },
  };
  assert.deepEqual(resolveConfig({ service: { source: "pso.config.json", values } }, { strict: true }).diagnostics, []);
  assert.deepEqual([...OPEN_NAMESPACES], ["channels.", "http.upstreams.", "app."], "the open namespaces are a deliberate, short list");
  assert.ok("logging.format" in SCHEMA && "logging.color" in SCHEMA, "settings the runtime reads are no longer reported as unknown");
  // the secret rule still applies inside an open namespace
  const leak = resolveConfig({ service: { source: "pso.config.json", values: { app: { apiToken: "live-abc-123" } } } }, { strict: true });
  assert.deepEqual(leak.diagnostics.map((d) => d.code), ["PSO_CONFIG_PLAINTEXT_SECRET"]);
  assert.ok(!JSON.stringify(leak.diagnostics).includes("live-abc-123"));
});

test("pso config:validate: development keeps warning (exit 0), --strict / production / PSO_CONFIG_STRICT fail (exit 1)", async () => {
  const root = await ws();
  const cfg = join(root, "gw", "pso.config.json");
  const original = (() => { try { return JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>; } catch { return {}; } })();

  // 1. what the CLI generates is valid in every mode
  for (const args of [[], ["--strict"], ["--env", "production"]]) { const v = await validate(root, ...args); assert.equal(v.code, 0, `${args.join(" ")}: ${v.out}`); }

  // 2. a typo
  json(cfg, { ...original, http: { rateLimit: { perMinuet: 5 } }, security: { authentication: { jwks: { urii: "https://tenant-7.example/keys" } } } });
  const dev = await validate(root);
  assert.equal(dev.code, 0, "development workflows are not broken by a typo");
  assert.deepEqual(dev.diagnostics.map((d) => [d.code, d.severity]), [["PSO_CONFIG_UNKNOWN_KEY", "warning"], ["PSO_CONFIG_UNKNOWN_KEY", "warning"]]);
  for (const args of [["--strict"], ["--env", "production"]]) {
    const v = await validate(root, ...args);
    assert.equal(v.code, 1, args.join(" "));
    assert.deepEqual(v.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).sort(), ['Unknown configuration key "http.rateLimit.perMinuet"', 'Unknown configuration key "security.authentication.jwks.urii"']);
    assert.ok(!v.out.includes("tenant-7"), "the misspelled setting's value is never printed");
  }
  process.env["PSO_CONFIG_STRICT"] = "true";
  try { assert.equal((await validate(root)).code, 1, "CI switch"); } finally { delete process.env["PSO_CONFIG_STRICT"]; }
  process.env["PSO_CONFIG_STRICT"] = "false";
  try { assert.equal((await validate(root, "--env", "production")).code, 0, "explicit opt-out"); } finally { delete process.env["PSO_CONFIG_STRICT"]; }

  // 3. environment overrides are validated too, and still take precedence when valid
  json(cfg, original);
  process.env["PSO_CFG_logging__levle"] = "debug";
  try { const v = await validate(root, "--strict"); assert.equal(v.code, 1); assert.match(v.diagnostics.find((d) => d.severity === "error")!.hint!, /^Did you mean "logging\.level"\?/); } finally { delete process.env["PSO_CFG_logging__levle"]; }
  process.env["PSO_CFG_logging__level"] = "debug";
  try {
    assert.equal((await validate(root, "--strict")).code, 0);
    const shown = JSON.parse((await pso(root, "config:show", "--service", "gw", "--json")).out) as Array<{ values: Array<{ key: string; value: unknown; origin: string }> }>;
    assert.deepEqual(shown[0]!.values.filter((v) => v.key === "logging.level").map((v) => [v.value, v.origin]), [["debug", "environment-variables"]]);
  } finally { delete process.env["PSO_CFG_logging__level"]; }

  // 4. the human-readable output names the key, the file and the suggestion
  json(cfg, { ...original, dispatch: { enabeld: true } });
  const text = await pso(root, "config:validate", "--service", "gw", "--strict");
  assert.equal(text.code, 1);
  assert.match(text.out, /ERROR\s+PSO_CONFIG_UNKNOWN_KEY gw\/pso\.config\.json: Unknown configuration key "dispatch\.enabeld"\n\s+hint: Did you mean "dispatch\.enabled"\?/);
  assert.match(text.out, /FAILED$/m);
});
