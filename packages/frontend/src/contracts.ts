/**
 * Declarative contracts of the PSO frontend ecosystem.
 *
 * FEI (Frontend Ecosystem Integration) is the application shell: it owns navigation, authentication, the middleware pipeline and the
 * session. MEI (Microfrontend Ecosystem Integration) is an independent business-domain React application rendered inside the FEI.
 *
 * `FEI.pso.ts`, `MEI.pso.ts` and `ROUTES.pso.ts` are DATA, like every other PSO declaration: the CLI and Studio read them without
 * executing them (see `@pso/frontend/node`), so they may contain literals only. The `define*` functions exist for the editor and tsc.
 *
 * This file is browser-safe: no Node API, no dependency.
 */

/** Version of the context contract between a FEI and its MEIs (`major.minor`). A MEI built for 1.x runs in any host that offers 1.y with y >= x. */
export const CONTEXT_CONTRACT_VERSION = "1.0";
/** Version of the FEI/MEI declaration schema. */
export const FRONTEND_SCHEMA_VERSION = 1;

export const DEFAULT_FEI_PORT = 4200;
export const DEFAULT_MEI_PORT = 9000;

/** Built-in navigation middlewares, in their mandatory order. Their implementation lives in `@pso/frontend-react`. */
export const BUILTIN_MIDDLEWARES = ["authentication", "authorization", "session", "context", "telemetry"] as const;
export type BuiltinMiddleware = (typeof BUILTIN_MIDDLEWARES)[number];

/** URL prefixes the frontend must never claim: the API, the remote artifacts and PSO's own endpoints. */
export const RESERVED_PATH_PREFIXES = ["/api", "/_mei", "/_pso", "/_fei", "/health", "/channels"] as const;

export type AuthenticationKind = "jwt" | "none";
export type SessionKind = "centralized" | "none";
export type LoadingMode = "lazy" | "eager";

export interface MicrofrontendEntry {
  /** identity of the MEI (`mei-<domain>`): must equal `name` in that project's MEI.pso.ts */
  name: string;
  /** the URL prefix the MEI owns inside the FEI (`/customers`): the MEI cannot serve anything outside it */
  path: string;
  /** scopes the user needs to enter the MEI (UX only; the orchestrator enforces them again) */
  scopes?: string[];
  /** `lazy` (default): loaded on first navigation. `eager`: loaded at startup (use sparingly) */
  loading?: LoadingMode;
  /** title shown in the navigation (a localized map is also accepted) */
  title?: string | Record<string, string>;
  /** react-icons name shown in the navigation (resolved by the FEI template) */
  icon?: string;
  /** `false` keeps the MEI routable but out of the navigation menu (public MEIs default to `false`) */
  nav?: boolean;
  /**
   * PUBLIC routes: pages a visitor with NO session may open. Default: none (everything a MEI serves needs a signed-in user).
   *  - `true`: every route of the MEI is public.
   *  - a list of paths RELATIVE to `path` (`"/"`, `"/login"`, `"/guide/*"`): only those routes are public, the rest of the MEI stays protected.
   * Only the FEI decides this (a MEI cannot declare itself public). A public route skips the sign-in requirement of the shell and nothing else: the API still authenticates every
   * request with the token the visitor does not have, so a public page can only show what the orchestrator serves to anonymous callers. A public MEI cannot declare `scopes`.
   */
  public?: boolean | string[];
}

export interface FeiDefinition {
  name: string;
  server?: { port?: number };
  /** the PSO orchestrator the frontend talks to: the only backend it may call */
  orchestrator: { service: string; /** path prefix the browser uses (default `/api`; same origin) */ basePath?: string };
  security?: {
    authentication?: AuthenticationKind;
    session?: SessionKind;
    /** where the browser sends users that are not signed in; relative paths only */
    loginPath?: string;
  };
  /** the navigation pipeline, in execution order. Built-in names or files `src/middlewares/<name>.ts` */
  middlewares?: string[];
  microfrontends: MicrofrontendEntry[];
  /** default locale and the list the shell offers */
  locale?: { default: string; supported?: string[] };
  /** upper limits checked after a build (bytes, gzip) */
  budgets?: { shellKb?: number; remoteKb?: number };
}

export interface MeiDefinition {
  name: string;
  /** the FEI this MEI is built for (`fei-<name>`) */
  host: string;
  server?: { port?: number };
  orchestrator: { service: string };
  /** what the MEI offers the host: the module (default `./src/module.tsx`) */
  expose?: { module?: string };
  security?: {
    /** the MEI uses the FEI's session; it never starts its own (always true in production) */
    inheritFromHost?: boolean;
    /** scopes the MEI's own routes need */
    scopes?: string[];
  };
  /** context contract version the MEI was built against (default: the current one) */
  contract?: { context?: string };
  /** domain middleware the MEI adds AFTER the mandatory FEI pipeline (files `src/middlewares/<name>.ts`) */
  middlewares?: string[];
}

