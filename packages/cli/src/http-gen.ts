import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { joinPaths, NAME_PATTERNS } from "@pso/core";
import { CliError } from "./fsx.ts";
import { camel, pascal } from "./templates.ts";
import { addClassMember, addDefaultImport, addNamedImport, addToArrayProperty, classHasMember, ensureConstructorParam } from "./ts-edit.ts";
import { analyzeOrchestrator } from "./http-static.ts";
import { orchestratorStructure, requireConsistent } from "./project-structure.ts";
import { VERIFIABLE_TYPES, parseSize } from "@pso/http";

/** Files to create and files to update, keyed by path relative to the orchestrator project root. */
export interface Plan { create: Record<string, string>; update: Record<string, string> }
export const emptyPlan = (): Plan => ({ create: {}, update: {} });

/**
 * Where the files of one orchestrator module live and how they import each other, in the structure the project follows:
 *   modular  src/modules/<m>/MODULE.pso.ts, routes/ROUTES.pso.ts, controllers/, services/, providers/, dto/request|response/, mappers/
 *   legacy   src/routes/<m>/MODULE.pso.ts, ROUTES.pso.ts and every other file next to them (0.1)
 */
export interface ModulePaths {
  modular: boolean;
  dir(mod: string): string;
  module(mod: string): string;
  routes(mod: string): string;
  controller(mod: string, base: string): string;
  service(mod: string, base: string): string;
  provider(mod: string, base: string): string;
  mapper(mod: string, base: string): string;
  contract(mod: string, base: string): string;
  dto(mod: string, name: string, side?: "request" | "response"): string;
  /** import specifier of `target` (a project path ending in .ts) as written in the file `from` */
  importOf(from: string, target: string): string;
}
function makePaths(modular: boolean): ModulePaths {
  const dir = (mod: string) => (modular ? `src/modules/${mod}` : `src/routes/${mod}`);
  const sub = (mod: string, d: string, file: string) => (modular ? `${dir(mod)}/${d}/${file}` : `${dir(mod)}/${file}`);
  return {
    modular, dir,
    module: (mod) => `${dir(mod)}/MODULE.pso.ts`,
    routes: (mod) => (modular ? `${dir(mod)}/routes/ROUTES.pso.ts` : `${dir(mod)}/ROUTES.pso.ts`),
    controller: (mod, base) => sub(mod, "controllers", `${base}.controller.ts`),
    service: (mod, base) => sub(mod, "services", `${base}.service.ts`),
    provider: (mod, base) => sub(mod, "providers", `${base}.provider.ts`),
    mapper: (mod, base) => sub(mod, "mappers", `${base}.mapper.ts`),
    contract: (mod, base) => sub(mod, "contracts", `${base}.contract.ts`),
    dto: (mod, name, side = "request") => (modular ? `${dir(mod)}/dto/${side}/${name}.dto.ts` : `${dir(mod)}/dto/${name}.dto.ts`),
    importOf: (from, target) => {
      const f = from.split("/").slice(0, -1), t = target.replace(/\.ts$/, "").split("/");
      let i = 0;
      while (i < f.length && i < t.length - 1 && f[i] === t[i]) i++;
      const up = f.length - i;
      return `${up === 0 ? "./" : "../".repeat(up)}${t.slice(i).join("/")}`;
    },
  };
}
export const LEGACY_PATHS = makePaths(false);
export const MODULAR_PATHS = makePaths(true);
/** The module paths of the orchestrator at `root`; a project that mixes conventions is refused (nothing is written into it). */
export function modulePaths(root: string): ModulePaths {
  const st = orchestratorStructure(root);
  requireConsistent(st.finding, "the orchestrator");
  return st.layout.structure === "modular" ? MODULAR_PATHS : LEGACY_PATHS;
}

const kebab = (s: string, what: string): string => {
  if (!NAME_PATTERNS.kebab.test(s)) throw new CliError(`Invalid ${what} "${s}"`, "Use kebab-case, e.g. customer-orders");
  return s;
};

