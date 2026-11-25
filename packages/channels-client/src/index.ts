/**
 * @pso/channels-client: the PSO Channels SDK for browsers, Electron and Node (uses the platform WebSocket; no dependencies, no React).
 * It OWNS the transport: one connection, authentication, reconnection, heartbeat and subscription state. Framework adapters (React, ...) only
 * bind its lifecycle to their components.
 *
 * - Authentication: `getToken()` is called after the socket opens and again before the token expires (and when the server says it expired);
 *   the token travels in an `auth` frame, never in the URL. A browser cannot set an Authorization header on a WebSocket.
 * - Reconnection: bounded exponential backoff with jitter. After reconnecting, authentication is repeated and every active subscription is
 *   requested again, so the SERVER re-authorizes each one (a subscription that is no longer allowed is reported through `onError`, not retried).
 * - No offline queue: `send()` rejects while disconnected, and a command is never replayed automatically (it may not be idempotent).
 * - Transport security: a ws:// URL is accepted only for a loopback host (development); anything else must be wss:// (or opt out with
 *   `allowInsecure`, which exists for private test networks and is never the default). No token is ever stored by the SDK.
 * - No replay: events published while disconnected are not redelivered; the server does not provide replay in this version.
 */
export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface ChannelEvent<T = unknown> { eventId: string; type: string; channel: string; ts: string; correlationId?: string; payload: T }
export interface ChannelsError { code: string; message: string; errors?: Array<{ field?: string; message: string }> }
export interface SubscriptionHandlers<T = unknown> {
  onEvent(event: ChannelEvent<T>): void;
  /** the server refused or ended the subscription (not retried), or a transport error happened */
  onError?(error: ChannelsError): void;
  onPresence?(p: { event: "sync" | "join" | "leave"; members?: string[]; member?: string }): void;
  /** called with `true` once the server accepted the subscription (again after every reconnect) and `false` when it ended */
  onSubscribed?(active: boolean): void;
}
export interface Subscription { readonly channel: string; unsubscribe(): void }

/** The events of one channel as a discriminated union: `TypedChannelEvent<{ "candidate.updated": CandidateUpdated }>`. */
export type TypedChannelEvent<Events extends Record<string, unknown>> = { [K in keyof Events & string]: ChannelEvent<Events[K]> & { type: K } }[keyof Events & string];

