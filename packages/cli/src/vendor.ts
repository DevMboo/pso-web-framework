import { spawnSync } from "node:child_process";
import { npmInvocation } from "./proc.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CliError } from "./fsx.ts";
import { TEMPLATES_DIR } from "./templates.ts";

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

export interface VendorResult { service: string; packages: Array<{ name: string; version: string; file: string }>; changed: string[] }

/**
 * Packs every @pso/* package the service depends on (and the @pso/* packages those depend on) into vendor/pso and rewrites the
 * service's package.json to the vendored tarballs. Idempotent. With `dryRun` nothing is written and the plan is returned.
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
  const result: VendorResult = { service: serviceDir, packages, changed };
  if (o.dryRun || packages.length === 0) return result;

  const out = join(serviceDir, ...VENDOR_DIR.split("/"));
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) if (/^pso-.*\.tgz$/.test(f)) rmSync(join(out, f)); // tarballs of an earlier framework version never linger
  for (const [name, { dir }] of closure) {
    const npm = npmInvocation("npm", ["pack", "--json", "--pack-destination", out]); // explicit executable and arguments: no shell, a path with spaces stays one argument
    const r = spawnSync(npm.command, npm.args, { cwd: dir, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new CliError(`npm pack failed for ${name}`, (r.stderr || r.stdout || String(r.error ?? "")).split("\n").slice(-3).join(" ").slice(0, 300));
  }
  for (const p of packages) if (!existsSync(join(serviceDir, ...p.file.split("/")))) throw new CliError(`Vendoring ${p.name} did not produce ${p.file}`, "Check that npm is installed and the framework packages are built");
  writeFileSync(pkgFile, JSON.stringify({ ...pkg, dependencies: Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2) + "\n");
  // a lock file written against the machine-bound paths would pin them again: it is rebuilt by the next `npm install`
  const lock = join(serviceDir, "package-lock.json");
  // npm writes a linked local package either as "file:<path>" or, for a link, as the bare relative path ("../../x", "link": true):
  // either one that is absolute or leaves the project cannot be resolved inside an image build
  if (existsSync(lock) && /"resolved":\s*"(file:)?(\/|[A-Za-z]:|\.\.[\\/])/.test(readFileSync(lock, "utf8"))) { rmSync(lock); result.changed.push("package-lock.json: removed (it pinned paths of this machine; `npm install` writes a portable one)"); }
  return result;
}

// ------------------------------------------------------------------------------------------------ Spring services (Maven)

/** Where the vendored PSO Java artifacts of a Spring service live: a Maven repository in LOCAL-repository layout, relative to the service. */
export const MAVEN_VENDOR_DIR = "vendor/maven";

export interface MavenVendorResult { service: string; version: string; snapshot: boolean; artifacts: string[]; files: number; source: string }

/** The PSO version a generated Spring service builds against (`<pso.version>` of its pom.xml). */
export function psoVersionOfPom(serviceDir: string): string | undefined {
  const pom = join(serviceDir, "pom.xml");
  if (!existsSync(pom)) return undefined;
  return /<pso\.version>\s*([^<\s]+)\s*<\/pso\.version>/.exec(readFileSync(pom, "utf8"))?.[1];
}

/** The local Maven repository: `--maven-repo`, else the directory Maven itself uses by default. */
export const defaultMavenRepo = (): string => join(homedir(), ".m2", "repository");

/**
 * Portable PSO Java artifacts for a generated Spring service.
 *
 * The `com.pso` artifacts are not on Maven Central: a generated service resolves them from the local Maven repository of the machine
 * where `pso java:install` ran. A container build, a CI runner or another checkout has no such repository, so a build that worked on
 * the developer's machine fails there (a populated ~/.m2 proves nothing about portability). Vendoring copies exactly the
 * `com.pso:*:<pso.version>` artifacts the service is built against into `<service>/vendor/maven`, in local-repository layout: the
 * generated Dockerfile seeds the build's local repository from it, and any other build does the same with one copy. Third-party
 * dependencies still come from Maven Central (or your mirror), as before. Idempotent; with `dryRun` nothing is written.
 */
export function vendorMaven(serviceDir: string, o: { dryRun?: boolean; mavenRepo?: string } = {}): MavenVendorResult {
  const version = psoVersionOfPom(serviceDir);
  if (!version) throw new CliError(`${join(serviceDir, "pom.xml")} has no <pso.version> property`, "Vendoring applies to Spring services generated by PSO (their pom.xml imports com.pso:pso-bom:${pso.version})");
  const source = resolve(o.mavenRepo ?? defaultMavenRepo());
  const group = join(source, "com", "pso");
  const artifacts = existsSync(group) ? readdirSync(group).filter((a) => existsSync(join(group, a, version)) && statSync(join(group, a, version)).isDirectory()).sort() : [];
  if (!artifacts.includes("pso-bom")) {
    throw new CliError(`The PSO Java artifacts ${version} were not found in ${source}`,
      "Run `pso java:install` (it builds and installs com.pso:*), or pass --maven-repo <dir> when your local Maven repository is somewhere else");
  }
  // bookkeeping of the machine's repository is not part of an artifact: where it was downloaded from, failed lookups, integration tests
  const skipFile = (name: string): boolean => name === "_remote.repositories" || name.endsWith(".lastUpdated") || name === "resolver-status.properties";
  const wanted = artifacts.filter((a) => a !== "pso-integration-tests");
  let files = 0;
  for (const a of wanted) files += readdirSync(join(group, a, version)).filter((f) => !skipFile(f)).length;
  const result: MavenVendorResult = { service: serviceDir, version, snapshot: /-SNAPSHOT$/.test(version), artifacts: wanted, files, source };
  if (o.dryRun) return result;
  const out = join(serviceDir, ...MAVEN_VENDOR_DIR.split("/"), "com", "pso");
  rmSync(out, { recursive: true, force: true }); // artifacts of an earlier PSO version never linger
  for (const a of wanted) {
    const to = join(out, a, version);
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(join(group, a, version))) if (!skipFile(f)) cpSync(join(group, a, version, f), join(to, f));
  }
  return result;
}
