import "reflect-metadata";
import { K } from "@pso/http";
import type { Principal } from "@pso/security";
import { parsePattern } from "./pattern.ts";

/**
 * Channel declarations. Decorators only ATTACH metadata: a class does nothing until it is listed in `channels: [...]` of a
 * MODULE.pso.ts (`defineModule`). Authentication and permissions reuse the decorators the framework already has:
 *   - a channel handler requires an authenticated caller unless it is marked `@Public()`;
 *   - `@Scopes("recruitment:read")` on a handler adds required scopes (the same decorator and semantics as on HTTP actions).
 */
export type Visibility = "public" | "private" | "presence" | "internal";
type Cls = abstract new (...args: never[]) => unknown;

export interface ChannelOptions {
  /** default "private". "public" allows unauthenticated subscription, "presence" adds participant tracking, "internal" is never subscribable by clients. */
  visibility?: Visibility;
  /**
   * Services allowed to PUBLISH server events to this channel through Dispatch or the bus (their `source` name). Empty or absent:
   * only code running inside this orchestrator (ChannelPublisher) may publish. Clients can never publish server events.
   */
  publishers?: readonly string[];
  /** Server event contracts: event type -> @Dto class the payload is validated against before delivery. When given, other event types are refused. */
  events?: Readonly<Record<string, Cls>>;
  /** Most subscribers one concrete channel accepts on this instance (default: unlimited, bounded by max connections). */
  maxSubscribers?: number;
}
export interface ChannelMeta { pattern: string; options: Required<Pick<ChannelOptions, "visibility">> & ChannelOptions }
export type HandlerKind = "connect" | "subscribe" | "unsubscribe" | "event" | "disconnect";
export interface HandlerMeta { kind: HandlerKind; event?: string; method: string }
export type ParamKind = "payload" | "client" | "context" | "param";
export interface ParamMeta { index: number; kind: ParamKind; name?: string; dto?: Cls }

export const CH = { channel: "pso:channel", handlers: "pso:channel:handlers", params: "pso:channel:params" } as const;

/** Declares a channel class. The pattern may contain `{param}` segments: `employee.{employeeId}`. */
export function Channel(pattern: string, options: ChannelOptions = {}): (target: Cls) => void {
  parsePattern(pattern); // fails at load time with a precise message
  const visibility = options.visibility ?? "private";
  if (!["public", "private", "presence", "internal"].includes(visibility)) throw new Error(`@Channel("${pattern}"): unknown visibility "${String(visibility)}"`);
  return (target) => Reflect.defineMetadata(CH.channel, { pattern, options: { ...options, visibility } } satisfies ChannelMeta, target);
}

const handler = (kind: HandlerKind, event?: string) => (target: object, key: string | symbol): void => {
  const ctor = (target as { constructor: Function }).constructor;
  const list = (Reflect.getOwnMetadata(CH.handlers, ctor) as HandlerMeta[] | undefined) ?? [];
  Reflect.defineMetadata(CH.handlers, [...list, { kind, ...(event ? { event } : {}), method: String(key) }], ctor);
};
/** Runs when a connection is established (after authentication); returning false refuses the connection. */
export const OnConnect = () => handler("connect");
/** Authorizes a subscription to THIS channel (resource-level: receives the channel parameters). Return true to allow; anything else denies. */
export const OnSubscribe = () => handler("subscribe");
export const OnUnsubscribe = () => handler("unsubscribe");
/** Handles a client command named `event` sent on this channel by a subscribed client. */
export const OnEvent = (event: string) => {
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/.test(event)) throw new Error(`@OnEvent("${event}"): event names are dotted lower-case, e.g. candidate.subscribe`);
  return handler("event", event);
};
export const OnDisconnect = () => handler("disconnect");

const param = (kind: ParamKind, name?: string, dto?: Cls) => (target: object, key: string | symbol | undefined, index: number): void => {
  if (key === undefined) return;
  const list = (Reflect.getOwnMetadata(CH.params, target, key) as ParamMeta[] | undefined) ?? [];
  Reflect.defineMetadata(CH.params, [...list, { index, kind, ...(name ? { name } : {}), ...(dto ? { dto } : {}) }], target, key);
};
/** The validated payload of a client event, bound to a `@Dto` class (the framework's DTO validation: strict, no coercion, unknown fields rejected). */
export const Payload = (dto: Cls) => param("payload", undefined, dto);
export const Client = () => param("client");
export const Context = () => param("context");
/** A parameter of the channel pattern, e.g. `@ChannelParam("employeeId")`. Already syntax-checked. */
export const ChannelParam = (name: string) => param("param", name);

// ---- values handed to handlers
export interface ChannelContext {
  /** the verified identity, or null on a public channel for an anonymous connection. Never client-supplied. */
  readonly user: Principal | null;
  readonly connectionId: string;
  readonly correlationId: string;
  /** the concrete channel this call concerns (empty for connect/disconnect) */
  readonly channel: string;
  readonly params: Readonly<Record<string, string>>;
}
export interface ChannelClient {
  readonly id: string;
  readonly user: Principal | null;
  /** Subscribes this connection to another channel THROUGH the normal pipeline (authentication, limits, the channel's own authorizer); rejects with ChannelError when denied. */
  join(channel: string): Promise<void>;
  leave(channel: string): Promise<void>;
  /** A private message to this connection only (type `t:"event"` with source "local"); it is not broadcast. */
  send(type: string, payload: unknown): void;
  channels(): string[];
}

export const readChannel = (cls: object): ChannelMeta | undefined => Reflect.getOwnMetadata(CH.channel, cls) as ChannelMeta | undefined;
export const readHandlers = (cls: object): HandlerMeta[] => (Reflect.getOwnMetadata(CH.handlers, cls) as HandlerMeta[] | undefined) ?? [];
export const readParams = (proto: object, method: string): ParamMeta[] => (Reflect.getOwnMetadata(CH.params, proto, method) as ParamMeta[] | undefined) ?? [];
export const handlerScopes = (proto: object, method: string): string[] => (Reflect.getOwnMetadata(K.scopes, proto, method) as string[] | undefined) ?? [];
export const handlerPublic = (proto: object, method: string): boolean => Reflect.getOwnMetadata(K.pub, proto, method) === true;
export const handlerRoles = (proto: object, method: string): string[] => (Reflect.getOwnMetadata(K.roles, proto, method) as string[] | undefined) ?? [];
