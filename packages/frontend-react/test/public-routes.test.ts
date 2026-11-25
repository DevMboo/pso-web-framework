import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenRoutes, isPublicRoute, runNavigation, type NavigationTarget } from "@pso/frontend";
import { defaultMiddlewares } from "../src/middlewares.ts";
import type { AuthManager, SessionState } from "../src/auth.ts";

/** The navigation pipeline with public routes: the same middlewares, fed by the same rule the shell uses. */

const fei = { loginPath: "/login", microfrontends: [{ name: "mei-welcome", path: "/welcome", public: ["/", "/guide/*"] as string[] }, { name: "mei-members", path: "/members" }] };
const own = flattenRoutes({ routes: [{ path: "/", page: "./src/pages/Home.tsx" }, { path: "/about", page: "./src/pages/About.tsx", public: true }] }, "fei-app", "/", "ROUTES.pso.ts");

const SIGNED_OUT: SessionState = { status: "signed-out", user: null, scopes: [], tenant: null, expiresAt: null };
const EXPIRED: SessionState = { status: "expired", user: null, scopes: [], tenant: null, expiresAt: null };
const SIGNED_IN: SessionState = { status: "signed-in", user: { id: "u1", roles: [] } as never, scopes: ["read"], tenant: null, expiresAt: Date.now() + 600_000 };

function chain(state: SessionState) {
  const calls = { refresh: 0, signOut: 0 };
  const auth = { getState: () => state, refresh: async () => { calls.refresh++; return false; }, signOut: async () => { calls.signOut++; } } as unknown as AuthManager;
  const m = defaultMiddlewares({ auth, authentication: "jwt", loginPath: fei.loginPath, locale: { default: "en" } });
  return { host: [m["authentication"]!, m["authorization"]!, m["session"]!, m["context"]!], calls };
}
const target = (path: string, query: Record<string, string> = {}, scopes: string[] = []): NavigationTarget => ({ path, query, params: {}, hash: "", scopes, meta: isPublicRoute(fei, own, path) ? { public: true } : {} });

test("a visitor with no session opens a public route and is not sent to sign in", async () => {
  for (const state of [SIGNED_OUT, EXPIRED]) {
    for (const path of ["/about", "/welcome", "/welcome/guide/start", "/login", "/auth/callback"]) {
      const { host, calls } = chain(state);
      const r = await runNavigation({ host, to: target(path) });
      assert.deepEqual(r.outcome, { type: "continue" }, `${state.status} ${path}`);
      assert.deepEqual(calls, { refresh: 0, signOut: 0 }, "a public route never tries to refresh or end a session that does not exist");
    }
  }
});

test("everything not declared public is still protected: the visitor is redirected to sign in with a safe return address", async () => {
  for (const path of ["/", "/members", "/members/42", "/welcome/private", "/welcome/guide2", "/unknown"]) {
    const { host } = chain(SIGNED_OUT);
    const r = await runNavigation({ host, to: target(path, { tab: "a" }) });
    assert.equal(r.outcome.type, "redirect", path);
    const to = (r.outcome as { to: string }).to;
    assert.match(to, /^\/login\?returnTo=/);
    assert.equal(new URLSearchParams(to.split("?")[1]).get("returnTo"), `${path}?tab=a`);
  }
});

test("no redirect loop: the page a visitor is sent to is reachable, and reaching it ends the chain", async () => {
  const { host } = chain(SIGNED_OUT);
  let at = "/members/secret";
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) {
    seen.push(at);
    const r = await runNavigation({ host, to: target(at.split("?")[0]!) });
    if (r.outcome.type !== "redirect") break;
    at = r.outcome.to;
  }
  assert.deepEqual(seen.map((p) => p.split("?")[0]), ["/members/secret", "/login"], "one redirect, then the sign-in page itself is public");
});

test("a signed-in person also opens public routes, and protected ones keep enforcing scopes", async () => {
  const { host } = chain(SIGNED_IN);
  assert.deepEqual((await runNavigation({ host, to: target("/welcome") })).outcome, { type: "continue" });
  assert.deepEqual((await runNavigation({ host, to: target("/members", {}, ["read"]) })).outcome, { type: "continue" });
  const denied = (await runNavigation({ host, to: target("/members", {}, ["admin"]) })).outcome;
  assert.equal(denied.type, "denied");
  assert.equal((denied as { status: number }).status, 403);
});

test("a protected route of a MEI that is public elsewhere still needs a session, with its own scopes", async () => {
  const { host } = chain(SIGNED_OUT);
  const r = await runNavigation({ host, to: target("/welcome/members-only", {}, ["read"]) });
  assert.equal(r.outcome.type, "redirect");
});

test("an expired session on a protected route ends it and redirects once; on a public route nothing happens", async () => {
  const soon: SessionState = { ...SIGNED_IN, expiresAt: Date.now() + 1_000 };
  const a = chain(soon);
  const protectedResult = await runNavigation({ host: a.host, to: target("/members") });
  assert.equal(protectedResult.outcome.type, "redirect");
  assert.deepEqual(a.calls, { refresh: 1, signOut: 1 });
  const b = chain(soon);
  const publicResult = await runNavigation({ host: b.host, to: target("/welcome") });
  assert.deepEqual(publicResult.outcome, { type: "continue" });
  assert.deepEqual(b.calls, { refresh: 0, signOut: 0 }, "no refresh storm and no sign-out caused by a public page");
});

test("a shell without sign-in (declared, or switched off for the environment): open pages load, pages that require scopes are denied", async () => {
  const auth = { getState: () => SIGNED_OUT, refresh: async () => false, signOut: async () => undefined } as unknown as AuthManager;
  const m = defaultMiddlewares({ auth, authentication: "none", loginPath: fei.loginPath, locale: { default: "en" } });
  const host = [m["authentication"]!, m["authorization"]!, m["session"]!, m["context"]!];
  for (const path of ["/", "/welcome", "/about"]) assert.deepEqual((await runNavigation({ host, to: target(path) })).outcome, { type: "continue" }, path);
  const denied = await runNavigation({ host, to: target("/members", {}, ["members:read"]) });
  assert.equal(denied.outcome.type, "denied", "no visitor can hold a scope, so the protected page is not opened");
  assert.match(JSON.stringify(denied.outcome), /runs without sign-in[^"]*members:read/);
  assert.equal((await runNavigation({ host, to: target("/members") })).outcome.type, "continue", "a page without scopes stays open");
});
