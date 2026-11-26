import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { npmInvocation } from "./proc.ts";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CliError } from "./fsx.ts";
import { PSO_JAVA_VERSION } from "./specs.ts";
import { TEMPLATES_DIR } from "./templates.ts";

/**
 * Vendored framework artifacts carry a manifest, `pso-vendor.json`, next to them: which framework release they are, and the SHA-256 of every
 * file. With it PSO can tell, without building anything, whether a vendor directory is the one the service needs (current), belongs to
 * another release or another build of the same release (outdated), was changed or truncated (corrupt), or was written by a PSO that kept
 * no manifest (unverified: 0.1 to 0.2.0-rc.6). Refreshing replaces only the framework's own artifacts, atomically: the new copy is
 * assembled and verified beside the old one and swapped in by a rename, so an interruption leaves either the old or the new copy, never a
 * mix. Anything else a developer keeps in the vendor directory is left alone.
 */
export const VENDOR_MANIFEST = "pso-vendor.json";
export type VendorState = "absent" | "current" | "outdated" | "corrupt" | "unverified";
export interface VendorInspection {
  state: VendorState;
  /** the release the service needs */
  wanted: string;
  /** releases found in the vendor directory */
  vendored: string[];
  /** why the state is not "current" (file names and versions only) */
  reasons: string[];
}
interface VendorManifest { schema: 1; kind: "maven" | "npm"; version: string; files: Record<string, string> }

const sha256File = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");
const readManifest = (dir: string, kind: VendorManifest["kind"]): VendorManifest | undefined => {
  try {
    const m = JSON.parse(readFileSync(join(dir, VENDOR_MANIFEST), "utf8")) as VendorManifest;
    return m && m.schema === 1 && m.kind === kind && typeof m.version === "string" && m.files && typeof m.files === "object" ? m : undefined;
  } catch { return undefined; }
};
/** every file below `dir`, as forward-slash paths relative to `base` */
const listFiles = (dir: string, base: string = dir): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) out.push(...listFiles(p, base)); else out.push(relative(base, p).split("\\").join("/")); }
  return out.sort();
};
/** Checks the files of a manifest against the disk: missing, changed and unexpected files. */
function verifyAgainst(dir: string, m: VendorManifest, present: string[]): string[] {
  const problems: string[] = [];
  for (const [f, h] of Object.entries(m.files)) {
    const p = join(dir, ...f.split("/"));
    if (!existsSync(p)) problems.push(`${f} is missing`);
    else if (sha256File(p) !== h) problems.push(`${f} does not match its recorded SHA-256`);
  }
  for (const f of present) if (!(f in m.files)) problems.push(`${f} is not part of the vendored release`);
  return problems;
}
/** Writes a file by rename, so a reader never sees half of it. */
const writeAtomic = (file: string, text: string): void => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };

/**
 * Replaces `target` (a directory) by `staged` with renames only: target -> backup, staged -> target, then the backup is removed. If the second
 * rename fails the backup is put back, so the service keeps a complete copy whatever happens.
 */
function swapDirectory(staged: string, target: string): void {
  const backup = `${target}.pso-old-${randomBytes(4).toString("hex")}`;
  const had = existsSync(target);
  if (had) renameSync(target, backup);
  try { renameSync(staged, target); }
  catch (e) { if (had) renameSync(backup, target); throw e; }
  if (had) rmSync(backup, { recursive: true, force: true });
}

/**
 * Portable framework dependencies for a generated Node service.
 *
 * While @pso/* is not installed from a registry, a generated orchestrator references the framework packages of the machine that
 * generated it (an absolute `file:` path). That is right for local development and wrong everywhere else: another checkout, CI, a
 * container build. Vendoring packs the exact framework packages in use into `<service>/vendor/pso/*.tgz` and points package.json at
 * them with RELATIVE paths, so the project carries what it needs and resolves the same bytes on every machine. Third-party
 * dependencies still come from the npm registry (or your mirror), as before.
 */
export const VENDOR_DIR = "vendor/pso";

type Deps = Record<string, string>;
interface Pkg { name?: string; version?: string; dependencies?: Deps; optionalDependencies?: Deps; devDependencies?: Deps }
const readPkg = (file: string): Pkg => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Pkg;
const frameworkDir = (name: string): string => resolve(TEMPLATES_DIR, "..", "..", name.slice("@pso/".length));

