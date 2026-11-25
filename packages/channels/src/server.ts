import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { Injectable, buildProblem, log } from "@pso/http";
import type { Principal } from "@pso/security";
import { LocalBus, RedisBus, type ChannelBus } from "./bus.ts";
import type { ChannelsConfig } from "./config.ts";
import { ChannelHub, errorFrame, type Connection } from "./hub.ts";
import { CLOSE, ChannelError, PROTOCOL_VERSION, SUBPROTOCOL } from "./protocol.ts";
import type { ChannelRegistry } from "./registry.ts";

export interface AttachOptions {
  server: Server;
  registry: ChannelRegistry;
  config: ChannelsConfig;
  /** the framework's own authentication: verifies the bearer in an Authorization header value ("Bearer <jwt>"); the same verifier the HTTP routes use */
  authenticate: (authorization: string) => Promise<Principal | undefined>;
  authorize: (principal: Principal, need: { scopes: readonly string[]; roleSets: readonly (readonly string[])[] }) => boolean;
  resolve: (cls: new (...a: never[]) => unknown) => Record<string, (...a: unknown[]) => unknown>;
  resolveValidator?: ConstructorParameters<typeof ChannelHub>[0]["resolveValidator"];
  service: string;
  production?: boolean;
  bus?: ChannelBus;
}
export interface AttachedChannels { hub: ChannelHub; publisher: ChannelPublisher; /** availability of the cross-instance bus; present only when one is configured (readiness reads it) */ health?: () => Promise<{ status: "up" | "down"; detail: string }>; close(): Promise<void> }

/**
 * The publishing API for code running inside the orchestrator (providers, guards, dispatch consumers). Inject it like Upstream.
 * Services in other processes publish through Dispatch (see ChannelDispatchConsumer); they cannot reach this class.
 */
export class ChannelPublisher {
  static hub: ChannelHub | undefined;
  /** Publishes a server event to a registered channel; the payload is validated against the channel's event contract when it declares one. */
  async publish(channel: string, type: string, payload: unknown, opts: { correlationId?: string } = {}): Promise<{ eventId: string }> {
    const hub = ChannelPublisher.hub;
    if (!hub) throw new ChannelError("PSO_CHANNEL_UNAVAILABLE");
    return { eventId: (await hub.publish(channel, type, payload, opts)).id };
  }
  /** Ingress for events that arrive from another service (the Dispatch bridge): applies the publisher allow-list of the channel. */
  async ingest(envelope: unknown, source: string): Promise<void> {
    const hub = ChannelPublisher.hub;
    if (!hub) throw new ChannelError("PSO_CHANNEL_UNAVAILABLE");
    await hub.ingest(envelope, source);
  }
}
Injectable()(ChannelPublisher);
// stable injection token: a provider compiled against another physical copy of this package still receives the connected publisher
Object.defineProperty(ChannelPublisher, Symbol.for("pso.di.token"), { value: { id: "pso.channels.ChannelPublisher", contract: 1 } });

