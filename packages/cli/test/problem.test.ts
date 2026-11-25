import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProblem, PROBLEM_CATALOG, PROBLEM_CONTENT_TYPE } from "@pso/http";
import { pso } from "./helpers.ts";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";

const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); });

test("problem builder: every catalog kind is a valid, leak-free RFC 9457 problem with a unique stable code", () => {
  const codes = new Set<string>();
  for (const k of PROBLEM_CATALOG) {
    const p = buildProblem(k.status, k.legacy, { correlationId: "c-1", instance: "/orders/42?token=secret" });
    assert.deepEqual([p.status, p.code, p.error], [k.status, k.code, k.legacy]);
    assert.match(p.type, /^urn:pso:problem:[a-z0-9-]+$/);
    assert.equal(p.instance, "/orders/42", "the query string never appears in the instance");
    assert.ok(p.title.length > 0 && p.detail.length > 0);
    assert.ok(!codes.has(k.code), `duplicate code ${k.code}`); codes.add(k.code);
    assert.ok(!/secret/.test(JSON.stringify(p)));
  }
  assert.equal(PROBLEM_CONTENT_TYPE.split(";")[0], "application/problem+json");
  // an application HttpError keeps its status and exposes only its own deliberate message
  const app = buildProblem(418, "teapot_brewing", { correlationId: "c-2" });
  assert.deepEqual([app.status, app.code, app.type, app.detail], [418, "PSO_HTTP_ERROR_418", "urn:pso:problem:http-418", "teapot_brewing"]);
  // validation problems carry structured details
  const v = buildProblem(400, "bad_request", { correlationId: "c-3", errors: [{ field: "email", message: "must be an e-mail" }, { message: "body is required" }] });
  assert.deepEqual(v.errors, [{ field: "email", message: "must be an e-mail" }, { message: "body is required" }]);
});

test("orchestrator: every failure path answers application/problem+json with a stable code and never leaks internals", { timeout: 300_000 }, async () => {
  const gw = await buildGateway("pso-prob-", async ({ root, gw }) => {
    for (const [name, path] of [["boom", "/boom"], ["teapot", "/teapot"]] as const) assert.equal((await pso(root, "make:route", "customer", name, "--method", "GET", "--path", path, "--public", "--service", "gw")).code, 0);
    const f = join(gw, "src/routes/customer/customer.controller.ts");
    let t = readFileSync(f, "utf8");
    t = t.replace('import { Controller,', 'import { HttpError, Controller,');
    t = t.replace(/\/\/ TODO: implement boom\s*return \{\};/, 'throw new Error("secret internals: /etc/passwd password=hunter2");');
    t = t.replace(/\/\/ TODO: implement teapot\s*return \{\};/, 'throw new HttpError(418, "teapot_brewing");');
    writeFileSync(f, t);
  });
  gateways.push(gw);
  const x = await gw.start({ RATE_LIMIT_PER_MINUTE: "0", MAX_HEADER_BYTES: "2048" });
  try {
    const unauth = await fetch(x.url("/customers"));
    assert.equal(unauth.headers.get("www-authenticate"), "Bearer", "401 advertises the scheme");
    const p401 = await expectProblem(unauth, 401, "PSO_AUTH_UNAUTHORIZED");
    assert.equal(p401["instance"], "/customers");
    assert.equal(p401["error"], "unauthorized", "the legacy member is kept for compatibility");

    const nf = await expectProblem(await fetch(x.url("/nope?secret=1")), 404, "PSO_HTTP_NOT_FOUND");
    assert.equal(nf["instance"], "/nope", "no query string in the instance");

    const boom = await fetch(x.url("/customers/boom"));
    const pb = await expectProblem(boom, 500, "PSO_INTERNAL_ERROR");
    assert.ok(!/hunter2|passwd|secret internals/.test(JSON.stringify(pb)), "the exception message never reaches the client");
    assert.ok(!/hunter2|passwd/.test(x.logs()), "and it is not logged with the value either");

    const tp = await expectProblem(await fetch(x.url("/customers/teapot")), 418, "PSO_HTTP_ERROR_418");
    assert.equal(tp["detail"], "teapot_brewing", "an application-raised HttpError exposes its deliberate message");

    await expectProblem(await fetch(x.url("/customers/upload"), { method: "POST", headers: { ...x.auth, "content-type": "application/json" }, body: "{}" }), 503, "PSO_UPSTREAM_UNAVAILABLE");

    const big = await fetch(x.url("/health/live"), { headers: { "x-big": "a".repeat(4000) } }).catch(() => undefined);
    if (big) { assert.equal(big.status, 431); assert.match(big.headers.get("content-type") ?? "", /problem\+json/); assert.equal(((await big.json()) as { code: string }).code, "PSO_HTTP_HEADERS_TOO_LARGE"); }
  } finally { x.child.kill("SIGKILL"); }
});

test("conformance: the TypeScript catalog is exactly the shared cross-language fixture (fixtures/contracts/problem/catalog.json)", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/contracts/problem/catalog.json"), "utf8")) as { kinds: unknown };
  assert.deepEqual(JSON.parse(JSON.stringify(PROBLEM_CATALOG)), fixture.kinds, "update the fixture AND the Java catalog together");
});