export function moduleSkeleton(mod: string, P: ModulePaths = LEGACY_PATHS): Record<string, string> {
  const id = `${camel(mod)}Routes`;
  return {
    [P.module(mod)]: `import { defineModule } from "@pso/core";\nimport ${id} from "${P.importOf(P.module(mod), P.routes(mod))}";\n\nexport default defineModule({\n  name: "${mod}",\n  controllers: [],\n  providers: [],\n  routes: ${id},\n  imports: [],\n  exports: []\n});\n`,
    [P.routes(mod)]: `import { defineRoutes } from "@pso/http";\n\n// The authoritative endpoint registry of this module: only routes listed here can be activated.\nexport default defineRoutes({\n  routes: []\n});\n`,
  };
}

export const controllerSkeleton = (cls: string, prefix: string): string =>
  `import { Controller, RestController } from "@pso/http";\n\n@Controller()\n@RestController("${prefix}")\nexport class ${cls} {\n}\n`;

export const serviceSkeleton = (cls: string): string => `export class ${cls} {\n}\n`;
/**
 * Source of a validated DTO. \`fields\` is the compact syntax of \`pso make:dto --fields\`: comma separated \`name[?]:type[:min=N][:max=N]\`
 * with type string | integer | number | boolean | email | date | enum=a|b | string[] ... (\`?\` makes the field optional). No fields: an empty DTO that
 * accepts only {} (unknown properties are rejected).
 */
