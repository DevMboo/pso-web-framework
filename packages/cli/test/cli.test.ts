import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { run } from "../src/main.ts";
import { linkModules } from "./helpers.ts";

async function pso(cwd: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await run(argv, cwd, (s) => { out += s + "\n"; }, (s) => { err += s + "\n"; });
  return { code, out, err };
}
const tmp = () => mkdtempSync(join(tmpdir(), "pso-cli-"));
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

test("create workspace/orchestrator/service wires ports and passes validate", async () => {
  const base = tmp();
  try {
    assert.equal((await pso(base, "create", "workspace", "demo")).code, 0);
    const ws = join(base, "demo");
    assert.equal((await pso(ws, "create", "service", "users", "--structure", "legacy")).code, 0);
    assert.equal((await pso(ws, "create", "service", "orders", "--structure", "legacy")).code, 0);
    assert.equal((await pso(ws, "create", "orchestrator", "gateway", "--structure", "legacy")).code, 0);
    const cfg = JSON.parse(read(ws, "pso.workspace.json"));
    assert.deepEqual(cfg.services.map((s: { name: string; port: number }) => [s.name, s.port]), [["users", 8081], ["orders", 8082], ["gateway", 3000]]);
    assert.ok(existsSync(join(ws, "users/src/main/java/com/pso/users/Application.java")));
    assert.ok(existsSync(join(ws, "gateway/src/main.ts")) && existsSync(join(ws, "gateway/src/guards/jwt.guard.ts")), "orchestrator scaffold");
    assert.ok(!existsSync(join(ws, "gateway/src/routes/ping.route.ts")), "no legacy implicit route is generated");
    const v = await pso(ws, "validate", "--json");
    assert.equal(v.code, 0, v.out + v.err);
    assert.equal(JSON.parse(v.out).ok, true);
    // a second orchestrator is refused
    assert.equal((await pso(ws, "create", "orchestrator", "gw2", "--structure", "legacy")).code, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("generation is idempotent, never silently overwrites, supports dry-run", async () => {
  const base = tmp();
  try {
    await pso(base, "create", "workspace", "w");
    const ws = join(base, "w");
    await pso(ws, "create", "orchestrator", "gw", "--structure", "legacy");
    const dry = await pso(ws, "make:guard", "authenticated", "--service", "gw", "--dry-run", "--json");
    assert.equal(dry.code, 0);
    assert.ok(!existsSync(join(ws, "gw/src/guards/authenticated.guard.ts")), "dry-run writes nothing");
    assert.equal((await pso(ws, "make:guard", "authenticated", "--service", "gw")).code, 0);
    const again = await pso(ws, "make:guard", "authenticated", "--service", "gw", "--json");
    assert.equal(again.code, 0);
    assert.equal(JSON.parse(again.out).files[0].action, "unchanged");
    const f = join(ws, "gw/src/guards/authenticated.guard.ts");
    writeFileSync(f, "// user code\n");
    const conflict = await pso(ws, "make:guard", "authenticated", "--service", "gw");
    assert.equal(conflict.code, 1);
    assert.equal(read(f), "// user code\n", "user code preserved");
    assert.equal((await pso(ws, "make:guard", "authenticated", "--service", "gw", "--force")).code, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("hostile names, routes and paths are rejected before touching the filesystem", async () => {
  const base = tmp();
  try {
    await pso(base, "create", "workspace", "w");
    const ws = join(base, "w");
    await pso(ws, "create", "orchestrator", "gw", "--structure", "legacy");
    for (const bad of ["../evil", "a/b", "A_B", "..", "x y"]) {
      const r = await pso(ws, "make:route", bad, "--service", "gw");
      assert.equal(r.code, 1, `name ${bad}`);
    }
    // make:route takes --path; --route was never one of its flags and used to be ignored without a word (F-02): it is a usage error now
    assert.equal((await pso(ws, "make:route", "ok", "--service", "gw", "--route", "/a/../../x?y")).code, 2);
    assert.equal((await pso(ws, "make:module", "ok", "--service", "gw")).code, 0);
    assert.equal((await pso(ws, "make:controller", "ok", "--service", "gw")).code, 0);
    for (const hostile of ["/a/../../x?y", "/a/../b", "//x", "/x y", "/a\\b"]) {
      const r = await pso(ws, "make:route", "ok", "list", "--method", "GET", "--path", hostile, "--service", "gw");
      assert.equal(r.code, 1, `path ${hostile}: ${r.out}${r.err}`);
    }
    assert.ok(!/action: "list"/.test(readFileSync(join(ws, "gw/src/routes/ok/ROUTES.pso.ts"), "utf8")), "no hostile path was declared");
    assert.equal((await pso(ws, "create", "service", "../escape", "--structure", "legacy")).code, 1);
    assert.ok(!existsSync(join(base, "escape")));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("spring make:* uses the service package and passes validate", async () => {
  const base = tmp();
  try {
    await pso(base, "create", "workspace", "w");
    const ws = join(base, "w");
    await pso(ws, "create", "service", "users", "--structure", "legacy");
    assert.equal((await pso(ws, "make:controller", "customer", "--service", "users", "--route", "/customers")).code, 0);
    assert.equal((await pso(ws, "make:dto", "customer-request", "--service", "users")).code, 0);
    const c = read(ws, "users/src/main/java/com/pso/users/routes/CustomerController.java");
    assert.match(c, /^package com\.pso\.users\.routes;/);
    assert.match(c, /@RequestMapping\("\/customers"\)/);
    assert.ok(existsSync(join(ws, "users/src/main/java/com/pso/users/contracts/CustomerRequestDto.java")));
    assert.equal((await pso(ws, "validate")).code, 0);
    const routeInSpring = await pso(ws, "make:route", "x", "--service", "users");
    assert.equal(routeInSpring.code, 1, "route kind is not a Spring kind");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("validate fails with actionable diagnostics (port conflict, misplaced file)", async () => {
  const base = tmp();
  try {
    await pso(base, "create", "workspace", "w");
    const ws = join(base, "w");
    await pso(ws, "create", "orchestrator", "gw", "--structure", "legacy");
    mkdirSync(join(ws, "gw/src/wrong"), { recursive: true });
    writeFileSync(join(ws, "gw/src/wrong/a.route.ts"), "");
    const cfg = JSON.parse(read(ws, "pso.workspace.json"));
    cfg.services.push({ name: "b", path: "gw", runtime: "node", port: 3000 });
    writeFileSync(join(ws, "pso.workspace.json"), JSON.stringify(cfg));
    const v = await pso(ws, "validate", "--json");
    assert.equal(v.code, 1);
    assert.ok(JSON.parse(v.out).diagnostics.some((d: { code: string }) => d.code === "PSO_PORT_CONFLICT"));
    const v2 = await pso(ws, "validate");
    assert.match(v2.out, /PSO_PORT_CONFLICT/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("unimplemented commands fail loudly and unknown commands are reported", async () => {
  const r = await pso(tmp(), "dispatch:health");
  assert.equal(r.code, 2);
  assert.match(r.err, /not implemented/);
  assert.equal((await pso(tmp(), "nope")).code, 2);
});
