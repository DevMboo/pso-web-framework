// PSD JavaScript protection. Produces an OVERLAY tree: the protected replacement of the files the distribution allowlist takes from packages/*/dist,
// studio and portal. It never modifies the repository (`npm run build` output stays the readable development build).
//
//   node scripts/psd/protect.mjs --out <overlay dir> [--report <json>]
//
// Profiles (per package, evidence in docs/implementation/psd-protection-compatibility.md):
//   A  framework implementation (cli, deploy, frontend): the compiled output is split-bundled per public entry point, internal identifiers are
//      mangled, syntax and whitespace are minified, comments and source-map references are dropped. Public export NAMES are preserved
//      (esbuild keeps the names an entry exports), bare imports stay external (so peer packages, optional drivers and `typescript` resolve as before),
//      and `import.meta.url` is rewritten to the URL the module had BEFORE bundling, so the resource lookups relative to it keep working.
//   B  public SDK (core, http, security, dispatch, channels, channels-client, react-channels, frontend-client, frontend-react): comments and
//      whitespace only. No identifier mangling: decorators, `reflect-metadata` design types and class/function names stay exactly as developers see them.
//   S  browser assets (Studio, documentation portal scripts and styles): per-file minification; ES module structure unchanged.
// Property-name mangling, control-flow flattening and string encoding are NOT applied: see the compatibility report for why.
import { build, transform } from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const out = resolve(flag("out") ?? "");
if (!flag("out")) { console.error("usage: node scripts/psd/protect.mjs --out <overlay dir> [--report <json>]"); process.exit(2); }
if (existsSync(out) && readdirSync(out).length) { console.error(`the overlay directory is not empty: ${out}`); process.exit(2); }
if (!relative(root, out).startsWith("..") && !isAbsolute(relative(root, out))) { console.error("the overlay must be outside the repository"); process.exit(2); }

const PROFILE_A = { cli: ["main", "maintenance"], deploy: ["index"], frontend: ["index", "node", "release"], infra: ["index"] };
// Profile A+: selective extra transforms (string table with base64 decoding, control-flow flattening on 30% of the functions) applied BEFORE bundling to the
// modules that hold the core algorithms (deployment engine and policy, release signing, FEI/MEI release engine, static analysis and generators).
// Not applied: the installer, package format and key handling (they must stay auditable), command wiring, anything that runs in the browser. Not enabled:
// self-defending, debug protection, console output removal or any other anti-debugging/anti-tamper option (rejected by the PSD scope), property renaming
// (breaks JSON/reflection contracts) and object-key transformation.
const OBFUSCATE = {
  deploy: ["agent/engine.js", "agent/plan.js", "agent/visibility.js", "agent/auth.js", "agent/state.js", "agent/systemd.js", "agent/nginx.js", "signing.js", "declare.js", "policy-compat.js", "agent-releases.js"],
  frontend: ["release.js", "nginx.js", "validate.js"],
  cli: ["http-static.js", "dispatch-static.js", "http-gen.js", "spring-config.js", "frontend-contracts.js", "studio-data.js", "studio-cloud.js"],
};
const OBF_OPTIONS = { compact: true, simplify: true, target: "node", sourceType: "module", ignoreImports: true, renameGlobals: false, renameProperties: false, transformObjectKeys: false, selfDefending: false, debugProtection: false, disableConsoleOutput: false, sourceMap: false, identifierNamesGenerator: "hexadecimal", numbersToExpressions: false, unicodeEscapeSequence: false, stringArray: true, stringArrayEncoding: ["base64"], stringArrayThreshold: 0.75, stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 2, splitStrings: false, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.3, deadCodeInjection: false };
const wantObfuscation = a.includes("--obfuscate");
let Obfuscator = null;
if (wantObfuscation) {
  const toolsDir = process.env.PSD_TOOLS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pso-psd", "tools");
  try { Obfuscator = createRequire(join(toolsDir, "package.json"))("javascript-obfuscator"); }
  catch { console.error(`--obfuscate needs javascript-obfuscator installed in ${toolsDir} (maintainer tooling, never part of the repository or an artifact)`); process.exit(2); }
}
const PROFILE_B = ["core", "http", "security", "dispatch", "channels", "channels-client", "react-channels", "frontend-client", "frontend-react"];
const posix = (p) => p.split(sep).join("/");
const walk = (d, acc = []) => { if (!existsSync(d)) return acc; for (const n of readdirSync(d).sort()) { const f = join(d, n); statSync(f).isDirectory() ? walk(f, acc) : acc.push(f); } return acc; };
const put = (rel, data) => { const f = join(out, ...rel.split("/")); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); };
const report = { generatedAt: new Date().toISOString(), esbuild: (await import("esbuild")).version, packages: {}, assets: {} };