export function dtoSource(cls: string, fields: string | undefined): string {
  const imports = new Set<string>(["Dto"]);
  const members: string[] = [];
  for (const raw of (fields ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const parts = raw.split(":");
    const rawName = parts[0]!;
    const optional = rawName.endsWith("?");
    const name = optional ? rawName.slice(0, -1) : rawName;
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw new CliError('Invalid field name "' + rawName + '"', "Use camelCase, e.g. firstName or age?");
    if (["constructor", "prototype", "__proto__"].includes(name)) throw new CliError('"' + name + '" cannot be a DTO field');
    const typeText = parts[1];
    if (!typeText) throw new CliError('Field "' + rawName + '" needs a type', "Use name:type, e.g. email:email or age?:integer");
    if (typeText === "file" || typeText === "files") {
      members.push(fileMember(name, optional, typeText === "files", parts.slice(2), imports));
      continue;
    }
    const array = typeText.endsWith("[]");
    const base = array ? typeText.slice(0, -2) : typeText;
    const decs: string[] = [optional ? "Optional()" : "Required()"];
    imports.add(optional ? "Optional" : "Required");
    const add = (n: string, call = n + "()") => { imports.add(n); decs.push(call); };
    const TYPES: Record<string, [string, string]> = { string: ["StringField", "string"], integer: ["IntegerField", "number"], number: ["NumberField", "number"], boolean: ["BooleanField", "boolean"], email: ["Email", "string"], date: ["IsoDate", "string"] };
    let ts: string;
    if (base.startsWith("enum=")) {
      const values = base.slice(5).split("|").filter(Boolean);
      if (values.length === 0 || values.some((v) => !/^[A-Za-z0-9_.-]+$/.test(v))) throw new CliError('Invalid enum values in "' + raw + '"', "Use enum=a|b|c with letters, digits, _ . -");
      if (array) throw new CliError("Arrays of enums are not supported by the generator; declare @ArrayOf by hand");
      add("OneOf", "OneOf(" + values.map((v) => JSON.stringify(v)).join(", ") + ")");
      ts = values.map((v) => JSON.stringify(v)).join(" | ");
    } else {
      const t = TYPES[base];
      if (!t) throw new CliError('Unknown type "' + base + '" for field "' + name + '"', "Use string, integer, number, boolean, email, date or enum=a|b (add [] for arrays)");
      if (array) {
        if (base === "email" || base === "date") throw new CliError('Arrays of "' + base + '" are not supported by the generator; declare @ArrayOf by hand');
        add("ArrayOf", "ArrayOf(" + JSON.stringify(base) + ")"); ts = t[1] + "[]";
      } else { add(t[0]); ts = t[1]; }
    }
    for (const c of parts.slice(2)) {
      const m = /^(min|max)=(-?\d+(?:\.\d+)?)$/.exec(c);
      if (!m) throw new CliError('Invalid constraint "' + c + '" in "' + raw + '"', "Use min=N or max=N");
      const isText = base === "string" || base === "email";
      if (array) add(m[1] === "min" ? "MinItems" : "MaxItems", (m[1] === "min" ? "MinItems" : "MaxItems") + "(" + m[2] + ")");
      else if (isText) add(m[1] === "min" ? "MinLength" : "MaxLength", (m[1] === "min" ? "MinLength" : "MaxLength") + "(" + m[2] + ")");
      else if (base === "integer" || base === "number") add(m[1] === "min" ? "Min" : "Max", (m[1] === "min" ? "Min" : "Max") + "(" + m[2] + ")");
      else throw new CliError('min/max do not apply to "' + base + '" in "' + raw + '"');
    }
    members.push("  " + decs.map((x) => "@" + x).join(" ") + "\n  " + name + (optional ? "?" : "!") + ": " + ts + ";");
  }
  const order = ["Dto", "FileField", "FilesField", "PsoUploadedFile", "Required", "Optional", "StringField", "IntegerField", "NumberField", "BooleanField", "Email", "IsoDate", "OneOf", "ArrayOf", "MinLength", "MaxLength", "Min", "Max", "MinItems", "MaxItems"];
  const names = order.filter((n) => imports.has(n));
  return 'import { ' + names.join(", ") + ' } from "@pso/http";\n\n@Dto()\nexport class ' + cls + ' {' + (members.length ? "\n" + members.join("\n\n") + "\n" : "") + '}\n';
}
/**
 * A file field of an upload DTO: \`name:file:mime=application/pdf:size=10MB:ext=.pdf\` or \`name?:files:mime=image/*:count=5:size=2MB\`.
 * A content type list is mandatory (the generator never produces a field that accepts any file) and every listed type must be one whose
 * content the framework can verify by signature.
 */
function fileMember(name: string, optional: boolean, many: boolean, constraints: string[], imports: Set<string>): string {
  const opts: string[] = [];
  let mime: string[] | undefined;
  for (const c of constraints) {
    const m = /^(size|count|mime|ext)=(.+)$/.exec(c);
    if (!m) throw new CliError('Invalid constraint "' + c + '" for the file field "' + name + '"', "Use mime=a/b|c/d, ext=.pdf|.docx, size=10MB" + (many ? ", count=5" : ""));
    const [, k, v] = m as unknown as [string, string, string];
    if (k === "size") {
      try { parseSize(v); } catch { throw new CliError('Invalid size "' + v + '" for "' + name + '"', 'Use a number of bytes or a value such as 512KB, 10MB'); }
      opts.push("maxSize: " + JSON.stringify(v.toUpperCase()));
    } else if (k === "count") {
      if (!many) throw new CliError('count applies to "files" fields, not to "' + name + '"');
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 100) throw new CliError('count must be between 1 and 100 (got "' + v + '")');
      opts.push("maxFiles: " + v);
    } else if (k === "mime") {
      mime = v.split("|").map((x) => x.trim().toLowerCase());
      for (const t of mime) {
        if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/([a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/.test(t) || t === "*/*") throw new CliError('"' + t + '" is not an acceptable media type for "' + name + '"');
        const ok = t.endsWith("/*") ? VERIFIABLE_TYPES.some((x) => x.startsWith(t.slice(0, -1))) : VERIFIABLE_TYPES.includes(t);
        if (!ok) throw new CliError('The framework cannot verify the content of "' + t + '" (field "' + name + '")', "Verifiable types: " + VERIFIABLE_TYPES.join(", ") + ". Declare the field by hand with unverified: true only if you accept trusting the client.");
      }
    } else {
      const exts = v.split("|").map((x) => x.trim().toLowerCase());
      if (exts.some((e) => !/^\.?[a-z0-9]{1,16}$/.test(e))) throw new CliError('Invalid extension list "' + v + '" for "' + name + '"', "Use ext=.pdf|.docx");
      opts.push("extensions: " + JSON.stringify(exts.map((e) => (e.startsWith(".") ? e : "." + e))));
    }
  }
  if (!mime) throw new CliError('The file field "' + name + '" needs mime=...', "Accepting any file type is not generated. Example: " + name + ":file:mime=application/pdf:size=10MB");
  opts.unshift("required: " + (optional ? "false" : "true"));
  opts.push("mimeTypes: " + JSON.stringify(mime));
  const dec = many ? "FilesField" : "FileField";
  imports.add(dec); imports.add("PsoUploadedFile");
  return "  @" + dec + "({ " + opts.join(", ") + " })\n  " + name + (optional ? "?" : "!") + ": PsoUploadedFile" + (many ? "[]" : "") + ";";
}
export const dtoSkeleton = (cls: string): string => dtoSource(cls, undefined);

/** A reader that sees pending (planned) content first, then the disk. */
export function reader(root: string, plan: Plan): (rel: string) => string | undefined {
  return (rel) => plan.update[rel] ?? plan.create[rel] ?? (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : undefined);
}

const objProp = (o: ts.ObjectLiteralExpression, k: string): ts.Expression | undefined =>
  o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === k)?.initializer;

