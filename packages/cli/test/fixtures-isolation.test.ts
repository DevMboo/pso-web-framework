import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The fixtures/ directory holds validation workloads. The framework never depends on them and no distribution contains them. */
const root = join(import.meta.dirname, "..", "..", "..");
const SKIP = new Set(["node_modules", "dist", "target", ".git", "release", "release-out"]);
const walk = (dir: string, accept: (f: string) => boolean, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) { if (SKIP.has(e)) continue; const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, accept, out); else if (accept(e)) out.push(p); }
  return out;
};

test("fixtures/ exists with one README per fixture and no leftover root-level fixture directories", () => {
  assert.ok(existsSync(join(root, "fixtures", "README.md")));
  for (const d of ["pso-commerce", "pso-cloud-validation", "contracts"]) assert.ok(existsSync(join(root, "fixtures", d, "README.md")), `fixtures/${d}/README.md`);
  const stray = readdirSync(root).filter((n) => /-fixtures$/.test(n));
  assert.deepEqual(stray, [], "contract fixtures belong in fixtures/contracts/, validation projects in fixtures/<name>/");
});

test("the framework's sources and package manifests never import or reference fixture application code", () => {
  const offenders: string[] = [];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const src = join(root, "packages", pkg, "src");
    if (existsSync(src)) for (const f of walk(src, (n) => /\.(ts|tsx|js|mjs)$/.test(n))) if (/fixtures\//.test(readFileSync(f, "utf8").replace(/Shared cross-language fixtures live in [^\n]*/g, ""))) offenders.push(relative(root, f));
  }
  assert.deepEqual(offenders, []);
});

test("distribution manifest and package allow-lists contain nothing from fixtures/", () => {
  assert.ok(!/fixtures/.test(readFileSync(join(root, "dist.config.json"), "utf8")), "dist.config.json must not name fixtures/");
  for (const pkg of readdirSync(join(root, "packages"))) {
    const m = JSON.parse(readFileSync(join(root, "packages", pkg, "package.json"), "utf8")) as { files?: string[] };
    for (const f of m.files ?? []) assert.ok(!/fixtures/.test(f), `packages/${pkg} publishes ${f}`);
  }
});

test("the ignore rules cover the secrets and generated files of the fixtures", () => {
  const ig = readFileSync(join(root, ".gitignore"), "utf8");
  for (const needle of ["fixtures/**/node_modules/", "fixtures/**/.env", "fixtures/**/*.private.pem", "fixtures/**/.tls/", "fixtures/**/keys/", "fixtures/pso-cloud-validation/artifacts/"]) assert.ok(ig.includes(needle), needle);
});

test("the two Commerce fixtures keep distinct responsibilities, stated in their READMEs", () => {
  const read = (p: string) => readFileSync(join(root, "fixtures", p), "utf8");
  assert.match(read("pso-commerce/README.md"), /Responsibility: functional application and distributed-ecosystem validation/);
  assert.match(read("pso-cloud-validation/README.md"), /Responsibility: cloud deployment, infrastructure, operational security and remote management/);
  assert.match(read("README.md"), /deliberately separate/);
  // no cloud/infrastructure scenario in the functional fixture, no functional acceptance suite in the cloud one
  assert.ok(existsSync(join(root, "fixtures", "pso-commerce", "acceptance.mjs")));
  assert.ok(!existsSync(join(root, "fixtures", "pso-commerce", "scenarios")) && !existsSync(join(root, "fixtures", "pso-commerce", "deploy")));
  assert.ok(!existsSync(join(root, "fixtures", "pso-cloud-validation", "acceptance.mjs")));
});

test("the cloud scenarios take host, user, key and paths from the environment, never from literals", () => {
  const dir = join(root, "fixtures", "pso-cloud-validation", "scenarios");
  const scripts = walk(dir, (n) => /\.(mjs|sh)$/.test(n));
  assert.ok(scripts.length >= 14, `expected the ported scenarios, found ${scripts.length}`);
  const bad: string[] = [];
  for (const f of scripts) {
    const t = readFileSync(f, "utf8");
    if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(t.replace(/127\.0\.0\.1|0\.0\.0\.0|203\.0\.113\.\d+/g, ""))) bad.push(`${relative(root, f)}: IP literal`);
    if (/azure-keys|azureuser|\b[A-Za-z]:[\\/]+(?:Users|azure|Projetos)/.test(t)) bad.push(`${relative(root, f)}: machine-specific path or user`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) bad.push(`${relative(root, f)}: private key`);
  }
  assert.deepEqual(bad, []);
  assert.match(readFileSync(join(dir, "config.mjs"), "utf8"), /process\.env\.ECV_HOST/);
});

test("the Commerce web playground is dependency-free, safe by construction, and carries no secret", () => {
  const dir = join(root, "fixtures", "pso-commerce", "web");
  const files = walk(dir, (n) => /\.(js|html|css)$/.test(n)); assert.ok(files.length >= 7, "index.html, styles.css and five modules");
  const bad: string[] = [];
  for (const f of files) {
    const t = readFileSync(f, "utf8"); const rel = relative(root, f);
    if (/\.(js|html)$/.test(f) && /\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\(|new Function\(/.test(t)) bad.push(`${rel}: unsafe HTML or dynamic code`);
    if (/\.js$/.test(f) && /^\s*import\b[^;]*from\s+["'](?!\.\/)/m.test(t)) bad.push(`${rel}: imports something that is not a sibling file`);
    if (/<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=["']|style=["']/i.test(t) && f.endsWith(".html")) bad.push(`${rel}: inline script, handler or style`);
    if (/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org)/.test(t.replace(/<!--[\s\S]*?-->/g, "")) && !f.endsWith(".css")) bad.push(`${rel}: hard-coded remote origin`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.|Authorization:\s*Bearer|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(t.replace(/127\.0\.0\.1/g, ""))) bad.push(`${rel}: a secret, token, authorization header literal or IP address`);
  }
  assert.deepEqual(bad, []);
  assert.ok(!existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules")), "no package manifest, no build tooling");
});

test("the gateway serves the playground from a fixed list of assets, never a path built from the request", () => {
  const src = readFileSync(join(root, "fixtures", "pso-cloud-validation", "gateway", "src", "routes", "playground", "playground.controller.ts"), "utf8");
  assert.match(src, /Object\.hasOwn\(ASSETS, name\)/); assert.match(src, /content-security-policy/); assert.match(src, /frame-ancestors 'none'/);
  assert.match(readFileSync(join(root, "fixtures", "pso-cloud-validation", "gateway", "src", "routes", "playground", "ROUTES.pso.ts"), "utf8"), /security: \{ public: true \}/);
});
