import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep, basename } from "node:path";
import { cmp, diag, type Diagnostic } from "./diagnostics.ts";
import { CONVENTIONS, type KindSpec, type Runtime } from "./conventions.ts";
import { conventionOf, detectNodeStructure, detectSpringStructure, matchesPath, type Structure } from "./structure.ts";
import { walkFiles } from "./fswalk.ts";

export interface Resource {
  /** `${kind}:${id}` */
  key: string;
  kind: string;
  id: string;
  /** project-relative path, forward slashes */
  file: string;
}

export interface Discovery {
  runtime: Runtime;
  /** the structural convention the project follows (modular|legacy for node, layered|legacy for spring-boot) */
  structure: Structure;
  resources: Resource[];
  diagnostics: Diagnostic[];
}

export interface DiscoverOptions {
  /** the structure declared for the project (pso.workspace.json `structure`); the files decide when absent */
  declaredStructure?: string;
}

const IGNORED = new Set(["node_modules", "dist", "target", ".git", ".pso", "build"]);

const toPosix = (p: string): string => p.split(sep).join("/");

/** Longest suffix wins so "Mapper.java" is never shadowed by a shorter suffix. */
const matchKind = (file: string, kinds: KindSpec[]): KindSpec | undefined =>
  [...kinds].sort((a, b) => b.suffix.length - a.suffix.length).find((k) => (k.exact ? file === k.suffix : file.endsWith(k.suffix) && file.length > k.suffix.length));

/** The package directory of the @SpringBootApplication class (the base package), or undefined. */
export function springBasePackageDir(javaRoot: string, files?: readonly string[]): string | undefined {
  const list = files ?? walkFiles(javaRoot, { ignore: IGNORED }).files;
  for (const f of list) if (f.endsWith(".java") && /Application\.java$/.test(f)) { try { if (readFileSync(f, "utf8").includes("@SpringBootApplication")) return dirname(f); } catch { /* unreadable: skipped */ } }
  for (const f of list) if (f.endsWith(".java")) { try { if (readFileSync(f, "utf8").includes("@SpringBootApplication")) return dirname(f); } catch { /* unreadable: skipped */ } }
  // no application class (yet): the base package is the parent of the first structural package found (application/, routes/, ...)
  const MARKERS = new Set(["application", "infrastructure", "shared", "routes", "contracts", "ports", "adapters", "persistence", "events", "configs", "security"]);
  for (const f of list) {
    if (!f.endsWith(".java")) continue;
    const parts = relative(javaRoot, dirname(f)).split(sep);
    const i = parts.findIndex((p) => MARKERS.has(p));
    if (i > 0) return join(javaRoot, ...parts.slice(0, i));
  }
  return undefined;
}

/**
 * Static discovery: classifies files by suffix and checks they live in the directory that owns their kind IN THE STRUCTURE THE
 * PROJECT FOLLOWS (detected from its files, see structure.ts). Application modules are never imported or executed.
 */
