import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkspaceConfig } from "@pso/core";
import { analyzeOrchestrator, routeRows } from "./http-static.ts";

/**
 * Migration of Spring service security for routes the orchestrator declares PUBLIC (services generated before 0.2.0).
 *
 * A Spring service authorizes every request itself and is secure by default (`anyRequest().authenticated()`): a route that is public in
 * ROUTES.pso.ts still answers 401 unless the service lists the same path as PUBLIC in `pso.security.rules`. This migration adds exactly
 * those rules and nothing else:
 *   - only for routes whose orchestrator declaration says `public` (never inferred from pages, names or other services);
 *   - exact method and path (a `:param` segment becomes `*`, never `**`);
 *   - an existing rule that already covers the route is kept; an existing rule that gives the same path another access level is the
 *     developer's explicit decision and is never overridden (diagnostic);
 *   - a configuration PSO cannot read with certainty (no application.yml, a properties file, a flow-style or unusual rules block, no
 *     controller mapping the path) is reported with the exact rule to add, never modified;
 *   - every modified file is backed up first; running it again changes nothing.
 */
export interface SpringRule { path: string; methods: string[]; access: string; line: number }
export type FindingKind = "covered" | "add" | "conflict" | "ambiguous" | "unmapped" | "exposed-extra";
export interface SpringFinding { service: string; file: string; route: string; method: string; rulePath: string; kind: FindingKind; detail: string }
export interface SpringPlan { findings: SpringFinding[]; changes: Array<{ service: string; file: string; add: Array<{ path: string; method: string; route: string }> }> }

const MARK = "# added by pso workspace:migrate (0.2.0)";
const toRulePath = (p: string): string => p.replace(/\/:[A-Za-z][A-Za-z0-9_]*/g, "/*");

