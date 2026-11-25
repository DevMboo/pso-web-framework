import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NAME_PATTERNS, findWorkspaceRoot, loadWorkspace, type ServiceDecl } from "@pso/core";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { camel, pascal } from "./templates.ts";
import { emit, resolveProject, type Command, type Ctx, type Project } from "./commands.ts";
import { emptyPlan, modulePaths, reader, type Plan } from "./http-gen.ts";
import { addNamedImport, addToArrayProperty } from "./ts-edit.ts";
import { runPlan } from "./commands-http.ts";
import { requireConsistent, springStructure } from "./project-structure.ts";

/**
 * Generators for the artifacts whose role used to be ambiguous. Each one states what it generates and how the framework uses it:
 *
 *   make:provider        orchestrator: an injectable class in src/providers/. It takes part in dependency injection only when a module
 *                        lists it in `providers` (--module does that). Explicitly registered, never discovered.
 *   make:hook            orchestrator: a lifecycle hook (onReady / onShutdown) in src/hooks/. It is a provider with a lifecycle: it
 *                        runs only when a module lists it in `providers` (--module). Explicitly registered, never discovered.
 *   make:config          orchestrator: a plain configuration module in src/configs/, consumed by importing it. Spring: a
 *                        @Configuration class (found by Spring's own component scan, like every bean of the service).
 *   make:event           Spring: a LOCAL application event (ApplicationEventPublisher, same process), in application/event/
 *                        (layered) or events/ (0.1 layout); make:listener and the Spring dispatch classes use the same package.
 *   make:listener        Spring: a LOCAL @EventListener for such an event.
 *   make:dispatch-event  both runtimes: the declaration and payload contract of a DISTRIBUTED PSO Dispatch event (broker).
 *   make:dispatch-handler both runtimes: a declared consumer of a PSO Dispatch event.
 *
 * Local events and Dispatch events are different mechanisms: a local event never leaves the process and is lost with it; a Dispatch
 * event is a versioned contract delivered at least once through Redis Streams, RabbitMQ or Kafka. Neither generator pretends to be
 * the other.
 */

const dry = (ctx: Ctx): boolean => ctx.flags["dry-run"] === true;
const kebab = (raw: string | undefined, what: string): string => {
  if (!raw) throw new CliError(`Missing ${what}`);
  if (!NAME_PATTERNS.kebab.test(raw)) throw new CliError(`Invalid ${what} "${raw}"`, "Use kebab-case, e.g. customer-orders");
  return raw;
};

function orchestratorProject(ctx: Ctx, what: string): Project {
  const p = resolveProject(ctx);
  if (p.runtime !== "node") throw new CliError(`${what} is generated in the orchestrator (Node.js)`, "Run it in the orchestrator project or pass --service <orchestrator>");
  return p;
}
function springProject(ctx: Ctx, what: string): Project {
  const p = resolveProject(ctx);
  if (p.runtime !== "spring-boot") throw new CliError(`${what} is generated in a Spring Boot service`, "Run it in the service project or pass --service <spring-service>");
  return p;
}

/** Adds `cls` (imported from `spec`) to `providers` of a module's MODULE.pso.ts, through the AST; existing code is preserved. */
function registerProvider(root: string, plan: Plan, mod: string, cls: string, spec: string): void {
  kebab(mod, "module name");
  const rel = modulePaths(root).module(mod);
  let text = reader(root, plan)(rel);
  if (text === undefined) throw new CliError(`Module "${mod}" does not exist`, `Run \`pso make:module ${mod}\` first`);
  text = addNamedImport(text, spec, [cls]);
  text = addToArrayProperty(text, "providers", cls, { alreadyHas: (e) => e.getText() === cls, inline: true });
  plan[rel in plan.create ? "create" : "update"][rel] = text;
}

