import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import type { ChildProcess } from "node:child_process";
import { pso, tmp, prepare, startNode, randomPort, unusedPort } from "./helpers.ts";

/**
 * A generated, compiled orchestrator (guarded GET /customers and POST /customers/upload forwarding to a "users" upstream) that tests
 * can start several times with different environments. Shared by the HTTP limits, rate limiting and custom guard tests.
 */
export interface Gw {
  root: string; gw: string; token: string;
  /** writes pso.config.json (merged over an empty object) before the next start */
  config(c: Record<string, unknown>): void;
  start(env?: Record<string, string>): Promise<{ child: ChildProcess; port: number; url: (p: string) => string; auth: Record<string, string>; logs: () => string }>;
  dispose(): void;
}

export async function buildGateway(prefix = "pso-gw-", setup?: (ctx: { root: string; gw: string }) => Promise<void> | void): Promise<Gw> {
  const base = tmp(prefix);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "create", "service", "users", "--structure", "legacy", "--port", String(await unusedPort()));
  assert.equal((await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read")).code, 0);
  assert.equal((await pso(root, "make:route", "customer", "ping", "--method", "GET", "--path", "/ping", "--public", "--upstream", "users", "--service", "gw")).code, 0);
  assert.equal((await pso(root, "make:route", "customer", "upload", "--method", "POST", "--path", "/upload", "--upstream", "users", "--service", "gw")).code, 0);
  const gw = join(root, "gw");
  if (setup) await setup({ root, gw });
  prepare(gw);
  const pub = join(root, "test-public.pem");
  const keys = await generateKeyPair("ES256", { extractable: true });
  writeFileSync(pub, await exportSPKI(keys.publicKey));
  const token = await new SignJWT({ scope: "customers:read" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject("tester").setIssuedAt().setExpirationTime("30m").sign(keys.privateKey);
  const cfgFile = join(gw, "pso.config.json");
  let original = "{}";
  try { original = readFileSync(cfgFile, "utf8"); } catch { /* none yet */ }
  return {
    root, gw, token,
    config(c) { writeFileSync(cfgFile, JSON.stringify({ ...(JSON.parse(original) as object), ...c }, null, 2)); },
    async start(env = {}) {
      const port = randomPort();
      const { child, logs } = await startNode(gw, { PORT: String(port), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256", ...env });
      return { child, port, url: (p: string) => `http://127.0.0.1:${port}${p}`, auth: { authorization: `Bearer ${token}` }, logs };
    },
    dispose() { try { rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } },
  };
}

/** Asserts a response follows the PSO error standard (RFC 9457) and returns the parsed problem. */
export async function expectProblem(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/problem\+json/);
  const p = (await res.json()) as Record<string, unknown>;
  assert.equal(p["status"], status);
  assert.equal(p["code"], code);
  assert.match(String(p["type"]), /^urn:pso:problem:[a-z0-9-]+$/);
  for (const f of ["title", "detail", "correlationId"]) assert.equal(typeof p[f], "string", f);
  assert.equal(res.headers.get("x-correlation-id"), p["correlationId"], "the header and the body carry the same correlation id");
  assert.ok(!/at .*\(.*:\d+:\d+\)|node_modules|[A-Z]:\\/.test(JSON.stringify(p)), "no stack or host path leaks");
  return p;
}
