import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pso, tmp } from "./helpers.ts";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };

test("pso --version and pso -v print the package version and exit 0; help is unchanged", async () => {
  for (const flag of ["--version", "-v"]) {
    const r = await pso(tmp(), flag);
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), pkg.version, `${flag} prints the version of package.json`);
  }
  const help = await pso(tmp());
  assert.equal(help.code, 0);
  assert.match(help.out, /^PSO CLI \(Path Structure Working\)/);
  assert.equal((await pso(tmp(), "help")).out, help.out);
  assert.equal((await pso(tmp(), "--help")).out, help.out, "--help still prints the help");
  const unknown = await pso(tmp(), "nonsense");
  assert.equal(unknown.code, 2, "unknown commands still fail");
  assert.doesNotMatch((await pso(tmp(), "doctor", "--json")).out, /^0\.\d/, "a flag after a command is not treated as a version request");
});

test("the installed binary prints the same version", () => {
  const r = spawnSync(process.execPath, [join(resolve(import.meta.dirname, ".."), "bin", "pso.js"), "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pkg.version);
});
