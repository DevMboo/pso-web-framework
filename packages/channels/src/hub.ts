import { randomUUID } from "node:crypto";
import { ValidationError, log, validateDto } from "@pso/http";
import type { Principal } from "@pso/security";
import { K } from "@pso/http";
import { handlerPublic, handlerRoles, handlerScopes, readParams, type ChannelClient, type ChannelContext, type HandlerKind, type HandlerMeta } from "./decorators.ts";
import { ChannelRegistry, type RegisteredChannel } from "./registry.ts";
import { ChannelError, MESSAGES, PROTOCOL_VERSION, envelopeProblem, type ChannelEnvelope, type ErrorCode } from "./protocol.ts";
import { PARAM_VALUE, normalizeName } from "./pattern.ts";
import type { ChannelBus } from "./bus.ts";
import type { ChannelsConfig } from "./config.ts";

/** The transport a connection runs on. The hub never touches a socket: tests and other transports implement this. */
export interface Connection {
  readonly id: string;
  readonly correlationId: string;
  principal: Principal | null;
  /** queue one serialized frame; returns false when the connection cannot keep up (it is then closed as a slow consumer) */
  send(frame: string): boolean;
  close(code: number, reason: string): void;
}

interface ConnState {
  conn: Connection;
  subs: Set<string>;
  client: ChannelClient;
  tokens: number;
  last: number;
  /** the identity this connection authenticated as first: a renewal for another subject is refused */
  subject: string | undefined;
  closed: boolean;
  /** authenticated-only @OnConnect handlers that already ran for this connection */
  connectRan: Set<string>;
}

export interface HubDeps {
  registry: ChannelRegistry;
  config: ChannelsConfig;
  bus: ChannelBus;
  /** builds channel instances through the application's dependency container */
  resolve: (cls: new (...a: never[]) => unknown) => Record<string, (...a: unknown[]) => unknown>;
  /** the framework's authorization (scopes, role sets) */
  authorize: (principal: Principal, need: { scopes: readonly string[]; roleSets: readonly (readonly string[])[] }) => boolean;
  /** resolves a DTO validator class (business validators); optional */
  resolveValidator?: Parameters<typeof validateDto>[2];
  service: string;
  now?: () => number;
}

export interface HubMetrics { connections: number; subscriptions: number; published: number; publishFailed: number; delivered: number; deniedSubscriptions: number; rateLimited: number; slowConsumers: number; invalidEvents: number; duplicates: number; /** events received from another instance and accepted after validation */ busReceived: number; /** events received from the bus and refused (malformed, unregistered channel, source not allowed, contract violation) */ busRejected: number }

const frame = (o: Record<string, unknown>): string => JSON.stringify({ v: PROTOCOL_VERSION, ...o });
export const errorFrame = (code: ErrorCode, id?: string, errors?: Array<{ field?: string; message: string }>): string => frame({ t: "error", ...(id ? { id } : {}), code, message: MESSAGES[code], ...(errors?.length ? { errors } : {}) });

export class ChannelHub {
  readonly #d: HubDeps;
  readonly #conns = new Map<string, ConnState>();
  readonly #subs = new Map<string, Set<ConnState>>();
  readonly #presence = new Map<string, Map<string, Set<string>>>();
  readonly #internal = new Map<string, Set<(env: ChannelEnvelope) => void>>();
  readonly #seen: string[] = [];
  readonly #seenSet = new Set<string>();
  readonly #m: HubMetrics = { connections: 0, subscriptions: 0, published: 0, publishFailed: 0, delivered: 0, deniedSubscriptions: 0, rateLimited: 0, slowConsumers: 0, invalidEvents: 0, duplicates: 0, busReceived: 0, busRejected: 0 };
  #closing = false;
  /** events arriving from other instances are validated one after another, so their order is the order they were received in */
  #ingress: Promise<void> = Promise.resolve();

  constructor(deps: HubDeps) {
    this.#d = deps;
    // "local": this process validated the event before handing it to the bus. "remote": it crossed a process boundary and is untrusted.
    deps.bus.onMessage((env, origin) => {
      if (origin !== "remote") return this.#fanout(env);
      this.#ingress = this.#ingress.then(() => this.#receive(env)).catch(() => undefined);
    });
  }

