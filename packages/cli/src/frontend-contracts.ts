import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { WorkspaceConfig } from "@pso/core";
import { analyzeOrchestrator, routeRows } from "./http-static.ts";

/**
 * Typed frontend contracts, derived from what the orchestrator really DECLARES: its routes (method, path, scopes, authentication), the DTO
 * classes its controllers validate request bodies against and, since contract schema 1.1, the OPTIONAL `responses` a route publishes.
 * Nothing is invented and nothing is sampled from a running service: a route without `responses` simply has an untyped response, and a
 * response type exists only because the orchestrator's authors wrote it down in ROUTES.pso.ts next to the route it describes.
 */
export interface DtoField { name: string; type: string; required: boolean; /** declared with `?` (a response field that may be absent) */ optional?: boolean }
export interface ResponseSpec { kind: "dto" | "void" | "problem"; dto?: string; collection?: boolean; nullable?: boolean }
export interface Operation { id: string; method: string; path: string; scopes: string[]; auth: "jwt" | "public" | string; pathParams: string[]; body: string | null; responses?: Record<string, ResponseSpec> }
export interface OrchestratorContract { schema: 1; kind: "pso-orchestrator-contract"; orchestrator: string; version: string; operations: Operation[]; dtos: Record<string, DtoField[]> }

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (n === "node_modules" || n === "dist") continue; if (statSync(p).isDirectory()) walk(p, out); else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) out.push(p); }
  return out;
}
const decoratorNames = (n: ts.Node): string[] => (ts.canHaveDecorators(n) ? (ts.getDecorators(n) ?? []) : []).map((d) => { const e = d.expression; return ts.isCallExpression(e) ? e.expression.getText() : e.getText(); });

/** `"CustomerResponse"`, `"CustomerResponse[]"`, `"CustomerResponse | null"`, `"void"`, `"problem"` -> a structured response, or undefined when it is not one. */
export function parseResponseSpec(text: string): ResponseSpec | undefined {
  const t = text.trim();
  if (t === "void") return { kind: "void" };
  if (t === "problem") return { kind: "problem" };
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?( \| null)?$/.exec(t);
  if (!m) return undefined;
  return { kind: "dto", dto: m[1]!, ...(m[2] ? { collection: true } : {}), ...(m[3] ? { nullable: true } : {}) };
}
const typeNames = (type: string): string[] => type.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];

