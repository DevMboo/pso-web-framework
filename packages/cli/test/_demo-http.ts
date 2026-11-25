// Not a test (no .test.ts suffix): produces the real HTTP/terminal output quoted in the getting-started documentation.
// Run: node packages/cli/test/_demo-http.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { pso, prepare, startNode, randomPort, unusedPort } from "./helpers.ts";

const base = mkdtempSync(join(tmpdir(), "pso-demo-http-"));
await pso(base, "create", "workspace", "shop");
const root = join(base, "shop");
await pso(root, "create", "orchestrator", "gateway", "--structure", "legacy");
await pso(root, "create", "service", "catalog", "--structure", "legacy", "--port", String(await unusedPort()));
await pso(root, "make:resource", "customer", "--service", "catalog", "--route", "/customers", "--scopes", "customers:read");
await pso(root, "make:module", "reports", "--service", "gateway");
await pso(root, "make:controller", "reports", "--service", "gateway");
await pso(root, "make:route", "reports", "summary", "--method", "GET", "--path", "/summary", "--public", "--service", "gateway");
const gw = join(root, "gateway");
prepare(gw);
const keys = await generateKeyPair("ES256", { extractable: true });
const pub = join(root, "test-public.pem");
writeFileSync(pub, await exportSPKI(keys.publicKey));
const mint = (scope: string) => new SignJWT({ scope }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("https://shop.local").setAudience("shop-api").setSubject("ada").setIssuedAt().setExpirationTime("30m").sign(keys.privateKey);
const port = randomPort();
const { child, logs } = await startNode(gw, { PORT: String(port), PSO_LOG_FORMAT: "pretty", PSO_LOG_COLOR: "never", PSO_JWT_ISSUER: "https://shop.local", PSO_JWT_AUDIENCE: "shop-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256" });
const show = async (title: string, path: string, init: RequestInit = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const body = await r.text();
  console.log(`\n$ ${title}\nHTTP ${r.status} ${r.headers.get("content-type") ?? ""}\n${body.length > 600 ? body.slice(0, 600) + "…" : body}`);
};
const good = await mint("customers:read"), wrong = await mint("other:scope");
await show("GET /health/ready", "/health/ready");
await show("GET /reports/summary  (public)", "/reports/summary", { headers: { "x-correlation-id": "doc-corr-0001" } });
await show("GET /customers  (no token)", "/customers", { headers: { "x-correlation-id": "doc-corr-0002" } });
await show("GET /customers  (token without the scope)", "/customers", { headers: { authorization: `Bearer ${wrong}`, "x-correlation-id": "doc-corr-0003" } });
await show("GET /customers  (right scope, catalog is not running)", "/customers", { headers: { authorization: `Bearer ${good}`, "x-correlation-id": "doc-corr-0004" } });
await show("DELETE /customers/1  (not declared)", "/customers/1", { method: "DELETE", headers: { authorization: `Bearer ${good}`, "x-correlation-id": "doc-corr-0005" } });
await show("GET /nothing-here", "/nothing-here", { headers: { "x-correlation-id": "doc-corr-0006" } });
await new Promise((r) => setTimeout(r, 400));
console.log("\n=== terminal ===\n" + logs().split("\n").filter(Boolean).join("\n"));
child.kill();
try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
