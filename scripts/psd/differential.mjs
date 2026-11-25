// PSD differential test: the SAME scripted workflow is run through two CLIs (for example the development build and the protected distribution)
// in separate temporary workspaces. Exit codes, normalised output and the generated file trees must be identical.
//
//   node scripts/psd/differential.mjs --a <path/to/pso.js> --b <path/to/pso.js> [--report <json>] [--keep]
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? undefined : process.argv[i + 1]; };
const A = arg("a"), B = arg("b");
if (!A || !B) { console.error("usage: node scripts/psd/differential.mjs --a <pso.js> --b <pso.js> [--report <json>] [--keep]"); process.exit(2); }

// [relative working directory, argv, "tree" to also record the tree after]
const SCENARIO = [
  [".", ["create", "workspace", "shop"]],
  ["shop", ["create", "orchestrator", "gateway"]],
  ["shop", ["create", "service", "catalog", "--port", "8081"]],
  ["shop", ["create", "service", "orders", "--port", "8082"]],
  ["shop", ["make:module", "products", "--service", "gateway"]],
  ["shop", ["make:controller", "products", "--service", "gateway"]],
  ["shop", ["make:dto", "products", "product", "--fields", "name:string:min=3,price:number,sku?:string", "--service", "gateway"]],
  ["shop", ["make:service", "products", "--service", "gateway"]],
  ["shop", ["make:guard", "products", "admin", "--service", "gateway"]],
  ["shop", ["make:route", "products", "list", "--method", "GET", "--path", "/", "--guard", "jwt", "--scopes", "products:read", "--upstream", "catalog", "--service", "gateway"]],
  ["shop", ["make:middleware", "audit", "--service", "gateway"]],
  ["shop", ["make:filter", "problems", "--service", "gateway"]],
  ["shop", ["make:hook", "warmup", "--service", "gateway"]],
  ["shop", ["make:config", "limits", "--service", "gateway"]],
  ["shop", ["create", "fei", "storefront"]],
  ["shop", ["create", "mei", "catalog-ui"]],
  ["shop", ["create", "mei", "orders-ui"]],
  ["shop", ["fei:register", "catalog-ui", "--path", "/catalog", "--scopes", "catalog:read"]],
  ["shop", ["fei:register", "orders-ui", "--path", "/orders", "--scopes", "orders:read"]],
  // read-only analysis of everything generated above
  ["shop", ["inspect", "--service", "gateway"]],
  ["shop", ["services:list"]],
  ["shop", ["services:graph"]],
  ["shop", ["graph"]],
  ["shop", ["routes:list"]],
  ["shop", ["security:policy"]],
  ["shop", ["config:list"]],
  ["shop", ["config:validate"]],
  ["shop", ["lint"]],
  ["shop", ["dispatch:providers"]],
  ["shop", ["dispatch:validate"]],
  ["shop", ["frontend:validate"]],
  ["shop", ["frontend:inspect"]],
  ["shop", ["frontend:routes"]],
  ["shop", ["frontend:graph"]],
  ["shop", ["deploy:init", "--target", "kubernetes"]],
  ["shop", ["docker:init"]],
  ["shop", ["environment:add", "staging", "--connection", "staging-vm", "--repo", "https://git.example.com/shop.git"]],
  ["shop", ["pipeline:validate"]],
  ["shop", ["environment:list"]],
  ["shop", ["ai:context"]],
  ["shop", ["help", "create"]],
  ["shop", ["docs", "--build", "docs-site"]],
];

function walk(d, acc = []) {
  for (const n of readdirSync(d).sort()) {
    if (n === "node_modules" || n === ".git") continue;
    const f = join(d, n);
    statSync(f).isDirectory() ? walk(f, acc) : acc.push(f);
  }
  return acc;
}

function runScenario(cli, label) {
  const base = mkdtempSync(join(tmpdir(), `psd-diff-${label}-`));
  const fw = resolve(cli, "..", "..", "..").replace(/\\/g, "/"); // .../packages  or  .../node_modules/@pso  (where the framework packages live)
  const norm = (s) => s
    .replaceAll(base.replace(/\\/g, "/"), "<T>").replaceAll(base, "<T>")
    .replaceAll(fw, "<FW>").replaceAll(fw.replace(/\//g, "\\"), "<FW>")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<TS>").replace(/\b\d+(\.\d+)?\s?ms\b/g, "<MS>").replace(/\r\n/g, "\n")
    .replace(/[0-9a-f]{40,64}/g, "<HASH>");
  const results = [];
  for (const [cwd, argv] of SCENARIO) {
    const dir = join(base, cwd); mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [cli, ...argv], { cwd: dir, encoding: "utf8", timeout: 180_000, windowsHide: true, env: { ...process.env, PSO_LOG_COLOR: "never", NO_COLOR: "1" } });
    results.push({ cmd: argv.join(" "), code: r.status, out: norm((r.stdout ?? "") + "\n--stderr--\n" + (r.stderr ?? "")), ms: Date.now() - t0 });
  }
  const tree = {};
  for (const f of walk(join(base, "shop"))) {
    const rel = relative(join(base, "shop"), f).split(sep).join("/");
    if (/(^|\/)keys\/|\.pem$|\.private/.test(rel)) continue;
    const buf = readFileSync(f);
    tree[rel] = createHash("sha256").update(/^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(buf.toString("utf8").slice(0, 4000)) ? Buffer.from(norm(buf.toString("utf8"))) : buf).digest("hex").slice(0, 16);
  }
  return { base, results, tree };
}

const ra = runScenario(A, "a"), rb = runScenario(B, "b");
const diffs = [];
ra.results.forEach((x, i) => { const y = rb.results[i]; if (x.code !== y.code) diffs.push(`exit code differs for "${x.cmd}": ${x.code} vs ${y.code}`); else if (x.out !== y.out) diffs.push(`output differs for "${x.cmd}"`); });
for (const k of new Set([...Object.keys(ra.tree), ...Object.keys(rb.tree)])) if (ra.tree[k] !== rb.tree[k]) diffs.push(`generated file differs: ${k}${ra.tree[k] ? "" : " (missing in A)"}${rb.tree[k] ? "" : " (missing in B)"}`);
const failing = ra.results.filter((x) => x.code !== 0);
const summary = { commands: SCENARIO.length, files: Object.keys(ra.tree).length, filesB: Object.keys(rb.tree).length, differences: diffs.length, nonZeroInA: failing.map((x) => `${x.cmd} -> ${x.code}`), msA: ra.results.reduce((s, x) => s + x.ms, 0), msB: rb.results.reduce((s, x) => s + x.ms, 0) };
console.log(JSON.stringify(summary, null, 2));
for (const d of diffs.slice(0, 40)) console.log("  DIFF " + d);
if (arg("report")) writeFileSync(resolve(arg("report")), JSON.stringify({ summary, diffs, a: ra.results.map(({ cmd, code, ms }) => ({ cmd, code, ms })), b: rb.results.map(({ cmd, code, ms }) => ({ cmd, code, ms })) }, null, 2));
if (process.argv.includes("--keep")) console.log(`kept: ${ra.base} ${rb.base}`); else { rmSync(ra.base, { recursive: true, force: true }); rmSync(rb.base, { recursive: true, force: true }); }
process.exit(diffs.length ? 1 : 0);
