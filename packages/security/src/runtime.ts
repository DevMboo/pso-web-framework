import type { IncomingMessage } from "node:http";
import { describeConfig, loadSecurityConfig, type LoadOptions, type SecurityConfig } from "./config.ts";
import { evaluate, describeMissing, isEmptyRequirement, type Decision, type Requirement } from "./authorization.ts";
import { JwtVerifier, type AuthResult } from "./jwt.ts";
import { JwksKeyProvider, PemKeyProvider, type JwksDeps, type KeyProvider } from "./keys.ts";
import { MetricsObserver, type SecurityObserver } from "./observer.ts";
import { SecurityInitError } from "./errors.ts";
import type { Principal } from "./principal.ts";

const GLOBAL = Symbol.for("pso.security.runtime");

/**
 * The initialized security subsystem of one application: validated configuration, key provider, verifier, observer.
 * `bootstrap()` creates it before the HTTP server listens; if it cannot be created the application never becomes ready, and
 * no route is exposed without it. It is registered process-wide so guards created with `JwtGuard.create()` find it.
 */
export class SecurityRuntime {
  readonly config: SecurityConfig;
  readonly observer: SecurityObserver;
  readonly metrics: MetricsObserver;
  private readonly keys: KeyProvider;
  private readonly verifier: JwtVerifier;

  private constructor(config: SecurityConfig, keys: KeyProvider, observer: SecurityObserver, metrics: MetricsObserver) {
    this.config = config; this.keys = keys; this.observer = observer; this.metrics = metrics;
    this.verifier = new JwtVerifier(config.authentication, keys);
  }

  /** Validates the configuration, initializes the key provider (with controlled retries for transient JWKS failures) and registers the runtime. */
  static async initialize(opts: LoadOptions & { deps?: JwksDeps; sink?: (line: string) => void; register?: boolean }): Promise<SecurityRuntime> {
    const config = loadSecurityConfig(opts); // throws SecurityConfigError with every problem found
    const metrics = new MetricsObserver(opts.sink);
    const observer: SecurityObserver = metrics;
    const a = config.authentication;
    const keys: KeyProvider = a.key.kind === "jwks" ? new JwksKeyProvider(a.key, { ...(opts.deps ?? {}), observer }) : new PemKeyProvider(a.key, a.algorithms, { observer });
    await keys.init(); // throws SecurityInitError: the application must not become ready
    const rt = new SecurityRuntime(config, keys, observer, metrics);
    observer.onInit?.({ type: "init", message: `security initialized (${a.key.kind}, ${a.algorithms.join(",")})` });
    if (opts.register !== false) (globalThis as Record<symbol, unknown>)[GLOBAL] = rt;
    return rt;
  }

  /** Authentication: who is calling? Never throws for bad input; failures are classified for logs only. */
  async authenticate(req: IncomingMessage, ctx: { route?: string; correlationId?: string } = {}): Promise<AuthResult> {
    const r = await this.verifier.verifyAuthorization(req.headers["authorization"]);
    if (r.ok) this.observer.onAuth({ type: "authenticated", ...ctx });
    else this.observer.onAuth({ type: "auth_failure", reason: r.reason, ...ctx });
    return r;
  }

  /** Authorization: may this principal do this? Independent of how the principal was established. */
  authorize(principal: Principal, req: Requirement, ctx: { route?: string; correlationId?: string } = {}): Decision {
    if (isEmptyRequirement(req)) return { allowed: true };
    const d = evaluate(principal, req);
    if (!d.allowed) this.observer.onAuth({ type: "authorization_denied", missing: describeMissing(d.missing), ...ctx });
    return d;
  }

  describe(): Record<string, unknown> { return { configuration: describeConfig(this.config), keys: this.keys.describe(), metrics: this.metrics.snapshot() }; }
  close(): void {
    this.keys.close();
    const g = globalThis as Record<symbol, unknown>;
    if (g[GLOBAL] === this) delete g[GLOBAL];
  }
}

export const activeSecurity = (): SecurityRuntime | undefined => (globalThis as Record<symbol, unknown>)[GLOBAL] as SecurityRuntime | undefined;
export { SecurityInitError };
