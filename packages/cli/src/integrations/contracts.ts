import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { parsePattern } from "@pso/channels";
import { orchestratorModulesDir } from "../project-structure.ts";

/**
 * Client-safe channel contracts, generated from the orchestrator's declarations by STATIC analysis (nothing is executed).
 * Included: registered channels that browsers can reach, the parameters of their names, the server events (and their payload types) and the
 * client commands (and their payload types). Excluded by construction: internal channels, publishers, authorization methods and policies,
 * scopes, configuration and any service address. A type is a developer-experience aid: the server still authorizes every subscription.
 */
export interface ChannelContractInfo { pattern: string; params: string[]; events: Record<string, string>; commands: Record<string, string> }
export interface Contracts { channels: ChannelContractInfo[]; dtos: Map<string, Array<{ name: string; optional: boolean; type: string }>>; warnings: string[] }

const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((e) => { const p = join(dir, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; }) : []);
const decoratorsOf = (n: ts.Node): ts.Decorator[] => (ts.canHaveDecorators(n) ? [...(ts.getDecorators(n) ?? [])] : []);
const callOf = (d: ts.Decorator): { name: string; args: readonly ts.Expression[] } | undefined => (ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) ? { name: d.expression.expression.text, args: d.expression.arguments } : undefined);
const str = (e: ts.Expression | undefined): string | undefined => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);

export function extractContracts(orchestratorDir: string): Contracts {
  const routes = orchestratorModulesDir(orchestratorDir);
  const warnings: string[] = [];
  const dtos = new Map<string, Array<{ name: string; optional: boolean; type: string }>>();
  const found: Array<ChannelContractInfo & { cls: string; module: string; internal: boolean }> = [];
  const registered = new Map<string, Set<string>>();
  for (const file of walk(routes)) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const module = file.slice(routes.length + 1).split(/[\\/]/)[0]!;
    if (/MODULE\.pso\.ts$/.test(file)) {
      const m = /\bchannels\s*:\s*\[([^\]]*)\]/.exec(text);
      registered.set(module, new Set(m ? m[1]!.split(",").map((x) => x.trim()).filter(Boolean) : []));
    }
    ts.forEachChild(sf, function visit(n): void {
      if (ts.isClassDeclaration(n) && n.name) {
        const decos = decoratorsOf(n).map(callOf);
        const dto = decos.find((d) => d?.name === "Dto");
        if (dto) dtos.set(n.name.text, n.members.filter(ts.isPropertyDeclaration).filter((p) => ts.isIdentifier(p.name)).map((p) => ({
          name: (p.name as ts.Identifier).text,
          optional: !!p.questionToken || decoratorsOf(p).some((d) => callOf(d)?.name === "Optional"),
          type: p.type ? p.type.getText(sf) : "unknown",
        })));
        const ch = decos.find((d) => d?.name === "Channel");
        if (ch) {
          const pattern = str(ch.args[0]);
          const opts = ch.args[1] && ts.isObjectLiteralExpression(ch.args[1]) ? ch.args[1] : undefined;
          const prop = (name: string): ts.Expression | undefined => opts?.properties.filter(ts.isPropertyAssignment).find((p) => ts.isIdentifier(p.name) && p.name.text === name)?.initializer;
          const events: Record<string, string> = {};
          const ev = prop("events");
          if (ev && ts.isObjectLiteralExpression(ev)) for (const p of ev.properties.filter(ts.isPropertyAssignment)) { const k = ts.isStringLiteral(p.name) ? p.name.text : ts.isIdentifier(p.name) ? p.name.text : undefined; if (k && ts.isIdentifier(p.initializer)) events[k] = p.initializer.text; }
          const commands: Record<string, string> = {};
          for (const mem of n.members.filter(ts.isMethodDeclaration)) {
            const on = decoratorsOf(mem).map(callOf).find((d) => d?.name === "OnEvent");
            const evName = str(on?.args[0]);
            if (!on || !evName) continue;
            for (const prm of mem.parameters) { const pl = decoratorsOf(prm).map(callOf).find((d) => d?.name === "Payload"); const a = pl?.args[0]; if (a && ts.isIdentifier(a)) commands[evName] = a.text; }
          }
          if (pattern) { try { const p = parsePattern(pattern); found.push({ cls: n.name.text, module, pattern: p.source, params: [...p.params], events, commands, internal: str(prop("visibility")) === "internal" }); } catch { warnings.push(`${n.name.text}: invalid channel pattern "${pattern}" (skipped)`); } }
        }
      }
    });
  }
  const channels = found.filter((c) => registered.get(c.module)?.has(c.cls) && !c.internal).sort((a, b) => a.pattern.localeCompare(b.pattern));
  for (const c of found) if (!registered.get(c.module)?.has(c.cls)) warnings.push(`${c.cls} is not registered in MODULE.pso.ts: no contract generated (it is inactive)`);
  return { channels: channels.map(({ pattern, params, events, commands }) => ({ pattern, params, events, commands })), dtos, warnings };
}