  /**
   * Distributed ingress: an event received from the bus gets the SAME checks as a local publication before any fan-out (envelope
   * structure and size, registered channel, source allowed for that channel, declared event type and payload contract). A refused event
   * is counted, logged without its content and dropped. An accepted event is only delivered to this instance's connections: it is never
   * published back to the bus, so instances cannot echo each other.
   * These checks prove the event is WELL-FORMED and PERMITTED, not who sent it: `source` is a field of the message. Authenticity of the
   * sender comes from the transport (the signed bus, see RedisBus; Redis ACLs and network policy).
   */
  async #receive(raw: unknown): Promise<void> {
    const refuse = (reason: string, fields: Record<string, unknown> = {}): void => {
      this.#m.busRejected++; this.#m.invalidEvents++;
      if (this.#m.busRejected <= 10 || this.#m.busRejected % 100 === 0) log("warn", "channel event from the bus refused", { reason, refused: this.#m.busRejected, ...fields }); // bounded logging under a flood
    };
    const problem = envelopeProblem(raw, this.#d.config.maxMessageBytes);
    if (problem) return refuse(problem);
    const env = raw as ChannelEnvelope;
    const r = env.channel === normalizeName(env.channel) ? this.#d.registry.resolve(env.channel) : undefined;
    if (!r) return refuse("channel is not registered");
    for (const v of Object.values(r.params)) if (!PARAM_VALUE.test(v)) return refuse("invalid channel parameter");
    const pattern = r.channel.pattern.source;
    if (env.source !== this.#d.service && !r.channel.publishers.has(env.source) && !(this.#d.config.trustedSources ?? []).includes(env.source)) return refuse("source may not publish to this channel", { source: env.source, channel: pattern });
    if (r.channel.events) {
      const dto = r.channel.events.get(env.type);
      if (!dto) return refuse("event type is not part of the channel contract", { channel: pattern, type: env.type });
      try { await validateDto(dto as new () => unknown, env.payload, this.#d.resolveValidator); }
      catch (e) { return refuse(e instanceof ValidationError ? "payload does not match its contract" : "payload could not be validated", { channel: pattern, type: env.type }); }
    }
    this.#m.busReceived++;
    this.#fanout(env);
  }

  metrics(): HubMetrics { return { ...this.#m, connections: this.#conns.size, subscriptions: [...this.#subs.values()].reduce((n, s) => n + s.size, 0) }; }
  get connectionCount(): number { return this.#conns.size; }
  subscribers(channel: string): number { return this.#subs.get(normalizeName(channel))?.size ?? 0; }
  presenceOf(channel: string): string[] { return [...(this.#presence.get(normalizeName(channel))?.keys() ?? [])]; }
  #now(): number { return (this.#d.now ?? Date.now)(); }

  // ------------------------------------------------------------------ connection lifecycle
  /** Registers a connection and runs the @OnConnect handlers. False: the connection must be closed (forbidden). */
  async connect(conn: Connection): Promise<boolean> {
    if (this.#closing || this.#conns.size >= this.#d.config.maxConnections) return false;
    const st: ConnState = { conn, subs: new Set(), client: undefined as unknown as ChannelClient, tokens: this.#d.config.burst, last: this.#now(), subject: conn.principal?.subject, closed: false, connectRan: new Set() };
    st.client = this.#clientOf(st);
    this.#conns.set(conn.id, st);
    if (!(await this.#runConnect(st))) { await this.disconnect(conn); return false; }
    return true;
  }

  /**
   * Runs the @OnConnect handlers that can run now: all of them for an authenticated connection, only the @Public ones for an anonymous one.
   * The rest run when the connection authenticates (so an authenticated-only hook never turns away a caller who only wants a public channel).
   */
  async #runConnect(st: ConnState): Promise<boolean> {
    for (const ch of this.#d.registry.channels) {
      for (const h of ch.handlers.filter((x) => x.kind === "connect")) {
        const needsAuth = !handlerPublic(ch.cls.prototype as object, h.method);
        if (needsAuth && !st.conn.principal) continue;
        if (needsAuth && st.connectRan.has(`${ch.cls.name}.${h.method}`)) continue;
        try {
          const ok = await this.#invoke(ch, h, st, "", {}, undefined);
          if (needsAuth) st.connectRan.add(`${ch.cls.name}.${h.method}`);
          if (ok !== true && ok !== undefined) return false;
        } catch (e) {
          log("warn", "channel connect handler refused or failed", { connectionId: st.conn.id, correlationId: st.conn.correlationId, channelClass: ch.cls.name, code: e instanceof ChannelError ? e.code : "handler_error" });
          return false;
        }
      }
    }
    return true;
  }

  async disconnect(conn: Connection): Promise<void> {
    const st = this.#conns.get(conn.id);
    if (!st || st.closed) return;
    st.closed = true;
    for (const name of [...st.subs]) await this.#drop(st, name, true);
    this.#conns.delete(conn.id);
    for (const ch of this.#d.registry.channels) for (const h of ch.handlers.filter((x) => x.kind === "disconnect")) {
      try { await this.#invoke(ch, h, st, "", {}, undefined, true); } catch (e) { log("warn", "channel disconnect handler failed", { connectionId: conn.id, channelClass: ch.cls.name, error: (e as Error).name }); }
    }
  }

  /** Sets (first time) or renews the identity of a connection. Renewal for a different subject is refused; subscriptions are re-authorized. */
  async authenticated(conn: Connection, principal: Principal): Promise<void> {
    const st = this.#state(conn);
    if (st.subject !== undefined && st.subject !== principal.subject) throw new ChannelError("PSO_CHANNEL_FORBIDDEN");
    st.subject = principal.subject;
    conn.principal = principal;
    if (!(await this.#runConnect(st))) throw new ChannelError("PSO_CHANNEL_FORBIDDEN");
    if (st.subs.size > 0) await this.reauthorize(conn);
  }

  /** Drops the identity (token expired): authorized subscriptions end, public ones stay. */
  async expire(conn: Connection): Promise<void> {
    const st = this.#state(conn);
    conn.principal = null;
    for (const name of [...st.subs]) { const r = this.#d.registry.resolve(name); if (!r || r.channel.visibility !== "public") await this.#drop(st, name, false, true); }
  }

  /** Re-runs the authorization of every subscription of the connection; the ones no longer allowed are removed (and announced). */
  async reauthorize(conn: Connection): Promise<void> {
    const st = this.#state(conn);
    for (const name of [...st.subs]) {
      try { await this.#authorizeSubscribe(st, name); } catch { await this.#drop(st, name, false, true); }
    }
  }

  /** Revokes subscriptions after a permission change elsewhere (for example a role removed). Returns how many were removed. */
  async revoke(filter: { subject?: string; channel?: string }): Promise<number> {
    let n = 0;
    for (const st of [...this.#conns.values()]) {
      if (filter.subject !== undefined && st.conn.principal?.subject !== filter.subject) continue;
      for (const name of [...st.subs]) if (filter.channel === undefined || normalizeName(filter.channel) === name) { await this.#drop(st, name, false, true); n++; }
    }
    return n;
  }

  // ------------------------------------------------------------------ client commands (untrusted)
  /** Counts one inbound message against the connection's budget. Throws RATE_LIMITED when empty. */
  admit(conn: Connection): void {
    const st = this.#state(conn);
    const now = this.#now();
    const c = this.#d.config;
    st.tokens = Math.min(c.burst, st.tokens + ((now - st.last) / 1000) * c.ratePerSecond);
    st.last = now;
    if (st.tokens < 1) { this.#m.rateLimited++; throw new ChannelError("PSO_CHANNEL_RATE_LIMITED"); }
    st.tokens -= 1;
  }

  async subscribe(conn: Connection, channel: string): Promise<void> {
    const st = this.#state(conn);
    const name = this.#checkedName(channel);
    if (st.subs.has(name)) return;
    if (st.subs.size >= this.#d.config.maxSubscriptionsPerConnection) throw new ChannelError("PSO_CHANNEL_SUBSCRIPTION_LIMIT");
    try { await this.#authorizeSubscribe(st, name); }
    catch (e) { this.#m.deniedSubscriptions++; log("info", "channel subscription denied", { connectionId: conn.id, correlationId: conn.correlationId, channel: name, code: e instanceof ChannelError ? e.code : "error" }); throw e; }
    const reg = this.#d.registry.resolve(name)!.channel;
    const set = this.#subs.get(name) ?? new Set<ConnState>();
    if (set.size >= reg.maxSubscribers) throw new ChannelError("PSO_CHANNEL_SUBSCRIPTION_LIMIT");
    set.add(st); this.#subs.set(name, set); st.subs.add(name);
    if (reg.visibility === "presence" && conn.principal) this.#presenceJoin(name, st);
    log("debug", "channel subscribed", { connectionId: conn.id, correlationId: conn.correlationId, channel: name });
  }

  async unsubscribe(conn: Connection, channel: string): Promise<void> {
    const st = this.#state(conn);
    const name = normalizeName(channel);
    if (!st.subs.has(name)) return;
    const r = this.#d.registry.resolve(name);
    if (r) for (const h of r.channel.handlers.filter((x) => x.kind === "unsubscribe")) { try { await this.#invoke(r.channel, h, st, name, r.params, undefined); } catch { /* cleanup hooks never block leaving */ } }
    await this.#drop(st, name, false);
  }

  /** A client command: authenticated, authorized, validated, then handed to the @OnEvent method. */
  async handleEvent(conn: Connection, channel: string, event: string, payload: unknown): Promise<unknown> {
    const st = this.#state(conn);
    const name = normalizeName(channel);
    const r = this.#d.registry.resolve(name);
    if (!r || r.channel.visibility === "internal") throw new ChannelError("PSO_CHANNEL_INVALID_CHANNEL");
    if (!st.subs.has(name)) throw new ChannelError("PSO_CHANNEL_FORBIDDEN"); // commands are accepted only on channels the client was authorized to join
    const h = r.channel.handlers.find((x) => x.kind === "event" && x.event === event);
    if (!h) throw new ChannelError("PSO_CHANNEL_UNKNOWN_EVENT");
    return this.#invoke(r.channel, h, st, name, r.params, payload);
  }

  // ------------------------------------------------------------------ server events
  /**
   * Accepts a server event from a service (Dispatch bridge): structure, publisher allow-list and event contract are checked, then it is
   * fanned out through the bus. `source` is the service the transport authenticated, never a field the browser can influence.
   */
  async ingest(raw: unknown, trustedSource?: string): Promise<void> {
    const problem = envelopeProblem(raw, this.#d.config.maxMessageBytes);
    if (problem) { this.#m.invalidEvents++; throw new Error(`invalid channel event: ${problem}`); }
    const env = { ...(raw as ChannelEnvelope), ...(trustedSource ? { source: trustedSource } : {}) };
    const r = this.#d.registry.resolve(env.channel);
    if (!r) { this.#m.invalidEvents++; throw new Error("event for a channel that is not registered"); }
    if (!r.channel.publishers.has(env.source)) { this.#m.invalidEvents++; log("warn", "channel event refused: the source may not publish to this channel", { source: env.source, channel: r.channel.pattern.source }); throw new Error("source is not allowed to publish to this channel"); }
    await this.#publishValidated(r.channel, env);
  }

  /** Publication by code running inside this orchestrator (trusted by construction): validates the contract, then fans out. */
  async publish(channel: string, type: string, payload: unknown, opts: { correlationId?: string } = {}): Promise<ChannelEnvelope> {
    const name = normalizeName(channel);
    const r = this.#d.registry.resolve(name);
    if (!r) throw new ChannelError("PSO_CHANNEL_INVALID_CHANNEL");
    const env: ChannelEnvelope = { v: 1, id: randomUUID(), type, channel: name, ts: new Date().toISOString(), ...(opts.correlationId ? { correlationId: opts.correlationId } : {}), source: this.#d.service, payload };
    const problem = envelopeProblem(env, this.#d.config.maxMessageBytes);
    if (problem) throw new Error(`invalid channel event: ${problem}`);
    await this.#publishValidated(r.channel, env);
    return env;
  }

  /** In-process listener for an `internal` channel (service-to-service use inside the orchestrator). Returns the unsubscribe function. */
  onInternal(channel: string, cb: (env: ChannelEnvelope) => void): () => void {
    const name = normalizeName(channel);
    const set = this.#internal.get(name) ?? new Set();
    set.add(cb); this.#internal.set(name, set);
    return () => { set.delete(cb); };
  }

  async #publishValidated(ch: RegisteredChannel, env: ChannelEnvelope): Promise<void> {
    let out = env;
    if (ch.events) {
      const dto = ch.events.get(env.type);
      if (!dto) { this.#m.invalidEvents++; throw new Error(`event type "${env.type}" is not part of the channel contract`); }
      try { out = { ...env, payload: await validateDto(dto as new () => unknown, env.payload, this.#d.resolveValidator) }; }
      catch (e) { this.#m.invalidEvents++; if (e instanceof ValidationError) throw new Error(`event payload does not match its contract (${e.errors.map((x) => x.field).join(", ")})`); throw e; }
    }
    try { await this.#d.bus.publish(out); this.#m.published++; }
    catch (e) { this.#m.publishFailed++; log("error", "channel event could not be published to the bus", { channel: env.channel, type: env.type, error: (e as Error).message.split("\n")[0] }); throw new ChannelError("PSO_CHANNEL_UNAVAILABLE"); }
  }

  #fanout(env: ChannelEnvelope): void {
    if (this.#seenSet.has(env.id)) { this.#m.duplicates++; return; }
    this.#seenSet.add(env.id); this.#seen.push(env.id);
    if (this.#seen.length > 4096) this.#seenSet.delete(this.#seen.shift()!);
    for (const cb of this.#internal.get(env.channel) ?? []) { try { cb(env); } catch { /* a listener never breaks delivery */ } }
    const subs = this.#subs.get(env.channel);
    if (!subs || subs.size === 0) return;
    const text = frame({ t: "event", eventId: env.id, type: env.type, channel: env.channel, ts: env.ts, ...(env.correlationId ? { correlationId: env.correlationId } : {}), payload: env.payload });
    for (const st of [...subs]) this.#deliver(st, text);
  }

  #deliver(st: ConnState, text: string): void {
    if (st.conn.send(text)) { this.#m.delivered++; return; }
    this.#m.slowConsumers++;
    log("warn", "channel connection closed as a slow consumer", { connectionId: st.conn.id, correlationId: st.conn.correlationId });
    st.conn.close(4429, "slow consumer");
  }

  // ------------------------------------------------------------------ internals
  #state(conn: Connection): ConnState {
    const st = this.#conns.get(conn.id);
    if (!st || st.closed) throw new ChannelError("PSO_CHANNEL_UNAVAILABLE");
    return st;
  }

  #checkedName(channel: unknown): string {
    if (typeof channel !== "string" || channel.length === 0 || channel.length > 200) throw new ChannelError("PSO_CHANNEL_INVALID_CHANNEL");
    const name = normalizeName(channel);
    const r = this.#d.registry.resolve(name);
    if (!r || r.channel.visibility === "internal") throw new ChannelError("PSO_CHANNEL_INVALID_CHANNEL");
    for (const v of Object.values(r.params)) if (!PARAM_VALUE.test(v)) throw new ChannelError("PSO_CHANNEL_INVALID_CHANNEL");
    return name;
  }

  async #authorizeSubscribe(st: ConnState, name: string): Promise<void> {
    const r = this.#d.registry.resolve(name);
    if (!r || r.channel.visibility === "internal") throw new ChannelError("PSO_CHANNEL_INVALID_CHANNEL");
    const ch = r.channel;
    if (st.conn.principal && st.conn.principal.expiresAt.getTime() <= this.#now()) throw new ChannelError("PSO_CHANNEL_TOKEN_EXPIRED");
    if (ch.visibility !== "public" && !st.conn.principal) throw new ChannelError("PSO_CHANNEL_UNAUTHENTICATED");
    const classScopes = (Reflect.getOwnMetadata(K.scopes, ch.cls) as string[] | undefined) ?? [];
    if (classScopes.length && (!st.conn.principal || !this.#d.authorize(st.conn.principal, { scopes: classScopes, roleSets: [] }))) throw new ChannelError(st.conn.principal ? "PSO_CHANNEL_FORBIDDEN" : "PSO_CHANNEL_UNAUTHENTICATED");
    for (const h of ch.handlers.filter((x) => x.kind === "subscribe")) {
      let ok: unknown;
      try { ok = await this.#invoke(ch, h, st, name, r.params, undefined); }
      catch (e) { if (e instanceof ChannelError) throw e; log("warn", "channel authorizer failed: denied", { channelClass: ch.cls.name, error: (e as Error).name }); throw new ChannelError("PSO_CHANNEL_FORBIDDEN"); }
      if (ok !== true) throw new ChannelError("PSO_CHANNEL_FORBIDDEN"); // anything but an explicit true denies; the same answer for "forbidden" and "does not exist"
    }
  }

  async #invoke(ch: RegisteredChannel, h: HandlerMeta, st: ConnState, channel: string, params: Record<string, string>, payload: unknown, lifecycle = false): Promise<unknown> {
    const proto = ch.cls.prototype as object;
    const principal = st.conn.principal;
    const isPublic = handlerPublic(proto, h.method);
    if (!lifecycle) {
      if (!isPublic && ch.visibility !== "public") { if (!principal) throw new ChannelError("PSO_CHANNEL_UNAUTHENTICATED"); }
      else if (!isPublic && ch.visibility === "public" && h.kind === "event" && !principal) throw new ChannelError("PSO_CHANNEL_UNAUTHENTICATED");
      const scopes = handlerScopes(proto, h.method), roles = handlerRoles(proto, h.method);
      if (scopes.length || roles.length) {
        if (!principal) throw new ChannelError("PSO_CHANNEL_UNAUTHENTICATED");
        if (!this.#d.authorize(principal, { scopes, roleSets: roles.length ? [roles] : [] })) throw new ChannelError("PSO_CHANNEL_FORBIDDEN");
      }
    }
    const ctx: ChannelContext = Object.freeze({ user: principal, connectionId: st.conn.id, correlationId: st.conn.correlationId, channel, params: Object.freeze({ ...params }) });
    const args: unknown[] = [];
    for (const p of readParams(proto, h.method)) {
      if (p.kind === "context") args[p.index] = ctx;
      else if (p.kind === "client") args[p.index] = st.client;
      else if (p.kind === "param") args[p.index] = params[p.name!];
      else if (p.kind === "payload") {
        try { args[p.index] = await validateDto(p.dto as new () => unknown, payload, this.#d.resolveValidator); }
        catch (e) { if (e instanceof ValidationError) throw new ChannelError("PSO_CHANNEL_INVALID_PAYLOAD", e.errors.map((x) => ({ ...(x.field ? { field: x.field } : {}), message: x.message }))); throw e; }
      }
    }
    const inst = this.#d.resolve(ch.cls);
    return (inst[h.method] as (...a: unknown[]) => unknown).apply(inst, args);
  }

  #clientOf(st: ConnState): ChannelClient {
    const hub = this;
    return {
      get id() { return st.conn.id; },
      get user() { return st.conn.principal; },
      join: (channel) => hub.subscribe(st.conn, channel),
      leave: (channel) => hub.unsubscribe(st.conn, channel),
      send: (type, payload) => { st.conn.send(frame({ t: "event", eventId: randomUUID(), type, channel: "", ts: new Date().toISOString(), source: "local", payload })); },
      channels: () => [...st.subs],
    };
  }

  async #drop(st: ConnState, name: string, silent: boolean, notify = false): Promise<void> {
    if (!st.subs.delete(name)) return;
    const set = this.#subs.get(name);
    set?.delete(st);
    if (set && set.size === 0) this.#subs.delete(name);
    this.#presenceLeave(name, st);
    if (notify && !silent) st.conn.send(frame({ t: "unsubscribed", channel: name, reason: "authorization" }));
  }

  // ---- presence: subject ids only (opaque identifiers), shown only to authorized subscribers of the channel
  #presenceJoin(name: string, st: ConnState): void {
    const subject = st.conn.principal!.subject;
    const m = this.#presence.get(name) ?? new Map<string, Set<string>>();
    const first = !m.has(subject);
    const conns = m.get(subject) ?? new Set<string>(); conns.add(st.conn.id); m.set(subject, conns); this.#presence.set(name, m);
    st.conn.send(frame({ t: "presence", channel: name, event: "sync", members: [...m.keys()] }));
    if (first) this.#broadcastPresence(name, { event: "join", member: subject }, st);
  }
  #presenceLeave(name: string, st: ConnState): void {
    const m = this.#presence.get(name);
    const subject = st.subject;
    if (!m || subject === undefined) return;
    const conns = m.get(subject);
    if (!conns?.delete(st.conn.id)) return;
    if (conns.size === 0) { m.delete(subject); this.#broadcastPresence(name, { event: "leave", member: subject }, st); }
    if (m.size === 0) this.#presence.delete(name);
  }
  #broadcastPresence(name: string, body: Record<string, unknown>, except: ConnState): void {
    const text = frame({ t: "presence", channel: name, ...body });
    for (const o of this.#subs.get(name) ?? []) if (o !== except) this.#deliver(o, text);
  }

  /** Graceful shutdown: stop accepting, tell every client, release everything. */
  async close(): Promise<void> {
    this.#closing = true;
    for (const st of [...this.#conns.values()]) st.conn.close(1001, "going away");
    await this.#d.bus.close();
  }
  /** Availability of the cross-instance bus (always up for the in-process bus). */
  async busHealth(): Promise<{ status: "up" | "down"; detail: string }> { return (await this.#d.bus.health?.()) ?? { status: "up", detail: "in-process bus" }; }
  get closing(): boolean { return this.#closing; }
}

export type { HandlerKind };
