import { test, after } from "node:test";
import assert from "node:assert/strict";
import { assertSecureEndpoint, createAuthManager, validateIdToken, type AuthDeps, type AuthManager, type StorageLike } from "../src/auth.ts";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.c2ln`;
const mem = (): StorageLike & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }; };
const oidc = { kind: "oidc" as const, issuer: "https://idp.example/realms/pso", authorizationEndpoint: "https://idp.example/auth", tokenEndpoint: "https://idp.example/token", logoutEndpoint: "https://idp.example/logout", clientId: "commerce-web", scope: "openid" };
const base = { app: "fei-commerce", origin: "https://app.example", basePath: "/commerce/", devTokenAllowed: false };
const made: AuthManager[] = [];
const create = (d: AuthDeps): AuthManager => { const m = createAuthManager(d); made.push(m); return m; };
after(() => { for (const m of made) m.dispose(); });
const exp = () => Math.floor(Date.now() / 1000) + 600;

test("ID token validation: issuer, audience, authorized party, expiry, issue time and a REQUIRED nonce", () => {
  const ok = { iss: oidc.issuer, aud: "commerce-web", exp: exp(), iat: Math.floor(Date.now() / 1000), nonce: "n1" };
  const o = { issuer: oidc.issuer, clientId: "commerce-web", nonce: "n1", now: Date.now() };
  assert.equal(validateIdToken(ok, o), undefined);
  assert.match(validateIdToken({ ...ok, nonce: undefined }, o)!, /nonce/, "a missing nonce is a mismatch, not a pass");
  assert.match(validateIdToken({ ...ok, nonce: "other" }, o)!, /nonce/);
  assert.match(validateIdToken({ ...ok, iss: "https://evil.example" }, o)!, /issued by/);
  assert.match(validateIdToken({ ...ok, aud: "another-app" }, o)!, /audience/);
  assert.match(validateIdToken({ ...ok, aud: ["commerce-web", "x"], azp: "x" }, o)!, /authorized party/);
  assert.equal(validateIdToken({ ...ok, aud: ["commerce-web", "x"], azp: "commerce-web" }, o), undefined);
  assert.match(validateIdToken({ ...ok, exp: Math.floor(Date.now() / 1000) - 600 }, o)!, /expired/);
  assert.match(validateIdToken({ ...ok, exp: undefined }, o)!, /expired/);
  assert.match(validateIdToken({ ...ok, iat: Math.floor(Date.now() / 1000) + 3600 }, o)!, /future/);
  assert.match(validateIdToken(undefined, o)!, /not a JWT/);
});

test("provider endpoints: https only, plain http only for loopback, no credentials or fragments", () => {
  for (const u of ["https://idp.example/auth", "http://localhost:8180/auth", "http://127.0.0.1/auth"]) assertSecureEndpoint(u, "x");
  for (const u of ["http://idp.example/auth", "ftp://idp.example", "javascript:alert(1)", "not a url", "https://u:p@idp.example/auth", "https://idp.example/auth#frag"]) assert.throws(() => assertSecureEndpoint(u, "x"), undefined, u);
  assert.throws(() => create({ ...base, config: { ...oidc, tokenEndpoint: "http://idp.example/token" }, storage: mem() }), /tokenEndpoint must use https/);
});

test("callback: an ID token from another issuer or audience is refused, as is an access token from another issuer", async () => {
  const run = async (idClaims: Record<string, unknown> | null, access: Record<string, unknown> = {}) => {
    const store = mem(); let url = "";
    const f = (async (_u: string, init: RequestInit) => { void init; const p = { nonce: new URL(url).searchParams.get("nonce")! }; return new Response(JSON.stringify({ access_token: jwt({ sub: "a", exp: exp(), iss: oidc.issuer, ...access }), ...(idClaims ? { id_token: jwt({ nonce: p.nonce, exp: exp(), iss: oidc.issuer, aud: "commerce-web", ...idClaims }) } : {}) }), { status: 200 }); }) as unknown as typeof fetch;
    const a = create({ ...base, config: oidc, storage: store, sessionMarker: store, fetch: f, navigate: (u) => { url = u; } });
    await a.signIn("/x"); return a.handleCallback(`?code=c&state=${new URL(url).searchParams.get("state")}`);
  };
  assert.equal(await run({}), "/x");
  await assert.rejects(run({ iss: "https://evil.example" }), /issued by/);
  await assert.rejects(run({ aud: "other" }), /audience/);
  await assert.rejects(run(null, { iss: "https://evil.example" }), /different issuer/);
});

test("silent session restoration: prompt=none after a reload; no provider session is not an error and never loops", async () => {
  const store = mem(); let url = "";
  const f = (async () => { const p = { nonce: new URL(url).searchParams.get("nonce") ?? "" }; return new Response(JSON.stringify({ access_token: jwt({ sub: "a", exp: exp(), iss: oidc.issuer }), id_token: jwt({ nonce: p.nonce, exp: exp(), iss: oidc.issuer, aud: "commerce-web" }), refresh_token: "r1" }), { status: 200 }); }) as unknown as typeof fetch;
  const first = create({ ...base, config: oidc, storage: store, sessionMarker: store, fetch: f, navigate: (u) => { url = u; } });
  assert.equal(await first.restore("/customers"), false, "a browser that never signed in is not redirected");
  await first.signIn("/customers"); await first.handleCallback(`?code=c&state=${new URL(url).searchParams.get("state")}`);
  assert.equal(first.getState().status, "signed-in"); assert.equal(store.getItem("pso:fei-commerce:session"), "1");
  assert.equal(await first.restore("/x"), false, "already signed in: nothing to restore");

  // a reload: the token (memory only) is gone, the marker remains
  url = ""; const second = create({ ...base, config: oidc, storage: store, sessionMarker: store, fetch: f, navigate: (u) => { url = u; } });
  assert.equal(second.getState().status, "signed-out");
  assert.equal(await second.restore("/customers/7?tab=1"), true);
  const u = new URL(url); assert.equal(u.searchParams.get("prompt"), "none"); assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  // the provider has no session any more: login_required is not an error and the marker is dropped (no loop)
  const to = await second.handleCallback(`?error=login_required&state=${u.searchParams.get("state")}`);
  assert.equal(to, "/customers/7?tab=1"); assert.equal(second.getState().status, "signed-out"); assert.equal(second.getState().error, undefined);
  assert.equal(store.getItem("pso:fei-commerce:session"), null);
  assert.equal(await second.restore("/"), false, "no marker, no second attempt");

  // the same error WITHOUT a silent request stays an error
  const third = create({ ...base, config: oidc, storage: store, sessionMarker: store, fetch: f, navigate: (x) => { url = x; } });
  await third.signIn("/"); await assert.rejects(third.handleCallback(`?error=login_required&state=${new URL(url).searchParams.get("state")}`), /refused the sign-in/);
});

test("restoration can be switched off; logout hints the provider and returns to the application", async () => {
  const store = mem(); let url = "";
  const f = (async () => { const p = { nonce: new URL(url).searchParams.get("nonce") ?? "" }; return new Response(JSON.stringify({ access_token: jwt({ sub: "a", exp: exp(), iss: oidc.issuer }), id_token: jwt({ nonce: p.nonce, exp: exp(), iss: oidc.issuer, aud: "commerce-web" }) }), { status: 200 }); }) as unknown as typeof fetch;
  const a = create({ ...base, config: oidc, storage: store, sessionMarker: store, fetch: f, navigate: (u) => { url = u; } });
  await a.signIn("/"); await a.handleCallback(`?code=c&state=${new URL(url).searchParams.get("state")}`);
  url = ""; await a.signOut();
  const lo = new URL(url); assert.equal(lo.origin + lo.pathname, "https://idp.example/logout");
  assert.equal(lo.searchParams.get("client_id"), "commerce-web"); assert.match(lo.searchParams.get("id_token_hint")!, /^ey/);
  assert.equal(lo.searchParams.get("post_logout_redirect_uri"), "https://app.example/commerce/");
  assert.equal(store.getItem("pso:fei-commerce:session"), null, "an explicit logout forgets the session marker");
  assert.equal(a.getState().status, "signed-out");

  store.setItem("pso:fei-commerce:session", "1");
  const off = create({ ...base, config: { ...oidc, restoreSession: false }, storage: store, sessionMarker: store, navigate: () => { throw new Error("must not redirect"); } });
  assert.equal(await off.restore("/"), false);
});

test("a callback page that mounts twice redeems the code once and does not undo the session it just created", async () => {
  const store = mem(); let url = ""; let tokenCalls = 0;
  const f = (async () => { tokenCalls++; await new Promise((r) => setTimeout(r, 20)); return new Response(JSON.stringify({ access_token: jwt({ sub: "a", exp: exp(), iss: oidc.issuer }) }), { status: 200 }); }) as unknown as typeof fetch;
  const a = create({ ...base, config: oidc, storage: store, fetch: f, navigate: (u) => { url = u; } });
  await a.signIn("/x"); const search = `?code=c&state=${new URL(url).searchParams.get("state")}`;
  const [one, two] = await Promise.all([a.handleCallback(search), a.handleCallback(search)]);
  assert.equal(one, "/x"); assert.equal(two, "/x"); assert.equal(tokenCalls, 1, "the single-use code is redeemed once");
  assert.equal(await a.handleCallback(search), "/x"); assert.equal(a.getState().status, "signed-in", "a late repeat does not turn the session into an error");
});

test("scopes: the configured claim and `scp` are combined (a provider may keep OIDC scopes in `scope` and permissions in `scp`)", async () => {
  const { scopesOf } = await import("../src/auth.ts");
  assert.deepEqual(scopesOf({ scope: "openid profile", scp: ["customers:read", "orders:read"] }), ["customers:read", "openid", "orders:read", "profile"]);
  assert.deepEqual(scopesOf({ scope: "a b" }), ["a", "b"]);
  assert.deepEqual(scopesOf({ scp: "x y" }), ["x", "y"]);
  assert.deepEqual(scopesOf({ permissions: ["p:1"], scp: ["p:2"] }, "permissions"), ["p:1", "p:2"]);
  assert.deepEqual(scopesOf({}), []);
});
