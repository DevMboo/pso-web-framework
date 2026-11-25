import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDeployment } from "@pso/deploy";
import { pso, tmp } from "./helpers.ts";

/** The frontend commands end to end on a generated workspace (no npm install): creation, registration, declaration for the native engine, nginx preview. */
async function workspace() {
  const base = tmp("pso-fe-cli-");
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const root = join(base, "shop");
  assert.equal((await pso(root, "create", "orchestrator", "shop-gateway", "--structure", "legacy")).code, 0);
  assert.equal((await pso(root, "create", "fei", "shop")).code, 0);
  assert.equal((await pso(root, "create", "mei", "customers", "--register")).code, 0);
  return root;
}
const declared = (file: string): unknown => JSON.parse(/defineDeployment\((\{[\s\S]*\})\);/.exec(readFileSync(file, "utf8"))![1]!);

test("frontend:declare writes a valid static deployment declaration for a shell and for a microfrontend, and refuses unsafe or incomplete input", async () => {
  const root = await workspace();
  const fei = await pso(root, "frontend:declare", "fei-shop", "--connection", "azure", "--base-path", "/shop/", "--api-port", "3000", "--probe-port", "8080", "--domain", "shop.example.com");
  assert.equal(fei.code, 0, fei.err + fei.out);
  const f = declared(join(root, "deploy", "shop-fei.deployment.pso.ts")) as { name: string; strategy: { type: string; proxy: string }; proxy: { nginx: { domains: string[] } }; services: Array<{ runtime: string; static: { kind: string; basePath: string; api: { upstreamPort: number } } }>; connection: { credentials: string } };
  assert.equal(f.name, "shop-fei"); assert.deepEqual(f.strategy, { type: "static", proxy: "nginx" }); assert.equal(f.services[0]!.static.basePath, "/shop/"); assert.equal(f.services[0]!.static.api.upstreamPort, 3000);
  assert.deepEqual(f.proxy.nginx.domains, ["shop.example.com"]); assert.equal(f.connection.credentials, "azure", "only the NAME of a connection is written");
  assert.deepEqual(validateDeployment(f).filter((d) => d.level === "error"), [], "the engine's own validator accepts it");

  const mei = await pso(root, "frontend:declare", "customers", "--connection", "azure", "--probe-port", "8080", "--retain", "7");
  assert.equal(mei.code, 0, mei.err + mei.out);
  const m = declared(join(root, "deploy", "shop-customers.deployment.pso.ts")) as { strategy: { proxy: string }; proxy?: unknown; services: Array<{ static: { kind: string; retain: number; probe: { port: number } } }> };
  assert.equal(m.strategy.proxy, "none"); assert.equal(m.proxy, undefined, "a microfrontend declaration has no nginx section"); assert.equal(m.services[0]!.static.retain, 7);
  assert.deepEqual(validateDeployment(m).filter((d) => d.level === "error"), []);
  assert.ok(!readFileSync(join(root, "deploy", "shop-fei.deployment.pso.ts"), "utf8").match(/password|secret|token\s*:/i), "no credential material");

  // refusals: nothing is written
  const before = existsSync(join(root, "deploy", "shop-orders.deployment.pso.ts"));
  assert.notEqual((await pso(root, "frontend:declare", "fei-shop", "--connection", "azure")).code, 0, "a shell needs --api-port");
  assert.notEqual((await pso(root, "frontend:declare", "fei-shop", "--connection", "azure", "--api-port", "3000", "--base-path", "shop")).code, 0, "a base path is absolute");
  assert.notEqual((await pso(root, "frontend:declare", "customers")).code, 0, "a connection is required");
  assert.notEqual((await pso(root, "frontend:declare", "customers", "--connection", "azure", "--retain", "1")).code, 0, "retain is at least 2");
  assert.notEqual((await pso(root, "frontend:declare", "nope", "--connection", "azure")).code, 0, "unknown project");
  assert.notEqual((await pso(root, "frontend:declare", "customers", "--connection", "azure", "--bogus", "x")).code, 0, "unknown flags are errors");
  assert.equal(existsSync(join(root, "deploy", "shop-orders.deployment.pso.ts")), before);
  // an existing declaration is not overwritten silently
  writeFileSync(join(root, "deploy", "shop-customers.deployment.pso.ts"), "// edited by hand\n");
  const again = await pso(root, "frontend:declare", "customers", "--connection", "azure");
  assert.notEqual(again.code, 0); assert.equal(readFileSync(join(root, "deploy", "shop-customers.deployment.pso.ts"), "utf8"), "// edited by hand\n");
});

