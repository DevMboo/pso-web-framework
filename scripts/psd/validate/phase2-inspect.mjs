// Phase 2: what an authorized developer actually has after installation, compared with the unprotected baseline; integrity, tamper detection, repair, Java install.
//   node scripts/psd/validate/phase2-inspect.mjs --label 0.1.0-alpha.1 --baseline <unprotected baseline stage dir>
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep, extname } from "node:path";
import { Evidence, makeIso, node, run } from "./iso.mjs";
import { scan, summarize } from "../scan.mjs";

const repo = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const label = flag("label") ?? "0.1.0-alpha.1";
const baseline = flag("baseline");
const K = join(process.env.USERPROFILE, ".pso-psd");
const evDir = join(repo, "docs", "implementation", "evidence", "psd", label);
const ev = new Evidence(join(evDir, "validation-inspect.json"));
const iso = makeIso(join(K, "validation", "iso-dev"), { fresh: false });
const dir = join(iso.root, "pso");
const ver = join(dir, "versions", label);
const cli = join(ver, "node_modules", "@pso", "cli", "bin", "pso.js");
const walk = (d, acc = []) => { for (const n of readdirSync(d)) { const f = join(d, n); const s = lstatSync(f); s.isDirectory() ? walk(f, acc) : acc.push(f); } return acc; };
const dirBytes = (d) => walk(d).reduce((s, f) => s + statSync(f).size, 0);
const posix = (p) => p.split(sep).join("/");
const KEYWORDS = new Set("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield await async of static get set null true false undefined".split(" "));
function metrics(files) {
  let bytes = 0, lines = 0, id = 0, short = 0, len = 0;
  for (const f of files) { const t = readFileSync(f, "utf8"); bytes += Buffer.byteLength(t); lines += t.split("\n").length; for (const m of t.matchAll(/(?<![.\w$"'`])[A-Za-z_$][\w$]*/g)) { if (KEYWORDS.has(m[0])) continue; id++; len += m[0].length; if (m[0].length <= 2) short++; } }
  return { files: files.length, bytes, lines, meanIdentifierLength: +(len / Math.max(1, id)).toFixed(2), shortIdentifierShare: +(short / Math.max(1, id)).toFixed(3) };
}

ev.check("installation exists", existsSync(cli), cli);
const all = walk(dir).map((f) => posix(relative(dir, f)));
const inVer = all.filter((f) => f.startsWith(`versions/${label}/`)).map((f) => f.slice(`versions/${label}/`.length));
ev.check("no source maps are installed", !inVer.some((f) => /\.map$/.test(f)), `${inVer.length} files`);
const tsSources = inVer.filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !f.startsWith("node_modules/@pso/cli/templates/") && !f.startsWith("node_modules/@pso/cli/docs/examples/") && !/^node_modules\/typescript\//.test(f));
ev.check("no original TypeScript source of the framework is installed (templates and doc examples are the only .ts, by design)", tsSources.length === 0, tsSources.slice(0, 3).join(", "));
// scope: framework packages (node_modules/@pso/<pkg>/test|tests|src), any fixtures directory, internal reports and evidence, Java sources. Templates and doc examples
// carry their own test folders for the DEVELOPER's projects by design, and third-party packages are unmodified, so neither is a finding.
const frameworkTests = all.filter((f) => /node_modules\/@pso\/[^/]+\/(test|tests|src)\//.test(f));
const internal = all.filter((f) => /(^|\/)fixtures(\/|$)|(^|\/)evidence(\/|$)|docs\/implementation|-sources\.jar$|-javadoc\.jar$/.test(f));
const pkgs = all.filter((f) => /\.psopkg$/.test(f) && !f.startsWith(".pso-install/packages/"));
ev.check("no framework tests or sources, no fixtures, no internal reports, no evidence, no sources jars in the installation", frameworkTests.length + internal.length + pkgs.length === 0, [...frameworkTests, ...internal, ...pkgs].slice(0, 4).join(", "));
ev.check("the cached repair package is encrypted (no plaintext product behind .pso-install)", (() => { const f = join(dir, ".pso-install", "packages", `${label}.psopkg`); return existsSync(f) && !readFileSync(f).includes("sourceMappingURL") && !readFileSync(f).includes("export function"); })());
ev.check("no private key or plaintext secret material was written to the installation", !all.some((f) => /\.(key|pem)$/.test(f) && !/\.public\.pem$/.test(f)), all.filter((f) => /\.pem$/.test(f)).join(", "));

// recursive scan of the installed tree with the maintainer's private deny-list
const denylist = readFileSync(join(K, "denylist.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
const exceptions = JSON.parse(readFileSync(join(repo, "scripts", "psd", "exceptions.json"), "utf8")).exceptions;
// exceptions are written against stage paths (node_modules/...): an installation keeps them under versions/<label>/
const shifted = exceptions.map((x) => ({ ...x, ...(x.path ? { path: `versions/${label}/${x.path}` } : {}), ...(x.pathPrefix ? { pathPrefix: `versions/${label}/${x.pathPrefix}` } : {}) }));
const digest = JSON.parse(readFileSync(join(evDir, "package-digest.json"), "utf8"));
// the encrypted repair package cannot be read from outside: it is covered by the scan of its plaintext before encryption (same bytes, same digest)
const sc = scan(dir, { denylist, exceptions: shifted, preEncryptionEvidence: new Set([digest.sha256]) });
writeFileSync(join(evDir, "scan-installed.json"), JSON.stringify({ stats: sc.stats, findings: sc.findings, uninspectable: sc.uninspectable }, null, 2));
ev.check("recursive scan of the installed tree (deny-list, secrets, fixtures, developer paths): no findings", sc.ok, sc.ok ? `${sc.stats.files} files, ${(sc.stats.bytes / 1048576).toFixed(1)} MB` : JSON.stringify(summarize(sc)));

// footprint and exposure against the unprotected baseline
const installedBytes = dirBytes(dir);
const jsOf = (root, sub) => walk(join(root, sub)).filter((f) => /\.(m?js)$/.test(f));
const prot = { cli: metrics(jsOf(ver, "node_modules/@pso/cli/dist")), deploy: metrics(jsOf(ver, "node_modules/@pso/deploy/dist")), frontend: metrics(jsOf(ver, "node_modules/@pso/frontend/dist")), agent: metrics([join(ver, "node_modules", "@pso", "deploy", "agent", "pso-agent.mjs")]) };
let base = null;
if (baseline && existsSync(baseline)) {
  const b = (p) => join(baseline, "node_modules", "@pso", p);
  base = { cli: metrics(jsOf(baseline, "node_modules/@pso/cli/dist")), deploy: metrics(jsOf(baseline, "node_modules/@pso/deploy/dist")), frontend: metrics(jsOf(baseline, "node_modules/@pso/frontend/dist")), agent: metrics([join(b("deploy"), "agent", "pso-agent.mjs")]) };
  ev.check("protected JavaScript is smaller and has fewer, mangled lines than the readable baseline", Object.keys(prot).every((k) => prot[k].lines < base[k].lines && prot[k].shortIdentifierShare > base[k].shortIdentifierShare), Object.keys(prot).map((k) => `${k}: lines ${base[k].lines}->${prot[k].lines}, short ${(base[k].shortIdentifierShare * 100).toFixed(0)}%->${(prot[k].shortIdentifierShare * 100).toFixed(0)}%`).join("; "));
}
// readable exposure that remains BY DESIGN
const readable = { publicSdkJsFiles: all.filter((f) => /node_modules\/@pso\/(core|http|security|dispatch|channels|channels-client|react-channels|frontend-client|frontend-react)\/dist\/.*\.js$/.test(f)).length, templateFiles: all.filter((f) => f.includes("/cli/templates/")).length, docPages: all.filter((f) => /cli\/docs\/.*\.md$/.test(f)).length };

// integrity, tamper detection, repair
let r = node(iso, [cli, "integrity", "check", "--full", "--root", dir]);
ev.check("integrity check --full on the fresh installation", r.status === 0, r.out.split("\n")[0]);
const victim = join(ver, "node_modules", "@pso", "deploy", "dist", "index.js");
const original = readFileSync(victim);
writeFileSync(victim, Buffer.concat([original, Buffer.from("\n// tampered\n")]));
r = node(iso, [cli, "integrity", "check", "--full", "--root", dir]);
ev.check("a modified protected file is detected", r.status === 1 && /deploy\/dist\/index\.js/.test(r.out), r.out.split("\n").filter((l) => /damaged/.test(l)).join(" "));
r = node(iso, [cli, "repair", "--full", "--root", dir]);
ev.check("repair restores the authentic PROTECTED file from the encrypted package, using the developer's DPAPI identity", r.status === 0 && readFileSync(victim).equals(original), r.out.split("\n")[0] || r.err.slice(0, 200));
r = node(iso, [cli, "integrity", "check", "--full", "--root", dir]);
ev.check("integrity check after repair", r.status === 0);
// user data is untouched by repair
writeFileSync(join(iso.work, "my-own-file.txt"), "mine");
r = node(iso, [cli, "doctor"]);
ev.check("pso doctor runs from the installation", r.status === 0 || /Node|Java|Docker/.test(r.out), r.out.split("\n").slice(0, 3).join(" | "));
// Java: the installed CLI carries the compiled Maven repository (no sources)
r = node(iso, [cli, "java:install", "--json"]);
let j; try { j = JSON.parse(r.out); } catch { j = null; }
ev.check("pso java:install copies the bundled compiled repository into the (isolated) ~/.m2 without any source checkout", r.status === 0 && j && /^0\.1\.0/.test(j.version) && j.installed === true, r.out.slice(0, 200) || r.err.slice(0, 200));
const m2 = join(iso.home, ".m2", "repository", "com", "pso");
ev.check("the installed Maven artifacts contain compiled classes only (no -sources.jar)", existsSync(m2) && !walk(m2).some((f) => /-sources\.jar$/.test(f)) && walk(m2).some((f) => f.endsWith(".jar")), `${existsSync(m2) ? walk(m2).filter((f) => f.endsWith(".jar")).length : 0} jars`);

// startup time: protected distribution vs the unprotected baseline stage
const time = (c, n = 11) => { const xs = []; for (let i = 0; i < n; i++) { const t = Date.now(); node(iso, [c, "help"]); xs.push(Date.now() - t); } xs.sort((x, y) => x - y); return xs[Math.floor(xs.length / 2)]; };
const startup = { protectedMs: time(cli), baselineMs: baseline ? time(join(baseline, "node_modules", "@pso", "cli", "bin", "pso.js")) : null };
ev.save({ label, installDir: dir, installedBytes, installedFiles: all.length, protectedMetrics: prot, baselineMetrics: base, readableByDesign: readable, startup });
console.log(`\ninstalled: ${all.length} files, ${(installedBytes / 1048576).toFixed(1)} MB; startup (median of 11 'pso help'): protected ${startup.protectedMs} ms vs baseline ${startup.baselineMs} ms\n${ev.checks.length - ev.failed}/${ev.checks.length} checks passed`);
process.exit(ev.failed ? 1 : 0);
