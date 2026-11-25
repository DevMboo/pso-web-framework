import { createContext, useContext, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { CONTEXT_CAPABILITIES_1_0, CONTEXT_CONTRACT_VERSION, type NotifyOptions, type PsoApi, type PsoChannelsFacade, type PsoContext } from "@pso/frontend";
import type { SessionState } from "./auth.ts";

/**
 * The shared application context. The React context object is kept on `globalThis` under a well-known key: if a bundler ever
 * produced two copies of this module (a misconfigured shared singleton), the FEI and the MEI would still talk through ONE context
 * instead of the MEI silently seeing "no host".
 */
const KEY = Symbol.for("@pso/frontend-react/context");
type G = { [KEY]?: React.Context<PsoContext | null> };
export const PsoReactContext: React.Context<PsoContext | null> = ((globalThis as G)[KEY] ??= createContext<PsoContext | null>(null));

export function usePsoContext(): PsoContext {
  const c = useContext(PsoReactContext);
  if (!c) throw new Error("usePsoContext: no PSO host. A MEI runs inside its FEI, or inside the standalone development host (pso frontend:dev --standalone).");
  return c;
}
export const usePsoContextOptional = (): PsoContext | null => useContext(PsoReactContext);

// ---- notifications --------------------------------------------------------------------------------------------------------------

export interface Notification { id: number; message: string; level: NonNullable<NotifyOptions["level"]>; title?: string; durationMs: number }
export interface NotificationStore {
  notify(message: string, options?: NotifyOptions): void;
  dismiss(id: number): void;
  subscribe(cb: () => void): () => void;
  snapshot(): readonly Notification[];
}
export function createNotificationStore(max = 5): NotificationStore {
  let list: readonly Notification[] = [];
  let seq = 0;
  const subs = new Set<() => void>();
  const emit = () => { for (const s of [...subs]) s(); };
  const dismiss = (id: number) => { const n = list.filter((x) => x.id !== id); if (n.length !== list.length) { list = n; emit(); } };
  return {
    notify(message, o = {}) {
      const level = o.level ?? "info";
      const n: Notification = { id: ++seq, message: String(message).slice(0, 500), level, ...(o.title ? { title: String(o.title).slice(0, 120) } : {}), durationMs: o.durationMs ?? (level === "error" ? 0 : 5000) };
      list = [...list, n].slice(-max);
      emit();
      if (n.durationMs > 0) setTimeout(() => dismiss(n.id), n.durationMs);
    },
    dismiss,
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
    snapshot: () => list,
  };
}
export function useNotificationQueue(store: NotificationStore): { items: readonly Notification[]; dismiss(id: number): void } {
  const items = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { items, dismiss: store.dismiss };
}

// ---- building the context a MEI receives -------------------------------------------------------------------------------------------

export interface ContextSources {
  session: SessionState;
  api: PsoApi;
  channels: PsoChannelsFacade;
  notifications: Pick<NotificationStore, "notify">;
  navigate(to: string, o?: { replace?: boolean }): void;
  locale: string;
  theme: "light" | "dark";
  correlationId: string;
  values: Readonly<Record<string, unknown>>;
}

/**
 * The context is a frozen snapshot of what a MEI may know. It holds no token, no auth manager, no refresh function and no setter for
 * session, tenant or permissions: a MEI cannot change global state through it.
 */
export function buildContext(s: ContextSources): PsoContext {
  const scopes = new Set(s.session.scopes);
  const published = Object.freeze({ ...s.values });
  return Object.freeze({
    contractVersion: CONTEXT_CONTRACT_VERSION,
    user: s.session.user ? Object.freeze({ ...s.session.user, roles: Object.freeze([...s.session.user.roles]) }) : null,
    permissions: Object.freeze([...s.session.scopes]),
    hasScope: (scope: string) => scopes.has(scope),
    locale: s.locale,
    tenant: s.session.tenant ? Object.freeze({ ...s.session.tenant }) : null,
    theme: s.theme,
    correlationId: s.correlationId,
    capabilities: CONTEXT_CAPABILITIES_1_0,
    navigate: s.navigate,
    api: s.api,
    channels: s.channels,
    notifications: Object.freeze({ notify: (m: string, o?: NotifyOptions) => s.notifications.notify(m, o) }),
    get: <T,>(key: string) => published[key] as T | undefined,
  });
}

export { resolveText } from "@pso/frontend";

export type PageComponent = ComponentType<{ children?: ReactNode }>;
