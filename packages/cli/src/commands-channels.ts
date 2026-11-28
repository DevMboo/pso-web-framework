import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAME_PATTERNS } from "@pso/core";
import { overlaps, parsePattern } from "@pso/channels";
import { CliError, writeFiles } from "./fsx.ts";
import { str } from "./args.ts";
import { camel, pascal } from "./templates.ts";
import { emit, requireWorkspace, resolveProject, type Command, type Ctx } from "./commands.ts";
import { dtoSource, emptyPlan, modulePaths, reader } from "./http-gen.ts";
import { orchestratorStructure, requireConsistent, springStructure } from "./project-structure.ts";
import { runPlan } from "./commands-http.ts";
import { addNamedImport, addToArrayProperty } from "./ts-edit.ts";
import { addPomDependency } from "./commands-java.ts";
import { frameworkSpecs } from "./specs.ts";
import { discoverDispatch } from "./dispatch-static.ts";

/**
 * PSO Channels on the CLI side. `make:channel` writes a channel class (and, for a resource channel, a deny-by-default access provider and the
 * event contract), registers it in MODULE.pso.ts and adds the dependency; `channels:enable` connects a service to Channels through Dispatch;
 * `make:notifier` writes a typed Spring publisher; `channels:validate` checks declarations statically (nothing is executed).
 */
const VIS = ["private", "public", "presence", "internal"] as const;
const PUBLISH_SCHEMA = { type: "object", required: ["v", "id", "type", "channel", "ts", "source", "payload"], additionalProperties: false, properties: { v: { type: "integer" }, id: { type: "string" }, type: { type: "string" }, channel: { type: "string" }, ts: { type: "string" }, correlationId: { type: "string" }, source: { type: "string" }, payload: { type: "object" } } };
const kebab = (s: string, what: string): string => { if (!NAME_PATTERNS.kebab.test(s)) throw new CliError(`Invalid ${what} "${s}"`, "Use kebab-case, e.g. recruitment"); return s; };

function orchestrator(ctx: Ctx) {
  const p = resolveProject(ctx);
  if (p.runtime !== "node") throw new CliError("This command generates orchestrator (Node.js) code", "Run it in the orchestrator project or pass --service <orchestrator>");
  return p;
}
function springService(ctx: Ctx) {
  const { root, config } = requireWorkspace(ctx);
  const springs = config.services.filter((s) => s.runtime === "spring-boot");
  const name = str(ctx.flags["service"]) ?? (springs.length === 1 ? springs[0]!.name : undefined);
  const svc = springs.find((s) => s.name === name);
  if (!svc) throw new CliError("Name the Spring service with --service", `Spring services: ${springs.map((s) => s.name).join(", ") || "(none)"}`);
  return { root, svc, dir: join(root, ...svc.path.split("/")) };
}

