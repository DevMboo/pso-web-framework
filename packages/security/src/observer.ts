import type { AuthFailure } from "./errors.ts";

export type SecurityEvent =
  | { type: "auth_failure"; reason: AuthFailure; route?: string; correlationId?: string }
  | { type: "authorization_denied"; route?: string; missing: string; correlationId?: string }
  | { type: "authenticated"; route?: string; correlationId?: string }
  | { type: "jwks_refreshed"; reason: string; keys: number }
  | { type: "jwks_refresh_failed"; reason: string; code: string }
  | { type: "key_reloaded"; reason: string; keys: number }
  | { type: "init"; message: string };

/**
 * Observability hook. Events carry classifications and counts only: never tokens, claims, keys or key identifiers' secrets.
 * Reasons for failed authentication are visible here (and in logs) but are never returned to HTTP clients.
 */
export interface SecurityObserver {
  onAuth(e: Extract<SecurityEvent, { type: "auth_failure" | "authenticated" | "authorization_denied" }>): void;
  onJwks(e: Extract<SecurityEvent, { type: "jwks_refreshed" | "jwks_refresh_failed" | "key_reloaded" }>): void;
  onInit?(e: Extract<SecurityEvent, { type: "init" }>): void;
}

export interface MetricsSnapshot { authenticated: number; failures: Record<string, number>; denied: number; jwksRefreshes: number; jwksFailures: number; keyReloads: number }

/** Counts events and writes one structured JSON line per notable event. */
export class MetricsObserver implements SecurityObserver {
  private authenticated = 0; private denied = 0; private jwksRefreshes = 0; private jwksFailures = 0; private keyReloads = 0;
  private failures: Record<string, number> = {};
  private readonly sink: ((line: string) => void) | undefined;
  constructor(sink?: (line: string) => void) { this.sink = sink; }
  private log(level: string, msg: string, extra: Record<string, unknown>): void { this.sink?.(JSON.stringify({ ts: new Date().toISOString(), level, component: "security", msg, ...extra })); }
  onAuth(e: Extract<SecurityEvent, { type: "auth_failure" | "authenticated" | "authorization_denied" }>): void {
    if (e.type === "authenticated") { this.authenticated++; return; }
    if (e.type === "auth_failure") { this.failures[e.reason] = (this.failures[e.reason] ?? 0) + 1; this.log("warn", "authentication failed", { reason: e.reason, route: e.route, correlationId: e.correlationId }); return; }
    this.denied++; this.log("warn", "authorization denied", { missing: e.missing, route: e.route, correlationId: e.correlationId });
  }
  onJwks(e: Extract<SecurityEvent, { type: "jwks_refreshed" | "jwks_refresh_failed" | "key_reloaded" }>): void {
    if (e.type === "jwks_refreshed") this.jwksRefreshes++; else if (e.type === "jwks_refresh_failed") { this.jwksFailures++; this.log("warn", "key refresh failed", { code: e.code, reason: e.reason }); } else this.keyReloads++;
  }
  onInit(e: Extract<SecurityEvent, { type: "init" }>): void { this.log("info", e.message, {}); }
  snapshot(): MetricsSnapshot { return { authenticated: this.authenticated, failures: { ...this.failures }, denied: this.denied, jwksRefreshes: this.jwksRefreshes, jwksFailures: this.jwksFailures, keyReloads: this.keyReloads }; }
}
