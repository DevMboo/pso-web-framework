import { createApiClient, PsoApiError, type AuthSource } from "@pso/frontend-client";
import { b64u, isSafeAppPath, sha256Hex } from "@pso/frontend";
import type { PsoTenant, PsoUser } from "@pso/frontend";

/**
 * Authentication and session lifecycle of the FEI.
 *
 * Trust model (see the documentation page "FEI security"):
 *  - the access token lives only in the closure of this manager: not in React state, not in the shared context, not in web storage.
 *    A MEI receives an `api` client that attaches it; it cannot read it. (Module Federation runs every MEI in the same JavaScript
 *    realm: code that is loaded can reach anything the page can reach. This is encapsulation against mistakes, not a sandbox.)
 *  - the claims decoded here are used for the user interface only. The signature is NOT verified in the browser: the orchestrator and
 *    the services validate every token (JWT/JWKS) and enforce scopes, tenants and business rules.
 *  - sign-in uses Authorization Code with PKCE (S256), `state` and `nonce`; the dev-token provider exists only in development builds
 *    (or in a build that explicitly allows it, which shows a permanent warning).
 */

export type SessionStatus = "signed-out" | "authenticating" | "signed-in" | "expired" | "error";
export interface SessionState { status: SessionStatus; user: PsoUser | null; scopes: readonly string[]; tenant: PsoTenant | null; expiresAt: number | null; error?: string; provider?: AuthConfig["kind"] }

export type AuthConfig =
  | { kind: "oidc"; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; scope?: string; redirectPath?: string; logoutEndpoint?: string; /** where the provider returns the browser after logout, relative to the base path (default: the application root); it must be registered at the provider */ postLogoutRedirectPath?: string; /** try to restore the session after a reload through the provider's own session (prompt=none; default true) */ restoreSession?: boolean }
  | { kind: "dev-token" }
  | { kind: "none" };

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export interface AuthDeps {
  config: AuthConfig;
  /** application identity, used for storage keys and cross-tab messages */
  app: string;
  origin: string;
  basePath: string;
  fetch?: typeof fetch;
  /** short-lived PKCE state (sessionStorage in browsers) */
  storage?: StorageLike;
  /** where the "this browser had a session" marker lives (a flag, never a token). Without it a reload always shows the sign-in page */
  sessionMarker?: StorageLike;
  now?: () => number;
  navigate?: (url: string) => void;
  /** a development token is acceptable (development build, or a build that explicitly allows it) */
  devTokenAllowed: boolean;
  /** DEVELOPMENT BUILDS ONLY: keep a pasted dev token in the tab's sessionStorage so a reload does not ask for it again. Never used in production builds. */
  persistDevToken?: boolean;
  /** seconds before expiry at which a refresh is attempted */
  refreshSkewSeconds?: number;
  broadcast?: { post(msg: unknown): void; onMessage(cb: (msg: unknown) => void): () => void };
  /** claim names */
  claims?: { scope?: string; roles?: string; tenant?: string };
}

export interface Claims { sub?: string; exp?: number; iat?: number; nbf?: number; iss?: string; aud?: string | string[]; scope?: string; scp?: string[] | string; roles?: string[] | string; name?: string; email?: string; preferred_username?: string; tenant?: string; tenant_id?: string; nonce?: string; [k: string]: unknown }

/** Reads the payload of a JWT without verifying it (display and UX only). Returns undefined when it is not a well-formed JWT. */
export function decodeClaims(token: string): Claims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) return undefined;
  try { const c = JSON.parse(new TextDecoder().decode(b64u.decode(parts[1]!))) as Claims; return typeof c === "object" && c ? c : undefined; } catch { return undefined; }
}

/**
 * Endpoints of the identity provider must be https (plain http is accepted only for a loopback development provider): a code or a token
 * must never cross an unprotected network.
 */
