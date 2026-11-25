import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Principal, evaluate } from "@pso/security";
import { buildGateway, type Gw } from "./gw-fixture.ts";

interface Fixture {
  correlation: { header: string; cases: Array<{ name: string; incoming: string | null; propagated: boolean }> };
  liveness: { http: number; status: string };
  authorization: { cases: Array<{ name: string; requirement: { scopes: string[]; roles: string[] }; principal: { scopes: string[]; roles: string[] }; allowed: boolean }> };
}
const fx = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/contracts/conformance/http.json"), "utf8")) as Fixture;
const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); });

test("conformance: the authorization decision of the shared fixture (scopes all, roles any)", () => {
  for (const c of fx.authorization.cases) {
    const principal = new Principal({ subject: "u", issuer: "i", audiences: ["a"], scopes: c.principal.scopes, roles: c.principal.roles, permissions: [], expiresAt: new Date(Date.now() + 60_000) });
    const d = evaluate(principal, { scopes: c.requirement.scopes, roleSets: c.requirement.roles.length ? [c.requirement.roles] : [] });
    assert.equal(d.allowed, c.allowed, c.name);
  }
});

test("conformance: correlation id handling and the liveness body of the shared fixture, on a real orchestrator", { timeout: 200_000 }, async () => {
  const g = await buildGateway("pso-conf-"); gateways.push(g);
  const x = await g.start({ RATE_LIMIT_PER_MINUTE: "0" });
  try {
    for (const c of fx.correlation.cases) {
      const r = await fetch(x.url("/customers/ping"), { headers: c.incoming === null ? {} : { [fx.correlation.header]: c.incoming } });
      const got = r.headers.get(fx.correlation.header) ?? "";
      assert.ok(got.length > 0, c.name);
      if (c.propagated) assert.equal(got, c.incoming, c.name); else assert.notEqual(got, c.incoming, c.name);
      assert.match(got, /^[A-Za-z0-9._-]{8,64}$/, c.name + ": whatever is returned is itself well-formed");
    }
    const live = await fetch(x.url("/health/live"));
    assert.equal(live.status, fx.liveness.http);
    assert.equal(((await live.json()) as { status: string }).status, fx.liveness.status);
  } finally { x.child.kill("SIGKILL"); }
});
