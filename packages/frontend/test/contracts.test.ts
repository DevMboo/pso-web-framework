import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  validateFei, validateMei, validateRelationships, validateRoutes, flattenRoutes, detectRouteConflicts, matchRoute, ownerOf, contractCompatible, satisfies,
  isSafeRedirect, isSafeAppPath, runNavigation, defineMiddleware, parseManifest, checkRemoteCompatibility, isTrustedRemoteUrl, verifyManifestSignature, canonicalManifest,
  type FeiDefinition, type MeiDefinition, type NavigationTarget, type MiddlewareDefinition,
} from "../src/index.ts";
import { buildRemoteManifest, parseFrontendDeclaration, publicKeyRaw } from "../src/node.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fei: FeiDefinition = {
  name: "fei-commerce", orchestrator: { service: "gateway" }, security: { authentication: "jwt", session: "centralized" },
  middlewares: ["authentication", "authorization", "session", "context", "telemetry"],
  microfrontends: [{ name: "mei-customers", path: "/customers", scopes: ["customers:read"] }, { name: "mei-catalog", path: "/catalog", scopes: ["catalog:read"] }],
};
const mei = (name: string, extra: Partial<MeiDefinition> = {}): MeiDefinition => ({ name, host: "fei-commerce", orchestrator: { service: "gateway" }, security: { inheritFromHost: true, scopes: [name === "mei-customers" ? "customers:read" : "catalog:read"] }, ...extra });
const codes = (ds: Array<{ code: string }>) => ds.map((d) => d.code);

test("a valid FEI and MEI pair produces no errors", () => {
  assert.deepEqual(validateFei(fei), []);
  assert.deepEqual(validateMei(mei("mei-customers")), []);
  const rel = validateRelationships({ file: "FEI.pso.ts", definition: fei }, [{ name: "mei-customers", file: "c/MEI.pso.ts", definition: mei("mei-customers") }, { name: "mei-catalog", file: "k/MEI.pso.ts", definition: mei("mei-catalog") }]);
  assert.deepEqual(rel.filter((d) => d.severity === "error"), []);
});

test("FEI validation names the exact configuration responsible", () => {
  const bad = { ...fei, microfrontends: [{ name: "mei-a", path: "/api/a" }, { name: "mei-b", path: "/orders" }, { name: "mei-c", path: "/orders/new" }, { name: "customers", path: "/x" }, { name: "mei-d", path: "/c/:id" }] };
  const ds = validateFei(bad);
  assert.ok(ds.some((d) => d.code === "PSO_FEI_ROUTE_RESERVED" && d.message.includes("microfrontends[0]")));
  assert.ok(ds.some((d) => d.code === "PSO_FEI_ROUTE_CONFLICT" && d.message.includes("microfrontends[2]") && d.message.includes("mei-b")));
  assert.ok(ds.some((d) => d.code === "PSO_FEI_MICROFRONTEND_NAME"));
  assert.ok(ds.some((d) => d.code === "PSO_FEI_MICROFRONTEND_PATH" && d.message.includes("parameters")));
});

test("authentication and authorization are mandatory and ordered", () => {
  assert.ok(codes(validateFei({ ...fei, middlewares: ["session", "context"] })).includes("PSO_FEI_MIDDLEWARE_MANDATORY"));
  assert.ok(codes(validateFei({ ...fei, middlewares: ["authorization", "authentication"] })).includes("PSO_FEI_MIDDLEWARE_ORDER"));
  assert.ok(codes(validateFei({ ...fei, middlewares: ["custom", "authentication", "authorization"] })).includes("PSO_FEI_MIDDLEWARE_ORDER"));
  const open = { ...fei, microfrontends: fei.microfrontends.map(({ scopes: _s, ...m }) => m) };
  assert.deepEqual(validateFei({ ...open, security: { authentication: "none" }, middlewares: ["context"] }), []);
});