const providerSource = (cls: string, id: string): string => `import { Injectable } from "@pso/http";

/**
 * Provider "${id}": a class the framework constructs once per application and injects by constructor type.
 *
 * It exists for a module only when that module lists it in \`providers\` of its MODULE.pso.ts
 * (\`pso make:provider ${id} --module <module>\` adds it); a file in src/providers/ is never loaded on its own.
 * Constructor parameters are injected the same way: other providers of the module, Upstream, UpstreamClient, Dispatch.
 */
@Injectable()
export class ${cls} {
}
`;

const hookSource = (cls: string, id: string): string => `import { Injectable, log, type OnReady, type OnShutdown } from "@pso/http";

/**
 * Lifecycle hook "${id}".
 *
 *   onReady      runs once, after start-up succeeded and the listener is bound, just before the application reports ready.
 *                Throwing (or rejecting) stops start-up: nothing stays running.
 *   onShutdown   runs once during shutdown, after the running requests finished and before the framework releases its resources.
 *
 * A hook is a provider with a lifecycle: it runs only when a module lists this class in \`providers\` of its MODULE.pso.ts
 * (\`pso make:hook ${id} --module <module>\` adds it). A file in src/hooks/ is never run on its own.
 */
@Injectable()
export class ${cls} implements OnReady, OnShutdown {
  async onReady(): Promise<void> {
    log("info", "hook ready", { component: "${id}" });
  }

  async onShutdown(): Promise<void> {
    log("info", "hook stopped", { component: "${id}" });
  }
}
`;

/** A module-registered orchestrator artifact (provider or hook): one file under src/<dir>/ and, with --module, its registration. */
function moduleArtifact(kind: "provider" | "hook", dir: string, source: (cls: string, id: string) => string): Command {
  const suffix = kind === "provider" ? "Provider" : "Hook";
  return {
    usage: `pso make:${kind} <name> [--module <module>] [--service <orchestrator>] [--dry-run] [--json]`,
    summary: kind === "provider"
      ? "Generate an injectable provider class in src/providers/ and, with --module, list it in that module's providers (explicit registration: a provider nobody lists is never constructed)"
      : "Generate a lifecycle hook (onReady / onShutdown) in src/hooks/ and, with --module, list it in that module's providers (a hook nobody lists never runs)",
    next: `list the class in \`providers\` of a MODULE.pso.ts (or pass --module), then \`pso validate\``,
    run(ctx) {
      const { root } = orchestratorProject(ctx, `A ${kind}`);
      const id = kebab(ctx.positionals[0], `${kind} name`);
      const cls = `${pascal(id)}${suffix}`;
      const P = modulePaths(root);
      const mod = str(ctx.flags["module"]);
      // modular: a provider or hook belongs to its module (modules/<m>/providers|hooks/); 0.1: src/providers|hooks/, registered with --module
      if (P.modular && mod === undefined) throw new CliError(`In the modular structure a ${kind} belongs to a module`, `pso make:${kind} ${id} --module <module>`);
      const rel = P.modular ? (kind === "provider" ? P.provider(mod!, id) : `${P.dir(mod!)}/hooks/${id}.hook.ts`) : `src/${dir}/${id}.${kind}.ts`;
      const plan = emptyPlan();
      const existing = reader(root, plan)(rel);
      if (existing === undefined) plan.create[rel] = source(cls, id);
      else if (!new RegExp(`export\\s+class\\s+${cls}\\b`).test(existing)) throw new CliError(`${rel} already exists and does not export a class named ${cls}`, "Existing code is never overwritten; choose another name");
      if (mod !== undefined) registerProvider(root, plan, mod, cls, P.importOf(P.module(mod), rel));
      const code = runPlan(ctx, root, plan);
      if (code === 0 && mod === undefined && !dry(ctx) && ctx.flags["json"] !== true) ctx.print(`\nnext: ${cls} is not used yet. Add it to \`providers\` of a module (pso make:${kind} ${id} --module <module>), then run \`pso validate\`.`);
      return code;
    },
  };
}

// ---------------------------------------------------------------- Spring: local application events