/** A dependency spec that only resolves on the machine it was written on. */
export function isMachineBound(spec: string): boolean {
  if (!spec.startsWith("file:")) return false;
  const p = spec.slice("file:".length);
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("~");
}

/** The @pso/* dependencies of a service that only resolve on this machine: [name, spec]. */
export function machineBoundDeps(serviceDir: string): Array<[string, string]> {
  const file = join(serviceDir, "package.json");
  if (!existsSync(file)) return [];
  const pkg = readPkg(file);
  return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([n, s]) => n.startsWith("@pso/") && isMachineBound(s));
}

export interface VendorResult { service: string; packages: Array<{ name: string; version: string; file: string }>; changed: string[]; previous?: VendorInspection; refreshed?: boolean }

/**
 * The vendored framework packages of a Node service against the framework release of this CLI. The npm packages of every 0.2.0 release
 * candidate are versioned 0.2.0, so the file names cannot tell two releases apart: the manifest records the release and each tarball's
 * SHA-256. Read-only and fast (no packing); vendorFramework() also compares the bytes with freshly packed ones.
 */
export function inspectNodeVendor(serviceDir: string): VendorInspection {
  const dir = join(serviceDir, ...VENDOR_DIR.split("/"));
  const tarballs = existsSync(dir) ? readdirSync(dir).filter((f) => /^pso-.*\.tgz$/.test(f)).sort() : [];
  if (!tarballs.length) return { state: "absent", wanted: PSO_JAVA_VERSION, vendored: [], reasons: [] };
  const m = readManifest(dir, "npm");
  if (!m) return { state: "unverified", wanted: PSO_JAVA_VERSION, vendored: [], reasons: [`${VENDOR_DIR} has no ${VENDOR_MANIFEST} (written by an earlier PSO): its release and integrity cannot be checked`] };
  const problems = verifyAgainst(dir, m, tarballs);
  if (problems.length) return { state: "corrupt", wanted: PSO_JAVA_VERSION, vendored: [m.version], reasons: problems };
  if (m.version !== PSO_JAVA_VERSION) return { state: "outdated", wanted: PSO_JAVA_VERSION, vendored: [m.version], reasons: [`${VENDOR_DIR} holds the framework packages of ${m.version}; this CLI is ${PSO_JAVA_VERSION}`] };
  return { state: "current", wanted: PSO_JAVA_VERSION, vendored: [m.version], reasons: [] };
}

/**
 * Packs every @pso/* package the service depends on (and the @pso/* packages those depend on) into vendor/pso and rewrites the
 * service's package.json to the vendored tarballs. Idempotent: when the vendored tarballs are byte-identical to freshly packed ones
 * nothing is written. With `dryRun` nothing is written and the plan is returned.
 */
