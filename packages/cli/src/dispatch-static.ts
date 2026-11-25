import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { walkFiles, type ServiceDecl, type WorkspaceConfig } from "@pso/core";
import { compatibilityProblems, definitionProblems, isChannelName, isEventName, schemaProblems, type Compatibility, type Schema } from "@pso/dispatch";
import { springSummary } from "./spring-config.ts";

/**
 * Static discovery of event contracts, producers and consumers. Spring: dispatch/*.events.json and @PsoEventHandler methods.
 * Node: EVENTS.pso.ts (TypeScript AST, never executed) and @DispatchConsumer classes. Nothing is imported or run, and no broker is contacted.
 */

export interface EventInfo { name: string; version: number; channel: string; publish: boolean; compatibility: Compatibility; accepts: number[]; key?: string; schema?: Schema; schemaFile?: string; file: string }
export interface ConsumerInfo { event: string; target: string; file: string; group?: string }
export interface Finding { code: string; severity: "error" | "warning" | "info"; message: string; file?: string; hint?: string }
export interface ServiceDispatch {
  service: string; runtime: "node" | "spring-boot"; provider: string; enabled: boolean;
  /** the provider whose adapter is a dependency of the project (null: none) */
  installed: string | null; events: EventInfo[]; consumers: ConsumerInfo[]; findings: Finding[]; configured: Record<string, unknown>;
}

export const PROVIDERS = ["redis", "rabbitmq", "kafka"] as const;
export type Provider = (typeof PROVIDERS)[number];

const files = (dir: string, ext: RegExp, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  // never follows links: declarations outside the service cannot be pulled in (see core fswalk)
  for (const p of walkFiles(dir, { ignore: new Set(["node_modules", "target", "dist", ".git"]) }).files) if (ext.test(p.slice(p.lastIndexOf(sep) + 1))) out.push(p);
  return out;
};
const rel = (base: string, p: string) => p.slice(base.length + 1).split("\\").join("/");

/** Evaluates a JSON-like literal (objects, arrays, strings, numbers, booleans, null). Anything else makes the declaration unverifiable. */
function literal(n: ts.Node): unknown {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text);
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(literal);
  if (ts.isObjectLiteralExpression(n)) {
    const o: Record<string, unknown> = {};
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) throw new Error("only plain key: value properties are allowed");
      o[p.name.text] = literal(p.initializer);
    }
    return o;
  }
  if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) return literal(n.expression);
  throw new Error("only literal values are allowed");
}

const parseTs = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8").replace(/^\uFEFF/, ""), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);

function defaultExportArg(sf: ts.SourceFile, callee: string): ts.Expression | undefined {
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && ts.isCallExpression(st.expression) && ts.isIdentifier(st.expression.expression) && st.expression.expression.text === callee) return st.expression.arguments[0];
    if (ts.isExportAssignment(st) && ts.isCallExpression(st.expression)) {
      // export default defineSchema({...}) style helpers
      return undefined;
    }
  }
  return undefined;
}

