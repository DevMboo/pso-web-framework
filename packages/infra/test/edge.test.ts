import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { connect } from "node:tls";
import { randomBytes } from "node:crypto";
import {
  apply, plan, environmentCa, localResolution, netRequest, DISCLOSURE, EDGE_DIR, EDGE_INCLUDES, EDGE_RESOURCES, EDGE_STATUSES, edgeBuildContext, edgeImage, ensureEdgeImage,
  type EngineHooks, type FrontendInfo, type NetResponse,
} from "../src/index.ts";

/**
 * The edge's native error handling and information-disclosure protection. Part 1 checks the framework resources, their ownership and
 * their distribution without Docker; part 2 sends real HTTP and HTTPS requests to the real edge image running the configuration the
 * engine generates, in front of stub upstreams on a private Docker network.
 */
const repo = join(EDGE_DIR, "..", "..", "..");
const REQUIRED = [400, 401, 403, 404, 405, 413, 429, 500, 502, 503, 504];
const fei = (name: string, port: number, extra: Partial<FrontendInfo> = {}): FrontendInfo => ({ name, port, authentication: "jwt", microfrontends: [], scopes: [], orchestratorBasePath: "/api", routes: [], ...extra });
const LOCAL = { schemaVersion: 1, defaultEnvironment: "local", environments: { local: { kind: "development", domain: "pso.localhost", runtime: "docker", httpsPort: 8443 } }, identity: { provider: "keycloak", realm: "shop", users: [{ username: "ana", scopes: ["cart:write"] }] } };
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pso-edge-ws-"));
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "shop", services: [
    { name: "gateway", path: "gateway", runtime: "node", role: "orchestrator", port: 3000, health: "/health/ready" },
    { name: "catalog", path: "catalog", runtime: "spring-boot", role: "service", port: 8081, prefix: "/catalog" },
  ] }, null, 2));
  for (const d of ["gateway", "catalog"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "pso.infra.json"), JSON.stringify(LOCAL, null, 2));
  const fes = [fei("fei-shop", 4200, { microfrontends: ["mei-catalog"], scopes: ["cart:write"] }), fei("fei-admin", 4300)];
  const hooks: EngineHooks = { frontends: () => ({ frontends: fes, scopes: ["cart:write"] }) };
  return { root, hooks };
}
const walk = (d: string, acc: string[] = []): string[] => { if (!existsSync(d)) return acc; for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f, acc); else acc.push(f); } return acc; };

// ------------------------------------------------------------------------------------------------------------------------ 1. resources