export function channelSource(o: { cls: string; pattern: string; visibility: string; publishers: string[]; scopes: string[]; access?: { cls: string; file: string; spec: string }; event?: { type: string; dto: string; file: string; spec: string } }): string {
  const p = parsePattern(o.pattern);
  const params = p.params;
  const imports = ["Channel", "OnSubscribe", "Context", ...(params.length ? ["ChannelParam"] : [])];
  const opts: string[] = [`visibility: "${o.visibility}"`];
  if (o.publishers.length) opts.push(`publishers: ${JSON.stringify(o.publishers)}`);
  if (o.event) opts.push(`events: { ${JSON.stringify(o.event.type)}: ${o.event.dto} }`);
  const lines = [`import { ${imports.join(", ")} } from "@pso/channels";`, `import type { ChannelContext } from "@pso/channels";`];
  if (o.scopes.length) lines.push(`import { Scopes } from "@pso/http";`);
  if (o.access) lines.push(`import { ${o.access.cls} } from "${o.access.spec}";`);
  if (o.event) lines.push(`import { ${o.event.dto} } from "${o.event.spec}";`);
  const auth: string[] = [];
  if (o.visibility === "public") { lines[0] = lines[0]!.replace("OnSubscribe,", "OnSubscribe,"); lines.splice(2, 0, `import { Public } from "@pso/http";`); auth.push("  @OnSubscribe()", "  @Public()", "  authorize(): boolean {", "    return true; // a public channel: nothing sensitive may ever be published on it", "  }"); }
  else if (o.visibility === "internal") { /* no client handlers: clients can never reach an internal channel */ }
  else {
    const args = [...params.map((x) => `@ChannelParam("${x}") ${x}: string`), "@Context() context: ChannelContext"];
    auth.push("  @OnSubscribe()", ...(o.scopes.length ? [`  @Scopes(${o.scopes.map((s) => JSON.stringify(s)).join(", ")})`] : []), `  async authorize(${args.join(", ")}): Promise<boolean> {`,
      o.access ? `    return this.access.canSubscribe(context.user, { ${params.join(", ")} });` : "    return context.user !== null; // authenticated callers only (the scopes above are checked first)", "  }");
  }
  const ctor = o.access ? [`  constructor(private readonly access: ${o.access.cls}) {}`, ""] : [];
  return [...lines, "", `@Channel(${JSON.stringify(o.pattern)}, { ${opts.join(", ")} })`, `export class ${o.cls} {`, ...ctor, ...auth, "}", ""].join("\n").replace(/\n\n\n/g, "\n\n");
}

const accessSource = (cls: string, params: readonly string[]): string => [
  `import { Injectable } from "@pso/http";`, `import type { Principal } from "@pso/security";`, "",
  "/**", " * Who may subscribe to which RESOURCE. Authentication alone never grants access to a resource channel, so this starts closed:", " * every subscription is refused until you write the rule (ownership, assignment, department, tenant).", " */",
  "@Injectable()", `export class ${cls} {`, `  canSubscribe(user: Principal | null, resource: { ${params.map((p) => `${p}: string`).join("; ")} }): boolean {`, "    void resource;", "    return user !== null && false;", "  }", "}", "",
].join("\n");