export const CONTRACTS_MARKER = "pso:generated contracts";
const SAFE_TYPE = /^(string|number|boolean|null|undefined|unknown|"[^"\\]*"|'[^'\\]*'|-?\d+(\.\d+)?|[A-Z][A-Za-z0-9]*|\||\[\]|\(|\)|Array<|Record<string, |>|\s|,)+$/;

/**
 * TypeScript source of the contracts file, and the warnings found while generating it. Warnings are for the developer running the CLI and are
 * NEVER written into the file: it ships to browsers and must not mention server classes or internals.
 */
export function renderContracts(c: Contracts): { text: string; warnings: string[] } {
  const used = new Set<string>();
  const need = (name: string): void => {
    if (used.has(name)) return;
    const dto = c.dtos.get(name);
    if (!dto) return;
    used.add(name);
    for (const p of dto) for (const ref of p.type.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? []) need(ref);
  };
  for (const ch of c.channels) for (const d of [...Object.values(ch.events), ...Object.values(ch.commands)]) need(d);
  const warnings = [...c.warnings];
  const iface = (name: string): string => `export interface ${name} {\n${c.dtos.get(name)!.map((p) => { let t = p.type; if (!SAFE_TYPE.test(t) || /\bPsoUploadedFile\b/.test(t)) { warnings.push(`${name}.${p.name}: type "${t}" is not a plain data type: emitted as unknown`); t = "unknown"; } return `  ${p.name}${p.optional ? "?" : ""}: ${t};`; }).join("\n")}\n}`;
  const ref = (n: string): string => (c.dtos.has(n) ? n : (warnings.push(`payload class ${n} was not found: emitted as unknown`), "unknown"));
  const entries = c.channels.map((ch) => `  ${JSON.stringify(ch.pattern)}: {\n    params: { ${ch.params.map((p) => `${p}: string`).join("; ")} };\n    events: { ${Object.entries(ch.events).map(([k, v]) => `${JSON.stringify(k)}: ${ref(v)}`).join("; ")} };\n    commands: { ${Object.entries(ch.commands).map(([k, v]) => `${JSON.stringify(k)}: ${ref(v)}`).join("; ")} };\n  };`);
  const text = [
    `// ${CONTRACTS_MARKER}: regenerate with \`pso channels:contracts\`; do not edit by hand.`,
    "// Client-safe contracts of the PSO channels this application may use: names, parameters, event and command payloads.",
    "// They are a typing aid, NOT access control: the server authorizes every subscription and command on its own.",
    "", "export const PROTOCOL_VERSION = 1;", "",
    ...[...used].sort().map(iface).flatMap((x) => [x, ""]),
    entries.length ? `export interface ChannelContracts {\n${entries.join("\n")}\n}` : "// No channels were found yet: declare them in the orchestrator (`pso make:channel`) and run `pso channels:contracts`.\nexport interface ChannelContracts {}",
    "",
  ].join("\n");
  return { text, warnings: [...new Set(warnings)] };
}
