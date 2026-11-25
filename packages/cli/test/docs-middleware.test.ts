import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pso, randomPort } from "./helpers.ts";
import { buildGateway, type Gw } from "./gw-fixture.ts";

/** The middleware and filter examples of orchestrator/middleware-and-filters.md, run for real. */
const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); });

const MIDDLEWARE = `import type { Middleware } from "@pso/http";

const middleware: Middleware = (req, _res, route) => {
  console.log(JSON.stringify({ msg: "audited", method: req.method, path: route.path }));
};
export default middleware;
`;
const FILTER = `import { HttpError, type Filter } from "@pso/http";

const filter: Filter = (err, _req, res) => {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  res.writeHead(409, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "conflict" }));
  return true;
};
export default filter;
`;

test("middleware runs after the guards and only for requests that passed them; a filter turns an HttpError into its own answer; unknown names stop start-up", { timeout: 240_000 }, async () => {
  const g = await buildGateway("pso-mw-", async ({ root, gw }) => {
    assert.equal((await pso(root, "make:module", "orders", "--service", "gw")).code, 0);
    assert.equal((await pso(root, "make:controller", "orders", "--service", "gw", "--prefix", "/orders")).code, 0);
    assert.equal((await pso(root, "make:route", "orders", "create", "--method", "POST", "--path", "/", "--scopes", "customers:read", "--service", "gw")).code, 0);
    const mw = await pso(root, "make:middleware", "audit", "--service", "gw"), fl = await pso(root, "make:filter", "conflict", "--service", "gw");
    assert.equal(mw.code, 0, mw.err); assert.equal(fl.code, 0, fl.err);
    assert.ok(existsSync(join(gw, "src/middlewares/audit.middleware.ts")) && existsSync(join(gw, "src/filters/conflict.filter.ts")));
    writeFileSync(join(gw, "src/middlewares/audit.middleware.ts"), MIDDLEWARE);
    writeFileSync(join(gw, "src/filters/conflict.filter.ts"), FILTER);
    const routes = join(gw, "src/routes/orders/ROUTES.pso.ts");
    const text = readFileSync(routes, "utf8");
    assert.match(text, /action: "create"/);
    writeFileSync(routes, text.replace('action: "create",', 'action: "create",\n      middleware: ["audit"],\n      filters: ["conflict"],'));
    const ctl = join(gw, "src/routes/orders/orders.controller.ts");
    writeFileSync(ctl, readFileSync(ctl, "utf8").replace("// TODO: implement create\n    return {};", "if ((body as { fail?: boolean } | undefined)?.fail) throw new HttpError(409, \"duplicate\");\n    return { ok: true };").replace(/import \{ ([^}]*) \} from "@pso\/http";/, (_m, n: string) => `import { ${n}, HttpError } from "@pso/http";`));
  });
  gateways.push(g);
  const a = await g.start();
  try {
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(a.url("/orders"), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    // no token: the guard refuses first, the middleware never runs
    assert.equal((await post({})).status, 401);
    assert.ok(!a.logs().includes("audited"), "middleware did not see an unauthenticated request");
    // authenticated: the middleware runs, then the action
    const ok = await post({}, a.auth);
    assert.equal(ok.status, 201); assert.deepEqual(await ok.json(), { ok: true });
    assert.match(a.logs(), /"msg":"audited","method":"POST","path":"\/orders"/);
    // the action throws HttpError(409): the filter writes the answer, not the default problem body
    const dup = await post({ fail: true }, a.auth);
    assert.equal(dup.status, 409); assert.equal(dup.headers.get("content-type"), "application/json");
    assert.deepEqual(await dup.json(), { error: "conflict" });
  } finally { a.child.kill(); }

  // an unknown middleware or filter name is a start-up error (PSO_ROUTE_008)
  const routes = join(g.gw, "src/routes/orders/ROUTES.pso.ts");
  const dist = join(g.gw, "dist/routes/orders/ROUTES.pso.js");
  writeFileSync(dist, readFileSync(dist, "utf8").replace('"audit"', '"does-not-exist"'));
  const r = spawnSync(process.execPath, ["dist/main.js"], { cwd: g.gw, encoding: "utf8", timeout: 20_000, env: { ...process.env, PORT: String(randomPort()), PSO_WORKSPACE: join(g.root, "pso.workspace.json"), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: join(g.root, "test-public.pem"), PSO_JWT_ALGORITHMS: "ES256" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /PSO_ROUTE_008/);
  assert.ok(routes.length > 0);
});
