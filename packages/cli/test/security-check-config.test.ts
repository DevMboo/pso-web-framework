import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

/** SEC005 must reflect the configuration the runtime really reads: security.authentication.* (modern), security.jwt.* (legacy, mapped onto it) and PSO_JWT_*. */
test("security:check recognises modern and legacy authentication configuration and still reports genuinely missing settings", { timeout: 120_000 }, async () => {
  const base = tmp("pso-seccfg-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "lab", "--layout", "flat")).code, 0);
  const ws = join(base, "lab");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--structure", "legacy", "--port", "8081")).code, 0);
  for (const a of [["make:module", "orders"], ["make:controller", "orders"]]) assert.equal((await pso(ws, ...a, "--service", "gateway")).code, 0);
  assert.equal((await pso(ws, "make:route", "orders", "list", "--method", "GET", "--path", "/", "--guard", "jwt", "--scopes", "orders:read", "--upstream", "catalog", "--service", "gateway")).code, 0);
  const cfg = join(ws, "gateway", "pso.config.json");
  const saved: Record<string, string | undefined> = {};
  for (const k of ["PSO_JWT_ISSUER", "PSO_JWT_AUDIENCE", "PSO_JWT_JWKS_URI", "PSO_JWT_PUBLIC_KEY_FILE", "PSO_ENV"]) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const check = async (config: unknown | undefined) => {
      writeFileSync(cfg, JSON.stringify(config ?? {}));
      const r = await pso(ws, "security:check");
      return { text: r.out + r.err, sec005: /SEC005/.test(r.out + r.err), sec007: /SEC007/.test(r.out + r.err) };
    };

    const none = await check(undefined);
    assert.ok(none.sec005, "nothing configured: SEC005");
    assert.ok(none.text.includes("security.authentication.issuer, security.authentication.audience, a key source (security.authentication.jwks.uri or security.authentication.publicKey.file)"), "the message names the keys the runtime reads");

    assert.equal((await check({ security: { authentication: { issuer: "https://idp.example.com", audience: "shop-api", algorithms: ["ES256"], jwks: { uri: "https://idp.example.com/.well-known/jwks.json" } } } })).sec005, false, "modern configuration");
    assert.equal((await check({ security: { authentication: { issuer: "https://idp.example.com", audience: "shop-api", publicKey: { file: "keys/k.public.pem" } } } })).sec005, false, "modern configuration with a public key file");
    assert.equal((await check({ security: { jwt: { issuer: "https://idp.example.com", audience: "shop-api", jwksUri: "https://idp.example.com/jwks.json" } } })).sec005, false, "legacy configuration");

    const partial = await check({ security: { authentication: { issuer: "https://idp.example.com" } } });
    assert.ok(partial.sec005, "an issuer alone is not enough");
    assert.ok(partial.text.includes("security.authentication.audience") && !partial.text.includes("security.authentication.issuer,"), "only what is missing is reported");

    const insecure = await check({ security: { authentication: { issuer: "https://idp.example.com", audience: "shop-api", jwks: { uri: "http://idp.example.com/jwks.json" } } } });
    assert.equal(insecure.sec005, false);
    assert.ok(insecure.sec007, "a plain-http JWKS URL on a remote host is still reported, for the modern key too");

    process.env["PSO_JWT_ISSUER"] = "https://idp.example.com"; process.env["PSO_JWT_AUDIENCE"] = "shop-api"; process.env["PSO_JWT_JWKS_URI"] = "https://idp.example.com/jwks.json";
    assert.equal((await check(undefined)).sec005, false, "PSO_JWT_* variables");
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
