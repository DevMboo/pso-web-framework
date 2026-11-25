import { spawnSync } from "node:child_process";
import { npmInvocation, viaCmd } from "../proc.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { CliError } from "../fsx.ts";

/**
 * The framework-independent core of `pso install:<framework> <integration>`. It knows about projects, package managers, plans and safe file
 * writing; it knows nothing about React. A framework adapter (see react.ts) supplies detection, the packages and the application-owned files;
 * a new framework or integration is one more adapter registered in integrations/index.ts.
 *
 * Guarantees: nothing is written before the project was validated; packages are installed with the project's own package manager and
 * lockfile (never globally, never through a downloaded script); existing user files are never overwritten (a file is replaced only when it
 * carries the integration's own marker); package.json and the lockfile are restored when the installation fails; running it again is safe.
 */
export type PackageManagerName = "npm" | "pnpm" | "yarn";
export interface PackageManager { name: PackageManagerName; version?: string; source: string; lockfile?: string }
export interface ProjectInfo {
  root: string;
  pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; packageManager?: string };
  /** dependencies + devDependencies (what is installed, not what is merely a peer requirement) */
  deps: Record<string, string>;
  packageManager: PackageManager;
}
export interface PackageSpec { name: string; spec: string; dev?: boolean }
export interface PlannedFile { path: string; content: string; /** text a previous run of THIS integration wrote on its first line(s): only such files may be replaced */ marker: string }
export interface IntegrationPlan { packages: PackageSpec[]; files: PlannedFile[]; notes: string[] }
export interface Detection { problems: string[]; warnings: string[]; facts: Record<string, string> }

export interface IntegrationAdapter {
  /** `react` in `pso install:react` */
  framework: string;
  /** integrations this adapter can install (`channels`) */
  integrations: readonly string[];
  /** looks at the project and reports what is wrong or unsupported, without changing anything */
  detect(project: ProjectInfo, flags: Record<string, string | boolean>): Detection;
  plan(project: ProjectInfo, integration: string, flags: Record<string, string | boolean>, facts: Record<string, string>): IntegrationPlan;
  /** type-checks or otherwise validates the installed result; returns problems (empty when sound) */
  verify(project: ProjectInfo, plan: IntegrationPlan): string[];
}

// ------------------------------------------------------------------ project detection
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new CliError("No package.json found", "Run this command from the root of an existing application (a directory with a package.json); it never creates a project");
    dir = up;
  }
}

/** The package manager the project already uses: the `packageManager` field wins, then the lockfile. Never a guess when evidence conflicts. */
export function detectPackageManager(root: string, pkg: ProjectInfo["pkg"]): PackageManager {
  const field = typeof pkg.packageManager === "string" ? /^(npm|pnpm|yarn)@([^+\s]+)/.exec(pkg.packageManager) : null;
  const locks: Array<[PackageManagerName, string]> = [["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"], ["npm", "package-lock.json"], ["npm", "npm-shrinkwrap.json"]];
  const found = locks.filter(([, f]) => existsSync(join(root, f)));
  if (field) {
    const name = field[1] as PackageManagerName;
    const other = found.filter(([n]) => n !== name);
    if (other.length) throw new CliError(`package.json says ${pkg.packageManager} but ${other.map(([, f]) => f).join(", ")} exists`, "Remove the stale lockfile or fix the packageManager field, then run the command again");
    return { name, version: field[2]!, source: "the packageManager field of package.json", ...(found[0] ? { lockfile: found[0][1] } : {}) };
  }
  const names = [...new Set(found.map(([n]) => n))];
  if (names.length > 1) throw new CliError(`Several lockfiles exist (${found.map(([, f]) => f).join(", ")}): cannot tell which package manager the project uses`, 'Keep one lockfile or set "packageManager" in package.json');
  if (names.length === 1) return { name: names[0]!, source: `the lockfile ${found[0]![1]}`, lockfile: found[0]![1] };
  return { name: "npm", source: "no lockfile found: npm is the default (it will create package-lock.json)" };
}

export function loadProject(cwd: string): ProjectInfo {
  const root = findProjectRoot(cwd);
  let pkg: ProjectInfo["pkg"];
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(/^﻿/, "")) as ProjectInfo["pkg"]; }
  catch (e) { throw new CliError(`package.json cannot be read: ${(e as Error).message}`); }
  return { root, pkg, deps: { ...pkg.devDependencies, ...pkg.dependencies }, packageManager: detectPackageManager(root, pkg) };
}

