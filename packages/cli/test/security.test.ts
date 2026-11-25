import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, importPKCS8, jwtVerify, SignJWT, type JSONWebKeySet } from "jose";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* OS reaps temp */ } } });
for (const k of Object.keys(process.env)) if (k.startsWith("PSO_JWT_")) delete process.env[k];

async function ws() {
  const base = tmp("pso-sec-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "service", "users", "--structure", "legacy");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  return root;
}
const ids = (out: string) => (JSON.parse(out).findings as Array<{ id: string; severity: string }>).map((f) => `${f.id}:${f.severity}`);

test("keys: generate, publish JWKS that really verifies tokens, never print private material", async () => {
  const root = await ws();
  const g = await pso(root, "security:keys", "--generate", "--alg", "ES256");
  assert.equal(g.code, 0, g.err);
  assert.ok(!/PRIVATE KEY/.test(g.out + g.err), "no private key in output");
  const idx = JSON.parse(readFileSync(join(root, "keys/index.json"), "utf8"));
  assert.equal(idx.length, 1);
  const kid = idx[0].kid as string;
  assert.ok(readFileSync(join(root, ".gitignore"), "utf8").includes("keys/*.private.pem"));
  assert.equal((await pso(root, "security:keys", "--generate")).code, 1, "second generate refused");

  const priv = await importPKCS8(readFileSync(join(root, `keys/${kid}.private.pem`), "utf8"), "ES256");
  const token = await new SignJWT({ scope: "x" }).setProtectedHeader({ alg: "ES256", kid }).setIssuer("i").setAudience("a").setExpirationTime("5m").sign(priv);
  const jwks = JSON.parse(readFileSync(join(root, "keys/jwks.json"), "utf8")) as JSONWebKeySet;
  assert.ok(jwks.keys.every((k) => !("d" in k)), "JWKS contains public parameters only");
  await jwtVerify(token, createLocalJWKSet(jwks), { issuer: "i", audience: "a" });
  assert.ok(!(await pso(root, "security:keys", "--json")).out.includes("PRIVATE"));
});

test("rotate: new key active, old one keeps validating until retired, active key cannot be retired", async () => {
  const root = await ws();
  await pso(root, "security:keys", "--generate", "--alg", "ES256");
  const oldKid = JSON.parse(readFileSync(join(root, "keys/index.json"), "utf8"))[0].kid as string;
  const oldPriv = await importPKCS8(readFileSync(join(root, `keys/${oldKid}.private.pem`), "utf8"), "ES256");
  const oldToken = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: oldKid }).setExpirationTime("5m").sign(oldPriv);

  const dry = await pso(root, "security:rotate", "--dry-run");
  assert.equal(dry.code, 0);
  assert.equal(JSON.parse(readFileSync(join(root, "keys/index.json"), "utf8")).length, 1, "dry-run changes nothing");

  assert.equal((await pso(root, "security:rotate")).code, 0);
  const idx = JSON.parse(readFileSync(join(root, "keys/index.json"), "utf8")) as Array<{ kid: string; status: string }>;
  assert.deepEqual(idx.map((k) => k.status), ["retiring", "active"]);
  let jwks = JSON.parse(readFileSync(join(root, "keys/jwks.json"), "utf8")) as JSONWebKeySet;
  assert.equal(jwks.keys.length, 2);
  await jwtVerify(oldToken, createLocalJWKSet(jwks)); // overlap period: old tokens still valid

  assert.equal((await pso(root, "security:rotate", "--retire", idx[1]!.kid)).code, 1, "active key protected");
  assert.equal((await pso(root, "security:rotate", "--retire", oldKid)).code, 0);
  jwks = JSON.parse(readFileSync(join(root, "keys/jwks.json"), "utf8")) as JSONWebKeySet;
  assert.equal(jwks.keys.length, 1);
  await assert.rejects(jwtVerify(oldToken, createLocalJWKSet(jwks)), "retired key no longer validates");
  assert.ok(readdirSync(join(root, "keys")).filter((f) => f.endsWith(".private.pem")).length === 2);
});

test("RS256 keys are generated at 3072 bits", async () => {
  const root = await ws();
  assert.equal((await pso(root, "security:keys", "--generate", "--alg", "RS256")).code, 0);
  const jwks = JSON.parse(readFileSync(join(root, "keys/jwks.json"), "utf8")) as { keys: Array<{ n: string; alg: string }> };
  assert.equal(jwks.keys[0]!.alg, "RS256");
  assert.ok(Buffer.from(jwks.keys[0]!.n, "base64url").length >= 384);
  assert.equal((await pso(root, "security:keys", "--generate", "--alg", "HS256")).code, 1);
});

test("check: clean workspace passes; git-ignored keys are not flagged", async () => {
  const root = await ws();
  assert.equal((await pso(root, "security:check", "--json")).code, 0);
  await pso(root, "security:keys", "--generate");
  const r = await pso(root, "security:check", "--json");
  assert.equal(r.code, 0, r.out);
  assert.ok(!ids(r.out).some((i) => i.startsWith("SEC001")));
});

