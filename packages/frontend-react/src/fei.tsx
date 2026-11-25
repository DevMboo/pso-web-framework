import { Component, StrictMode, Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  BUILTIN_MIDDLEWARES, breadcrumbsFor, isPublicRoute, isSafeRedirect, matchRoute, ownerOf, runNavigation, flattenRoutes, type FrontendRuntimeConfig, type MicrofrontendEntry, type MiddlewareDefinition,
  type NavigationOutcome, type NavigationTarget, type PsoContext, type ResolvedRoute,
} from "@pso/frontend";
import { createApiClient, createChannelsManager, type ChannelsManager } from "@pso/frontend-client";
import { createAuthManager, type AuthConfig, type AuthManager, type SessionState } from "./auth.ts";
import { PsoReactContext, buildContext, createNotificationStore, resolveText, useNotificationQueue, type NotificationStore } from "./context.tsx";
import { MeiBoundary, renderRoutes, type MeiModule, type MeiRouteNode } from "./mei.tsx";
import { defaultMiddlewares, safeReturnTo, type TelemetryEvent } from "./middlewares.ts";
import { createRemoteLoader, RemoteLoadError, type RemoteLoader, type RemoteStatus } from "./remote.ts";

declare const __PSO_DEV__: boolean | undefined;
declare const __PSO_ALLOW_DEV_TOKEN__: boolean | undefined;
declare const __PSO_BASE_PATH__: string | undefined;
const IS_DEV = typeof __PSO_DEV__ !== "undefined" && __PSO_DEV__;
const ALLOW_DEV_TOKEN = IS_DEV || (typeof __PSO_ALLOW_DEV_TOKEN__ !== "undefined" && __PSO_ALLOW_DEV_TOKEN__);

export interface FeiRuntimeDefinition {
  name: string;
  orchestrator: { service: string; basePath: string };
  security: { authentication: "jwt" | "none"; session: "centralized" | "none"; loginPath: string };
  locale: { default: string; supported?: string[] };
  middlewares: string[];
  microfrontends: Array<MicrofrontendEntry & { loading: "lazy" | "eager"; nav: boolean }>;
}

