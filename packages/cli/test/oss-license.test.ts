import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// PSO Web Framework is Apache-2.0: the official license text, the same license and NOTICE in every package, the Java metadata, the
// distribution that installs them, and no proprietary or wrong-publisher wording left in distribution metadata.
const root = resolve(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"; // https://www.apache.org/licenses/LICENSE-2.0.txt
const packages = readdirSync(join(root, "packages")).filter((p) => existsSync(join(root, "packages", p, "package.json")));

test("LICENSE is the official, unmodified Apache License 2.0 and NOTICE names the project and the maintainer", () => {
  assert.equal(sha("LICENSE"), APACHE_2_0_SHA256);
  const notice = read("NOTICE");
  assert.match(notice, /^PSO Web Framework\r?\nCopyright 2026 DevMboo/);
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /Inno Setup, Copyright \(C\) 1997-2026 Jordan Russell/, "the installer's Inno Setup runtime is acknowledged");
});

test("every PSO package declares Apache-2.0, the maintainer, and ships the same LICENSE and NOTICE", () => {
  assert.ok(packages.length >= 13);
  const rootPkg = JSON.parse(read("package.json")) as Record<string, unknown>;
  assert.equal(rootPkg["license"], "Apache-2.0");
  for (const p of packages) {
    const j = JSON.parse(read(`packages/${p}/package.json`)) as { license?: string; author?: string; files?: string[] };
    assert.equal(j.license, "Apache-2.0", p); assert.equal(j.author, "DevMboo", p);
    assert.equal(sha(`packages/${p}/LICENSE`), APACHE_2_0_SHA256, `${p}/LICENSE`);
    assert.equal(read(`packages/${p}/NOTICE`), read("NOTICE"), `${p}/NOTICE`);
    if (j.files) assert.ok(j.files.includes("NOTICE"), `${p}: NOTICE is packed (npm always packs LICENSE, not NOTICE)`);
  }
  const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { license?: string }> };
  for (const [k, v] of Object.entries(lock.packages)) if (k === "" || k.startsWith("packages/")) assert.equal(v.license, "Apache-2.0", `package-lock ${k || "(root)"}`);
});

test("the Java metadata is PSO's own: Apache-2.0, maintainer DevMboo, project URL; nothing inherited from Spring Boot's parent", () => {
  for (const pom of ["pso-java/pom.xml", "pso-java/pso-bom/pom.xml"]) {
    const x = read(pom);
    assert.match(x, /<licenses>\s*<license>\s*<name>Apache-2\.0<\/name>/, pom);
    assert.match(x, /<developer>\s*<id>DevMboo<\/id>/, pom);
    assert.match(x, /<url>https:\/\/devmboo\.github\.io\/pso-web-docs\/<\/url>/, pom);
    assert.match(x, /<scm[^>]*>\s*<url>https:\/\/github\.com\/DevMboo\/pso-web-framework<\/url>/, pom);
  }
  assert.match(read("pso-java/pom.xml"), /child\.project\.url\.inherit\.append\.path="false"/, "module URLs are not appended to the project URL");
});

test("the Windows distribution installs LICENSE and NOTICE, and every release directory carries them", async () => {
  const cfg = JSON.parse(read("dist.config.json")) as { components: Array<{ include: Array<{ from: string; to: string }> }> };
  const inc = cfg.components.flatMap((c) => c.include);
  for (const n of ["LICENSE", "NOTICE"]) assert.ok(inc.some((i) => i.from === n && i.to === "licenses"), n);
  const { classify } = await import("../../../scripts/psd/policy.mjs");
  assert.equal(classify("licenses/LICENSE")?.id, "M-licenses"); assert.equal(classify("licenses/NOTICE")?.id, "M-licenses");
  assert.equal(classify("licenses/anything-else"), null, "nothing else is accepted there");
  const br = read("scripts/psd/build-release.mjs");
  assert.match(br, /for \(const n of \["LICENSE", "NOTICE"\]\) copyFileSync\(join\(repo, n\), join\(releaseDir, n\)\)/);
  assert.match(br, /licenses: \[\{ license: \{ id: "Apache-2\.0" \} \}\]/, "PSO's Java artifacts are Apache-2.0 in the SBOM");
});

test("distribution metadata carries the product identity and no proprietary or wrong-publisher wording", () => {
  const files = ["scripts/release.mjs", "scripts/psd/build-release.mjs", "scripts/psd/build-portable.mjs", "scripts/psd/build-install-kit.mjs", "scripts/psd/tools/bootstrap-main.ts",
    "packages/cli/src/commands-dist.ts", ...readdirSync(join(root, "scripts/psd/release-files")).map((f) => `scripts/psd/release-files/${f}`), ".signpath/artifact-configurations/installer.xml", ".signpath/artifact-configurations/inno-uninstaller.xml"];
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /PSO Games|Axoria Cloud|axoria\.cloud/, `${f}: an old publisher name`);
    // (a check that treats a declared "UNLICENSED" as missing is fine; declaring or labelling PSO code that way is not)
    assert.doesNotMatch(t, /"license":\s*"UNLICENSED"|PSO proprietary|no licen[cs]e granted|proprietary JavaScript/, `${f}: proprietary license wording`);
  }
  const dist = read("packages/cli/src/commands-dist.ts");
  assert.match(dist, /const name = "PSO Web Framework";/); assert.match(dist, /\?\? "DevMboo";/);
  assert.match(dist, /VersionInfoCopyright=Copyright 2026 DevMboo\. Licensed under the Apache License 2\.0/);
  for (const x of ["installer.xml", "inno-uninstaller.xml"]) assert.match(read(`.signpath/artifact-configurations/${x}`), /product-name="PSO Web Framework"/);
});
