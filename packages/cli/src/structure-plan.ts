import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkFiles, type ServiceDecl } from "@pso/core";
import { orchestratorStructure, springStructure } from "./project-structure.ts";

/**
 * Structural migration INSPECTION (read-only): for a project in the 0.1 structure, where each file would go in the official one, and
 * which other files would change with it (imports, route declarations, module registrations, Java package declarations). It moves
 * nothing: applications are restructured by their owners, with this plan, after a backup.
 */
export interface StructurePlan {
  service: string;
  runtime: string;
  structure: string;
  source: string;
  target: string;
  problems: string[];
  moves: Array<{ from: string; to: string; note?: string }>;
  references: Array<{ file: string; what: string }>;
  manual: string[];
}

const posix = (p: string): string => p.split(sep).join("/");
const files = (dir: string): string[] => (existsSync(dir) ? walkFiles(dir, { ignore: new Set(["node_modules", "dist", "target", ".git"]) }).files : []);

export function structurePlan(projectDir: string, s: ServiceDecl): StructurePlan {
  return s.runtime === "node" ? nodePlan(projectDir, s) : springPlan(projectDir, s);
}

function nodePlan(dir: string, s: ServiceDecl): StructurePlan {
  const st = orchestratorStructure(dir, s.structure);
  const out: StructurePlan = { service: s.name, runtime: "node", structure: st.finding.structure, source: st.finding.source, target: "modular", problems: st.finding.problems, moves: [], references: [], manual: [] };
  if (st.finding.structure === "modular" && !st.finding.problems.length) return out;
  const src = join(dir, "src");
  const APP: Record<string, string> = { guards: ".app/guards", middlewares: ".app/middlewares", filters: ".app/filters", configs: ".app/configs", contracts: ".app/contracts", hooks: ".app/hooks", services: "shared", providers: "shared" };
  for (const f of files(src).map((x) => posix(relative(src, x))).filter((x) => !x.endsWith(".gitkeep"))) {
    const parts = f.split("/");
    if (parts[0] === "routes" && parts.length >= 3) {
      const [, mod, ...rest] = parts;
      const name = rest.join("/");
      const to = name === "ROUTES.pso.ts" ? "routes/ROUTES.pso.ts"
        : name === "MODULE.pso.ts" ? "MODULE.pso.ts"
        : /\.controller\.ts$/.test(name) && rest.length === 1 ? `controllers/${name}`
        : /\.service\.ts$/.test(name) && rest.length === 1 ? `services/${name}`
        : rest[0] === "dto" ? `dto/request/${rest.slice(1).join("/")}`
        : name;
      out.moves.push({ from: `src/${f}`, to: `src/modules/${mod}/${to}`, ...(to === name && name !== "MODULE.pso.ts" ? { note: "kept as is inside the module" } : {}) });
    } else if (APP[parts[0]!] && parts.length >= 2) {
      out.moves.push({ from: `src/${f}`, to: `src/${APP[parts[0]!]}/${parts.slice(1).join("/")}`, ...(parts[0] === "services" || parts[0] === "providers" ? { note: "an application-wide injectable: shared/, or move it into the module that uses it" } : {}) });
    }
  }
  const moved = new Set(out.moves.map((m) => m.from));
  // every TypeScript file with a relative import of a moved file (or that moves itself: its own relative imports change)
  for (const f of files(src).filter((x) => x.endsWith(".ts"))) {
    const rel = `src/${posix(relative(src, f))}`;
    const text = readFileSync(f, "utf8");
    const imports = [...text.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]!);
    if (!imports.length) continue;
    const what: string[] = [];
    if (moved.has(rel)) what.push(`${imports.length} relative import(s) re-pointed`);
    else if (imports.some((i) => [...moved].some((m) => m.replace(/\.ts$/, "").endsWith(i.replace(/^(\.\.?\/)+/, "").replace(/\.js$/, ""))))) what.push("imports a moved file");
    if (/defineRoutes\(/.test(text)) what.push(`${(text.match(/method:\s*"/g) ?? []).length} route declaration(s)`);
    if (/defineModule\(/.test(text)) what.push("module registration (controllers/providers imports)");
    if (what.length) out.references.push({ file: rel, what: what.join("; ") });
  }
  const ts = join(dir, "tsconfig.json");
  if (existsSync(ts) && !readFileSync(ts, "utf8").includes("src/.app/**/*")) out.references.push({ file: "tsconfig.json", what: 'add "src/.app/**/*" to "include" (TypeScript skips dot-directories otherwise)' });
  return out;
}

function springPlan(dir: string, s: ServiceDecl): StructurePlan {
  let st: ReturnType<typeof springStructure>;
  try { st = springStructure(dir, s.structure); } catch (e) { return { service: s.name, runtime: "spring-boot", structure: "unknown", source: "files", target: "layered", problems: [(e as Error).message], moves: [], references: [], manual: [] }; }
  const out: StructurePlan = { service: s.name, runtime: "spring-boot", structure: st.finding.structure, source: st.finding.source, target: "layered", problems: st.finding.problems, moves: [], references: [], manual: [] };
  if (st.finding.structure === "layered" && !st.finding.problems.length) return out;
  const base = st.pkgDir, baseRel = posix(relative(dir, base));
  const pkgOf = (p: string) => p.split("/").join(".");
  const javaFiles = files(base).filter((x) => x.endsWith(".java"));
  const moves = new Map<string, string>(); // old fully qualified class -> new package
  for (const f of javaFiles) {
    const r = posix(relative(base, f));
    const parts = r.split("/"), file = parts[parts.length - 1]!, top = parts.length > 1 ? parts[0]! : "";
    const text = readFileSync(f, "utf8");
    const entity = /@Entity\b/.test(text);
    const target = entity ? "infrastructure/entity"
      : top === "routes" ? "application/rest"
      : top === "application" && parts.length === 2 ? "application/service"
      : top === "contracts" ? (/Request\.java$/.test(file) ? "application/dto/request" : "application/dto/response")
      : top === "adapters" ? (/Mapper\.java$/.test(file) ? "application/mapper" : "infrastructure/client")
      : top === "persistence" ? "infrastructure/persistence"
      : top === "configs" ? "infrastructure/config"
      : top === "security" ? "infrastructure/security"
      : top === "events" ? "application/event"
      : top === "domain" ? (entity ? "infrastructure/entity" : "application/service")
      : undefined;
    if (top === "ports") { out.manual.push(`${baseRel}/${r}: the layered structure has no ports; inline the interface into the service, or keep it under application/service`); continue; }
    if (!target) continue;
    const to = `${baseRel}/${target}/${file}`;
    out.moves.push({ from: `${baseRel}/${r}`, to, ...(top === "contracts" && !/Request\.java$/.test(file) ? { note: "a DTO that is a request belongs in dto/request" } : {}) });
    moves.set(`${pkgOf(st.pkg)}.${pkgOf(parts.slice(0, -1).join("/"))}.${file.replace(/\.java$/, "")}`, `${st.pkg}.${pkgOf(target)}`);
  }
  for (const f of javaFiles) {
    const r = `${baseRel}/${posix(relative(base, f))}`;
    const text = readFileSync(f, "utf8");
    const what: string[] = [];
    if (out.moves.some((m) => m.from === r)) what.push("package declaration");
    const hits = [...moves.keys()].filter((fq) => text.includes(`import ${fq};`) || (out.moves.some((m) => m.from === r) && text.includes(fq.split(".").pop()!)));
    if (hits.length) what.push(`${hits.length} import(s) of moved classes`);
    if (what.length) out.references.push({ file: r, what: what.join("; ") });
  }
  for (const t of files(join(dir, "src", "test", "java")).filter((x) => x.endsWith(".java"))) {
    const text = readFileSync(t, "utf8");
    const hits = [...moves.keys()].filter((fq) => text.includes(`import ${fq};`));
    if (hits.length) out.references.push({ file: posix(relative(dir, t)), what: `${hits.length} import(s) of moved classes (tests)` });
  }
  if (statSync(join(dir, "src", "main", "resources", "application.yml"), { throwIfNoEntry: false })) out.manual.push("pso.security.rules paths are unchanged by the move (they are URL paths, not packages)");
  return out;
}
