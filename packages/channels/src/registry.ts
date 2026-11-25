import { checkDeclaration, isDto } from "@pso/http";
import { handlerPublic, readChannel, readHandlers, readParams, type HandlerMeta, type Visibility } from "./decorators.ts";
import { matchPattern, overlaps, parsePattern, type Pattern } from "./pattern.ts";
import { isEventType } from "./protocol.ts";

type Cls = abstract new (...args: never[]) => unknown;

export interface RegisteredChannel {
  cls: new (...args: never[]) => Record<string, (...a: unknown[]) => unknown>;
  pattern: Pattern;
  visibility: Visibility;
  publishers: ReadonlySet<string>;
  events: ReadonlyMap<string, Cls> | undefined;
  maxSubscribers: number;
  handlers: HandlerMeta[];
  /** the module that registered it */
  module: string;
}

/** The set of explicitly registered channels. Built from `channels: [...]` of the loaded modules; nothing else is ever active. */
export class ChannelRegistry {
  readonly channels: RegisteredChannel[] = [];

  /** Adds the channel classes of one module. Returns every problem found (an empty list when sound); on problems nothing is added. */
  add(module: string, classes: readonly Function[]): string[] {
    const problems: string[] = [];
    const staged: RegisteredChannel[] = [];
    for (const c of classes) {
      const name = (c as { name?: string }).name ?? "(anonymous)";
      const meta = typeof c === "function" ? readChannel(c) : undefined;
      if (!meta) { problems.push(`${module}: ${name} is registered in channels but is not decorated with @Channel()`); continue; }
      let pattern: Pattern;
      try { pattern = parsePattern(meta.pattern); } catch (e) { problems.push(`${module}: ${name}: ${(e as Error).message}`); continue; }
      const at = `${module}: ${name} ("${pattern.source}")`;
      const handlers = readHandlers(c);
      const proto = (c as { prototype: object }).prototype;
      const seen = new Set<string>();
      for (const h of handlers) {
        const key = h.kind === "event" ? `event:${h.event}` : h.kind;
        if (seen.has(key)) problems.push(`${at}: duplicate handler for ${h.kind === "event" ? `event "${h.event}"` : `@On${h.kind[0]!.toUpperCase()}${h.kind.slice(1)}`}`);
        seen.add(key);
        if (typeof (proto as Record<string, unknown>)[h.method] !== "function") problems.push(`${at}: handler ${h.method} is not a method`);
        for (const p of readParams(proto, h.method)) {
          if (p.kind === "param" && !pattern.params.includes(p.name ?? "")) problems.push(`${at}: ${h.method} asks for @ChannelParam("${p.name}") but the pattern has ${pattern.params.length ? pattern.params.join(", ") : "no parameters"}`);
          if (p.kind === "payload") {
            if (h.kind !== "event") problems.push(`${at}: @Payload is only available in @OnEvent handlers (${h.method})`);
            else if (!p.dto || !isDto(p.dto)) problems.push(`${at}: the @Payload class of ${h.method} must be decorated with @Dto()`);
            else problems.push(...checkDeclaration(p.dto as never).map((x) => `${at}: ${h.method}: ${x}`));
          }
        }
        if (h.kind === "event" && !isEventType(h.event)) problems.push(`${at}: invalid event name`);
        if (h.kind === "event" && readParams(proto, h.method).filter((p) => p.kind === "payload").length > 1) problems.push(`${at}: ${h.method} has more than one @Payload`);
      }
      const o = meta.options;
      if (o.visibility === "internal" && (handlers.some((h) => h.kind === "subscribe" || h.kind === "event"))) problems.push(`${at}: an internal channel cannot have client handlers (@OnSubscribe, @OnEvent): clients can never reach it`);
      // never authorize on authentication alone: a channel with parameters designates a resource and must say who may see it
      if ((o.visibility === "private" || o.visibility === "presence") && pattern.params.length > 0 && !handlers.some((h) => h.kind === "subscribe")) {
        problems.push(`${at}: a ${o.visibility} channel with parameters needs an @OnSubscribe method that authorizes the requested resource (authentication alone never grants access to "${pattern.params.join(", ")}")`);
      }
      if (o.visibility === "public") {
        for (const h of handlers) if (!handlerPublic(proto, h.method) && (h.kind === "subscribe" || h.kind === "event")) problems.push(`${at}: public channel handler ${h.method} must be marked @Public() (it runs for anonymous callers)`);
      }
      for (const [type, dto] of Object.entries(o.events ?? {})) {
        if (!isEventType(type)) problems.push(`${at}: invalid server event type "${type}"`);
        if (!isDto(dto)) problems.push(`${at}: the contract of server event "${type}" must be a @Dto class`);
        else problems.push(...checkDeclaration(dto as never).map((x) => `${at}: event "${type}": ${x}`));
      }
      if (o.maxSubscribers !== undefined && (!Number.isInteger(o.maxSubscribers) || o.maxSubscribers < 1)) problems.push(`${at}: maxSubscribers must be a positive integer`);
      for (const s of o.publishers ?? []) if (!/^[a-z][a-z0-9.-]{0,62}$/.test(s)) problems.push(`${at}: invalid publisher service name "${s}"`);
      staged.push({
        cls: c as RegisteredChannel["cls"], pattern, visibility: o.visibility, publishers: new Set(o.publishers ?? []),
        events: o.events ? new Map(Object.entries(o.events)) : undefined, maxSubscribers: o.maxSubscribers ?? Infinity, handlers, module,
      });
    }
    for (const s of staged) {
      for (const other of [...this.channels, ...staged]) {
        if (other === s) continue;
        if (other.cls === s.cls) { problems.push(`${module}: ${(s.cls as { name: string }).name} is registered twice`); break; }
        if (other.pattern.source === s.pattern.source) problems.push(`duplicate channel "${s.pattern.source}" (module ${s.module} and ${other.module})`);
        else if (overlaps(other.pattern, s.pattern)) problems.push(`ambiguous channels: "${s.pattern.source}" (module ${s.module}) and "${other.pattern.source}" (module ${other.module}) can match the same name`);
      }
    }
    const uniq = [...new Set(problems)];
    if (uniq.length === 0) this.channels.push(...staged);
    return uniq;
  }

  /** The registered channel a concrete name resolves to, with its parameters. */
  resolve(name: string): { channel: RegisteredChannel; params: Record<string, string> } | undefined {
    for (const c of this.channels) { const params = matchPattern(c.pattern, name); if (params) return { channel: c, params }; }
    return undefined;
  }
}
