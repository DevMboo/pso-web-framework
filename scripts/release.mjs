#!/usr/bin/env node
// PSO release preparation. It PACKS, CHECKSUMS, INVENTORIES and (only when you supply a key) SIGNS. It never publishes anything.
//
//   node scripts/release.mjs npm  [--out <dir>] [--sign-key <ed25519 private pem>] [--skip-install-test] [--skip-audit]
//
// Output (default release-out/npm): the five tarballs, SHA256SUMS, manifest.json, sbom.cdx.json, licenses.json, provenance.json,
// secret-scan.json, audit.json and, with a key, SHA256SUMS.sig + manifest.json.sig. Each stage records PASSED / FAILED / NOT RUN honestly.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };
const PACKAGES = ["core", "security", "dispatch", "http", "channels-client", "react-channels", "channels", "deploy", "frontend", "frontend-client", "frontend-react", "infra", "cli"];
const sha = (b) => createHash("sha256").update(b).digest("hex");
// npm is a JavaScript program next to node: it is run with the current Node binary, with an argument array and no shell (on
// Windows `npm` is a batch wrapper, and starting it through a shell concatenates the arguments into one command string)
const npm = "npm";
const npmCli = [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((f) => existsSync(f));
const run = (c, a, o = {}) => {
  const opts = { encoding: "utf8", timeout: 300_000, maxBuffer: 256 * 1024 * 1024, ...o };
  if (c !== npm) return spawnSync(c, a, opts);
  if (npmCli) return spawnSync(process.execPath, [npmCli, ...a], opts);
  return process.platform === "win32" ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...a], opts) : spawnSync("npm", a, opts);
};
const stages = [];
const stage = (name, status, detail) => { stages.push({ name, status, detail }); console.log(`${status.padEnd(8)} ${name}${detail ? ` - ${detail}` : ""}`); };

if (cmd !== "npm") { console.error("usage: node scripts/release.mjs npm [--out <dir>] [--sign-key <file>] [--skip-install-test] [--skip-audit]"); process.exit(1); }

const out = resolve(typeof flag("out") === "string" ? flag("out") : join(root, "release-out", "npm"));
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });

// 1. pack (twice in different directories: npm normalises timestamps, so the bytes must match)
const packInto = (dir) => {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const p of PACKAGES) {
    const r = run(npm, ["pack", "--json", "--pack-destination", dir], { cwd: join(root, "packages", p) });
    if (r.status !== 0) throw new Error(`npm pack failed for ${p}: ${r.stderr}`);
    files.push(JSON.parse(r.stdout)[0]);
  }
  return files;
};
const packed = packInto(out);
const check = packInto(mkdtempSync(join(tmpdir(), "pso-repack-")));
let identical = true;
for (let i = 0; i < packed.length; i++) { if (packed[i].integrity !== check[i].integrity) identical = false; }
stage("pack", "PASSED", `${packed.length} tarballs: ${packed.map((p) => `${p.name}@${p.version} (${p.files.length} files)`).join(", ")}`);
stage("reproducible tarballs", identical ? "PASSED" : "FAILED", identical ? "two independent packs have identical integrity" : "tarball bytes differ between two packs");

// 2. content policy: nothing but the allowlist; no source maps, tests, env files, keys
const bad = [];
for (const p of packed) for (const f of p.files) if (!f.path.startsWith("templates/") && !f.path.startsWith("docs/examples/") && /(^|\/)(test|tests)\/|\.tsbuildinfo$|\.map$|(^|\/)\.env|\.pem$|\.key$|\.p12$|(^|\/)\.git(\/|$)|(^|\/)\.pso(\/|$)/.test(f.path)) bad.push(`${p.name}: ${f.path}`);
stage("content policy", bad.length ? "FAILED" : "PASSED", bad.length ? bad.slice(0, 5).join("; ") : "no tests, maps, env files or key material in any tarball");

// 3. secret scan of every packed file (extracted to a scratch dir)
const SECRETS = [[/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, "private key"], [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"], [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"], [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"], [/\bsk-[A-Za-z0-9]{32,}\b/, "API secret key"], [/\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/, "JWT"]];
const scratch = mkdtempSync(join(tmpdir(), "pso-scan-"));
const findings = [];
for (const p of packed) {
  const d = join(scratch, p.name.replace(/[@/]/g, "_")); mkdirSync(d, { recursive: true });
  copyFileSync(join(out, p.filename), join(d, p.filename));
  const x = run("tar", ["-xzf", p.filename], { cwd: d });
  rmSync(join(d, p.filename));
  if (x.status !== 0) throw new Error(`cannot extract ${p.filename}: ${x.stderr}`);
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) { const t = readFileSync(f); if (t.length > 4_000_000) continue; const s = t.toString("latin1"); for (const [re, what] of SECRETS) if (re.test(s)) findings.push({ package: p.name, file: f.slice(d.length + 1), what }); } } };
  walk(d);
}
rmSync(scratch, { recursive: true, force: true });
writeFileSync(join(out, "secret-scan.json"), JSON.stringify({ patterns: SECRETS.map(([, w]) => w), findings }, null, 2));
// Documentation and templates legitimately contain *examples*; any finding is listed and must be reviewed, never silently ignored
stage("secret scan", findings.length ? "FAILED" : "PASSED", findings.length ? `${findings.length} finding(s): ${findings.slice(0, 3).map((f) => `${f.package}/${f.file} (${f.what})`).join("; ")}` : `${SECRETS.length} secret patterns, no findings`);