function localEvent(): Command {
  return {
    usage: "pso make:event <name> [--service <spring-service>] [--dry-run] [--force] [--json]",
    summary: "Generate a LOCAL Spring application event (a record published with ApplicationEventPublisher and delivered in the same process). For an event between services use make:dispatch-event",
    next: "publish it with ApplicationEventPublisher.publishEvent(...) and handle it with `pso make:listener <name>`",
    run(ctx) {
      const p = springProject(ctx, "A local application event");
      const id = kebab(javaName(ctx.positionals[0]), "event name");
      const ev = springEventPackage(p);
      const cls = `${pascal(id)}Event`;
      const body = `package ${ev.pkg};

/**
 * LOCAL application event: published with Spring's ApplicationEventPublisher and delivered to the @EventListener methods of THIS
 * process, synchronously, in the publisher's thread and transaction. It never leaves the service and is not stored: for an event
 * other services receive, declare a PSO Dispatch event instead (\`pso make:dispatch-event\`).
 */
public record ${cls}(String id) {
}
`;
      return writeSpring(ctx, p, { [`${ev.dir}/${cls}.java`]: body });
    },
  };
}

function localListener(): Command {
  return {
    usage: "pso make:listener <name> [--service <spring-service>] [--dry-run] [--force] [--json]",
    summary: "Generate a LOCAL Spring @EventListener for the application event of the same name (same process). For an event from another service use make:dispatch-handler",
    next: "create the event with `pso make:event <name>` if it does not exist yet",
    run(ctx) {
      const p = springProject(ctx, "A local event listener");
      const id = kebab(javaName(ctx.positionals[0]), "listener name");
      const ev = springEventPackage(p);
      const dir = ev.dir;
      const cls = `${pascal(id)}Listener`;
      const event = `${pascal(id)}Event`;
      const typed = existsSync(join(p.root, dir, `${event}.java`));
      const body = `package ${ev.pkg};

import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * LOCAL listener: receives ${typed ? `{@link ${event}}` : "application events"} published in THIS process with ApplicationEventPublisher.
 * It is not a PSO Dispatch consumer: events of other services arrive through a broker and are handled by a
 * {@code @PsoEventHandler} method (\`pso make:dispatch-handler\`).
 */
@Component
public class ${cls} {

    @EventListener
    public void on(${typed ? event : "Object"} event) {${typed ? "" : `\n        // ${event} does not exist yet: create it with \`pso make:event ${id}\` and use it as the parameter type`}
    }
}
`;
      return writeSpring(ctx, p, { [`${dir}/${cls}.java`]: body });
    },
  };
}

/**
 * Where the event classes of a Spring service live: application/event/ in the layered structure, events/ in the 0.1 layout.
 * A project that mixes the two conventions is refused before anything is written.
 */
function springEventPackage(p: Project): { pkg: string; dir: string } {
  const st = springStructure(p.root);
  requireConsistent(st.finding, p.name);
  const sub = st.layout.pkg("event")!;
  const pkgPath = st.pkg.split(".").join("/");
  return { pkg: `${st.pkg}.${sub.split("/").join(".")}`, dir: `src/main/java/${pkgPath}/${sub}` };
}

/** CustomerOrders and customer-orders both name the same Java class. */
const javaName = (raw: string | undefined): string | undefined => raw?.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

function writeSpring(ctx: Ctx, p: Project, files: Record<string, string>): number {
  const res = writeFiles(p.root, files, { dryRun: dry(ctx), force: ctx.flags["force"] === true });
  emit(ctx, { dryRun: dry(ctx), files: res }, res.map((r) => `${dry(ctx) ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`).join("\n"));
  const conflicts = res.filter((r) => r.action === "conflict").length;
  if (conflicts) ctx.print(`\n${conflicts} file(s) already exist with different content and were NOT modified. Use --force to overwrite.`);
  return conflicts ? 1 : 0;
}

// ---------------------------------------------------------------- PSO Dispatch: distributed events

const EVENT_NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
const CHANNEL_NAME = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
interface Field { name: string; type: "string" | "integer" | "number" | "boolean"; optional: boolean }
const JAVA_TYPE: Record<Field["type"], [required: string, optional: string]> = { string: ["String", "String"], integer: ["long", "Long"], number: ["double", "Double"], boolean: ["boolean", "Boolean"] };

function parseFields(raw: string | undefined): Field[] {
  const out: Field[] = [];
  for (const part of (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [rawName, type, ...rest] = part.split(":");
    const optional = rawName!.endsWith("?");
    const name = optional ? rawName!.slice(0, -1) : rawName!;
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || rest.length || !type || !(type in JAVA_TYPE)) throw new CliError(`Invalid field "${part}"`, "Use name:type with type string, integer, number or boolean; name? makes it optional. Example: --fields \"orderId:string,total:number,note?:string\"");
    if (out.some((f) => f.name === name)) throw new CliError(`Field "${name}" is listed twice`);
    out.push({ name, type: type as Field["type"], optional });
  }
  return out;
}

const schemaOf = (fields: Field[]): Record<string, unknown> => ({
  type: "object",
  required: fields.filter((f) => !f.optional).map((f) => f.name),
  // an optional field may be absent or null (a Java record serializes a missing value as null)
  properties: Object.fromEntries(fields.map((f) => [f.name, { type: f.optional ? [f.type, "null"] : f.type }])),
});

interface EventSpec { name: string; version: number; channel: string; key?: string; fields: Field[]; consumeOnly: boolean }

function eventSpec(ctx: Ctx): EventSpec {
  const name = ctx.positionals[0];
  if (!name) throw new CliError("Missing event name", "Example: pso make:dispatch-event orders.placed --service orders --fields \"orderId:string,total:number\"");
  if (!EVENT_NAME.test(name)) throw new CliError(`Invalid event name "${name}"`, "Use a dotted lower-case name: <domain>.<what-happened>, e.g. orders.placed");
  const versionRaw = str(ctx.flags["version"]) ?? "1";
  if (!/^[1-9]\d{0,3}$/.test(versionRaw)) throw new CliError(`Invalid --version "${versionRaw}"`, "Use a positive whole number");
  const channel = str(ctx.flags["channel"]) ?? `${name.split(".")[0]}.events`;
  if (!CHANNEL_NAME.test(channel)) throw new CliError(`Invalid --channel "${channel}"`, "Use lower-case letters, digits, - and _ separated by dots, e.g. orders.events");
  const fields = parseFields(str(ctx.flags["fields"]));
  const key = str(ctx.flags["key"]);
  if (key !== undefined && !fields.some((f) => f.name === key && !f.optional)) throw new CliError(`--key "${key}" must be one of the required --fields`, "The key orders the events of one entity: it is a field every event carries");
  return { name, version: Number(versionRaw), channel, ...(key ? { key } : {}), fields, consumeOnly: ctx.flags["consume-only"] === true };
}

/** orders.placed -> OrdersPlaced / orders-placed */
const eventClass = (name: string): string => pascal(name.replace(/[._]/g, "-"));
const eventFile = (name: string): string => name.replace(/[._]/g, "-");

/** The workspace declaration of a project, when it belongs to one (its name is the default event file name and consumer group). */
function declOf(ctx: Ctx, p: Project): ServiceDecl | undefined {
  const root = findWorkspaceRoot(ctx.cwd);
  const config = root ? loadWorkspace(root).config : undefined;
  return config?.services.find((s) => join(root!, ...s.path.split("/")) === p.root) ?? config?.services.find((s) => s.name === str(ctx.flags["service"]));
}

interface Change { path: string; action: "created" | "updated" | "unchanged"; text?: string }

function springEventsFile(p: Project, decl: ServiceDecl | undefined): { rel: string; doc: { events: Array<Record<string, unknown>> } } {
  const dir = join(p.root, "src", "main", "resources", "dispatch");
  const existing = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".events.json")).sort() : [];
  const file = existing[0] ?? `${decl?.name ?? "service"}.events.json`;
  const rel = `src/main/resources/dispatch/${file}`;
  let doc: { events: Array<Record<string, unknown>> } = { events: [] };
  if (existing[0]) {
    try { doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as typeof doc; } catch { throw new CliError(`${rel} is not valid JSON`, "Fix the file, then retry"); }
    if (!Array.isArray(doc.events)) throw new CliError(`${rel} has no "events" array`);
  }
  return { rel, doc };
}

function springDispatchEvent(ctx: Ctx, p: Project, spec: EventSpec): number {
  const decl = declOf(ctx, p);
  const ev = springEventPackage(p);
  const { rel, doc } = springEventsFile(p, decl);
  if (doc.events.some((e) => e["name"] === spec.name && Number(e["version"]) === spec.version)) throw new CliError(`${spec.name} version ${spec.version} is already declared in ${rel}`, "A published contract is never edited in place: declare the next --version for a change");
  doc.events.push({
    name: spec.name, version: spec.version, channel: spec.channel, ...(spec.key ? { key: spec.key } : {}), compatibility: "full",
    ...(spec.consumeOnly ? { publish: false } : {}), schema: schemaOf(spec.fields),
  });
  const cls = `${eventClass(spec.name)}Event`;
  const record = `package ${ev.pkg};

/**
 * Payload of the PSO Dispatch event "${spec.name}" (version ${spec.version}, channel "${spec.channel}"): a DISTRIBUTED event, delivered at least once
 * through the configured broker to every service that declares it. Its contract is the schema in ${rel}:
 * keep this record and that schema in step, and declare a new version instead of changing a published one.
 *${spec.consumeOnly ? `
 * This service only CONSUMES the event (publish: false).` : `
 * Publish it with the injected PsoDispatch (the event must be declared, as it now is):
 *   dispatch.publish("${spec.name}", new ${cls}(${spec.fields.map((f) => f.name).join(", ")}));
 * Inside a transaction that also changes data, use the transactional outbox instead (\`pso dispatch:outbox\`).`}
 */
public record ${cls}(${spec.fields.map((f) => `${JAVA_TYPE[f.type][f.optional ? 1 : 0]} ${f.name}`).join(", ")}) {
}
`;
  const files = { [rel]: JSON.stringify(doc, null, 2) + "\n", [`${ev.dir}/${cls}.java`]: record };
  const changes: Change[] = Object.entries(files).map(([path, text]) => {
    const abs = join(p.root, path);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    return { path, action: current === undefined ? "created" : current === text ? "unchanged" : "updated", text };
  });
  // the payload record is the developer's: an existing one with other content is never replaced
  const recordPath = `${ev.dir}/${cls}.java`;
  if (changes.some((c) => c.path === recordPath && c.action === "updated") && ctx.flags["force"] !== true) throw new CliError(`${recordPath} already exists with different content`, "Nothing was written. Use --force to replace it, or another event name");
  if (!dry(ctx)) writeFiles(p.root, Object.fromEntries(changes.filter((c) => c.action !== "unchanged").map((c) => [c.path, c.text!])), { force: true });
  const rows = changes.map((c) => ({ path: c.path, action: c.action }));
  emit(ctx, { dryRun: dry(ctx), event: spec.name, version: spec.version, channel: spec.channel, files: rows },
    rows.map((r) => `${dry(ctx) ? "[dry-run] " : ""}${r.action.padEnd(10)} ${r.path}`).join("\n") + (dry(ctx) ? "" : `\n\nnext: ${springNext(p, spec)}`));
  return 0;
}

function springNext(p: Project, spec: EventSpec): string {
  const pom = existsSync(join(p.root, "pom.xml")) ? readFileSync(join(p.root, "pom.xml"), "utf8") : "";
  const installed = /<artifactId>pso-dispatch-(redis|rabbitmq|kafka)-starter<\/artifactId>/.test(pom);
  return [
    ...(installed ? [] : ["install a provider (`pso dispatch:install <redis|rabbitmq|kafka>`) and set pso.dispatch.enabled=true: declarations are inert until then"]),
    "`pso dispatch:validate` checks the declaration, `pso dispatch:lock` records the contract",
    spec.consumeOnly ? `handle it with \`pso make:dispatch-handler ${spec.name}\`` : `the services that receive it declare it too: \`pso make:dispatch-event ${spec.name} --consume-only\`, then \`pso make:dispatch-handler ${spec.name}\``,
  ].join("; ");
}

