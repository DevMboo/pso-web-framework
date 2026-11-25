import { useCallback, useEffect, useMemo, useState } from "react";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import type { Item } from "../models/item.ts";
import { cartService } from "../services/cart.service.ts";

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: PsoApiError | Error };

/** Loads the list once, cancels the request when the page goes away, and exposes `reload`. */
export function useCart(): Load<Item[]> & { reload(): void } {
  const { api } = usePsoContext();
  const service = useMemo(() => cartService(api), [api]);
  const [state, setState] = useState<Load<Item[]>>({ status: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: "loading" });
    service.findAll(ctl.signal).then((data) => setState({ status: "ready", data }), (error: Error) => { if (!ctl.signal.aborted) setState({ status: "error", error }); });
    return () => ctl.abort();
  }, [service, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}