test("0.2.0: contradictory security declarations are rejected", () => {
  // no authentication, yet the shell gates microfrontends by scope: nobody could ever enter them
  assert.deepEqual(codes(validateFei({ ...fei, security: { authentication: "none" }, middlewares: ["context"] })), ["PSO_FEI_AUTH_CONTRADICTION", "PSO_FEI_AUTH_CONTRADICTION"]);
  assert.ok(codes(validateFei({ ...fei, microfrontends: [], security: { authentication: "none", session: "centralized" }, middlewares: ["context"] })).includes("PSO_FEI_AUTH_CONTRADICTION"));
  // a public route that needs scopes, the two spellings disagreeing, and a MEI making itself public through meta
  assert.deepEqual(codes(validateRoutes({ routes: [{ path: "/", page: "./src/pages/Home.tsx", public: true, scopes: ["a:read"] }] }, "ROUTES.pso.ts", { owner: "fei" })), ["PSO_ROUTE_PUBLIC_SCOPES"]);
  assert.deepEqual(codes(validateRoutes({ routes: [{ path: "/", page: "./src/pages/Home.tsx", public: false, meta: { public: true } }] }, "ROUTES.pso.ts", { owner: "fei" })), ["PSO_ROUTE_PUBLIC_AMBIGUOUS"]);
  assert.deepEqual(codes(validateRoutes({ routes: [{ path: "/", page: "./src/pages/Home.tsx", meta: { public: true } }] }, "ROUTES.pso.ts", { owner: "mei" })), ["PSO_ROUTE_PUBLIC_MEI"]);
  // the compatible spelling alone still works
  assert.deepEqual(validateRoutes({ routes: [{ path: "/", page: "./src/pages/Home.tsx", meta: { public: true } }] }, "ROUTES.pso.ts", { owner: "fei" }), []);
});

test("MEI validation: no own session, no mandatory middleware, valid expose", () => {
  assert.ok(codes(validateMei({ ...mei("mei-customers"), security: { inheritFromHost: false } })).includes("PSO_MEI_SESSION"));
  assert.ok(codes(validateMei({ ...mei("mei-customers"), middlewares: ["authentication"] })).includes("PSO_MEI_MIDDLEWARE_MANDATORY"));
  assert.ok(codes(validateMei({ ...mei("mei-customers"), expose: { module: "../x.tsx" } })).includes("PSO_MEI_EXPOSE"));
  assert.ok(codes(validateMei({ ...mei("customers") })).includes("PSO_MEI_NAME"));
});

test("relationships: host mismatch, unregistered, scope mismatch, contract, orchestrator and port conflicts", () => {
  const info = (m: MeiDefinition) => ({ name: m.name, file: `${m.name}/MEI.pso.ts`, definition: m });
  const r = validateRelationships({ file: "f/FEI.pso.ts", definition: fei }, [
    info({ ...mei("mei-customers"), host: "fei-other" }),
    info({ ...mei("mei-orders"), orchestrator: { service: "other" } }),
    info({ ...mei("mei-catalog"), security: { scopes: ["catalog:write"] }, contract: { context: "2.0" }, server: { port: 4200 } }),
  ]);
  const c = codes(r);
  for (const x of ["PSO_MEI_HOST_MISMATCH", "PSO_MEI_NOT_REGISTERED", "PSO_MEI_SCOPE_MISMATCH", "PSO_MEI_CONTRACT_INCOMPATIBLE", "PSO_FRONTEND_PORT_CONFLICT"]) assert.ok(c.includes(x), x);
  assert.ok(r.find((d) => d.code === "PSO_MEI_SCOPE_MISMATCH")!.message.includes("microfrontends[1]"));
  assert.ok(r.some((d) => d.code === "PSO_FEI_REMOTE_NOT_FOUND" || d.code === "PSO_MEI_NOT_REGISTERED"));
});

test("contract and dependency compatibility", () => {
  assert.equal(contractCompatible("1.0", "1.2").ok, true);
  assert.equal(contractCompatible("1.3", "1.2").ok, false);
  assert.equal(contractCompatible("2.0", "1.9").ok, false);
  assert.equal(satisfies("18.3.1", "^18.2.0"), true);
  assert.equal(satisfies("19.0.0", "^18.2.0"), false);
  assert.equal(satisfies("18.3.1", "~18.2.0"), false);
});