export function discover(projectRoot: string, runtime: Runtime, options: DiscoverOptions = {}): Discovery {
  const legacyConv = CONVENTIONS[runtime];
  const srcRoot = join(projectRoot, ...legacyConv.sourceRoot.split("/"));
  const diagnostics: Diagnostic[] = [];
  const resources: Resource[] = [];

  if (!statSync(srcRoot, { throwIfNoEntry: false })?.isDirectory()) {
    diagnostics.push(diag("error", "PSO_NO_SOURCE_ROOT", `Source root "${legacyConv.sourceRoot}" does not exist`, undefined, `Create ${legacyConv.sourceRoot}/ or check the service runtime`));
    return { runtime, structure: runtime === "node" ? "modular" : "layered", resources, diagnostics };
  }

  // secure walk: links are not followed, nothing outside the source root is read, cycles cannot loop (see fswalk.ts)
  const { files, issues } = walkFiles(srcRoot, { ignore: IGNORED });
  for (const i of issues) {
    const sev = i.code === "PSO_FS_SYMLINK_SKIPPED" ? "warning" : "error";
    diagnostics.push(diag(sev, i.code, i.message, toPosix(relative(projectRoot, i.path)), i.code === "PSO_FS_SYMLINK_SKIPPED" ? "Links are never followed during discovery; place real files under the source root" : undefined));
  }

  const baseDir = runtime === "spring-boot" ? springBasePackageDir(srcRoot, files) : undefined;
  const finding = runtime === "node" ? detectNodeStructure(srcRoot, options.declaredStructure) : baseDir ? detectSpringStructure(baseDir, options.declaredStructure) : { structure: (options.declaredStructure === "legacy" ? "legacy" : "layered") as Structure, problems: [] as string[] };
  for (const p of finding.problems) diagnostics.push(diag("error", "PSO_STRUCTURE_MIXED", p, undefined, "One project follows one convention: see `pso structure:inspect`"));
  const conv = conventionOf(runtime, finding.structure, CONVENTIONS);
  const structured = conv.kinds.some((k) => k.paths);

  for (const full of files) {
    const rel = toPosix(relative(projectRoot, full));
    const fromSrc = toPosix(relative(srcRoot, full));
    const spec = matchKind(basename(full), conv.kinds);
    if (!spec) continue; // plain helper modules are legal and silent
    const dirParts = fromSrc.split("/").slice(0, -1);
    if (structured) {
      // structure-aware placement: node paths are relative to src/, Java paths to the base package (the package prefix is free)
      const pkgParts = runtime === "spring-boot" && baseDir ? toPosix(relative(baseDir, dirname(full))).split("/").filter((x) => x && x !== ".") : dirParts;
      const outsideBase = runtime === "spring-boot" && baseDir !== undefined && relative(baseDir, full).startsWith("..");
      const owners = spec.paths ?? [spec.dir];
      const id = spec.exact ? (dirParts[spec.kind === "route-registry" ? dirParts.length - 2 : dirParts.length - 1] ?? "") : basename(full).slice(0, -spec.suffix.length) + (runtime === "spring-boot" ? spec.suffix.replace(/\.java$/, "") : "");
      if (outsideBase || !matchesPath(pkgParts, owners)) {
        diagnostics.push(diag("error", "PSO_MISPLACED_RESOURCE", `${spec.kind} "${id || basename(full)}" must live in ${owners.map((o) => `"${o.replace(/\/\*\*$/, "/...")}/"`).join(" or ")}${runtime === "spring-boot" ? " (under the application package)" : ""} in the ${finding.structure} structure`, rel, `Move it, or generate it with \`pso make:${spec.kind}\` which places it correctly`));
        continue;
      }
      // module-local files (modules/<module>/...) are namespaced by their module so two modules may reuse a file name
      const scope = runtime === "node" && dirParts[0] === "modules" && dirParts.length >= 2 && !spec.exact ? `${dirParts[1]}/` : "";
      resources.push({ key: `${spec.kind}:${scope}${id}`, kind: spec.kind, id, file: rel });
      continue;
    }
    // exact files (MODULE.pso.ts, ROUTES.pso.ts) are identified by the module directory that contains them
    const id = spec.exact ? (dirParts[dirParts.length - 1] ?? "") : basename(full).slice(0, -spec.suffix.length) + (runtime === "spring-boot" ? spec.suffix.replace(/\.java$/, "") : "");
    // Node: the owning dir is the first segment (or one of `alsoIn`). Java: it is the last package segment (package prefix is free).
    const owners = [spec.dir, ...(spec.alsoIn ?? [])];
    const dirOk = runtime === "spring-boot" ? dirParts[dirParts.length - 1] === spec.dir : owners.includes(dirParts[0] ?? "");
    if (!dirOk || (spec.exact && dirParts.length !== 2)) {
      diagnostics.push(diag("error", "PSO_MISPLACED_RESOURCE", `${spec.kind} "${id || basename(full)}" must live in ${spec.exact ? `a module directory "${spec.dir}/<module>/"` : `a "${owners.join("/ or ")}/" directory`}`, rel, `Move it to ${spec.exact ? `${spec.dir}/<module>/` : `${spec.dir}/`}`));
      continue;
    }
    // module-local files (routes/<module>/...) are namespaced by their module so two modules may reuse a file name
    const scope = runtime === "node" && dirParts[0] === "routes" && dirParts.length >= 2 && !spec.exact ? `${dirParts[1]}/` : "";
    resources.push({ key: `${spec.kind}:${scope}${id}`, kind: spec.kind, id, file: rel });
  }

  resources.sort((a, b) => cmp(a.key, b.key) || cmp(a.file, b.file));
  return { runtime, structure: finding.structure, resources, diagnostics };
}