export function assertSecureEndpoint(url: string, what: string): void {
  let u: URL; try { u = new URL(url); } catch { throw new Error(`${what} is not a valid URL`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error(`${what} must use https (http is accepted only for localhost): ${u.origin}`);
  if (u.username || u.password || u.hash) throw new Error(`${what} must not contain credentials or a fragment`);
}

/**
 * Validation of an ID token received directly from the token endpoint over TLS (OIDC Core 3.1.3.7: the signature check may be replaced by
 * the TLS connection to the issuer's token endpoint). Checks issuer, audience, authorized party, expiry, issue time and the nonce, which
 * is REQUIRED to match when an ID token is present. Returns a reason, or undefined when the token is acceptable.
 */
export function validateIdToken(c: Claims | undefined, o: { issuer: string; clientId: string; nonce: string; now: number; skewMs?: number }): string | undefined {
  if (!c) return "the identity token is not a JWT";
  const skew = o.skewMs ?? 60_000;
  if (c.nonce !== o.nonce) return "the identity token does not match this sign-in (nonce)";
  if (c.iss !== o.issuer) return `the identity token was issued by "${String(c.iss)}", not by the configured issuer`;
  const aud = Array.isArray(c.aud) ? c.aud : typeof c.aud === "string" ? [c.aud] : [];
  if (!aud.includes(o.clientId)) return "the identity token was not issued for this application (audience)";
  if (aud.length > 1 && c["azp"] !== o.clientId) return "the identity token's authorized party is not this application (azp)";
  if (typeof c.exp !== "number" || c.exp * 1000 <= o.now - skew) return "the identity token is expired";
  if (typeof c.iat === "number" && c.iat * 1000 > o.now + skew) return "the identity token was issued in the future";
  return undefined;
}

export function scopesOf(c: Claims, claim = "scope"): string[] {
  // the configured claim AND `scp` (the orchestrator reads both): a provider may put the OIDC scopes in `scope` and the user's permissions in `scp`
  const list = [claim, "scp"].flatMap((k) => { const v = c[k]; return Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s+/) : []; });
  return [...new Set(list.filter((s): s is string => typeof s === "string" && s.length > 0))].sort();
}

const randomString = (bytes = 32): string => b64u.encode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64u.encode(new Uint8Array(digest));
}

export interface AuthManager {
  readonly source: AuthSource;
  getState(): SessionState;
  subscribe(cb: (s: SessionState) => void): () => void;
  /** start sign-in: OIDC redirects the browser; dev-token needs `signInWithToken` */
  signIn(returnTo?: string, opts?: { silent?: boolean }): Promise<void>;
  signInWithToken(token: string): void;
  /** complete the OIDC redirect (call on the callback route); resolves to the path to return to */
  handleCallback(search: string): Promise<string>;
  signOut(options?: { reason?: string; broadcast?: boolean }): Promise<void>;
  refresh(): Promise<boolean>;
  /** after a reload: ask the provider (prompt=none) to restore the session if one is still alive there. Resolves true when the browser is being redirected */
  restore(returnTo?: string): Promise<boolean>;
  /** release timers and listeners */
  dispose(): void;
}

const ANON: SessionState = { status: "signed-out", user: null, scopes: [], tenant: null, expiresAt: null };