test("routes: effective paths, precedence, params, wildcard, deterministic", () => {
  const def = { routes: [{ path: "/", page: "./src/pages/List.tsx", title: "Customers" }, { path: "/new", page: "./src/pages/New.tsx" }, { path: "/:id", page: "./src/pages/Detail.tsx", children: [{ path: "/edit", page: "./src/pages/Edit.tsx" }] }, { path: "/old", redirect: "/new" }] };
  assert.deepEqual(validateRoutes(def), []);
  const rs = flattenRoutes(def, "mei-customers", "/customers", "ROUTES.pso.ts");
  assert.deepEqual(rs.map((r) => r.path), ["/customers", "/customers/new", "/customers/:id", "/customers/:id/edit", "/customers/old"]);
  assert.equal(rs.find((r) => r.path === "/customers/old")!.redirect, "/customers/new");
  assert.equal(matchRoute(rs, "/customers/new")!.route.page, "./src/pages/New.tsx"); // static beats :id
  assert.deepEqual(matchRoute(rs, "/customers/a%20b")!.params, { id: "a b" });
  assert.equal(matchRoute(rs, "/customers/7/edit")!.route.path, "/customers/:id/edit");
  assert.equal(matchRoute(rs, "/customers/")!.route.path, "/customers");
  assert.equal(matchRoute(rs, "/nope"), undefined);
  assert.equal(matchRoute(rs, "/customers/1/2/3"), undefined);
  const w = flattenRoutes({ routes: [{ path: "/*", page: "./src/pages/NotFound.tsx" }, { path: "/x", page: "./src/pages/X.tsx" }] }, "mei-a", "/a", "R");
  assert.equal(matchRoute(w, "/a/x")!.route.page, "./src/pages/X.tsx");
  assert.equal(matchRoute(w, "/a/y/z")!.params["*"], "y/z");
  assert.equal(matchRoute([...rs].reverse(), "/customers/new")!.route.path, "/customers/new"); // order of input does not matter
});

test("route conflicts and invalid route declarations are reported", () => {
  const a = flattenRoutes({ routes: [{ path: "/:id", page: "./a.tsx" }, { path: "/:name", page: "./b.tsx" }] }, "mei-a", "/a", "R");
  assert.ok(codes(detectRouteConflicts(a)).includes("PSO_ROUTE_CONFLICT"));
  const x = flattenRoutes({ routes: [{ path: "/p", page: "./a.tsx" }] }, "mei-a", "/shared", "R1"), y = flattenRoutes({ routes: [{ path: "/p", page: "./a.tsx" }] }, "mei-b", "/shared", "R2");
  assert.ok(detectRouteConflicts([...x, ...y]).some((d) => d.message.includes("already owned by mei-a")));
  const ds = codes(validateRoutes({ routes: [{ path: "/a", page: "../../etc/passwd.tsx" }, { path: "/b" }, { path: "/c", page: "./c.tsx", redirect: "/x" }, { path: "https://evil.example/x", page: "./d.tsx" }] }));
  for (const c of ["PSO_ROUTE_FILE", "PSO_ROUTE_EMPTY", "PSO_ROUTE_AMBIGUOUS", "PSO_ROUTE_PATH"]) assert.ok(ds.includes(c), c);
  assert.equal(ownerOf([{ name: "a", path: "/a" }, { name: "ab", path: "/a/b" }], "/a/b/c")!.name, "ab");
  assert.equal(ownerOf([{ name: "a", path: "/a" }], "/ab"), undefined);
});

test("safe redirects and paths", () => {
  for (const ok of ["/", "/customers/1?x=1", "/a/b"]) assert.equal(isSafeRedirect(ok), true, ok);
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "evil", "/a\nb", ""]) assert.equal(isSafeRedirect(bad), false, bad);
  assert.equal(isSafeAppPath("/a/../b"), false);
  assert.equal(isSafeAppPath("/a%2e%2e/b"), false);
});