function nodeDispatch(root: string, s: ServiceDecl): ServiceDispatch {
  const dir = join(root, ...s.path.split("/"));
  const out: ServiceDispatch = { service: s.name, runtime: "node", provider: "none", enabled: false, installed: null, events: [], consumers: [], findings: [], configured: {} };
  let cfg: Record<string, unknown> = {};
  try { cfg = (JSON.parse(readFileSync(join(dir, "pso.config.json"), "utf8")) as { dispatch?: Record<string, unknown> }).dispatch ?? {}; } catch { /* no config yet */ }
  out.enabled = cfg["enabled"] === true;
  out.provider = typeof cfg["provider"] === "string" ? cfg["provider"] : "none";
  out.configured = cfg;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const deps = pkg.dependencies ?? {};
    if ("@pso/dispatch" in deps) out.installed = deps["ioredis"] ? "redis" : deps["amqplib"] ? "rabbitmq" : deps["kafkajs"] ? "kafka" : null;
  } catch { /* no package.json */ }
  const dispatchDir = join(dir, "src", "dispatch");
  if (!existsSync(dispatchDir)) return out;
  for (const mod of readdirSync(dispatchDir).sort()) {
    const md = join(dispatchDir, mod);
    if (!statSync(md).isDirectory()) continue;
    const file = join(md, "EVENTS.pso.ts");
    const at = rel(dir, file);
    const tsFiles = files(md, /\.ts$/).filter((f) => !f.endsWith("EVENTS.pso.ts"));
    // consumers: classes decorated with @DispatchConsumer("event")
    const consumersByClass = new Map<string, ConsumerInfo>();
    for (const f of tsFiles) {
      const sf = parseTs(f);
      sf.forEachChild(function visit(n): void {
        if (ts.isClassDeclaration(n) && n.name) for (const d of ts.getDecorators(n) ?? []) {
          const c = d.expression;
          if (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "DispatchConsumer" && c.arguments[0] && ts.isStringLiteralLike(c.arguments[0])) {
            consumersByClass.set(n.name.text, { event: c.arguments[0].text, target: n.name.text, file: rel(dir, f) });
          }
        }
        ts.forEachChild(n, visit);
      });
    }
    if (!existsSync(file)) { if (consumersByClass.size) out.findings.push({ code: "PSO_DISPATCH_001", severity: "error", file: rel(dir, md), message: `dispatch/${mod} has consumers but no EVENTS.pso.ts: none of them is registered`, hint: "Declare the events and list the consumers in EVENTS.pso.ts" }); continue; }
    const sf = parseTs(file);
    const arg = defaultExportArg(sf, "defineEvents");
    if (!arg || !ts.isObjectLiteralExpression(arg)) { out.findings.push({ code: "PSO_DISPATCH_002", severity: "error", file: at, message: "EVENTS.pso.ts must `export default defineEvents({...})` with an object literal" }); continue; }
    let decl: { events?: unknown[]; consumers?: string[] } = {};
    try {
      const props: Record<string, unknown> = {};
      for (const p of arg.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) throw new Error("only plain key: value properties are allowed");
        props[p.name.text] = p.name.text === "consumers" ? (ts.isArrayLiteralExpression(p.initializer) ? p.initializer.elements.map((e) => (ts.isIdentifier(e) ? e.text : "?")) : "?") : literal(p.initializer);
      }
      decl = props as typeof decl;
    } catch (e) { out.findings.push({ code: "PSO_DISPATCH_002", severity: "error", file: at, message: `EVENTS.pso.ts cannot be verified statically: ${(e as Error).message}` }); continue; }
    const events = (decl.events ?? []) as Array<Record<string, unknown>>;
    const problems = definitionProblems({ events: events as never, consumers: [] });
    for (const p of problems) out.findings.push({ code: "PSO_DISPATCH_003", severity: "error", file: at, message: p });
    for (const e of events) {
      const info: EventInfo = { name: String(e["name"]), version: Number(e["version"]), channel: String(e["channel"]), publish: e["publish"] !== false, compatibility: (e["compatibility"] as Compatibility) ?? "full", accepts: (e["accepts"] as number[]) ?? [], ...(typeof e["key"] === "string" ? { key: e["key"] } : {}), file: at };
      if (typeof e["schema"] === "string") {
        info.schemaFile = rel(dir, join(md, e["schema"]));
        const sp = join(md, e["schema"]);
        if (!existsSync(sp)) out.findings.push({ code: "PSO_DISPATCH_004", severity: "error", file: at, message: `schema file ${e["schema"]} of "${info.name}" does not exist` });
        else {
          try {
            const sa = defaultExportArg(parseTs(sp), "defineSchema") ?? (() => { for (const st of parseTs(sp).statements) if (ts.isExportAssignment(st)) return st.expression; return undefined; })();
            if (!sa) throw new Error("export default a schema literal (or defineSchema({...}))");
            const schema = literal(sa) as Schema;
            const bad = schemaProblems(schema);
            for (const b of bad) out.findings.push({ code: "PSO_DISPATCH_005", severity: "error", file: info.schemaFile, message: `schema of "${info.name}": ${b}` });
            if (!bad.length) info.schema = schema;
          } catch (err) { out.findings.push({ code: "PSO_DISPATCH_005", severity: "error", file: info.schemaFile, message: `schema of "${info.name}" cannot be verified statically: ${(err as Error).message}` }); }
        }
      } else if (e["schema"] && typeof e["schema"] === "object") info.schema = e["schema"] as Schema;
      out.events.push(info);
    }
    const listed = new Set(decl.consumers ?? []);
    for (const c of listed) {
      const found = consumersByClass.get(c);
      if (!found) out.findings.push({ code: "PSO_DISPATCH_006", severity: "error", file: at, message: `consumer ${c} is listed in EVENTS.pso.ts but is not a class decorated with @DispatchConsumer in this module` });
      else { if (!events.some((e) => e["name"] === found.event)) out.findings.push({ code: "PSO_DISPATCH_007", severity: "error", file: found.file, message: `consumer ${c} handles "${found.event}", which ${at} does not declare` }); out.consumers.push(found); }
    }
    for (const [name, c] of consumersByClass) if (!listed.has(name)) out.findings.push({ code: "PSO_DISPATCH_008", severity: "warning", file: c.file, message: `${name} is decorated with @DispatchConsumer but is not listed in EVENTS.pso.ts: it is never registered`, hint: "Add it to the consumers list" });
  }
  return out;
}

