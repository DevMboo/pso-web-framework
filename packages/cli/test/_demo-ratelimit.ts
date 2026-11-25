// Not a test (no .test.ts suffix): produces the real rate-limit transcript quoted in security/rate-limiting.md.
// Run: node packages/cli/test/_demo-ratelimit.ts
import { buildGateway } from "./gw-fixture.ts";

const g = await buildGateway("pso-demo-rl-");
g.config({ http: { rateLimit: { perMinute: 3, burst: 3 } } });
const a = await g.start({ PSO_LOG_FORMAT: "pretty", PSO_LOG_COLOR: "never" });
for (let i = 1; i <= 5; i++) {
  const r = await fetch(a.url("/customers/ping"), { headers: { "x-correlation-id": `doc-rl-000${i}` } });
  const h = ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after"].map((k) => (r.headers.get(k) !== null ? `${k}: ${r.headers.get(k)}` : "")).filter(Boolean).join("  ");
  console.log(`request ${i}: HTTP ${r.status}  ${h}`);
  if (i === 4) console.log("   body: " + (await r.text()));
}
const health = await fetch(a.url("/health/ready"));
console.log(`health during the limit: HTTP ${health.status}`);
await new Promise((r) => setTimeout(r, 300));
console.log("\n=== terminal ===\n" + a.logs().split("\n").filter((l) => /rate|429|ping/.test(l)).join("\n"));
a.child.kill();
g.dispose();
