import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JWK } from "jose";
import { loadSecurityConfig, JwtVerifier, JwksKeyProvider, type SecurityConfig } from "../src/index.ts";
import { idp, jwksEnv, tmp } from "./helpers.ts";

/**
 * Cross-runtime conformance: fixtures/contracts/jwt/cases.json holds pre-signed tokens (throwaway key, public JWK only). The Spring starter judges
 * the very same tokens in JwtConformanceTests; both must give the verdict recorded in the file.
 */
interface Fixture { issuer: string; audience: string; jwks: { keys: JWK[] }; cases: Array<{ name: string; token: string; authenticated: boolean }> }
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/contracts/jwt/cases.json"), "utf8")) as Fixture;
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("conformance: every token of the shared JWT fixture gets the recorded verdict from the TypeScript verifier", async () => {
  assert.ok(fixture.cases.length >= 16);
  const server = await idp(fixture.jwks.keys);
  const dir = tmp(); dirs.push(dir);
  try {
    const cfg = loadSecurityConfig({ projectDir: dir, env: { ...jwksEnv(server.url), PSO_JWT_ISSUER: fixture.issuer, PSO_JWT_AUDIENCE: fixture.audience } });
    const provider = new JwksKeyProvider(cfg.authentication.key as Extract<SecurityConfig["authentication"]["key"], { kind: "jwks" }>);
    await provider.init();
    const verifier = new JwtVerifier(cfg.authentication, provider);
    for (const c of fixture.cases) {
      const r = await verifier.verifyAuthorization(`Bearer ${c.token}`);
      assert.equal(r.ok, c.authenticated, `${c.name}: ${r.ok ? "accepted" : `rejected (${r.reason})`}`);
    }
    // the accepted principal carries the claims the other runtime maps to authorities
    const ok = await verifier.verifyAuthorization(`Bearer ${fixture.cases[0]!.token}`);
    assert.ok(ok.ok && ok.principal.hasScope("customers:read") && ok.principal.hasRole("admin") && ok.principal.subject === "user-1");
  } finally { await server.close(); }
});