export function createAuthManager(d: AuthDeps): AuthManager {
  const now = d.now ?? (() => Date.now());
  const doFetch = d.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const claimNames = { scope: "scope", roles: "roles", tenant: "tenant_id", ...d.claims };
  const skew = (d.refreshSkewSeconds ?? 30) * 1000;
  const listeners = new Set<(s: SessionState) => void>();
  let state: SessionState = { ...ANON, provider: d.config.kind };
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let idToken: string | undefined; // kept only to hint the provider at logout
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<boolean> | undefined;
  const key = (k: string) => `pso:${d.app}:${k}`;
  const callbacks = new Map<string, Promise<string>>();

  const set = (next: Partial<SessionState>) => { state = { ...state, ...next }; for (const l of [...listeners]) l(state); };
  const clear = () => { if (d.persistDevToken) { try { d.storage?.removeItem(key("dev-token")); } catch { /* ignore */ } } accessToken = undefined; refreshToken = undefined; idToken = undefined; if (timer) clearTimeout(timer); timer = undefined; };

  function adopt(token: string, refresh?: string): void {
    const c = decodeClaims(token);
    if (!c || typeof c.sub !== "string") throw new Error("the token is not a JWT with a subject");
    const expMs = typeof c.exp === "number" ? c.exp * 1000 : null;
    if (expMs !== null && expMs <= now()) throw new Error("the token is already expired");
    if (typeof c.nbf === "number" && c.nbf * 1000 > now() + 60_000) throw new Error("the token is not valid yet");
    accessToken = token;
    if (refresh) refreshToken = refresh;
    const roles = Array.isArray(c[claimNames.roles]) ? (c[claimNames.roles] as unknown[]).filter((r): r is string => typeof r === "string") : typeof c[claimNames.roles] === "string" ? String(c[claimNames.roles]).split(/\s+/) : [];
    const tenantId = c[claimNames.tenant] ?? c.tenant ?? c.tenant_id;
    set({
      status: "signed-in", error: undefined as never,
      user: { id: c.sub, ...(typeof c.name === "string" ? { name: c.name } : typeof c.preferred_username === "string" ? { name: c.preferred_username } : {}), ...(typeof c.email === "string" ? { email: c.email } : {}), roles },
      scopes: scopesOf(c, claimNames.scope), tenant: typeof tenantId === "string" && tenantId ? { id: tenantId } : null, expiresAt: expMs,
    });
    schedule();
    if (d.config.kind === "oidc") { try { d.sessionMarker?.setItem(key("session"), "1"); } catch { /* storage unavailable */ } }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (state.expiresAt === null) return;
    const wait = Math.max(state.expiresAt - now() - skew, 0);
    timer = setTimeout(() => {
      void (async () => {
        if (state.status !== "signed-in") return;
        if (refreshToken && (await refresh())) return;
        if (state.expiresAt !== null && state.expiresAt > now()) { schedule(); return; } // the skew passed but the token is still valid: try again later
        await expire();
      })();
    }, Math.min(wait, 2 ** 31 - 1));
  }

  async function expire(): Promise<void> {
    clear();
    set({ ...ANON, status: "expired", provider: d.config.kind });
    d.broadcast?.post({ type: "expired", app: d.app });
  }

  async function refresh(): Promise<boolean> {
    if (refreshing) return refreshing; // one refresh at a time, for every MEI and every request
    refreshing = (async () => {
      if (d.config.kind !== "oidc" || !refreshToken) return false;
      try {
        const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: d.config.clientId });
        const res = await doFetch(d.config.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
        if (!res.ok) return false;
        const t = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
        if (!t.access_token) return false;
        if (t.id_token) idToken = t.id_token;
        adopt(t.access_token, t.refresh_token ?? refreshToken);
        return true;
      } catch { return false; }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  const redirectUri = (): string => new URL(`${d.basePath.replace(/\/$/, "")}${(d.config.kind === "oidc" && d.config.redirectPath) || "/auth/callback"}`, d.origin).href;

  const source: AuthSource = {
    getAccessToken: () => (state.status === "signed-in" ? accessToken : undefined),
    refresh: () => refresh(),
    onUnauthorized: () => { if (state.status === "signed-in") void (async () => { if (!(refreshToken && (await refresh()))) await expire(); })(); },
  };

  if (d.config.kind === "oidc") { assertSecureEndpoint(d.config.authorizationEndpoint, "authorizationEndpoint"); assertSecureEndpoint(d.config.tokenEndpoint, "tokenEndpoint"); if (d.config.logoutEndpoint) assertSecureEndpoint(d.config.logoutEndpoint, "logoutEndpoint"); }

  if (d.persistDevToken && d.config.kind === "dev-token") {
    try { const saved = d.storage?.getItem(key("dev-token")); if (saved) adopt(saved); } catch { try { d.storage?.removeItem(key("dev-token")); } catch { /* ignore */ } }
  }

  const unsubBroadcast = d.broadcast?.onMessage((m) => {
    const msg = m as { type?: string; app?: string };
    if (msg?.app !== d.app) return;
    if (msg.type === "signed-out" || msg.type === "expired") { clear(); set({ ...ANON, status: msg.type === "expired" ? "expired" : "signed-out", provider: d.config.kind }); }
  });

  return {
    source,
    getState: () => state,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },

    async signIn(returnTo = "/", opts: { silent?: boolean } = {}) {
      if (d.config.kind !== "oidc") throw new Error(d.config.kind === "dev-token" ? "this build signs in with a development token: use the token form" : "authentication is disabled in this application");
      const store = d.storage; if (!store) throw new Error("no storage for the sign-in state");
      const verifier = randomString(48), st = randomString(24), nonce = randomString(24);
      const safe = isSafeAppPath(returnTo.split(/[?#]/)[0]) ? returnTo : "/";
      store.setItem(key("pkce"), JSON.stringify({ verifier, state: st, nonce, returnTo: safe, at: now(), ...(opts.silent ? { silent: true } : {}) }));
      const u = new URL(d.config.authorizationEndpoint);
      u.search = new URLSearchParams({ response_type: "code", client_id: d.config.clientId, redirect_uri: redirectUri(), scope: d.config.scope ?? "openid", state: st, nonce, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", ...(opts.silent ? { prompt: "none" } : {}) }).toString();
      set({ status: "authenticating" });
      (d.navigate ?? ((url) => { globalThis.location.assign(url); }))(u.href);
    },

    signInWithToken(token) {
      if (d.config.kind !== "dev-token" || !d.devTokenAllowed) throw new Error("signing in with a pasted token is not enabled in this build");
      try { adopt(token.trim()); } catch (e) { set({ status: "error", error: (e as Error).message }); throw e; }
      if (d.persistDevToken) { try { d.storage?.setItem(key("dev-token"), token.trim()); } catch { /* storage unavailable */ } }
    },

    handleCallback(search) {
      // one callback is processed once: a remount of the callback page (or a second effect) gets the SAME outcome instead of a second, failing attempt that would end a session that was just established
      const prior = callbacks.get(search); if (prior) return prior;
      const run = (async (): Promise<string> => {
      if (d.config.kind !== "oidc") throw new Error("not an OIDC application");
      const q = new URLSearchParams(search);
      const raw = d.storage?.getItem(key("pkce"));
      d.storage?.removeItem(key("pkce")); // single use, whatever happens next
      const fail = (m: string): never => { set({ ...ANON, status: "error", error: m, provider: "oidc" }); throw new Error(m); };
      if (!raw) return fail("there is no sign-in in progress (the page was opened directly or the sign-in expired)");
      const p = JSON.parse(raw) as { verifier: string; state: string; nonce: string; returnTo: string; at: number; silent?: boolean };
      if (now() - p.at > 10 * 60_000) return fail("the sign-in took too long; start again");
      if (p.silent && ["login_required", "interaction_required", "consent_required", "account_selection_required"].includes(q.get("error") ?? "")) { try { d.sessionMarker?.removeItem(key("session")); } catch { /* ignore */ } set({ ...ANON, provider: "oidc" }); return p.returnTo; } // no live provider session: not an error, the user signs in normally
      if (q.get("error")) return fail(`the identity provider refused the sign-in (${q.get("error")})`);
      if (!q.get("state") || q.get("state") !== p.state) return fail("the sign-in response does not match this browser's request (state)");
      const code = q.get("code"); if (!code) return fail("the sign-in response has no authorization code");
      const res = await doFetch(d.config.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), client_id: d.config.clientId, code_verifier: p.verifier }), credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" }).catch(() => undefined);
      if (!res || !res.ok) return fail("the token request was refused");
      const t = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
      if (!t.access_token) return fail("the token response has no access token");
      if (t.id_token) { const bad = validateIdToken(decodeClaims(t.id_token), { issuer: d.config.issuer, clientId: d.config.clientId, nonce: p.nonce, now: now() }); if (bad) return fail(bad); }
      { const ac = decodeClaims(t.access_token); if (ac?.iss !== undefined && ac.iss !== d.config.issuer) return fail("the access token was issued by a different issuer than the configured one"); }
      try { adopt(t.access_token, t.refresh_token); if (t.id_token) idToken = t.id_token; } catch (e) { return fail((e as Error).message); }
      return p.returnTo;
      })();
      callbacks.set(search, run); return run;
    },

    async signOut(o = {}) {
      const was = state.status; const hint = idToken;
      clear(); try { d.sessionMarker?.removeItem(key("session")); } catch { /* ignore */ }
      set({ ...ANON, provider: d.config.kind });
      if (o.broadcast !== false && was !== "signed-out") d.broadcast?.post({ type: "signed-out", app: d.app });
      if (d.config.kind === "oidc" && d.config.logoutEndpoint && was === "signed-in" && !o.reason) { const u = new URL(d.config.logoutEndpoint); u.searchParams.set("client_id", d.config.clientId); if (hint) u.searchParams.set("id_token_hint", hint); u.searchParams.set("post_logout_redirect_uri", new URL(`${d.basePath.replace(/\/$/, "")}${d.config.postLogoutRedirectPath ?? "/"}`, d.origin).href); (d.navigate ?? ((x) => { globalThis.location.assign(x); }))(u.href); }
    },

    async restore(returnTo = "/") {
      if (d.config.kind !== "oidc" || d.config.restoreSession === false || state.status === "signed-in" || !d.sessionMarker || !d.storage) return false;
      let marked: string | null = null; try { marked = d.sessionMarker.getItem(key("session")); } catch { /* storage unavailable */ }
      if (!marked) return false;
      await this.signIn(returnTo, { silent: true }); return true;
    },

    refresh,
    dispose() { clear(); unsubBroadcast?.(); listeners.clear(); },
  };
}

/** The API client of an application, wired to its auth manager. */
export function createAppApi(auth: AuthManager, o: { basePath: string; origin: string; fetch?: typeof fetch }) {
  return createApiClient({ basePath: o.basePath, origin: o.origin, auth: auth.source, ...(o.fetch ? { fetch: o.fetch } : {}) });
}
export { PsoApiError, sha256Hex };
