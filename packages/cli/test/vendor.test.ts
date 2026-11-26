import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frameworkSpecs } from "../src/specs.ts";
import { isMachineBound, machineBoundDeps, vendorFramework, inspectNodeVendor } from "../src/vendor.ts";
import { PSO_JAVA_VERSION } from "../src/specs.ts";
import { pso, tmp, startNode, unusedPort } from "./helpers.ts";

/**
 * Artifact portability: a generated orchestrator must be buildable and runnable WITHOUT the machine that generated it. The proof is
 * done the way another machine would experience it: the project is copied elsewhere with no node_modules, installed from what the
 * project itself carries (plus the public registry for third-party packages), compiled and started.
 */
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const npm = (cwd: string, ...args: string[]) => spawnSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32", timeout: 280_000 });
const json = (file: string): { dependencies: Record<string, string> } => JSON.parse(readFileSync(file, "utf8")) as { dependencies: Record<string, string> };

async function workspace(): Promise<{ root: string; gw: string }> {
  const base = tmp("pso-vendor-"); dirs.push(base);
  await pso(base, "create", "workspace", "w", "--layout", "flat");
  const root = join(base, "w");
  assert.equal((await pso(root, "create", "orchestrator", "gw", "--structure", "legacy")).code, 0);
  return { root, gw: join(root, "gw") };
}

test("what makes a dependency machine-bound", () => {
  for (const s of ["file:D:/work/pso/packages/core", "file:d:\\x\\core", "file:/home/dev/pso/packages/core", "file:~/pso/core"]) assert.equal(isMachineBound(s), true, s);
  for (const s of ["file:vendor/pso/pso-core-0.1.0.tgz", "file:./vendor/pso/pso-core-0.1.0.tgz", "^0.1.0", "0.1.0", "npm:@scope/x@1"]) assert.equal(isMachineBound(s), false, s);
});

test("vendoring drops a lock file that links the framework packages by a path outside the project (npm link format), keeps a portable one", { timeout: 300_000 }, async () => {
  const { gw } = await workspace();
  const lock = (resolved: string) => JSON.stringify({ name: "gw", lockfileVersion: 3, packages: { "node_modules/@pso/core": { resolved, link: true } } }, null, 2);
  // what `npm install` writes for "@pso/core": "file:../../cli/node_modules/@pso/core": a bare relative path, no file: prefix
  writeFileSync(join(gw, "package-lock.json"), lock("../../cli/node_modules/@pso/core"));
  const r = vendorFramework(gw);
  assert.ok(!existsSync(join(gw, "package-lock.json")), "the machine-bound lock is removed");
  assert.ok(r.changed.some((c) => c.startsWith("package-lock.json: removed")), r.changed.join("; "));
  // a lock that only points inside the project (the vendored tarballs) is kept
  writeFileSync(join(gw, "package-lock.json"), lock("file:vendor/pso/pso-core-0.2.0.tgz"));
  vendorFramework(gw);
  assert.ok(existsSync(join(gw, "package-lock.json")), "a portable lock is kept");
});

test("docker:init without --vendor is unchanged and now SAYS when the project cannot be built elsewhere", async () => {
  const { root, gw } = await workspace();
  const before = readFileSync(join(gw, "package.json"), "utf8");
  const local = frameworkSpecs().coreSpec.startsWith("file:"); // a framework checkout: the development workflow under test
  const r = await pso(root, "docker:init", "--json");
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out) as { notPortable: Array<{ service: string; dependencies: string[] }>; vendored: unknown[] };
  assert.equal(readFileSync(join(gw, "package.json"), "utf8"), before, "package.json is not touched");
  assert.deepEqual(out.vendored, []);
  const dockerfile = readFileSync(join(gw, "Dockerfile"), "utf8");
  assert.match(dockerfile, /# NOTE: @pso\/core and @pso\/http must be installable from a registry \(or vendored\) inside the build context\./);
  assert.ok(!dockerfile.includes("COPY vendor"), "the generated Dockerfile is exactly what it was");
  if (local) {
    assert.deepEqual(out.notPortable, [{ service: "gw", dependencies: ["@pso/core", "@pso/http", "@pso/security"] }]);
    const text = (await pso(root, "docker:init", "--force")).out;
    assert.match(text, /WARNING\s+gw: @pso\/core, @pso\/http, @pso\/security resolve to a path on THIS machine; .*Run `pso docker:init --vendor --force`/);
    assert.deepEqual(machineBoundDeps(gw).map(([n]) => n), ["@pso/core", "@pso/http", "@pso/security"]);
  }
});

