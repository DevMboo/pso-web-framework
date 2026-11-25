import ts from "typescript";

/**
 * Source updates driven by the TypeScript AST. Each helper locates the exact node with the compiler API and splices
 * text at that node's position, so everything else in the file (comments, formatting, user code) is preserved byte for byte.
 * Every helper is idempotent: it returns the text unchanged when the requested change is already present.
 */
const parse = (text: string): ts.SourceFile => ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
const splice = (text: string, at: number, insert: string, remove = 0): string => text.slice(0, at) + insert + text.slice(at + remove);

/** Ensures `import { names } from "module"`; adds to an existing import of that module when there is one. */
export function addNamedImport(text: string, module: string, names: string[]): string {
  let out = text;
  for (const name of names) {
    const sf = parse(out);
    let handled = false, last: ts.ImportDeclaration | undefined;
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      last = st;
      if (!ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== module) continue;
      const nb = st.importClause?.namedBindings;
      if (st.importClause?.isTypeOnly || !nb || !ts.isNamedImports(nb)) continue;
      if (nb.elements.some((e) => e.name.text === name)) { handled = true; break; }
      const end = nb.elements.length ? nb.elements[nb.elements.length - 1]!.getEnd() : nb.getStart() + 1;
      out = splice(out, end, nb.elements.length ? `, ${name}` : ` ${name} `);
      handled = true; break;
    }
    if (handled) continue;
    const line = `import { ${name} } from "${module}";\n`;
    out = last ? splice(out, last.getEnd() + (out[last.getEnd()] === "\n" ? 1 : 0), line.startsWith("\n") ? line : line) : line + (out.startsWith("\n") ? "" : "\n") + out;
  }
  return out;
}

/** Adds a default import (`import x from "./y"`) unless the identifier is already imported. */
export function addDefaultImport(text: string, ident: string, from: string): string {
  const sf = parse(text);
  let last: ts.ImportDeclaration | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    last = st;
    if (st.importClause?.name?.text === ident) return text;
  }
  const line = `import ${ident} from "${from}";\n`;
  return last ? splice(text, last.getEnd() + (text[last.getEnd()] === "\n" ? 1 : 0), line) : line + text;
}

function find(sf: ts.SourceFile, pred: (n: ts.Node) => boolean): ts.Node | undefined {
  let hit: ts.Node | undefined;
  const walk = (n: ts.Node) => { if (hit) return; if (pred(n)) { hit = n; return; } ts.forEachChild(n, walk); };
  walk(sf);
  return hit;
}

/** Appends `elementText` to the array literal that is the value of property `prop` in the first object literal matching `where`. */
export function addToArrayProperty(text: string, prop: string, elementText: string, opts: { alreadyHas?: (el: ts.Expression) => boolean; indent?: string; inline?: boolean } = {}): string {
  const sf = parse(text);
  const target = find(sf, (n) => ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === prop && ts.isArrayLiteralExpression(n.initializer)) as ts.PropertyAssignment | undefined;
  if (!target) throw new Error(`property "${prop}" with an array literal was not found`);
  const arr = target.initializer as ts.ArrayLiteralExpression;
  if (opts.alreadyHas && arr.elements.some((e) => opts.alreadyHas!(e))) return text;
  const indent = opts.indent ?? "    ";
  if (arr.elements.length === 0 && opts.inline) return splice(text, arr.getStart(), `[${elementText}]`, arr.getEnd() - arr.getStart());
  if (arr.elements.length === 0) {
    // `[]` or `[ ]` -> multi-line list
    const inner = arr.getEnd() - 1;
    return splice(text, arr.getStart() + 1, `\n${indent}${elementText}\n${indent.slice(2)}`, inner - (arr.getStart() + 1));
  }
  const lastEl = arr.elements[arr.elements.length - 1]!;
  const multiline = text.slice(arr.getStart(), lastEl.getStart()).includes("\n");
  return splice(text, lastEl.getEnd(), multiline ? `,\n${indent}${elementText}` : `, ${elementText}`);
}

/** Adds a member (method) at the end of the named class. */
export function addClassMember(text: string, className: string, memberText: string): string {
  const sf = parse(text);
  const cls = find(sf, (n) => ts.isClassDeclaration(n) && n.name?.text === className) as ts.ClassDeclaration | undefined;
  if (!cls) throw new Error(`class ${className} not found`);
  const close = cls.getEnd() - 1; // the closing brace
  const before = text.slice(0, close).replace(/\s*$/, "");
  return before + `\n\n${memberText.replace(/\n$/, "")}\n` + text.slice(close);
}

export const classHasMember = (text: string, className: string, member: string): boolean => {
  const cls = find(parse(text), (n) => ts.isClassDeclaration(n) && n.name?.text === className) as ts.ClassDeclaration | undefined;
  return !!cls?.members.some((m) => (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && ts.isIdentifier(m.name) && m.name.text === member);
};

/** Ensures the constructor of `className` has a parameter named `paramName` (adding a constructor if needed). */
export function ensureConstructorParam(text: string, className: string, paramName: string, paramText: string): string {
  const sf = parse(text);
  const cls = find(sf, (n) => ts.isClassDeclaration(n) && n.name?.text === className) as ts.ClassDeclaration | undefined;
  if (!cls) throw new Error(`class ${className} not found`);
  const ctor = cls.members.find(ts.isConstructorDeclaration);
  if (!ctor) {
    const open = cls.members.pos; // right after "{"
    return splice(text, open, `\n  constructor(${paramText}) {}\n`);
  }
  if (ctor.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === paramName)) return text;
  if (ctor.parameters.length === 0) return splice(text, ctor.parameters.pos, paramText);
  return splice(text, ctor.parameters[ctor.parameters.length - 1]!.getEnd(), `, ${paramText}`);
}
