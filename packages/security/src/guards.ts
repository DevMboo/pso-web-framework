import type { IncomingMessage } from "node:http";
import type { Policy } from "./authorization.ts";
import { activeSecurity } from "./runtime.ts";
import { Principal } from "./principal.ts";

/** What a guard may answer. `{ allow: true, principal }` establishes the identity the framework then authorizes. */
export type GuardOutcome = boolean | { allow: false; status: 401 | 403 } | { allow: true; principal?: Principal };

/** The route information a guard receives (a subset of the framework's route type, kept structural to avoid a package cycle). */
export interface GuardRoute { module: string; method: string; path: string; scopes: readonly string[]; roleSets: readonly (readonly string[])[] }
export type GuardFunction = (req: IncomingMessage, route: GuardRoute) => GuardOutcome | Promise<GuardOutcome>;

export interface JwtGuardOptions {
  /**
   * "authenticated" (default): a valid token is required. A custom policy adds a further restriction after authentication;
   * it can never remove authentication, bypass the framework's route requirements or allow anonymous access.
   */
  policy?: "authenticated" | Policy;
}

/** Marks guards created by the framework: they REQUIRE valid security configuration at startup, unlike custom guards. */
export const FRAMEWORK_GUARD = Symbol.for("pso.security.guard");
export const isFrameworkGuard = (g: unknown): boolean => typeof g === "function" && (g as unknown as Record<symbol, unknown>)[FRAMEWORK_GUARD] === true;

/**
 * Marks a custom authentication guard that carries a provider identity (for audit logs and diagnostics). A project may replace the
 * framework "jwt" guard only by DECLARING it (security.authentication.provider = "custom") AND, in production, by creating it here.
 */
export const CUSTOM_GUARD = Symbol.for("pso.security.customGuard");
export const customGuardProvider = (g: unknown): string | undefined => (typeof g === "function" ? ((g as unknown as Record<symbol, unknown>)[CUSTOM_GUARD] as string | undefined) : undefined);
export const CustomGuard = {
  create(options: { provider: string; verify: GuardFunction }): GuardFunction {
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(options.provider)) throw new Error("CustomGuard.create(): provider must be a lower-case identifier such as corporate-sso");
    if (typeof options.verify !== "function") throw new Error("CustomGuard.create(): verify must be a function");
    const guard: GuardFunction = (req, route) => options.verify(req, route);
    (guard as unknown as Record<symbol, unknown>)[CUSTOM_GUARD] = options.provider;
    return guard;
  },
};

const DENY = { allow: false, status: 401 } as const;
const FORBID = { allow: false, status: 403 } as const;

/** The framework-managed JWT authentication guard. Configuration is resolved and validated by `bootstrap()`, not by the guard. */
export const JwtGuard = {
  create(options: JwtGuardOptions = {}): GuardFunction {
    const policy = typeof options.policy === "function" ? options.policy : undefined;
    if (options.policy !== undefined && options.policy !== "authenticated" && typeof options.policy !== "function") throw new Error(`JwtGuard.create(): unknown policy ${JSON.stringify(options.policy)} (use "authenticated" or a policy function)`);
    const guard: GuardFunction = async (req, route) => {
      const rt = activeSecurity();
      if (!rt) return DENY; // security was not initialized: fail closed
      const r = await rt.authenticate(req, { route: `${route.method} ${route.path}` });
      if (!r.ok) return DENY;
      if (policy) {
        const d = policy(r.principal);
        if (d === false || (typeof d === "object" && !d.allowed)) return FORBID;
      }
      return { allow: true, principal: r.principal };
    };
    Object.defineProperty(guard, FRAMEWORK_GUARD, { value: true });
    return guard;
  },
};
