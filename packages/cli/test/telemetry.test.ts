import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { traceContextFrom, traceparentOf, Telemetry, loadDiagnostics, loadOtlp, DURATION_BOUNDS_S } from "@pso/http";
import { buildGateway, expectProblem, type Gw } from "./gw-fixture.ts";

const gateways: Gw[] = [];
after(() => { for (const g of gateways) g.dispose(); });
const TOKEN = "t".repeat(40);

test("trace context: a valid traceparent is continued, invalid ones start a new trace", () => {
  const trace = "4bf92f3577b34da6a3ce929d0e0e4736", parent = "00f067aa0ba902b7";
  const c = traceContextFrom(`00-${trace}-${parent}-01`);
  assert.deepEqual([c.traceId, c.parentSpanId, c.sampled], [trace, parent, true]);
  assert.notEqual(c.spanId, parent, "this hop has its own span id");
  assert.equal(traceContextFrom(`00-${trace.toUpperCase()}-${parent}-00`).sampled, false, "case-insensitive, sampled flag honoured");
  for (const bad of [undefined, "", "garbage", `01-${trace}-${parent}-01`, `00-${"0".repeat(32)}-${parent}-01`, `00-${trace}-${"0".repeat(16)}-01`, `00-${trace}-${parent}`]) {
    const n = traceContextFrom(bad);
    assert.match(n.traceId, /^[0-9a-f]{32}$/); assert.equal(n.parentSpanId, undefined, String(bad));
  }
  assert.match(traceparentOf(c), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("telemetry unit: histograms use the declared bounds, cardinality is bounded, nothing is reported as zero by default", () => {
  const t = new Telemetry("svc");
  const trace = traceContextFrom(undefined);
  t.requestStarted();
  t.requestFinished({ method: "GET", route: "/x", status: 200, seconds: 0.03, trace, startedAtMs: Date.now(), correlationId: "c" });
  const s = t.snapshot() as { http: { requests: number; byClass: Record<string, number>; routes: Array<{ buckets: number[]; count: number }>; durationBoundsSeconds: number[]; inFlight: number }; rateLimit: unknown; dispatch: unknown; instrumented: boolean };
  assert.equal(s.http.requests, 1); assert.equal(s.http.byClass["2xx"], 1); assert.equal(s.http.inFlight, 0);
  assert.deepEqual(s.http.durationBoundsSeconds, [...DURATION_BOUNDS_S]);
  assert.equal(s.http.routes[0]!.buckets[3], 1, "0.03 s falls in the (0.025, 0.05] bucket");
  assert.equal(s.rateLimit, null, "an absent subsystem is null (unavailable), not an object full of zeros");
  assert.equal(s.dispatch, null);
  for (let i = 0; i < 700; i++) t.requestFinished({ method: "GET", route: `/r${i}`, status: 200, seconds: 0.001, trace, startedAtMs: Date.now(), correlationId: "c" });
  assert.ok((t.snapshot() as { http: { routes: unknown[] } }).http.routes.length <= 500, "route cardinality is bounded");
});

test("configuration: weak diagnostics tokens and unsafe OTLP endpoints stop start-up logic", () => {
  assert.equal(loadDiagnostics({}).token, undefined);
  assert.throws(() => loadDiagnostics({ PSO_DIAGNOSTICS_TOKEN: "short" }), /at least 32/);
  assert.equal(loadDiagnostics({ PSO_DIAGNOSTICS_TOKEN: TOKEN }).token, TOKEN);
  assert.equal(loadOtlp({}, "svc"), undefined, "no endpoint: nothing is exported");
  assert.throws(() => loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://x" }, "svc"), /http:\/\/ or https:\/\//);
  assert.throws(() => loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://u:p@collector:4318" }, "svc"), /must not contain credentials/);
  assert.throws(() => loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318", NODE_ENV: "production" }, "svc"), /https:\/\//);
  assert.doesNotThrow(() => loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", NODE_ENV: "production" }, "svc"));
  assert.throws(() => loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c:4318", OTEL_EXPORTER_OTLP_HEADERS: "no-equals" }, "svc"), /name=value/);
  assert.throws(() => loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, "svc"), /gRPC is not supported/);
  assert.equal(loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c:4318" }, "svc")!.protocol, "http/protobuf", "the specification default");
  assert.equal(loadOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c:4318", OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer abc" }, "svc")!.headers["authorization"], "Bearer abc");
});

interface Hit { path: string; traceparent: string | undefined }
async function plainUpstream(): Promise<{ port: number; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const s: Server = createServer((req, res) => { hits.push({ path: req.url ?? "", traceparent: req.headers["traceparent"] as string | undefined }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as { port: number }).port, hits, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

test("diagnostics endpoint: off by default, authenticated when on, and it reports only what was measured", { timeout: 300_000 }, async () => {
  const g = await buildGateway("pso-tel-"); gateways.push(g);
  // 1) default: the endpoint does not exist
  const off = await g.start({ RATE_LIMIT_PER_MINUTE: "0" });
  try { await expectProblem(await fetch(off.url("/_pso/telemetry"), { headers: { authorization: `Bearer ${TOKEN}` } }), 404, "PSO_HTTP_NOT_FOUND"); } finally { off.child.kill("SIGKILL"); }
  // 2) with a token
  const x = await g.start({ RATE_LIMIT_PER_MINUTE: "1000", PSO_DIAGNOSTICS_TOKEN: TOKEN });
  try {
    await expectProblem(await fetch(x.url("/_pso/telemetry")), 401, "PSO_AUTH_UNAUTHORIZED");
    await expectProblem(await fetch(x.url("/_pso/telemetry"), { headers: { authorization: `Bearer ${"x".repeat(40)}` } }), 401, "PSO_AUTH_UNAUTHORIZED");
    for (let i = 0; i < 3; i++) assert.equal((await fetch(x.url("/customers/ping"))).status, 503);   // upstream not running
    assert.equal((await fetch(x.url("/customers"))).status, 401);
    assert.equal((await fetch(x.url("/nope"))).status, 404);
    await new Promise((r) => setTimeout(r, 300)); // requests are recorded when their connection closes
    const r = await fetch(x.url("/_pso/telemetry"), { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    const s = (await r.json()) as { instrumented: boolean; state: string; http: { requests: number; byClass: Record<string, number>; unauthorized: number; inFlight: number; routes: Array<{ route: string; method: string; count: number }> }; upstream: Record<string, { outcomes: Record<string, number>; latency: { count: number } }>; rateLimit: { provider: string; allowed: number } | null; dispatch: unknown; readiness: { status: string }; tracing: { exporter: string } };
    assert.equal(s.instrumented, true); assert.equal(s.state, "ready"); assert.equal(s.readiness.status, "UP");
    assert.equal(s.http.requests, 5, "the diagnostics calls themselves are not counted");
    assert.deepEqual([s.http.byClass["5xx"], s.http.byClass["4xx"], s.http.unauthorized, s.http.inFlight], [3, 2, 1, 0]);
    assert.ok(s.http.routes.some((x) => x.route === "/customers/ping" && x.count === 3), "routes are the DECLARED templates");
    assert.ok(s.http.routes.some((x) => x.route === "unmatched"), "unknown paths are one bounded label, never raw URLs");
    assert.deepEqual(s.upstream["users"]?.outcomes, { unavailable: 3 });
    assert.equal(s.upstream["users"]?.latency.count, 3);
    assert.equal(s.rateLimit?.provider, "local"); assert.ok((s.rateLimit?.allowed ?? 0) >= 5);
    assert.equal(s.dispatch, null, "dispatch is not installed: null, not zero counters");
    assert.equal(s.tracing.exporter, "none", "no OpenTelemetry export is configured");
    const raw = JSON.stringify(s);
    assert.ok(!raw.includes(TOKEN) && !raw.includes("127.0.0.1"), "no credentials and no client addresses in the document");
  } finally { x.child.kill("SIGKILL"); }
});

test("trace propagation: the orchestrator continues the caller's trace and passes it on to the upstream", { timeout: 300_000 }, async () => {
  const g = await buildGateway("pso-trace-"); gateways.push(g);
  const up = await plainUpstream();
  const x = await g.start({ RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}` });
  try {
    const trace = "4bf92f3577b34da6a3ce929d0e0e4736", parent = "00f067aa0ba902b7";
    const r = await fetch(x.url("/customers/ping"), { headers: { traceparent: `00-${trace}-${parent}-01` } });
    assert.equal(r.status, 200);
    const back = r.headers.get("traceparent") ?? "";
    assert.match(back, new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`), "the response carries the same trace");
    const seen = up.hits[0]!.traceparent ?? "";
    assert.match(seen, new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`), "the upstream continues the same trace");
    assert.ok(!seen.includes(parent), "with a new parent span (the orchestrator's client span), not the caller's");
    const fresh = await fetch(x.url("/customers/ping"));
    assert.match(fresh.headers.get("traceparent") ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, "no incoming trace: one is started");
    const spoof = await fetch(x.url("/customers/ping"), { headers: { traceparent: `00-${"0".repeat(32)}-${parent}-01` } });
    assert.ok(!(spoof.headers.get("traceparent") ?? "").includes("0".repeat(32)), "an invalid trace id is never propagated");
    assert.match(x.logs(), new RegExp(`"traceId":"${trace}"`), "the trace id is in the structured request log");
  } finally { x.child.kill("SIGKILL"); await up.close(); }
});

interface Hit2 { path: string; contentType: string; raw: Buffer; headers: IncomingMessage["headers"] }
async function collector(): Promise<{ port: number; hits: Hit2[]; close(): Promise<void> }> {
  const hits: Hit2[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { hits.push({ path: req.url ?? "", contentType: String(req.headers["content-type"] ?? ""), raw: Buffer.concat(chunks), headers: req.headers }); res.writeHead(200, { "content-type": req.headers["content-type"] ?? "application/json" }); res.end(req.headers["content-type"]?.includes("json") ? "{}" : ""); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const waitFor = async (f: () => boolean, ms = 20_000): Promise<void> => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 200)); };

test("OpenTelemetry export uses the OFFICIAL SDK and OTLP exporters, is opt-in, and its spans match the headers that crossed the wire", { timeout: 300_000 }, async () => {
  const g = await buildGateway("pso-otlp-"); gateways.push(g);
  const col = await collector();
  const up = await plainUpstream();
  const env = { RATE_LIMIT_PER_MINUTE: "0", PSO_UPSTREAM_USERS: `127.0.0.1:${up.port}`, PSO_OTEL_EXPORT_INTERVAL_MS: "500" };
  try {
    // default: nothing is exported, whatever the traffic
    const quiet = await g.start(env);
    try { await fetch(quiet.url("/customers/ping")); await new Promise((r) => setTimeout(r, 1500)); assert.equal(col.hits.length, 0, "no OTEL_EXPORTER_OTLP_ENDPOINT: nothing leaves the process"); } finally { quiet.child.kill("SIGKILL"); }

    // OTLP/HTTP JSON (decodable here) through the official exporters
    const x = await g.start({ ...env, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${col.port}`, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_SERVICE_NAME: "gw-under-test", OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=collector-secret" });
    try {
      const trace = "0af7651916cd43dd8448eb211c80319c", callerSpan = "b7ad6b7169203331";
      assert.equal((await fetch(x.url("/customers/ping"), { headers: { traceparent: `00-${trace}-${callerSpan}-01` } })).status, 200);
      await fetch(x.url("/customers")); // a 401, for the auth counter
      await waitFor(() => col.hits.some((h) => h.path === "/v1/metrics") && col.hits.some((h) => h.path === "/v1/traces"));
      const m = col.hits.find((h) => h.path === "/v1/metrics")!, t = col.hits.find((h) => h.path === "/v1/traces")!;
      assert.ok(m && t, "both signals were exported by the SDK");
      assert.match(m.contentType, /json/); assert.equal(m.headers["x-api-key"], "collector-secret", "configured headers are sent (and never logged)");
      const metrics = JSON.parse(m.raw.toString("utf8")) as { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeMetrics: Array<{ metrics: Array<{ name: string; unit?: string }> }> }> };
      const resAttrs = metrics.resourceMetrics[0]!.resource.attributes;
      assert.equal(resAttrs.find((a) => a.key === "service.name")?.value.stringValue, "gw-under-test");
      const names = metrics.resourceMetrics[0]!.scopeMetrics.flatMap((s) => s.metrics.map((k) => k.name));
      for (const n of ["http.server.request.duration", "http.server.active_requests", "pso.upstream.request.duration", "pso.upstream.requests"]) assert.ok(names.includes(n), `${n} in ${names.join(",")}`);
      assert.ok(!names.includes("pso.ratelimit.decisions") && !names.some((n) => n.startsWith("pso.dispatch.")), "subsystems that are not configured export no data points (not zeros)");
      assert.equal(metrics.resourceMetrics[0]!.scopeMetrics.flatMap((s) => s.metrics).find((k) => k.name === "http.server.request.duration")!.unit, "s");

      type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string | number } }> };
      const spans = col.hits.filter((h) => h.path === "/v1/traces").flatMap((h) => (JSON.parse(h.raw.toString("utf8")) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> }).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
      const server = spans.find((sp) => sp.traceId === trace && sp.name === "GET /customers/ping")!;
      const client = spans.find((sp) => sp.traceId === trace && sp.name === "upstream users")!;
      assert.ok(server && client, "server and client spans are in the caller's trace");
      assert.equal(server.parentSpanId, callerSpan, "the server span continues the caller's span");
      assert.equal(client.parentSpanId, server.spanId, "the upstream call is a child of the server span");
      assert.equal(up.hits.find((h) => h.traceparent?.includes(trace))?.traceparent, `00-${trace}-${client.spanId}-01`, "the traceparent the upstream received names exactly the exported client span");
      assert.match(x.logs(), /"traceId":"0af7651916cd43dd8448eb211c80319c"/);
      assert.ok(!x.logs().includes("collector-secret"), "export credentials never reach the logs");
    } finally { x.child.kill("SIGKILL"); }

    // OTLP/HTTP protobuf is the specification default
    col.hits.length = 0;
    const p = await g.start({ ...env, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${col.port}`, OTEL_SERVICE_NAME: "gw-proto" });
    try {
      await fetch(p.url("/customers/ping"));
      await waitFor(() => col.hits.some((h) => h.path === "/v1/metrics"));
      const m = col.hits.find((h) => h.path === "/v1/metrics")!;
      assert.match(m.contentType, /x-protobuf/); assert.ok(m.raw.includes("gw-proto") && m.raw.includes("http.server.request.duration"), "protobuf payload carries the resource and the metric");
    } finally { p.child.kill("SIGKILL"); }
    await assert.rejects(g.start({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:pw@collector:4318" }), /must not contain credentials/);
    await assert.rejects(g.start({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }), /gRPC is not supported/);
  } finally { await col.close(); await up.close(); }
});

test("start-up refuses a weak diagnostics token and a token written in a file", { timeout: 200_000 }, async () => {
  const g = await buildGateway("pso-tel2-"); gateways.push(g);
  await assert.rejects(g.start({ PSO_DIAGNOSTICS_TOKEN: "too-short" }), /at least 32 characters/);
  g.config({ http: { diagnostics: { token: "a-token-that-is-long-enough-to-pass-the-length-check" } } });
  await assert.rejects(g.start({}), (e: Error) => /must not be written in a file/.test(e.message) && !e.message.includes("a-token-that-is-long"));
});
