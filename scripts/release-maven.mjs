#!/usr/bin/env node
// PSO Maven release preparation. Works on a TEMPORARY COPY of pso-java (the repository sources are never modified), sets a fixed
// non-SNAPSHOT version, deploys every artifact to a LOCAL FILE repository (NO sources or javadoc jars: they would hand the Java sources to every recipient; `--with-sources` exists only for a repository that is never distributed), checksums it, produces a CycloneDX SBOM, and builds a
// freshly generated Spring service against that repository with an ISOLATED local Maven repository. It never publishes anything.
//
//   node scripts/release-maven.mjs [--version 0.1.0] [--out <dir>] [--sign-key <ed25519 private pem>] [--skip-consumer] [--with-sources] [--denylist <file>]
import { createHash, createPrivateKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { scan, summarize } from "./psd/scan.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };
const version = typeof flag("version") === "string" ? flag("version") : "0.1.0";
if (/SNAPSHOT/i.test(version) || !/^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/.test(version)) { console.error("a release needs a fixed, non-SNAPSHOT version such as 0.1.0"); process.exit(1); }
const out = resolve(typeof flag("out") === "string" ? flag("out") : join(root, "release-out", "maven"));
const mvnw = join(root, "pso-java", process.platform === "win32" ? "mvnw.cmd" : "mvnw");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stages = [];
const stage = (name, status, detail) => { stages.push({ name, status, detail }); console.log(`${status.padEnd(8)} ${name}${detail ? ` - ${detail}` : ""}`); };
// an executable and an argument array on every platform: the Maven Wrapper is a batch file on Windows, started by cmd.exe with
// the arguments as separate array elements, never as one shell command string
// Maven Archiver writes "Built-By: <user.name>" into every jar manifest: pin it so the build machine's account never ships
const mvnEnv = { ...process.env, MAVEN_OPTS: `${process.env.MAVEN_OPTS ?? ""} -Duser.name=pso`.trim() };
const mvn = (cwd, a, timeout = 290_000) => (process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", mvnw, "-B", ...a], { cwd, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, env: mvnEnv })
  : spawnSync(mvnw, ["-B", ...a], { cwd, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, env: mvnEnv }));
const fileUrl = (p) => "file:///" + resolve(p).replace(/\\/g, "/").replace(/^\//, "");
const walk = (d, acc = []) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f, acc); else acc.push(f); } return acc; };

rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "pso-mvn-release-"));
const src = join(work, "src"), repo = join(out, "repository");
try {
  cpSync(join(root, "pso-java"), src, { recursive: true, filter: (s) => !/[\\/]target(-[a-z]+\.log)?$|target-.*\.log$/.test(s) });
  let r = mvn(src, ["-q", "versions:set", `-DnewVersion=${version}`, "-DgenerateBackupPoms=false", "-DprocessAllModules=true"]);
  if (r.status !== 0) { stage("set release version", "FAILED", (r.stdout + r.stderr).slice(-300)); process.exit(1); }
  const left = walk(src).filter((f) => f.endsWith("pom.xml") && /SNAPSHOT/.test(readFileSync(f, "utf8")));
  stage("set release version", left.length ? "FAILED" : "PASSED", left.length ? `SNAPSHOT left in ${left.map((f) => relative(src, f)).join(", ")}` : `${version} in every module (temporary copy; the repository is unchanged)`);

  const withSources = flag("with-sources") === true;
  if (withSources) console.warn("WARNING --with-sources: this repository contains the Java SOURCES and must never be distributed");
  r = mvn(src, ["-q", "-DskipTests", "-pl", "!pso-integration-tests", ...(withSources ? ["source:jar-no-fork"] : []), "deploy", `-DaltDeploymentRepository=release::${fileUrl(repo)}`]);
  const jars = existsSync(repo) ? walk(repo).filter((f) => f.endsWith(".jar") && !f.endsWith("-sources.jar")) : [];
  stage("deploy to file repository", r.status === 0 && jars.length > 0 ? "PASSED" : "FAILED", r.status === 0 ? `${jars.length} compiled jars + poms${withSources ? " + SOURCES (not distributable)" : ""}, no SNAPSHOT` : (r.stdout + r.stderr).slice(-400));
  if (r.status !== 0) process.exit(1);
  const srcJars = walk(repo).filter((f) => /-(sources|javadoc)\.jar$/.test(f));
  stage("no sources or javadoc jars", srcJars.length && !withSources ? "FAILED" : srcJars.length ? "FAILED" : "PASSED", srcJars.length ? `${srcJars.length} sources/javadoc jar(s) present${withSources ? " (--with-sources: NOT a distributable repository)" : ""}` : "compiled artifacts only");
  const snap = walk(repo).filter((f) => /SNAPSHOT/.test(f));
  stage("no SNAPSHOT artifacts", snap.length ? "FAILED" : "PASSED", snap.length ? `${snap.length} SNAPSHOT file(s)` : "none");

  // recursive distribution scan: jars are opened, class files and resources inspected for secrets, developer paths and the private deny-list
  {
    const dl = typeof flag("denylist") === "string" ? flag("denylist") : process.env.PSD_DENYLIST;
    const denylist = dl && existsSync(dl) ? readFileSync(dl, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")) : [];
    const res = scan(repo, { denylist });
    writeFileSync(join(out, "scan-report.json"), JSON.stringify({ stats: res.stats, findings: res.findings, uninspectable: res.uninspectable }, null, 2));
    stage("distribution scan", res.ok ? "PASSED" : "FAILED", res.ok ? `${res.stats.files} files incl. ${res.stats.archives} archives inspected${denylist.length ? "" : " (no private deny-list supplied)"}` : `${res.findings.length} finding(s) (${Object.entries(summarize(res)).map(([k, v]) => `${k}=${v}`).join(", ")}), ${res.uninspectable.length} uninspectable; see scan-report.json (values are redacted)`);
  }

  // checksums over every deployed file that is not itself a checksum
  const files = walk(repo).filter((f) => !/\.(md5|sha1|sha256)$/.test(f)).sort();
  const sums = files.map((f) => `${sha(readFileSync(f))} *${relative(out, f).replace(/\\/g, "/")}`);
  writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  stage("checksums", "PASSED", `SHA-256 of ${files.length} files (Maven also wrote .md5/.sha1 next to each)`);

  // SBOM (CycloneDX aggregate)
  r = mvn(src, ["-q", "org.cyclonedx:cyclonedx-maven-plugin:2.9.1:makeAggregateBom", "-DoutputFormat=json", "-DoutputName=sbom.cdx", "-pl", "!pso-integration-tests", "-DskipTests"], 240_000);
  const bom = join(src, "target", "sbom.cdx.json");
  if (r.status === 0 && existsSync(bom)) {
    writeFileSync(join(out, "sbom.cdx.json"), readFileSync(bom));
    const j = JSON.parse(readFileSync(bom, "utf8"));
    const lic = new Map(); for (const c of j.components ?? []) for (const l of c.licenses?.length ? c.licenses : [{ license: { id: "unknown" } }]) { const k = l.license?.id ?? l.license?.name ?? l.expression ?? "unknown"; lic.set(k, (lic.get(k) ?? 0) + 1); }
    writeFileSync(join(out, "licenses.json"), JSON.stringify({ scope: "aggregate of all released modules (runtime + compile)", counts: Object.fromEntries(lic) }, null, 2));
    stage("SBOM (CycloneDX)", "PASSED", `${j.components?.length ?? 0} components; licences: ${[...lic].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  } else stage("SBOM (CycloneDX)", "FAILED", (r.stdout + r.stderr).slice(-300));

  // signing of the checksum file (artifact signing with GPG is a separate, key-dependent step that is NOT done here)
  const keyFile = typeof flag("sign-key") === "string" ? flag("sign-key") : process.env.PSO_RELEASE_SIGNING_KEY_FILE;
  if (keyFile && !resolve(keyFile).toLowerCase().startsWith(root.toLowerCase())) {
    writeFileSync(join(out, "SHA256SUMS.sig"), sign(null, readFileSync(join(out, "SHA256SUMS")), createPrivateKey(readFileSync(keyFile, "utf8"))).toString("base64") + "\n");
    // DSSE-wrapped, self-asserted provenance whose subject is the checksum file (which in turn lists every artifact)
    const priv = createPrivateKey(readFileSync(keyFile, "utf8"));
    const st = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: "SHA256SUMS", digest: { sha256: sha(readFileSync(join(out, "SHA256SUMS"))) } }], predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { buildType: "https://pso.example/build/local-maven-deploy/v1", externalParameters: { command: "node scripts/release-maven.mjs", version } }, runDetails: { builder: { id: "local:developer-machine" } }, note: "SELF-ASSERTED, UNATTESTED: produced on the build machine itself; not an attested SLSA build." } };
    const body = Buffer.from(JSON.stringify(st)), type = "application/vnd.in-toto+json";
    const pae = Buffer.concat([Buffer.from(`DSSEv1 ${type.length} ${type} ${body.length} `), body]);
    writeFileSync(join(out, "provenance.intoto.json"), JSON.stringify({ payloadType: type, payload: body.toString("base64"), signatures: [{ sig: sign(null, pae, priv).toString("base64") }] }, null, 2));
    stage("signing", "PASSED", "Ed25519 signature of SHA256SUMS and a DSSE provenance envelope (Maven artifacts themselves are NOT GPG-signed: Maven Central requires that with your key)");
  } else stage("signing", "NOT RUN", keyFile ? "key inside the repository refused" : "no key supplied; artifacts are UNSIGNED (also no GPG signatures)");

  // consumer: generate a service with the CLI and build it against ONLY this repository, with an isolated local repository
  if (flag("skip-consumer")) stage("consumer build", "NOT RUN", "--skip-consumer");
  else {
    const cons = join(work, "consumer"); mkdirSync(cons);
    const pso = join(root, "packages", "cli", "bin", "pso.js");
    const g = (a) => spawnSync(process.execPath, [pso, ...a], { cwd: cons, encoding: "utf8" });
    g(["create", "workspace", "demo"]);
    const gw = (a) => spawnSync(process.execPath, [pso, ...a], { cwd: join(cons, "demo"), encoding: "utf8" });
    const c = gw(["create", "service", "orders", "--runtime", "spring-boot"]);
    // the project directory comes from the workspace file (standard layout: services/orders; flat layout: orders)
    const svcDir = (() => { try { const p = JSON.parse(readFileSync(join(cons, "demo", "pso.workspace.json"), "utf8")).services.find((x) => x.name === "orders")?.path; return p ? join(cons, "demo", ...p.split("/")) : join(cons, "demo", "orders"); } catch { return join(cons, "demo", "orders"); } })();
    const pom = join(svcDir, "pom.xml");
    if (c.status !== 0 || !existsSync(pom)) stage("consumer build", "FAILED", "could not generate a service: " + (c.stderr || c.stdout).slice(-200));
    else {
      writeFileSync(pom, readFileSync(pom, "utf8").replace(/<pso\.version>[^<]*<\/pso\.version>/, `<pso.version>${version}</pso.version>`));
      const settings = join(cons, "settings.xml");
      writeFileSync(settings, `<settings><profiles><profile><id>pso</id><repositories><repository><id>pso-release</id><url>${fileUrl(repo)}</url><releases><enabled>true</enabled></releases><snapshots><enabled>false</enabled></snapshots></repository></repositories></profile></profiles><activeProfiles><activeProfile>pso</activeProfile></activeProfiles></settings>`);
      const iso = join(cons, "m2");
      const b = mvn(svcDir, ["-s", settings, `-Dmaven.repo.local=${iso}`, "package"], 290_000);
      // the generated service has its own project version (not the PSO release's): read it from its pom
      const own = /<artifactId>orders<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(readFileSync(pom, "utf8"))?.[1] ?? "";
      const jar = join(svcDir, "target", `orders-${own}.jar`);
      const rep = existsSync(join(svcDir, "target", "surefire-reports")) ? readdirSync(join(svcDir, "target", "surefire-reports")).filter((f) => f.endsWith(".txt")).length : 0;
      const fromRepo = existsSync(join(iso, "com", "pso", "pso-bom", version));
      stage("consumer build", b.status === 0 && existsSync(jar) && fromRepo ? "PASSED" : "FAILED", b.status === 0 ? `generated service built (including its ${rep} test class report(s)) against the release repository with an isolated local repository; PSO artifacts resolved: ${fromRepo}` : (b.stdout + b.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 4).join(" | ").slice(0, 400));
    }
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ schema: 1, product: "pso", kind: "maven", version, generatedAt: new Date().toISOString(), repository: "repository/", stages }, null, 2));
  console.log(`\nartifacts: ${out}\nNothing was published.`);
  process.exitCode = stages.some((s) => s.status === "FAILED") ? 1 : 0;
} finally { rmSync(work, { recursive: true, force: true }); }
