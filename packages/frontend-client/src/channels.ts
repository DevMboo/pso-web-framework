import { createPsoChannels, type ChannelEvent, type ChannelsError, type ConnectionState, type PsoChannels, type PsoChannelsOptions } from "@pso/channels-client";
import type { PsoChannelEvent, PsoChannelsFacade } from "@pso/frontend";

/**
 * The FEI-owned Channels connection. MEIs get a `PsoChannelsFacade`: they can subscribe and observe the state, nothing else. The
 * manager keeps ONE WebSocket for the whole shell and one server-side subscription per channel, however many MEIs listen to it, and
 * closes the server-side subscription when the last listener goes away (so navigating between MEIs leaves nothing behind).
 */
export interface ChannelsManagerOptions extends Omit<PsoChannelsOptions, "onStateChange" | "onError"> {
  /** a connection is opened when the first listener subscribes (lazy, default) or at once */
  connect?: "lazy" | "eager";
  /** inject a connection (tests) */
  channels?: PsoChannels;
}
export interface ChannelsManager extends PsoChannelsFacade {
  /** FEI only: after login, logout or a permissions change */
  reauthenticate(): Promise<void>;
  /** FEI only: close everything (logout) */
  close(): void;
  /** FEI only: errors reported by the transport (never contain tokens) */
  onError(cb: (e: ChannelsError) => void): () => void;
  /** number of server-side subscriptions currently open (diagnostics, tests) */
  readonly activeChannels: number;
  readonly listenerCount: number;
}

interface Entry { unsubscribe(): void; listeners: Set<(e: PsoChannelEvent) => void> }

export function createChannelsManager(o: ChannelsManagerOptions): ChannelsManager {
  const state = { value: "idle" as ConnectionState };
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const errorListeners = new Set<(e: ChannelsError) => void>();
  const entries = new Map<string, Entry>();
  let conn: PsoChannels | undefined = o.channels;
  let wired = false;

  const ensure = (): PsoChannels => {
    conn ??= createPsoChannels(o);
    if (!wired) {
      wired = true;
      state.value = conn.state;
      conn.onStateChange((s) => { state.value = s; for (const cb of [...stateListeners]) cb(s); });
      conn.onError((e) => { for (const cb of [...errorListeners]) cb(e); });
    }
    return conn;
  };
  if (o.connect === "eager") ensure().connect();

  return {
    get state() { return state.value; },
    get activeChannels() { return entries.size; },
    get listenerCount() { let n = 0; for (const e of entries.values()) n += e.listeners.size; return n; },
    subscribe<T = unknown>(channel: string, onEvent: (e: PsoChannelEvent<T>) => void): () => void {
      const c = ensure();
      let entry = entries.get(channel);
      if (!entry) {
        const listeners = new Set<(e: PsoChannelEvent) => void>();
        const sub = c.subscribe(channel, { onEvent: (e: ChannelEvent) => { for (const l of [...listeners]) { try { l(e); } catch { /* one faulty listener must not stop the others */ } } } });
        entry = { unsubscribe: () => sub.unsubscribe(), listeners };
        entries.set(channel, entry);
        if (c.state === "idle" || c.state === "closed") c.connect();
      }
      const l = onEvent as (e: PsoChannelEvent) => void;
      entry.listeners.add(l);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const e = entries.get(channel);
        if (!e) return;
        e.listeners.delete(l);
        if (e.listeners.size === 0) { e.unsubscribe(); entries.delete(channel); }
      };
    },
    onStateChange(cb) { stateListeners.add(cb); return () => { stateListeners.delete(cb); }; },
    onError(cb) { errorListeners.add(cb); return () => { errorListeners.delete(cb); }; },
    async reauthenticate() { if (conn) await conn.reauthenticate(); },
    close() { for (const e of entries.values()) e.unsubscribe(); entries.clear(); conn?.close(); },
  };
}