export const CHANNEL_COMMANDS: Record<string, Command> = {
  "make:channel": {
    usage: "pso make:channel <module> <name> [--pattern <recruitment | candidate.{candidateId}>] [--visibility private|public|presence|internal] [--publisher <service>[,<service>]] [--scopes a:b,c:d] [--event <type> --fields \"name:string,...\"] [--service <orchestrator>] [--dry-run] [--json]",
    summary: "Generate a channel class (and, for a resource channel, a deny-by-default access provider and the event contract), register it in MODULE.pso.ts and add @pso/channels",
    run(ctx) {
      const { root } = orchestrator(ctx);
      const mod = kebab(ctx.positionals[0] ?? "", "module name");
      const name = kebab(ctx.positionals[1] ?? "", "channel name");
      const P = modulePaths(root);
      if (!existsSync(join(root, P.module(mod)))) throw new CliError(`Module "${mod}" does not exist`, `Run \`pso make:module ${mod}\` first`);
      const pattern = str(ctx.flags["pattern"]) ?? name.replace(/-/g, "_").replace(/_/g, "-");
      try { parsePattern(pattern); } catch (e) { throw new CliError((e as Error).message); }
      const visibility = (str(ctx.flags["visibility"]) ?? "private") as (typeof VIS)[number];
      if (!VIS.includes(visibility)) throw new CliError(`Unknown visibility "${visibility}"`, `Use ${VIS.join(", ")}`);
      const publishers = (str(ctx.flags["publisher"]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (publishers.some((p) => !/^[a-z][a-z0-9.-]{0,62}$/.test(p))) throw new CliError("Invalid --publisher", "Use service names such as recruitment-service");
      if (visibility === "internal" && publishers.length === 0) throw new CliError("An internal channel needs at least one --publisher", "Only declared services may publish to it");
      const scopes = (str(ctx.flags["scopes"]) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (scopes.some((s) => !/^[A-Za-z0-9:._-]+$/.test(s))) throw new CliError("Invalid scope name");
      const event = str(ctx.flags["event"]);
      if (event && !/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/.test(event)) throw new CliError(`Invalid --event "${event}"`, "Use a dotted lower-case type such as candidate.updated");
      if (str(ctx.flags["fields"]) && !event) throw new CliError("--fields describes the event payload: add --event <type>");
      const cls = `${pascal(name)}Channel`;
      const plan = emptyPlan();
      const read = reader(root, plan);
      const dir = P.dir(mod);
      // modular: channels (and their access provider) in modules/<m>/channels/; 0.1: next to MODULE.pso.ts
      const chDir = P.modular ? `${dir}/channels` : dir;
      const chRel = `${chDir}/${name}.channel.ts`;
      if (read(chRel) !== undefined) throw new CliError(`${chRel} already exists`);
      const params = parsePattern(pattern).params;
      const accessRel = `${chDir}/${name}-access.ts`;
      const access = params.length && (visibility === "private" || visibility === "presence") ? { cls: `${pascal(name)}Access`, file: `${name}-access`, spec: P.importOf(chRel, accessRel) } : undefined;
      let ev: { type: string; dto: string; file: string; spec: string } | undefined;
      if (event) {
        const dtoName = `${name}-event`;
        const dtoRel = P.dto(mod, dtoName);
        if (read(dtoRel) !== undefined) throw new CliError(`${dtoRel} already exists`);
        plan.create[dtoRel] = dtoSource(`${pascal(dtoName)}Dto`, str(ctx.flags["fields"]) ?? (params.length ? params.map((p) => `${p}:string`).join(",") : undefined));
        ev = { type: event, dto: `${pascal(dtoName)}Dto`, file: `dto/${dtoName}.dto`, spec: P.importOf(chRel, dtoRel) };
      }
      plan.create[chRel] = channelSource({ cls, pattern, visibility, publishers, scopes, ...(access ? { access } : {}), ...(ev ? { event: ev } : {}) });
      if (access) plan.create[accessRel] = accessSource(access.cls, params);
      // MODULE.pso.ts: import, `channels: [...]` (added when the module has none yet) and the access provider
      const mRel = P.module(mod);
      let m = read(mRel)!;
      if (!/\bchannels\s*:\s*\[/.test(m)) m = m.replace(/(\bproviders\s*:\s*\[[^\]]*\])/, "$1,\n  channels: []");
      if (!/\bchannels\s*:\s*\[/.test(m)) throw new CliError("MODULE.pso.ts has an unexpected shape", "Add `channels: []` to defineModule({...}) by hand and run the command again");
      m = addNamedImport(m, P.importOf(mRel, chRel), [cls]);
      m = addToArrayProperty(m, "channels", cls, { alreadyHas: (e) => e.getText() === cls, inline: true });
      if (access) { m = addNamedImport(m, P.importOf(mRel, accessRel), [access.cls]); m = addToArrayProperty(m, "providers", access.cls, { alreadyHas: (e) => e.getText() === access.cls, inline: true }); }
      plan.update[mRel] = m;
      const pkgRel = "package.json";
      const pkg = JSON.parse(read(pkgRel) ?? "{}") as { dependencies?: Record<string, string> };
      if (!pkg.dependencies?.["@pso/channels"]) { pkg.dependencies = { ...pkg.dependencies, "@pso/channels": frameworkSpecs().channelsSpec }; plan.update[pkgRel] = JSON.stringify(pkg, null, 2) + "\n"; }
      const code = runPlan(ctx, root, plan);
      if (code === 0 && ctx.flags["dry-run"] !== true && ctx.flags["json"] !== true) {
        ctx.print(["", `channel "${pattern}" is registered in ${mod}/MODULE.pso.ts (visibility ${visibility}${publishers.length ? `, publishers ${publishers.join(", ")}` : ""})`,
          ...(access ? [`${access.cls} starts CLOSED: every subscription is refused until you implement canSubscribe()`] : []),
          "client:", `  const channels = createPsoChannels({ url: "/channels", getToken });`, `  channels.subscribe(${JSON.stringify(params.length ? pattern.replace(/\{(\w+)\}/g, "<$1>") : pattern)}, { onEvent: (e) => console.log(e.type, e.payload) });`,
          "next: pso channels:validate; the Spring side is `pso channels:enable --service <spring>` and `pso make:notifier`."].join("\n"));
      }
      return code;
    },
  },

  "channels:enable": {
    usage: "pso channels:enable [--service <name>] [--dry-run] [--json]",
    summary: "Connect a service to PSO Channels through Dispatch: for a Spring service the starter, pso.channels and the channels.publish event; for the orchestrator @pso/channels and the Dispatch consumer that delivers events to browsers",
    run(ctx) {
      const { root, config } = requireWorkspace(ctx);
      const dry = ctx.flags["dry-run"] === true;
      const name = str(ctx.flags["service"]);
      const svc = config.services.find((s) => s.name === name) ?? (name ? undefined : config.services.length === 1 ? config.services[0] : undefined);
      if (!svc) throw new CliError("Name the service with --service", `Services: ${config.services.map((s) => `${s.name} (${s.runtime})`).join(", ")}`);
      const dir = join(root, ...svc.path.split("/"));
      const changes: string[] = [];
      const notes: string[] = [];
      const writes: Array<[string, string]> = [];
      if (svc.runtime === "spring-boot") {
        const pomFile = join(dir, "pom.xml");
        let pom = readFileSync(pomFile, "utf8");
        const r = addPomDependency(pom, "pso-channels-spring-boot-starter", "    <dependency>\n      <groupId>com.pso</groupId>\n      <artifactId>pso-channels-spring-boot-starter</artifactId>\n    </dependency>\n");
        if (!r) throw new CliError("pom.xml has an unexpected shape: add com.pso:pso-channels-spring-boot-starter yourself");
        if (r.changed) { changes.push("pom.xml: + pso-channels-spring-boot-starter"); writes.push([pomFile, r.text]); pom = r.text; }
        const yml = join(dir, "src/main/resources/application.yml");
        let y = readFileSync(yml, "utf8");
        if (!/^  channels:/m.test(y)) {
          const at = y.search(/^  database:/m);
          if (at < 0) throw new CliError("application.yml has no pso.database section to anchor the channels settings", "Add `pso.channels.enabled: true` by hand");
          y = y.slice(0, at) + "  channels:                    # publishing to PSO Channels (browsers) over Dispatch; needs dispatch enabled (and the outbox for durable events)\n    enabled: true\n    # dispatch-event: channels.publish\n    # max-payload: 32KB\n" + y.slice(at);
          writes.push([yml, y]); changes.push("application.yml: + pso.channels.enabled");
        }
        const ev = join(dir, "src/main/resources/dispatch/channels.events.json");
        if (!existsSync(ev)) { writes.push([ev, JSON.stringify({ events: [{ name: "channels.publish", version: 1, channel: "channels-events", key: "channel", compatibility: "full", schema: PUBLISH_SCHEMA }] }, null, 2) + "\n"]); changes.push("src/main/resources/dispatch/channels.events.json: the channels.publish event (the contract between this service and the orchestrator)"); }
        notes.push("note: Dispatch must be enabled with a provider (`pso dispatch:install <redis|rabbitmq|kafka>`); durable events also need `pso dispatch:outbox`");
      } else if (svc.runtime === "node") {
        // the orchestrator's side of Channels IS a Dispatch consumer (services' events reach browsers through it): without a Dispatch
        // provider the generated consumer could not even compile. The provider is the developer's choice, so nothing is written before it
        const installed = discoverDispatch(root, config).find((d) => d.service === svc.name)?.installed;
        if (!installed) throw new CliError(`${svc.name} has no Dispatch provider: PSO Channels delivers the services' events to browsers through Dispatch, so the orchestrator needs one first. Nothing was changed`, `Run: pso dispatch:install <redis|rabbitmq|kafka> --service ${svc.name}, then pso channels:enable --service ${svc.name} again`);
        const pkgFile = join(dir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { dependencies?: Record<string, string> };
        if (!pkg.dependencies?.["@pso/channels"]) { pkg.dependencies = { ...pkg.dependencies, "@pso/channels": frameworkSpecs().channelsSpec }; writes.push([pkgFile, JSON.stringify(pkg, null, 2) + "\n"]); changes.push("package.json: + @pso/channels"); }
        const d = join(dir, "src/dispatch/channels");
        if (!existsSync(join(d, "EVENTS.pso.ts"))) {
          writes.push([join(d, "EVENTS.pso.ts"), `import { defineEvents } from "@pso/dispatch";\nimport { ChannelEvents } from "./channels.consumer";\n\n// The only event the Channels bridge consumes: services publish channel events to it, the orchestrator delivers them to browsers.\nexport default defineEvents({\n  events: [{ name: "channels.publish", version: 1, channel: "channels-events", key: "channel", schema: ${JSON.stringify(PUBLISH_SCHEMA)} }],\n  consumers: [ChannelEvents],\n});\n`]);
          writes.push([join(d, "channels.consumer.ts"), `import { DispatchConsumer } from "@pso/dispatch";\nimport { ChannelDispatchConsumer } from "@pso/channels";\n\n// The Dispatch envelope's \`source\` (the authenticated publisher) is checked against each channel's \`publishers\` list.\n@DispatchConsumer("channels.publish", { group: "orchestrator-channels" })\nexport class ChannelEvents extends ChannelDispatchConsumer {}\n`]);
          changes.push("src/dispatch/channels/: EVENTS.pso.ts and the Dispatch consumer that hands events to the channel hub");
        }
        notes.push("note: enable Dispatch for the orchestrator (`pso dispatch:install <provider>`); production needs PSO_CHANNELS_BUS=redis with several instances");
      } else throw new CliError(`Unsupported runtime ${svc.runtime}`);
      if (!dry) for (const [f, t] of writes) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, t); }
      emit(ctx, { service: svc.name, dryRun: dry, changes }, changes.map((c) => `${dry ? "[dry-run] " : ""}${c}`).join("\n") || `${svc.name} is already connected to Channels`);
      return 0;
    },
  },

  "make:notifier": {
    usage: "pso make:notifier <name> --service <spring-service> --channel <candidate.{candidateId}> --event <candidate.updated> --fields \"candidateId:string,status:string\" [--durable] [--dry-run] [--force] [--json]",
    summary: "Generate a typed Spring publisher for a channel event (a record and a service on PsoChannelPublisher; --durable stores the event in the transactional outbox)",
    run(ctx) {
      const name = kebab(ctx.positionals[0] ?? "", "name");
      const { dir, svc } = springService(ctx);
      const pom = readFileSync(join(dir, "pom.xml"), "utf8");
      if (!/<artifactId>pso-channels-spring-boot-starter<\/artifactId>/.test(pom)) throw new CliError(`${svc.name} is not connected to Channels`, `Run \`pso channels:enable --service ${svc.name}\` first`);
      const channel = str(ctx.flags["channel"]), event = str(ctx.flags["event"]);
      if (!channel || !event) throw new CliError("--channel and --event are required", 'Example: --channel "candidate.{candidateId}" --event candidate.updated');
      if (!/^[a-z][a-z0-9_-]{0,63}(\.(\{[A-Za-z][A-Za-z0-9]*\}|[A-Za-z0-9_-]{1,64})){0,7}$/.test(channel)) throw new CliError(`Invalid --channel "${channel}"`);
      if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/.test(event)) throw new CliError(`Invalid --event "${event}"`);
      const params = [...channel.matchAll(/\{(\w+)}/g)].map((m) => m[1]!);
      const TYPES: Record<string, string> = { string: "String", integer: "int", long: "long", boolean: "boolean", number: "double", uuid: "java.util.UUID" };
      const fieldSpec = (str(ctx.flags["fields"]) ?? params.map((p) => `${p}:string`).join(",")).split(",").map((x) => x.trim()).filter(Boolean);
      if (fieldSpec.length === 0) throw new CliError("--fields is required", 'Example: --fields "candidateId:string,status:string"');
      const fields = fieldSpec.map((f) => {
        const [n, t] = f.split(":");
        if (!n || !/^[a-z][A-Za-z0-9]*$/.test(n) || !t || !TYPES[t]) throw new CliError(`Invalid field "${f}"`, `Use name:type with type ${Object.keys(TYPES).join(", ")}`);
        return { n, j: TYPES[t]! };
      });
      for (const p of params) if (!fields.some((f) => f.n === p && f.j !== "boolean")) throw new CliError(`The channel parameter {${p}} must be one of the event fields`);
      // layered: application/event/ (record) and application/service/ (notifier); 0.1 layout: events/ and application/
      const st = springStructure(dir);
      requireConsistent(st.finding, svc.name);
      const pkg = st.pkg;
      const eventSub = st.layout.pkg("event")!, serviceSub = st.layout.pkg("service")!;
      const eventPkg = `${pkg}.${eventSub.split("/").join(".")}`, servicePkg = `${pkg}.${serviceSub.split("/").join(".")}`;
      const cls = pascal(name);
      const durable = ctx.flags["durable"] === true;
      const lit = channel.replace(/\{(\w+)}/g, '" + event.$1() + "');
      const record = `package ${eventPkg};\n\n/** The payload of the "${event}" channel event: what the browsers receive. Keep it small and free of sensitive data. */\npublic record ${cls}Event(${fields.map((f) => `${f.j} ${f.n}`).join(", ")}) {\n}\n`;
      const service = `package ${servicePkg};\n\nimport ${eventPkg}.${cls}Event;\nimport com.pso.spring.channels.PsoChannelPublisher;\nimport org.springframework.stereotype.Service;\n\n/**\n * Publishes "${event}" to the channel "${channel}".\n * ${durable ? "DURABLE: call it from a @Transactional method; the event is stored in the outbox with your data (a rollback removes it)." : "BEST_EFFORT: inside a transaction it is sent after commit; it is lost if the transport fails afterwards."}\n */\n@Service\npublic class ${cls}Notifier {\n\n    private final PsoChannelPublisher publisher;\n\n    public ${cls}Notifier(PsoChannelPublisher publisher) {\n        this.publisher = publisher;\n    }\n\n    public PsoChannelPublisher.Outcome notify(${cls}Event event) {\n        return publisher.publish("${lit}", "${event}", event, PsoChannelPublisher.Options.${durable ? "durable" : "bestEffort"}());\n    }\n}\n`.replace('"" + ', "").replace(' + ""', "");
      const pp = pkg.split(".").join("/");
      const dry = ctx.flags["dry-run"] === true;
      const res = writeFiles(dir, { [`src/main/java/${pp}/${eventSub}/${cls}Event.java`]: record, [`src/main/java/${pp}/${serviceSub}/${cls}Notifier.java`]: service }, { dryRun: dry, force: ctx.flags["force"] === true });
      emit(ctx, { dryRun: dry, files: res }, res.map((r) => `${dry ? "[dry-run] " : ""}${r.action.padEnd(10)} ${svc.path}/${r.path}`).join("\n") + `\n\nthe orchestrator must register a channel with the publisher "${svc.name}": pso make:channel <module> <name> --pattern "${channel}" --publisher ${svc.name} --event ${event}`);
      return res.some((r) => r.action === "conflict") ? 1 : 0;
    },
  },

  "channels:validate": {
    usage: "pso channels:validate [--service <orchestrator>] [--json]",
    summary: "Check channel declarations without running them: invalid, duplicate or ambiguous patterns, classes registered in MODULE.pso.ts that are not channels, channel classes that are not registered",
    run(ctx) {
      const { root } = orchestrator(ctx);
      type Decl = { module: string; cls: string; pattern: string; file: string };
      const decls: Decl[] = [];
      const registered = new Map<string, string[]>();
      const problems: Array<{ severity: "error" | "warning"; message: string; file?: string }> = [];
      const { layout, src: srcDir } = orchestratorStructure(root);
      const routes = join(srcDir, ...layout.modulesDir.split("/"));
      if (existsSync(routes)) for (const mod of readdirSync(routes).sort()) {
        const md = join(routes, mod);
        const mfile = join(md, "MODULE.pso.ts");
        if (!existsSync(mfile)) continue;
        const m = readFileSync(mfile, "utf8");
        const arr = /\bchannels\s*:\s*\[([^\]]*)\]/.exec(m);
        registered.set(mod, arr ? arr[1]!.split(",").map((x) => x.trim()).filter(Boolean) : []);
        const chFiles = [...readdirSync(md).filter((x) => x.endsWith(".ts")), ...(existsSync(join(md, "channels")) ? readdirSync(join(md, "channels")).filter((x) => x.endsWith(".ts")).map((x) => `channels/${x}`) : [])];
        for (const f of chFiles) {
          const src = readFileSync(join(md, ...f.split("/")), "utf8");
          for (const c of src.matchAll(/@Channel\(\s*(["'`])([^"'`]+)\1[^)]*\)\s*(?:export\s+)?class\s+(\w+)/g)) decls.push({ module: mod, cls: c[3]!, pattern: c[2]!, file: `src/${layout.modulesDir}/${mod}/${f}` });
        }
      }
      const patterns = new Map<string, ReturnType<typeof parsePattern>>();
      for (const d of decls) {
        try { patterns.set(`${d.module}/${d.cls}`, parsePattern(d.pattern)); } catch (e) { problems.push({ severity: "error", message: `${d.cls}: ${(e as Error).message}`, file: d.file }); continue; }
        if (!(registered.get(d.module) ?? []).includes(d.cls)) problems.push({ severity: "warning", message: `${d.cls} ("${d.pattern}") is decorated with @Channel but not listed in channels of ${d.module}/MODULE.pso.ts: it stays INACTIVE`, file: d.file });
      }
      const active = decls.filter((d) => (registered.get(d.module) ?? []).includes(d.cls) && patterns.has(`${d.module}/${d.cls}`));
      for (const [i, a] of active.entries()) for (const b of active.slice(i + 1)) {
        const pa = patterns.get(`${a.module}/${a.cls}`)!, pb = patterns.get(`${b.module}/${b.cls}`)!;
        if (pa.source === pb.source) problems.push({ severity: "error", message: `duplicate channel "${pa.source}": ${a.cls} (${a.module}) and ${b.cls} (${b.module})`, file: b.file });
        else if (overlaps(pa, pb)) problems.push({ severity: "error", message: `ambiguous channels "${pa.source}" (${a.cls}) and "${pb.source}" (${b.cls}) can match the same name`, file: b.file });
      }
      for (const [mod, list] of registered) for (const c of list) if (!decls.some((d) => d.module === mod && d.cls === c)) problems.push({ severity: "error", message: `${c} is listed in channels of ${mod}/MODULE.pso.ts but is not a @Channel class declared in that module`, file: `src/routes/${mod}/MODULE.pso.ts` });
      const bad = problems.some((p) => p.severity === "error");
      emit(ctx, { channels: active.map((d) => ({ module: d.module, class: d.cls, pattern: patterns.get(`${d.module}/${d.cls}`)!.source })), problems }, [`${active.length} active channel(s)`, ...active.map((d) => `  ${patterns.get(`${d.module}/${d.cls}`)!.source.padEnd(32)} ${d.cls} (${d.module})`), ...problems.map((p) => `${p.severity === "error" ? "ERROR  " : "warning"} ${p.message}${p.file ? `  [${p.file}]` : ""}`), bad ? "INVALID" : "OK"].join("\n"));
      void camel;
      return bad ? 1 : 0;
    },
  },
};
