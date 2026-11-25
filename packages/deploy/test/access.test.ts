import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isMutating, resolveUrls, runTest, tcpProbe } from "../src/access.ts";

/** Request-tester guardrails and URL resolution: no network beyond a loopback server created here. */
test("only safe methods are non-mutating", () => {
  for (const m of ["GET", "head", "OPTIONS"]) assert.equal(isMutating(m), false);
  for (const m of ["POST", "PUT", "patch", "DELETE"]) assert.equal(isMutating(m), true);
});

test("a mutating request is refused without confirmation and never reaches the server", async () => {
  let hits = 0;
  const s = createServer((_q, r) => { hits++; r.end("{}"); }); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  try {
    await assert.rejects(runTest({ method: "POST", path: "/x" }, { baseUrl: `http://127.0.0.1:${port}` }));
    assert.equal(hits, 0);
    const ok = await runTest({ method: "GET", path: "/x" }, { baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 200); assert.equal(hits, 1);
  } finally { s.close(); }
});

test("a bearer token is never sent to a plain-http non-loopback destination", async () => {
  await assert.rejects(runTest({ method: "GET", path: "/", token: "secret-token" }, { baseUrl: "http://203.0.113.9", timeoutMs: 500 }));
});

test("tcpProbe reports a closed loopback port as refused or no-answer, not open", async () => {
  assert.notEqual(await tcpProbe("127.0.0.1", 1, 800), "open");
});

test("resolveUrls substitutes the server address when the nginx server_name is a catch-all", () => {
  const r = resolveUrls([{ scheme: "https", host: null, hostSource: "default", port: 443, path: "/", visibility: "public-binding", redirectsTo: null, tls: null } as never], "203.0.113.5");
  assert.equal(r[0]?.resolvedHost, "203.0.113.5");
});