function refuse(socket: Duplex, status: number, legacy: string, correlationId: string): void {
  const body = JSON.stringify(buildProblem(status, legacy, { correlationId }));
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 503 ? "Service Unavailable" : "Bad Request"}\r\ncontent-type: application/problem+json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\ncache-control: no-store\r\n\r\n${body}`);
}

class WsConnection implements Connection {
  readonly id = randomUUID();
  principal: Principal | null = null;
  alive = true;
  lastMessage = Date.now();
  authTimer: NodeJS.Timeout | undefined;
  readonly ws: WebSocket;
  readonly correlationId: string;
  readonly #maxBuffered: number;
  constructor(ws: WebSocket, correlationId: string, maxBuffered: number) { this.ws = ws; this.correlationId = correlationId; this.#maxBuffered = maxBuffered; }
  send(frame: string): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return true;
    if (this.ws.bufferedAmount > this.#maxBuffered) return false; // bounded outbound queue: a client that cannot keep up is closed, memory never grows without limit
    this.ws.send(frame);
    return true;
  }
  close(code: number, reason: string): void {
    try { this.ws.close(code, reason); } catch { this.ws.terminate(); return; }
    // a peer that does not read (a slow consumer) never completes the close handshake: do not wait for it, or its subscriptions would linger
    const t = setTimeout(() => this.ws.terminate(), 1000);
    t.unref();
    this.ws.once("close", () => clearTimeout(t));
  }
}

/**
 * Attaches the Channels WebSocket endpoint to the EXISTING orchestrator HTTP server (no second listener). Authentication, resource
 * authorization and DTO validation are the framework's; this function is only the transport adapter.
 */
export async function attachChannels(o: AttachOptions): Promise<AttachedChannels> {
  const cfg = o.config;
  let bus = o.bus;
  if (!bus) {
    if (cfg.bus === "redis") {
      let dropped = 0, unsigned = 0;
      const r = new RedisBus(cfg.redisUrl!, cfg.redisPrefix, {
        ...(cfg.busSecret ? { secret: cfg.busSecret } : {}), previousSecrets: cfg.busPreviousSecrets, maxBytes: cfg.maxMessageBytes + 4096,
        ...(cfg.busSecret && cfg.busAcceptUnsigned ? { acceptUnsigned: true, onUnsigned: () => { unsigned++; if (unsigned <= 10 || unsigned % 100 === 0) log("warn", "channels bus: an UNSIGNED message was accepted (PSO_CHANNELS_BUS_ACCEPT_UNSIGNED): an instance without the secret is still publishing, or someone else is", { component: "channels", unsigned }); } } : {}),
        onError: (e) => log("error", "channels redis bus error", { error: e.message.split("\n")[0] }),
        onReject: (reason) => { dropped++; if (dropped <= 10 || dropped % 100 === 0) log("warn", "channels bus message dropped before validation", { reason, dropped }); },
      });
      await r.start(); bus = r;
      // structure and contracts are always validated on receive; WHO may publish to the topic is only as strong as this boundary
      if (!cfg.busSecret) log(o.production ? "warn" : "info", `channels redis bus is not authenticated${cfg.busUnauthenticatedAccepted ? " (accepted explicitly with PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED: INSECURE legacy mode)" : ""}: any client able to publish to the Redis topic can make instances deliver (contract-valid) events. Set PSO_CHANNELS_BUS_SECRET to the same value on every instance and restrict the Redis user with ACLs`, { component: "channels" });
      else if (cfg.busAcceptUnsigned) log("warn", "channels redis bus: migration mode, unsigned messages are still accepted (PSO_CHANNELS_BUS_ACCEPT_UNSIGNED). The bus is NOT authenticated until this is removed; remove it once every instance has the secret", { component: "channels" });
    }
    else bus = new LocalBus();
  }
  const hub = new ChannelHub({ registry: o.registry, config: cfg, bus, resolve: o.resolve, authorize: o.authorize, ...(o.resolveValidator ? { resolveValidator: o.resolveValidator } : {}), service: o.service });
  ChannelPublisher.hub = hub;
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxMessageBytes, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });
  const sockets = new Set<WsConnection>();
  log("info", "channels ready", { component: "channels", path: cfg.path, channels: o.registry.channels.length, bus: bus.kind, maxConnections: cfg.maxConnections });

  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers["origin"];
    if (origin === undefined) return true; // not a browser: judged by authentication alone
    if (typeof origin !== "string") return false;
    if (cfg.allowedOrigins.includes(origin)) return true;
    if (!o.production && cfg.allowedOrigins.length === 0) { try { return new URL(origin).host === req.headers["host"]; } catch { return false; } } // development: same origin
    return false;
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const incoming = req.headers["x-correlation-id"];
    const correlationId = typeof incoming === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    let pathname: string;
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { return refuse(socket, 400, "bad_request", correlationId); }
    if (pathname !== cfg.path) return refuse(socket, 404, "not_found", correlationId);
    if (req.method !== "GET") return refuse(socket, 400, "bad_request", correlationId);
    if (hub.closing) return refuse(socket, 503, "upstream_unavailable", correlationId);
    if (!originAllowed(req)) { log("warn", "channels upgrade refused: origin", { correlationId, origin: String(req.headers["origin"]).slice(0, 100) }); return refuse(socket, 403, "forbidden", correlationId); }
    if (sockets.size >= cfg.maxConnections) return refuse(socket, 503, "server_busy", correlationId);
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (offered.length > 0 && !offered.includes(SUBPROTOCOL)) return refuse(socket, 400, "bad_request", correlationId);
    const header = req.headers["authorization"];
    void (async () => {
      let principal: Principal | null = null;
      if (typeof header === "string") {
        const p = await o.authenticate(header).catch(() => undefined);
        if (!p) { log("info", "channels upgrade refused: authentication", { correlationId }); return refuse(socket, 401, "unauthorized", correlationId); }
        principal = p;
      }
      wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, principal, correlationId));
    })().catch(() => { if (!socket.destroyed) refuse(socket, 400, "bad_request", correlationId); });
  };
  o.server.on("upgrade", onUpgrade);

  async function onConnection(ws: WebSocket, principal: Principal | null, correlationId: string): Promise<void> {
    const conn = new WsConnection(ws, correlationId, cfg.maxBufferedBytes);
    conn.principal = principal;
    sockets.add(conn);
    ws.on("pong", () => { conn.alive = true; });
    ws.on("error", () => ws.terminate());
    let queue: Promise<void> = Promise.resolve(); // messages of ONE connection are processed in order
    ws.on("message", (data, isBinary) => { queue = queue.then(() => onMessage(conn, data, isBinary)).catch(() => undefined); });
    ws.on("close", () => { clearTimeout(conn.authTimer); sockets.delete(conn); void hub.disconnect(conn); log("debug", "channels connection closed", { connectionId: conn.id, correlationId }); });
    if (!(await hub.connect(conn))) { conn.close(CLOSE.forbidden, "refused"); return; }
    log("info", "channels connection opened", { connectionId: conn.id, correlationId, authenticated: principal !== null });
    conn.send(JSON.stringify({ v: PROTOCOL_VERSION, t: "ready", connectionId: conn.id, authenticated: principal !== null }));
    if (!principal && !cfg.allowAnonymous) conn.authTimer = setTimeout(() => { if (!conn.principal) { log("info", "channels connection closed: no authentication", { connectionId: conn.id }); conn.close(CLOSE.unauthenticated, "unauthenticated"); } }, cfg.authTimeoutMs);
  }

  async function onMessage(conn: WsConnection, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): Promise<void> {
    conn.lastMessage = Date.now();
    const reply = (text: string): void => { conn.send(text); };
    let msg: Record<string, unknown>;
    if (isBinary) return reply(errorFrame("PSO_CHANNEL_BAD_FRAME"));
    try { const v = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8")) as unknown; if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object"); msg = v as Record<string, unknown>; }
    catch { return reply(errorFrame("PSO_CHANNEL_BAD_FRAME")); }
    const id = typeof msg["id"] === "string" && msg["id"].length <= 64 ? msg["id"] : undefined;
    if (msg["v"] !== PROTOCOL_VERSION) { reply(errorFrame("PSO_CHANNEL_UNSUPPORTED_VERSION", id)); return conn.close(CLOSE.badVersion, "unsupported version"); }
    try {
      // leaving is never refused for rate: an unsubscribe only releases what the connection holds (and is bounded by the subscription limit),
      // while a refused one would leave a server-side subscription behind for the whole life of the connection
      if (msg["t"] !== "unsubscribe") hub.admit(conn);
      if (conn.principal && conn.principal.expiresAt.getTime() <= Date.now() && msg["t"] !== "auth" && msg["t"] !== "ping") {
        await hub.expire(conn);
        throw new ChannelError("PSO_CHANNEL_TOKEN_EXPIRED");
      }
      switch (msg["t"]) {
        case "ping": return reply(JSON.stringify({ v: 1, t: "pong" }));
        case "auth": {
          const token = msg["token"];
          if (typeof token !== "string" || token.length === 0 || token.length > 8192) throw new ChannelError("PSO_CHANNEL_UNAUTHENTICATED");
          const p = await o.authenticate(`Bearer ${token}`).catch(() => undefined);
          if (!p) { if (!conn.principal) { reply(errorFrame("PSO_CHANNEL_UNAUTHENTICATED", id)); return conn.close(CLOSE.unauthenticated, "unauthenticated"); } throw new ChannelError("PSO_CHANNEL_UNAUTHENTICATED"); }
          const first = conn.principal === null;
          try { await hub.authenticated(conn, p); } catch (e) { reply(errorFrame("PSO_CHANNEL_FORBIDDEN", id)); return conn.close(CLOSE.forbidden, "identity changed"); }
          clearTimeout(conn.authTimer);
          log("info", first ? "channels connection authenticated" : "channels credentials renewed", { connectionId: conn.id, correlationId: conn.correlationId });
          return reply(JSON.stringify({ v: 1, t: "ack", ...(id ? { id } : {}), authenticated: true }));
        }
        case "subscribe": await hub.subscribe(conn, String(msg["channel"])); return reply(JSON.stringify({ v: 1, t: "ack", ...(id ? { id } : {}), channel: String(msg["channel"]).replace(/^\//, "") }));
        case "unsubscribe": await hub.unsubscribe(conn, String(msg["channel"])); return reply(JSON.stringify({ v: 1, t: "ack", ...(id ? { id } : {}) }));
        case "event": {
          if (typeof msg["event"] !== "string" || typeof msg["channel"] !== "string") throw new ChannelError("PSO_CHANNEL_BAD_FRAME");
          const result = await hub.handleEvent(conn, msg["channel"], msg["event"], msg["payload"]);
          return reply(JSON.stringify({ v: 1, t: "ack", ...(id ? { id } : {}), ...(result !== undefined && JSON.stringify(result)?.length < 4096 ? { result } : {}) }));
        }
        default: throw new ChannelError("PSO_CHANNEL_BAD_FRAME");
      }
    } catch (e) {
      if (e instanceof ChannelError) return reply(errorFrame(e.code, id, e.errors));
      log("error", "channels handler failed", { connectionId: conn.id, correlationId: conn.correlationId, error: (e as Error).name }); // never the message or stack to the client
      reply(errorFrame("PSO_CHANNEL_INTERNAL", id));
    }
  }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const c of sockets) {
      if (!c.alive) { c.ws.terminate(); continue; }
      if (now - c.lastMessage > cfg.idleTimeoutMs) { c.close(CLOSE.idle, "idle"); continue; }
      if (c.principal && c.principal.expiresAt.getTime() <= now) { void hub.expire(c).then(() => c.send(errorFrame("PSO_CHANNEL_TOKEN_EXPIRED"))); if (!cfg.allowAnonymous) c.authTimer ??= setTimeout(() => { if (!c.principal) c.close(CLOSE.unauthenticated, "credentials expired"); }, cfg.authTimeoutMs); }
      c.alive = false;
      try { c.ws.ping(); } catch { c.ws.terminate(); }
    }
  }, cfg.heartbeatMs);
  timer.unref();

  return {
    hub, publisher: new ChannelPublisher(), ...(bus.health ? { health: () => hub.busHealth() } : {}),
    async close() {
      clearInterval(timer);
      o.server.off("upgrade", onUpgrade);
      await hub.close();
      await new Promise<void>((resolve) => { const t = setTimeout(() => { for (const c of sockets) c.ws.terminate(); resolve(); }, cfg.shutdownGraceMs); t.unref(); const done = (): void => { clearTimeout(t); resolve(); }; if (sockets.size === 0) done(); else { const iv = setInterval(() => { if (sockets.size === 0) { clearInterval(iv); done(); } }, 25); iv.unref(); } });
      wss.close();
      if (ChannelPublisher.hub === hub) ChannelPublisher.hub = undefined;
    },
  };
}