// ---- metrics: how readable is a set of JS files? (indicative, not a security measure)
const KEYWORDS = new Set("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield await async of static get set null true false undefined".split(" "));
function metrics(files) {
  let bytes = 0, lines = 0, idTotal = 0, idShort = 0, idLen = 0;
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    bytes += Buffer.byteLength(t); lines += t.split("\n").length;
    for (const m of t.matchAll(/(?<![.\w$"'`])[A-Za-z_$][\w$]*/g)) { if (KEYWORDS.has(m[0])) continue; idTotal++; idLen += m[0].length; if (m[0].length <= 2) idShort++; }
  }
  return { files: files.length, bytes, lines, avgLineLength: Math.round(bytes / Math.max(1, lines)), identifiers: idTotal, meanIdentifierLength: +(idLen / Math.max(1, idTotal)).toFixed(2), shortIdentifierShare: +(idShort / Math.max(1, idTotal)).toFixed(3) };
}
const jsIn = (dir) => walk(dir).filter((f) => /\.(m?js|cjs)$/.test(f) && !f.endsWith(".map"));

// ---- profile A
// import.meta.url of an original module becomes the URL that module had before bundling (its compiled path), resolved against the bundle's own location
const virtualUrl = (distRoot) => ({
  name: "psd-virtual-import-meta-url",
  setup(b) {
    b.onLoad({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith(distRoot)) return null;
      let text = readFileSync(args.path, "utf8");
      if (!text.includes("import.meta.url")) return null;
      const rel = "./" + posix(relative(distRoot, args.path));
      text = text.split("import.meta.url").join(`new URL(${JSON.stringify(rel)}, import.meta.url).href`);
      return { contents: text, loader: "js" };
    });
  },
});
const workDirs = [], roots = {};
for (const [pkg, entries] of Object.entries(PROFILE_A)) {
  const pkgDir = join(root, "packages", pkg), devDist = join(pkgDir, "dist");
  const before = metrics(jsIn(devDist));
  let distRoot = devDist;
  const obfuscated = [];
  if (Obfuscator) {
    // work on a copy: the development build output is never modified
    const work = mkdtempSync(join(tmpdir(), `psd-obf-${pkg}-`)); workDirs.push(work);
    cpSync(devDist, work, { recursive: true });
    for (const rel of OBFUSCATE[pkg] ?? []) {
      const file = join(work, ...rel.split("/"));
      if (!existsSync(file)) throw new Error(`obfuscation list names a module that does not exist: ${pkg}/${rel}`);
      writeFileSync(file, Obfuscator.obfuscate(readFileSync(file, "utf8"), OBF_OPTIONS).getObfuscatedCode());
      obfuscated.push(rel);
    }
    distRoot = work;
  }
  roots[pkg] = distRoot;
  const res = await build({
    entryPoints: entries.map((e) => join(distRoot, `${e}.js`)), outdir: join(out, "packages", pkg, "dist"), outbase: distRoot,
    bundle: true, splitting: entries.length > 1, format: "esm", platform: "node", target: "node24", packages: "external",
    minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: true, keepNames: false, legalComments: "none", sourcemap: false, logLevel: "silent",
    plugins: [virtualUrl(distRoot)], absWorkingDir: root, write: true, metafile: true,
  });
  // public types of the packages whose declarations developers import (deploy: defineDeployment/definePipeline; frontend: contracts and node helpers).
  // The CLI has no public entry point: no declarations are shipped for it.
  let dts = 0;
  if (pkg !== "cli") for (const f of walk(devDist).filter((x) => x.endsWith(".d.ts"))) { put(`packages/${pkg}/dist/${posix(relative(devDist, f))}`, readFileSync(f)); dts++; }
  const after = metrics(jsIn(join(out, "packages", pkg, "dist")));
  report.packages[pkg] = { profile: obfuscated.length ? "A+" : "A", entries, obfuscatedModules: obfuscated, before, after, declarationsShipped: dts, outputs: Object.keys(res.metafile.outputs).map((o) => posix(relative(out, resolve(root, o)))) };
}

// ---- AG: the runtime agent that is uploaded to Linux servers. Same treatment as profile A/A+, built from the same (optionally obfuscated) work copies, bundled
// self-contained (the agent runs with nothing but Node.js on the server), without the "// packages/..." source path comments the development bundle carries.
{
  const agentOut = join(out, "packages", "deploy", "agent", "pso-agent.mjs");
  mkdirSync(dirname(agentOut), { recursive: true });
  await build({
    entryPoints: [join(roots.deploy, "agent", "main.js")], outfile: agentOut, bundle: true, platform: "node", format: "esm", target: "node24",
    alias: { "@pso/frontend/release": join(roots.frontend, "release.js"), "@pso/frontend": join(roots.frontend, "index.js") },
    minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: true, keepNames: false, legalComments: "none", sourcemap: false, logLevel: "silent",
    banner: { js: "#!/usr/bin/env node" }, absWorkingDir: root,
  });
  const bytes = readFileSync(agentOut);
  const dev = readFileSync(join(root, "packages", "deploy", "agent", "pso-agent.mjs"));
  const sum = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(out, "packages", "deploy", "agent", "pso-agent.sha256"), `${sum}  pso-agent.mjs\n`);
  report.agent = { profile: Obfuscator ? "A+" : "A", bytesDevelopmentBundle: dev.length, bytesProtected: bytes.length, sha256: sum, devMetrics: metrics([join(root, "packages", "deploy", "agent", "pso-agent.mjs")]), protectedMetrics: metrics([agentOut]) };
}

for (const w of workDirs) rmSync(w, { recursive: true, force: true });

// ---- profile B
for (const pkg of PROFILE_B) {
  const distRoot = join(root, "packages", pkg, "dist");
  const files = walk(distRoot);
  const before = metrics(jsIn(distRoot));
  for (const f of files) {
    const rel = posix(relative(distRoot, f));
    if (f.endsWith(".map")) continue;
    if (/\.(m?js|cjs)$/.test(f)) {
      const t = readFileSync(f, "utf8");
      const r = await transform(t, { loader: "js", format: "esm", target: "node24", minifyWhitespace: true, minifySyntax: false, minifyIdentifiers: false, legalComments: "none", keepNames: false });
      put(`packages/${pkg}/dist/${rel}`, r.code);
    } else put(`packages/${pkg}/dist/${rel}`, readFileSync(f));
  }
  const after = metrics(jsIn(join(out, "packages", pkg, "dist")));
  report.packages[pkg] = { profile: "B", before, after };
}

// ---- S: Studio and documentation portal browser assets
for (const dir of ["studio", "portal"]) {
  const base = join(root, "packages", "cli", dir);
  let n = 0, inB = 0, outB = 0;
  for (const f of walk(base)) {
    const rel = `packages/cli/${dir}/${posix(relative(base, f))}`, ext = extname(f).toLowerCase();
    const buf = readFileSync(f);
    if (ext === ".js" || ext === ".mjs") { const r = await transform(buf.toString("utf8"), { loader: "js", format: "esm", minify: true, legalComments: "none" }); put(rel, r.code); n++; inB += buf.length; outB += Buffer.byteLength(r.code); }
    else if (ext === ".css") { const r = await transform(buf.toString("utf8"), { loader: "css", minify: true, legalComments: "none" }); put(rel, r.code); n++; inB += buf.length; outB += Buffer.byteLength(r.code); }
    else put(rel, buf);
  }
  report.assets[dir] = { minifiedFiles: n, bytesBefore: inB, bytesAfter: outB };
}

// ---- T: pruned third-party packages. Only content that is provably unused by the product is left out; licence files always stay.
//   lucide-static: the product reads icons/<name>.svg only (documentation portal and Studio sprites). dist/ (ES/CJS bundles), font/ and the sprite are never read.
//     Of the icons, only those whose name appears as a string in the product's own code are kept. A name that is built at run time from data is covered
//     because the data lives in the same code; a missing icon makes the documentation build FAIL (it never renders blank), which the differential test exercises.
//   typescript: used through its API by the CLI and the deployment declaration loader. Removed: the 13 localized message directories (only used with
//     "tsc --locale") and the language-server entry points. lib/typescript.js, tsc and every lib.*.d.ts stay.
{
  const nm = join(root, "node_modules");
  const sizeOf = (files) => files.reduce((s, x) => s + statSync(x).size, 0);
  const luc = join(nm, "lucide-static");
  const iconFiles = walk(join(luc, "icons")).filter((x) => x.endsWith(".svg"));
  const available = new Map(iconFiles.map((x) => [x.slice(x.lastIndexOf(sep) + 1, -4), x]));
  const names = new Set();
  const code = [...walk(join(root, "packages", "cli", "dist")).filter((x) => /\.js$/.test(x)), ...walk(join(root, "packages", "cli", "studio")).filter((x) => /\.(js|html)$/.test(x)), ...walk(join(root, "packages", "cli", "portal")).filter((x) => /\.(js|html|css)$/.test(x))];
  for (const file of code) for (const m of readFileSync(file, "utf8").matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)["'`]/g)) if (available.has(m[1])) names.add(m[1]);
  // icon names written in documentation front matter (section icons) are part of the same candidate set
  for (const md of walk(join(root, "packages", "cli", "docs")).filter((x) => x.endsWith(".md"))) for (const m of readFileSync(md, "utf8").slice(0, 2000).matchAll(/^icon:\s*([a-z0-9-]+)/gm)) if (available.has(m[1])) names.add(m[1]);
  const kept = [...names].sort();
  for (const n of kept) put(`node_modules/lucide-static/icons/${n}.svg`, readFileSync(available.get(n)));
  for (const keep of ["LICENSE", "package.json"]) put(`node_modules/lucide-static/${keep}`, readFileSync(join(luc, keep)));
  const lucideAll = walk(luc);
  report.pruned = { "lucide-static": { version: JSON.parse(readFileSync(join(luc, "package.json"), "utf8")).version, bytesBefore: sizeOf(lucideAll), filesBefore: lucideAll.length, iconsAvailable: available.size, iconsKept: kept.length, bytesAfter: sizeOf(kept.map((n) => available.get(n))), removed: "dist/, font/, sprite.svg, icon-nodes.json, tags.json, README, build config, unreferenced icons" } };

  const tsDir = join(nm, "typescript");
  const REMOVE_TS = [/^lib\/(cs|de|es|fr|it|ja|ko|pl|pt-br|ru|tr|zh-cn|zh-tw)\//, /^lib\/(_tsserver|tsserver|tsserverlibrary|typingsInstaller|_typingsInstaller|watchGuard|cancellationToken)\.js$/, /^lib\/tsserverlibrary\.d\.ts$/, /^bin\/tsserver$/];
  const tsAll = walk(tsDir);
  let removedBytes = 0, kept2 = 0;
  for (const file of tsAll) {
    const rel = posix(relative(tsDir, file));
    if (REMOVE_TS.some((re) => re.test(rel))) { removedBytes += statSync(file).size; continue; }
    put(`node_modules/typescript/${rel}`, readFileSync(file)); kept2++;
  }
  report.pruned.typescript = { version: JSON.parse(readFileSync(join(tsDir, "package.json"), "utf8")).version, bytesBefore: sizeOf(tsAll), filesBefore: tsAll.length, filesKept: kept2, bytesRemoved: removedBytes, removed: "13 localized message directories, language-server entry points" };
}

if (flag("report")) writeFileSync(resolve(flag("report")), JSON.stringify(report, null, 2));
for (const [p, r] of Object.entries(report.packages)) console.log(`${r.profile} ${p.padEnd(16)} ${String(r.before.files).padStart(4)} -> ${String(r.after.files).padStart(3)} files  ${(r.before.bytes / 1024).toFixed(0).padStart(5)} -> ${(r.after.bytes / 1024).toFixed(0).padStart(5)} KB  ident.len ${r.before.meanIdentifierLength} -> ${r.after.meanIdentifierLength}  short ${(r.before.shortIdentifierShare * 100).toFixed(0)}% -> ${(r.after.shortIdentifierShare * 100).toFixed(0)}%`);
for (const [d, r] of Object.entries(report.assets)) console.log(`S ${d.padEnd(16)} ${r.minifiedFiles} files  ${(r.bytesBefore / 1024).toFixed(0)} -> ${(r.bytesAfter / 1024).toFixed(0)} KB`);
for (const [p, r] of Object.entries(report.pruned ?? {})) console.log(`T ${p.padEnd(16)} ${((r.bytesBefore) / 1048576).toFixed(1)} MB${r.iconsKept !== undefined ? ` -> ${(r.bytesAfter / 1048576).toFixed(2)} MB (${r.iconsKept} of ${r.iconsAvailable} icons)` : ` -> ${((r.bytesBefore - r.bytesRemoved) / 1048576).toFixed(1)} MB`}`);
if (report.agent) console.log(`AG pso-agent.mjs    ${(report.agent.bytesDevelopmentBundle / 1024).toFixed(0)} KB -> ${(report.agent.bytesProtected / 1024).toFixed(0)} KB, lines ${report.agent.devMetrics.lines} -> ${report.agent.protectedMetrics.lines}, short identifiers ${(report.agent.devMetrics.shortIdentifierShare * 100).toFixed(0)}% -> ${(report.agent.protectedMetrics.shortIdentifierShare * 100).toFixed(0)}%`);