test("docker:init --vendor: the project carries its framework packages, nothing points at this machine, and it runs from a clean copy", { timeout: 600_000 }, async () => {
  const { root, gw } = await workspace();
  // a dry run changes nothing and shows the plan
  const plan = JSON.parse((await pso(root, "docker:init", "--vendor", "--dry-run", "--json")).out) as { vendored: Array<{ packages: Array<{ name: string; file: string }>; changed: string[] }> };
  assert.deepEqual(plan.vendored[0]!.packages.map((p) => p.name), ["@pso/core", "@pso/http", "@pso/security"]);
  assert.ok(!existsSync(join(gw, "vendor")), "dry run writes nothing");

  const r = await pso(root, "docker:init", "--vendor", "--json");
  assert.equal(r.code, 0, r.out + r.err);
  const version = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "core", "package.json"), "utf8")) as { version: string }).version;
  assert.deepEqual(json(join(gw, "package.json")).dependencies, {
    "@pso/core": `file:vendor/pso/pso-core-${version}.tgz`, "@pso/http": `file:vendor/pso/pso-http-${version}.tgz`, "@pso/security": `file:vendor/pso/pso-security-${version}.tgz`, "reflect-metadata": "^0.2.2",
  }, "framework packages are relative tarballs with the framework's own version; third-party specs are untouched");
  assert.deepEqual(readdirSync(join(gw, "vendor", "pso")).sort(), [`pso-core-${version}.tgz`, `pso-http-${version}.tgz`, `pso-security-${version}.tgz`, "pso-vendor.json"]);
  // the manifest names the framework release and the SHA-256 of every tarball (0.2.0 release candidates share the npm version 0.2.0)
  const manifest = json(join(gw, "vendor", "pso", "pso-vendor.json")) as unknown as { kind: string; version: string; files: Record<string, string> };
  assert.equal(manifest.kind, "npm");
  assert.equal(manifest.version, PSO_JAVA_VERSION);
  assert.deepEqual(Object.keys(manifest.files).sort(), [`pso-core-${version}.tgz`, `pso-http-${version}.tgz`, `pso-security-${version}.tgz`]);
  assert.equal(inspectNodeVendor(gw).state, "current");
  assert.deepEqual(machineBoundDeps(gw), []);
  assert.ok(!/[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(readFileSync(join(gw, "package.json"), "utf8")), "no absolute path is left in package.json");
  assert.match(readFileSync(join(gw, "Dockerfile"), "utf8"), /COPY package\*\.json \.\/\nCOPY vendor \.\/vendor\nRUN npm install/, "the image build copies the vendored packages before installing");
  // idempotent
  const again = JSON.parse((await pso(root, "docker:init", "--vendor", "--force", "--json")).out) as { vendored: Array<{ changed: string[] }> };
  assert.deepEqual(again.vendored[0]!.changed, []);

  // ---- "another machine": only the project directory travels (no node_modules, no workspace, no PSO checkout on any path it knows)
  const elsewhere = join(tmp("pso-elsewhere-"), "gw"); dirs.push(join(elsewhere, ".."));
  cpSync(gw, elsewhere, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(src) });
  const install = npm(elsewhere, "install", "--no-audit", "--no-fund");
  assert.equal(install.status, 0, `npm install from the vendored tarballs failed:\n${install.stderr}`);
  for (const p of ["core", "http", "security"]) {
    const dir = join(elsewhere, "node_modules", "@pso", p);
    assert.equal(lstatSync(dir).isSymbolicLink(), false, `@pso/${p} is a real installed copy, not a link to a checkout`);
    assert.ok(realpathSync(dir).startsWith(realpathSync(elsewhere)), `@pso/${p} lives inside the project`);
    assert.ok(existsSync(join(dir, "dist", "index.js")));
  }
  const lock = readFileSync(join(elsewhere, "package-lock.json"), "utf8");
  assert.match(lock, /"resolved": "file:vendor\/pso\/pso-http-/);
  assert.ok(!/"resolved": "file:([A-Za-z]:|\/)/.test(lock), "the lock file is portable too: it can be committed and used by CI");
  const build = npm(elsewhere, "run", "build");
  assert.equal(build.status, 0, `the copied project does not compile:\n${build.stdout}${build.stderr}`);
  const port = await unusedPort();
  const { child, logs } = await startNode(elsewhere, { PORT: String(port) });
  try {
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(ready.status, 200, logs());
    assert.deepEqual(await ready.json(), { status: "UP", upstreams: 0 });
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
  } finally { child.kill("SIGKILL"); }
});

test("vendoring follows the framework's own dependencies, and a missing artifact is named with what to do", async () => {
  const { gw } = await workspace();
  const file = join(gw, "package.json");
  const pkg = json(file);
  writeFileSync(file, JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "@pso/channels": frameworkSpecs().channelsSpec, "@pso/dispatch": frameworkSpecs().dispatchSpec } }, null, 2));
  const plan = vendorFramework(gw, { dryRun: true });
  assert.deepEqual(plan.packages.map((p) => p.name), ["@pso/channels", "@pso/channels-client", "@pso/core", "@pso/dispatch", "@pso/http", "@pso/security"], "every @pso/* package a vendored package needs is vendored with it");
  assert.ok(plan.changed.some((c) => /@pso\/channels-client: \(added: required by a framework package\)/.test(c)));

  writeFileSync(file, JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "@pso/ghost": "file:D:/nowhere/ghost" } }, null, 2));
  assert.throws(() => vendorFramework(gw), (e: Error & { hint?: string }) => /The framework package @pso\/ghost \(needed by gw\) was not found, built, next to this CLI/.test(e.message) && /npm run build|pso repair/.test(String(e.hint ?? e.message)));
  assert.ok(!existsSync(join(gw, "vendor")), "nothing is half-written when an artifact is missing");
});
