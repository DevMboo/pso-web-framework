import { defineMiddleware, isSafeAppPath, type MiddlewareDefinition } from "@pso/frontend";
import type { AuthManager } from "./auth.ts";

/**
 * The default FEI middlewares. They improve the user experience: they decide what the shell shows and where it sends the user.
 * They are NOT a security boundary. Every request still carries the access token to the orchestrator, which verifies the JWT and
 * enforces scopes, tenant and business rules.
 */
export interface MiddlewareDeps {
  auth: AuthManager;
  authentication: "jwt" | "none";
  loginPath: string;
  locale: { default: string; supported?: string[] };
  /** receives navigation measurements (the shell's telemetry sink) */
  telemetry?: (e: TelemetryEvent) => void;
  now?: () => number;
  getLocale?: () => string | null;
  correlation?: () => string;
}
export interface TelemetryEvent { type: "navigation"; path: string; owner?: string; outcome: string; ms: number; trace: number }

export const isPublic = (meta: Record<string, unknown> | undefined): boolean => meta?.["public"] === true;

export function loginRedirect(loginPath: string, path: string, query: Record<string, string>): string {
  const back = path + (Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "");
  return isSafeAppPath(path) ? `${loginPath}?returnTo=${encodeURIComponent(back)}` : loginPath;
}
/** Reads `returnTo` and refuses anything that is not a path inside this application (open-redirect protection). */
export function safeReturnTo(raw: string | null | undefined, fallback = "/"): string {
  if (!raw || raw.length > 2048 || !/^\/(?![/\\])/.test(raw) || /[\u0000-\u001f\\]/.test(raw)) return fallback;
  return isSafeAppPath(raw.split(/[?#]/)[0]) ? raw : fallback;
}

export function defaultMiddlewares(d: MiddlewareDeps): Record<string, MiddlewareDefinition> {
  const now = d.now ?? (() => Date.now());
  return {
    authentication: defineMiddleware({
      name: "authentication",
      execute(ctx, next) {
        if (d.authentication === "none" || isPublic(ctx.to.meta)) return next();
        const s = d.auth.getState();
        if (s.status === "signed-in") { ctx.set("user", s.user); return next(); }
        return ctx.redirect(loginRedirect(d.loginPath, ctx.to.path, ctx.to.query));
      },
    }),
    authorization: defineMiddleware({
      name: "authorization",
      execute(ctx, next) {
        if (isPublic(ctx.to.meta)) return next();
        // a shell without sign-in has no session, so no visitor can hold a scope: a page that requires scopes is denied, not opened
        if (d.authentication === "none") return ctx.to.scopes.length ? ctx.deny(403, `this application runs without sign-in, and this page requires: ${ctx.to.scopes.join(", ")}`) : next();
        const have = new Set(d.auth.getState().scopes);
        const missing = ctx.to.scopes.filter((s) => !have.has(s));
        if (missing.length) return ctx.deny(403, `missing scope${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
        ctx.set("permissions", [...have]);
        return next();
      },
    }),
    session: defineMiddleware({
      name: "session",
      async execute(ctx, next) {
        if (d.authentication === "none" || isPublic(ctx.to.meta)) return next();
        const s = d.auth.getState();
        if (s.expiresAt !== null && s.expiresAt - now() < 5_000) {
          // one controlled refresh (shared with every concurrent request); if it fails the session is over
          if (!(await d.auth.refresh())) { await d.auth.signOut({ reason: "expired" }); return ctx.redirect(loginRedirect(d.loginPath, ctx.to.path, ctx.to.query)); }
        }
        return next();
      },
    }),
    context: defineMiddleware({
      name: "context",
      execute(ctx, next) {
        const s = d.auth.getState();
        const wanted = ctx.to.query["tenant"];
        if (wanted && s.tenant && wanted !== s.tenant.id) return ctx.deny(403, "the requested tenant is not the tenant of this session");
        const stored = d.getLocale?.();
        const supported = d.locale.supported ?? [d.locale.default];
        ctx.set("locale", stored && supported.includes(stored) ? stored : d.locale.default);
        ctx.set("tenant", s.tenant);
        ctx.set("correlationId", d.correlation?.() ?? globalThis.crypto?.randomUUID?.() ?? String(now()));
        return next();
      },
    }),
    telemetry: defineMiddleware({
      name: "telemetry",
      async execute(ctx, next) {
        const t0 = now();
        const out = await next();
        d.telemetry?.({ type: "navigation", path: ctx.to.path, ...(ctx.to.owner ? { owner: ctx.to.owner } : {}), outcome: out.type, ms: now() - t0, trace: 0 });
        return out;
      },
    }),
  };
}
