// D1 regression: an existing vendor/maven (or vendor/pso) is checked against the release the service needs and refreshed in place by
// `--vendor`: outdated (another release, or another build of the same release), corrupt and unverified (no manifest: written by PSO 0.1 to
// 0.2.0-rc.6) copies are replaced atomically; a current copy is left alone; other groups a developer keeps there are preserved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAVEN_VENDOR_DIR, VENDOR_MANIFEST, inspectMavenVendor, vendorMaven } from "../src/vendor.ts";
import { pso, tmp } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A local Maven repository with com.pso artifacts of the given versions (small stand-in files: vendoring copies bytes, it does not parse them). */
function repo(versions: Record<string, string>): string {
  const r = tmp("pso-m2-"); dirs.push(r);
  for (const [version, mark] of Object.entries(versions)) for (const a of ["pso-bom", "pso-spring-boot-starter", "pso-dispatch-api"]) {
    const d = join(r, "com", "pso", a, version); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${a}-${version}.pom`), `<project><!-- ${a} ${version} ${mark} --></project>\n`);
    if (a !== "pso-bom") writeFileSync(join(d, `${a}-${version}.jar`), `jar ${a} ${version} ${mark}`);
    writeFileSync(join(d, "_remote.repositories"), "machine bookkeeping");
  }
  return r;
}
function service(version: string): string {
  const s = tmp("pso-svc-"); dirs.push(s);
  writeFileSync(join(s, "pom.xml"), `<project><properties><pso.version>${version}</pso.version></properties></project>\n`);
  return s;
}
const group = (svc: string) => join(svc, ...MAVEN_VENDOR_DIR.split("/"), "com", "pso");

test("an outdated vendor directory (another release) is detected and replaced by --vendor, without deleting it by hand", () => {
  const m2 = repo({ "0.2.0-rc.5": "old", "0.2.0-rc.7": "new" });
  const svc = service("0.2.0-rc.5");
  vendorMaven(svc, { mavenRepo: m2 });
  assert.equal(inspectMavenVendor(svc, { mavenRepo: m2 }).state, "current");
  // the workspace moves to the next release: pom.xml changes, the vendored copy does not
  writeFileSync(join(svc, "pom.xml"), readFileSync(join(svc, "pom.xml"), "utf8").replace("0.2.0-rc.5", "0.2.0-rc.7"));
  const before = inspectMavenVendor(svc, { mavenRepo: m2 });
  assert.equal(before.state, "outdated");
  assert.deepEqual(before.vendored, ["0.2.0-rc.5"]);
  assert.match(before.reasons[0]!, /holds com\.pso 0\.2\.0-rc\.5; pom\.xml builds against 0\.2\.0-rc\.7/);
  const r = vendorMaven(svc, { mavenRepo: m2 });
  assert.equal(r.refreshed, true);
  assert.equal(r.previous?.state, "outdated");
  for (const a of readdirSync(group(svc)).filter((x) => x !== VENDOR_MANIFEST)) assert.deepEqual(readdirSync(join(group(svc), a)), ["0.2.0-rc.7"], `${a}: only the new release`);
  assert.equal(inspectMavenVendor(svc, { mavenRepo: m2 }).state, "current");
  assert.ok(!readdirSync(join(svc, "vendor", "maven")).some((f) => f.startsWith(".pso-")), "no staging or backup directory is left behind");
});

test("idempotent: a current vendor directory is not rewritten", () => {
  const m2 = repo({ "0.2.0-rc.7": "a" });
  const svc = service("0.2.0-rc.7");
  vendorMaven(svc, { mavenRepo: m2 });
  const jar = join(group(svc), "pso-spring-boot-starter", "0.2.0-rc.7", "pso-spring-boot-starter-0.2.0-rc.7.jar");
  writeFileSync(join(svc, "marker"), ""); const t0 = readFileSync(jar);
  const again = vendorMaven(svc, { mavenRepo: m2 });
  assert.equal(again.refreshed, false);
  assert.deepEqual(readFileSync(jar), t0);
});

test("the same release rebuilt (pso java:install ran again) makes the vendored bytes outdated", () => {
  const m2 = repo({ "0.2.0-rc.7": "first build" });
  const svc = service("0.2.0-rc.7");
  vendorMaven(svc, { mavenRepo: m2 });
  writeFileSync(join(m2, "com", "pso", "pso-spring-boot-starter", "0.2.0-rc.7", "pso-spring-boot-starter-0.2.0-rc.7.jar"), "jar rebuilt");
  const i = inspectMavenVendor(svc, { mavenRepo: m2 });
  assert.equal(i.state, "outdated");
  assert.match(i.reasons[0]!, /different build of com\.pso 0\.2\.0-rc\.7: com\/pso\/pso-spring-boot-starter\/0\.2\.0-rc\.7\/pso-spring-boot-starter-0\.2\.0-rc\.7\.jar/);
  vendorMaven(svc, { mavenRepo: m2 });
  assert.equal(readFileSync(join(group(svc), "pso-spring-boot-starter", "0.2.0-rc.7", "pso-spring-boot-starter-0.2.0-rc.7.jar"), "utf8"), "jar rebuilt");
});

test("integrity: a changed, missing or foreign file makes the copy corrupt; --vendor repairs it", () => {
  const m2 = repo({ "0.2.0-rc.7": "a" });
  const svc = service("0.2.0-rc.7");
  vendorMaven(svc, { mavenRepo: m2 });
  const jar = join(group(svc), "pso-dispatch-api", "0.2.0-rc.7", "pso-dispatch-api-0.2.0-rc.7.jar");
  writeFileSync(jar, "truncated");
  rmSync(join(group(svc), "pso-bom", "0.2.0-rc.7", "pso-bom-0.2.0-rc.7.pom"));
  writeFileSync(join(group(svc), "pso-bom", "0.2.0-rc.7", "extra.jar"), "x");
  const i = inspectMavenVendor(svc, { mavenRepo: m2 });
  assert.equal(i.state, "corrupt");
  assert.deepEqual(i.reasons.sort(), [
    "com/pso/pso-bom/0.2.0-rc.7/extra.jar is not part of the vendored release",
    "com/pso/pso-bom/0.2.0-rc.7/pso-bom-0.2.0-rc.7.pom is missing",
    "com/pso/pso-dispatch-api/0.2.0-rc.7/pso-dispatch-api-0.2.0-rc.7.jar does not match its recorded SHA-256",
  ]);
  vendorMaven(svc, { mavenRepo: m2 });
  assert.equal(inspectMavenVendor(svc, { mavenRepo: m2 }).state, "current");
});

test("a copy written by an earlier PSO (no manifest) is unverified and gets a manifest on refresh; other groups are preserved", () => {
  const m2 = repo({ "0.2.0-rc.7": "a" });
  const svc = service("0.2.0-rc.7");
  // the layout rc.6 writes: the artifacts, no manifest, plus an artifact of another group the developer vendored on purpose
  for (const a of ["pso-bom"]) { const d = join(group(svc), a, "0.2.0-rc.7"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${a}-0.2.0-rc.7.pom`), "<project/>"); }
  const other = join(svc, "vendor", "maven", "org", "acme", "lib", "1.0"); mkdirSync(other, { recursive: true }); writeFileSync(join(other, "lib-1.0.jar"), "acme");
  assert.equal(inspectMavenVendor(svc, { mavenRepo: m2 }).state, "unverified");
  vendorMaven(svc, { mavenRepo: m2 });
  assert.equal(inspectMavenVendor(svc, { mavenRepo: m2 }).state, "current");
  assert.ok(existsSync(join(group(svc), VENDOR_MANIFEST)));
  assert.equal(readFileSync(join(other, "lib-1.0.jar"), "utf8"), "acme", "a dependency PSO does not own is left alone");
  assert.deepEqual(readdirSync(join(svc, "vendor", "maven")).sort(), ["com", "org"], "nothing but the repository layout at the top (the build copies it into ~/.m2)");
});