// 4. SBOM (CycloneDX from the lockfile) and licence inventory
const sbomRun = run(npm, ["sbom", "--sbom-format", "cyclonedx", "--sbom-type", "application", "--omit", "dev", "--package-lock-only"], { cwd: root });
let sbom = null;
if (sbomRun.status === 0) { try { sbom = JSON.parse(sbomRun.stdout); } catch { /* reported below */ } }
if (sbom) {
  writeFileSync(join(out, "sbom.cdx.json"), JSON.stringify(sbom, null, 2));
  const lic = (sbom.components ?? []).map((c) => ({ name: c.name, version: c.version, licenses: (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression ?? "unknown") }));
  for (const c of lic) if (PACKAGES.includes(c.name) && c.licenses.length === 0) c.licenses = ["MISSING: a PSO package without a license field (expected Apache-2.0)"];
  const unknown = lic.filter((c) => c.licenses.length === 0 || c.licenses.includes("unknown"));
  const counts = {}; for (const c of lic) for (const l of c.licenses.length ? c.licenses : ["unknown"]) counts[l] = (counts[l] ?? 0) + 1;
  writeFileSync(join(out, "licenses.json"), JSON.stringify({ scope: "production dependency tree from package-lock.json (dev dependencies omitted)", counts, unknown: unknown.map((c) => `${c.name}@${c.version}`), components: lic }, null, 2));
  stage("SBOM (CycloneDX)", "PASSED", `${sbom.components?.length ?? 0} components, production tree from package-lock.json`);
  stage("licence inventory", unknown.length ? "FAILED" : "PASSED", unknown.length ? `${unknown.length} component(s) without a declared licence: ${unknown.slice(0, 5).map((c) => c.name).join(", ")}` : `licences: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
} else { stage("SBOM (CycloneDX)", "FAILED", (sbomRun.stderr || "npm sbom produced no JSON").slice(0, 300)); }

// 5. vulnerability audit (needs the registry; reported as NOT RUN when it cannot be reached)
if (flag("skip-audit")) stage("vulnerability audit", "NOT RUN", "--skip-audit");
else {
  const a = run(npm, ["audit", "--omit=dev", "--json"], { cwd: root, timeout: 90_000 });
  try {
    const j = JSON.parse(a.stdout);
    if (j.error) stage("vulnerability audit", "NOT RUN", `registry unavailable: ${String(j.error.summary ?? j.error.code).slice(0, 120)}`);
    else { writeFileSync(join(out, "audit.json"), JSON.stringify(j, null, 2)); const v = j.metadata?.vulnerabilities ?? {}; const high = (v.high ?? 0) + (v.critical ?? 0); stage("vulnerability audit", high ? "FAILED" : "PASSED", `npm audit (production): ${JSON.stringify(v)}`); }
  } catch { stage("vulnerability audit", "NOT RUN", "npm audit returned no JSON (offline?)"); }
}

// 6. checksums, manifest, provenance
const entries = packed.map((p) => ({ file: p.filename, name: p.name, version: p.version, bytes: readFileSync(join(out, p.filename)).length, sha256: sha(readFileSync(join(out, p.filename))), sha512Integrity: p.integrity, files: p.files.length }));
writeFileSync(join(out, "SHA256SUMS"), entries.map((e) => `${e.sha256} *${e.file}`).join("\n") + "\n");
const npmV = run(npm, ["-v"]).stdout.trim();
const manifest = { schema: 1, product: "PSO Web Framework", license: "Apache-2.0", generatedAt: new Date().toISOString(), node: process.version, npm: npmV, platform: process.platform, packages: entries, extras: ["sbom.cdx.json", "licenses.json", "secret-scan.json", "SHA256SUMS", "provenance.json"].filter((f) => existsSync(join(out, f)) || f === "provenance.json"), stages: stages.map((s) => ({ ...s })) };
const provenance = { _type: "https://in-toto.io/Statement/v1", subject: entries.map((e) => ({ name: e.file, digest: { sha256: e.sha256 } })), predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { buildType: "https://pso.example/build/local-npm-pack/v1", externalParameters: { command: "node scripts/release.mjs npm" } }, runDetails: { builder: { id: "local:developer-machine" }, metadata: { startedOn: manifest.generatedAt } }, note: "SELF-ASSERTED, UNATTESTED: produced on the build machine itself. It is not a SLSA-attested build; real attestation needs a hosted builder (for example a CI platform) that signs it." } };
writeFileSync(join(out, "provenance.json"), JSON.stringify(provenance, null, 2));
stage("checksums + provenance", "PASSED", "SHA256SUMS, manifest.json, provenance.json (self-asserted, not an attested SLSA build)");

// 7. signing: only with a key supplied from outside the repository
const keyFile = typeof flag("sign-key") === "string" ? flag("sign-key") : process.env.PSO_RELEASE_SIGNING_KEY_FILE;
if (keyFile) {
  if (resolve(keyFile).toLowerCase().startsWith(root.toLowerCase())) { stage("signing", "FAILED", "the signing key is inside the repository; refusing to use it"); }
  else {
    const priv = createPrivateKey(readFileSync(keyFile, "utf8")), pub = createPublicKey(priv).export({ type: "spki", format: "pem" });
    const id = sha(createPublicKey(priv).export({ type: "spki", format: "der" })).slice(0, 16);
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
    for (const f of ["SHA256SUMS", "manifest.json"]) writeFileSync(join(out, `${f}.sig`), sign(null, readFileSync(join(out, f)), priv).toString("base64") + "\n");
    writeFileSync(join(out, "signing-key.public.pem"), pub);
    // The provenance statement is wrapped in a DSSE envelope signed with the same key (PAE = "DSSEv1 <len type> <type> <len body> <body>")
    const body = Buffer.from(JSON.stringify(provenance)), type = "application/vnd.in-toto+json";
    const pae = Buffer.concat([Buffer.from(`DSSEv1 ${type.length} ${type} ${body.length} `), body]);
    writeFileSync(join(out, "provenance.intoto.json"), JSON.stringify({ payloadType: type, payload: body.toString("base64"), signatures: [{ keyid: id, sig: sign(null, pae, priv).toString("base64") }] }, null, 2));
    stage("signing", "PASSED", `Ed25519 signature of SHA256SUMS and manifest.json by key ${id} (verify with signing-key.public.pem)`);
  }
} else stage("signing", "NOT RUN", "no key supplied (--sign-key or PSO_RELEASE_SIGNING_KEY_FILE); the artifacts are UNSIGNED");
manifest.stages = stages.map((s) => ({ ...s }));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
if (keyFile && existsSync(join(out, "manifest.json.sig"))) { // re-sign the final manifest (it now includes every stage)
  const priv = createPrivateKey(readFileSync(keyFile, "utf8"));
  writeFileSync(join(out, "manifest.json.sig"), sign(null, readFileSync(join(out, "manifest.json")), priv).toString("base64") + "\n");
}

// 8. installation outside the monorepo from the tarballs only
if (flag("skip-install-test")) stage("clean install", "NOT RUN", "--skip-install-test");
else {
  const d = mkdtempSync(join(tmpdir(), "pso-clean-"));
  try {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "clean-install", version: "1.0.0", private: true, type: "module" }));
    const tars = packed.map((p) => join(out, p.filename));
    const i = run(npm, ["install", "--no-audit", "--no-fund", "--omit=optional", ...tars], { cwd: d, timeout: 280_000 });
    if (i.status !== 0) stage("clean install", "FAILED", (i.stderr || i.stdout).split("\n").slice(-4).join(" ").slice(0, 300));
    else {
      const bin = join(d, "node_modules", "@pso", "cli", "bin", "pso.js");
      const v = run(process.execPath, [bin, "--help"], { cwd: d });
      const imp = run(process.execPath, ["--input-type=module", "-e", "import('@pso/http').then(m=>import('@pso/security')).then(()=>import('@pso/dispatch')).then(()=>console.log('imports-ok'))"], { cwd: d });
      const linked = existsSync(join(d, "node_modules", "@pso", "core", "dist", "index.js"));
      stage("clean install", v.status === 0 && imp.stdout.includes("imports-ok") && linked ? "PASSED" : "FAILED", `outside the monorepo from tarballs: cli --help exit ${v.status}; imports ${imp.stdout.trim() || imp.stderr.slice(0, 120)}`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
}
manifest.stages = stages.map((s) => ({ ...s }));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
if (keyFile && existsSync(join(out, "manifest.json.sig"))) writeFileSync(join(out, "manifest.json.sig"), sign(null, readFileSync(join(out, "manifest.json")), createPrivateKey(readFileSync(keyFile, "utf8"))).toString("base64") + "\n");
console.log(`\nartifacts: ${out}\nNothing was published.`);
process.exit(stages.some((s) => s.status === "FAILED") ? 1 : 0);
