import { useCallback, useEffect, useMemo, useState } from "react";
import { usePsoContext } from "@pso/frontend-react";
import { customersService } from "../services/customers.service.ts";

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: Error };

export function useCustomersService() {
  const { api } = usePsoContext();
  return useMemo(() => customersService(api), [api]);
}

/** Runs a read once per `key`, cancels it when the page goes away and exposes `reload`. */
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