test("a refresh that cannot complete leaves the previous copy usable", () => {
  const m2 = repo({ "0.2.0-rc.5": "old" });
  const svc = service("0.2.0-rc.5");
  vendorMaven(svc, { mavenRepo: m2 });
  writeFileSync(join(svc, "pom.xml"), readFileSync(join(svc, "pom.xml"), "utf8").replace("0.2.0-rc.5", "0.2.0-rc.7"));
  assert.throws(() => vendorMaven(svc, { mavenRepo: m2 }), (e: unknown) => /The PSO Java artifacts 0\.2\.0-rc\.7 were not found in /.test((e as Error).message) && /pso java:install/.test((e as { hint?: string }).hint ?? ""));
  assert.deepEqual(readdirSync(join(group(svc), "pso-bom")), ["0.2.0-rc.5"], "the old copy is untouched");
});

test("pso docker:build without --vendor names an outdated vendor directory and the fix, before any image is built", { skip: process.env["PSO_TEST_DOCKER"] === "0" ? "docker disabled" : false }, async () => {
  const m2 = repo({ "0.2.0-rc.5": "old" });
  const root = tmp("pso-ws-"); dirs.push(root);
  writeFileSync(join(root, "pso.workspace.json"), JSON.stringify({ schemaVersion: 1, name: "shop", services: [{ name: "catalog", path: "catalog", runtime: "spring-boot", role: "service", port: 8081 }] }));
  mkdirSync(join(root, "catalog"));
  writeFileSync(join(root, "catalog", "pom.xml"), "<project><properties><pso.version>0.2.0-rc.5</pso.version></properties></project>\n");
  vendorMaven(join(root, "catalog"), { mavenRepo: m2 });
  writeFileSync(join(root, "catalog", "pom.xml"), "<project><properties><pso.version>0.2.0-rc.7</pso.version></properties></project>\n");
  writeFileSync(join(root, "pso.infra.json"), JSON.stringify({ schemaVersion: 1, defaultEnvironment: "local", environments: { local: { kind: "development", domain: "pso.localhost", runtime: "docker", httpsPort: 18643 } } }));
  const r = await pso(root, "docker:build", "--env", "local");
  if (/Docker is not usable/.test(r.out + r.err)) return; // no Docker Engine on this machine: the check runs before the engine is needed
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /catalog: vendor\/maven is outdated \(PSO_VENDOR_OUTDATED\): vendor\/maven holds com\.pso 0\.2\.0-rc\.5; pom\.xml builds against 0\.2\.0-rc\.7/);
  assert.match(r.out + r.err, /Re-run with --vendor.*Deleting the directory by hand is not needed/s);
});