/** Ant-style match as Spring's request matcher applies it to rule paths: `*` one segment, `**` any number of segments. */
export function ruleMatches(pattern: string, path: string): boolean {
  const p = pattern.split("/").filter(Boolean), s = path.replace(/\/:[A-Za-z][A-Za-z0-9_]*/g, "/x").split("/").filter(Boolean);
  const seg = (a: string, b: string) => a === "*" || new RegExp(`^${a.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(b);
  const go = (i: number, j: number): boolean => {
    if (i === p.length) return j === s.length;
    if (p[i] === "**") return go(i + 1, j) || (j < s.length && go(i, j + 1));
    return j < s.length && seg(p[i]!, s[j]!) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/** Reads the `pso.security.rules` block of an application.yml. `undefined` when the block cannot be read with certainty. */
export function readRules(text: string): { rules: SpringRule[]; style: "empty" | "list"; anchor: number } | undefined {
  const lines = text.split(/\r?\n/);
  const pso = lines.findIndex((l) => /^pso:\s*(#.*)?$/.test(l));
  if (pso < 0) return undefined;
  let sec = -1;
  for (let i = pso + 1; i < lines.length && !/^\S/.test(lines[i]!); i++) if (/^  security:\s*(#.*)?$/.test(lines[i]!)) { sec = i; break; }
  if (sec < 0) return undefined;
  let rulesLine = -1;
  for (let i = sec + 1; i < lines.length && (/^\s{4,}|^\s*$|^\s*#/.test(lines[i]!)) && !/^  \S/.test(lines[i]!); i++) if (/^    rules:/.test(lines[i]!)) { rulesLine = i; break; }
  if (rulesLine < 0) return undefined;
  const head = lines[rulesLine]!;
  if (/^    rules: \[\]\s*(#.*)?$/.test(head)) return { rules: [], style: "empty", anchor: rulesLine };
  if (!/^    rules:\s*(#.*)?$/.test(head)) return undefined; // flow style or anything else: not ours to rewrite
  const rules: SpringRule[] = [];
  let cur: Partial<SpringRule> | undefined;
  for (let i = rulesLine + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue;
    if (!/^      /.test(l)) break;
    let m: RegExpExecArray | null;
    if ((m = /^      - path:\s*(\S+)\s*(#.*)?$/.exec(l))) { if (cur) rules.push(cur as SpringRule); cur = { path: m[1]!.replace(/^["']|["']$/g, ""), methods: [], access: "AUTHENTICATED", line: i }; continue; }
    if (!cur) return undefined;
    if ((m = /^        methods:\s*\[([^\]]*)\]\s*(#.*)?$/.exec(l))) { cur.methods = m[1]!.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toUpperCase()).filter(Boolean); continue; }
    if ((m = /^        access:\s*([A-Za-z]+)\s*(#.*)?$/.exec(l))) { cur.access = m[1]!.toUpperCase(); continue; }
    if (/^        (scopes|roles):/.test(l)) continue;
    return undefined; // a key or layout this reader does not know: report instead of guessing
  }
  if (cur) rules.push(cur as SpringRule);
  return { rules, style: "list", anchor: rulesLine };
}

/** Request paths the service's controllers map (class-level @RequestMapping joined with method-level mappings), relative to the prefix. */
export function mappedPaths(serviceDir: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const src = join(serviceDir, "src", "main", "java");
  const walk = (d: string) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".java")) scan(readFileSync(p, "utf8")); } };
  const val = (args: string | undefined): string[] => { if (!args) return [""]; const m = [...args.matchAll(/"([^"]*)"/g)].map((x) => x[1]!); return m.length ? m : [""]; };
  const scan = (t: string) => {
    if (!/@RestController|@Controller/.test(t)) return;
    const cls = /@RequestMapping\s*(?:\(([^)]*)\))?\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:final\s+)?class/.exec(t);
    const bases = cls ? val(cls[1]) : [""];
    for (const m of t.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping\s*(?:\(([^)]*)\))?/g)) for (const b of bases) for (const v of val(m[2])) out.push({ method: m[1]!.toUpperCase(), path: (`/${b}/${v}`).replace(/\/+/g, "/").replace(/(.)\/$/, "$1") });
  };
  walk(src);
  return out;
}

export function planSpringSecurity(root: string, ws: WorkspaceConfig): SpringPlan {
  const findings: SpringFinding[] = [];
  const changes: SpringPlan["changes"] = [];
  const orch = ws.services.find((s) => s.role === "orchestrator");
  if (!orch) return { findings, changes };
  const rows = routeRows(join(root, ...orch.path.split("/")), analyzeOrchestrator(join(root, ...orch.path.split("/"))));
  const bySvc = new Map<string, typeof rows>();
  for (const r of rows) if (r.service) bySvc.set(r.service, [...(bySvc.get(r.service) ?? []), r]);
  for (const svc of ws.services.filter((s) => s.runtime === "spring-boot")) {
    const routes = bySvc.get(svc.name) ?? [];
    const pub = routes.filter((r) => r.public);
    const dir = join(root, ...svc.path.split("/"));
    const rel = `${svc.path}/src/main/resources/application.yml`;
    const yml = join(dir, "src", "main", "resources", "application.yml");
    const text = existsSync(yml) ? readFileSync(yml, "utf8") : undefined;
    const parsed = text !== undefined ? readRules(text) : undefined;
    const mapped = mappedPaths(dir);
    const adds: Array<{ path: string; method: string; route: string }> = [];
    for (const r of pub) {
      const rulePath = toRulePath(r.path);
      const f = (kind: FindingKind, detail: string) => findings.push({ service: svc.name, file: rel, route: r.path, method: r.method, rulePath, kind, detail });
      if (!mapped.some((m) => m.method === r.method && ruleMatches(toRulePath(m.path.replace(/\{[^}]+\}/g, ":p")), r.path))) { f("unmapped", `no controller of ${svc.name} maps ${r.method} ${r.path}: the route may forward elsewhere. If it is served here, add to pso.security.rules: { path: ${rulePath}, methods: [${r.method}], access: PUBLIC }`); continue; }
      if (text === undefined) { f("ambiguous", `${rel} does not exist (a properties file or another layout?): add the PUBLIC rule for ${r.method} ${rulePath} by hand`); continue; }
      if (!parsed) { f("ambiguous", `the pso.security.rules block of ${rel} cannot be read with certainty (missing, flow style or unknown keys): add { path: ${rulePath}, methods: [${r.method}], access: PUBLIC } by hand`); continue; }
      const applies = parsed.rules.filter((x) => ruleMatches(x.path, r.path) && (x.methods.length === 0 || x.methods.includes(r.method)));
      // Spring evaluates rules in order: the first matching one decides
      const first = applies[0];
      if (first && first.access === "PUBLIC") { f("covered", `rule at line ${first.line + 1} (${first.path}) already makes it public`); continue; }
      if (first) { f("conflict", `rule at line ${first.line + 1} gives ${first.path} access ${first.access}: the developer's explicit rule is kept. The orchestrator route is public; decide which one is right`); continue; }
      f("add", `add { path: ${rulePath}, methods: [${r.method}], access: PUBLIC }`);
      adds.push({ path: rulePath, method: r.method, route: r.path });
    }
    // the opposite direction is reported only: a service rule that makes public something the orchestrator protects
    if (parsed) for (const x of parsed.rules.filter((y) => y.access === "PUBLIC")) {
      const prot = routes.filter((r) => !r.public && ruleMatches(x.path, r.path) && (x.methods.length === 0 || x.methods.includes(r.method)));
      for (const r of prot) findings.push({ service: svc.name, file: rel, route: r.path, method: r.method, rulePath: x.path, kind: "exposed-extra", detail: `the service rule at line ${x.line + 1} makes ${x.path} PUBLIC while the orchestrator protects ${r.method} ${r.path} (${r.access}): reachable without a token on the private network. Not changed automatically` });
    }
    if (adds.length) changes.push({ service: svc.name, file: rel, add: adds });
  }
  return { findings, changes };
}

