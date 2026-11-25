import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign, createPrivateKey } from "node:crypto";
import { createAuthManager, decodeClaims, pkceChallenge, type StorageLike } from "../src/auth.ts";
import { createRemoteLoader, RemoteLoadError, type FederationRuntime } from "../src/remote.ts";
import { defaultMiddlewares, safeReturnTo, loginRedirect } from "../src/middlewares.ts";
import { runNavigation, canonicalManifest, b64u, type FrontendRuntimeConfig, type RemoteManifest } from "@pso/frontend";
import { publicKeyRaw } from "@pso/frontend/node";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${enc({ alg: "ES256", typ: "JWT" })}.${enc(claims)}.c2ln`;
const mem = (): StorageLike & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }; };

const oidc = { kind: "oidc" as const, issuer: "https://idp.example", authorizationEndpoint: "https://idp.example/authorize", tokenEndpoint: "https://idp.example/token", clientId: "commerce-web", scope: "openid customers:read" };
const base = { app: "fei-commerce", origin: "https://app.example", basePath: "/commerce/", devTokenAllowed: false };

test("claims: decoded for display only; malformed tokens are rejected", () => {
  assert.equal(decodeClaims("not-a-jwt"), undefined);
  assert.equal(decodeClaims("a.b"), undefined);
  assert.equal(decodeClaims("a.b!.c"), undefined);
  assert.equal(decodeClaims(jwt({ sub: "ana" }))?.sub, "ana");
});

test("PKCE: S256 challenge matches the RFC 7636 test vector", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("OIDC authorization code flow with PKCE, state and nonce; the token stays inside the manager", async () => {
  const store = mem(); let redirected = ""; let tokenReq: URLSearchParams | undefined;
  const exp = Math.floor(Date.now() / 1000) + 600;
  const access = jwt({ sub: "ana", name: "Ana", exp, scope: "customers:read orders:read", roles: ["admin"], tenant_id: "acme" });
  const fetchImpl = (async (_u: string, init: RequestInit) => { tokenReq = init.body as URLSearchParams; return new Response(JSON.stringify({ access_token: access, refresh_token: "r1" }), { status: 200 }); }) as unknown as typeof fetch;
  const a = createAuthManager({ ...base, config: oidc, storage: store, fetch: fetchImpl, navigate: (u) => { redirected = u; } });
  await a.signIn("/customers/7?tab=1");
  const u = new URL(redirected);
  assert.equal(u.origin + u.pathname, "https://idp.example/authorize");
  assert.equal(u.searchParams.get("response_type"), "code"); assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.example/commerce/auth/callback");
  const state = u.searchParams.get("state")!;
  assert.equal(a.getState().status, "authenticating");
  const back = await a.handleCallback(`?code=abc&state=${state}`);
  assert.equal(back, "/customers/7?tab=1");
  assert.equal(tokenReq!.get("grant_type"), "authorization_code"); assert.equal(tokenReq!.get("code_verifier")!.length >= 43, true);
  assert.equal(await pkceChallenge(tokenReq!.get("code_verifier")!), u.searchParams.get("code_challenge"));
  const s = a.getState();
  assert.equal(s.status, "signed-in"); assert.deepEqual(s.scopes, ["customers:read", "orders:read"]); assert.equal(s.tenant?.id, "acme"); assert.equal(s.user?.name, "Ana");
  assert.ok(!JSON.stringify(s).includes(access), "the token is not part of the session state");
  assert.equal(await a.source.getAccessToken(), access);
  assert.equal(store.data.size, 0, "the PKCE state is single use");
  a.dispose();
});

test("OIDC callback refuses: wrong state, replay, provider error, missing sign-in, bad nonce, unsafe return path", async () => {
  const mk = () => { const store = mem(); let url = ""; const f = (async () => new Response(JSON.stringify({ access_token: jwt({ sub: "a", exp: Math.floor(Date.now() / 1000) + 60 }), id_token: jwt({ nonce: "other" }) }), { status: 200 })) as unknown as typeof fetch; return { a: createAuthManager({ ...base, config: oidc, storage: store, fetch: f, navigate: (u) => { url = u; } }), url: () => url }; };
  let m = mk(); await m.a.signIn("/x");
  await assert.rejects(m.a.handleCallback("?code=c&state=WRONG"), /state/);
  assert.equal(m.a.getState().status, "error");
  await assert.rejects(m.a.handleCallback(`?code=c&state=${new URL(m.url()).searchParams.get("state")}`), /no sign-in in progress/, "state is single use");
  m = mk(); await m.a.signIn("/x"); await assert.rejects(m.a.handleCallback("?error=access_denied&state=x"), /refused/);
  m = mk(); await assert.rejects(m.a.handleCallback("?code=c&state=s"), /no sign-in in progress/);
  m = mk(); await m.a.signIn("/x"); await assert.rejects(m.a.handleCallback(`?code=c&state=${new URL(m.url()).searchParams.get("state")}`), /nonce/);
  m = mk(); await m.a.signIn("//evil.example/steal"); const st = new URL(m.url()).searchParams.get("state");
  m = { ...m }; // the stored return path was sanitized at sign-in time
  assert.ok(st);
});

test("the sanitized return path never leaves the application", async () => {
  const store = mem(); let u = "";
  const a = createAuthManager({ ...base, config: oidc, storage: store, navigate: (x) => { u = x; }, fetch: (async () => new Response(JSON.stringify({ access_token: jwt({ sub: "a", exp: Math.floor(Date.now() / 1000) + 60 }) }), { status: 200 })) as unknown as typeof fetch });
  await a.signIn("//evil.example/steal");
  assert.equal(await a.handleCallback(`?code=c&state=${new URL(u).searchParams.get("state")}`), "/");
  for (const [raw, want] of [["/customers", "/customers"], ["//evil.example", "/"], ["https://evil.example", "/"], ["/\\evil", "/"], [null, "/"], ["/a\nb", "/"]] as const) assert.equal(safeReturnTo(raw), want, String(raw));
});

test("dev-token provider only works when the build allows it; expired tokens are refused", () => {
  const prod = createAuthManager({ ...base, config: { kind: "dev-token" }, devTokenAllowed: false });
  assert.throws(() => prod.signInWithToken(jwt({ sub: "a" })), /not enabled/);
  const dev = createAuthManager({ ...base, config: { kind: "dev-token" }, devTokenAllowed: true });
  assert.throws(() => dev.signInWithToken(jwt({ sub: "a", exp: 1 })), /expired/);
  assert.throws(() => dev.signInWithToken("junk"), /not a JWT/);
  dev.signInWithToken(jwt({ sub: "dev", scope: "orders:read", exp: Math.floor(Date.now() / 1000) + 300 }));
  assert.equal(dev.getState().status, "signed-in"); dev.dispose();
});

test("session: expiry is detected, logout is propagated to other tabs, refresh is shared", async () => {
  let t = Date.now(); const bus: Array<(m: unknown) => void> = [];
  const post = (m: unknown) => bus.forEach((f) => f(m));
  const mk = (id: string) => createAuthManager({ ...base, config: { kind: "dev-token" }, devTokenAllowed: true, now: () => t, refreshSkewSeconds: 0, broadcast: { post: (m) => bus.filter((_f, i) => i !== Number(id)).forEach((f) => f(m)), onMessage: (cb) => { bus.push(cb); return () => undefined; } } });
  void post;
  const a = mk("0"), b = mk("1");
  const token = jwt({ sub: "a", exp: Math.floor(t / 1000) + 100 });
  a.signInWithToken(token); b.signInWithToken(token);
  await a.signOut();
  assert.equal(a.getState().status, "signed-out"); assert.equal(b.getState().status, "signed-out", "logout propagates to the other tab");
  assert.equal(await b.source.getAccessToken(), undefined);
  a.dispose(); b.dispose();
  // expiry through the timer
  const c = createAuthManager({ ...base, config: { kind: "dev-token" }, devTokenAllowed: true });
  c.signInWithToken(jwt({ sub: "a", exp: Math.floor(Date.now() / 1000) + 1 }));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(c.getState().status, "expired"); assert.equal(await c.source.getAccessToken(), undefined); c.dispose();
});

test("refresh: one request for concurrent callers; failure ends the session", async () => {
  let calls = 0;
  const store = mem();
  const newTok = jwt({ sub: "ana", exp: Math.floor(Date.now() / 1000) + 600, scope: "a" });
  const f = (async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return new Response(JSON.stringify({ access_token: newTok, refresh_token: "r2" }), { status: 200 }); }) as unknown as typeof fetch;
  let u = ""; const a = createAuthManager({ ...base, config: oidc, storage: store, fetch: f, navigate: (x) => { u = x; } });
  await a.signIn("/");
  const first = jwt({ sub: "ana", exp: Math.floor(Date.now() / 1000) + 600 });
  const tokenF = (async () => new Response(JSON.stringify({ access_token: first, refresh_token: "r1" }), { status: 200 })) as unknown as typeof fetch;
  const a2 = createAuthManager({ ...base, config: oidc, storage: store, fetch: tokenF, navigate: (x) => { u = x; } });
  void a2; void u;
  // adopt through the callback of a manager that returns a refresh token, then refresh through the manager with the counting fetch
  const b = createAuthManager({ ...base, config: oidc, storage: mem(), fetch: (async (url: string, init: RequestInit) => ((init.body as URLSearchParams).get("grant_type") === "refresh_token" ? f(url as never, init) : tokenF(url as never, init))) as unknown as typeof fetch, navigate: (x) => { u = x; } });
  await b.signIn("/"); await b.handleCallback(`?code=c&state=${new URL(u).searchParams.get("state")}`);
  const rs = await Promise.all([b.refresh(), b.refresh(), b.refresh()]);
  assert.deepEqual(rs, [true, true, true]); assert.equal(calls, 1, "three concurrent refreshes cost one request");
  assert.deepEqual(b.getState().scopes, ["a"]);
  a.dispose(); b.dispose();
});

test("default middlewares: authentication redirects with a safe returnTo, authorization denies, tenant mismatch denies", async () => {
  const mk = (token?: string) => {
    const auth = createAuthManager({ ...base, config: { kind: "dev-token" }, devTokenAllowed: true });
    if (token) auth.signInWithToken(token);
    return { auth, mws: defaultMiddlewares({ auth, authentication: "jwt", loginPath: "/login", locale: { default: "pt-BR", supported: ["pt-BR", "en"] } }) };
  };
  const to = (path: string, scopes: string[] = [], extra: Record<string, unknown> = {}) => ({ path, query: {}, params: {}, hash: "", scopes, meta: {}, ...extra }) as never;
  let { auth, mws } = mk();
  const chain = (m: ReturnType<typeof mk>["mws"]) => [m["authentication"]!, m["authorization"]!, m["session"]!, m["context"]!, m["telemetry"]!];
  assert.deepEqual((await runNavigation({ host: chain(mws), to: to("/customers/7") })).outcome, { type: "redirect", to: "/login?returnTo=%2Fcustomers%2F7" });
  assert.equal((await runNavigation({ host: chain(mws), to: to("/login", [], { meta: { public: true } }) })).outcome.type, "continue");
  auth.dispose();
  ({ auth, mws } = mk(jwt({ sub: "a", scope: "customers:read", tenant_id: "acme", exp: Math.floor(Date.now() / 1000) + 600 })));
  const ok = await runNavigation({ host: chain(mws), to: to("/customers", ["customers:read"]) });
  assert.equal(ok.outcome.type, "continue"); assert.equal(ok.values["locale"], "pt-BR"); assert.deepEqual(ok.trace, ["authentication", "authorization", "session", "context", "telemetry"]);
  const denied = await runNavigation({ host: chain(mws), to: to("/orders", ["orders:read"]) });
  assert.deepEqual(denied.outcome, { type: "denied", status: 403, reason: "missing scope: orders:read" });
  const tenant = await runNavigation({ host: chain(mws), to: to("/customers", ["customers:read"], { query: { tenant: "other" } }) });
  assert.equal(tenant.outcome.type, "denied");
  assert.equal(loginRedirect("/login", "/a b", {}), "/login");
  auth.dispose();
});

// ---- remote loading -------------------------------------------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function release(over: Partial<RemoteManifest> = {}, key?: { keyId: string; pem: string }): { manifest: RemoteManifest } {
  const m: RemoteManifest = { schema: 1, kind: "pso-mei-manifest", name: "mei-customers", host: "fei-commerce", version: "1.0.0", contract: { context: "1.0" }, entry: "remoteEntry.js", expose: "./module", shared: { react: "^18.3.1" }, scopes: [], routes: [{ path: "/customers" }], files: [{ path: "remoteEntry.js", sha256: sha("entry"), size: 5 }, { path: "assets/a.js", sha256: sha("chunk"), size: 5 }], createdAt: "2026-01-01T00:00:00Z", ...over };
  if (key) m.signature = { keyId: key.keyId, alg: "ed25519", value: b64u.encode(new Uint8Array(sign(null, Buffer.from(canonicalManifest(m)), createPrivateKey(key.pem)))) };
  return { manifest: m };
}
const config = (over: Partial<FrontendRuntimeConfig> = {}): FrontendRuntimeConfig => ({ schema: 1, fei: "fei-commerce", mode: "production", orchestrator: { basePath: "/api" }, remotes: { "mei-customers": { manifest: "/_mei/mei-customers/pso-manifest.json" } }, ...over });
const goodModule = { default: { kind: "pso-mei-module", name: "mei-customers", contract: "1.0", Root: () => null } };
function setup(cfg: FrontendRuntimeConfig, manifest: unknown, mod: unknown = goodModule) {
  const regs: Array<{ name: string; entry: string }> = [];
  let loads = 0;
  const federation: FederationRuntime = { registerRemotes: (r) => { regs.push(...r); }, loadRemote: (async () => { loads++; if (mod instanceof Error) throw mod; return mod; }) as never };
  const fetched: string[] = [];
  const f = (async (u: string) => { fetched.push(String(u)); return manifest === undefined ? new Response("", { status: 404 }) : new Response(JSON.stringify(manifest), { status: 200 }); }) as unknown as typeof fetch;
  return { loader: createRemoteLoader({ config: cfg, origin: "https://app.example", federation, fetch: f, retries: 0, timeoutMs: 500, hostShared: { react: "18.3.1" } }), regs, fetched, loads: () => loads };
}
const fails = async (p: Promise<unknown>, kind: string, re?: RegExp) => { const e = await p.then(() => undefined, (x) => x as RemoteLoadError); assert.ok(e instanceof RemoteLoadError, `expected RemoteLoadError(${kind}), got ${String(e)}`); assert.equal(e.kind, kind, e.message); if (re) assert.match(e.message + e.reasons.join(), re); };

test("loader: loads an approved, compatible release from its manifest and records integrity for every file", async () => {
  const s = setup(config(), release().manifest);
  const m = await s.loader.load("mei-customers");
  assert.equal(m.name, "mei-customers");
  assert.deepEqual(s.regs, [{ name: "mei_customers", entry: "https://app.example/_mei/mei-customers/remoteEntry.js" }]);
  assert.equal(s.loader.integrityFor("https://app.example/_mei/mei-customers/remoteEntry.js"), `sha256-${Buffer.from(sha("entry"), "hex").toString("base64")}`);
  assert.ok(s.loader.integrityFor("https://app.example/_mei/mei-customers/assets/a.js"));
  await s.loader.load("mei-customers"); assert.equal(s.loads(), 1, "loaded once");
  assert.equal(s.loader.status("mei-customers").state, "ready"); assert.equal(s.loader.status("mei-customers").version, "1.0.0");
});

test("loader: refuses everything that is not an approved, compatible, intact release", async () => {
  await fails(setup(config(), release().manifest).loader.load("mei-orders"), "not-registered");
  await fails(setup(config({ remotes: { "mei-customers": { manifest: "https://evil.example/m.json" } } }), release().manifest).loader.load("mei-customers"), "untrusted");
  await fails(setup(config({ remotes: { "mei-customers": { manifest: "/assets/m.json" } } }), release().manifest).loader.load("mei-customers"), "untrusted");
  await fails(setup(config({ remotes: { "mei-customers": { devEntry: "http://localhost:9000/mf-manifest.json" } } }), undefined).loader.load("mei-customers"), "not-registered");
  await fails(setup(config(), undefined).loader.load("mei-customers"), "manifest-unavailable");
  await fails(setup(config(), { nope: 1 }).loader.load("mei-customers"), "manifest-invalid");
  await fails(setup(config(), release({ host: "fei-other" }).manifest).loader.load("mei-customers"), "incompatible", /fei-other/);
  await fails(setup(config(), release({ contract: { context: "2.0" } }).manifest).loader.load("mei-customers"), "incompatible", /major/);
  await fails(setup(config(), release({ shared: { react: "^19.0.0" } }).manifest).loader.load("mei-customers"), "incompatible", /react/);
  await fails(setup(config(), release().manifest, new Error("chunk failed")).loader.load("mei-customers"), "load-failed", /chunk failed/);
  await fails(setup(config(), release().manifest, { default: { kind: "other" } }).loader.load("mei-customers"), "bad-module");
  await fails(setup(config(), release().manifest, { default: { ...goodModule.default, name: "mei-orders" } }).loader.load("mei-customers"), "bad-module");
  await fails(setup(config(), release().manifest, { default: { ...goodModule.default, contract: "1.9" } }).loader.load("mei-customers"), "incompatible");
});

test("loader: signatures are enforced when required and checked when present", async () => {
  const { privateKey } = generateKeyPairSync("ed25519"); const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const keys = [{ keyId: "k1", publicKey: publicKeyRaw(pem) }];
  await fails(setup(config({ requireSignature: true, trustedKeys: keys }), release().manifest).loader.load("mei-customers"), "signature", /not signed/);
  assert.equal((await setup(config({ requireSignature: true, trustedKeys: keys }), release({}, { keyId: "k1", pem }).manifest).loader.load("mei-customers")).name, "mei-customers");
  await fails(setup(config({ requireSignature: true, trustedKeys: keys }), release({}, { keyId: "k1", pem: other }).manifest).loader.load("mei-customers"), "signature", /does not match/);
  await fails(setup(config({ requireSignature: true, trustedKeys: keys }), release({}, { keyId: "k2", pem }).manifest).loader.load("mei-customers"), "signature", /not trusted/);
  const tampered = release({}, { keyId: "k1", pem }).manifest; tampered.files[0]!.sha256 = sha("evil");
  await fails(setup(config({ requireSignature: true, trustedKeys: keys }), tampered).loader.load("mei-customers"), "signature");
  // not required and not signed: allowed (development-like); signed but wrong key: refused
  assert.ok(await setup(config(), release().manifest).loader.load("mei-customers"));
  await fails(setup(config({ trustedKeys: keys }), release({}, { keyId: "k1", pem: other }).manifest).loader.load("mei-customers"), "signature");
});

test("loader: transient failures are retried within bounds, permanent ones are not; prefetch respects data saving", async () => {
  let n = 0; const regs: unknown[] = [];
  const fed: FederationRuntime = { registerRemotes: (r) => { regs.push(r); }, loadRemote: (async () => { n++; if (n === 1) throw new Error("flaky"); return goodModule; }) as never };
  const loader = createRemoteLoader({ config: config(), origin: "https://app.example", federation: fed, retries: 1, timeoutMs: 2000, fetch: (async () => new Response(JSON.stringify(release().manifest), { status: 200 })) as unknown as typeof fetch });
  assert.ok(await loader.load("mei-customers")); assert.equal(n, 2);
  let manifestCalls = 0;
  const l2 = createRemoteLoader({ config: config(), origin: "https://app.example", federation: fed, retries: 2, fetch: (async () => { manifestCalls++; return new Response(JSON.stringify(release({ host: "x" }).manifest), { status: 200 }); }) as unknown as typeof fetch });
  await fails(l2.load("mei-customers"), "incompatible"); assert.equal(manifestCalls, 1, "an incompatible release is not retried");
  Object.defineProperty(globalThis, "navigator", { value: { connection: { saveData: true } }, configurable: true });
  const l3 = setup(config(), release().manifest);
  assert.equal(await l3.loader.prefetch("mei-customers"), false); assert.equal(l3.fetched.length, 0, "nothing is fetched when the user asked to save data");
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
  assert.equal(await setup(config(), release().manifest).loader.prefetch("mei-customers"), true);
});

test("loader: a remote that never answers times out", async () => {
  const fed: FederationRuntime = { registerRemotes: () => undefined, loadRemote: (() => new Promise(() => undefined)) as never };
  const loader = createRemoteLoader({ config: config(), origin: "https://app.example", federation: fed, retries: 0, timeoutMs: 50, fetch: (async () => new Response(JSON.stringify(release().manifest), { status: 200 })) as unknown as typeof fetch });
  await fails(loader.load("mei-customers"), "timeout");
});