const target = (extra: Partial<NavigationTarget> = {}): NavigationTarget => ({ path: "/customers/1", query: {}, params: {}, hash: "", owner: "mei-customers", scopes: ["customers:read"], ...extra });
const mw = (name: string, f: MiddlewareDefinition["execute"]) => defineMiddleware({ name, execute: f });

test("pipeline: ordered, context propagates, short-circuit, redirect, deny", async () => {
  const order: string[] = [];
  const a = mw("a", async (c, next) => { order.push("a"); c.set("locale", "pt-BR"); return next(); });
  const b = mw("b", async (c, next) => { order.push(`b:${c.get("locale")}`); return next(); });
  const r = await runNavigation({ host: [a, b], to: target() });
  assert.deepEqual(r.trace, ["a", "b"]); assert.deepEqual(order, ["a", "b:pt-BR"]); assert.equal(r.outcome.type, "continue"); assert.equal(r.values["locale"], "pt-BR");
  const deny = mw("deny", async (c) => c.deny(403, "no scope"));
  const r2 = await runNavigation({ host: [deny, b], to: target() });
  assert.deepEqual(r2.outcome, { type: "denied", status: 403, reason: "no scope" }); assert.deepEqual(r2.trace, ["deny"]);
  const red = mw("red", async (c) => c.redirect("/login"));
  assert.deepEqual((await runNavigation({ host: [red], to: target() })).outcome, { type: "redirect", to: "/login" });
});

test("pipeline: unsafe redirects, errors, double next and cancellation are refused", async () => {
  await assert.rejects(runNavigation({ host: [mw("x", async (c) => c.redirect("//evil.example"))], to: target() }), /redirect to "\/\/evil\.example" refused/);
  await assert.rejects(runNavigation({ host: [mw("x", async () => ({ type: "redirect", to: "https://evil.example" }))], to: target() }), /refused/);
  await assert.rejects(runNavigation({ host: [mw("boom", async () => { throw new Error("kaput"); })], to: target() }), (e: Error) => e.name === "PipelineError" && /boom/.test(e.message) && /kaput/.test(e.message));
  await assert.rejects(runNavigation({ host: [mw("twice", async (_c, next) => { await next(); return next(); })], to: target() }), /next\(\) called twice/);
  const ac = new AbortController();
  await assert.rejects(runNavigation({ host: [mw("slow", async (_c, next) => { ac.abort(); return next(); })], to: target(), signal: ac.signal }), /cancelled/);
});

test("MEI middleware cannot bypass or weaken the mandatory pipeline", async () => {
  const seen: string[] = [];
  const domain = { name: "mei-customers", middlewares: [mw("dom", async (c, next) => { seen.push(String(c.get("user"))); c.set("mei.mei-customers.flag", true); return next(); })] };
  const hostAllows = mw("auth", async (c, next) => { c.set("user", "ana"); return next(); });
  const ok = await runNavigation({ host: [hostAllows], domain, to: target() });
  assert.deepEqual(seen, ["ana"]); assert.equal(ok.values["mei.mei-customers.flag"], true); assert.deepEqual(ok.trace, ["auth", "dom"]);
  // a denial by the host means the MEI middleware never runs
  seen.length = 0;
  const denied = await runNavigation({ host: [mw("auth", async (c) => c.deny(401, "no session"))], domain, to: target() });
  assert.equal(denied.outcome.type, "denied"); assert.deepEqual(seen, []);
  // it cannot overwrite what the host published
  await assert.rejects(runNavigation({ host: [hostAllows], domain: { name: "mei-customers", middlewares: [mw("evil", async (c, next) => { c.set("user", "root"); return next(); })] }, to: target() }), /may not write "user"/);
  // it may deny, but only redirect inside its mount path
  const d2 = await runNavigation({ host: [hostAllows], domain: { name: "mei-customers", middlewares: [mw("d", async (c) => c.deny(403, "domain rule"))] }, to: target() });
  assert.equal(d2.outcome.type, "denied");
  await assert.rejects(runNavigation({ host: [hostAllows], domain: { name: "mei-customers", middlewares: [mw("r", async (c) => c.redirect("/admin"))] }, to: target() }), /only redirect inside its own mount path/);
  assert.equal((await runNavigation({ host: [hostAllows], domain: { name: "mei-customers", middlewares: [mw("r", async (c) => c.redirect("/customers/new"))] }, to: target() })).outcome.type, "redirect");
});

