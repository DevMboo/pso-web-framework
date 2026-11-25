import { createContext, createElement, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ChannelEvent, ChannelsError, ConnectionState, PsoChannels, TypedChannelEvent } from "@pso/channels-client";

/**
 * @pso/react-channels: React bindings over @pso/channels-client. The client owns the single WebSocket, authentication and reconnection;
 * these hooks only tie subscriptions to component lifecycles (they never open a connection of their own).
 *
 *   <PsoChannelsProvider channels={channels}> ... </PsoChannelsProvider>
 *   const { status, connected, events, error } = usePsoChannel("candidate." + id);
 *
 * One subscription per mounted hook; it is removed on unmount and when the channel name changes (no duplicates, no leaks). Events are
 * kept in a bounded list (`maxEvents`, default 100). Changing authentication is the client's `getToken`; the provider re-renders on state changes.
 */
const Ctx = createContext<PsoChannels | undefined>(undefined);
export function PsoChannelsProvider(props: { channels: PsoChannels; children?: ReactNode }): ReturnType<typeof createElement> {
  return createElement(Ctx.Provider, { value: props.channels }, props.children);
}
export const usePsoChannels = (): PsoChannels => {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePsoChannel must be used inside <PsoChannelsProvider>");
  return c;
};

export type ChannelStatus = "loading" | "connected" | "disconnected" | "error";
export interface UsePsoChannelResult<T> { status: ChannelStatus; connected: boolean; events: Array<ChannelEvent<T>>; error: ChannelsError | null; last: ChannelEvent<T> | undefined }

export function usePsoChannel<T = unknown>(channel: string | null, opts: { maxEvents?: number; onEvent?: (e: ChannelEvent<T>) => void } = {}): UsePsoChannelResult<T> {
  const channels = usePsoChannels();
  const [events, setEvents] = useState<Array<ChannelEvent<T>>>([]);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<ChannelsError | null>(null);
  const onEvent = useRef(opts.onEvent);
  onEvent.current = opts.onEvent;
  const max = opts.maxEvents ?? 100;
  useEffect(() => {
    setEvents([]); setError(null); setSubscribed(false);
    if (channel === null) return undefined;
    const sub = channels.subscribe<T>(channel, {
      onEvent: (e) => { onEvent.current?.(e); setEvents((prev) => [...prev, e].slice(-max)); },
      onError: (e) => { setError(e); setSubscribed(false); },
      onSubscribed: (a) => { setSubscribed(a); if (a) setError(null); },
    });
    return () => sub.unsubscribe();
  }, [channels, channel, max]);
  const connection = useConnectionState(channels);
  const status: ChannelStatus = error ? "error" : subscribed ? "connected" : connection === "closed" || connection === "reconnecting" ? "disconnected" : "loading";
  return { status, connected: subscribed, events, error, last: events[events.length - 1] };
}

function useConnectionState(channels: PsoChannels): ConnectionState {
  return useSyncExternalStore((cb) => channels.onStateChange(cb), () => channels.state, () => channels.state);
}

export interface UsePsoConnectionResult {
  state: ConnectionState;
  connected: boolean;
  /** the last transport or authentication error; cleared when the connection is established again */
  error: ChannelsError | null;
  /** call after login, logout or a permission change: re-authenticates and has the server re-authorize every subscription */
  reauthenticate: () => Promise<void>;
}

/** The state of the shared connection (for a status badge, or to hide controls while offline: the server still enforces every permission). */
export function usePsoConnection(): UsePsoConnectionResult {
  const channels = usePsoChannels();
  const state = useConnectionState(channels);
  const [error, setError] = useState<ChannelsError | null>(null);
  useEffect(() => channels.onError((e) => setError(e)), [channels]);
  useEffect(() => { if (state === "connected") setError(null); }, [state]);
  return { state, connected: state === "connected", error, reauthenticate: () => channels.reauthenticate() };
}

/** Like usePsoChannel, but `events` is the discriminated union of the channel's server events (from the generated contracts). */
export interface UsePsoChannelEventsResult<Events extends Record<string, unknown>> extends Omit<UsePsoChannelResult<unknown>, "events" | "last"> {
  events: Array<TypedChannelEvent<Events>>;
  last: TypedChannelEvent<Events> | undefined;
}
export function usePsoChannelEvents<Events extends Record<string, unknown>>(channel: string | null, opts: { maxEvents?: number; onEvent?: (e: TypedChannelEvent<Events>) => void } = {}): UsePsoChannelEventsResult<Events> {
  return usePsoChannel<unknown>(channel, opts as { maxEvents?: number; onEvent?: (e: ChannelEvent<unknown>) => void }) as unknown as UsePsoChannelEventsResult<Events>;
}

export interface PsoChannelsRootProps {
  /** builds the ONE client of this tree (called once per mount; keep `getToken` stable inside it, or read it through a ref) */
  create: () => PsoChannels;
  /** false closes the connection (for example while logged out); true opens it. Default true. */
  enabled?: boolean;
  /** any value that changes when the application session changes (user id, session id): the client then re-authenticates and the server re-authorizes every subscription */
  sessionKey?: unknown;
  children?: ReactNode;
}

/**
 * Owns the lifecycle of the shared client: creates it once, connects while mounted and enabled, closes on unmount, follows session changes.
 * StrictMode-safe (the simulated unmount and remount close and reopen the same client without leaking a socket or a subscription).
 */
export function PsoChannelsRoot(props: PsoChannelsRootProps): ReturnType<typeof createElement> {
  const [client] = useState(props.create);
  const enabled = props.enabled ?? true;
  const first = useRef(true);
  useEffect(() => {
    if (enabled) client.connect(); else client.close();
    return () => client.close();
  }, [client, enabled]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void client.reauthenticate();
  }, [client, props.sessionKey]);
  return createElement(Ctx.Provider, { value: client }, props.children);
}
