import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAME_PATTERNS, normalizePath, formatDiagnostic, servicePrefix } from "@pso/core";
import { CliError, writeFiles, type WriteResult } from "./fsx.ts";
import { str } from "./args.ts";
import { camel, pascal } from "./templates.ts";
import { findJavaPackage, repeatsPrefix } from "./generators.ts";
import { emit, kebabName, requireWorkspace, type Command } from "./commands.ts";
import { analyzeOrchestrator } from "./http-static.ts";
import { addController, addRoute, applyPlan, classify, emptyPlan, ensureModule } from "./http-gen.ts";
import { orchestratorStructure, requireConsistent, springStructure } from "./project-structure.ts";

const METHODS = ["GET", "POST"] as const;
type Method = (typeof METHODS)[number];

const lines = (...l: string[]): string => l.join("\n") + "\n";

export function contractFor(name: string, service: string, method: Method, route: string): string {
  const op = `${camel(name)}${method === "GET" ? "List" : "Create"}`;
  return JSON.stringify({ name, version: "0.1.0", service, operations: [{ id: op, method, path: route }] }, null, 2) + "\n";
}

const preAuth = (scopes: string[]): string[] =>
  scopes.length ? [`    @PreAuthorize("${scopes.map((x) => `hasAuthority('SCOPE_${x}')`).join(" and ")}")`] : [];

export { repeatsPrefix };

/** where make:resource puts the Spring files: the 0.1 packages, or the layered ones (application/rest, application/dto/response) */
export interface ResourceLayout { rest: string; dtoPkg: string; suffix: string }
export const LEGACY_RESOURCE: ResourceLayout = { rest: "routes", dtoPkg: "contracts", suffix: "Dto" };
export const LAYERED_RESOURCE: ResourceLayout = { rest: "application.rest", dtoPkg: "application.dto.response", suffix: "Response" };

function controller(pkg: string, cls: string, route: string, method: Method, scopes: string[], repeats = false, prefix = "", L: ResourceLayout = LEGACY_RESOURCE): string {
  const get = method === "GET";
  const D = `${cls}${L.suffix}`;
  return lines(
    `package ${pkg}.${L.rest};`,
    "",
    `import ${pkg}.${L.dtoPkg}.${D};`,
    ...(get ? ["import java.util.List;", "import org.springframework.web.bind.annotation.GetMapping;"] : ["import jakarta.validation.Valid;", "import org.springframework.web.bind.annotation.PostMapping;", "import org.springframework.web.bind.annotation.RequestBody;"]),
    ...(scopes.length ? ["import org.springframework.security.access.prepost.PreAuthorize;"] : []),
    "import org.springframework.web.bind.annotation.RequestMapping;",
    "import org.springframework.web.bind.annotation.RestController;",
    ...(repeats ? ["import com.pso.spring.autoconfigure.RepeatsServicePrefix;"] : []),
    "",
    ...(repeats ? [`// The service prefix ${prefix} is applied by PSO, so this resource is served at ${prefix}${route}. The path repeats the prefix on`, "// purpose (the resource is named like the service): @RepeatsServicePrefix says so, otherwise PSO would refuse it as a mistake."] : []),
    "@RestController",
    ...(repeats ? ["@RepeatsServicePrefix"] : []),
    `@RequestMapping("${route}")`,
    `public class ${cls}Controller {`,
    "",
    ...preAuth(scopes),
    ...(get
      ? ["    @GetMapping", `    public List<${D}> list() {`, "        return List.of();", "    }"]
      : ["    @PostMapping", `    public ${D} create(@Valid @RequestBody ${D} body) {`, "        return body;", "    }"]),
    "}",
  );
}

const dto = (pkg: string, cls: string, L: ResourceLayout = LEGACY_RESOURCE): string =>
  lines(`package ${pkg}.${L.dtoPkg};`, "", "import jakarta.validation.constraints.NotBlank;", "import jakarta.validation.constraints.Size;", "", "/** Request and response contract. Jakarta Validation runs because the controller declares @Valid; a violation becomes a 400 problem+json with field errors. */", `public record ${cls}${L.suffix}(@NotBlank @Size(max = 64) String id, @NotBlank @Size(max = 120) String name) {`, "}");