test("the declaration reader accepts data and refuses code", () => {
  const ok = parseFrontendDeclaration(`import { defineFEI } from "@pso/frontend";\nexport default defineFEI({ name: "fei-x", server: { port: 4200 }, microfrontends: [] });`, "FEI.pso.ts", "defineFEI");
  assert.deepEqual(ok.problems, []); assert.equal((ok.value as { name: string }).name, "fei-x");
  const bad = parseFrontendDeclaration(`export default defineFEI({ name: process.env.NAME, ...other, port: compute() });`, "FEI.pso.ts", "defineFEI");
  assert.ok(bad.problems.length >= 2 && bad.problems.every((p) => /literal|key: value/.test(p)));
  assert.match(parseFrontendDeclaration(`export default defineMEI({})`, "x", "defineFEI").problems[0]!, /must be defineFEI/);
});

test("shared singletons: the host may be newer than the MEI within one major, never older or another major", () => {
  const base = { schema: 1, kind: "pso-mei-manifest", name: "mei-a", host: "fei-x", version: "1.0.0", contract: { context: "1.0" }, entry: "r.js", expose: "./module", scopes: [], routes: [{ path: "/a" }], files: [{ path: "r.js", sha256: "a".repeat(64), size: 1 }], createdAt: "x" };
  const m = (react: string) => parseManifest({ ...base, shared: { react } }).manifest!;
  const host = (react: string) => ({ contract: "1.0", shared: { react } });
  const issues = (mine: string, theirs: string) => checkRemoteCompatibility(m(mine), { name: "mei-a", host: "fei-x" }, host(theirs));
  assert.deepEqual(issues("18.3.0", "18.3.1"), []);   // same major, host newer
  assert.deepEqual(issues("18.2.0", "18.3.1"), []);
  assert.equal(issues("18.3.1", "18.2.0").length, 1); // host older than the MEI needs
  assert.equal(issues("18.3.1", "19.0.0").length, 1); // another major
  assert.equal(issues("19.0.0", "18.3.1").length, 1);
});

test("manifest: parse, compatibility, trusted URLs", () => {
  const good = { schema: 1, kind: "pso-mei-manifest", name: "mei-customers", host: "fei-commerce", version: "1.0.0", contract: { context: "1.0" }, entry: "remoteEntry.js", expose: "./module", shared: { react: "18.3.1" }, scopes: [], routes: [{ path: "/customers" }], files: [{ path: "remoteEntry.js", sha256: "a".repeat(64), size: 1 }], createdAt: "2026-01-01T00:00:00Z" };
  const p = parseManifest(good); assert.deepEqual(p.problems, []);
  assert.ok(parseManifest({ ...good, entry: "../x.js" }).problems.length);
  assert.ok(parseManifest({ ...good, files: [{ path: "other.js", sha256: "a".repeat(64), size: 1 }] }).problems.some((x) => /not listed/.test(x)));
  assert.deepEqual(checkRemoteCompatibility(p.manifest!, { name: "mei-customers", host: "fei-commerce" }, { contract: "1.0", shared: { react: "18.3.1" } }), []);
  const issues = checkRemoteCompatibility({ ...p.manifest!, shared: { react: "^19.0.0" }, host: "fei-x" }, { name: "mei-customers", host: "fei-commerce" }, { contract: "1.0", shared: { react: "18.3.1" } });
  assert.equal(issues.length, 2);
  const o = { origin: "https://app.example", mode: "production" as const };
  assert.equal(isTrustedRemoteUrl("/_mei/customers/pso-manifest.json", o), true);
  assert.equal(isTrustedRemoteUrl("/assets/evil.js", o), false);
  assert.equal(isTrustedRemoteUrl("https://evil.example/_mei/x", o), false);
  assert.equal(isTrustedRemoteUrl("https://cdn.example/_mei/x", { ...o, allowedOrigins: ["https://cdn.example"] }), true);
  assert.equal(isTrustedRemoteUrl("http://cdn.example/_mei/x", { ...o, allowedOrigins: ["http://cdn.example"] }), false);
  assert.equal(isTrustedRemoteUrl("http://localhost:9000/x", { origin: "http://localhost:4200", mode: "development" }), true);
  assert.equal(isTrustedRemoteUrl("http://localhost:9000/x", o), false);
  assert.equal(isTrustedRemoteUrl("https://u:p@app.example/_mei/x", o), false);
});

