import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedNginxRoots, assertSafeLayout, assertSafeWriteTarget, applyProxy, targetFor } from "../src/agent/nginx.ts";

/** nginx management stays inside what PSO owns: no path traversal, no write through a symlink, no adoption of someone else's enabled site. */
const policy = (managed: string) => ({ nginxManagedDir: managed, nginxLayout: "pso.d" as const, nginxPrivilege: "direct" as const });
const posixOnly = process.platform === "win32" && "symlink/real-path behaviour is checked on Linux (the suite runs it in a Linux container)";

test("a layout from a declaration must be an absolute path without dot segments, inside an allowed root", () => {
  const p = policy("/etc/nginx/pso.d");
  for (const ok of ["/etc/nginx/conf.d", "/etc/nginx/pso.d", "/etc/nginx/conf.d/", "/etc/nginx/pso.d/team-a"]) assert.doesNotThrow(() => assertSafeLayout(ok, p), ok);
  for (const bad of ["/etc/nginx/../../tmp", "/etc/nginx/conf.d/../../../root", "/tmp", "/srv/anywhere", "/etc/nginx", "/etc/nginx/conf.dx", "etc/nginx/conf.d", "/etc/nginx/./conf.d", "/etc/cron.d"]) assert.throws(() => assertSafeLayout(bad, p), /not acceptable|outside the directories/, bad);
  assert.throws(() => targetFor(p, "app", "/etc/nginx/../../tmp"), /not acceptable/); assert.equal(targetFor(p, "shop", "/etc/nginx/conf.d").file, "/etc/nginx/conf.d/pso-shop.conf");
  assert.ok(allowedNginxRoots(p).includes("/etc/nginx/pso.d"));
});

test("PSO refuses to write through a symlinked file or a directory that resolves outside the managed roots", { skip: posixOnly }, () => {
  const base = mkdtempSync(join(tmpdir(), "pso-ngx-")); const managed = join(base, "pso.d"); const outside = join(base, "outside"); mkdirSync(managed); mkdirSync(outside);
  const p = policy(managed);
  assert.equal(assertSafeWriteTarget({ file: join(managed, "pso-a.conf") }, p), undefined, "a plain file inside the managed directory is fine");
  writeFileSync(join(outside, "victim.conf"), "# not ours\n"); symlinkSync(join(outside, "victim.conf"), join(managed, "pso-b.conf"));
  assert.match(assertSafeWriteTarget({ file: join(managed, "pso-b.conf") }, p)!, /symbolic link/);
  const res = applyProxy(join(base, "home"), p, { file: join(managed, "pso-b.conf") }, "b", "# Managed by PSO Web (app=b)\nserver {}\n", "d1"); assert.match(res.error ?? "", /symbolic link/); assert.equal(readFileSync(join(outside, "victim.conf"), "utf8"), "# not ours\n", "the file behind the link was not touched");
  symlinkSync(outside, join(managed, "sub")); assert.match(assertSafeWriteTarget({ file: join(managed, "sub", "pso-c.conf") }, p)!, /outside the directories PSO may manage/);
});

test("an existing sites-enabled entry must be the link to OUR file: a regular file or a link elsewhere is somebody else's", { skip: posixOnly }, () => {
  const base = mkdtempSync(join(tmpdir(), "pso-ngx2-")); const managed = join(base, "pso.d"); mkdirSync(managed);
  const p = policy(managed); const file = join(managed, "pso-a.conf"); const link = join(managed, "pso-a.enabled");
  writeFileSync(link, "# a regular file where the link should be\n"); assert.match(assertSafeWriteTarget({ file, link }, p)!, /not a symbolic link/);
  const other = join(managed, "pso-a.enabled2"); writeFileSync(join(managed, "elsewhere.conf"), "x"); symlinkSync(join(managed, "elsewhere.conf"), other); assert.match(assertSafeWriteTarget({ file, link: other }, p)!, /not to .*pso-a\.conf/);
  const good = join(managed, "pso-a.enabled3"); symlinkSync(file, good); assert.equal(assertSafeWriteTarget({ file, link: good }, p), undefined);
});

test("values that are written into an nginx file cannot carry directives: tls paths and route paths are validated in the declaration", async () => {
  const { validateDeployment } = await import("../src/declare.ts");
  const base = (over: Record<string, unknown>, route = "/") => ({ name: "app", environment: "testing", connection: { provider: "ssh", credentials: "c" }, source: { provider: "git", url: "file:///x.git", branch: "main" }, service: { name: "web", runtime: "node", start: ["node", "a.js"], port: 21777, shutdownGraceSeconds: 5, route: { path: route } }, strategy: { type: "recreate", proxy: "none", downtimeAcknowledged: true }, proxy: { nginx: over } });
  const errs = (d: unknown) => validateDeployment(d).filter((x) => x.level === "error").map((x) => x.code);
  assert.deepEqual(errs(base({ tls: { certificate: "/etc/ssl/a.pem", key: "/etc/ssl/a.key" }, listen: { https: 443 } })), []);
  for (const bad of ["/etc/ssl/a.pem; include /etc/passwd", "/etc/ssl/a.pem\nroot /;", "/etc/ssl/../../x", "relative.pem", "/etc/ssl/a b.pem", "/etc/ssl/a.pem}"]) assert.ok(errs(base({ tls: { certificate: bad, key: "/etc/ssl/a.key" } })).includes("PSO-DEC-NGINX"), JSON.stringify(bad));
  for (const bad of ["/x { proxy_pass http://evil; }", "/x;", "x", "/a/../b", "/x y", "/x\n"]) assert.ok(errs(base({}, bad)).includes("PSO-DEC-ROUTE"), JSON.stringify(bad));
  assert.deepEqual(errs(base({}, "/api/v1/shop-items_2")), []);
});