test("check: detects committed private keys without printing them", async () => {
  const root = await ws();
  const fake = "-----BEGIN PRIVATE KEY-----\nTOPSECRETMATERIAL\n-----END PRIVATE KEY-----\n";
  mkdirSync(join(root, "gw/src/configs"), { recursive: true });
  writeFileSync(join(root, "gw/src/configs/leak.txt"), fake);
  const r = await pso(root, "security:check", "--json");
  assert.equal(r.code, 1);
  assert.ok(ids(r.out).includes("SEC001:critical"));
  assert.ok(!r.out.includes("TOPSECRETMATERIAL"));
});

test("check: spring authorization regressions and hard-coded credentials", async () => {
  const root = await ws();
  // a hand-written chain replaces the one from the PSO security starter; the check must still analyse it
  const dir = join(root, "users/src/main/java/com/pso/users/configs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SecurityConfig.java"), [
    "package com.pso.users.configs;",
    "",
    "import org.springframework.security.web.SecurityFilterChain;",
    "",
    "class SecurityConfig {",
    "    SecurityFilterChain chain(org.springframework.security.config.annotation.web.builders.HttpSecurity http) throws Exception {",
    "        return http.authorizeHttpRequests(a -> a.anyRequest().permitAll()).build();",
    "    }",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "users/src/main/resources/application.yml"), readFileSync(join(root, "users/src/main/resources/application.yml"), "utf8") + "  datasource:\n    password: hunter2\n");
  const r = await pso(root, "security:check", "--json");
  assert.equal(r.code, 1);
  const got = ids(r.out);
  assert.ok(got.includes("SEC006:critical"));
  assert.ok(got.includes("SEC010:high"));
  assert.ok(!r.out.includes("hunter2"));
});

test("check: public state-changing route, jwt guard without configuration, wide bind, plaintext secret", async () => {
  const root = await ws();
  await pso(root, "make:resource", "hook", "--service", "users", "--method", "POST", "--route", "/hooks");
  await pso(root, "make:resource", "list", "--service", "users", "--route", "/lists");
  // a public POST cannot be generated (the CLI refuses it); a human can still declare one, and the check must catch it
  const routesFile = join(root, "gw/src/routes/hook/ROUTES.pso.ts");
  writeFileSync(routesFile, readFileSync(routesFile, "utf8").replace(/security: { guard: "jwt" }/, "security: { public: true }"));
  writeFileSync(join(root, "gw/pso.config.json"), JSON.stringify({ server: { host: "0.0.0.0" }, db: { password: "pw" } }));
  const r = await pso(root, "security:check", "--json");
  assert.equal(r.code, 1);
  const got = ids(r.out);
  for (const want of ["SEC004:high", "SEC005:high", "SEC009:medium", "SEC008:high"]) assert.ok(got.includes(want), `${want} in ${got.join(",")}`);

  writeFileSync(join(root, "gw/pso.config.json"), JSON.stringify({ security: { jwt: { issuer: "i", audience: "a", jwksUri: "https://idp.test/jwks" } } }));
  writeFileSync(routesFile, readFileSync(routesFile, "utf8").replace("security: { public: true }", "security: { guard: \"jwt\" }"));
  const fixed = await pso(root, "security:check", "--json");
  assert.equal(fixed.code, 0, fixed.out);
});

test("policy shows the effective matrix; audit reports honestly", async () => {
  const root = await ws();
  await pso(root, "make:resource", "orders", "--service", "users", "--scopes", "orders:read,orders:write");
  const p = JSON.parse((await pso(root, "security:policy", "--json")).out) as { defaultPolicy: string; routes: Array<{ access: string; scopes: string[] }>; services: Array<{ default: string }> };
  assert.equal(p.defaultPolicy, "deny");
  assert.deepEqual(p.routes.find((r) => r.access === "guarded")!.scopes, ["orders:read", "orders:write"]);
  assert.equal(p.services[0]!.default, "deny by default");

  const a = JSON.parse((await pso(root, "security:audit", "--json")).out) as { report: Array<{ tool: string; status: string; detail: string }> };
  assert.equal(a.report.find((r) => r.tool === "npm audit")!.status, "skipped", "no lockfile -> skipped, never 'ok'");
  assert.match(a.report.find((r) => r.tool === "pom scan")!.detail, /NOT performed/);
  const pom = join(root, "users/pom.xml");
  writeFileSync(pom, readFileSync(pom, "utf8").replace("<version>0.1.0</version>", "<version>0.1.0</version>\n  <!-- --><dependencies><dependency><version>1.0-SNAPSHOT</version></dependency></dependencies>"));
  assert.equal((await pso(root, "security:audit")).code, 1);
  assert.ok(existsSync(pom));
});