function springDispatchHandler(ctx: Ctx, p: Project, name: string): number {
  const decl = declOf(ctx, p);
  const ev = springEventPackage(p);
  const { rel, doc } = springEventsFile(p, decl);
  const declared = doc.events.filter((e) => e["name"] === name).sort((a, b) => Number(b["version"]) - Number(a["version"]))[0];
  if (!declared) throw new CliError(`"${name}" is not declared in this service (${rel})`, `A handler consumes a declared event. Run \`pso make:dispatch-event ${name} --consume-only --fields "..."\` first (use the publisher's fields)`);
  const base = eventClass(name);
  const event = `${base}Event`;
  const cls = `${base}Handler`;
  const hasRecord = existsSync(join(p.root, ...ev.dir.split("/"), `${event}.java`));
  const group = str(ctx.flags["group"]);
  if (group !== undefined && !/^[a-z][a-z0-9_-]*$/.test(group)) throw new CliError(`Invalid --group "${group}"`, "Use lower-case letters, digits, - and _");
  const body = `package ${ev.pkg};

import com.pso.dispatch.ConsumeContext;
import com.pso.dispatch.PsoEventHandler;
import org.springframework.stereotype.Component;

/**
 * Consumer of the PSO Dispatch event "${name}" (declared in ${rel}): a DISTRIBUTED event that arrives through the
 * configured broker, possibly more than once and possibly from another service. Delivery is at least once: make the work
 * idempotent (ctx.envelope().id() identifies the event). An exception triggers the configured retries, then the dead letter channel.
 * It is not a Spring @EventListener: local application events are a different mechanism (\`pso make:listener\`).
 */
@Component
public class ${cls} {

    @PsoEventHandler(${group ? `value = "${name}", group = "${group}"` : `"${name}"`})
    public void on(${hasRecord ? event : "java.util.Map<String, Object>"} event, ConsumeContext ctx) {
        // idempotent work; ctx.attempt() is 1 on the first try
    }
}
`;
  const code = writeSpring(ctx, p, { [`${ev.dir}/${cls}.java`]: body });
  if (code === 0 && !dry(ctx) && ctx.flags["json"] !== true) ctx.print(`\nnext: implement ${cls}.on, then \`pso dispatch:validate\` and \`pso dispatch:consumers\`${/<artifactId>pso-dispatch-(redis|rabbitmq|kafka)-starter<\/artifactId>/.test(readFileSync(join(p.root, "pom.xml"), "utf8")) ? "" : "; the handler is inert until a provider is installed (`pso dispatch:install`) and pso.dispatch.enabled=true"}`);
  return code;
}

