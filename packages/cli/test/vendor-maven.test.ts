import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { psoJavaDir } from "../src/specs.ts";
import { MAVEN_VENDOR_DIR, inspectMavenVendor, psoVersionOfPom, vendorMaven } from "../src/vendor.ts";
import { pso, tmp } from "./helpers.ts";

/**
 * Portability of a generated Spring service (PORT-01). The com.pso artifacts are not on Maven Central: a service builds on the
 * machine where `pso java:install` ran and nowhere else. `pso docker:init --vendor` puts exactly those artifacts inside the
 * service; the proof is a build in a CLEAN directory with a CLEAN local Maven repository that contains nothing but what the service
 * carries. Third-party artifacts come from a repository standing in for Maven Central (this machine's cache served as a remote
 * repository), so the test needs no network and still cannot resolve com.pso from anywhere except the vendored copy.
 */
const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* OS reaps temp */ } } });
const M2 = join(homedir(), ".m2", "repository");
const javaDir = psoJavaDir();
const ready = javaDir !== undefined && existsSync(join(M2, "com", "pso", "pso-bom"));
const needsJava = { timeout: 900_000, skip: ready ? false : "the PSO Java artifacts are not installed in the local Maven repository (pso java:install)" } as const;
const fileUrl = (p: string): string => "file:///" + resolve(p).replace(/\\/g, "/").replace(/^\//, "");
const walk = (d: string, acc: string[] = []): string[] => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f, acc); else acc.push(f); } return acc; };

async function workspace(): Promise<{ root: string; svc: string }> {
  const base = tmp("pso-vendor-mvn-"); dirs.push(base);
  assert.equal((await pso(base, "create", "workspace", "w", "--layout", "flat")).code, 0);
  const root = join(base, "w");
  assert.equal((await pso(root, "create", "service", "catalog", "--structure", "legacy")).code, 0);
  return { root, svc: join(root, "catalog") };
}

test("docker:init without --vendor: the Spring Dockerfile is unchanged and the missing portability is SAID, with the fix", needsJava, async () => {
  const { root, svc } = await workspace();
  const r = await pso(root, "docker:init", "--json");
  assert.equal(r.code, 0, r.out + r.err);
  const out = JSON.parse(r.out) as { mavenNotPortable: Array<{ service: string; version: string }>; vendoredMaven: unknown[] };
  const version = psoVersionOfPom(svc)!;
  assert.deepEqual(out.mavenNotPortable, [{ service: "catalog", version }]);
  assert.deepEqual(out.vendoredMaven, []);
  const dockerfile = readFileSync(join(svc, "Dockerfile"), "utf8");
  assert.ok(!dockerfile.includes("vendor/maven"), "nothing is vendored unless asked");
  assert.match(dockerfile, /must be resolvable from a Maven repository inside this build/);
  assert.ok(!existsSync(join(svc, "vendor")));
  const text = (await pso(root, "docker:init", "--force")).out;
  assert.match(text, new RegExp(`WARNING\\s+catalog: the com\\.pso:\\*:${version.replace(/\./g, "\\.")} artifacts exist only in the local Maven repository of THIS machine; .*Run \`pso docker:init --vendor --force\``));
});

test("docker:init --vendor carries the com.pso artifacts in the service: only that version, no machine bookkeeping, idempotent, dry-run writes nothing", needsJava, async () => {
  const { root, svc } = await workspace();
  const version = psoVersionOfPom(svc)!;
  const dry = await pso(root, "docker:init", "--vendor", "--dry-run", "--json");
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.ok(!existsSync(join(svc, "vendor")), "dry-run writes nothing");
  assert.equal((JSON.parse(dry.out) as { vendoredMaven: Array<{ service: string; version: string }> }).vendoredMaven[0]?.version, version);

  const r = await pso(root, "docker:init", "--vendor");
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`vendored\\s+catalog: com\\.pso ${version.replace(/\./g, "\\.")} \\(\\d+ artifacts, \\d+ files\\) -> vendor/maven`));
  if (/-SNAPSHOT$/.test(version)) assert.match(r.out, /is a SNAPSHOT: right for development images\. For a release, build fixed-version artifacts/);
  const vendor = join(svc, ...MAVEN_VENDOR_DIR.split("/"), "com", "pso");
  const artifacts = readdirSync(vendor).filter((a) => a !== "pso-vendor.json").sort();
  // the manifest lives with the artifacts: the release they are and the SHA-256 of every file, so a later build can tell current from stale
  const manifest = JSON.parse(readFileSync(join(vendor, "pso-vendor.json"), "utf8")) as { kind: string; version: string; files: Record<string, string> };
  assert.equal(manifest.kind, "maven");
  assert.equal(manifest.version, version);
  assert.ok(Object.keys(manifest.files).some((f) => f.endsWith(`pso-spring-boot-starter-${version}.jar`)));
  assert.equal(inspectMavenVendor(svc).state, "current");
  for (const needed of ["pso-bom", "pso-parent", "pso-spring-boot-starter", "pso-spring-boot-autoconfigure", "pso-dispatch-api"]) assert.ok(artifacts.includes(needed), needed);
  assert.ok(!artifacts.includes("pso-integration-tests"), "the framework's own integration tests are not a dependency of a service");
  for (const a of artifacts) assert.deepEqual(readdirSync(join(vendor, a)), [version], `${a}: exactly the version the pom builds against`);
  const files = walk(vendor).filter((f) => !f.endsWith("pso-vendor.json"));
  assert.ok(files.some((f) => f.endsWith(`pso-spring-boot-starter-${version}.jar`)));
  assert.deepEqual(files.filter((f) => /_remote\.repositories$|\.lastUpdated$|resolver-status\.properties$/.test(f)), [], "bookkeeping of this machine's repository is not copied");
  for (const f of files.filter((x) => x.endsWith(".pom"))) assert.ok(!/(^|[^A-Za-z])[A-Za-z]:[\\/](?!\/)|\/home\/|\/Users\//.test(readFileSync(f, "utf8")), `${f} contains no path of this machine`);
  assert.match(readFileSync(join(svc, "Dockerfile"), "utf8"), /COPY mvnw pom\.xml \.\/\r?\nCOPY vendor\/maven \/root\/\.m2\/repository\r?\nRUN chmod \+x mvnw && \.\/mvnw -B -ntp dependency:go-offline/);
  assert.ok(!readFileSync(join(svc, ".dockerignore"), "utf8").split(/\r?\n/).includes("vendor"), "the vendored artifacts are part of the build context");

  // idempotent, and a later plain docker:init keeps the vendored Dockerfile
  const before = files.length;
  const again = await pso(root, "docker:init", "--vendor", "--force");
  assert.equal(again.code, 0);
  assert.equal(walk(vendor).filter((f) => !f.endsWith("pso-vendor.json")).length, before);
  assert.equal((await pso(root, "docker:init", "--force")).code, 0);
  assert.match(readFileSync(join(svc, "Dockerfile"), "utf8"), /COPY vendor\/maven/);

  // a missing installation is an actionable error, never an empty vendor directory
  const empty = tmp("pso-empty-m2-"); dirs.push(empty);
  assert.throws(() => vendorMaven(svc, { mavenRepo: empty }), /were not found in .*pso-empty-m2/);
  const cli = await pso(root, "docker:init", "--vendor", "--force", "--maven-repo", empty);
  assert.notEqual(cli.code, 0);
  assert.match(cli.out + cli.err, /pso java:install/);
});

