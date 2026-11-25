// Builds the two standalone PSD tools into <out>: pso-bootstrap.mjs (installer core) and pso-recipient.mjs (developer key provisioning).
// Both are deliberately NOT minified or obfuscated: they handle keys and must be auditable by the people who run them. Each is a single file.
//
//   node scripts/psd/build-tools.mjs --out <dir>
// The bootstrap is checked against a list of modules that must never be inside it (the rest of PSO).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = process.argv.slice(2);
const out = resolve(a[a.indexOf("--out") + 1] ?? join(root, "build", "psd-tools"));
mkdirSync(out, { recursive: true });

// markers of framework internals that must not be reachable from the small bootstrap
export const FORBIDDEN_IN_BOOTSTRAP = [
  "pso-agent", "blue-green", "release:plan", "environment:policy", "studio", "structural discovery", "make:controller", "frontend:publish", "OSV-Scanner", "systemd", "nginx",
  "createRoute", "PsoModule", "@pso/deploy", "@pso/frontend", "packages/deploy", "validateProject", "findCycles", "validateContractFile", "loadWorkspace",
];

const results = [];
for (const [name, entry] of [["pso-bootstrap", "scripts/psd/tools/bootstrap-main.ts"], ["pso-recipient", "scripts/psd/tools/recipient-main.ts"]]) {
  const file = join(out, `${name}.mjs`);
  const r = await build({
    entryPoints: [join(root, entry)], outfile: file, bundle: true, platform: "node", format: "esm", target: "node24", treeShaking: true,
    legalComments: "none", sourcemap: false, minify: false, metafile: true, logLevel: "silent",
    banner: { js: "// PSO Web - " + name + " (single file). Part of the PSO Secure Distribution. Source: scripts/psd/tools." },
    absWorkingDir: root,
    // the tools need one function of @pso/core (a bounded directory walk): alias it so none of the rest of core (discovery, validation, graph) is bundled
    alias: { "@pso/core": join(root, "packages", "core", "src", "fswalk.ts") },
  });
  const text = readFileSync(file, "utf8");
  const inputs = Object.keys(r.metafile.inputs).filter((i) => !i.startsWith("node:"));
  const hits = FORBIDDEN_IN_BOOTSTRAP.filter((m) => text.includes(m));
  results.push({ name, file, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), modules: inputs, forbiddenMarkers: hits });
}
const bad = results.filter((r) => r.forbiddenMarkers.length);
writeFileSync(join(out, "tools-manifest.json"), JSON.stringify({ tools: results.map(({ name, bytes, sha256, modules, forbiddenMarkers }) => ({ name, bytes, sha256, modules, forbiddenMarkers })) }, null, 2));
for (const r of results) console.log(`${r.forbiddenMarkers.length ? "FAILED" : "BUILT "}  ${r.name}.mjs  ${r.bytes} bytes  ${r.modules.length} modules  sha256 ${r.sha256.slice(0, 16)}...${r.forbiddenMarkers.length ? `  forbidden markers: ${r.forbiddenMarkers.join(", ")}` : ""}`);
for (const r of results) console.log(`  ${r.name}: ${r.modules.join(", ")}`);
process.exit(bad.length ? 1 : 0);