export interface ShellPages {
  Login: ComponentType;
  Forbidden: ComponentType<{ reason: string }>;
  NotFound: ComponentType;
  /** shown when a MEI cannot be loaded; `retry` tries again (bounded by the loader) */
  RemoteUnavailable: ComponentType<{ name: string; error: RemoteLoadError | Error; retry(): void }>;
  Loading: ComponentType<{ label?: string }>;
  /** unexpected error of the shell itself */
  Crash: ComponentType<{ error: Error; reset(): void }>;
}
export interface StartFeiOptions {
  fei: FeiRuntimeDefinition;
  customMiddlewares?: Record<string, MiddlewareDefinition>;
  feiRoutes?: MeiRouteNode[];
  /** the global layout: header, sidebar, notifications. It receives the current page as `children` */
  Shell: ComponentType<{ children?: ReactNode }>;
  /**
   * The layout of PUBLIC routes (see `microfrontends[].public` and `FrontendRoute.public`): shown instead of `Shell`, so a visitor with no session never sees the signed-in navigation or
   * user information. Default: no layout at all (the page alone).
   */
  PublicShell?: ComponentType<{ children?: ReactNode }>;
  pages: ShellPages;
  mount?: HTMLElement;
  /** loaded from `${base}pso-runtime-config.json` when omitted */
  runtimeConfig?: FrontendRuntimeConfig;
  federation?: import("./remote.ts").FederationRuntime;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the FEI's own context (what the shell and its hooks use; a MEI only ever sees PsoContext)

interface FeiState {
  fei: FeiRuntimeDefinition;
  config: FrontendRuntimeConfig;
  auth: AuthManager;
  loader: RemoteLoader;
  channels: ChannelsManager;
  notifications: NotificationStore;
  api: ReturnType<typeof createApiClient>;
  routes: ResolvedRoute[];
  pages: ShellPages;
  theme: { get(): "light" | "dark"; set(t: "light" | "dark" | "system"): void; subscribe(cb: () => void): () => void; preference(): "light" | "dark" | "system" };
  telemetry: { events: TelemetryEvent[]; log(e: TelemetryEvent): void };
  middlewares: MiddlewareDefinition[];
  values: { current: Readonly<Record<string, unknown>> };
}
const FeiCtx = createContext<FeiState | null>(null);
const useFeiState = (): FeiState => { const s = useContext(FeiCtx); if (!s) throw new Error("this hook belongs to the FEI shell"); return s; };

export function useSession(): SessionState {
  const { auth } = useFeiState();
  return useSyncExternalStore(auth.subscribe, auth.getState, auth.getState);
}
export function useAuth(): Pick<AuthManager, "signIn" | "signInWithToken" | "signOut" | "handleCallback"> & { devTokenAllowed: boolean; kind: AuthConfig["kind"] } {
  const { auth, config } = useFeiState();
  return { signIn: auth.signIn, signInWithToken: auth.signInWithToken, signOut: auth.signOut, handleCallback: auth.handleCallback, devTokenAllowed: ALLOW_DEV_TOKEN && config.auth?.kind === "dev-token", kind: (config.auth?.kind ?? "none") };
}
export function useFei(): { name: string; locale: string; loginPath: string; microfrontends: FeiRuntimeDefinition["microfrontends"]; /** "none" when this shell runs without sign-in (declared in FEI.pso.ts, or switched off for this environment by the runtime configuration) */ authentication: "jwt" | "none"; devTokenBuild: boolean; devBuild: boolean } {
  const s = useFeiState();
  return { name: s.fei.name, locale: s.fei.locale.default, loginPath: s.fei.security.loginPath, authentication: s.fei.security.authentication, microfrontends: s.fei.microfrontends, devTokenBuild: ALLOW_DEV_TOKEN && !IS_DEV, devBuild: IS_DEV };
}
export interface NavItem { name: string; path: string; title: string; icon?: string; enabled: boolean; status: RemoteStatus["state"] }
/** Navigation entries the current session may open (UX filtering: the orchestrator enforces access to data). */
export function useNavItems(): NavItem[] {
  const s = useFeiState(); const session = useSession(); const locale = useLocale();
  useSyncExternalStore(s.loader.subscribe, () => JSON.stringify([...s.fei.microfrontends.map((m) => s.loader.status(m.name).state)]));
  const have = new Set(session.scopes);
  return s.fei.microfrontends.filter((m) => m.nav !== false && (m.scopes ?? []).every((x) => have.has(x))).map((m) => ({ name: m.name, path: m.path, title: resolveText(m.title, locale) ?? m.name.replace(/^mei-/, "").replace(/^./, (c) => c.toUpperCase()), ...(m.icon ? { icon: m.icon } : {}), enabled: true, status: s.loader.status(m.name).state }));
}
export function useLocale(): string { const s = useFeiState(); const [l] = useState(() => { try { const v = localStorage.getItem(`pso:${s.fei.name}:locale`); return v && (s.fei.locale.supported ?? [s.fei.locale.default]).includes(v) ? v : s.fei.locale.default; } catch { return s.fei.locale.default; } }); return l; }
export function useTheme(): { theme: "light" | "dark"; preference: "light" | "dark" | "system"; setTheme(t: "light" | "dark" | "system"): void } {
  const { theme } = useFeiState();
  const t = useSyncExternalStore(theme.subscribe, theme.get, theme.get);
  return { theme: t, preference: theme.preference(), setTheme: theme.set };
}
export function useNotifications() { const s = useFeiState(); return useNotificationQueue(s.notifications); }
export function useConnectionState(): ChannelsManager["state"] {
  const { channels } = useFeiState();
  return useSyncExternalStore(channels.onStateChange, () => channels.state, () => channels.state);
}
export function usePrefetch(): (name: string) => void {
  const s = useFeiState(); const session = useSession();
  return useCallback((name: string) => {
    const m = s.fei.microfrontends.find((x) => x.name === name);
    if (!m || !(m.scopes ?? []).every((x) => session.scopes.includes(x))) return; // never prefetch what the user cannot open
    void s.loader.prefetch(name);
  }, [s, session.scopes]);
}
export function useTelemetry(): readonly TelemetryEvent[] { return useFeiState().telemetry.events; }
export function useBreadcrumbs(): Array<{ path: string; title: string }> {
  const s = useFeiState(); const loc = useLocation(); const locale = useLocale();
  useSyncExternalStore(s.loader.subscribe, () => [...s.fei.microfrontends.map((m) => s.loader.status(m.name).version ?? "")].join());
  const known: Array<{ path: string; title?: string | Record<string, string> }> = [...s.routes.map((r) => ({ path: r.path, ...(r.title !== undefined ? { title: r.title } : {}) })), ...s.fei.microfrontends.map((m) => ({ path: m.path, ...(m.title !== undefined ? { title: m.title } : {}) }))];
  for (const m of s.fei.microfrontends) for (const r of s.loader.status(m.name).routes ?? []) known.push(r);
  return breadcrumbsFor(known, loc.pathname, locale);
}
export function useRemoteStatus(name: string): RemoteStatus {
  const { loader } = useFeiState();
  useSyncExternalStore(loader.subscribe, () => loader.status(name).state + (loader.status(name).error?.message ?? ""));
  return loader.status(name);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// navigation gate

type GateState = { key: string; outcome: NavigationOutcome; domain?: MeiModule | undefined } | { key: string; error: Error; remote?: string };

function targetFor(s: FeiState, loc: { pathname: string; search: string; hash: string }): NavigationTarget {
  const pathname = loc.pathname.length > 1 ? loc.pathname.replace(/\/+$/, "") : loc.pathname;
  const owner = ownerOf(s.fei.microfrontends.map((m) => ({ name: m.name, path: m.path })), pathname);
  const m = owner ? s.fei.microfrontends.find((x) => x.name === owner.name) : undefined;
  const own = matchRoute(s.routes.filter((r) => r.owner === s.fei.name), pathname);
  const meta: Record<string, unknown> = { ...(own?.route.meta ?? {}), ...(isPublicHere(s, pathname) ? { public: true } : {}) };
  return { path: pathname, query: Object.fromEntries(new URLSearchParams(loc.search)), params: own?.params ?? {}, hash: loc.hash, ...(owner ? { owner: owner.name } : {}), scopes: [...new Set([...(m?.scopes ?? []), ...(own?.route.scopes ?? [])])], meta };
}

/** The one rule for "may a visitor with no session open this path?" (`isPublicRoute` of @pso/frontend), applied with this shell's declarations. */
function isPublicHere(s: Pick<FeiState, "fei" | "routes">, pathname: string): boolean {
  return isPublicRoute({ loginPath: s.fei.security.loginPath, microfrontends: s.fei.microfrontends }, s.routes.filter((r) => r.owner === s.fei.name), pathname);
}

/** True while the current route is public. A public page can use it to adapt (for example to hide a link that needs a session). */
export function useIsPublicRoute(): boolean {
  const s = useFeiState(); const loc = useLocation();
  return isPublicHere(s, loc.pathname);
}

const Bare = ({ children }: { children?: ReactNode }) => <>{children}</>;
function Frame({ Shell, PublicShell, children }: { Shell: StartFeiOptions["Shell"]; PublicShell: StartFeiOptions["PublicShell"]; children?: ReactNode }) {
  const pub = useIsPublicRoute();
  const Layout = pub ? (PublicShell ?? Bare) : Shell;
  return <Layout>{children}</Layout>;
}

function NavigationGate({ children }: { children: ReactNode }) {
  const s = useFeiState();
  const loc = useLocation();
  const session = useSession();
  const [state, setState] = useState<GateState | null>(null);
  const prev = useRef<string | undefined>(undefined);
  const key = `${loc.pathname}${loc.search}|${session.status}|${session.scopes.join(",")}`;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    const to = targetFor(s, loc);
    void (async () => {
      try {
        const hostResult = await runNavigation({ host: s.middlewares, to, ...(prev.current ? { from: prev.current } : {}), signal: ctl.signal, initial: { feiName: s.fei.name } });
        s.values.current = hostResult.values;
        if (hostResult.outcome.type !== "continue" || !to.owner) { if (!ctl.signal.aborted) { prev.current = to.path; setState({ key: `${key}|${attempt}`, outcome: hostResult.outcome }); } return; }
        // microfrontend resolution: authorized, so the MEI may be loaded now
        const mod = (await s.loader.load(to.owner, attempt > 0 ? { force: true } : {})) as MeiModule;
        let outcome: NavigationOutcome = hostResult.outcome;
        if (mod.middlewares?.length) { const r = await runNavigation({ host: [], domain: { name: to.owner, middlewares: mod.middlewares }, to, signal: ctl.signal, initial: hostResult.values }); outcome = r.outcome; s.values.current = r.values; }
        if (!ctl.signal.aborted) { prev.current = to.path; setState({ key: `${key}|${attempt}`, outcome, domain: mod }); }
      } catch (e) {
        if (ctl.signal.aborted) return;
        if ((e as Error).name === "NavigationCancelled") return;
        setState({ key: `${key}|${attempt}`, error: e as Error, ...(to.owner ? { remote: to.owner } : {}) });
      }
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  if (!state || state.key !== `${key}|${attempt}`) return <s.pages.Loading label="Checking access" />;
  if ("error" in state) {
    if (state.remote) return <s.pages.RemoteUnavailable name={state.remote} error={state.error} retry={() => setAttempt((n) => n + 1)} />;
    return <s.pages.Crash error={state.error} reset={() => setAttempt((n) => n + 1)} />;
  }
  const o = state.outcome;
  if (o.type === "redirect") return <Navigate to={o.to} replace />;
  if (o.type === "denied") return o.status === 404 ? <s.pages.NotFound /> : <s.pages.Forbidden reason={o.reason} />;
  return <>{children}</>;
}

export function MeiOutlet({ name }: { name: string }) {
  const s = useFeiState();
  const [mod, setMod] = useState<MeiModule | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    s.loader.load(name, n ? { force: true } : {}).then((m) => { if (live) { setErr(null); setMod(m as MeiModule); } }, (e: Error) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [s, name, n]);
  if (err) return <s.pages.RemoteUnavailable name={name} error={err} retry={() => setN((x) => x + 1)} />;
  if (!mod) return <s.pages.Loading label={`Loading ${name}`} />;
  const Root = mod.Root as ComponentType;
  return <MeiBoundary name={name} fallback={(e, reset) => <s.pages.RemoteUnavailable name={name} error={e} retry={() => { reset(); setN((x) => x + 1); }} />}><Root /></MeiBoundary>;
}

function AuthCallback() {
  const s = useFeiState(); const nav = useNavigate(); const [err, setErr] = useState<string | null>(null);
  const done = useRef(false);
  // The query string is captured when the page mounts: the effect can run again after the router has already moved on (its `navigate`
  // changes with the location), and a later run must neither read another URL nor redeem the single-use code a second time.
  const search = useRef(globalThis.location.search);
  useEffect(() => {
    if (done.current) return; done.current = true; // React StrictMode runs effects twice; the code may be redeemed once
    if (!globalThis.location.pathname.endsWith("/auth/callback")) return; // not the callback URL (any more): nothing to redeem
    s.auth.handleCallback(search.current).then((to) => nav(safeReturnTo(to), { replace: true }), (e: Error) => setErr(e.message));
  }, [s, nav]);
  if (err) return <div role="alert" data-pso="auth-error"><h1>Sign-in failed</h1><p>{err}</p><a href={s.fei.security.loginPath}>Try again</a></div>;
  return <s.pages.Loading label="Signing in" />;
}

class ShellBoundary extends Component<{ page: ComponentType<{ error: Error; reset(): void }>; children?: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override render() { const P = this.props.page; return this.state.error ? <P error={this.state.error} reset={() => this.setState({ error: null })} /> : this.props.children; }
}

function ContextBridge({ children }: { children: ReactNode }) {
  const s = useFeiState(); const session = useSession(); const navigate = useNavigate(); const locale = useLocale(); const { theme } = useTheme();
  const loc = useLocation();
  const cid = useMemo(() => globalThis.crypto?.randomUUID?.() ?? String(Date.now()), [loc.key]);
  const value: PsoContext = useMemo(() => buildContext({ session, api: s.api, channels: s.channels, notifications: s.notifications, navigate: (to, o) => { if (!isSafeRedirect(to)) throw new Error(`navigate("${to}") refused: only paths inside this application`); void navigate(to, { replace: o?.replace ?? false }); }, locale, theme, correlationId: cid, values: s.values.current }), [session, s, navigate, locale, theme, cid]);
  return <PsoReactContext.Provider value={value}>{children}</PsoReactContext.Provider>;
}

function SignOutOnExpiry() {
  const s = useFeiState(); const session = useSession(); const nav = useNavigate(); const loc = useLocation();
  useEffect(() => { if (session.status === "signed-out" || session.status === "expired") s.channels.close(); }, [session.status, s]);
  useEffect(() => { void s.channels.reauthenticate().catch(() => undefined); }, [session.user?.id, s]); // new identity or refreshed permissions: the server re-authorizes every subscription
  useEffect(() => {
    if ((session.status === "expired" || session.status === "signed-out") && s.fei.security.authentication === "jwt" && !isPublicHere(s, loc.pathname)) nav(`${s.fei.security.loginPath}?returnTo=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
  }, [session.status]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function FeiApp({ s, Shell, PublicShell, feiRoutes }: { s: FeiState; Shell: StartFeiOptions["Shell"]; PublicShell: StartFeiOptions["PublicShell"]; feiRoutes: MeiRouteNode[] }) {
  // when the sign-in page is served by a public microfrontend the shell does not register its own page at that address (the microfrontend renders it)
  const loginInMei = !!ownerOf(s.fei.microfrontends.map((m) => ({ name: m.name, path: m.path })), s.fei.security.loginPath);
  // built once: lazy components created during a render would remount the page every time
  const ownElements = useMemo(() => renderRoutes(feiRoutes, <s.pages.Loading />), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FeiCtx.Provider value={s}>
      <BrowserRouter basename={(typeof __PSO_BASE_PATH__ !== "undefined" ? __PSO_BASE_PATH__ : "/").replace(/\/$/, "") || undefined}>
        <ShellBoundary page={s.pages.Crash}>
          <ContextBridge>
            <SignOutOnExpiry />
            <Frame Shell={Shell} PublicShell={PublicShell}>
              <NavigationGate>
                <Suspense fallback={<s.pages.Loading />}>
                  <Routes>
                    {loginInMei ? null : <Route path={s.fei.security.loginPath} element={<s.pages.Login />} />}
                    <Route path="/auth/callback" element={<AuthCallback />} />
                    <Route path="/forbidden" element={<s.pages.Forbidden reason="You do not have access to this area." />} />
                    {ownElements}
                    {s.fei.microfrontends.map((m) => <Route key={m.name} path={`${m.path}/*`} element={<MeiOutlet name={m.name} />} />)}
                    <Route path="*" element={<s.pages.NotFound />} />
                  </Routes>
                </Suspense>
              </NavigationGate>
            </Frame>
          </ContextBridge>
        </ShellBoundary>
      </BrowserRouter>
    </FeiCtx.Provider>
  );
}

export async function loadRuntimeConfig(base: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<FrontendRuntimeConfig> {
  const res = await fetchImpl(`${base.replace(/\/?$/, "/")}pso-runtime-config.json`, { cache: "no-store", credentials: "omit", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`the runtime configuration answered HTTP ${res.status}`);
  const c = (await res.json()) as FrontendRuntimeConfig;
  if (c?.schema !== 1 || typeof c.fei !== "string" || typeof c.remotes !== "object" || c.remotes === null) throw new Error("the runtime configuration is not a PSO frontend configuration (schema 1)");
  return c;
}

function makeTheme(app: string): FeiState["theme"] {
  const subs = new Set<() => void>();
  const stored = (): "light" | "dark" | "system" => { try { const v = localStorage.getItem(`pso:${app}:theme`); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; } };
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  const effective = (): "light" | "dark" => { const p = stored(); return p === "system" ? (mq?.matches ? "dark" : "light") : p; };
  let cur = effective();
  const apply = () => { cur = effective(); document.documentElement.dataset["theme"] = cur; document.documentElement.style.colorScheme = cur; for (const s of [...subs]) s(); };
  mq?.addEventListener?.("change", apply);
  apply();
  return { get: () => cur, preference: stored, set: (t) => { try { if (t === "system") localStorage.removeItem(`pso:${app}:theme`); else localStorage.setItem(`pso:${app}:theme`, t); } catch { /* storage unavailable: the choice lasts for this page only */ } apply(); }, subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; } };
}

/** Builds and renders the application. `src/main.tsx` is just this call. */
export async function startFei(o: StartFeiOptions): Promise<{ unmount(): void }> {
  const base = (typeof __PSO_BASE_PATH__ !== "undefined" ? __PSO_BASE_PATH__ : "/");
  const container = o.mount ?? document.getElementById("root")!;
  const root = createRoot(container);
  let config: FrontendRuntimeConfig;
  try { config = o.runtimeConfig ?? (await loadRuntimeConfig(base)); }
  catch (e) { root.render(<o.pages.Crash error={e as Error} reset={() => location.reload()} />); throw e; }
  if (config.fei !== o.fei.name) { const e = new Error(`the runtime configuration is for "${config.fei}", this application is "${o.fei.name}"`); root.render(<o.pages.Crash error={e} reset={() => location.reload()} />); throw e; }
  if (!IS_DEV && config.mode === "development") { const e = new Error("a production build refuses a development runtime configuration"); root.render(<o.pages.Crash error={e} reset={() => location.reload()} />); throw e; }
  // the environment can run this shell without sign-in (`pso frontend:config --env <name> --auth none`): the shell is then public there.
  // Only an explicit runtime `auth: none` does this (a missing auth section keeps the declared behaviour), and it changes the shell only:
  // the orchestrator and the services still enforce every protected route, so its API calls without a token still answer 401.
  if (o.fei.security.authentication === "jwt" && config.auth?.kind === "none") o = { ...o, fei: { ...o.fei, security: { ...o.fei.security, authentication: "none", session: "none" } } };
  // the shell's own routes, resolved once: the start-up decision below and the navigation gate use the same table
  const routes: ResolvedRoute[] = o.feiRoutes ? flattenRoutes({ routes: toDecl(o.feiRoutes) }, o.fei.name, "/", "ROUTES.pso.ts") : [];
  const authCfg: AuthConfig = o.fei.security.authentication === "none" ? { kind: "none" } : (config.auth ?? { kind: "none" });
  if (authCfg.kind === "dev-token" && !ALLOW_DEV_TOKEN) { const e = new Error("this build does not allow development-token sign-in. Configure an OIDC provider in the runtime configuration."); root.render(<o.pages.Crash error={e} reset={() => location.reload()} />); throw e; }
  const origin = location.origin;
  const bc = typeof BroadcastChannel === "function" ? new BroadcastChannel(`pso-session:${o.fei.name}`) : undefined;
  const auth = createAuthManager({
    config: authCfg, app: o.fei.name, origin, basePath: base, devTokenAllowed: ALLOW_DEV_TOKEN, persistDevToken: IS_DEV, storage: sessionStorage, sessionMarker: sessionStorage,
    ...(bc ? { broadcast: { post: (m: unknown) => bc.postMessage(m), onMessage: (cb: (m: unknown) => void) => { const h = (ev: MessageEvent) => cb(ev.data); bc.addEventListener("message", h); return () => bc.removeEventListener("message", h); } } } : {}),
  });
  // session restoration: after a reload the token (kept only in memory) is gone; if the provider still has a session for this browser it
  // issues a new code silently (prompt=none). No provider session -> `login_required` -> the user signs in normally. Never on the callback route.
  if (authCfg.kind === "oidc" && !location.pathname.endsWith("/auth/callback")) {
    const b0 = base.replace(/\/$/, ""); const here = (location.pathname.startsWith(b0) ? location.pathname.slice(b0.length) : "/") || "/";
    // a PUBLIC page is opened as it is: restoring a provider session would send the visitor away (a silent redirect to the provider and back) from a page that needs no session at all
    const publicHere = isPublicRoute({ loginPath: o.fei.security.loginPath, microfrontends: o.fei.microfrontends }, routes.filter((r) => r.owner === o.fei.name), here);
    try { if (!publicHere && await auth.restore(`${here}${location.search}`)) return { unmount() { auth.dispose(); bc?.close(); } }; } catch { /* storage or navigation unavailable: the user signs in */ }
  }
  const apiBase = config.orchestrator.basePath;
  const api = createApiClient({ basePath: apiBase, origin, auth: auth.source });
  const wsBase = (config.orchestrator.channelsPath ?? `${apiBase.replace(/\/$/, "")}/channels`);
  const channels = createChannelsManager({ url: wsBase, getToken: async () => (await auth.source.getAccessToken()) ?? "", reconnect: { minDelayMs: 500, maxDelayMs: 10_000, maxAttempts: 12 } });
  const federation = o.federation ?? (await import("@module-federation/enhanced/runtime")) as unknown as import("./remote.ts").FederationRuntime;
  const hostShared: Record<string, string> = {};
  const loader = createRemoteLoader({ config, origin, federation, hostShared });
  const notifications = createNotificationStore();
  const telemetryEvents: TelemetryEvent[] = [];
  const telemetry = { events: telemetryEvents, log: (e: TelemetryEvent) => { telemetryEvents.push(e); if (telemetryEvents.length > 200) telemetryEvents.shift(); window.dispatchEvent(new CustomEvent("pso:telemetry", { detail: e })); } };
  const defaults = defaultMiddlewares({ auth, authentication: o.fei.security.authentication, loginPath: o.fei.security.loginPath, locale: o.fei.locale, telemetry: telemetry.log, getLocale: () => { try { return localStorage.getItem(`pso:${o.fei.name}:locale`); } catch { return null; } } });
  const chain: MiddlewareDefinition[] = o.fei.middlewares.map((n) => { const m = (BUILTIN_MIDDLEWARES as readonly string[]).includes(n) ? defaults[n] : o.customMiddlewares?.[n]; if (!m) throw new Error(`middleware "${n}" is declared in FEI.pso.ts but was not found`); return m; });
  const state: FeiState = { fei: o.fei, config, auth, loader, channels, notifications, api, routes, pages: o.pages, theme: makeTheme(o.fei.name), telemetry, middlewares: chain, values: { current: {} } };
  for (const m of o.fei.microfrontends) if (m.loading === "eager") void loader.prefetch(m.name);
  root.render(<StrictMode><FeiApp s={state} Shell={o.Shell} PublicShell={o.PublicShell} feiRoutes={o.feiRoutes ?? []} /></StrictMode>);
  return { unmount() { root.unmount(); auth.dispose(); channels.close(); bc?.close(); } };
}

const toDecl = (rs: MeiRouteNode[]): import("@pso/frontend").FrontendRoute[] => rs.map((r) => ({ path: r.path, ...(r.redirect ? { redirect: r.redirect } : {}), ...(r.load ? { page: "./page" } : {}), ...(r.title !== undefined ? { title: r.title } : {}), ...(r.scopes ? { scopes: r.scopes } : {}), ...(r.meta ? { meta: r.meta as Record<string, string | number | boolean> } : {}), ...(r.children ? { children: toDecl(r.children) } : {}) }));
export { lazy };