export function vendorFramework(serviceDir: string, o: { dryRun?: boolean } = {}): VendorResult {
  const pkgFile = join(serviceDir, "package.json");
  if (!existsSync(pkgFile)) throw new CliError(`${pkgFile} not found`, "Vendoring applies to Node services");
  const pkg = readPkg(pkgFile);
  const wanted = Object.keys(pkg.dependencies ?? {}).filter((n) => n.startsWith("@pso/"));
  // the closure over the framework's own @pso/* dependencies: every one of them must come from the vendor directory too
  const closure = new Map<string, { dir: string; pkg: Pkg }>();
  const visit = (name: string, wantedBy: string): void => {
    if (closure.has(name)) return;
    const dir = frameworkDir(name);
    if (!existsSync(join(dir, "package.json")) || !existsSync(join(dir, "dist"))) {
      throw new CliError(`The framework package ${name} (needed by ${wantedBy}) was not found, built, next to this CLI (${dir})`,
        "Vendoring packs the framework packages this CLI ships with. From a framework checkout run `npm run build` first; with an installed PSO, repair the installation (`pso repair`)");
    }
    const p = readPkg(join(dir, "package.json"));
    closure.set(name, { dir, pkg: p });
    for (const dep of Object.keys(p.dependencies ?? {})) if (dep.startsWith("@pso/")) visit(dep, name);
  };
  for (const n of wanted) visit(n, pkg.name ?? "the service");
  const packages = [...closure.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, { pkg: p }]) => ({ name, version: p.version ?? "0.0.0", file: `${VENDOR_DIR}/${name.slice(1).replace("/", "-")}-${p.version ?? "0.0.0"}.tgz` }));
  const next: Deps = { ...(pkg.dependencies ?? {}) };
  const changed: string[] = [];
  for (const p of packages) { const spec = `file:${p.file}`; if (next[p.name] !== spec) { changed.push(`${p.name}: ${next[p.name] === undefined ? "(added: required by a framework package)" : isMachineBound(next[p.name]!) ? "(a path on this machine)" : next[p.name]} -> ${spec}`); next[p.name] = spec; } }
  const previous = inspectNodeVendor(serviceDir);
  const result: VendorResult = { service: serviceDir, packages, changed, previous };
  if (o.dryRun || packages.length === 0) return result;

  const out = join(serviceDir, ...VENDOR_DIR.split("/"));
  mkdirSync(join(serviceDir, "vendor"), { recursive: true });
  // pack into a staging directory first: the current vendor directory stays usable until the new one is complete and verified
  const staged = mkdtempSync(join(serviceDir, "vendor", ".pso-staging-"));
  try {
    for (const [name, { dir }] of closure) {
      const npm = npmInvocation("npm", ["pack", "--json", "--pack-destination", staged]); // explicit executable and arguments: no shell, a path with spaces stays one argument
      const r = spawnSync(npm.command, npm.args, { cwd: dir, encoding: "utf8", timeout: 120_000 });
      if (r.status !== 0) throw new CliError(`npm pack failed for ${name}`, (r.stderr || r.stdout || String(r.error ?? "")).split("\n").slice(-3).join(" ").slice(0, 300));
    }
    const files: Record<string, string> = {};
    for (const p of packages) {
      const f = join(staged, p.file.slice(VENDOR_DIR.length + 1));
      if (!existsSync(f)) throw new CliError(`Vendoring ${p.name} did not produce ${p.file}`, "Check that npm is installed and the framework packages are built");
      files[p.file.slice(VENDOR_DIR.length + 1)] = sha256File(f);
    }
    const manifest: VendorManifest = { schema: 1, kind: "npm", version: PSO_JAVA_VERSION, files };
    const same = previous.state === "current" && JSON.stringify(readManifest(out, "npm")?.files) === JSON.stringify(files);
    if (same && !changed.length) { rmSync(staged, { recursive: true, force: true }); return { ...result, refreshed: false }; }
    // anything a developer added to vendor/pso that is not a framework tarball is carried over unchanged
    if (existsSync(out)) for (const f of readdirSync(out)) if (!/^pso-.*\.tgz$/.test(f) && f !== VENDOR_MANIFEST && !existsSync(join(staged, f))) { const src = join(out, f); if (statSync(src).isFile()) copyFileSync(src, join(staged, f)); }
    writeFileSync(join(staged, VENDOR_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    swapDirectory(staged, out);
  } catch (e) { rmSync(staged, { recursive: true, force: true }); throw e; }
  writeAtomic(pkgFile, JSON.stringify({ ...pkg, dependencies: Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2) + "\n");
  // a lock file written against the machine-bound paths would pin them again: it is rebuilt by the next `npm install`
  const lock = join(serviceDir, "package-lock.json");
  // npm writes a linked local package either as "file:<path>" or, for a link, as the bare relative path ("../../x", "link": true):
  // either one that is absolute or leaves the project cannot be resolved inside an image build. A lock that pins the integrity of
  // the previous tarballs is outdated as well once they were replaced.
  if (existsSync(lock) && (/"resolved":\s*"(file:)?(\/|[A-Za-z]:|\.\.[\\/])/.test(readFileSync(lock, "utf8")) || previous.state !== "absent")) { rmSync(lock); result.changed.push("package-lock.json: removed (it pinned paths of this machine or the previous framework tarballs; `npm install` writes a new one)"); }
  return { ...result, refreshed: true };
}

// ------------------------------------------------------------------------------------------------ Spring services (Maven)

/** Where the vendored PSO Java artifacts of a Spring service live: a Maven repository in LOCAL-repository layout, relative to the service. */
export const MAVEN_VENDOR_DIR = "vendor/maven";

export interface MavenVendorResult { service: string; version: string; snapshot: boolean; artifacts: string[]; files: number; source: string; previous?: VendorInspection; refreshed?: boolean }

/** The PSO version a generated Spring service builds against (`<pso.version>` of its pom.xml). */
export function psoVersionOfPom(serviceDir: string): string | undefined {
  const pom = join(serviceDir, "pom.xml");
  if (!existsSync(pom)) return undefined;
  return /<pso\.version>\s*([^<\s]+)\s*<\/pso\.version>/.exec(readFileSync(pom, "utf8"))?.[1];
}

/** The local Maven repository: `--maven-repo`, else the directory Maven itself uses by default. */
export const defaultMavenRepo = (): string => join(homedir(), ".m2", "repository");

// bookkeeping of the machine's repository is not part of an artifact: where it was downloaded from, failed lookups, integration tests
const skipFile = (name: string): boolean => name === "_remote.repositories" || name.endsWith(".lastUpdated") || name === "resolver-status.properties" || name === "maven-metadata-local.xml";

/** The com.pso artifacts of `version` in a local repository: artifact -> its files (repository-relative, forward slashes). */
function mavenArtifacts(repo: string, version: string): Map<string, string[]> {
  const group = join(repo, "com", "pso");
  const out = new Map<string, string[]>();
  if (!existsSync(group)) return out;
  for (const a of readdirSync(group).sort()) {
    if (a === "pso-integration-tests") continue;
    const d = join(group, a, version);
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    out.set(a, readdirSync(d).filter((f) => !skipFile(f) && statSync(join(d, f)).isFile()).sort().map((f) => `com/pso/${a}/${version}/${f}`));
  }
  return out;
}

/**
 * The vendored com.pso artifacts of a Spring service against the `<pso.version>` its pom.xml builds with and, when it holds that version,
 * the local Maven repository (`pso java:install` may have installed a different build of the same version). Read-only.
 */
export function inspectMavenVendor(serviceDir: string, o: { mavenRepo?: string } = {}): VendorInspection {
  const wanted = psoVersionOfPom(serviceDir) ?? "";
  const dir = join(serviceDir, ...MAVEN_VENDOR_DIR.split("/"));
  const group = join(dir, "com", "pso");
  if (!existsSync(group)) return { state: "absent", wanted, vendored: [], reasons: [] };
  const vendored = [...new Set(readdirSync(group).flatMap((a) => (statSync(join(group, a)).isDirectory() ? readdirSync(join(group, a)).filter((v) => statSync(join(group, a, v)).isDirectory()) : [])))].sort();
  const present = listFiles(group, dir).filter((f) => !skipFile(f.split("/").pop()!) && f !== `com/pso/${VENDOR_MANIFEST}`);
  // the manifest lives with the artifacts it describes (com/pso), so both are replaced together and the build's local repository holds com/ only
  const m = readManifest(group, "maven");
  if (!vendored.includes(wanted) || vendored.length > 1) return { state: "outdated", wanted, vendored, reasons: [`${MAVEN_VENDOR_DIR} holds com.pso ${vendored.join(", ") || "(nothing)"}; pom.xml builds against ${wanted}`] };
  if (!m) return { state: "unverified", wanted, vendored, reasons: [`${MAVEN_VENDOR_DIR} has no ${VENDOR_MANIFEST} (written by an earlier PSO): its integrity cannot be checked`] };
  if (m.version !== wanted) return { state: "outdated", wanted, vendored, reasons: [`${VENDOR_MANIFEST} records com.pso ${m.version}; pom.xml builds against ${wanted}`] };
  const problems = verifyAgainst(dir, m, present);
  if (problems.length) return { state: "corrupt", wanted, vendored, reasons: problems };
  // the same version rebuilt and installed again (a snapshot, or a release candidate rebuilt locally): the vendored bytes are stale
  const source = resolve(o.mavenRepo ?? defaultMavenRepo());
  const src = mavenArtifacts(source, wanted);
  if (src.has("pso-bom")) {
    const differs: string[] = [];
    for (const files of src.values()) for (const f of files) { const h = m.files[f]; if (h === undefined) differs.push(`${f} (not vendored)`); else if (sha256File(join(source, ...f.split("/"))) !== h) differs.push(f); }
    for (const f of Object.keys(m.files)) if (!existsSync(join(source, ...f.split("/")))) differs.push(`${f} (no longer in the local repository)`);
    if (differs.length) return { state: "outdated", wanted, vendored, reasons: [`the local Maven repository holds a different build of com.pso ${wanted}: ${differs.slice(0, 3).join(", ")}${differs.length > 3 ? ` and ${differs.length - 3} more` : ""}`] };
  }
  return { state: "current", wanted, vendored, reasons: [] };
}

/**
 * Portable PSO Java artifacts for a generated Spring service.
 *
 * The `com.pso` artifacts are not on Maven Central: a generated service resolves them from the local Maven repository of the machine
 * where `pso java:install` ran. A container build, a CI runner or another checkout has no such repository, so a build that worked on
 * the developer's machine fails there (a populated ~/.m2 proves nothing about portability). Vendoring copies exactly the
 * `com.pso:*:<pso.version>` artifacts the service is built against into `<service>/vendor/maven`, in local-repository layout, with a
 * manifest of their SHA-256: the generated Dockerfile seeds the build's local repository from it, and any other build does the same with
 * one copy. Third-party dependencies still come from Maven Central (or your mirror), as before.
 *
 * Idempotent: a current vendor directory is left as it is. An outdated, corrupt or unverified one is replaced atomically (see
 * swapDirectory); other groups a developer keeps in vendor/maven are not touched. With `dryRun` nothing is written.
 */
export function vendorMaven(serviceDir: string, o: { dryRun?: boolean; mavenRepo?: string } = {}): MavenVendorResult {
  const version = psoVersionOfPom(serviceDir);
  if (!version) throw new CliError(`${join(serviceDir, "pom.xml")} has no <pso.version> property`, "Vendoring applies to Spring services generated by PSO (their pom.xml imports com.pso:pso-bom:${pso.version})");
  const source = resolve(o.mavenRepo ?? defaultMavenRepo());
  const src = mavenArtifacts(source, version);
  const previous = inspectMavenVendor(serviceDir, o);
  if (!src.has("pso-bom")) {
    // a verified copy needs no local repository (a clean checkout, a CI runner); a repository named explicitly must hold the artifacts
    if (previous.state === "current" && !o.mavenRepo) return { service: serviceDir, version, snapshot: /-SNAPSHOT$/.test(version), artifacts: [], files: 0, source, previous, refreshed: false };
    throw new CliError(`The PSO Java artifacts ${version} were not found in ${source}`,
      "Run `pso java:install` (it builds and installs com.pso:*), or pass --maven-repo <dir> when your local Maven repository is somewhere else");
  }
  const artifacts = [...src.keys()];
  const files = [...src.values()].flat();
  const result: MavenVendorResult = { service: serviceDir, version, snapshot: /-SNAPSHOT$/.test(version), artifacts, files: files.length, source, previous };
  if (o.dryRun || previous.state === "current") return { ...result, refreshed: false };
  const dir = join(serviceDir, ...MAVEN_VENDOR_DIR.split("/"));
  mkdirSync(dir, { recursive: true });
  const staged = mkdtempSync(join(dir, ".pso-staging-"));
  try {
    const hashes: Record<string, string> = {};
    for (const f of files) {
      const from = join(source, ...f.split("/")), to = join(staged, ...f.split("/"));
      mkdirSync(join(to, ".."), { recursive: true });
      copyFileSync(from, to);
      const h = sha256File(to);
      if (h !== sha256File(from)) throw new CliError(`copying ${f} produced different bytes`, "Nothing was replaced; run the command again");
      hashes[f] = h;
    }
    writeFileSync(join(staged, "com", "pso", VENDOR_MANIFEST), JSON.stringify({ schema: 1, kind: "maven", version, files: hashes } satisfies VendorManifest, null, 2) + "\n");
    // only com/pso is replaced (artifacts and manifest in one rename): other groups in vendor/maven stay as they are
    mkdirSync(join(dir, "com"), { recursive: true });
    swapDirectory(join(staged, "com", "pso"), join(dir, "com", "pso"));
    // a manifest written at the top of vendor/maven by a pre-release build of this change is not part of the repository layout
    rmSync(join(dir, VENDOR_MANIFEST), { force: true });
  } finally { rmSync(staged, { recursive: true, force: true }); }
  const after = inspectMavenVendor(serviceDir, o);
  if (after.state !== "current") throw new CliError(`${MAVEN_VENDOR_DIR} could not be verified after vendoring: ${after.reasons.join("; ")}`);
  return { ...result, refreshed: true };
}