test("every required status (and nginx's 494-497) has a page and a problem document; one template, nothing external, nothing identifying", () => {
  const ctx = edgeBuildContext();
  for (const code of REQUIRED) assert.ok(EDGE_STATUSES.some((s) => s.code === code), `status ${code}`);
  assert.deepEqual(EDGE_STATUSES.find((s) => s.code === 400)!.from, [495, 496, 497], "497 (plain HTTP on the TLS port) is answered as 400");
  assert.deepEqual(EDGE_STATUSES.find((s) => s.code === 431)!.from, [494]);
  const styles = new Set<string>();
  for (const s of EDGE_STATUSES) {
    const html = ctx.get(`errors/html/${s.code}.html`)!;
    assert.ok(html, `page ${s.code}`);
    assert.match(html, /^<!doctype html>\n<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, new RegExp(`<h1>${s.title.replace(/'/g, "&#39;")}</h1>`));
    assert.match(html, new RegExp(`Error ${s.code}<`));
    assert.doesNotMatch(html, /<script|<img|<link|<iframe|@import|url\(|https?:|\/\/[a-z]/i, `${s.code}: no script and no external resource`);
    assert.doesNotMatch(html.replace(/<style>[\s\S]*<\/style>/, ""), DISCLOSURE, `${s.code}: no technology, version, path or internal status`);
    assert.doesNotMatch(html, /\{\{[a-z]+\}\}/, "every placeholder is filled");
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji");
    styles.add(/<style>([\s\S]*?)<\/style>/.exec(html)![1]!);
    const p = JSON.parse(ctx.get(`errors/problem/${s.code}.json`)!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(p), ["type", "title", "status", "detail"]);
    assert.equal(p["type"], "about:blank"); assert.equal(p["status"], s.code);
    assert.doesNotMatch(JSON.stringify(p), DISCLOSURE);
  }
  assert.equal(styles.size, 1, "one visual standard for every status");
  assert.doesNotMatch([...styles][0]!, /url\(|@import|@font-face/, "no external font or image");
  assert.ok(ctx.get("errors/html/502.html")!.includes('<a href="">Try again</a>') && !ctx.get("errors/html/421.html")!.includes("<nav"), "actions depend on the status; no link where it cannot help");
});

test("the nginx snippets only name files the image contains; every status is mapped for browsers and for programs", () => {
  const ctx = edgeBuildContext();
  for (const kind of ["browser", "api"] as const) {
    const conf = ctx.get(`conf/${kind}-errors.conf`)!;
    for (const s of EDGE_STATUSES) assert.match(conf, new RegExp(`^error_page ${s.code} /__edge_error__/${kind === "browser" ? "html" : "problem"}/${s.code}\\.(html|json);$`, "m"));
    assert.match(conf, /^error_page 495 496 497 =400 /m);
    for (const [, target] of conf.matchAll(/ (\/__edge_error__\/\S+);$/gm)) assert.ok(ctx.has(`errors/${target!.replace("/__edge_error__/", "")}`), `${kind}: ${target} exists in the image`);
  }
  const loc = ctx.get("conf/error-locations.conf")!;
  assert.equal((loc.match(/^\s+internal;$/gm) ?? []).length, 2, "the error locations are internal: never reachable by a request");
  assert.match(loc, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.equal((loc.match(/more_clear_headers Server X-Powered-By/g) ?? []).length, 2);
  const docker = ctx.get("Dockerfile")!;
  assert.match(docker, /^FROM alpine:3\.\d+@sha256:[0-9a-f]{64}$/m, "the base image is pinned by digest");
  assert.match(docker, /nginx-mod-http-headers-more/);
  assert.match(ctx.get("nginx.conf")!, /^load_module \/usr\/lib\/nginx\/modules\/ngx_http_headers_more_filter_module\.so;$/m);
  const all = [...ctx.values()].join("\n");
  assert.doesNotMatch(all, /[A-Za-z]:\\|\/Users\/|\/home\//, "no path of the machine that builds it");
  assert.ok(!all.includes(repo) && !all.includes(repo.replace(/\\/g, "/")), "not even the repository's own location");
  assert.match(edgeImage().tag, /^pso-edge:[0-9a-f]{16}$/);
  assert.equal(edgeImage().tag, edgeImage().tag);
});

test("the generated edge configuration: every public server handles its errors, APIs get problem documents, only the shells are intercepted", () => {
  const { root, hooks } = workspace();
  apply(root, { hooks });
  const conf = readFileSync(join(root, ".infra", "nginx", "local", "edge.conf"), "utf8");
  const servers = conf.split(/^server \{$/m).slice(1).map((b) => b.slice(0, b.search(/^\}$/m)));
  const pub = servers.filter((b) => /listen 8443 ssl/.test(b));
  assert.equal(pub.length, 5, "shop, admin, api, identity, default");
  for (const b of pub) assert.ok(b.includes(`include ${EDGE_INCLUDES.locations};`), "error locations in every public server");
  const of = (host: string) => pub.find((b) => new RegExp(`server_name ${host.replace(/\./g, "\\.")};`).test(b))!;
  const t = plan(root, undefined, hooks).topology;
  for (const f of t.frontends) {
    const b = of(f.host);
    assert.ok(b.includes(`    include ${EDGE_INCLUDES.browser};`), `${f.name}: pages for browsers`);
    assert.match(b, /location \^~ \/api\/ \{[^}]*include \/etc\/nginx\/edge\/api-errors\.conf;[^}]*\}/, `${f.name}: the same-origin API gets problem documents`);
    assert.match(b, /location = \/channels \{[^}]*include \/etc\/nginx\/edge\/api-errors\.conf;/);
    assert.match(b, /location \/ \{[^}]*proxy_intercept_errors on;/, `${f.name}: the shell's static server is intercepted`);
  }
  assert.ok(of(t.api.host).includes(`    include ${EDGE_INCLUDES.api};`), "the API host answers programs");
  assert.equal((conf.match(/proxy_intercept_errors on;/g) ?? []).length, t.frontends.length, "the orchestrator and the identity provider are never intercepted");
  assert.match(of(t.identity!.host), /location ~ \^\/\(realms\/\[\^\/\]\+\/\(protocol\/openid-connect[^{]*\{[^}]*api-errors\.conf;/, "token, keys and discovery answer programs");
  const def = pub.find((b) => /default_server/.test(b))!;
  assert.ok(def.includes(EDGE_INCLUDES.browser) && /location \/ \{ return 421; \}/.test(def), "an unknown host gets the sanitized page");
  assert.match(conf, /^server_tokens off;$/m);
  const compose = readFileSync(join(root, ".infra", "docker", "local", "compose.yml"), "utf8");
  assert.match(compose, new RegExp(`  edge:\\n    image: "${edgeImage().tag}"\\n    pull_policy: "never"\\n`), "the edge runs the framework image, never a pulled one");
  // nothing of the error machinery is in the workspace: only the generated configuration names it
  const files = walk(root).map((f) => relative(root, f).split("\\").join("/"));
  assert.deepEqual(files.filter((f) => /\.html$|errors?\/|problem\/|page\.html|__edge_error__/.test(f)), [], "no error page in the workspace or .infra/");
  for (const f of files) assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /Error \d{3}<|Something went wrong|"type":"about:blank"/, `${f} holds no error page content`);
  rmSync(root, { recursive: true, force: true });
});

test("distribution: the edge resources are in the npm package, the installer allowlist and the distribution policy", async () => {
  const pkg = JSON.parse(readFileSync(join(EDGE_DIR, "..", "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("edge"), "@pso/infra files lists edge");
  for (const r of EDGE_RESOURCES) assert.ok(existsSync(join(EDGE_DIR, r)), r);
  const dist = JSON.parse(readFileSync(join(repo, "dist.config.json"), "utf8")) as { components: Array<{ include: Array<{ from: string; to: string }> }> };
  assert.ok(dist.components[0]!.include.some((i) => i.from === "packages/infra/edge" && i.to === "node_modules/@pso/infra/edge"), "dist.config.json copies packages/infra/edge");
  const { classify } = await import(new URL("../../../scripts/psd/policy.mjs", import.meta.url).href) as { classify: (p: string) => { cls: string; id: string } | null };
  for (const r of EDGE_RESOURCES) { const c = classify(`node_modules/@pso/infra/edge/${r}`); assert.equal(c?.cls, "A", `${r}: ${JSON.stringify(c)}`); }
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], { cwd: join(EDGE_DIR, ".."), encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(npm.status, 0, npm.stderr);
  const packed = (JSON.parse(npm.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
  for (const r of EDGE_RESOURCES) assert.ok(packed.includes(`edge/${r}`), `npm package contains edge/${r}`);
});

// ------------------------------------------------------------------------------------------------------------------------ 2. real nginx

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 180_000, windowsHide: true });
const dockerOk = docker("info", "--format", "{{.ServerVersion}}").status === 0 && docker("image", "inspect", "node:24-alpine").status === 0;
const id = randomBytes(3).toString("hex");
const net = `pso-edge-test-${id}`;
const started: string[] = [];
after(() => { for (const c of started) docker("rm", "-f", c); docker("network", "rm", net); });

test("real edge: sanitized native errors, no server identification, upstream contracts preserved", { skip: dockerOk ? false : "Docker or node:24-alpine is not available", timeout: 600_000 }, async (tt) => {
  const { root, hooks } = workspace();
  apply(root, { hooks });
  const t = plan(root, undefined, hooks).topology;
  const ca = environmentCa(root, t)!;
  await ensureEdgeImage(edgeImage().tag);
  assert.equal(docker("network", "create", net).status, 0);
  const fixture = join(EDGE_DIR, "..", "test", "fixtures", "edge-upstream.mjs");
  const stub = (alias: string, role: string, env: Record<string, string> = {}, tlsDir?: string) => {
    const name = `${net}-${alias}`;
    const r = docker("run", "-d", "--name", name, "--network", net, "--network-alias", alias, "-e", `ROLE=${role}`, "-e", `NAME=${alias}`, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-v", `${fixture}:/app/u.mjs:ro`, ...(tlsDir ? ["-v", `${join(root, ".infra", "certs", "local", tlsDir)}:/run/pso/tls:ro`] : []), "node:24-alpine", "node", "/app/u.mjs");
    assert.equal(r.status, 0, r.stderr); started.push(name); return name;
  };
  const gw = stub("gateway", "orchestrator", { PORT: "3000" }, "gateway");
  stub("fei-shop", "fei"); const admin = stub("fei-admin", "fei"); const idp = stub("idp", "idp", {}, "idp");
  const edgeName = `${net}-edge`;
  const e = docker("run", "-d", "--name", edgeName, "--network", net, "--network-alias", "edge", "--read-only", "--tmpfs", "/tmp:mode=1777", "--tmpfs", "/var/cache/nginx:mode=1777", "--tmpfs", "/var/run:mode=1777",
    "--user", "101:101", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "-p", "127.0.0.1::8443",
    "-v", `${join(root, ".infra", "nginx", "local", "edge.conf")}:/etc/nginx/conf.d/default.conf:ro`, "-v", `${join(root, ".infra", "certs", "local", "edge")}:/run/pso/tls:ro`, edgeImage().tag);
  assert.equal(e.status, 0, e.stderr); started.push(edgeName);
  const port = Number(/:(\d+)\s*$/m.exec(docker("port", edgeName, "8443/tcp").stdout)![1]);
  const resolve = Object.fromEntries(Object.keys(localResolution(t)).map((h) => [h, "127.0.0.1"]));
  const shop = t.frontends.find((f) => f.name === "fei-shop")!, adm = t.frontends.find((f) => f.name === "fei-admin")!;
  const url = (host: string, path: string, scheme = "https") => `${scheme}://${host}:${port}${path}`;
  const req = (u: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => netRequest({ url: u, ca, resolve, timeoutMs: 30_000, ...o });
  // a raw exchange over TLS (malformed requests, unknown names, upgrades): what a client that is not a well-behaved HTTP library sends
  const raw = (servername: string, payload: string, untilHeaders = false) => new Promise<string>((res) => {
    let b = "";
    const s = connect({ host: "127.0.0.1", port, servername, ca, rejectUnauthorized: false }, () => s.write(payload));
    const done = () => { s.destroy(); res(b); };
    s.on("data", (d) => { b += d.toString("latin1"); if (untilHeaders && b.includes("\r\n\r\n")) done(); });
    s.on("end", done); s.on("error", done); setTimeout(done, 15_000);
  });
  for (let i = 0; i < 60; i++) { try { if ((await req(url(t.api.host, "/health/ready"))).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const anonymous = (r: NetResponse | string, label: string) => {
    const head = typeof r === "string" ? r.slice(0, r.indexOf("\r\n\r\n")) : Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\n");
    const body = typeof r === "string" ? r.slice(r.indexOf("\r\n\r\n") + 4) : r.body.toString("utf8");
    assert.doesNotMatch(head, /^server:/im, `${label}: no Server header`);
    assert.doesNotMatch(head, /^x-powered-by:|^x-aspnet-version:/im, `${label}: no X-Powered-By`);
    return body;
  };
  const page = (r: NetResponse, code: number, label: string) => {
    assert.equal(r.status, code, `${label}: status ${code}`);
    assert.match(String(r.headers["content-type"]), /^text\/html; charset=utf-8$/, label);
    const body = anonymous(r, label);
    assert.match(body, new RegExp(`Error ${code}<`), `${label}: the edge's page`);
    assert.doesNotMatch(body.replace(/<style>[\s\S]*<\/style>/, ""), DISCLOSURE, `${label}: nothing identifying in the body`);
    assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/); assert.equal(r.headers["cache-control"], "no-store");
    assert.match(String(r.headers["x-correlation-id"]), /^[0-9a-f]{32}$/, `${label}: correlation id of the edge's log line`);
    assert.equal(r.headers["last-modified"], undefined); assert.equal(r.headers["etag"], undefined);
  };
  const problemDoc = (r: NetResponse, code: number, label: string) => {
    assert.equal(r.status, code, `${label}: status ${code}`);
    assert.equal(r.headers["content-type"], "application/problem+json", label);
    const j = JSON.parse(anonymous(r, label)) as { type: string; status: number };
    assert.equal(j.type, "about:blank"); assert.equal(j.status, code);
  };

  await tt.test("1-2. plain HTTP on the HTTPS port: 400, sanitized (browser page / problem document by route)", async () => {
    page(await req(url(shop.host, "/", "http")), 400, "plain HTTP to the shop");
    problemDoc(await req(url(t.api.host, "/products", "http")), 400, "plain HTTP to the API");
  });
  await tt.test("3. no Server or X-Powered-By on success, on the shells and from upstreams", async () => {
    const ok = await req(url(shop.host, "/?code=secret-authorization-code&state=s"));
    assert.equal(ok.status, 200); anonymous(ok, "shop shell"); assert.match(String(ok.headers["strict-transport-security"]), /max-age/);
    const pw = await req(url(t.api.host, "/powered"));
    assert.equal(pw.status, 200); anonymous(pw, "upstream with X-Powered-By, Server and X-AspNet-Version");
  });
  await tt.test("4. unknown host, malformed and oversized requests", async () => {
    const unknown = await raw("nowhere.example.test", "GET / HTTP/1.1\r\nHost: nowhere.example.test\r\nConnection: close\r\n\r\n");
    assert.match(unknown, /^HTTP\/1\.1 421 /); assert.doesNotMatch(anonymous(unknown, "unknown host").replace(/<style>[\s\S]*<\/style>/, ""), DISCLOSURE); assert.match(unknown, /Site not available/);
    const garbage = await raw(shop.host, "GARBAGE \u0001\r\n\r\n");
    assert.match(garbage, /^HTTP\/1\.1 400 /); assert.doesNotMatch(anonymous(garbage, "malformed request line").replace(/<style>[\s\S]*<\/style>/, ""), DISCLOSURE);
    const noHost = await raw(shop.host, "GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
    assert.match(noHost, /^HTTP\/1\.1 400 /); anonymous(noHost, "HTTP/1.1 without Host");
    const bigHeader = await raw(shop.host, `GET / HTTP/1.1\r\nHost: ${shop.host}\r\nCookie: ${"a".repeat(40_000)}\r\nConnection: close\r\n\r\n`);
    assert.match(bigHeader, /^HTTP\/1\.1 431 /, "494 is answered 431"); assert.doesNotMatch(anonymous(bigHeader, "oversized header").replace(/<style>[\s\S]*<\/style>/, ""), DISCLOSURE);
    const longUri = await req(url(shop.host, `/${"x".repeat(9000)}`));
    assert.equal(longUri.status, 414); anonymous(longUri, "URI too long");
    const direct = await req(url(shop.host, "/__edge_error__/html/404.html"));
    page(direct, 404, "the internal error location requested directly");
    const parent = await req(url(shop.host, "/__edge_error__/"));
    assert.equal(parent.status, 200); assert.match(parent.body.toString(), /shell fei-shop \/__edge_error__\//, "anything else under that name is an ordinary client route of the shell: no listing, nothing of the image");
    problemDoc(await req(url(t.api.host, "/__edge_error__/problem/500.json")), 404, "the problem directory from the API host");
  });
  await tt.test("5. authentication and authorization errors of the application pass unchanged", async () => {
    const r = await req(url(t.api.host, "/problem/401"));
    assert.equal(r.status, 401); assert.equal(r.headers["content-type"], "application/problem+json");
    assert.equal(r.headers["www-authenticate"], 'Bearer realm="api", error="invalid_token"'); assert.equal(r.headers["x-correlation-id"], "c-123");
    assert.equal(JSON.parse(anonymous(r, "upstream 401")).code, "APP_401", "the application's own document, not the edge's");
    const f = await req(url(shop.host, "/api/problem/403"));
    assert.equal(f.status, 403); assert.equal(JSON.parse(f.body.toString()).code, "APP_403", "same-origin API path");
    const denied = await req(url(shop.host, "/denied"));
    page(denied, 403, "a 403 of the shell's static server");
  });
  await tt.test("6. request size limit (edge) and rate limiting (application)", async () => {
    const big = await raw(t.api.host, `POST /products HTTP/1.1\r\nHost: ${t.api.host}\r\nContent-Type: application/json\r\nContent-Length: 30000000\r\nConnection: close\r\n\r\n`);
    assert.match(big, /^HTTP\/1\.1 413 /); assert.match(big, /content-type: application\/problem\+json/i); assert.match(big, /"status":413/); anonymous(big, "413 on the API");
    const bigShop = await raw(shop.host, `POST /api/products HTTP/1.1\r\nHost: ${shop.host}\r\nContent-Length: 30000000\r\nConnection: close\r\n\r\n`);
    assert.match(bigShop, /^HTTP\/1\.1 413 /); assert.match(bigShop, /application\/problem\+json/i, "the same-origin API answers programs");
    const lim = await req(url(t.api.host, "/limited"));
    assert.equal(lim.status, 429); assert.equal(lim.headers["retry-after"], "7"); assert.equal(JSON.parse(lim.body.toString()).code, "APP_429");
    const m = await req(url(t.api.host, "/method"), { method: "DELETE" });
    assert.equal(m.status, 405); assert.equal(m.headers["allow"], "GET, POST");
    const svc = await req(url(t.api.host, "/unavailable"));
    assert.equal(svc.status, 503); assert.equal(svc.headers["retry-after"], "3"); assert.equal(JSON.parse(svc.body.toString()).code, "APP_503", "an application 503 is never replaced");
    const crash = await req(url(t.api.host, "/crash"));
    assert.equal(crash.status, 500); assert.equal(JSON.parse(crash.body.toString()).code, "APP_500");
    const post = await req(url(shop.host, "/"), { method: "POST", body: "x" });
    page(post, 405, "POST to the shell");
  });
  await tt.test("9-12. SPA routes, assets of several shells, the identity provider", async () => {
    const route = await req(url(shop.host, "/catalog/products/42"));
    assert.equal(route.status, 200); assert.match(route.body.toString(), /shell fei-shop \/catalog\/products\/42/, "client routes reach the shell unchanged");
    page(await req(url(shop.host, "/fei/assets/missing.js")), 404, "a missing asset of shop");
    page(await req(url(adm.host, "/fei/assets/missing.js")), 404, "a missing asset of admin (the same protection for every FEI)");
    assert.equal((await req(url(adm.host, "/"))).status, 200);
    const disc = await req(url(t.identity!.host, "/realms/shop/.well-known/openid-configuration"));
    assert.equal(disc.status, 200); anonymous(disc, "identity discovery");
  });
  await tt.test("13. WebSocket upgrade through the edge", async () => {
    const up = await raw(shop.host, `GET /channels HTTP/1.1\r\nHost: ${shop.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Protocol: pso.channels.v1\r\n\r\n`, true);
    assert.match(up, /^HTTP\/1\.1 101 /); anonymous(up, "upgrade");
  });
  await tt.test("7-8. upstream timeout and unavailability; the pages need nothing but the edge", async () => {
    // the edge resolves upstream names per request but caches an answer for 10 s (resolver valid=10s): wait for it after each swap
    const expire = () => new Promise((r) => setTimeout(r, 11_500));
    docker("rm", "-f", gw);
    stub("gateway", "silent", { PORT: "3000" });
    await expire();
    const slow = await req(url(t.api.host, "/products"));
    problemDoc(slow, 504, "API, upstream does not answer");
    assert.ok(slow.timeMs < 15_000, `answered after the connect timeout (5 s), not the read timeout: ${slow.timeMs} ms`);
    docker("rm", "-f", `${net}-gateway`);
    await expire();
    problemDoc(await req(url(t.api.host, "/products")), 502, "API, orchestrator stopped");
    problemDoc(await req(url(shop.host, "/api/products")), 502, "same-origin API, orchestrator stopped");
    const ws = await raw(shop.host, `GET /channels HTTP/1.1\r\nHost: ${shop.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`, true);
    assert.match(ws, /^HTTP\/1\.1 502 /); assert.match(ws, /application\/problem\+json/i);
    docker("rm", "-f", admin, idp, `${net}-fei-shop`);
    await expire();
    page(await req(url(shop.host, "/")), 502, "shop, every application container stopped");
    page(await req(url(adm.host, "/orders")), 502, "admin, every application container stopped");
    page(await req(url(t.identity!.host, "/realms/shop/account")), 502, "identity provider stopped (browser)");
    problemDoc(await req(url(t.identity!.host, "/realms/shop/protocol/openid-connect/token"), { method: "POST", body: "grant_type=x" }), 502, "identity provider stopped (token endpoint)");
    page(await req(url(shop.host, "/", "http")), 400, "plain HTTP with everything stopped");
    const logs = docker("logs", edgeName);
    assert.match(logs.stderr + logs.stdout, /could not be resolved|connect\(\) failed|upstream timed out/, "the cause stays in the edge's own log");
    assert.match(logs.stdout, /"GET \/products HTTP\/1\.1" 50[24] .* id=[0-9a-f]{32}/, "access log: path, status and correlation id");
    assert.doesNotMatch(logs.stdout, /grant_type|secret-authorization-code/, "no query string or body in the log");
  });
  rmSync(root, { recursive: true, force: true });
});