// ------------------------------------------------------------------ package manager commands
/** The exact command that adds `packages` with the project's own package manager. Pure, so it is testable without running anything. */
export function installCommand(pm: PackageManagerName, packages: readonly PackageSpec[]): { command: string; args: string[] } {
  const spec = (p: PackageSpec): string => (p.spec.startsWith("file:") ? p.spec : `${p.name}@${p.spec}`);
  const group = (list: PackageSpec[]): string[] => list.map(spec);
  const runtime = packages.filter((p) => !p.dev), development = packages.filter((p) => p.dev);
  switch (pm) {
    case "npm": return { command: "npm", args: ["install", "--no-audit", "--no-fund", ...(development.length && !runtime.length ? ["--save-dev"] : ["--save"]), ...group(runtime.length ? runtime : development)] };
    case "pnpm": return { command: "pnpm", args: ["add", ...(development.length && !runtime.length ? ["--save-dev"] : []), ...group(runtime.length ? runtime : development)] };
    case "yarn": return { command: "yarn", args: ["add", ...(development.length && !runtime.length ? ["--dev"] : []), ...group(runtime.length ? runtime : development)] };
  }
}

function run(project: ProjectInfo, packages: PackageSpec[]): { ok: boolean; command: string; output: string } {
  const groups = [packages.filter((p) => !p.dev), packages.filter((p) => p.dev)].filter((g) => g.length);
  let last = "";
  for (const g of groups) {
    const c = installCommand(project.packageManager.name, g);
    const cmd = `${c.command} ${c.args.join(" ")}`;
    // npm runs with the current Node binary; pnpm and yarn are batch wrappers on Windows and go through cmd.exe with an argument array.
    // Package names and versions are the only variable arguments, and one that contains a shell metacharacter is refused.
    let inv: { command: string; args: string[] };
    try { inv = c.command === "npm" ? npmInvocation("npm", c.args) : process.platform === "win32" ? viaCmd(c.command, c.args) : { command: c.command, args: c.args }; }
    catch (e) { return { ok: false, command: cmd, output: (e as Error).message }; }
    const r = spawnSync(inv.command, inv.args, { cwd: project.root, encoding: "utf8", timeout: 600_000 });
    if (r.status !== 0) return { ok: false, command: cmd, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim().split("\n").slice(-15).join("\n") };
    last = cmd;
  }
  return { ok: true, command: last, output: "" };
}

// ------------------------------------------------------------------ the installation
export type FileAction = "created" | "unchanged" | "conflict";
export interface InstallReport {
  integration: string; framework: string; dryRun: boolean; state: "none" | "partial" | "complete";
  packageManager: string; facts: Record<string, string>; warnings: string[];
  packages: Array<{ name: string; spec: string; action: "installed" | "present" | "planned" }>;
  files: Array<{ path: string; action: FileAction | "planned"; reason?: string }>;
  notes: string[]; problems: string[]; verification: string[]; command?: string;
}

const isInside = (root: string, abs: string): boolean => abs === root || abs.startsWith(root + sep);