// ---- orchestrator (TypeScript): src/dispatch/<module>/EVENTS.pso.ts
const EVENTS_SKELETON = `import { defineEvents } from "@pso/dispatch";

// The events of this module and the consumer classes that are active. Nothing is discovered: a consumer that is not listed never runs.
export default defineEvents({
  events: [],
  consumers: []
});
`;

function nodeModuleDir(ctx: Ctx, name: string): string { return kebab(str(ctx.flags["module"]) ?? name.split(".")[0]!.replace(/_/g, "-"), "module name"); }

function requireNodeDispatch(root: string): void {
  let deps: Record<string, string> = {};
  try { deps = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {}; } catch { /* reported below */ }
  if (!deps["@pso/dispatch"]) throw new CliError("@pso/dispatch is not a dependency of this orchestrator", "Run `pso dispatch:install <redis|rabbitmq|kafka>` first: it adds the package and the dispatch configuration");
}

function nodeDispatchEvent(ctx: Ctx, p: Project, spec: EventSpec): number {
  requireNodeDispatch(p.root);
  const mod = nodeModuleDir(ctx, spec.name);
  const dir = `src/dispatch/${mod}`;
  const plan = emptyPlan();
  const read = reader(p.root, plan);
  const eventsRel = `${dir}/EVENTS.pso.ts`;
  let events = read(eventsRel);
  const created = events === undefined;
  events ??= EVENTS_SKELETON;
  if (new RegExp(`name:\\s*"${spec.name.replace(/\./g, "\\.")}"\\s*,\\s*version:\\s*${spec.version}\\b`).test(events)) throw new CliError(`${spec.name} version ${spec.version} is already declared in ${eventsRel}`, "A published contract is never edited in place: declare the next --version for a change");
  const schemaRel = `schemas/${eventFile(spec.name)}${spec.version > 1 ? `.v${spec.version}` : ""}.schema.ts`;
  if (read(`${dir}/${schemaRel}`) !== undefined) throw new CliError(`${dir}/${schemaRel} already exists`, "Existing code is never overwritten");
  plan.create[`${dir}/${schemaRel}`] = `// Contract of the PSO Dispatch event "${spec.name}" (version ${spec.version}): what every publisher sends and every consumer accepts.\n// A published version is never changed; declare the next version instead (\`pso dispatch:lock\` records and checks it).\nexport default ${JSON.stringify(schemaOf(spec.fields), null, 2)};\n`;
  const entry = `{ name: "${spec.name}", version: ${spec.version}, channel: "${spec.channel}"${spec.key ? `, key: "${spec.key}"` : ""}${spec.consumeOnly ? ", publish: false" : ""}, schema: "${schemaRel}" }`;
  try { events = addToArrayProperty(events, "events", entry); }
  catch { throw new CliError(`${eventsRel} has no \`events: [ ... ]\` array literal`, "Declare events as a literal array inside defineEvents({ ... })"); }
  plan[created ? "create" : "update"][eventsRel] = events;
  const code = runPlan(ctx, p.root, plan);
  if (code === 0 && !dry(ctx) && ctx.flags["json"] !== true) {
    ctx.print(`\nnext: \`pso dispatch:validate\`${spec.consumeOnly ? `; handle it with \`pso make:dispatch-handler ${spec.name}\`` : `; publish it through the injected Dispatch: await this.dispatch.publish("${spec.name}", { ${spec.fields.map((f) => f.name).join(", ")} })`}`);
  }
  return code;
}

function nodeDispatchHandler(ctx: Ctx, p: Project, name: string): number {
  requireNodeDispatch(p.root);
  const mod = nodeModuleDir(ctx, name);
  const dir = `src/dispatch/${mod}`;
  const plan = emptyPlan();
  const read = reader(p.root, plan);
  const eventsRel = `${dir}/EVENTS.pso.ts`;
  let events = read(eventsRel);
  if (events === undefined || !new RegExp(`name:\\s*"${name.replace(/\./g, "\\.")}"`).test(events)) throw new CliError(`"${name}" is not declared in ${eventsRel}`, `A consumer handles a declared event. Run \`pso make:dispatch-event ${name} --consume-only --fields "..."${mod === name.split(".")[0] ? "" : ` --module ${mod}`}\` first`);
  const base = eventClass(name);
  const cls = `${base}Consumer`;
  const file = `${eventFile(name)}.consumer`;
  const rel = `${dir}/${file}.ts`;
  if (read(rel) !== undefined) throw new CliError(`${rel} already exists`, "Existing code is never overwritten");
  const group = str(ctx.flags["group"]);
  if (group !== undefined && !/^[a-z][a-z0-9_-]*$/.test(group)) throw new CliError(`Invalid --group "${group}"`, "Use lower-case letters, digits, - and _");
  plan.create[rel] = `import { DispatchConsumer, type ConsumeContext } from "@pso/dispatch";

/**
 * Consumer of the PSO Dispatch event "${name}": a DISTRIBUTED event that arrives through the configured broker, possibly more than
 * once. Make the work idempotent; throwing triggers the configured retries, then the dead letter channel.
 * It is active because EVENTS.pso.ts lists it in \`consumers\`; a consumer that is not listed never runs.
 */
@DispatchConsumer("${name}"${group ? `, { group: "${group}" }` : ""})
export class ${cls} {
  async handle(payload: Record<string, unknown>, ctx: ConsumeContext): Promise<void> {
    // idempotent work; ctx.attempt is 1 on the first try
    void payload; void ctx;
  }
}
`;
  events = addNamedImport(events, `./${file}`, [cls]);
  try { events = addToArrayProperty(events, "consumers", cls, { alreadyHas: (e) => e.getText() === cls, inline: true }); }
  catch { throw new CliError(`${eventsRel} has no \`consumers: [ ... ]\` array literal`, "Add `consumers: []` to defineEvents({ ... })"); }
  plan.update[eventsRel] = events;
  const code = runPlan(ctx, p.root, plan);
  if (code === 0 && !dry(ctx) && ctx.flags["json"] !== true) ctx.print(`\nnext: implement ${cls}.handle, then \`pso dispatch:validate\` and \`pso dispatch:consumers\``);
  return code;
}