export interface PsoChannelsOptions {
  /** ws:// or wss:// URL, or a path such as "/channels" resolved against `location` (browsers) */
  url: string;
  /** returns a currently valid access token (refresh it here); omit for public channels only */
  getToken?: () => string | Promise<string>;
  reconnect?: { minDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  /** application-level ping interval; a missing pong closes the socket and triggers reconnection (default 25000, 0 disables) */
  heartbeatMs?: number;
  WebSocketImpl?: typeof WebSocket;
  onStateChange?(state: ConnectionState): void;
  onError?(error: ChannelsError): void;
  /** accept ws:// to a non-loopback host (private test networks only) */
  allowInsecure?: boolean;
}
export interface PsoChannels {
  readonly state: ConnectionState;
  /** observe the connection state (for UI bindings); returns the unsubscribe function */
  onStateChange(cb: (state: ConnectionState) => void): () => void;
  /** observe transport and authentication errors; returns the unsubscribe function */
  onError(cb: (error: ChannelsError) => void): () => void;
  /** call after the application session changed (login, logout, refreshed permissions): fetches a token again, re-authenticates and has the server re-authorize every subscription */
  reauthenticate(): Promise<void>;
  subscribe<T = unknown>(channel: string, handlers: SubscriptionHandlers<T>): Subscription;
  /** a client command handled by the channel's @OnEvent method; resolves with the handler's result, rejects with ChannelsError */
  send(channel: string, event: string, payload?: unknown): Promise<unknown>;
  connect(): void;
  close(): void;
}

const SUBPROTOCOL = "pso.channels.v1";
interface Sub { channel: string; handlers: SubscriptionHandlers; active: boolean; /** the subscribe request is in flight */ joining?: boolean }

export function createPsoChannels(o: PsoChannelsOptions): PsoChannels {
  const Impl = o.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Impl) throw new Error("createPsoChannels: no WebSocket implementation (pass WebSocketImpl)");
  const min = o.reconnect?.minDelayMs ?? 500, max = o.reconnect?.maxDelayMs ?? 15_000, maxAttempts = o.reconnect?.maxAttempts ?? Infinity;
  const heartbeat = o.heartbeatMs ?? 25_000;
  let state: ConnectionState = "idle";
  let ws: WebSocket | undefined;
  let attempts = 0, seq = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, hbTimer: ReturnType<typeof setInterval> | undefined, renewTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPong = 0, authenticated = false, wantOpen = false;
  const subs = new Set<Sub>();
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: ChannelsError): void; timer: ReturnType<typeof setTimeout> }>();

  const stateListeners = new Set<(s: ConnectionState) => void>();
  const errorListeners = new Set<(e: ChannelsError) => void>();
  const set = (s: ConnectionState): void => { if (state !== s) { state = s; o.onStateChange?.(s); for (const l of [...stateListeners]) l(s); } };
  const fail = (e: ChannelsError): void => { o.onError?.(e); for (const l of [...errorListeners]) l(e); };
  const loopback = (host: string): boolean => /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(host);
  const secure = (url: string): string => {
    const m = /^ws:\/\/([^/:]+|\[[^\]]+\])/i.exec(url);
    if (m && !loopback(m[1]!) && !o.allowInsecure) throw new Error("refusing an unencrypted ws:// connection to a non-loopback host: use wss:// (or allowInsecure for a private test network)");
    return url;
  };
  const urlOf = (): string => {
    if (/^wss?:\/\//.test(o.url)) return secure(o.url);
    const loc = (globalThis as { location?: { protocol: string; host: string } }).location;
    if (!loc) throw new Error("a relative url needs a browser location; pass a ws:// or wss:// url");
    return secure(`${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${o.url}`);
  };
  const raw = (m: Record<string, unknown>): boolean => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ v: 1, ...m })); return true; } return false; };
  const request = (m: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> => new Promise((resolve, reject) => {
    const id = `c${++seq}`;
    const timer = setTimeout(() => { pending.delete(id); reject({ code: "PSO_CHANNEL_UNAVAILABLE", message: "no answer from the server" }); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (!raw({ ...m, id })) { clearTimeout(timer); pending.delete(id); reject({ code: "PSO_CHANNEL_UNAVAILABLE", message: "not connected" }); }
  });
  const failPending = (e: ChannelsError): void => { for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(e); pending.delete(id); } };

  const jwtExp = (t: string): number | undefined => { try { const b = t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"); const j = JSON.parse(atob(b)) as { exp?: number }; return typeof j.exp === "number" ? j.exp * 1000 : undefined; } catch { return undefined; } };
  async function authenticate(): Promise<boolean> {
    if (!o.getToken) return true;
    let token: string;
    try { token = await o.getToken(); } catch { fail({ code: "PSO_CHANNEL_UNAUTHENTICATED", message: "could not obtain a token" }); return false; }
    try { await request({ t: "auth", token }); authenticated = true; } catch (e) { fail(e as ChannelsError); return false; }
    clearTimeout(renewTimer);
    const exp = jwtExp(token);
    if (exp) renewTimer = setTimeout(() => { void authenticate().then((ok) => { if (ok) resubscribeAll(); }); }, Math.max(1000, exp - Date.now() - 30_000)); // renew shortly before expiry
    return true;
  }
  async function reauth(): Promise<void> {
    if (!ws || ws.readyState !== 1) return; // not connected: authentication happens on the next connection anyway
    authenticated = false;
    if (await authenticate()) resubscribeAll();
  }
  function resubscribeAll(): void { for (const s of subs) void join(s); }
  async function join(s: Sub): Promise<void> {
    s.joining = true;
    try { await request({ t: "subscribe", channel: s.channel }); s.joining = false; if (subs.has(s)) { s.active = true; s.handlers.onSubscribed?.(true); } }
    catch (e) { s.joining = false; subs.delete(s); s.active = false; s.handlers.onSubscribed?.(false); s.handlers.onError?.(e as ChannelsError); }
  }
  // the server keeps ONE subscription per connection and channel: it is released only when no other subscription of this client still wants the channel
  function releaseIfUnused(channel: string): void { for (const x of subs) if (x.channel === channel) return; raw({ t: "unsubscribe", channel, id: `u${++seq}` }); }

  function open(): void {
    if (!wantOpen) return;
    set(attempts === 0 ? "connecting" : "reconnecting");
    let sock: WebSocket;
    try { sock = new Impl!(urlOf(), SUBPROTOCOL); } catch (e) { fail({ code: "PSO_CHANNEL_UNAVAILABLE", message: (e as Error).message }); return scheduleRetry(); }
    ws = sock; authenticated = false;
    sock.onopen = () => {
      lastPong = Date.now(); // attempts are NOT reset here: a connection the server drops right after the upgrade (rejected token) must still count against the bound
      set("connected");
      void (async () => { if (await authenticate()) { attempts = 0; resubscribeAll(); } })(); // a connection that authenticated is a good one: the retry budget starts again
      clearInterval(hbTimer);
      if (heartbeat > 0) hbTimer = setInterval(() => {
        if (Date.now() - lastPong > heartbeat * 2.5) { try { sock.close(4000, "heartbeat"); } catch { /* ignore */ } return; }
        raw({ t: "ping" });
      }, heartbeat);
    };
    sock.onmessage = (ev: MessageEvent) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
      lastPong = Date.now();
      const id = typeof m["id"] === "string" ? m["id"] : undefined;
      switch (m["t"]) {
        case "ack": { const p = id ? pending.get(id) : undefined; if (p && id) { clearTimeout(p.timer); pending.delete(id); p.resolve(m["result"]); } break; }
        case "error": {
          const err: ChannelsError = { code: String(m["code"]), message: String(m["message"]), ...(Array.isArray(m["errors"]) ? { errors: m["errors"] as ChannelsError["errors"] & object } : {}) };
          const p = id ? pending.get(id) : undefined;
          if (p && id) { clearTimeout(p.timer); pending.delete(id); p.reject(err); }
          else if (err.code === "PSO_CHANNEL_TOKEN_EXPIRED") { for (const s of subs) s.handlers.onSubscribed?.(false); void authenticate().then((ok) => { if (ok) resubscribeAll(); }); }
          else fail(err);
          break;
        }
        case "event": { const ch = String(m["channel"]); const ev2 = { eventId: String(m["eventId"]), type: String(m["type"]), channel: ch, ts: String(m["ts"]), ...(typeof m["correlationId"] === "string" ? { correlationId: m["correlationId"] } : {}), payload: m["payload"] }; for (const s of subs) if (s.active && s.channel === ch) s.handlers.onEvent(ev2); break; }
        case "presence": for (const s of subs) if (s.channel === m["channel"]) s.handlers.onPresence?.({ event: m["event"] as "sync", ...(Array.isArray(m["members"]) ? { members: m["members"] as string[] } : {}), ...(typeof m["member"] === "string" ? { member: m["member"] } : {}) }); break;
        case "unsubscribed": for (const s of [...subs]) if (s.channel === m["channel"]) { s.active = false; s.handlers.onSubscribed?.(false); s.handlers.onError?.({ code: "PSO_CHANNEL_FORBIDDEN", message: "The subscription ended: authorization changed." }); subs.delete(s); } break;
        default: break;
      }
    };
    sock.onclose = (ev: CloseEvent) => {
      clearInterval(hbTimer); clearTimeout(renewTimer);
      failPending({ code: "PSO_CHANNEL_UNAVAILABLE", message: "connection closed" });
      for (const s of subs) if (s.active) { s.active = false; s.handlers.onSubscribed?.(false); }
      if (ws === sock) ws = undefined;
      const fatal = ev.code === 4426; // unsupported protocol version: retrying cannot help
      if (!wantOpen || fatal) { set("closed"); return; }
      scheduleRetry();
    };
    sock.onerror = () => { /* onclose follows; the reason is deliberately not exposed */ };
  }

  function scheduleRetry(): void {
    if (!wantOpen) return;
    attempts++;
    if (attempts > maxAttempts) { wantOpen = false; set("closed"); fail({ code: "PSO_CHANNEL_UNAVAILABLE", message: "gave up reconnecting" }); return; }
    set("reconnecting");
    const delay = Math.min(max, min * 2 ** Math.min(attempts - 1, 20)) * (0.5 + Math.random() / 2); // bounded exponential backoff with jitter
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, delay);
  }

  return {
    get state() { return state; },
    onStateChange(cb) { stateListeners.add(cb); return () => { stateListeners.delete(cb); }; },
    onError(cb) { errorListeners.add(cb); return () => { errorListeners.delete(cb); }; },
    reauthenticate: reauth,
    connect() { if (wantOpen) return; wantOpen = true; attempts = 0; open(); },
    subscribe(channel, handlers) {
      const s: Sub = { channel: channel.replace(/^\//, ""), handlers: handlers as SubscriptionHandlers, active: false };
      subs.add(s);
      if (!wantOpen) this.connect();
      else if (state === "connected" && (authenticated || !o.getToken)) void join(s);
      return { channel: s.channel, unsubscribe() { if (!subs.delete(s)) return; const held = s.active || s.joining === true; s.active = false; if (held) releaseIfUnused(s.channel); } };
    },
    send(channel, event, payload) { return request({ t: "event", channel: channel.replace(/^\//, ""), event, payload }); },
    close() { wantOpen = false; clearTimeout(retryTimer); clearInterval(hbTimer); clearTimeout(renewTimer); failPending({ code: "PSO_CHANNEL_UNAVAILABLE", message: "closed" }); try { ws?.close(1000, "client closed"); } catch { /* ignore */ } subs.clear(); set("closed"); },
  };
}