test("a vendored Spring service builds (and passes its tests) in a clean directory with a clean local Maven repository", needsJava, async () => {
  const { root, svc } = await workspace();
  const version = psoVersionOfPom(svc)!;
  assert.equal((await pso(root, "docker:init", "--vendor")).code, 0);

  // "another machine": a checkout of the workspace (its declaration and the service) and nothing else: no target/, no ~/.m2
  const elsewhere = tmp("pso-elsewhere-"); dirs.push(elsewhere);
  cpSync(root, join(elsewhere, "w"), { recursive: true, filter: (s) => !/[\\/]target$/.test(s) });
  const project = join(elsewhere, "w", "catalog");
  void svc;
  // Maven Central stand-in for third-party artifacts and plugins (releases only: a SNAPSHOT of com.pso cannot be resolved from it)
  const settings = join(elsewhere, "settings.xml");
  writeFileSync(settings, `<settings><mirrors><mirror><id>central-stand-in</id><mirrorOf>*</mirrorOf><url>${fileUrl(M2)}</url></mirror></mirrors></settings>`);
  const mvnw = join(javaDir!, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  const mvn = (repo: string, ...goals: string[]) => spawnSync(mvnw, ["-B", "-ntp", "-s", settings, `-Dmaven.repo.local=${repo}`, ...goals], { cwd: project, encoding: "utf8", shell: process.platform === "win32", timeout: 800_000, maxBuffer: 256 * 1024 * 1024 });

  // what the generated Dockerfile does: the local repository of the build starts with the vendored artifacts and nothing else
  const clean = join(elsewhere, "m2");
  mkdirSync(clean);
  cpSync(join(project, ...MAVEN_VENDOR_DIR.split("/")), clean, { recursive: true });
  assert.deepEqual(readdirSync(clean), ["com"], "the clean repository holds only what the service carries");
  assert.deepEqual(readdirSync(join(clean, "com")), ["pso"]);
  const r = mvn(clean, "package");
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /ERROR|FAIL|Tests run:|BUILD/.test(l)).slice(0, 25).join("\n"));
  assert.ok(existsSync(join(project, "target")) && readdirSync(join(project, "target")).some((f) => /^catalog-.*\.jar$/.test(f)), "the service jar was built");
  assert.match(out, /Tests run: \d+, Failures: 0, Errors: 0, Skipped: 0/, "the generated service's own tests ran and passed");
  // the com.pso artifacts came from the vendored copy: an artifact downloaded from a repository is recorded in _remote.repositories
  for (const a of ["pso-bom", "pso-spring-boot-starter", "pso-spring-boot-autoconfigure"]) assert.ok(!existsSync(join(clean, "com", "pso", a, version, "_remote.repositories")), `${a} was not downloaded`);
  assert.ok(existsSync(join(clean, "org", "springframework", "boot")), "third-party artifacts were resolved from the repository, as on any machine");

  // the control: the same clean build WITHOUT the vendored artifacts cannot resolve com.pso (this is the gap vendoring closes)
  if (/-SNAPSHOT$/.test(version)) {
    const bare = join(elsewhere, "m2-bare");
    mkdirSync(bare);
    const c = mvn(bare, "-q", "validate");
    assert.notEqual(c.status, 0, "without vendoring a clean machine cannot build the service");
    assert.match(c.stdout + c.stderr, /com\.pso:pso-bom/);
  }
});