function test(pkg: string, cls: string, route: string, method: Method, scopes: string[], L: ResourceLayout = LEGACY_RESOURCE): string {
  const get = method === "GET";
  const user = scopes.length ? `    @WithMockUser(authorities = {${scopes.map((x) => `"SCOPE_${x}"`).join(", ")}})` : "    @WithMockUser";
  const valid = '"{\\"id\\":\\"1\\",\\"name\\":\\"x\\"}"';
  const call = (body: string) => (get ? `get("${route}")` : `post("${route}").contentType(MediaType.APPLICATION_JSON).content(${body})`);
  const t = (annot: string[], name: string, perform: string, expect: string): string[] =>
    ["    @Test", ...annot, `    void ${name}() throws Exception {`, `        mvc.perform(${perform}).andExpect(status().${expect}());`, "    }", ""];
  return lines(
    `package ${pkg}.${L.rest};`,
    "",
    `import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.${get ? "get" : "post"};`,
    "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;",
    "",
    "import org.junit.jupiter.api.Test;",
    "import org.springframework.beans.factory.annotation.Autowired;",
    "import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;",
    "import org.springframework.boot.test.context.SpringBootTest;",
    ...(get ? [] : ["import org.springframework.http.MediaType;"]),
    "import org.springframework.security.test.context.support.WithMockUser;",
    "import org.springframework.test.web.servlet.MockMvc;",
    "",
    "@SpringBootTest",
    "@AutoConfigureMockMvc",
    `class ${cls}ControllerTests {`,
    "",
    "    @Autowired",
    "    MockMvc mvc;",
    "",
    ...t([user], "authorizedRequestSucceeds", call(valid), "isOk"),
    ...(get ? [] : t([user], "blankFieldsAreRejected", call('"{\\"id\\":\\"\\",\\"name\\":\\"\\"}"'), "isBadRequest")),
    ...(scopes.length ? t(['    @WithMockUser(authorities = "SCOPE_unrelated")'], "missingScopeIsForbidden", call(valid), "isForbidden") : []),
    ...t([], "anonymousRequestIsRejected", call('"{}"'), "isUnauthorized"),
    "}",
  );
}

