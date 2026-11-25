import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "./crypto.ts";
import { err, type DeclDiagnostic } from "./declare.ts";

/** Reads declaration files without executing them (needs the TypeScript compiler, so it is used by the CLI and Studio, never bundled into the agent). */
function evalNode(n: ts.Node, path: string, diags: DeclDiagnostic[]): unknown {
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n)) return evalNode(n.expression, path, diags);
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text);
  if (ts.isArrayLiteralExpression(n)) return n.elements.map((e, i) => evalNode(e, `${path}[${i}]`, diags));
  if (ts.isObjectLiteralExpression(n)) {
    const o: Record<string, unknown> = {};
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) { diags.push(err("PSO-DEC-STATIC", path, "only `key: value` properties are allowed (no spreads, methods or computed keys): a declaration is data")); continue; }
      o[p.name.text] = evalNode(p.initializer, `${path}.${p.name.text}`, diags);
    }
    return o;
  }
  diags.push(err("PSO-DEC-STATIC", path, `\`${n.getText().slice(0, 60)}\` is not a literal: declarations are read without executing project code, so they may contain literal data only (secrets are referenced by name, never computed)`));
  return undefined;
}

export interface LoadedDeclaration { value: unknown; kind: "deployment" | "pipeline" | undefined; file: string; hash: string; diagnostics: DeclDiagnostic[] }

/** Reads `export default defineDeployment({...})` / `definePipeline({...})` (or a bare object literal) without executing it. */
export function parseDeclaration(source: string, file: string): LoadedDeclaration {
  const diagnostics: DeclDiagnostic[] = [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  let expr: ts.Expression | undefined;
  for (const st of sf.statements) if (ts.isExportAssignment(st) && !st.isExportEquals) expr = st.expression;
  let kind: "deployment" | "pipeline" | undefined;
  if (expr && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const fn = expr.expression.text;
    kind = fn === "defineDeployment" ? "deployment" : fn === "definePipeline" ? "pipeline" : undefined;
    if (!kind) diagnostics.push(err("PSO-DEC-ENTRY", file, `export default must be defineDeployment({...}) or definePipeline({...}), not ${fn}(...)`));
    expr = expr.arguments[0];
  } else if (expr && !ts.isObjectLiteralExpression(expr)) diagnostics.push(err("PSO-DEC-ENTRY", file, "export default must be defineDeployment({...}) or definePipeline({...})"));
  if (!expr) { if (!diagnostics.length) diagnostics.push(err("PSO-DEC-ENTRY", file, "no `export default` found")); return { value: undefined, kind, file, hash: sha256(source), diagnostics }; }
  const value = evalNode(expr, "$", diagnostics);
  return { value, kind, file, hash: sha256(source), diagnostics };
}

export function loadDeclarationFile(file: string): LoadedDeclaration {
  if (!existsSync(file)) return { value: undefined, kind: undefined, file, hash: "", diagnostics: [err("PSO-DEC-MISSING", file, "file not found")] };
  return parseDeclaration(readFileSync(file, "utf8"), file);
}

