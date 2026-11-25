// Packages the generated orchestrator for deployment: compiled output + the runtime dependency CLOSURE (including transitive dependencies that
// npm hoisted outside the project, such as those of the @pso packages), copied rather than linked so the tarball is self-contained.
//   node package-gateway.mjs <workspace-dir> <artifacts-dir> <tarball-name>
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const [ws, art, name = "gateway.tgz"] = process.argv.slice(2);
const g = join(ws, "gateway"); const stage = join(art, `${name.replace(/\.tgz$/, "")}-stage`);
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
cpSync(join(g, "dist"), join(stage, "dist"), { recursive: true }); cpSync(join(g, "package.json"), join(stage, "package.json")); if (existsSync(join(g, "pso.config.json"))) cpSync(join(g, "pso.config.json"), join(stage, "pso.config.json")); cpSync(join(ws, "pso.workspace.json"), join(stage, "pso.workspace.json"));

const find = (dep, from) => { let d = from; for (;;) { const p = join(d, "node_modules", dep); if (existsSync(join(p, "package.json"))) return realpathSync(p); const up = dirname(d); if (up === d) return undefined; d = up; } };
const closure = new Map();
const visit = (dir) => {
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of [...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.optionalDependencies ?? {})]) {
    if (closure.has(dep)) continue; const p = find(dep, dir); if (!p) continue; closure.set(dep, p); visit(p);
  }
};
visit(realpathSync(g));
for (const [dep, p] of closure) cpSync(p, join(stage, "node_modules", dep), { recursive: true, dereference: true, filter: (s) => !/[\\/]\.cache([\\/]|$)/.test(s) });
const r = spawnSync("tar", ["-czf", name, "-C", `${name.replace(/\.tgz$/, "")}-stage`, "."], { cwd: art, encoding: "utf8", windowsHide: true });
if (r.status !== 0) throw new Error(r.stderr);
console.log(JSON.stringify({ tarball: join(art, name), packages: [...closure.keys()].sort() }));