export interface FrontendRoute {
  /** path relative to the owner (the MEI's mount path, or the FEI root) */
  path: string;
  /** component file relative to `src/` (MEI) or `src/routes/` is not assumed: give the path from the project root, e.g. `./src/pages/Customers.tsx` */
  page?: string;
  /** layout file wrapped around `page` and the children */
  layout?: string;
  redirect?: string;
  title?: string | Record<string, string>;
  /** scopes needed to open the route (UX; enforced again by the orchestrator for the data) */
  scopes?: string[];
  /**
   * A page of the FEI itself (not of a MEI) that a visitor with no session may open. Default: false (protected). A MEI's own routes cannot use this: a MEI is made public by the FEI
   * (`microfrontends[].public`). Same effect as the earlier `meta: { public: true }`, which keeps working.
   */
  public?: boolean;
  /** free metadata, e.g. breadcrumb labels */
  meta?: Record<string, string | number | boolean>;
  children?: FrontendRoute[];
}

export interface FrontendRoutesDefinition { routes: FrontendRoute[] }

export type MiddlewareScope = "navigation" | "request" | "lifecycle";

export interface MiddlewareContextBase {
  /** values set by earlier middlewares; MEI middlewares get a read-only view */
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  readonly signal: AbortSignal;
}
export interface NavigationTarget { path: string; query: Record<string, string>; params: Record<string, string>; hash: string; /** the MEI that owns the route, if any */ owner?: string; scopes: readonly string[]; title?: string; meta?: Record<string, unknown> }
export interface NavigationContext extends MiddlewareContextBase {
  readonly kind: "navigation";
  readonly to: NavigationTarget;
  readonly from?: string;
  /** stop the pipeline and navigate elsewhere (same-origin paths only; checked) */
  redirect(path: string): NavigationOutcome;
  /** stop the pipeline: the user is not allowed here (a UX decision: the backend enforces the real boundary) */
  deny(status: 401 | 403 | 404, reason: string): NavigationOutcome;
}
export type NavigationOutcome =
  | { type: "continue" }
  | { type: "redirect"; to: string }
  | { type: "denied"; status: 401 | 403 | 404; reason: string };

export interface MiddlewareDefinition<C extends MiddlewareContextBase = NavigationContext> {
  name: string;
  scope?: MiddlewareScope;
  execute(context: C, next: () => Promise<NavigationOutcome>): Promise<NavigationOutcome> | NavigationOutcome;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// define* helpers: identity functions that give types. They are never executed by the PSO tools.

export const defineFEI = <const T extends FeiDefinition>(d: T): T => d;
export const defineMEI = <const T extends MeiDefinition>(d: T): T => d;
export const defineFrontendRoutes = <const T extends FrontendRoutesDefinition>(d: T): T => d;
export const defineMiddleware = <C extends MiddlewareContextBase = NavigationContext>(d: MiddlewareDefinition<C>): MiddlewareDefinition<C> => d;

// ---------------------------------------------------------------------------------------------------------------------------------
// The shared application context a MEI receives. Stable, versioned, read-only: a MEI never gets the raw token or a way to mutate it.

export interface PsoUser { id: string; name?: string; email?: string; roles: readonly string[] }
export interface PsoTenant { id: string; name?: string }
export interface NotifyOptions { level?: "info" | "success" | "warning" | "error"; title?: string; /** milliseconds, 0 = until dismissed */ durationMs?: number }

export interface PsoRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** GET only: concurrent identical requests share one network call */
  dedupe?: boolean;
  /** an `Idempotency-Key` makes a POST safe to repeat; only then may the client retry it */
  idempotencyKey?: string;
}
export interface PsoApi {
  get<T = unknown>(path: string, options?: PsoRequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: PsoRequestOptions): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, options?: PsoRequestOptions): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, options?: PsoRequestOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: PsoRequestOptions): Promise<T>;
  upload<T = unknown>(path: string, body: FormData, options?: PsoRequestOptions): Promise<T>;
  download(path: string, options?: PsoRequestOptions): Promise<Blob>;
}
export interface PsoChannelEvent<T = unknown> { eventId: string; type: string; channel: string; ts: string; correlationId?: string; payload: T }
export interface PsoChannelsFacade {
  readonly state: "idle" | "connecting" | "connected" | "reconnecting" | "closed";
  /** subscribe to a channel; the FEI owns the single connection. Returns the unsubscribe function */
  subscribe<T = unknown>(channel: string, onEvent: (event: PsoChannelEvent<T>) => void): () => void;
  onStateChange(cb: (state: PsoChannelsFacade["state"]) => void): () => void;
}
export interface PsoContext {
  readonly contractVersion: string;
  readonly user: PsoUser | null;
  /** the scopes of the session: for UX decisions only */
  readonly permissions: readonly string[];
  hasScope(scope: string): boolean;
  readonly locale: string;
  readonly tenant: PsoTenant | null;
  readonly theme: "light" | "dark";
  readonly correlationId: string;
  readonly capabilities: readonly string[];
  navigate(to: string, options?: { replace?: boolean }): void;
  readonly api: PsoApi;
  readonly channels: PsoChannelsFacade;
  readonly notifications: { notify(message: string, options?: NotifyOptions): void };
  /** a read-only value a FEI middleware published (`context.set`) */
  get<T = unknown>(key: string): T | undefined;
}

/** What the FEI offers MEIs in contract 1.0. */
export const CONTEXT_CAPABILITIES_1_0 = ["user", "permissions", "locale", "tenant", "theme", "navigate", "api", "channels", "notifications", "correlation"] as const;

/** What a MEI module exports as `default` (see `defineMeiModule` in `@pso/frontend-react`). */
export interface MeiModuleExport { readonly kind: "pso-mei-module"; readonly name: string; readonly contract: string; readonly Root: unknown }