function springDispatch(root: string, s: ServiceDecl): ServiceDispatch {
  const dir = join(root, ...s.path.split("/"));
  const sum = springSummary(root, s);
  const pom = existsSync(join(dir, "pom.xml")) ? readFileSync(join(dir, "pom.xml"), "utf8") : "";
  const installed = PROVIDERS.find((p) => new RegExp(`<artifactId>pso-dispatch-${p}-starter</artifactId>`).test(pom)) ?? null;
  const out: ServiceDispatch = { service: s.name, runtime: "spring-boot", provider: sum.dispatch.provider, enabled: sum.dispatch.enabled, installed, events: [], consumers: [], findings: [], configured: {} };
  const resources = join(dir, "src", "main", "resources", "dispatch");
  for (const f of files(resources, /\.events\.json$/)) {
    const at = rel(dir, f);
    let doc: { events?: Array<Record<string, unknown>> };
    try { doc = JSON.parse(readFileSync(f, "utf8")); } catch { out.findings.push({ code: "PSO_DISPATCH_002", severity: "error", file: at, message: "the events file is not valid JSON" }); continue; }
    for (const e of doc.events ?? []) {
      let schema = e["schema"] as Schema | string | undefined;
      let schemaFile: string | undefined;
      if (typeof schema === "string") {
        schemaFile = rel(dir, join(resources, schema));
        const sp = join(resources, schema);
        if (!existsSync(sp)) { out.findings.push({ code: "PSO_DISPATCH_004", severity: "error", file: at, message: `schema file ${schema} of "${String(e["name"])}" does not exist` }); schema = undefined; }
        else try { schema = JSON.parse(readFileSync(sp, "utf8")) as Schema; } catch { out.findings.push({ code: "PSO_DISPATCH_005", severity: "error", file: schemaFile, message: "the schema file is not valid JSON" }); schema = undefined; }
      }
      const info: EventInfo = { name: String(e["name"]), version: Number(e["version"]), channel: String(e["channel"]), publish: e["publish"] !== false, compatibility: (e["compatibility"] as Compatibility) ?? "full", accepts: (e["accepts"] as number[]) ?? [], ...(typeof e["key"] === "string" ? { key: e["key"] } : {}), ...(schemaFile ? { schemaFile } : {}), ...(schema && typeof schema === "object" ? { schema } : {}), file: at };
      for (const p of definitionProblems({ events: [{ ...info, ...(info.schema ? { schema: info.schema } : {}) } as never] })) out.findings.push({ code: "PSO_DISPATCH_003", severity: "error", file: at, message: p });
      out.events.push(info);
    }
  }
  for (const f of files(join(dir, "src", "main", "java"), /\.java$/)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/@PsoEventHandler\(\s*(?:value\s*=\s*)?"([^"]+)"([^)]*)\)\s*(?:public\s+|protected\s+|private\s+)?(?:[\w<>\[\], ?]+\s+)(\w+)\s*\(/g)) {
      const group = /group\s*=\s*"([^"]*)"/.exec(m[2] ?? "")?.[1];
      out.consumers.push({ event: m[1]!, target: m[3]!, file: rel(dir, f), ...(group ? { group } : {}) });
    }
  }
  for (const c of out.consumers) if (!out.events.some((e) => e.name === c.event)) out.findings.push({ code: "PSO_DISPATCH_007", severity: "error", file: c.file, message: `@PsoEventHandler("${c.event}") handles an event that is not declared in dispatch/*.events.json` });
  return out;
}

