import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePsoContext } from "@pso/frontend-react";
import type { PsoChannelEvent } from "@pso/frontend";
import { ordersService } from "../services/orders.service.ts";
import { isFinal, type Order, type OrderUpdated } from "../models/order.ts";

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: Error };

export function useOrdersService() {
  const { api } = usePsoContext();
  return useMemo(() => ordersService(api), [api]);
}

export function useLoad<T>(run: (signal: AbortSignal) => Promise<T>, key: string): Load<T> & { reload(): void } {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: "loading" });
    run(ctl.signal).then((data) => setState({ status: "ready", data }), (error: Error) => { if (!ctl.signal.aborted) setState({ status: "error", error }); });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}

export type LiveMode = "channel" | "polling" | "done";
/**
 * One order, kept current. While it is PENDING the hook listens to `order.<id>` on the FEI's single Channels connection (an
 * `order.updated` event triggers a re-read: the event says THAT it changed, the orchestrator is asked WHAT it is) and, as a bounded
 * fallback for environments without Channels, polls every few seconds for at most `maxPolls` times. Everything is released when
 * the page goes away or the order is decided.
 */
export function useLiveOrder(id: string, o: { pollMs?: number; maxPolls?: number } = {}): { order: Load<Order>; mode: LiveMode; reload(): void; channelState: string; lastEventAt: number | null } {
  const { channels } = usePsoContext();
  const service = useOrdersService();
  const [order, setOrder] = useState<Load<Order>>({ status: "loading" });
  const [mode, setMode] = useState<LiveMode>("channel");
  const [channelState, setChannelState] = useState<string>(channels.state);
  const [lastEventAt, setLast] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const polls = useRef(0);
  const finalSeen = order.status === "ready" && isFinal(order.data.status);

  useEffect(() => channels.onStateChange(setChannelState), [channels]);

  useEffect(() => {
    const ctl = new AbortController();
    service.findById(id, ctl.signal).then((data) => setOrder({ status: "ready", data }), (error: Error) => { if (!ctl.signal.aborted) setOrder({ status: "error", error }); });
    return () => ctl.abort();
  }, [service, id, tick]);

  useEffect(() => {
    if (finalSeen) { setMode("done"); return; }
    if (order.status !== "ready") return;
    const unsubscribe = channels.subscribe<OrderUpdated>(`order.${id}`, (e: PsoChannelEvent<OrderUpdated>) => { if (e.type === "order.updated") { setLast(Date.now()); setTick((t) => t + 1); } });
    const every = o.pollMs ?? 2500, max = o.maxPolls ?? 24;
    const timer = setInterval(() => { if (polls.current++ < max) setTick((t) => t + 1); else clearInterval(timer); }, every);
    setMode(channels.state === "connected" ? "channel" : "polling");
    return () => { unsubscribe(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, id, finalSeen, order.status === "ready"]);

  useEffect(() => { if (!finalSeen) setMode(channelState === "connected" ? "channel" : "polling"); }, [channelState, finalSeen]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { order, mode, reload, channelState, lastEventAt };
}
