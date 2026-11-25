import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { isSafeRedirect } from "@pso/frontend";
import { createApiClient, createChannelsManager } from "@pso/frontend-client";
import { createAuthManager } from "./auth.ts";
import { PsoReactContext, buildContext, createNotificationStore, useNotificationQueue } from "./context.tsx";
import type { MeiModule } from "./mei.tsx";

/**
 * Development host adapter: a minimal stand-in for the FEI so a MEI can be developed on its own.
 *
 * It provides the SAME PsoContext contract the real FEI provides (user, permissions, api, channels, notifications, navigate...) and
 * nothing else: no shell, no navigation chrome. It is only ever compiled into the standalone development entry
 * (`pso frontend:dev --standalone`), and it refuses to run when the build is not a development build: simulated authentication
 * cannot reach production.
 */
declare const __PSO_DEV__: boolean | undefined;

export interface StandaloneOptions { apiBasePath?: string; mount?: HTMLElement }

function Banner() {
  return <div role="note" style={{ background: "#7c2d12", color: "#fff", padding: "6px 12px", font: "13px/1.4 system-ui, sans-serif" }}>Standalone development host: this simulates the FEI for local development. It does not exist in production builds.</div>;
}

function TokenForm({ onToken, error }: { onToken(t: string): void; error?: string | undefined }) {
  const [v, setV] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onToken(v); setV(""); }} style={{ maxWidth: 560, margin: "48px auto", font: "14px/1.5 system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20 }}>Development session</h1>
      <p>Paste a development token (<code>pso idp:dev token --scopes …</code>). It is kept in memory only and disappears when you reload.</p>
      <label htmlFor="pso-dev-token">Access token</label>
      <textarea id="pso-dev-token" value={v} onChange={(e) => setV(e.target.value)} rows={4} spellCheck={false} autoComplete="off" style={{ display: "block", width: "100%", fontFamily: "monospace" }} />
      {error ? <p role="alert" style={{ color: "#b91c1c" }}>{error}</p> : null}
      <button type="submit" disabled={!v.trim()}>Start session</button>
    </form>
  );
}

function Notifications({ store }: { store: ReturnType<typeof createNotificationStore> }) {
  const { items, dismiss } = useNotificationQueue(store);
  return <div aria-live="polite" style={{ position: "fixed", right: 12, bottom: 12, display: "grid", gap: 8, zIndex: 50 }}>{items.map((n) => <div key={n.id} role={n.level === "error" ? "alert" : "status"} style={{ background: "#111827", color: "#fff", padding: "8px 12px", borderRadius: 6, font: "13px system-ui" }}>{n.title ? <strong>{n.title}: </strong> : null}{n.message}<button onClick={() => dismiss(n.id)} aria-label="Dismiss" style={{ marginLeft: 8 }}>x</button></div>)}</div>;
}

function Host({ mei, apiBasePath }: { mei: MeiModule; apiBasePath: string }) {
  const parts = useMemo(() => {
    const auth = createAuthManager({ config: { kind: "dev-token" }, app: `standalone-${mei.name}`, origin: location.origin, basePath: "/", devTokenAllowed: true, persistDevToken: true, storage: sessionStorage });
    const api = createApiClient({ basePath: apiBasePath, origin: location.origin, auth: auth.source });
    const channels = createChannelsManager({ url: `${apiBasePath}/channels`, getToken: async () => (await auth.source.getAccessToken()) ?? "" });
    return { auth, api, channels, notifications: createNotificationStore() };
  }, [mei.name, apiBasePath]);
  const session = useSyncExternalStore(parts.auth.subscribe, parts.auth.getState, parts.auth.getState);
  const [error, setError] = useState<string>();
  const navigate = useNavigate();
  const loc = useLocation();
  useEffect(() => () => { parts.channels.close(); parts.auth.dispose(); }, [parts]);
  const ctx = useMemo(() => buildContext({
    session, api: parts.api, channels: parts.channels, notifications: parts.notifications,
    navigate: (to, o) => { if (!isSafeRedirect(to)) throw new Error(`navigate("${to}") refused`); void navigate(to, { replace: o?.replace ?? false }); },
    locale: navigator.language || "en", theme: matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light", correlationId: crypto.randomUUID(), values: {},
  }), [session, parts, navigate, loc.key]);
  const Root = mei.Root as () => ReactNode;
  return (
    <PsoReactContext.Provider value={ctx}>
      <Banner />
      {session.status === "signed-in" ? <Root /> : <TokenForm error={error ?? session.error} onToken={(t) => { try { parts.auth.signInWithToken(t); setError(undefined); } catch (e) { setError((e as Error).message); } }} />}
      <Notifications store={parts.notifications} />
    </PsoReactContext.Provider>
  );
}

export function startStandalone(mei: MeiModule, o: StandaloneOptions = {}): void {
  if (typeof __PSO_DEV__ === "undefined" || !__PSO_DEV__) throw new Error("the standalone development host cannot run in a production build");
  const el = o.mount ?? document.getElementById("root")!;
  createRoot(el).render(<StrictMode><BrowserRouter><Routes><Route path="/*" element={<Host mei={mei} apiBasePath={o.apiBasePath ?? "/api"} />} /></Routes></BrowserRouter></StrictMode>);
}