/** @RestController("...") argument of a class, found through the AST. */
export function controllerPrefix(text: string, cls: string): string | undefined {
  const sf = ts.createSourceFile("c.ts", text, ts.ScriptTarget.ES2023, true);
  let out: string | undefined;
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || n.name?.text !== cls) return;
    for (const d of ts.getDecorators(n) ?? []) {
      const e = d.expression;
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "RestController") out = ts.isStringLiteralLike(e.arguments[0]!) ? (e.arguments[0] as ts.StringLiteral).text : "/";
    }
  });
  return out;
}

export function ensureModule(root: string, plan: Plan, mod: string, P: ModulePaths = modulePaths(root)): void {
  kebab(mod, "module name");
  if (existsSync(join(root, P.module(mod))) || plan.create[P.module(mod)]) return;
  Object.assign(plan.create, moduleSkeleton(mod, P));
}

export function addController(root: string, plan: Plan, mod: string, base: string, prefix: string, P: ModulePaths = modulePaths(root)): { cls: string; file: string } {
  kebab(base, "controller name");
  const cls = `${pascal(base)}Controller`;
  const rel = P.controller(mod, base);
  const read = reader(root, plan);
  if (read(rel) === undefined) plan.create[rel] = controllerSkeleton(cls, prefix);
  const m = P.module(mod);
  let text = read(m);
  if (text === undefined) throw new CliError(`Module "${mod}" does not exist`, `Run \`pso make:module ${mod}\` first`);
  text = addNamedImport(text, P.importOf(m, rel), [cls]);
  text = addToArrayProperty(text, "controllers", cls, { alreadyHas: (e) => e.getText() === cls, inline: true });
  plan[m in plan.create ? "create" : "update"][m] = text;
  return { cls, file: rel };
}

/**
 * An injectable class of the module, registered in its MODULE.pso.ts providers: a service (business coordination, services/) or, in the
 * modular structure, a provider (communication with a microservice, providers/). The legacy structure only knows services.
 */
export function addProvider(root: string, plan: Plan, mod: string, base: string, exportIt: boolean, P: ModulePaths = modulePaths(root), role: "service" | "provider" = "service", source?: string): string {
  kebab(base, `${role} name`);
  const cls = `${pascal(base)}${role === "provider" ? "Provider" : "Service"}`;
  const rel = role === "provider" ? P.provider(mod, base) : P.service(mod, base);
  const read = reader(root, plan);
  if (read(rel) === undefined) plan.create[rel] = source ?? serviceSkeleton(cls);
  const m = P.module(mod);
  let text = read(m);
  if (text === undefined) throw new CliError(`Module "${mod}" does not exist`, `Run \`pso make:module ${mod}\` first`);
  text = addNamedImport(text, P.importOf(m, rel), [cls]);
  text = addToArrayProperty(text, "providers", cls, { alreadyHas: (e) => e.getText() === cls, inline: true });
  if (exportIt) text = addToArrayProperty(text, "exports", cls, { alreadyHas: (e) => e.getText() === cls, inline: true });
  plan[m in plan.create ? "create" : "update"][m] = text;
  return cls;
}