/** Checks that apply to both runtimes once the declarations are known. */
function common(d: ServiceDispatch): void {
  const seen = new Map<string, EventInfo>();
  for (const e of d.events) {
    const key = `${e.name}@${e.version}`;
    if (seen.has(key)) d.findings.push({ code: "PSO_DISPATCH_009", severity: "error", file: e.file, message: `event ${e.name} version ${e.version} is declared more than once in ${d.service}` });
    seen.set(key, e);
    if (!isEventName(e.name)) d.findings.push({ code: "PSO_DISPATCH_003", severity: "error", file: e.file, message: `invalid event name "${e.name}"` });
    if (!isChannelName(e.channel)) d.findings.push({ code: "PSO_DISPATCH_010", severity: "error", file: e.file, message: `invalid channel "${e.channel}"` });
  }
  const chan = new Map<string, string>();
  for (const e of d.events) { const c = chan.get(e.name); if (c && c !== e.channel) d.findings.push({ code: "PSO_DISPATCH_011", severity: "error", file: e.file, message: `event ${e.name} is declared on two channels ("${c}" and "${e.channel}")` }); chan.set(e.name, e.channel); }
  if (d.enabled && d.provider === "none") d.findings.push({ code: "PSO_DISPATCH_012", severity: "error", message: `${d.service}: dispatch is enabled but no provider is selected`, hint: "Run `pso dispatch:install <redis|rabbitmq|kafka>` and set the provider" });
  if (d.enabled && d.provider !== "none" && d.installed !== d.provider) d.findings.push({ code: "PSO_DISPATCH_013", severity: "error", message: `${d.service}: provider "${d.provider}" is configured but ${d.installed ? `"${d.installed}" is the installed adapter` : "no adapter is installed"}`, hint: `Run \`pso dispatch:install ${d.provider}\`` });
  if (!d.enabled && d.installed && d.provider === "none") d.findings.push({ code: "PSO_DISPATCH_014", severity: "info", message: `${d.service}: the ${d.installed} adapter is installed but dispatch is disabled (nothing connects)` });
  if (d.enabled && d.events.length === 0) d.findings.push({ code: "PSO_DISPATCH_015", severity: "error", message: `${d.service}: dispatch is enabled but no events are declared` });
}

export function discoverDispatch(root: string, ws: WorkspaceConfig): ServiceDispatch[] {
  const out: ServiceDispatch[] = [];
  for (const s of ws.services) {
    if (s.runtime === "spring-boot") { if (existsSync(join(root, ...s.path.split("/"), "pom.xml"))) out.push(springDispatch(root, s)); }
    else if (s.role === "orchestrator") out.push(nodeDispatch(root, s));
  }
  for (const d of out) common(d);
  // cross-service consistency: one event name lives on one channel everywhere
  const global = new Map<string, { channel: string; service: string }>();
  for (const d of out) for (const e of d.events) {
    const g = global.get(e.name);
    if (g && g.channel !== e.channel) d.findings.push({ code: "PSO_DISPATCH_011", severity: "error", file: e.file, message: `event ${e.name} is on channel "${e.channel}" here but on "${g.channel}" in ${g.service}` });
    else if (!g) global.set(e.name, { channel: e.channel, service: d.service });
  }
  return out;
}

