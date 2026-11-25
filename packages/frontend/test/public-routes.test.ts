import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenRoutes, isPublicMeiPath, isPublicRoute, validateFei, validateRoutes, type FeiDefinition, type FrontendRoutesDefinition } from "../src/index.ts";

/** Public routes: the declaration, its validation, and the one rule that decides whether a visitor with no session may open a path. Default is protected. */

const base = (over: Partial<FeiDefinition> = {}): FeiDefinition => ({
  name: "fei-app", orchestrator: { service: "gateway" }, security: { authentication: "jwt", loginPath: "/login" },
  microfrontends: [{ name: "mei-members", path: "/members" }], ...over,
});
const codes = (d: Array<{ code: string }>) => d.map((x) => x.code);

test("nothing is public unless the FEI says so: an undeclared route, a MEI and the application root are protected", () => {
  const fei = { loginPath: "/login", microfrontends: [{ name: "mei-members", path: "/members" }, { name: "mei-welcome", path: "/welcome", public: false }] };
  for (const p of ["/", "/members", "/members/x/y", "/welcome", "/welcome/anything", "/unknown", "/api/x"]) assert.equal(isPublicRoute(fei, [], p), false, p);
  // what the shell itself serves so that a visitor can sign in and come back
  for (const p of ["/login", "/auth/callback", "/forbidden", "/login/"]) assert.equal(isPublicRoute(fei, [], p), true, p);
});

test("a MEI declared public is public on its whole mount, and only there; a lookalike prefix is not", () => {
  const fei = { loginPath: "/login", microfrontends: [{ name: "mei-welcome", path: "/welcome", public: true as const }, { name: "mei-members", path: "/members" }] };
  for (const p of ["/welcome", "/welcome/", "/welcome/a/b", "/welcome/guide/x"]) assert.equal(isPublicRoute(fei, [], p), true, p);
  for (const p of ["/welcomes", "/welcome-private", "/members", "/members/welcome"]) assert.equal(isPublicRoute(fei, [], p), false, p);
});

test("a MEI can declare only some routes public: the rest of the same MEI stays protected", () => {
  const entry = { name: "mei-welcome", path: "/welcome", public: ["/", "/guide/*", "/about"] };
  assert.equal(isPublicMeiPath(entry, "/welcome"), true);
  assert.equal(isPublicMeiPath(entry, "/welcome/"), true);
  assert.equal(isPublicMeiPath(entry, "/welcome/about"), true);
  assert.equal(isPublicMeiPath(entry, "/welcome/guide/getting-started"), true);
  assert.equal(isPublicMeiPath(entry, "/welcome/guide"), true, "a trailing /* is a splat, as in the router: the bare prefix matches too");
  assert.equal(isPublicMeiPath(entry, "/welcome/members"), false);
  assert.equal(isPublicMeiPath(entry, "/welcome/about/extra"), false, "a static pattern is exact");
  assert.equal(isPublicMeiPath(entry, "/other/about"), false);
  assert.equal(isPublicMeiPath({ name: "x", path: "/x" }, "/x"), false, "no declaration: protected");
  assert.equal(isPublicMeiPath({ name: "x", path: "/x", public: [] }, "/x"), false, "an empty list makes nothing public");
});

test("a FEI route is public only when marked, through `public` or the earlier `meta.public`; the marking never spreads to other routes or to the MEIs", () => {
  const routes: FrontendRoutesDefinition = { routes: [{ path: "/", page: "./src/pages/Home.tsx" }, { path: "/about", page: "./src/pages/About.tsx", public: true }, { path: "/legacy", page: "./src/pages/L.tsx", meta: { public: true } }, { path: "/terms", children: [{ path: "/en", page: "./src/pages/T.tsx", public: true }, { path: "/admin", page: "./src/pages/A.tsx" }] }] };
  const own = flattenRoutes(routes, "fei-app", "/", "ROUTES.pso.ts");
  const fei = { loginPath: "/login", microfrontends: [{ name: "mei-members", path: "/members" }] };
  assert.equal(isPublicRoute(fei, own, "/"), false);
  assert.equal(isPublicRoute(fei, own, "/about"), true);
  assert.equal(isPublicRoute(fei, own, "/legacy"), true);
  assert.equal(isPublicRoute(fei, own, "/terms/en"), true);
  assert.equal(isPublicRoute(fei, own, "/terms/admin"), false);
  assert.equal(isPublicRoute(fei, own, "/members"), false);
});