export interface RouteSpec {
  mod: string;
  action: string;
  method: string;
  /** path relative to the controller prefix, as it appears in the decorator */
  path: string;
  controller?: string;
  public?: boolean;
  guard?: string;
  scopes?: string[];
  service?: string;
  /**
   * name of a DTO created with `pso make:dto` (src/routes/<module>/dto/<name>.dto.ts): the body is validated with @Body(Dto). With
   * `service` the validated request is then forwarded: the upstream receives the very bytes the client sent, and only when they passed
   */
  dto?: string;
  /**
   * upstream services the action calls through the injected UpstreamClient to COMPOSE its response (instead of forwarding the
   * request to one service): they are declared on the route (metadata.services), which is what allows the calls at run time
   */
  services?: string[];
  /** GET action that streams a file download from the upstream (forwardDownload) */
  download?: boolean;
  /** with `download`: largest response accepted for this route (e.g. "100MB") */
  maxDownload?: string;
}

const DECORATOR: Record<string, string> = { GET: "Get", POST: "Post", PUT: "Put", PATCH: "Patch", DELETE: "Delete" };

/** Adds the decorated action to the controller AND the matching declaration to ROUTES.pso.ts, keeping both consistent. */
export function addRoute(root: string, plan: Plan, spec: RouteSpec): { fullPath: string } {
  const { mod, action, method } = spec;
  if (!DECORATOR[method]) throw new CliError(`Unsupported method "${method}"`, "Use GET, POST, PUT, PATCH or DELETE");
  if (!/^[a-z][A-Za-z0-9]*$/.test(action)) throw new CliError(`Invalid action name "${action}"`, "Use camelCase, e.g. findAll");
  if (!/^\/[A-Za-z0-9_\-/:]*$/.test(spec.path) || spec.path.includes("..") || spec.path.includes("//")) throw new CliError(`Invalid path "${spec.path}"`, "Use literal segments and :params, e.g. / or /:id");
  if (spec.public && spec.guard) throw new CliError("A route cannot be both --public and guarded");
  if (spec.public && method !== "GET") throw new CliError("Refusing to declare a public non-GET route", "Public state-changing routes are unsafe; use a guard");
  const read = reader(root, plan);
  const P = modulePaths(root);
  if (read(P.module(mod)) === undefined) throw new CliError(`Module "${mod}" does not exist`, `Run \`pso make:module ${mod}\` first`);

  const ctlDirRel = P.controller(mod, "x").split("/").slice(0, -1).join("/");
  const dir = join(root, ctlDirRel);
  const ctlFiles = [...new Set([...(existsSync(dir) ? readdirSync(dir) : []), ...Object.keys(plan.create).filter((k) => k.startsWith(`${ctlDirRel}/`) && !k.slice(ctlDirRel.length + 1).includes("/")).map((k) => k.split("/").pop()!)])].filter((f) => f.endsWith(".controller.ts")).sort();
  const base = spec.controller ?? (ctlFiles.length === 1 ? ctlFiles[0]!.replace(/\.controller\.ts$/, "") : ctlFiles.includes(`${mod}.controller.ts`) ? mod : undefined);
  if (!base) throw new CliError(ctlFiles.length ? "Several controllers exist: choose one with --controller <name>" : `Module "${mod}" has no controller`, ctlFiles.length ? `Found: ${ctlFiles.join(", ")}` : `Run \`pso make:controller ${mod}\``);
  const cls = `${pascal(base)}Controller`;
  const cRel = P.controller(mod, base);
  let ctl = read(cRel);
  if (ctl === undefined) throw new CliError(`Controller ${cls} not found at ${cRel}`);
  const prefix = controllerPrefix(ctl, cls);
  if (prefix === undefined) throw new CliError(`${cls} has no @RestController(prefix) decorator`, "Add @Controller() and @RestController(\"/prefix\")");
  const fullPath = joinPaths(prefix, spec.path);

  if (classHasMember(ctl, cls, action)) throw new CliError(`${cls} already has a member named "${action}"`, "Existing code is never overwritten; choose another action name");
  // duplicate check across the whole orchestrator, including what this plan already added
  const existing = analyzeOrchestrator(root).models.flatMap((m) => m.routes);
  const sig = (p: string) => p.replace(/:[A-Za-z_]\w*/g, ":");
  if (existing.some((r) => r.method === method && sig(r.path) === sig(fullPath))) throw new CliError(`${method} ${fullPath} is already declared`, "Duplicate route declarations are rejected");

  // --- controller action ---
  const params = [...fullPath.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]!);
  // an action that forwards to an upstream must not consume the body itself
  let uploadDto = false;
  if (spec.dto) {
    const src = read(P.dto(mod, kebab(spec.dto, "dto name")));
    uploadDto = src !== undefined && /@Files?Field\(/.test(src);
  }
  if (uploadDto && !spec.service) throw new CliError("A DTO with file fields is forwarded to a service: add --upstream <service>", "The orchestrator receives, validates and forwards the files; the service stores them (pso make:files)");
  if (spec.download) {
    if (method !== "GET") throw new CliError("--download applies to GET actions");
    if (!spec.service) throw new CliError("--download streams a file from a service: add --upstream <service>");
    if (spec.dto) throw new CliError("--download does not take a body: remove --dto");
  }
  if (spec.maxDownload && !spec.download) throw new CliError("--max-download applies to --download actions");
  if (spec.services?.length) {
    if (spec.service) throw new CliError("--compose and --upstream are two different actions", "--upstream forwards the request to one service; --compose calls several services and builds the response. Choose one");
    if (spec.download) throw new CliError("--download forwards a file from one service: it cannot be combined with --compose");
    if (uploadDto) throw new CliError("A DTO with file fields is forwarded to one service (--upstream): it cannot be combined with --compose");
    for (const s of spec.services) kebab(s, "service name");
    if (new Set(spec.services).size !== spec.services.length) throw new CliError("--compose lists a service twice");
  }
  let maxDownload: number | undefined;
  if (spec.maxDownload) { try { maxDownload = parseSize(spec.maxDownload); } catch { throw new CliError(`Invalid --max-download "${spec.maxDownload}"`, "Use a number of bytes or a value such as 100MB"); } }
  // An action that forwards to an upstream leaves the body to forward(), with two exceptions: an upload (the framework binds and
  // validates the files, then forwards them) and a validated forward (--upstream with --dto: @Body(Dto) validates the JSON body at the
  // gateway; forward() then sends the bytes it kept, so an invalid request never reaches the service)
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
  if (spec.dto && !hasBody) throw new CliError("--dto applies to POST, PUT and PATCH actions (the methods that carry a body)");
  const validatedForward = !!spec.service && !!spec.dto && !uploadDto;
  const body = hasBody && (!spec.service || uploadDto || validatedForward);
  const args: string[] = [...params.map((p) => `@Param("${p}") ${p}: string`)];
  let dtoImport: { cls: string; from: string } | undefined;
  if (body && spec.dto) {
    const dtoName = kebab(spec.dto, "dto name"), dtoRel = P.dto(mod, dtoName);
    const dtoSrc = read(dtoRel);
    if (dtoSrc === undefined) throw new CliError(`DTO ${dtoRel} does not exist`, `Run \`pso make:dto ${mod} ${dtoName} --fields "name:string"\` first`);
    const dtoCls = `${pascal(dtoName)}Dto`;
    if (!new RegExp(`@Dto\\([^)]*\\)\\s*export class ${dtoCls}\\b`).test(dtoSrc)) throw new CliError(`${dtoRel} does not export a @Dto() class named ${dtoCls}`, "Only classes decorated with @Dto() can validate a body");
    dtoImport = { cls: dtoCls, from: P.importOf(cRel, dtoRel) };
    args.push(`@Body(${dtoCls}) ${validatedForward ? "_body" : "body"}: ${dtoCls}`);
  } else if (body) args.push("@Body() body: unknown");
  const imports = [DECORATOR[method]!, ...(params.length ? ["Param"] : []), ...(body ? ["Body"] : [])];
  let bodyText: string;
  if (spec.service) {
    args.push("@Req() req: IncomingMessage", "@Res() res: ServerResponse");
    imports.push("Req", "Res", "Upstream");
    bodyText = uploadDto
      ? `    return this.upstream.forwardUpload(req, res, "${spec.service}", body);`
      : spec.download
        ? `    return this.upstream.forwardDownload(req, res, "${spec.service}"${maxDownload ? `, { maxResponseBytes: ${maxDownload} }` : ""});`
        : validatedForward
          ? `    // the body was validated against ${dtoImport!.cls} before this line; forward() sends the request the client sent\n    return this.upstream.forward(req, res, "${spec.service}");`
          : `    return this.upstream.forward(req, res, "${spec.service}");`;
  } else if (spec.services?.length) {
    imports.push("UpstreamClient");
    const first = spec.services[0]!;
    bodyText = `    // Compose the response from the services this route declares (metadata.services in ROUTES.pso.ts): ${spec.services.join(", ")}.\n    // A call to any other service is refused. Example:\n    //   const item = await this.services.get<{ id: string }>("${first}", "/items/:id", { params: { id: "1" } });\n    // TODO: implement ${action}\n    return {};`;
  } else bodyText = `    // TODO: implement ${action}\n    return {};`;
  ctl = addNamedImport(ctl, "@pso/http", imports);
  if (dtoImport) ctl = addNamedImport(ctl, dtoImport.from, [dtoImport.cls]);
  if (spec.service) {
    ctl = addNamedImport(ctl, "node:http", ["IncomingMessage", "ServerResponse"]);
    ctl = ensureConstructorParam(ctl, cls, "upstream", "private readonly upstream: Upstream");
  }
  if (spec.services?.length) ctl = ensureConstructorParam(ctl, cls, "services", "private readonly services: UpstreamClient");
  const member = `  @${DECORATOR[method]}("${spec.path}")\n  async ${action}(${args.join(", ")}) {\n${bodyText}\n  }`;
  ctl = addClassMember(ctl, cls, member);
  plan[cRel in plan.create ? "create" : "update"][cRel] = ctl;

  // --- route registry ---
  const rRel = P.routes(mod);
  let routes = read(rRel);
  if (routes === undefined) throw new CliError(`Module "${mod}" has no ROUTES.pso.ts`, "Recreate it with `pso make:module`");
  routes = addNamedImport(routes, P.importOf(rRel, cRel), [cls]);
  const security = spec.public ? "{ public: true }" : `{ guard: "${spec.guard ?? "jwt"}"${spec.scopes?.length ? `, scopes: ${JSON.stringify(spec.scopes)}` : ""} }`;
  const entry = `{\n      method: "${method}",\n      path: "${fullPath}",\n      controller: ${cls},\n      action: "${action}",\n      security: ${security}${spec.service ? `,\n      metadata: { service: "${spec.service}" }` : spec.services?.length ? `,\n      metadata: { services: ${JSON.stringify(spec.services)} }` : ""}\n    }`;
  routes = addToArrayProperty(routes, "routes", entry);
  plan[rRel in plan.create ? "create" : "update"][rRel] = routes;
  return { fullPath };
}

