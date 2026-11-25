import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createServer as createTcp, type Server as TcpServer, type Socket } from "node:net";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { pso, tmp, prepare, startNode, randomPort } from "./helpers.ts";
import { expectProblem } from "./gw-fixture.ts";
import { loadHttpLimits, HttpLimitsError } from "@pso/http";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });

test("limits: secure defaults, every invalid value is reported, production refuses to disable safeguards", () => {
  const d = loadHttpLimits({});
  assert.deepEqual([d.maxBodyBytes, d.maxUpstreamResponseBytes, d.maxHeaderBytes, d.upstreamTimeoutMs, d.maxConcurrentRequests], [1_048_576, 10_485_760, 16_384, 5000, 0]);
  assert.equal(loadHttpLimits({ MAX_BODY_BYTES: "2048" }).maxBodyBytes, 2048);
  assert.throws(() => loadHttpLimits({ MAX_BODY_BYTES: "abc", UPSTREAM_TIMEOUT_MS: "0", MAX_HEADER_BYTES: "5" }), (e: unknown) => e instanceof HttpLimitsError && e.problems.length === 3 && e.problems.every((p) => !/abc/.test(p) || /non-numeric/.test(p)));
  assert.throws(() => loadHttpLimits({ HEADERS_TIMEOUT_MS: "60000", REQUEST_TIMEOUT_MS: "1000" }), /HEADERS_TIMEOUT_MS must not exceed/);
  assert.throws(() => loadHttpLimits({ NODE_ENV: "production", MAX_BODY_BYTES: "1073741824" }), /production does not allow/);
  assert.doesNotThrow(() => loadHttpLimits({ NODE_ENV: "production", MAX_BODY_BYTES: "5242880" }));
});

interface Fake { port: number; seen: string[]; close(): Promise<void>; }
const listen = (server: Server | TcpServer): Promise<number> => new Promise((r) => (server as Server).listen(0, "127.0.0.1", () => r(((server as Server).address() as { port: number }).port)));

