import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveConfig, envLayer, coerce, redact, hasErrors, formatDiagnostic, diag, cmp, ENVIRONMENTS, SCHEMA, flatten, setIn, isStrictConfig,
  type Diagnostic, type Layers, type Resolved, type WorkspaceConfig,
} from "@pso/core";
import { CliError } from "./fsx.ts";
import { str } from "./args.ts";
import { emit, requireWorkspace, type Command, type Ctx } from "./commands.ts";

function readJson(file: string, ds: Diagnostic[]): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("must be a JSON object");
    return v as Record<string, unknown>;
  } catch (e) {
    ds.push(diag("error", "PSO_CONFIG_UNREADABLE", `Cannot read configuration: ${(e as Error).message}`, file));
    return undefined;
  }
}

function environment(ctx: Ctx): string {
  const env = str(ctx.flags["env"]) ?? process.env["PSO_ENV"] ?? "development";
  if (!(ENVIRONMENTS as readonly string[]).includes(env)) throw new CliError(`Unknown environment "${env}"`, `Use one of: ${ENVIRONMENTS.join(", ")}`);
  return env;
}

function cliLayer(ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of (str(ctx.flags["set"]) ?? "").split("\n").filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new CliError(`Invalid --set "${pair}"`, "Use --set key.path=value");
    setIn(out, pair.slice(0, eq), coerce(pair.slice(eq + 1)));
  }
  return out;
}

interface Scope { name: string; layers: Layers; files: string[]; diagnostics: Diagnostic[] }

function buildScope(root: string, ws: WorkspaceConfig, service: string | undefined, env: string, ctx: Ctx): Scope {
  const ds: Diagnostic[] = [];
  const files: string[] = [];
  const layers: Layers = {};
  if (ws.config) layers.workspace = { source: "pso.workspace.json", values: ws.config };

  const envFiles: Array<[string, string]> = [[join(root, `pso.config.${env}.json`), `pso.config.${env}.json`]];
  if (service) {
    const s = ws.services.find((x) => x.name === service);
    if (!s) throw new CliError(`Unknown service "${service}"`, `Known: ${ws.services.map((x) => x.name).join(", ")}`);
    const base = join(root, ...s.path.split("/"));
    const sv = readJson(join(base, "pso.config.json"), ds);
    if (sv) { layers.service = { source: `${s.path}/pso.config.json`, values: sv }; files.push(`${s.path}/pso.config.json`); }
    envFiles.push([join(base, `pso.config.${env}.json`), `${s.path}/pso.config.${env}.json`]);
    layers.defaults = undefined;
    // the service's own port is a declaration, not a guess
    layers.workspace = { source: "pso.workspace.json", values: { ...(ws.config ?? {}), server: { ...((ws.config?.["server"] as object | undefined) ?? {}), port: s.port } } };
  }
  const merged: Record<string, unknown> = {};
  for (const [file, label] of envFiles) {
    const v = readJson(file, ds);
    if (v) { for (const [k, val] of Object.entries(flatten(v))) setIn(merged, k, val); files.push(label); }
  }
  if (Object.keys(merged).length) layers["environment-file"] = { source: files.filter((f) => f.includes(`.${env}.`)).join(" + "), values: merged };
  const ev = envLayer(process.env);
  if (Object.keys(ev).length) layers["environment-variables"] = { source: "PSO_CFG_*", values: ev };
  const cli = cliLayer(ctx);
  if (Object.keys(cli).length) layers.cli = { source: "--set", values: cli };
  if (ws.config) files.unshift("pso.workspace.json#config");
  return { name: service ?? "(workspace)", layers, files, diagnostics: ds };
}

function scopes(ctx: Ctx): { env: string; items: Array<{ scope: Scope; values: Map<string, Resolved>; diagnostics: Diagnostic[] }> } {
  const { root, config } = requireWorkspace(ctx);
  const env = environment(ctx);
  const only = str(ctx.flags["service"]);
  const names: Array<string | undefined> = only ? [only] : [undefined, ...config.services.map((s) => s.name)];
  const items = names.map((n) => {
    const scope = buildScope(root, config, n, env, ctx);
    // strict: an unknown key is an error. On with --strict, in the production environment, or with PSO_CONFIG_STRICT=true; off with PSO_CONFIG_STRICT=false
    const r = resolveConfig(scope.layers, { strict: ctx.flags["strict"] === true || isStrictConfig(process.env, env) });
    return { scope, values: r.values, diagnostics: [...scope.diagnostics, ...r.diagnostics] };
  });
  return { env, items };
}

export const CONFIG_COMMANDS: Record<string, Command> = {
  "config:list": {
    usage: "pso config:list [--service name] [--env development|test|staging|production] [--json]",
    summary: "List configuration sources found per scope and the known configuration keys",
    run(ctx) {
      const { env, items } = scopes(ctx);
      const data = { environment: env, precedence: ["defaults", "workspace", "service", "environment-file", "environment-variables (PSO_CFG_a__b)", "cli (--set a.b=v)"], scopes: items.map((i) => ({ scope: i.scope.name, files: i.scope.files, keys: i.values.size })), knownKeys: Object.keys(SCHEMA) };
      emit(ctx, data, [`environment: ${env}`, `precedence (low -> high): ${data.precedence.join(" < ")}`, ...items.map((i) => `${i.scope.name.padEnd(18)} ${String(i.values.size).padStart(3)} keys  files: ${i.scope.files.join(", ") || "-"}`)].join("\n"));
      return 0;
    },
  },
  "config:show": {
    usage: "pso config:show [--service name] [--env e] [--set key=value ...] [--json]",
    summary: "Show the effective configuration with the origin of every value (secrets redacted)",
    run(ctx) {
      const { env, items } = scopes(ctx);
      const out = items.map(({ scope, values, diagnostics }) => ({
        scope: scope.name, environment: env,
        values: [...values.entries()].sort(([a], [b]) => cmp(a, b)).map(([key, r]) => ({ key, value: redact(key, r), origin: r.origin, source: r.source })),
        diagnostics,
      }));
      emit(ctx, out, out.map((s) => `# ${s.scope} (${env})\n` + s.values.map((v) => `${v.key.padEnd(34)} ${JSON.stringify(v.value).padEnd(20)} <- ${v.origin}`).join("\n")).join("\n\n"));
      return 0;
    },
  },
  "config:validate": {
    usage: "pso config:validate [--service name] [--env e] [--strict] [--json]",
    summary: "Validate configuration against the typed schema and secret-handling rules (exit 1 on errors; unknown keys are errors with --strict and in production)",
    run(ctx) {
      const { items } = scopes(ctx);
      const all = items.flatMap((i) => i.diagnostics.map((d) => ({ ...d, scope: i.scope.name })));
      const bad = hasErrors(all);
      emit(ctx, { ok: !bad, diagnostics: all }, (all.length ? all.map(formatDiagnostic).join("\n") + "\n" : "") + (bad ? "FAILED" : "OK"));
      return bad ? 1 : 0;
    },
  },
};
