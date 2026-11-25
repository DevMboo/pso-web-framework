import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const doc = (id: string) => readFileSync(resolve(import.meta.dirname, "..", "docs", id + ".md"), "utf8").replaceAll("\r\n", "\n");

/** "Deterministic manifests" and "Structural discovery": the claims are reproduced on a generated workspace. */
test("the manifest is byte-identical across runs, changes with the structure and returns when the structure returns; inspect lists what was found", { timeout: 120_000 }, async () => {
  const base = tmp("pso-manifest-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "shop")).code, 0);
  const ws = join(base, "shop");
  assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--template", "empty")).code, 0);
  assert.equal((await pso(ws, "create", "service", "catalog", "--template", "empty")).code, 0);
  for (const a of [["make:module", "product"], ["make:controller", "product"]]) assert.equal((await pso(ws, ...a, "--service", "gateway")).code, 0);
  assert.equal((await pso(ws, "make:route", "product", "findAll", "--method", "GET", "--path", "/", "--guard", "jwt", "--scopes", "products:read", "--upstream", "catalog", "--service", "gateway")).code, 0);

  const manifest = join(ws, "gateway/.pso/manifest.json");
  const hash = () => createHash("sha256").update(readFileSync(manifest)).digest("hex");
  const digest = (out: string) => /gateway: (\d+) resource\(s\), digest ([0-9a-f]{12})/.exec(out)!;
  const first = await pso(ws, "validate", "--write-manifest");
  const h1 = hash(), d1 = digest(first.out);
  const second = await pso(ws, "validate", "--write-manifest");
  assert.equal(hash(), h1, "two runs with nothing changed produce the same file");
  assert.equal(digest(second.out)[2], d1[2]);
  const doc1 = JSON.parse(readFileSync(manifest, "utf8")) as { resources: Array<{ key: string }>; digest: string };
  assert.ok(doc1.digest.startsWith(d1[2]!), "the printed digest is the start of the manifest digest");
  assert.equal(JSON.stringify(doc1).includes(base.replaceAll("\\", "\\\\")), false, "no absolute path in the manifest");
  assert.deepEqual(doc1.resources.map((r) => r.key), [...doc1.resources.map((r) => r.key)].sort(), "resources are sorted");

  assert.equal((await pso(ws, "make:module", "extra", "--service", "gateway")).code, 0);
  assert.equal((await pso(ws, "make:controller", "extra", "--service", "gateway")).code, 0);
  const changed = await pso(ws, "validate", "--write-manifest");
  assert.notEqual(digest(changed.out)[2], d1[2], "adding a module and a controller changes the digest");
  rmSync(join(ws, "gateway/src/modules/extra"), { recursive: true, force: true });
  assert.equal(digest((await pso(ws, "validate", "--write-manifest")).out)[2], d1[2], "removing them returns the original digest");
  assert.ok(doc("concepts/deterministic-manifests").includes("gateway: 4 resource(s), digest " + d1[2]), "the page shows this digest");

  const inspectGateway = (await pso(ws, "inspect", "--service", "gateway")).out;
  assert.match(inspectGateway, /^guard {7}jwt {26}src\/\.app\/guards\/jwt\.guard\.ts$/m);
  const inspectCatalog = (await pso(ws, "inspect", "--service", "catalog")).out;
  for (const l of ["exception   ConflictException            src/main/java/com/pso/catalog/shared/exception/ConflictException.java", "exception   ResourceNotFoundException    src/main/java/com/pso/catalog/shared/exception/ResourceNotFoundException.java"]) {
    assert.ok(inspectCatalog.includes(l), `inspect prints ${l}`);
    assert.ok(doc("concepts/structural-discovery").includes(l), `the page shows ${l}`);
  }
  assert.ok(doc("concepts/deterministic-manifests").includes('"kind": "route-registry"'));
});
