import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStudio } from "../src/studio.ts";
import { pso, tmp } from "./helpers.ts";

/** A workspace whose orchestrator port is served by a small real HTTP server (the API Client's "process" target). */
async function setup() {
  const echo: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("late"); }, 4000).unref(); return; }
      if (req.url === "/redirect") { res.writeHead(302, { location: "http://example.com/" }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "session=abcdefghijklmnop; HttpOnly" });
      res.end(JSON.stringify({ method: req.method, url: req.url, authorization: req.headers["authorization"] ?? null, contentType: req.headers["content-type"] ?? null, body: Buffer.concat(chunks).toString("utf8") }));
    });
  });
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const port = (echo.address() as { port: number }).port;
  const parent = tmp("pso-apiclient-");
  await pso(parent, "create", "workspace", "w", "--layout", "flat");
  const root = join(parent, "w");
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "w", services: [{ name: "gateway", path: "gateway", runtime: "node", role: "orchestrator", port }] }, null, 2));
  const studio = await startStudio({ root });
  const send = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${studio.port}${path}`, { method: "POST", headers: { cookie: `pso_studio=${studio.token}`, origin: `http://127.0.0.1:${studio.port}`, "x-pso-studio": "1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  return { root, studio, send, close: async () => { await studio.close(); echo.close(); } };
}

test("API Client: real request to a declared target, credentials masked in the history, cookies masked in the response", async () => {
  const s = await setup();
  try {
    const r = await s.send("/api/client/send", { target: "process:gateway", method: "POST", path: "/orders", query: [["access_token", "abcdefghijkl1234"], ["page", "2"]], headers: [["x-trace", "t-1"]], body: { kind: "json", text: '{"sku":"A1"}' }, auth: { kind: "bearer", token: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXRlc3Q" } });
    assert.equal(r.status, 200);
    const echoed = JSON.parse(String(r.body["text"])) as Record<string, string>;
    assert.equal(echoed["method"], "POST");
    assert.equal(echoed["url"], "/orders?access_token=abcdefghijkl1234&page=2", "the request really reached the service");
    assert.equal(echoed["contentType"], "application/json");
    assert.match(String(r.body["text"]), /\[REDACTED/, "a token echoed back is masked before it reaches the page");
    const cookie = (r.body["headers"] as Array<[string, string]>).find(([k]) => k === "set-cookie");
    assert.equal(cookie?.[1], "[REDACTED]");
    const hist = readFileSync(join(s.root, ".pso", "studio", "api-history.json"), "utf8");
    assert.match(hist, /"Bearer \[REDACTED\]"/);
    assert.match(hist, /"access_token",\s*"\[REDACTED\]"/);
    assert.doesNotMatch(hist, /eyJhbGciOiJFUzI1NiJ9|abcdefghijkl1234|"sku"/, "the history keeps neither credentials nor bodies");
  } finally { await s.close(); }
});

test("API Client: redirects are returned, never followed; multipart uploads carry the file", async () => {
  const s = await setup();
  try {
    const r = await s.send("/api/client/send", { target: "process:gateway", method: "GET", path: "/redirect" });
    assert.equal(r.body["status"], 302);
    assert.equal((r.body["headers"] as Array<[string, string]>).find(([k]) => k === "location")?.[1], "http://example.com/");
    const up = await s.send("/api/client/send", { target: "process:gateway", method: "POST", path: "/files", body: { kind: "multipart", fields: [["title", "report"]], files: [{ field: "file", filename: "a.txt", contentType: "text/plain", base64: Buffer.from("hello file").toString("base64") }] } });
    const e = JSON.parse(String(up.body["text"])) as { contentType: string; body: string };
    assert.match(e.contentType, /^multipart\/form-data; boundary=/);
    assert.match(e.body, /name="file"; filename="a\.txt"\r\nContent-Type: text\/plain\r\n\r\nhello file/);
    assert.match(e.body, /name="title"\r\n\r\nreport/);
  } finally { await s.close(); }
});

test("API Client: deadlines and cancellation end a request; the boundary refuses everything that is not a declared target", async () => {
  const s = await setup();
  try {
    const t0 = Date.now();
    const slow = await s.send("/api/client/send", { target: "process:gateway", method: "GET", path: "/slow", timeoutMs: 1000 });
    assert.equal(slow.body["code"], "PSO_NET_TIMEOUT");
    assert.ok(Date.now() - t0 < 3500);
    const pending = s.send("/api/client/send", { target: "process:gateway", method: "GET", path: "/slow", requestId: "cancel-me-123" });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual((await s.send("/api/client/cancel", { requestId: "cancel-me-123" })).body, { cancelled: true });
    assert.equal((await pending).body["code"], "PSO_NET_CANCELLED");
    for (const [why, b] of [
      ["undeclared target", { target: "http://127.0.0.1:22", method: "GET", path: "/" }],
      ["scheme in path", { target: "process:gateway", method: "GET", path: "/http://evil/" }],
      ["protocol-relative path", { target: "process:gateway", method: "GET", path: "//evil/x" }],
      ["unknown method", { target: "process:gateway", method: "TRACE", path: "/" }],
      ["forbidden header", { target: "process:gateway", method: "GET", path: "/", headers: [["transfer-encoding", "chunked"]] }],
      ["header injection", { target: "process:gateway", method: "GET", path: "/", headers: [["x-a", "1\r\nx-b: 2"]] }],
      ["body on GET", { target: "process:gateway", method: "GET", path: "/", body: { kind: "raw", text: "x" } }],
    ] as const) assert.equal((await s.send("/api/client/send", b)).status, 400, why);
    // no cross-site form can reach it, and infrastructure operations need --ops
    assert.equal((await s.send("/api/client/send", { target: "process:gateway", method: "GET", path: "/" }, { "x-pso-studio": "" })).status, 403);
    assert.equal((await s.send("/api/client/send", { target: "process:gateway", method: "GET", path: "/" }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.send("/api/ops/containers", { action: "down", confirm: "down local" })).status, 403);
    assert.equal((await s.send("/api/ops/infra", { action: "apply", confirm: "apply local" })).status, 403);
  } finally { await s.close(); }
});

test("API Client: saved collections never store sensitive header values or variables", async () => {
  const s = await setup();
  try {
    const r = await s.send("/api/client/collections", { requests: [{ name: "orders", method: "GET", path: "/orders", headers: [["authorization", "Bearer real-token-value-123"], ["x-api-key", "k-123456"], ["accept", "application/json"]], auth: { kind: "bearer", token: "real-token-value-123" } }], variables: [["base", "/v1"], ["token", "real-token-value-123"]] });
    assert.equal(r.status, 200);
    assert.equal(r.body["droppedSensitiveVariables"], 1);
    const saved = readFileSync(join(s.root, ".pso", "studio", "api-collections.json"), "utf8");
    assert.doesNotMatch(saved, /real-token-value-123|k-123456/);
    assert.match(saved, /\{\{authorization\}\}/);
    assert.match(saved, /"base",\s*"\/v1"/);
  } finally { await s.close(); }
});