/** Drops entries identical to what is on disk (idempotency) and reports every entry as created / updated / unchanged. */
export function classify(root: string, plan: Plan): { rows: Array<{ path: string; action: "created" | "updated" | "unchanged" }>; plan: Plan } {
  const pruned = emptyPlan();
  const rows: Array<{ path: string; action: "created" | "updated" | "unchanged" }> = [];
  for (const [kind, files] of [["create", plan.create], ["update", plan.update]] as const) {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(root, rel);
      const same = existsSync(abs) && readFileSync(abs, "utf8") === text;
      rows.push({ path: rel, action: same ? "unchanged" : kind === "create" ? "created" : "updated" });
      if (!same) pruned[kind][rel] = text;
    }
  }
  return { rows: rows.sort((a, b) => (a.path < b.path ? -1 : 1)), plan: pruned };
}

// ---------- applying a plan transactionally ----------
export interface Applied { created: string[]; updated: string[]; rollback(): void }

export function applyPlan(root: string, plan: Plan): Applied {
  const originals = new Map<string, string | null>();
  const touch = (rel: string, text: string) => {
    const abs = join(root, rel);
    originals.set(rel, existsSync(abs) ? readFileSync(abs, "utf8") : null);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  for (const [rel, text] of Object.entries(plan.create)) touch(rel, text);
  for (const [rel, text] of Object.entries(plan.update)) touch(rel, text);
  return {
    created: Object.keys(plan.create), updated: Object.keys(plan.update),
    rollback() { for (const [rel, text] of originals) { const abs = join(root, rel); if (text === null) rmSync(abs, { force: true }); else writeFileSync(abs, text); } },
  };
}

export { addDefaultImport };