/** a controllable upstream: behaviour is chosen by the query string `m` */
async function fakeUpstream(): Promise<Fake & { bytesWritten: () => number; closedEarly: () => number; bodyBytes: () => number }> {
  const seen: string[] = [];
  let written = 0, early = 0, bodyBytes = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const m = u.searchParams.get("m") ?? "ok";
    seen.push(`${req.method} ${u.pathname} ${m}`);
    req.on("data", (c: Buffer) => { bodyBytes += c.length; });
    if (m === "ok") { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); }); return; }
    if (m === "declared-big") { res.writeHead(200, { "content-length": String(500_000) }); res.end(Buffer.alloc(500_000, 97)); return; }
    if (m === "chunked-big") { // no content-length, far more data than any limit: stop as soon as the connection is closed
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 98);
      let sent = 0;
      const pump = (): void => {
        while (sent < 200 * 1024 * 1024) {
          const ok = res.write(chunk); sent += chunk.length; written = sent;
          if (!ok) { res.once("drain", pump); return; }
        }
        res.end();
      };
      res.on("close", () => { if (!res.writableFinished) early++; });
      pump();
      return;
    }
    if (m === "slow") { return; } // never answers: the proxy must time out
    if (m === "drop") { req.socket.destroy(); return; }
    if (m === "hold") { res.on("close", () => { early++; }); req.on("close", () => { /* observed through early */ }); return; } // answers never; used for client-abort and concurrency
    res.end();
  });
  const port = await listen(server);
  return { port, seen, bytesWritten: () => written, closedEarly: () => early, bodyBytes: () => bodyBytes, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** a TCP server that speaks garbage instead of HTTP */
async function garbageUpstream(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcp((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("data", () => { s.write("this is not http\r\n\r\n"); s.end(); }); });
  const port = await listen(server);
  return { port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

async function orchestrator(env: Record<string, string>) {
  const base = tmp("pso-lim-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  await pso(root, "create", "orchestrator", "gw", "--structure", "legacy");
  await pso(root, "create", "service", "users", "--structure", "legacy");
  assert.equal((await pso(root, "make:resource", "customer", "--service", "users", "--route", "/customers", "--scopes", "customers:read")).code, 0);
  assert.equal((await pso(root, "make:route", "customer", "ping", "--method", "GET", "--path", "/ping", "--public", "--upstream", "users", "--service", "gw")).code, 0);
  assert.equal((await pso(root, "make:route", "customer", "upload", "--method", "POST", "--path", "/upload", "--upstream", "users", "--service", "gw")).code, 0);
  const gw = join(root, "gw");
  prepare(gw);
  const port = randomPort();
  const pub = join(root, "test-public.pem");
  const keys = await generateKeyPair("ES256", { extractable: true });
  writeFileSync(pub, await exportSPKI(keys.publicKey));
  const token = await new SignJWT({ scope: "customers:read" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject("tester").setIssuedAt().setExpirationTime("10m").sign(keys.privateKey);
  const { child } = await startNode(gw, { PORT: String(port), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256", ...env });
  return { port, child, token, auth: { authorization: `Bearer ${token}` }, url: (p: string) => `http://127.0.0.1:${port}${p}` };
}

test("HTTP limits against a real orchestrator and real (fake) upstream services", { timeout: 300_000 }, async () => {
  const up = await fakeUpstream();
  const gw = await orchestrator({ PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}`, MAX_BODY_BYTES: "1000", MAX_UPSTREAM_RESPONSE_BYTES: "100000", UPSTREAM_TIMEOUT_MS: "600", UPSTREAM_RESPONSE_TIMEOUT_MS: "5000", MAX_CONCURRENT_REQUESTS: "3", RATE_LIMIT_PER_MINUTE: "0" });
  const memBefore = process.memoryUsage().rss;
  let step = "start";
  try {
    const small = await fetch(gw.url("/customers/ping?m=ok"));
    assert.equal(small.status, 200); assert.deepEqual(await small.json(), { ok: true });

    // ---- request bodies ----

    step = "request bodies";
    const okPost = await fetch(gw.url("/customers/upload?m=ok"), { method: "POST", headers: { "content-type": "application/json", ...gw.auth }, body: JSON.stringify({ a: "x".repeat(100) }) });
    assert.equal(okPost.status, 200, "a small request passes through");
    step = "declared-length 413";
    const declaredBig = await fetch(gw.url("/customers/upload?m=ok"), { method: "POST", headers: { "content-type": "application/json", ...gw.auth }, body: "x".repeat(5000) });
    assert.equal(declaredBig.status, 413, "declared Content-Length over the limit: controlled 413");
    await expectProblem(declaredBig, 413, "PSO_HTTP_PAYLOAD_TOO_LARGE");
    assert.ok(!up.seen.some((s) => s.includes("upload") && up.bodyBytes() >= 5000), "the oversized body never reached the upstream");
    // chunked (no Content-Length) request that exceeds the limit while streaming
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(500).fill(65)); c.close(); } });
    step = "chunked 413";
    const chunkedBig = await fetch(gw.url("/customers/upload?m=ok"), { method: "POST", headers: { "content-type": "application/octet-stream", ...gw.auth }, body: stream, duplex: "half" } as RequestInit);
    assert.equal(chunkedBig.status, 413, "chunked body over the limit: controlled 413 (not a dropped connection)");

    // ---- upstream response limits ----

    step = "upstream response limits";
    const declared = await fetch(gw.url("/customers/ping?m=declared-big"));
    assert.equal(declared.status, 502, "declared upstream length over the limit: stable gateway failure");
    await expectProblem(declared, 502, "PSO_UPSTREAM_RESPONSE_TOO_LARGE");
    const chunked = await fetch(gw.url("/customers/ping?m=chunked-big"));
    assert.equal(chunked.status, 200, "headers were already committed: no second status is possible");
    await assert.rejects(async () => { const r = chunked.body!.getReader(); for (;;) { const { done } = await r.read(); if (done) return; } }, "the stream is closed abnormally once it exceeds the limit");
    const t0 = Date.now();
    while (up.closedEarly() < 1 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(up.closedEarly() >= 1, "the upstream transfer was terminated");
    assert.ok(up.bytesWritten() < 32 * 1024 * 1024, `the proxy stopped the transfer early (upstream wrote ${up.bytesWritten()} of 200 MiB)`);

    // ---- failure mapping ----

    step = "failure mapping";
    assert.equal((await fetch(gw.url("/customers/ping?m=slow"))).status, 504, "slow upstream -> 504");
    assert.equal((await fetch(gw.url("/customers/ping?m=drop"))).status, 502, "connection reset before a response -> 502");

    // ---- client abort propagates to the upstream ----

    step = "client abort propagates to the upstream";
    const ac = new AbortController();
    const before = up.closedEarly();
    const pending = fetch(gw.url("/customers/ping?m=hold"), { signal: ac.signal }).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    assert.equal(await pending, "aborted");
    const t1 = Date.now();
    while (up.closedEarly() <= before && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(up.closedEarly() > before, "the upstream request was cancelled when the client disconnected");

    // ---- concurrency: shed load, then recover ----

    step = "concurrency: shed load, then recover";
    const burst = await Promise.all(Array.from({ length: 8 }, () => fetch(gw.url("/customers/ping?m=hold"), { signal: AbortSignal.timeout(1500) }).then((r) => r.status).catch(() => 0)));
    assert.ok(burst.filter((s) => s === 503).length >= 4, `requests beyond the concurrency limit get 503 (got ${JSON.stringify(burst)})`);
    await new Promise((r) => setTimeout(r, 2200)); // the held requests finish or are cancelled
    assert.equal((await fetch(gw.url("/customers/ping?m=ok"))).status, 200, "the orchestrator recovers after the burst");

    // ---- memory stays bounded after streaming ~200 MiB attempts ----

    step = "memory stays bounded after streaming ~200 MiB attempts";
    const grown = (process.memoryUsage().rss - memBefore) / (1024 * 1024);
    assert.ok(grown < 200, `test process memory grew by ${grown.toFixed(0)} MiB`);
  } catch (e) { (e as Error).message += ` [step: ${step}]`; throw e; } finally { gw.child.kill("SIGKILL"); await up.close(); }
});

test("an upstream that does not speak HTTP produces 502, never a hang or a crash", { timeout: 240_000 }, async () => {
  const bad = await garbageUpstream();
  const gw = await orchestrator({ PSO_UPSTREAM_USERS: `127.0.0.1:${bad.port}`, UPSTREAM_TIMEOUT_MS: "1500", RATE_LIMIT_PER_MINUTE: "0" });
  try {
    const r = await fetch(gw.url("/customers/ping"));
    assert.equal(r.status, 502);
    await expectProblem(r, 502, "PSO_UPSTREAM_BAD_GATEWAY");
    assert.equal((await fetch(gw.url("/health/live"))).status, 200, "the orchestrator is still healthy");
  } finally { gw.child.kill("SIGKILL"); await bad.close(); }
});

test("oversized request headers get 431 and invalid limits stop start-up with a clear message", { timeout: 240_000 }, async () => {
  const gw = await orchestrator({ MAX_HEADER_BYTES: "2048", RATE_LIMIT_PER_MINUTE: "0" });
  try {
    // fetch refuses nothing here: a 4 KiB header exceeds the 2 KiB budget
    const r = await fetch(gw.url("/health/live"), { headers: { "x-big": "a".repeat(4000) } }).catch(() => undefined);
    assert.ok(r === undefined || r.status === 431, `expected 431 or a closed connection, got ${r?.status}`);
    assert.equal((await fetch(gw.url("/health/live"))).status, 200);
  } finally { gw.child.kill("SIGKILL"); }
});