export function buildContract(root: string, config: WorkspaceConfig): OrchestratorContract {
  const orch = config.services.find((s) => s.role === "orchestrator");
  if (!orch) throw new Error("this workspace has no orchestrator");
  const dir = join(root, ...orch.path.split("/"));
  const analysis = analyzeOrchestrator(dir);
  if (!analysis.ok) throw new Error("the orchestrator's routes are invalid: run `pso validate` and fix them first");
  const rows = routeRows(dir, analysis);

  const dtos: Record<string, DtoField[]> = {};
  const bodyOf = new Map<string, string>(); // "Controller.action" -> DTO class
  const src = join(dir, "src");
  for (const file of existsSync(src) ? walk(src) : []) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) && n.name) {
        if (decoratorNames(n).includes("Dto")) {
          const fields: DtoField[] = [];
          for (const m of n.members) {
            if (!ts.isPropertyDeclaration(m) || !ts.isIdentifier(m.name) || !m.type) continue;
            fields.push({ name: m.name.text, type: m.type.getText(), required: decoratorNames(m).includes("Required"), ...(m.questionToken ? { optional: true } : {}) });
          }
          dtos[n.name.text] = fields;
        }
        for (const m of n.members) if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name)) for (const p of m.parameters) for (const d of ts.canHaveDecorators(p) ? (ts.getDecorators(p) ?? []) : []) {
          const e = d.expression;
          if (ts.isCallExpression(e) && e.expression.getText() === "Body" && e.arguments[0] && ts.isIdentifier(e.arguments[0])) bodyOf.set(`${n.name.text}.${m.name.text}`, e.arguments[0].text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const problems: string[] = [];
  const operations: Operation[] = rows.filter((r) => r.active).map((r) => {
    const id = `${r.method} ${r.path}`;
    const responses: Record<string, ResponseSpec> = {};
    for (const [code, expr] of Object.entries(r.responses).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const spec = parseResponseSpec(expr);
      if (!spec) { problems.push(`${id}: response ${code} "${expr}" is not a DTO name, "Name[]", "Name | null", "void" or "problem"`); continue; }
      if (spec.kind === "dto" && !dtos[spec.dto!]) { problems.push(`${id}: response ${code} names "${spec.dto}", but no @Dto() class of that name exists in the orchestrator`); continue; }
      responses[code] = spec;
    }
    return {
      id, method: r.method, path: r.path, scopes: [...r.scopes].sort(), auth: r.public ? "public" : (r.guard ?? "denied"),
      pathParams: r.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)),
      body: bodyOf.get(`${r.controller}.${r.action}`) && dtos[bodyOf.get(`${r.controller}.${r.action}`)!] ? bodyOf.get(`${r.controller}.${r.action}`)! : null,
      ...(Object.keys(responses).length ? { responses } : {}),
    };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (problems.length) throw new Error(`the orchestrator's response contracts are invalid:\n${problems.map((p) => `  ${p}`).join("\n")}`);

  // a DTO is published when an operation's body or response uses it, and (transitively) when a published DTO's field type names it
  const used = new Set<string>();
  const add = (name: string): void => { if (used.has(name) || !dtos[name]) return; used.add(name); for (const f of dtos[name]!) for (const t of typeNames(f.type)) add(t); };
  for (const o of operations) { if (o.body) add(o.body); for (const s of Object.values(o.responses ?? {})) if (s.dto) add(s.dto); }
  const published = Object.fromEntries(Object.entries(dtos).filter(([k]) => used.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = { operations, dtos: published };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
  return { schema: 1, kind: "pso-orchestrator-contract", orchestrator: orch.name, version, ...body };
}

const responseType = (s: ResponseSpec): string => (s.kind === "void" ? "void" : s.kind === "problem" ? "Problem" : `${s.dto}${s.collection ? "[]" : ""}${s.nullable ? " | null" : ""}`);

/** The TypeScript a frontend project imports. Types, a constant table and one factory over the host's `api`. */
export function renderContractTs(c: OrchestratorContract): string {
  const bodyDtos = new Set(c.operations.map((o) => o.body).filter((x): x is string => x !== null));
  const lines = [
    `// GENERATED by \`pso frontend:contracts\` from the orchestrator "${c.orchestrator}". Do not edit: regenerate after the orchestrator changes.`,
    `// Request bodies come from the DTO classes the orchestrator validates. Response types exist only for routes that DECLARE \`responses\` in`,
    `// their ROUTES.pso.ts entry; for every other route the response is not part of the contract and stays untyped (\`unknown\`).`,
    `import { typedOperations, type PsoApi } from "@pso/frontend";`, ``,
    `export const ORCHESTRATOR_CONTRACT_VERSION = ${JSON.stringify(c.version)};`, ``,
    `/** RFC 9457 Problem Details, the shape of every error body the orchestrator sends. */`,
    `export interface Problem { type: string; title: string; status: number; detail?: string; instance?: string; code?: string; correlationId?: string; errors?: ReadonlyArray<{ field?: string; message: string; code?: string }>; [extension: string]: unknown }`, ``,
  ];
  for (const [name, fields] of Object.entries(c.dtos)) {
    const asBody = bodyDtos.has(name);
    lines.push(`export interface ${name} {`);
    // a request body DTO marks what the caller must send (@Required); a response-only DTO is complete unless a field is declared with "?"
    for (const f of fields) lines.push(`  ${f.name}${(asBody ? f.required : !f.optional) ? "" : "?"}: ${f.type};`);
    lines.push(`}`, ``);
  }
  lines.push(`export interface OperationInfo { readonly method: string; readonly path: string; readonly scopes: readonly string[]; readonly auth: string; readonly pathParams: readonly string[] }`);
  lines.push(`export const operations = {`);
  for (const o of c.operations) lines.push(`  ${JSON.stringify(o.id)}: { method: ${JSON.stringify(o.method)}, path: ${JSON.stringify(o.path)}, scopes: ${JSON.stringify(o.scopes)}, auth: ${JSON.stringify(o.auth)}, pathParams: ${JSON.stringify(o.pathParams)} },`);
  lines.push(`} as const satisfies Record<string, OperationInfo>;`, `export type OperationId = keyof typeof operations;`, ``);
  lines.push(`/** Request body type of each operation that has one. */`, `export interface OperationBodies {`);
  for (const o of c.operations) if (o.body) lines.push(`  ${JSON.stringify(o.id)}: ${o.body};`);
  lines.push(`}`, ``);
  lines.push(`/** Declared responses by HTTP status, for the operations whose route publishes them. */`, `export interface OperationResponses {`);
  for (const o of c.operations) if (o.responses) lines.push(`  ${JSON.stringify(o.id)}: { ${Object.entries(o.responses).map(([code, s]) => `${code}: ${responseType(s)}`).join("; ")} };`);
  lines.push(`}`, ``);
  lines.push(`/** The body of an operation's success response (200, 201, 202, 203, 206; or void for 204), or unknown when the route declares none. */`);
  lines.push(`export type SuccessOf<Id extends string> = Id extends keyof OperationResponses ? OperationResponses[Id][Extract<keyof OperationResponses[Id], 200 | 201 | 202 | 203 | 206 | 204>] : unknown;`);
  lines.push(`/** The body of a given status of an operation (an error status is a Problem). */`);
  lines.push(`export type ResponseOf<Id extends keyof OperationResponses, S extends keyof OperationResponses[Id]> = OperationResponses[Id][S];`, ``);
  lines.push(`export type SuccessMap = { [K in OperationId]: SuccessOf<K> };`);
  lines.push("/** Typed calls over this contract through the host's api: createOperations(api).call(\"GET /customers\") resolves to the declared success type. */");
  lines.push(`export const createOperations = (api: PsoApi) => typedOperations<typeof operations, OperationBodies, SuccessMap>(api, operations);`, ``);
  return lines.join("\n");
}

export const CONTRACT_FILE = "src/models/contract.generated.ts";
export const contractVersionOf = (text: string): string | undefined => /ORCHESTRATOR_CONTRACT_VERSION = "([0-9a-f]+)"/.exec(text)?.[1];

// ------------------------------------------------------------------------------------------------------------------ compatibility
export interface ContractDiff { breaking: string[]; additive: string[] }

/**
 * What a change of the orchestrator's contract means for frontends that were built against the previous one. BREAKING: an operation, a
 * response status or a DTO field disappears or changes type, a response field becomes optional, a request field becomes required, a route
 * needs more scopes. ADDITIVE: anything that only adds. A frontend built against the old contract keeps working across additive changes.
 */
export function diffContracts(prev: OrchestratorContract, next: OrchestratorContract): ContractDiff {
  const breaking: string[] = [], additive: string[] = [];
  const nextOps = new Map(next.operations.map((o) => [o.id, o]));
  const prevOps = new Map(prev.operations.map((o) => [o.id, o]));
  const bodyUse = (c: OrchestratorContract): Set<string> => new Set(c.operations.map((o) => o.body).filter((x): x is string => x !== null));
  const prevBody = bodyUse(prev), nextBody = bodyUse(next);
  for (const [id, a] of prevOps) {
    const b = nextOps.get(id);
    if (!b) { breaking.push(`operation ${id} was removed`); continue; }
    for (const s of b.scopes) if (!a.scopes.includes(s)) breaking.push(`${id}: now requires the scope "${s}"`);
    if (a.auth !== b.auth) (a.auth === "public" ? breaking : additive).push(`${id}: authentication changed from ${a.auth} to ${b.auth}`);
    if (a.body !== b.body) (b.body ? breaking : additive).push(`${id}: request body changed from ${a.body ?? "none"} to ${b.body ?? "none"}`);
    for (const [code, sa] of Object.entries(a.responses ?? {})) {
      const sb = b.responses?.[code];
      if (!sb) { breaking.push(`${id}: the ${code} response is no longer declared`); continue; }
      if (JSON.stringify(sa) !== JSON.stringify(sb)) breaking.push(`${id}: the ${code} response changed from ${responseType(sa)} to ${responseType(sb)}`);
    }
    for (const code of Object.keys(b.responses ?? {})) if (!a.responses?.[code]) additive.push(`${id}: a ${code} response is now declared`);
  }
  for (const id of nextOps.keys()) if (!prevOps.has(id)) additive.push(`operation ${id} was added`);
  for (const [name, fa] of Object.entries(prev.dtos)) {
    const fb = next.dtos[name];
    if (!fb) { breaking.push(`DTO ${name} is no longer published`); continue; }
    const asBody = prevBody.has(name) || nextBody.has(name);
    for (const f of fa) {
      const g = fb.find((x) => x.name === f.name);
      if (!g) { breaking.push(`DTO ${name}: field "${f.name}" was removed`); continue; }
      if (g.type !== f.type) breaking.push(`DTO ${name}.${f.name}: type changed from ${f.type} to ${g.type}`);
      const fReq = asBody ? f.required : !f.optional, gReq = asBody ? g.required : !g.optional;
      if (fReq !== gReq) (asBody ? (gReq ? breaking : additive) : (gReq ? additive : breaking)).push(`DTO ${name}.${f.name}: ${gReq ? "became required" : "became optional"}`);
    }
    for (const g of fb) if (!fa.some((x) => x.name === g.name)) ((asBody && g.required) ? breaking : additive).push(`DTO ${name}: field "${g.name}" was added${asBody && g.required ? " and is required in requests" : ""}`);
  }
  for (const name of Object.keys(next.dtos)) if (!prev.dtos[name]) additive.push(`DTO ${name} is now published`);
  return { breaking, additive };
}