// ---------------------------------------------------------------- contract lock (schema compatibility across versions)

export interface Lock { comment: string; contracts: Record<string, Record<string, { channel: string; hash: string; schema: Schema | null; compatibility: Compatibility }>> }
export const LOCK_FILE = "pso.dispatch.lock.json";
const hash = (s: Schema | undefined) => createHash("sha256").update(JSON.stringify(s ?? null)).digest("hex").slice(0, 16);

export function readLock(root: string): Lock {
  try { return JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")) as Lock; } catch { return { comment: "Locked event contracts. Managed by `pso dispatch:lock`; commit it.", contracts: {} }; }
}

/**
 * Compares the declared contracts with the lock. The same name and version must keep the same schema (otherwise bump the version).
 * A new version is checked against the highest locked lower version under the new version's compatibility policy
 * (compatibility "none" is the deliberate way to ship a breaking version).
 */
export function lockFindings(all: ServiceDispatch[], lock: Lock): Finding[] {
  const out: Finding[] = [];
  for (const d of all) for (const e of d.events) {
    const versions = lock.contracts[e.name] ?? {};
    const same = versions[String(e.version)];
    if (same) {
      if (same.hash !== hash(e.schema)) out.push({ code: "PSO_DISPATCH_SCHEMA_CHANGED", severity: "error", file: e.schemaFile ?? e.file, message: `the schema of ${e.name} v${e.version} changed after it was locked: published events of that version would no longer match`, hint: `Declare version ${e.version + 1} (with a compatible schema or compatibility: "none"), then run \`pso dispatch:lock\`` });
      if (same.channel !== e.channel) out.push({ code: "PSO_DISPATCH_CHANNEL_CHANGED", severity: "error", file: e.file, message: `${e.name} v${e.version} moved from channel "${same.channel}" to "${e.channel}" after it was locked` });
      continue;
    }
    const lower = Object.keys(versions).map(Number).filter((v) => v < e.version).sort((a, b) => b - a)[0];
    if (lower !== undefined && e.schema && versions[String(lower)]!.schema) {
      for (const p of compatibilityProblems(versions[String(lower)]!.schema!, e.schema, e.compatibility)) out.push({ code: "PSO_DISPATCH_INCOMPATIBLE", severity: "error", file: e.schemaFile ?? e.file, message: `${e.name} v${e.version} is not ${e.compatibility}-compatible with v${lower}: ${p}`, hint: 'Make the change compatible, or declare compatibility: "none" on the new version to mark it as a deliberate breaking change' });
    } else if (!Object.keys(versions).length) out.push({ code: "PSO_DISPATCH_UNLOCKED", severity: "info", file: e.file, message: `${e.name} v${e.version} is not locked yet`, hint: "Run `pso dispatch:lock` to record its contract" });
  }
  return out;
}

export function buildLock(all: ServiceDispatch[], prev: Lock): Lock {
  const lock: Lock = { comment: prev.comment, contracts: JSON.parse(JSON.stringify(prev.contracts)) };
  for (const d of all) for (const e of d.events) {
    lock.contracts[e.name] ??= {};
    lock.contracts[e.name]![String(e.version)] ??= { channel: e.channel, hash: hash(e.schema), schema: e.schema ?? null, compatibility: e.compatibility };
  }
  return lock;
}

export const dispatchProviderOf = (d: ServiceDispatch) => d.installed ?? (d.provider !== "none" ? d.provider : null);
export { springSummary };

export function dispatchFindings(root: string, config: import("@pso/core").WorkspaceConfig): Array<{ service: string; findings: Finding[] }> {
  const all = discoverDispatch(root, config);
  const lock = lockFindings(all, readLock(root));
  return all.map((d) => ({ service: d.service, findings: [...d.findings, ...lock.filter((f) => d.events.some((e) => f.file === e.file || f.file === e.schemaFile))] }));
}
