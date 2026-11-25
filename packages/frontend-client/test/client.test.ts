import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiClient, assertApiPath, PsoApiError, redact, createChannelsManager, type AuthSource } from "../src/index.ts";

const origin = "https://app.example";
type Call = { url: string; init: RequestInit };
function fake(responses: Array<Response | Error | ((c: Call) => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const f = (async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r({ url: String(url), init }) : r;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const problem = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify({ status, ...body }), { status, headers: { "content-type": "application/problem+json" } });
const hdr = (c: Call, k: string) => new Headers(c.init.headers).get(k);

test("paths: only orchestrator-relative paths are accepted", () => {
  for (const ok of ["/customers", "/customers/42?x=1", "/a%20b"]) assert.doesNotThrow(() => assertApiPath(ok), ok);
  for (const bad of ["customers", "//evil.example/x", "https://evil.example/x", "/\\evil", "/a/../b", "/a/%2e%2e/b", "/a\nb", "/x://y", "/%zz"]) assert.throws(() => assertApiPath(bad), PsoApiError, bad);
});

test("requests: base path, query, JSON, correlation id, bearer token; the token is never exposed", async () => {
  const { f, calls } = fake([json({ id: 1 })]);
  const auth: AuthSource = { getAccessToken: () => "tok-123" };
  const api = createApiClient({ basePath: "/api", origin, fetch: f, auth });
  const r = await api.post<{ id: number }>("/customers", { name: "Ana" }, { query: { dry: true, skip: undefined, n: 2 } });
  assert.deepEqual(r, { id: 1 });
  const c = calls[0]!;
  assert.equal(c.url, "https://app.example/api/customers?dry=true&n=2");
  assert.equal(hdr(c, "authorization"), "Bearer tok-123");
  assert.equal(hdr(c, "content-type"), "application/json");
  assert.match(hdr(c, "x-correlation-id")!, /.{8,}/);
  assert.equal(c.init.body, JSON.stringify({ name: "Ana" }));
  assert.equal(c.init.credentials, "omit"); assert.equal(c.init.redirect, "error");
  assert.deepEqual(Object.keys(api).filter((k) => /token|auth|refresh/i.test(k)), []);
  await assert.rejects(api.get("/x", { headers: { Authorization: "Bearer other" } }), /managed by the client/);
  await assert.rejects(api.get("https://evil.example/x"), /must start with/);
  assert.equal(calls.length, 1, "refused requests are never sent");
});

test("Problem Details (RFC 9457) become typed errors with field errors and correlation", async () => {
  const { f } = fake([problem(400, { type: "urn:pso:problem:validation-failed", title: "Validation failed", code: "PSO_VALIDATION_FAILED", correlationId: "c-9", errors: [{ field: "email", message: "invalid" }, { field: "email", message: "required" }] })]);
  const api = createApiClient({ basePath: "/api", origin, fetch: f });
  const e = await api.post("/customers", {}).then(() => undefined, (x: PsoApiError) => x);
  assert.ok(e instanceof PsoApiError); assert.equal(e.kind, "problem"); assert.equal(e.status, 400); assert.equal(e.correlationId, "c-9"); assert.deepEqual(e.fieldErrors, { email: ["invalid", "required"] });
  const h = createApiClient({ basePath: "/api", origin, fetch: fake([new Response("<html>nginx</html>", { status: 502, headers: { "content-type": "text/html" } }), new Response("<html/>", { status: 502 })]).f, retries: 1, retryDelayMs: 1 });
  const e2 = await h.get("/x").then(() => undefined, (x: PsoApiError) => x);
  assert.equal(e2?.kind, "http"); assert.equal(e2?.status, 502);
});

test("network classification: timeout, cancellation, unreachable, invalid JSON", async () => {
  const never = (c: Call) => new Promise<Response>((_res, rej) => (c.init.signal as AbortSignal).addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const t = await createApiClient({ basePath: "/api", origin, fetch: fake([never]).f, timeoutMs: 20, retries: 0 }).get("/slow").then(() => undefined, (x: PsoApiError) => x);
  assert.equal(t?.kind, "timeout");
  const ctl = new AbortController();
  const p = createApiClient({ basePath: "/api", origin, fetch: fake([never]).f, retries: 0 }).get("/slow", { signal: ctl.signal }).then(() => undefined, (x: PsoApiError) => x);
  ctl.abort();
  assert.equal((await p)?.kind, "cancelled");
  assert.equal((await createApiClient({ basePath: "/api", origin, fetch: fake([new TypeError("fetch failed")]).f, retries: 0 }).get("/x").then(() => undefined, (x: PsoApiError) => x))?.kind, "network");
  assert.equal((await createApiClient({ basePath: "/api", origin, fetch: fake([new Response("not json", { status: 200 })]).f }).get("/x").then(() => undefined, (x: PsoApiError) => x))?.kind, "invalid-response");
  assert.equal(await createApiClient({ basePath: "/api", origin, fetch: fake([new Response(null, { status: 204 })]).f }).delete("/x"), undefined);
});

test("retries: GET is retried, POST is not (unless it carries an idempotency key)", async () => {
  const a = fake([new TypeError("down"), json({ ok: 1 })]);
  assert.deepEqual(await createApiClient({ basePath: "/api", origin, fetch: a.f, retryDelayMs: 1 }).get("/x"), { ok: 1 }); assert.equal(a.calls.length, 2);
  const b = fake([new TypeError("down"), json({ ok: 1 })]);
  await assert.rejects(createApiClient({ basePath: "/api", origin, fetch: b.f, retryDelayMs: 1 }).post("/orders", { x: 1 })); assert.equal(b.calls.length, 1, "a POST without a key is sent once");
  const c = fake([problem(503, { title: "x" }), json({ id: 7 })]);
  assert.deepEqual(await createApiClient({ basePath: "/api", origin, fetch: c.f, retryDelayMs: 1 }).post("/orders", { x: 1 }, { idempotencyKey: "k-1" }), { id: 7 });
  assert.equal(c.calls.length, 2); assert.equal(hdr(c.calls[1]!, "idempotency-key"), "k-1");
  const d = fake([problem(500, { title: "boom" })]);
  await assert.rejects(createApiClient({ basePath: "/api", origin, fetch: d.f, retryDelayMs: 1 }).get("/x")); assert.equal(d.calls.length, 1, "500 is not retried");
});

test("401 triggers ONE shared refresh, then the request is repeated; a failed refresh reports the session as gone", async () => {
  let token = "old", refreshes = 0, gone = 0;
  const auth: AuthSource = { getAccessToken: () => token, refresh: async () => { refreshes++; await new Promise((r) => setTimeout(r, 10)); token = "new"; return true; }, onUnauthorized: () => { gone++; } };
  const f = (async (_u: unknown, init: RequestInit) => new Headers(init.headers).get("authorization") === "Bearer new" ? json({ ok: true }) : problem(401, { title: "Authentication required" })) as unknown as typeof fetch;
  const api = createApiClient({ basePath: "/api", origin, fetch: f, auth });
  const rs = await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
  assert.equal(rs.length, 3); assert.equal(refreshes, 1, "three MEIs failing at once cause one refresh"); assert.equal(gone, 0);
  const auth2: AuthSource = { getAccessToken: () => "x", refresh: async () => false, onUnauthorized: () => { gone++; } };
  await assert.rejects(createApiClient({ basePath: "/api", origin, fetch: (async () => problem(401, { title: "no" })) as unknown as typeof fetch, auth: auth2 }).get("/a"), /no/);
  assert.equal(gone, 1);
});

test("a POST is never repeated after a 401 refresh (it may have been applied)", async () => {
  const g = fake([problem(401, { title: "no" })]);
  await assert.rejects(createApiClient({ basePath: "/api", origin, fetch: g.f, auth: { getAccessToken: () => "t", refresh: async () => true } }).post("/orders", {}));
  assert.equal(g.calls.length, 1);
});

test("dedupe shares one network call for concurrent identical GETs; cookie sessions send the CSRF token on unsafe methods", async () => {
  const a = fake([async () => { await new Promise((r) => setTimeout(r, 15)); return json({ n: 1 }); }]);
  const api = createApiClient({ basePath: "/api", origin, fetch: a.f });
  const [x, y] = await Promise.all([api.get("/p", { dedupe: true }), api.get("/p", { dedupe: true })]);
  assert.deepEqual(x, y); assert.equal(a.calls.length, 1);
  await api.get("/p"); await api.get("/p"); assert.equal(a.calls.length, 3, "without dedupe every call goes out");
  const b = fake([json({}), json({})]);
  const c = createApiClient({ basePath: "/api", origin, fetch: b.f, credentials: "same-origin", auth: { getAccessToken: () => undefined, getCsrfToken: () => "csrf-1" } });
  await c.get("/s"); await c.post("/s", {});
  assert.equal(hdr(b.calls[0]!, "x-csrf-token"), null); assert.equal(hdr(b.calls[1]!, "x-csrf-token"), "csrf-1"); assert.equal(b.calls[1]!.init.credentials, "same-origin");
});

test("middleware can add headers and observe responses; upload and download work", async () => {
  const seen: number[] = [];
  const { f, calls } = fake([json({}), new Response(new Blob(["pdf"]), { status: 200 }), json({})]);
  const api = createApiClient({ basePath: "/api", origin, fetch: f, middlewares: [{ request: (r) => { r.headers.set("x-tenant", "t1"); }, response: (res) => { seen.push(res.status); } }] });
  await api.get("/m"); assert.equal(hdr(calls[0]!, "x-tenant"), "t1");
  assert.equal((await api.download("/file")).size, 3);
  const fd = new FormData(); fd.append("file", new Blob(["a"]), "a.txt"); await api.upload("/up", fd);
  assert.equal(calls[2]!.init.body, fd); assert.equal(hdr(calls[2]!, "content-type"), null, "the browser sets the multipart boundary");
  assert.deepEqual(seen, [200, 200, 200]);
});

test("redact removes credentials from anything that is logged", () => {
  const out = String(redact(`Authorization: Bearer abcdefghijklmnop.qrstuvwxyz; token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl and {"access_token":"secret123","name":"Ana"} password=hunter2`));
  for (const s of ["abcdefghijklmnop", "eyJhbGci", "secret123", "hunter2"]) assert.ok(!out.includes(s), s);
  assert.ok(out.includes("Ana"));
});

test("channels manager: one connection, shared subscriptions, cleanup when the last listener leaves", () => {
  const log: string[] = [];
  const handlers = new Map<string, (e: unknown) => void>();
  let state = "idle";
  const stateCbs = new Set<(s: string) => void>();
  const fakeConn = {
    get state() { return state; }, onStateChange: (cb: (s: string) => void) => { stateCbs.add(cb); return () => stateCbs.delete(cb); }, onError: () => () => undefined, reauthenticate: async () => { log.push("reauth"); },
    subscribe: (channel: string, h: { onEvent(e: unknown): void }) => { log.push(`sub:${channel}`); handlers.set(channel, h.onEvent); return { channel, unsubscribe: () => { log.push(`unsub:${channel}`); handlers.delete(channel); } }; },
    send: async () => undefined, connect: () => { log.push("connect"); state = "connected"; for (const c of stateCbs) c(state); }, close: () => { log.push("close"); state = "closed"; },
  };
  const m = createChannelsManager({ url: "/channels", channels: fakeConn as never });
  const got: string[] = [];
  const u1 = m.subscribe("order.1", (e) => got.push(`a:${(e as { type: string }).type}`));
  const u2 = m.subscribe("order.1", (e) => got.push(`b:${(e as { type: string }).type}`));
  assert.deepEqual(log, ["sub:order.1", "connect"], "one server subscription and one connection for two listeners");
  handlers.get("order.1")!({ type: "order.updated" });
  assert.deepEqual(got, ["a:order.updated", "b:order.updated"]);
  u1(); u1(); assert.equal(m.activeChannels, 1);
  u2(); assert.equal(m.activeChannels, 0); assert.ok(log.includes("unsub:order.1"));
  const seen: string[] = []; m.onStateChange((s) => seen.push(s));
  m.close(); assert.equal(m.listenerCount, 0);
});
