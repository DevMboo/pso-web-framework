import "reflect-metadata";
import { DispatchError, isChannelName, isEventName } from "./envelope.ts";
import { schemaProblems, type Compatibility, type Schema } from "./schema.ts";

export interface EventDecl {
  /** event type on the wire, e.g. users.created */
  name: string;
  /** schema version of this event's payload; bump it for incompatible changes */
  version: number;
  /** logical channel (Redis stream, RabbitMQ exchange, Kafka topic) */
  channel: string;
  /** payload schema: a path (relative to EVENTS.pso.ts, resolved by the loader) or an inline schema */
  schema?: string | Schema;
  /** compatibility policy enforced when the schema changes between versions (default: full) */
  compatibility?: Compatibility;
  /** older versions this service still accepts when consuming (default: none) */
  accepts?: number[];
  /** may this service publish the event? Default true. Set false for events that are only consumed. */
  publish?: boolean;
  /** dotted payload path used as the partition/ordering key (e.g. "userId") */
  key?: string;
}

export const CONSUMER_META = "pso:dispatch:consumer";
export interface ConsumerMeta {
  event: string; group?: string; concurrency?: number;
  /**
   * This consumer acts on WHO published the event (a privileged consumer). Every message must then carry a valid signature of the
   * service its envelope names, whatever `dispatch.trust.mode` says: an unsigned, forged or unknown publisher is dead-lettered and the
   * handler never runs. Start-up fails when no verification key is configured at all.
   */
  requireVerified?: boolean;
}
export type ConsumerClass = new (...args: never[]) => { handle(payload: never, ctx: ConsumeContext): unknown };

export interface EventsDefinition { events: readonly EventDecl[]; consumers?: readonly ConsumerClass[] }

export interface ConsumeContext {
  envelope: import("./envelope.ts").DispatchEnvelope; attempt: number; group: string;
  /**
   * The publishing service, present ONLY when the message carried a valid signature of that service's key (dispatch trust). Use this,
   * never `envelope.source`, for authorization decisions: `envelope.source` is whatever the producer wrote.
   */
  verifiedSource?: string;
}

/** Marks a class as the consumer of one event type. It is only active when the class is listed in the module's EVENTS.pso.ts. */
export function DispatchConsumer(event: string, options: { group?: string; concurrency?: number; requireVerified?: boolean } = {}): (target: ConsumerClass) => void {
  if (!isEventName(event)) throw new DispatchError("PSO_DISPATCH_EVENT_NAME", `invalid event name "${event}" (use a dotted lower-case name such as users.created)`);
  return (target) => Reflect.defineMetadata(CONSUMER_META, { event, ...options } satisfies ConsumerMeta, target);
}

export const EVENTS_BRAND = Symbol.for("pso.dispatch.events");

export function definitionProblems(def: EventsDefinition): string[] {
  const p: string[] = [];
  if (!def || !Array.isArray(def.events)) return ["defineEvents() expects { events: [...] }"];
  const seen = new Set<string>();
  for (const e of def.events) {
    const at = `event "${e?.name}"`;
    if (typeof e?.name !== "string" || !isEventName(e.name)) p.push(`${at}: invalid name (dotted lower-case, e.g. users.created)`);
    if (!Number.isInteger(e?.version) || e.version < 1) p.push(`${at}: version must be an integer >= 1`);
    if (typeof e?.channel !== "string" || !isChannelName(e.channel)) p.push(`${at}: invalid channel`);
    const key = `${e?.name}@${e?.version}`;
    if (seen.has(key)) p.push(`${at}: declared twice with version ${e?.version}`);
    seen.add(key);
    if (e?.compatibility !== undefined && !["backward", "forward", "full", "none"].includes(e.compatibility)) p.push(`${at}: unknown compatibility policy`);
    if (e?.accepts !== undefined && (!Array.isArray(e.accepts) || e.accepts.some((v: number) => !Number.isInteger(v) || v < 1 || v >= e.version))) p.push(`${at}: accepts must list older versions`);
    if (e?.schema !== undefined && typeof e.schema !== "string") p.push(...schemaProblems(e.schema).map((x) => `${at}: ${x}`));
  }
  const names = new Map<string, string>();
  for (const e of def.events) { const c = names.get(e.name); if (c && c !== e.channel) p.push(`event "${e.name}" is declared on two channels ("${c}" and "${e.channel}")`); names.set(e.name, e.channel); }
  for (const c of def.consumers ?? []) {
    const m = Reflect.getOwnMetadata(CONSUMER_META, c) as ConsumerMeta | undefined;
    if (!m) p.push(`consumer ${c?.name} is listed but is not decorated with @DispatchConsumer`);
    else if (!def.events.some((e) => e.name === m.event)) p.push(`consumer ${c.name} handles "${m.event}", which this module does not declare`);
  }
  return p;
}

/** The authoritative event declaration of a dispatch module (EVENTS.pso.ts). Declaring an event is what permits publishing it. */
export function defineEvents(def: EventsDefinition): EventsDefinition {
  const p = definitionProblems(def);
  if (p.length) throw new DispatchError("PSO_DISPATCH_EVENTS_INVALID", `invalid EVENTS.pso declaration:\n - ${p.join("\n - ")}`);
  return Object.freeze({ ...def, [EVENTS_BRAND]: true }) as EventsDefinition;
}

export interface RegisteredEvent extends EventDecl { schemaObject?: Schema }

export class EventRegistry {
  private readonly byName = new Map<string, RegisteredEvent>();
  add(decl: EventDecl, schemaObject?: Schema): void {
    const prev = this.byName.get(decl.name);
    if (prev && prev.version >= decl.version) { if (prev.version === decl.version) throw new DispatchError("PSO_DISPATCH_EVENT_DUPLICATE", `event "${decl.name}" is declared more than once`); return; }
    const resolved = schemaObject ?? (typeof decl.schema === "object" ? decl.schema : undefined);
    this.byName.set(decl.name, { ...decl, ...(resolved ? { schemaObject: resolved } : {}) });
  }
  get(name: string): RegisteredEvent | undefined { return this.byName.get(name); }
  all(): RegisteredEvent[] { return [...this.byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)); }
  channels(): string[] { return [...new Set(this.all().map((e) => e.channel))].sort(); }
}
