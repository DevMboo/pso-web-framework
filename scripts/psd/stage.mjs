// PSD isolated staging. Builds the distribution stage from the explicit allowlist in dist.config.json, classifying EVERY file with policy.mjs.
//   - restricted (E) files are dropped and listed; unknown files fail the build; links/junctions and paths that leave the workspace fail it;
//   - the stage directory must be new/empty and OUTSIDE the repository;
//   - a canonical manifest (path, size, sha256, class, rule) is written next to the stage, never inside it.
//
//   node scripts/psd/stage.mjs --out <dir> [--config dist.config.json] [--source-root <dir>] [--overlay <protected build dir>]
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { classify, THIRD_PARTY } from "./policy.mjs";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const posix = (p) => p.split(sep).join("/");
const inside = (root, p) => { const r = relative(root, p); return r === "" || (!r.startsWith("..") && !/^[A-Za-z]:/.test(r)); };

export function buildStage({ out, config = join(repoRoot, "dist.config.json"), sourceRoot = repoRoot, overlay }) {
  const problems = [];
  const outAbs = resolve(out), srcAbs = realpathSync(sourceRoot);
  if (inside(srcAbs, outAbs)) throw new Error(`the stage must be outside the repository (${outAbs})`);
  if (existsSync(outAbs) && readdirSync(outAbs).length) throw new Error(`the stage directory is not empty: ${outAbs}`);
  const cfg = JSON.parse(readFileSync(config, "utf8"));
  mkdirSync(outAbs, { recursive: true });

  const entries = [], dropped = [], unknown = [], links = [];
  const seen = new Map();
  const add = (from, destRel) => {
    const cls = classify(destRel);
    if (!cls) { unknown.push(destRel); return; }
    if (cls.cls === "E") { dropped.push({ path: destRel, rule: cls.id, note: cls.note }); return; }
    if (seen.has(destRel.toLowerCase())) { problems.push(`duplicate destination (case-insensitive): ${destRel}`); return; }
    seen.set(destRel.toLowerCase(), true);
    let data = readFileSync(from);
    const target = join(outAbs, ...destRel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    const transforms = [];
    // the maps are dropped (E-source-map), so the trailing reference comment would dangle and point at internal layout
    if (/\.(?:m?js|cjs|css)$/i.test(destRel)) {
      const text = data.toString("utf8");
      const stripped = text.replace(/(?:\r?\n)?\s*(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=(?!data:)[^\r\n]*?(?:\*\/)?[ \t]*(?:\r?\n)?\s*$/, "\n");
      if (stripped !== text) { data = Buffer.from(stripped, "utf8"); transforms.push("strip-sourcemap-comment"); }
    }
    if (transforms.length) writeFileSync(target, data); else copyFileSync(from, target);
    entries.push({ path: destRel, size: data.length, sha256: sha256(data), class: cls.cls, rule: cls.id, ...(transforms.length ? { transforms } : {}) });
  };

  const walk = (dir, mapRel) => {
    for (const n of readdirSync(dir).sort()) {
      const full = join(dir, n), st = lstatSync(full);
      if (st.isSymbolicLink()) { links.push(posix(relative(dir, full))); continue; }
      if (st.isDirectory()) walk(full, mapRel); else if (st.isFile()) add(full, mapRel(full));
    }
  };

  const overlayAbs = overlay ? realpathSync(overlay) : undefined;
  const overlaid = [];
  for (const comp of cfg.components) for (const inc of comp.include) {
    // a protected build replaces the development build output at the same repository-relative path; everything else comes from the repository
    const ovPath = overlayAbs ? resolve(overlayAbs, inc.from) : undefined;
    const useOverlay = !!ovPath && inside(overlayAbs, ovPath) && existsSync(ovPath);
    const base = useOverlay ? overlayAbs : srcAbs;
    if (useOverlay) overlaid.push(inc.from);
    const from = resolve(base, inc.from);
    if (!inside(base, from)) { problems.push(`"${inc.from}" is outside the workspace`); continue; }
    if (!existsSync(from)) { problems.push(`allowlisted path not found: ${inc.from}`); continue; }
    const real = realpathSync(from);
    if (!inside(base, real)) { problems.push(`"${inc.from}" resolves outside the workspace (link or junction)`); continue; }
    const to = inc.to.replace(/\/+$/, "");
    if (lstatSync(from).isDirectory()) walk(from, (f) => `${to}/${posix(relative(from, f))}`.replace(/^\/+/, ""));
    else add(from, `${to}/${posix(from).split("/").pop()}`.replace(/^\/+/, ""));
  }
  if (links.length) problems.push(`${links.length} symbolic link(s) or junction(s) in allowlisted trees (e.g. ${links[0]}); links are never followed`);
  if (unknown.length) problems.push(`${unknown.length} file(s) match no classification rule (e.g. ${unknown.slice(0, 3).join(", ")})`);
  // third-party packages must carry their licence text
  for (const p of THIRD_PARTY) {
    const base = `node_modules/${p}/`;
    if (entries.some((e) => e.path.startsWith(base)) && !entries.some((e) => e.path.startsWith(base) && /^(licen[cs]e|copying)(\.|$)/i.test(e.path.slice(base.length)))) problems.push(`third-party package "${p}" is staged without a licence file`);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byClass = {};
  for (const e of entries) { byClass[e.class] ??= { files: 0, bytes: 0 }; byClass[e.class].files++; byClass[e.class].bytes += e.size; }
  const manifest = { schema: 1, name: cfg.name, version: cfg.version, overlaid, files: entries.length, byClass, dropped: dropped.length, droppedByRule: dropped.reduce((a, d) => ((a[d.rule] = (a[d.rule] ?? 0) + 1), a), {}), unknown, problems, entries };
  const manifestFile = `${outAbs}.stage-manifest.json`;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  if (problems.length) { rmSync(outAbs, { recursive: true, force: true }); }
  return { ok: problems.length === 0, manifestFile, manifest, problems };
}

if (process.argv[1]?.endsWith("stage.mjs")) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
  if (!flag("out")) { console.error("usage: node scripts/psd/stage.mjs --out <dir> [--config <file>] [--source-root <dir>]"); process.exit(2); }
  try {
    const r = buildStage({ out: flag("out"), ...(flag("config") ? { config: flag("config") } : {}), ...(flag("source-root") ? { sourceRoot: flag("source-root") } : {}), ...(flag("overlay") ? { overlay: flag("overlay") } : {}) });
    const m = r.manifest;
    console.log(`${r.ok ? "STAGED" : "FAILED"}  ${m.files} file(s); dropped as restricted: ${m.dropped}`);
    for (const [c, v] of Object.entries(m.byClass)) console.log(`  class ${c}: ${v.files} files, ${(v.bytes / 1048576).toFixed(1)} MB`);
    for (const [k, v] of Object.entries(m.droppedByRule)) console.log(`  dropped ${String(v).padStart(5)}  ${k}`);
    for (const p of r.problems) console.log(`  PROBLEM: ${p}`);
    console.log(`manifest: ${r.manifestFile}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
}