export function install(adapter: IntegrationAdapter, integration: string, cwd: string, flags: Record<string, string | boolean>): InstallReport {
  if (!adapter.integrations.includes(integration)) throw new CliError(`${adapter.framework} has no integration "${integration}"`, `Available for ${adapter.framework}: ${adapter.integrations.join(", ")}`);
  const project = loadProject(cwd);
  const dry = flags["dry-run"] === true;
  const detection = adapter.detect(project, flags);
  const report: InstallReport = { integration, framework: adapter.framework, dryRun: dry, state: "none", packageManager: `${project.packageManager.name} (${project.packageManager.source})`, facts: detection.facts, warnings: detection.warnings, packages: [], files: [], notes: [], problems: [...detection.problems], verification: [] };
  if (detection.problems.length) return report; // nothing is touched when the project is not a supported target
  const plan = adapter.plan(project, integration, flags, detection.facts);
  report.notes = plan.notes;
  for (const f of plan.files) if (!isInside(project.root, resolve(project.root, f.path))) throw new CliError(`Refusing to write outside the project: ${f.path}`);

  // existing state: which packages and files of THIS integration are already there
  const missingPackages = plan.packages.filter((p) => project.deps[p.name] === undefined);
  const fileStates = plan.files.map((f) => {
    const abs = resolve(project.root, f.path);
    if (!existsSync(abs)) return { f, action: "created" as FileAction };
    const text = readFileSync(abs, "utf8");
    if (text === f.content) return { f, action: "unchanged" as FileAction };
    if (text.split("\n").slice(0, 3).join("\n").includes(f.marker)) return { f, action: "unchanged" as FileAction, reason: "installed by a previous run (kept: regenerate contracts with `pso channels:contracts`)" };
    return { f, action: "conflict" as FileAction, reason: "exists and was not written by PSO: left untouched" };
  });
  const present = plan.packages.length - missingPackages.length, written = fileStates.filter((s) => s.action === "unchanged").length;
  report.state = missingPackages.length === 0 && fileStates.every((s) => s.action === "unchanged") ? "complete" : present === 0 && written === 0 ? "none" : "partial";
  report.packages = plan.packages.map((p) => ({ name: p.name, spec: p.spec, action: dry ? (project.deps[p.name] === undefined ? "planned" : "present") : project.deps[p.name] === undefined ? "installed" : "present" }));
  const conflicts = fileStates.filter((s) => s.action === "conflict");
  if (conflicts.length) report.problems.push(...conflicts.map((c) => `${c.f.path} already exists and was not written by PSO; it was not changed. Move it, or choose another folder with --dir`));
  if (dry) { report.files = fileStates.map((s) => ({ path: s.f.path, action: s.action === "created" ? "planned" : s.action, ...(s.reason ? { reason: s.reason } : {}) })); return report; }
  if (conflicts.length) { report.files = fileStates.map((s) => ({ path: s.f.path, action: s.action, ...(s.reason ? { reason: s.reason } : {}) })); return report; }

  // 1. packages (the only step that can fail for external reasons); restore the manifests if it does
  const snapshots = new Map<string, string | undefined>();
  for (const f of ["package.json", ...["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]]) { const p = join(project.root, f); snapshots.set(p, existsSync(p) ? readFileSync(p, "utf8") : undefined); }
  if (missingPackages.length && flags["skip-install"] !== true) {
    const r = run(project, missingPackages);
    report.command = r.command;
    if (!r.ok) {
      for (const [p, text] of snapshots) { if (text === undefined) continue; writeFileSync(p, text); }
      report.problems.push(`Installing the packages failed: \`${r.command}\`\n${r.output}\npackage.json and the lockfile were restored; no file was written`);
      return report;
    }
  } else if (missingPackages.length) report.notes.push(`--skip-install: add these yourself with ${project.packageManager.name}: ${missingPackages.map((p) => `${p.name}@${p.spec}`).join(" ")}`);

  // 2. files: only the ones that do not exist
  for (const s of fileStates) {
    const abs = resolve(project.root, s.f.path);
    if (s.action === "created") { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, s.f.content); }
    report.files.push({ path: s.f.path, action: s.action, ...(s.reason ? { reason: s.reason } : {}) });
  }
  // 3. verification of the result
  if (flags["skip-install"] !== true) report.verification = adapter.verify(loadProject(project.root), plan);
  if (report.verification.length) report.problems.push(...report.verification.map((v) => `Verification: ${v}`));
  return report;
}

export function formatReport(r: InstallReport): string {
  const lines = [`pso install:${r.framework} ${r.integration}${r.dryRun ? "  [dry-run]" : ""}`, `  package manager: ${r.packageManager}`, ...Object.entries(r.facts).map(([k, v]) => `  ${k}: ${v}`), `  state before: ${r.state}`];
  if (r.packages.length) lines.push("packages:", ...r.packages.map((p) => `  ${p.action.padEnd(9)} ${p.name}@${p.spec}`));
  if (r.files.length) lines.push("files:", ...r.files.map((f) => `  ${f.action.padEnd(9)} ${f.path}${f.reason ? `  (${f.reason})` : ""}`));
  if (r.warnings.length) lines.push("warnings:", ...r.warnings.map((w) => `  ${w}`));
  if (r.problems.length) lines.push("problems:", ...r.problems.map((p) => `  ${p.split("\n").join("\n  ")}`));
  if (r.notes.length) lines.push("next:", ...r.notes.map((n) => `  ${n.split("\n").join("\n  ")}`));
  if (!r.problems.length && !r.dryRun) lines.push(r.state === "complete" ? "nothing to change: the integration is already installed" : "installed and verified");
  return lines.join("\n");
}