test("validateFei accepts the public declarations and refuses malformed or contradictory ones", () => {
  const ok = base({ microfrontends: [{ name: "mei-welcome", path: "/welcome", public: ["/", "/guide/*"] }, { name: "mei-docs", path: "/docs", public: true }, { name: "mei-members", path: "/members" }] });
  assert.deepEqual(validateFei(ok), []);
  const bad = (m: unknown) => codes(validateFei(base({ microfrontends: [m as never] })));
  assert.deepEqual(bad({ name: "mei-a", path: "/a", public: "yes" }), ["PSO_FEI_MICROFRONTEND_PUBLIC"]);
  assert.deepEqual(bad({ name: "mei-a", path: "/a", public: [] }), ["PSO_FEI_MICROFRONTEND_PUBLIC"]);
  assert.deepEqual(bad({ name: "mei-a", path: "/a", public: ["relative"] }), ["PSO_FEI_MICROFRONTEND_PUBLIC"]);
  assert.deepEqual(bad({ name: "mei-a", path: "/a", public: ["/x/../y"] }), ["PSO_FEI_MICROFRONTEND_PUBLIC"]);
  assert.deepEqual(bad({ name: "mei-a", path: "/a", public: ["/*/x"] }), ["PSO_FEI_MICROFRONTEND_PUBLIC"]);
  assert.deepEqual(bad({ name: "mei-a", path: "/a", public: true, scopes: ["read"] }), ["PSO_FEI_MICROFRONTEND_PUBLIC_SCOPES"], "a visitor has no scopes");
  assert.deepEqual(bad({ name: "mei-a", path: "/a", public: false, scopes: ["read"] }), [], "scopes are fine while it is protected");
  // the shell serves these itself
  assert.deepEqual(bad({ name: "mei-a", path: "/auth", public: true }), ["PSO_FEI_MOUNT_SHELL_ROUTE"]);
  assert.deepEqual(bad({ name: "mei-a", path: "/forbidden", public: true }), ["PSO_FEI_MOUNT_SHELL_ROUTE"]);
  assert.deepEqual(bad({ name: "mei-a", path: "/api/x", public: true }), ["PSO_FEI_ROUTE_RESERVED"], "a public route can never sit on the API prefix");
  assert.deepEqual(bad({ name: "mei-a", path: "/_mei/x", public: true }), ["PSO_FEI_ROUTE_RESERVED"]);
});

test("the sign-in page may live inside a MEI only when that MEI makes it public: otherwise a visitor would be redirected to sign in forever", () => {
  const login = (loginPath: string, pub: boolean | string[] | undefined) => codes(validateFei(base({ security: { authentication: "jwt", loginPath }, microfrontends: [{ name: "mei-access", path: "/access", ...(pub !== undefined ? { public: pub } : {}) }] })));
  assert.deepEqual(login("/access/login", ["/login", "/register"]), []);
  assert.deepEqual(login("/access/login", true), []);
  assert.deepEqual(login("/access/login", undefined), ["PSO_FEI_LOGIN_PATH_PROTECTED"]);
  assert.deepEqual(login("/access/login", ["/register"]), ["PSO_FEI_LOGIN_PATH_PROTECTED"]);
  assert.deepEqual(login("/access/login", false), ["PSO_FEI_LOGIN_PATH_PROTECTED"]);
  assert.deepEqual(login("/signin", undefined), [], "a sign-in page of the shell is always reachable");
  assert.deepEqual(codes(validateFei(base({ security: { authentication: "none" }, microfrontends: [{ name: "mei-access", path: "/login", }] }))), [], "without authentication there is nothing to loop");
});

test("route declarations: `public` is for the FEI's own routes; a MEI cannot make its own route public", () => {
  const r = { routes: [{ path: "/about", page: "./src/pages/About.tsx", public: true }] };
  assert.deepEqual(validateRoutes(r, "ROUTES.pso.ts", { owner: "fei" }), []);
  assert.deepEqual(validateRoutes(r), [], "unspecified owner (older callers) keeps working");
  assert.deepEqual(codes(validateRoutes(r, "ROUTES.pso.ts", { owner: "mei" })), ["PSO_ROUTE_PUBLIC_MEI"]);
  assert.deepEqual(codes(validateRoutes({ routes: [{ path: "/a", page: "./src/pages/A.tsx", public: "yes" }] }, "ROUTES.pso.ts", { owner: "fei" })), ["PSO_ROUTE_PUBLIC"]);
  assert.deepEqual(validateRoutes({ routes: [{ path: "/a", page: "./src/pages/A.tsx", public: false }] }, "ROUTES.pso.ts", { owner: "mei" }), [], "false is just the default");
});

test("backward compatibility: a FEI with no public declaration validates exactly as before and everything it serves is protected", () => {
  const old = base({ microfrontends: [{ name: "mei-customers", path: "/customers", scopes: ["customers:read"] }, { name: "mei-orders", path: "/orders" }] });
  assert.deepEqual(validateFei(old), []);
  const fei = { loginPath: "/login", microfrontends: old.microfrontends };
  assert.equal(isPublicRoute(fei, [], "/customers"), false);
  assert.equal(isPublicRoute(fei, [], "/orders/42"), false);
  assert.equal(isPublicRoute(fei, [], "/login"), true);
});