export const MAKE_COMMANDS: Record<string, Command> = {
  "make:provider": moduleArtifact("provider", "providers", providerSource),
  "make:hook": moduleArtifact("hook", "hooks", hookSource),
  "make:event": localEvent(),
  "make:listener": localListener(),

  "make:dispatch-event": {
    usage: "pso make:dispatch-event <event.name> [--service <name>] [--fields \"orderId:string,total:number,note?:string\"] [--key <field>] [--channel <name>] [--version 1] [--consume-only] [--module <dir>] [--dry-run] [--force] [--json]",
    summary: "Declare a DISTRIBUTED PSO Dispatch event and its payload contract. Spring: dispatch/*.events.json and a payload record; orchestrator: src/dispatch/<module>/EVENTS.pso.ts and a schema. --consume-only declares an event another service publishes",
    next: "`pso dispatch:validate`, then `pso make:dispatch-handler <event.name>` in the services that consume it",
    run(ctx) {
      const p = resolveProject(ctx);
      const spec = eventSpec(ctx);
      if (p.runtime === "spring-boot") {
        if (ctx.flags["module"] !== undefined) throw new CliError("--module applies to the orchestrator (src/dispatch/<module>/)", "A Spring service declares its events in src/main/resources/dispatch/*.events.json");
        return springDispatchEvent(ctx, p, spec);
      }
      if (ctx.flags["force"] === true) throw new CliError("--force applies to Spring services", "In the orchestrator existing files are never replaced");
      return nodeDispatchEvent(ctx, p, spec);
    },
  },

  "make:dispatch-handler": {
    usage: "pso make:dispatch-handler <event.name> [--service <name>] [--group <consumer-group>] [--module <dir>] [--dry-run] [--force] [--json]",
    summary: "Generate a declared consumer of a PSO Dispatch event that this project already declares. Spring: a @PsoEventHandler component; orchestrator: a @DispatchConsumer class listed in EVENTS.pso.ts",
    next: "`pso dispatch:validate` and `pso dispatch:consumers`",
    run(ctx) {
      const p = resolveProject(ctx);
      const name = ctx.positionals[0];
      if (!name) throw new CliError("Missing event name", "Example: pso make:dispatch-handler orders.placed --service billing");
      if (!EVENT_NAME.test(name)) throw new CliError(`Invalid event name "${name}"`, "Use the declared dotted name, e.g. orders.placed");
      if (p.runtime === "spring-boot") {
        if (ctx.flags["module"] !== undefined) throw new CliError("--module applies to the orchestrator (src/dispatch/<module>/)");
        return springDispatchHandler(ctx, p, name);
      }
      if (ctx.flags["force"] === true) throw new CliError("--force applies to Spring services", "In the orchestrator existing files are never replaced");
      return nodeDispatchHandler(ctx, p, name);
    },
  },
};