/** Inserts the planned rules (after a backup). Returns the backup paths. Idempotent: rules already present are not inserted again. */
export function applySpringSecurity(root: string, plan: SpringPlan, backupDir: string): string[] {
  const backups: string[] = [];
  for (const c of plan.changes) {
    const f = join(root, ...c.file.split("/"));
    const text = readFileSync(f, "utf8");
    const parsed = readRules(text);
    if (!parsed) continue;
    const todo = c.add.filter((a) => !parsed.rules.some((r) => r.path === a.path && r.access === "PUBLIC" && (r.methods.length === 0 || r.methods.includes(a.method))));
    if (!todo.length) continue;
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const entry = todo.flatMap((a) => [`      - path: ${a.path}`, `        methods: [${a.method}]`, `        access: PUBLIC      ${MARK}: orchestrator route ${a.method} ${a.route} is public`]);
    if (parsed.style === "empty") { const comment = /#.*$/.exec(lines[parsed.anchor]!.replace(/^    rules: \[\]/, ""))?.[0] ?? ""; lines.splice(parsed.anchor, 1, `    rules:${comment ? ` ${comment.trim()}` : ""}`, ...entry); }
    else {
      // inserted at the END of the list: rules are evaluated in order, so an existing rule always keeps precedence
      let end = parsed.anchor + 1;
      for (let i = parsed.anchor + 1; i < lines.length; i++) { const l = lines[i]!; if (/^      /.test(l)) end = i + 1; else if (/^\s*$|^\s*#/.test(l)) continue; else break; }
      lines.splice(end, 0, ...entry);
    }
    const b = join(backupDir, ...c.file.split("/"));
    mkdirSync(dirname(b), { recursive: true }); copyFileSync(f, b); backups.push(b);
    writeFileSync(f, lines.join(nl));
  }
  return backups;
}