export const RESOURCE_COMMANDS: Record<string, Command> = {
  "make:resource": {
    usage: "pso make:resource <name> --service <spring-service> [--route /customers] [--method GET|POST] [--guard jwt] [--scopes a,b] [--public] [--dry-run] [--force] [--json]",
    summary: "Generate a connected route + contract in the orchestrator and controller + DTO + test in a Spring service",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const name = kebabName(ctx.positionals[0], "resource");
      const svcName = str(ctx.flags["service"]);
      const svc = config.services.find((s) => s.name === svcName);
      if (!svc || svc.role === "orchestrator") throw new CliError(`--service must name a service of this workspace`, `Known: ${config.services.filter((s) => s.role !== "orchestrator").map((s) => s.name).join(", ") || "(none)"}`);
      if (svc.runtime !== "spring-boot") throw new CliError(`Service "${svc.name}" is ${svc.runtime}; make:resource generates Spring Boot services`);
      const orch = config.services.find((s) => s.role === "orchestrator");
      if (!orch) throw new CliError("The workspace has no orchestrator", "Run `pso create orchestrator <name>` first");

      const method = (str(ctx.flags["method"]) ?? "GET").toUpperCase() as Method;
      if (!METHODS.includes(method)) throw new CliError(`Method "${method}" is not supported by make:resource`, "Supported: GET (collection) and POST. The orchestrator matches exact paths, so item routes (/x/{id}) are not generated.");
      const route = str(ctx.flags["route"]) ?? `/${name}`;
      if (!/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(route)) throw new CliError(`Invalid route "${route}"`, "Use literal segments, e.g. /customers or /v1/customers");
      const guard = str(ctx.flags["guard"]) ?? "jwt";
      if (!NAME_PATTERNS.kebab.test(guard)) throw new CliError(`Invalid guard "${guard}"`);
      const scopes = (str(ctx.flags["scopes"]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (scopes.some((x) => !/^[A-Za-z0-9:._-]+$/.test(x))) throw new CliError("Invalid scope name");
      const isPublic = ctx.flags["public"] === true;
      if (isPublic && method !== "GET") throw new CliError("Refusing to generate a public non-GET route", "Public state-changing routes are unsafe; use a guard");

      const orchDir = join(root, ...orch.path.split("/"));
      const svcDir = join(root, ...svc.path.split("/"));
      const pkg = findJavaPackage(svcDir);
      const cls = pascal(name);
      const contract = contractFor(name, svc.name, method, route);
      const effScopes = isPublic ? [] : scopes;
      const pkgPath = pkg.split(".").join("/");

      // each side in the structure it follows: a layered service gets application/rest + application/dto/response; a modular
      // orchestrator keeps its JSON contracts in src/.app/contracts (the module itself goes to src/modules through the AST generators)
      const sst = springStructure(svcDir);
      requireConsistent(sst.finding, svc.name);
      const L = sst.layout.structure === "layered" ? LAYERED_RESOURCE : LEGACY_RESOURCE;
      const javaDir = (p: string) => p.split(".").join("/");
      const ost = orchestratorStructure(orchDir);
      requireConsistent(ost.finding, orch.name);
      const contractFiles = { [`src/${ost.layout.component("contracts")}/${name}.contract.json`]: contract };
      const svcFiles = {
        [`src/main/java/${pkgPath}/${javaDir(L.rest)}/${cls}Controller.java`]: controller(pkg, cls, route, method, effScopes, repeatsPrefix(servicePrefix(svc), route), servicePrefix(svc), L),
        [`src/main/java/${pkgPath}/${javaDir(L.dtoPkg)}/${cls}${L.suffix}.java`]: dto(pkg, cls, L),
        [`src/main/resources/contracts/${name}.contract.json`]: contract,
        [`src/test/java/${pkgPath}/${javaDir(L.rest)}/${cls}ControllerTests.java`]: test(pkg, cls, servicePrefix(svc) + route, method, effScopes, L),
      };
      const docs = {
        [`docs/api/${name}.md`]: `# ${cls}\n\n\`${method} ${route}\` served by **${svc.name}** through **${orch.name}**.\n\n- Access: ${isPublic ? "public" : `guard \`${guard}\`${scopes.length ? `, scopes ${scopes.join(", ")}` : ""}`}\n- Declaration: \`${orch.path}/src/routes/${name}/ROUTES.pso.ts\` (module \`${name}\`)\n- Contract: \`${orch.path}/src/contracts/${name}.contract.json\` (mirrored in \`${svc.path}/src/main/resources/contracts/\`)\n- Controller: \`${svc.path}/src/main/java/${pkgPath}/routes/${cls}Controller.java\`\n`,
      };

      const dryRun = ctx.flags["dry-run"] === true, force = ctx.flags["force"] === true;
      const files: Array<[string, string, Record<string, string>]> = [[orchDir, orch.path, contractFiles], [svcDir, svc.path, svcFiles], [root, ".", docs]];
      const tag = (label: string, rs: WriteResult[]): WriteResult[] => rs.map((r) => ({ ...r, path: label === "." ? r.path : `${label}/${r.path}` }));
      // all-or-nothing: look for conflicts everywhere before writing anything
      const preview = files.flatMap(([dir, label, f]) => tag(label, writeFiles(dir, f, { dryRun: true, force })));
      const conflicts = preview.filter((r) => r.action === "conflict");
      if (conflicts.length) {
        emit(ctx, { dryRun, files: preview }, preview.map((r) => `${dryRun ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`).join("\n"));
        ctx.print(`\n${conflicts.length} file(s) exist with different content; nothing was written. Use --force to overwrite.`);
        return 1;
      }

      // orchestrator side: module + controller + ROUTES.pso.ts entry, through the AST generators
      const hplan = emptyPlan();
      ensureModule(orchDir, hplan, name);
      addController(orchDir, hplan, name, name, route);
      const declared = analyzeOrchestrator(orchDir).models.find((m) => m.dir === name)?.routes ?? [];
      const action = method === "GET" ? "findAll" : "create";
      const already = declared.some((r) => r.method === method && normalizePath(r.path) === normalizePath(route));
      if (!already) addRoute(orchDir, hplan, { mod: name, action, method, path: "/", ...(isPublic ? { public: true } : { guard, ...(scopes.length ? { scopes } : {}) }), service: svc.name });
      const { rows: hr, plan: prunedPlan } = classify(orchDir, hplan);
      const hrows = hr.map((x) => ({ path: `${orch.path}/${x.path}`, action: x.action }));

      if (dryRun) {
        const all = [...preview, ...hrows];
        emit(ctx, { dryRun, files: all }, all.map((r) => `[dry-run] ${r.action.padEnd(10)} ${r.path}`).join("\n"));
        return 0;
      }
      const before = new Set(analyzeOrchestrator(orchDir).diagnostics.map((d) => `${d.code}|${d.file ?? ""}|${d.message}`));
      const applied = applyPlan(orchDir, prunedPlan);
      const introduced = analyzeOrchestrator(orchDir).diagnostics.filter((d) => d.severity === "error" && !before.has(`${d.code}|${d.file ?? ""}|${d.message}`));
      if (introduced.length) {
        applied.rollback();
        throw new CliError(`The generated orchestrator module would be inconsistent; nothing was written:\n${introduced.map(formatDiagnostic).join("\n")}`);
      }
      const results = [...files.flatMap(([dir, label, f]) => tag(label, writeFiles(dir, f, { force }))), ...hrows];
      // A public route must be public in BOTH tiers: the service authorizes every request itself and is secure by default, so the
      // generator declares the exception explicitly in its pso.security.rules (never implied by anything else, e.g. a public page)
      const notes: string[] = [];
      if (isPublic) {
        const yml = join(svcDir, "src", "main", "resources", "application.yml");
        const text = existsSync(yml) ? readFileSync(yml, "utf8") : "";
        const entry = [`      - path: ${route}`, `        methods: [${method}]`, `        access: PUBLIC      # generated by pso make:resource ${name} --public`];
        const already = text.includes(`- path: ${route}\n`) || text.includes(`- path: ${route}\r\n`);
        if (already) notes.push(`${svc.path}/src/main/resources/application.yml already declares ${route}`);
        else if (/^    rules: \[\][^\n]*$/m.test(text)) { writeFileSync(yml, text.replace(/^    rules: \[\]([^\n]*)$/m, (_m, c: string) => [`    rules:${c}`, ...entry].join("\n"))); results.push({ path: `${svc.path}/src/main/resources/application.yml`, action: "updated" as never }); notes.push(`declared PUBLIC access for ${method} ${route} in pso.security.rules of ${svc.name}: the service is secure by default`); }
        else if (/^    rules:\s*(#[^\n]*)?$/m.test(text)) { writeFileSync(yml, text.replace(/^(    rules:\s*(#[^\n]*)?)$/m, (m) => [m, ...entry].join("\n"))); results.push({ path: `${svc.path}/src/main/resources/application.yml`, action: "updated" as never }); notes.push(`declared PUBLIC access for ${method} ${route} in pso.security.rules of ${svc.name}`); }
        else notes.push(`WARNING: add a PUBLIC rule for ${method} ${route} to pso.security.rules in ${svc.path}/src/main/resources/application.yml, or the service keeps requiring a token (it is secure by default)`);
      }
      emit(ctx, { dryRun, files: results, notes }, [...results.map((r) => `${r.action.padEnd(10)} ${r.path}`), ...notes].join("\n"));
      return 0;
    },
  },
};