test("frontend:nginx previews the same locations the managed adapter generates and refuses unsafe options", async () => {
  const root = await workspace();
  const r = await pso(root, "frontend:nginx", "--site", "/srv/pso/sites/shop", "--base-path", "/shop/", "--api", "/api", "--api-port", "3000");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /location \^~ \/shop\/assets\//); assert.match(r.out, /location \^~ \/_mei\//); assert.match(r.out, /return 404;/); assert.match(r.out, /script-src 'self'/);
  assert.notEqual((await pso(root, "frontend:nginx", "--site", "/srv/pso/sites/shop", "--api", "/_mei")).code, 0);
  assert.notEqual((await pso(root, "frontend:nginx", "--site", "/srv/pso/sites/shop", "--base-path", "/x")).code, 0);
  // dotted identifiers are routes; declared routes win over file extensions; the identity provider's origin is allowed in connect-src
  const d = await pso(root, "frontend:nginx", "--site", "/srv/pso/sites/shop", "--base-path", "/shop/", "--route", "/catalog/sku/:id,/files/*", "--connect-src", "https://idp.example.com");
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /location ~ "\^\/shop\/catalog\/sku\/\[\^\/\]\+\/\?\$"/); assert.match(d.out, /connect-src 'self' https:\/\/idp\.example\.com;/);
  assert.doesNotMatch(d.out, /\{1,8\}/, "the old extension-length rule is gone");
  assert.notEqual((await pso(root, "frontend:nginx", "--site", "/srv/pso/sites/shop", "--base-path", "/shop/", "--route", "/a/../b")).code, 0);
  assert.notEqual((await pso(root, "frontend:nginx", "--site", "/srv/pso/sites/shop", "--base-path", "/shop/", "--connect-src", "http://evil.example.com")).code, 0, "plain http is accepted only for localhost");
});

test("a built shell carries its own release manifest: frontend:build writes pso-fei.json (shell) and pso-manifest.json (microfrontend) next to the output", async () => {
  // the build itself needs installed dependencies (covered by the browser runs); here the manifest writers are checked on a prepared dist
  const { buildFeiManifest } = await import("@pso/frontend/node");
  const dir = tmp("pso-fei-m-"); const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "dist", "assets"), { recursive: true }); writeFileSync(join(dir, "dist", "index.html"), "<html/>"); writeFileSync(join(dir, "dist", "assets", "main-abc.js"), "x");
  const rel = buildFeiManifest({ dir, definition: { name: "fei-x", orchestrator: { service: "g" }, microfrontends: [{ name: "mei-a", path: "/a" }] }, version: "1.2.3", basePath: "/x/" });
  assert.equal(rel.version, "1.2.3"); assert.deepEqual(rel.mounts, [{ name: "mei-a", path: "/a" }]); assert.deepEqual(rel.files.map((f) => f.path).sort(), ["assets/main-abc.js", "index.html"]);
  assert.ok(existsSync(join(dir, "dist", "pso-fei.json")));
});

test("frontend:declare for a shell that joins an existing server: attach target, runtime configuration, trusted release signers; the engine's validator accepts it and unsafe input is refused", async () => {
  const root = await workspace();
  const key = "A".repeat(43);
  const r = await pso(root, "frontend:declare", "fei-shop", "--connection", "azure", "--base-path", "/commerce/", "--attach-to", "shop-gateway", "--probe-port", "20003", "--orchestrator-path", "/", "--auth", "dev-token", "--require-signature", "--trust-key", `release-1=${key}`);
  assert.equal(r.code, 0, r.err + r.out);
  const d = declared(join(root, "deploy", "shop-fei.deployment.pso.ts")) as { proxy: { nginx: Record<string, unknown> }; services: Array<{ static: { api?: unknown; runtimeConfig: { orchestratorBasePath: string; requireSignature: boolean; trustedKeys: unknown[]; auth: { kind: string } } } }> };
  assert.deepEqual(d.proxy.nginx, { attachTo: "shop-gateway" }); assert.equal(d.services[0]!.static.api, undefined);
  assert.deepEqual([d.services[0]!.static.runtimeConfig.orchestratorBasePath, d.services[0]!.static.runtimeConfig.requireSignature, d.services[0]!.static.runtimeConfig.auth.kind], ["/", true, "dev-token"]);
  assert.deepEqual(validateDeployment(d as never).filter((x) => x.level === "error"), []);
  assert.ok(!readFileSync(join(root, "deploy", "shop-fei.deployment.pso.ts"), "utf8").match(/password|secret|token\s*:/i), "no credential material (only a public key)");
  const bad = async (...a: string[]) => assert.notEqual((await pso(root, "frontend:declare", "fei-shop", "--connection", "azure", "--force", "--base-path", "/commerce/", ...a)).code, 0, a.join(" "));
  await bad("--attach-to", "shop-gateway", "--api-port", "3000"); await bad("--attach-to", "../x"); await bad("--api-port", "3000", "--auth", "magic"); await bad("--api-port", "3000", "--auth", "oidc");
  await bad("--api-port", "3000", "--trust-key", "nokey"); await bad("--api-port", "3000", "--orchestrator-path", "https://evil.example");
  assert.notEqual((await pso(root, "frontend:declare", "customers", "--connection", "azure", "--auth", "none")).code, 0, "runtime configuration belongs to the shell");
});