test("a built MEI release gets a hashed, signed manifest that verifies and detects tampering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pso-mf-"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "remoteEntry.js"), "console.log(1)"); writeFileSync(join(dir, "dist", "assets", "a.js"), "x");
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const m = buildRemoteManifest({ dir, definition: mei("mei-customers"), routes: [], version: "1.2.3", signWith: { keyId: "k1", privateKeyPem: pem } });
  assert.equal(m.files.length, 2); assert.equal(m.signature!.alg, "ed25519");
  const written = JSON.parse(readFileSync(join(dir, "dist", "pso-manifest.json"), "utf8"));
  const keys = [{ keyId: "k1", publicKey: publicKeyRaw(pem) }];
  assert.deepEqual(await verifyManifestSignature(written, keys), { ok: true, keyId: "k1" });
  const tampered = { ...written, files: [{ ...written.files[0], sha256: "b".repeat(64) }, written.files[1]] };
  assert.equal((await verifyManifestSignature(tampered, keys) as { ok: boolean }).ok, false);
  assert.match((await verifyManifestSignature(written, [{ keyId: "other", publicKey: keys[0]!.publicKey }]) as { reason: string }).reason, /not trusted/);
  assert.match((await verifyManifestSignature({ ...written, signature: undefined }, keys) as { reason: string }).reason, /not signed/);
  assert.equal(canonicalManifest(written), canonicalManifest({ ...written, signature: undefined }));
});

test("localized navigation metadata and breadcrumbs", async () => {
  const { resolveText, breadcrumbsFor } = await import("../src/index.ts");
  assert.equal(resolveText("Customers", "pt-BR"), "Customers");
  assert.equal(resolveText({ en: "Customers", "pt-BR": "Clientes" }, "pt-BR"), "Clientes");
  assert.equal(resolveText({ en: "Customers", pt: "Clientes" }, "pt-PT"), "Clientes", "the language wins over a missing region");
  assert.equal(resolveText({ en: "Customers" }, "fr"), "Customers", "a missing translation falls back to the first declared one");
  assert.equal(resolveText(undefined, "en"), undefined);
  const known = [{ path: "/customers", title: { en: "Customers", "pt-BR": "Clientes" } }, { path: "/customers/new", title: "New customer" }, { path: "/customers/:id", title: "Customer" }];
  assert.deepEqual(breadcrumbsFor(known, "/customers/new", "en"), [{ path: "/customers", title: "Customers" }, { path: "/customers/new", title: "New customer" }]);
  assert.deepEqual(breadcrumbsFor(known, "/customers/42", "pt-BR"), [{ path: "/customers", title: "Clientes" }, { path: "/customers/42", title: "Customer" }]);
  assert.deepEqual(breadcrumbsFor(known, "/orders/a%20b", "en"), [{ path: "/orders", title: "orders" }, { path: "/orders/a%20b", title: "a b" }]);
  assert.deepEqual(breadcrumbsFor(known, "/orders/%E0%A4%A", "en").at(-1)!.title, "%E0%A4%A", "a malformed escape does not throw");
});
