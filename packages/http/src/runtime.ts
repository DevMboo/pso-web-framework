import "reflect-metadata";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { detectNodeStructure, nodeLayout, validateModules, type ActiveRoute, type AppComponent, type ModelContext, type ModuleModel } from "@pso/core";
import { JwtGuard, customGuardProvider, readAuthenticationMode, isFrameworkGuard, SecurityConfigError, SecurityInitError, SecurityRuntime, currentPrincipal, evaluate, isEmptyRequirement, runInSecurityContext, setPrincipal, type GuardOutcome, type JwksDeps, type Principal } from "@pso/security";
import { K, readMeta, type ParamBinding } from "./decorators.ts";
import { loadModules } from "./model.ts";
import { loadHttpLimits, type HttpLimits } from "./limits.ts";
import { checkProjectConfig, effectiveEnv } from "./settings.ts";
import { startOtel, type OtelRuntime } from "./otel.ts";
import { DiagnosticsConfigError, OtlpConfigError, Telemetry, loadDiagnostics, loadOtlp, tokenMatches, traceContextFrom, traceparentOf } from "./telemetry.ts";
import { TlsMaterial, UpstreamSecurityError, checkProductionTransport, isLoopbackHost, loadUpstreamPolicy } from "./upstream-security.ts";
import { buildProblem, kindOf, PROBLEM_CONTENT_TYPE } from "./problem.ts";
import { LogConfigError, configureLogging, log } from "./logger.ts";
import { ValidationError, checkDeclaration, fileFieldsOf, validateDto, validateParam, validatorsOf, type FieldValidator } from "./validation.ts";
import { MultipartError, isMultipart, parseMultipart, type ParsedMultipart } from "./multipart.ts";
import { formInput, uploadLimitFor } from "./upload.ts";
import { createRateLimiting, clientAddress, rateHeaders, RateLimitConfigError, type RateDecision } from "./ratelimit.ts";
import { OwnedResources } from "./resources.ts";
import { SecretFilesError, loadSecretFiles } from "./secret-files.ts";
import { Readiness } from "./readiness.ts";
import { HttpError, StartupError, startupDiagnostics } from "./errors.ts";
import { contexts, midstream, rawBodies, runWithRequest } from "./context.ts";
import { send, sendAndClose, sendProblem } from "./responses.ts";
import { isActionResult } from "./results.ts";
import { Upstream, loadUpstreams, type ForwardOptions, type UpstreamTarget } from "./upstream.ts";
import { UpstreamClient, UpstreamCallError, problemKindOf } from "./client.ts";
import { describeError, startupProblems } from "./diagnostics.ts";
import { isLifecycleProvider, type LifecycleHook } from "./lifecycle.ts";
import { healthModule } from "./health.ts";
import { defineDiToken, makeContainer } from "./container.ts";

/*
 * The orchestrator runtime: start-up (bootstrap) and the handling of one request. The parts it is assembled from live next to it:
 *   errors.ts      HttpError, StartupError                      context.ts    the request being handled
 *   responses.ts   Problem Details and JSON answers             upstream.ts   declared upstreams and Upstream (forwarding)
 *   client.ts      UpstreamClient (composition)                 health.ts     the framework-owned /health module
 *   container.ts   dependency injection                         process.ts    signal handling for main.ts
 */

/** A guard answers true/false, {allow:false,status}, or {allow:true, principal} to establish the caller identity the framework then authorizes. */
export type GuardResult = GuardOutcome;
export type Guard = (req: IncomingMessage, route: ActiveRoute) => GuardResult | Promise<GuardResult>;
export type Middleware = (req: IncomingMessage, res: ServerResponse, route: ActiveRoute) => void | Promise<void>;
/** Return true when the error was handled (the response has been written). */
export type Filter = (err: unknown, req: IncomingMessage, res: ServerResponse, route: ActiveRoute) => boolean | Promise<boolean>;
/**
 * Runs around the action of the routes that name it (`interceptors: ["timing"]` in ROUTES.pso.ts), after guards and middleware, in the
 * declared order. `next()` runs the rest of the chain and the action and resolves with its result; the interceptor returns the result
 * to answer with (unchanged, or transformed). An error it throws is handled like an error of the action (filters, Problem Details).
 */
export type Interceptor = (call: { req: IncomingMessage; res: ServerResponse; route: ActiveRoute }, next: () => Promise<unknown>) => unknown | Promise<unknown>;

export { HttpError, StartupError, Upstream, loadUpstreams, type ForwardOptions, type UpstreamTarget };
// the framework's injectable classes keep one instance per application even when a second copy of this package is loaded
defineDiToken(Upstream, "pso.http.Upstream");
defineDiToken(UpstreamClient, "pso.http.UpstreamClient");


// logging lives in logger.ts (pretty/JSON, levels, colours, redaction); re-exported here for existing imports
export { log };


// ---------- named extension points ----------
function loadNamed<T>(dir: string, suffix: string): Map<string, T> {
  const out = new Map<string, T>();
  if (!existsSync(dir)) return out;
  const req = createRequire(join(dir, "noop.js"));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(suffix)).sort()) {
    const mod = req(join(dir, f)) as { default?: T };
    if (typeof mod.default === "function") out.set(f.slice(0, -suffix.length), mod.default);
  }
  return out;
}


// ---------- routing ----------
interface CompiledRoute { route: ActiveRoute; re: RegExp; names: string[]; handler: (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; url: URL }) => Promise<unknown>; httpCode: number }

function compile(path: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const src = path.split("/").map((seg) => (seg.startsWith(":") ? (names.push(seg.slice(1)), "([^/]+)") : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return { re: new RegExp(`^${src}$`), names };
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const declared = req.headers["content-length"] === undefined ? 0 : Number(req.headers["content-length"]);
  if (declared > max) throw new HttpError(413, "payload_too_large"); // refused before reading a byte
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > max) { cleanup(); req.pause(); reject(new HttpError(413, "payload_too_large")); return; } // not destroyed: the 413 can still be written
      chunks.push(c);
    };
    const onEnd = (): void => { cleanup(); resolve(); };
    const onError = (e: Error): void => { cleanup(); reject(e); };
    const onAborted = (): void => { cleanup(); reject(new HttpError(400, "request_aborted")); };
    const cleanup = (): void => { req.off("data", onData); req.off("end", onEnd); req.off("error", onError); req.off("aborted", onAborted); };
    req.on("data", onData); req.on("end", onEnd); req.on("error", onError); req.on("aborted", onAborted);
  });
  const whole = Buffer.concat(chunks);
  rawBodies.set(req, whole);
  if (size === 0) return undefined;
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "unsupported_media_type");
  try { return JSON.parse(whole.toString("utf8")); } catch { throw new HttpError(400, "invalid_json"); }
}

export interface BootstrapOptions {
  /** directory of the COMPILED application (contains routes/, guards/, middlewares/, filters/) */
  appDir: string;
  /** the orchestrator project directory (pso.config.json lives here); defaults to the parent of appDir */
  projectDir?: string;
  workspaceFile?: string;
  port?: number;
  host?: string;
  /** do not listen; return the validated state (used by tests and `pso validate` at runtime) */
  dryRun?: boolean;
  /** test hook: dependencies of the JWKS key provider (resolver, clock) */
  securityDeps?: JwksDeps;
}
export interface App {
  server: Server; routes: ActiveRoute[]; security: SecurityRuntime | undefined; close(): Promise<void>;
  /**
   * The time close() is allowed to take, from the effective configuration: `graceMs` for requests that are already running
   * (http.shutdown.graceMs), `cleanupMs` for releasing the dependents afterwards (http.shutdown.cleanupMs), and their sum plus a
   * small margin as `deadlineMs`: the moment after which whoever owns the process ends it (see shutdownOnSignals).
   */
  shutdown: { graceMs: number; cleanupMs: number; deadlineMs: number };
}


/**
 * Start-up pipeline:
 *   discover modules -> load MODULE/ROUTES -> validate structure and route security (one authority, @pso/core)
 *   -> load and validate security configuration -> initialize key providers (controlled retries) -> build the security pipeline
 *   -> resolve dependencies -> register ONLY the validated routes -> listen.
 * Any validation or security-initialization error aborts start-up: nothing is activated and the process never becomes ready.
 */
/** True when pso.config.json switches dispatch on (so a missing @pso/dispatch is an error, not silence). */
function projectDeclaresDispatch(projectDir: string): boolean {
  try { return (JSON.parse(readFileSync(join(projectDir, "pso.config.json"), "utf8")) as { dispatch?: { enabled?: unknown } }).dispatch?.enabled === true; } catch { return false; }
}

/** the envelope source: the service name (kebab-case) */
/**
 * Inbound TLS (0.2.0). The orchestrator terminates TLS itself when PSO_HTTP_TLS_CERT_FILE and PSO_HTTP_TLS_KEY_FILE name PEM files, so the
 * hop from a reverse proxy (the generated edge gateway) is encrypted too. PSO_HTTP_TLS_CLIENT_CA_FILE additionally requires a client
 * certificate issued by that authority (mutual TLS). One without the other is a configuration error, never a silent fallback to HTTP.
 */
export function inboundTls(env: NodeJS.ProcessEnv): { cert: Buffer; key: Buffer; ca?: Buffer; requestCert?: boolean; rejectUnauthorized?: boolean } | undefined {
  const cert = env["PSO_HTTP_TLS_CERT_FILE"]?.trim(), key = env["PSO_HTTP_TLS_KEY_FILE"]?.trim(), ca = env["PSO_HTTP_TLS_CLIENT_CA_FILE"]?.trim();
  if (!cert && !key && !ca) return undefined;
  if (!cert || !key) throw new StartupError("PSO_HTTP_TLS_CERT_FILE and PSO_HTTP_TLS_KEY_FILE must be set together (inbound TLS)\nnothing was started", startupDiagnostics([{ code: "PSO_HTTP_TLS_CONFIG", message: "inbound TLS needs both a certificate and its key" }]));
  const read = (name: string, file: string): Buffer => { try { return readFileSync(file); } catch (e) { throw new StartupError(`${name} (${file}) cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}\nnothing was started`, startupDiagnostics([{ code: "PSO_HTTP_TLS_CONFIG", message: `${name} is not readable` }])); } };
  return { cert: read("PSO_HTTP_TLS_CERT_FILE", cert), key: read("PSO_HTTP_TLS_KEY_FILE", key), ...(ca ? { ca: read("PSO_HTTP_TLS_CLIENT_CA_FILE", ca), requestCert: true, rejectUnauthorized: true } : {}) };
}

function serviceName(projectDir: string, env: NodeJS.ProcessEnv): string {
  const raw = env["PSO_SERVICE"] ?? basename(projectDir);
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orchestrator";
}

/** The security runtime emits JSON lines; they go through the same logger (format, level, colour, redaction) as everything else. */
function forwardSecurityLog(line: string): void {
  try { const { ts: _ts, level, msg, ...rest } = JSON.parse(line) as { ts?: string; level?: string; msg?: string } & Record<string, unknown>; log(level ?? "info", msg ?? "", rest); }
  catch { log("info", line.slice(0, 500), { component: "security" }); }
}

export async function bootstrap(opts: BootstrapOptions): Promise<App> {
  // everything start-up acquires is owned here: a failure at ANY later step releases what was already acquired (newest first),
  // so a failed start never leaves a listener, a consumer, a connection or a timer behind and never reports readiness
  const owned = new OwnedResources();
  try { return await start(opts, owned); }
  catch (e) {
    const pending = owned.pending;
    if (pending.length) {
      const failed = await owned.releaseAll();
      log(failed.length ? "warn" : "info", "start-up failed: acquired resources were released", { component: "lifecycle", released: pending.filter((n) => !failed.includes(n)), ...(failed.length ? { notReleased: failed } : {}) });
    }
    throw e;
  }
}

async function start(opts: BootstrapOptions, owned: OwnedResources): Promise<App> {
  const env = process.env;
  // secrets mounted as files by the container topology become variables first, so every setting below reads them like any other variable
  let secretFiles: ReturnType<typeof loadSecretFiles>;
  try { secretFiles = loadSecretFiles(env); }
  catch (e) { const problems = e instanceof SecretFilesError ? e.problems : [(e as Error).message]; throw new StartupError(`${(e as Error).message}\nnothing was started`, startupDiagnostics(problems.map((message) => ({ code: "PSO_SECRET_FILES", message })))); }
  const port = opts.port ?? Number(env["PORT"] ?? 3000);
  const host = opts.host ?? env["HOST"] ?? "127.0.0.1";
  const projectDir = opts.projectDir ?? resolve(opts.appDir, "..");
  // one precedence for every HTTP setting: variable > PSO_CFG_* > pso.config.<env>.json > pso.config.json > defaults
  let eff: NodeJS.ProcessEnv;
  let limits: HttpLimits;
  let logCfg: ReturnType<typeof configureLogging>;
  let cfgCheck: ReturnType<typeof checkProjectConfig>;
  try { eff = effectiveEnv(env, projectDir); limits = loadHttpLimits(eff); logCfg = configureLogging(eff); cfgCheck = checkProjectConfig(env, projectDir); }
  catch (e) { throw new StartupError(`${(e as Error).message}\nnothing was started`, []); }
  void LogConfigError;
  // a misspelled key is never silently ignored: strict validation (production) refused it above; elsewhere it is reported on every start
  for (const w of cfgCheck.warnings) log("warn", "unknown configuration key ignored", { component: "config", code: w.code, detail: w.message, source: w.file, ...(/^Did you mean/.test(w.hint ?? "") ? { hint: `${w.hint!.split("?")[0]}?` } : {}) });
  log("info", "starting orchestrator", { component: "startup", service: serviceName(projectDir, env), environment: env["PSO_ENV"] ?? env["NODE_ENV"] ?? "development", logLevel: logCfg.level, logFormat: logCfg.format, node: process.version });
  if (secretFiles.loaded.length || secretFiles.kept.length) log("info", "secret variables read from files", { component: "startup", loaded: secretFiles.loaded, ...(secretFiles.kept.length ? { keptFromEnvironment: secretFiles.kept } : {}) });
  const maxBody = limits.maxBodyBytes;
  Upstream.services = loadUpstreams(opts.workspaceFile ?? env["PSO_WORKSPACE"], env);
  {
    const problems: string[] = [];
    for (const [name, t] of Upstream.services) {
      const policy = loadUpstreamPolicy(name, env, projectDir, problems);
      checkProductionTransport(name, t.host, policy, env, problems);
      t.policy = policy;
      if (policy.tls) {
        try {
          const m = new TlsMaterial(policy.tls, t.host); m.init(); t.material = m;
          if (m.daysLeft !== undefined && m.daysLeft < 30) log("warn", "a TLS certificate configured for this upstream expires soon", { component: "security", service: name, daysLeft: m.daysLeft });
        }
        catch (e) { problems.push(`${name}: ${(e as Error).message}`); }
      }
      const plaintext = !policy.tls && !isLoopbackHost(t.host);
      log("info", "upstream configured", { service: name, tls: !!policy.tls, mutualTls: !!(policy.tls?.certFile), forward: policy.forward, audienceBound: !!policy.audience, ...(plaintext ? { plaintext: true } : {}) });
      // an explicit plaintext authorization is honoured, never silent: the hop is not encrypted and the user's bearer token is not sent over it
      if (plaintext && policy.allowPlaintext && (env["PSO_ENV"] ?? env["NODE_ENV"]) === "production") log("warn", "upstream is reached over plain HTTP because allowPlaintext is set for it: the connection is not encrypted and the caller's bearer token is not forwarded on it", { component: "security", service: name, host: t.host });
    }
    if (problems.length) throw new StartupError(`${new UpstreamSecurityError(problems).message}\nnothing was started`, []);
  }
  Upstream.limits = limits;

  // the application structure of the build: modular (.app + modules, 0.2.0) or legacy (src/routes, 0.1); never both
  const structure = detectNodeStructure(opts.appDir);
  if (structure.problems.length) throw new StartupError(`${structure.problems.join("\n")}\nnothing was started`, startupDiagnostics(structure.problems.map((m) => ({ code: "PSO_STRUCTURE_MIXED", message: m }))));
  const layout = nodeLayout(structure.structure);
  const modulesRoot = join(opts.appDir, ...layout.modulesDir.split("/"));
  /** application-wide components of one kind plus the module-local ones (modules/<m>/<kind>/): one namespace per kind */
  const loadKind = <T>(kind: AppComponent, suffix: string, what: string): Map<string, T> => {
    const all = loadNamed<T>(join(opts.appDir, ...layout.component(kind).split("/")), suffix);
    const local = layout.moduleDir(kind as "guards");
    if (local && existsSync(modulesRoot)) {
      for (const d of readdirSync(modulesRoot).sort()) {
        for (const [n, g] of loadNamed<T>(join(modulesRoot, d, ...local.split("/")), suffix)) {
          if (all.has(n)) throw new StartupError(`${what} "${n}" is defined more than once`, []);
          all.set(n, g);
        }
      }
    }
    return all;
  };
  const guards = loadKind<Guard>("guards", ".guard.js", "guard");
  // The framework provides the "jwt" authentication guard. A project jwt.guard.* may replace it ONLY when that is declared
  // (security.authentication.provider = "custom"); a file that merely exists never changes how requests are authenticated.
  const environment = env["PSO_ENV"] ?? env["NODE_ENV"] ?? "development";
  const mode = readAuthenticationMode(projectDir, env, env["PSO_ENV"] ?? "development");
  if (mode.issues.length) {
    for (const i of mode.issues) log("error", "authentication configuration invalid", { code: i.code, detail: i.message });
    throw new StartupError("authentication configuration is invalid; the application did not start and no route is active", startupDiagnostics(mode.issues));
  }
  // An unexpected error is always logged with its type, a stable code and the place in the code it came from. Its message and stack
  // are logged only when logging.errorDetails (PSO_LOG_ERROR_DETAILS) asks for them, which `pso dev` does: a message can quote request
  // data, so the default keeps it out of the log and production never records it, whatever the setting says.
  const detailsRequested = /^(true|1|yes)$/i.test((eff["PSO_LOG_ERROR_DETAILS"] ?? "").trim());
  const errorDetails = detailsRequested && environment !== "production";
  if (detailsRequested && !errorDetails) log("warn", "logging.errorDetails is ignored in production: the messages and stacks of unexpected errors are not logged", { component: "config" });
  const projectGuard = guards.get("jwt");
  const customJwt = projectGuard !== undefined && !isFrameworkGuard(projectGuard);
  if (customJwt && mode.provider !== "custom") {
    const d = [{ code: "PSO_SEC_CUSTOM_GUARD_UNDECLARED", message: 'a project jwt guard replaces the framework authentication but security.authentication.provider is not "custom". Declare it explicitly (and name it with customProvider), or use JwtGuard.create()' }];
    log("error", "custom jwt guard is not declared", { code: d[0]!.code });
    throw new StartupError("security initialization failed: an undeclared custom jwt guard was found; the application did not start and no route is active", startupDiagnostics(d));
  }
  if (mode.provider === "custom" && !customJwt) {
    const d = [{ code: "PSO_SEC_CUSTOM_GUARD_MISSING", message: 'security.authentication.provider is "custom" but no custom jwt guard was found in guards/ (jwt.guard.ts must export a guard that is not JwtGuard.create()); refusing to fall back silently' }];
    log("error", "custom authentication declared but no custom guard exists", { code: d[0]!.code });
    throw new StartupError("security initialization failed: custom authentication is declared but missing; the application did not start and no route is active", startupDiagnostics(d));
  }
  if (customJwt) {
    const identity = customGuardProvider(projectGuard);
    if (environment === "production" && !identity) {
      const d = [{ code: "PSO_SEC_CUSTOM_GUARD_UNIDENTIFIED", message: "in production a custom guard must be created with CustomGuard.create({ provider, verify }) so the authentication provider is identifiable and auditable" }];
      log("error", "custom guard has no provider identity", { code: d[0]!.code });
      throw new StartupError("security initialization failed: unidentified custom guard in production; the application did not start and no route is active", startupDiagnostics(d));
    }
    if (identity && mode.customProvider && identity !== mode.customProvider) {
      const d = [{ code: "PSO_SEC_CUSTOM_GUARD_MISMATCH", message: `the custom guard identifies as "${identity}" but security.authentication.customProvider is "${mode.customProvider}"` }];
      throw new StartupError("security initialization failed: custom guard identity mismatch; the application did not start and no route is active", startupDiagnostics(d));
    }
    log("warn", "custom authentication is active: the framework JWT guard is replaced", { provider: identity ?? mode.customProvider ?? "unidentified", environment });
  } else guards.set("jwt", JwtGuard.create());
  const middleware = loadKind<Middleware>("middlewares", ".middleware.js", "middleware");
  const filters = loadKind<Filter>("filters", ".filter.js", "filter");
  const interceptors = loadKind<Interceptor>("interceptors", ".interceptor.js", "interceptor");

  const telemetry = new Telemetry(serviceName(projectDir, env));
  const readinessMs = (name: string, def: number, lo: number, hi: number): number => {
    const raw = eff[name];
    if (raw === undefined || raw.trim() === "") return def;
    if (!/^\d+$/.test(raw.trim()) || Number(raw) < lo || Number(raw) > hi) throw new StartupError(`${name} must be a whole number between ${lo} and ${hi}\nnothing was started`, []);
    return Number(raw);
  };
  const readiness = new Readiness({
    intervalMs: readinessMs("PSO_READINESS_INTERVAL_MS", 5000, 250, 300_000), timeoutMs: readinessMs("PSO_READINESS_TIMEOUT_MS", 2000, 50, 60_000),
    state: () => telemetry.state,
    onChange: (name, r) => log(r.status === "UP" ? "info" : r.required ? "error" : "warn", r.status === "UP" ? "dependency available" : "dependency unavailable", { component: "readiness", dependency: name, required: r.required, ...(r.detail ? { detail: r.detail } : {}) }),
  });
  const modules = [healthModule(() => readiness.report()), ...loadModules(modulesRoot, { routesFile: layout.routesFile, label: layout.modulesDir })];
  for (const m of modules) for (const f of m.ignoredControllerFiles) {
    const file = f.split("/").pop()!;
    // kebab-case files (cart-item.controller.js) declare PascalCase classes (CartItemController): compare letters and digits only
    const declared = m.model.controllers.some((c) => file.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(c.replace(/Controller$/, "").toLowerCase().replace(/[^a-z0-9]/g, "")));
    if (!declared && m.model.hasModule) log("warn", "controller file ignored: it is not declared in MODULE.pso.ts", { file: f });
  }
  const ctx: ModelContext = { guards: new Set(guards.keys()), middleware: new Set(middleware.keys()), filters: new Set(filters.keys()), interceptors: new Set(interceptors.keys()), builtins: new Set(["Upstream", "UpstreamClient", "Dispatch", "ChannelPublisher"]), defaultGuard: "jwt" };
  const verdict = validateModules(modules.map((m) => m.model as ModuleModel), ctx);
  if (!verdict.ok) {
    for (const d of verdict.diagnostics) log("error", d.message.split("\n")[0]!, { code: d.code, file: d.file, detail: d.message });
    throw new StartupError(`route validation failed (${verdict.diagnostics.length} diagnostic(s)); no route was activated`, verdict.diagnostics);
  }
  // routes bound to a service that is not registered (an orchestrator generated before its microservice): the rest of the application
  // starts; those routes answer 502 "upstream not configured" until the service exists. Said once per service, with the way out.
  {
    const missing = new Map<string, string[]>();
    for (const r of verdict.routes) for (const name of [...(r.service ? [r.service] : []), ...(r.services ?? [])]) if (!Upstream.services.has(name)) missing.set(name, [...(missing.get(name) ?? []), `${r.method} ${r.path}`]);
    for (const [name, routes] of missing) log("warn", "routes call a service that is not registered: they answer 502 until it is", { component: "upstream", service: name, routes, hint: `register it (pso create service ${name}) or bind the module to another service (pso crud:bind <module> --to <service>)` });
  }

  // ---- security: configuration, key providers, pipeline (before anything listens) ----
  let sec: SecurityRuntime | undefined;
  const channelModules = modules.filter((m) => ((m.def as { channels?: readonly unknown[] } | undefined)?.channels?.length ?? 0) > 0);
  if (verdict.routes.some((r) => r.guards.includes("jwt")) || channelModules.length > 0) {
    try {
      sec = await SecurityRuntime.initialize({ projectDir, env, sink: forwardSecurityLog, ...(opts.securityDeps ? { deps: opts.securityDeps } : {}) });
    } catch (e) {
      const notConfigured = e instanceof SecurityConfigError && e.issues.every((i) => i.code === "PSO_SEC_MISSING");
      if (customJwt && notConfigured) log("info", "custom jwt guard in use; framework security configuration not present");
      else {
        const issues = e instanceof SecurityConfigError ? e.issues : [{ code: e instanceof SecurityInitError ? "PSO_SEC_INIT" : "PSO_SEC_ERROR", message: (e as Error).message }];
        for (const i of issues) log("error", "security initialization failed", { code: i.code, detail: i.message });
        throw new StartupError("security initialization failed; the application did not start and no route is active", startupDiagnostics(issues));
      }
    }
    if (sec) { const s = sec; owned.add("security", () => s.close()); }
  }
  Upstream.credentials = sec?.config.propagation.forward ?? (env["PSO_FORWARD_CREDENTIALS"] === "none" ? "none" : "bearer");

  // ---- dispatch (optional): only when the project has dispatch modules or dispatch is switched on; absent otherwise ----
  type DispatchMod = { Dispatch: new (...a: never[]) => unknown; prepareDispatch(o: Record<string, unknown>): Promise<{ dispatch: unknown; runtime?: unknown; start(resolve?: (c: never) => unknown): Promise<void>; stop(): Promise<void> }> };
  let dispatchStarted: Awaited<ReturnType<DispatchMod["prepareDispatch"]>> | undefined;
  let dispatchClass: unknown;
  if (existsSync(join(opts.appDir, "dispatch")) || env["PSO_DISPATCH_ENABLED"] === "true" || projectDeclaresDispatch(projectDir)) {
    let mod: DispatchMod;
    try { mod = (await import("@pso/dispatch")) as unknown as DispatchMod; }
    catch { throw new StartupError("dispatch is configured but @pso/dispatch is not installed; run `pso dispatch:install <redis|rabbitmq|kafka>`", []); }
    try {
      dispatchStarted = await mod.prepareDispatch({ appDir: opts.appDir, projectDir, source: serviceName(projectDir, env), env, log });
      dispatchClass = mod.Dispatch;
      const d = dispatchStarted;
      owned.add("dispatch", () => d.stop());
    } catch (e) {
      const p = startupProblems(e);
      log("error", "dispatch initialization failed", { component: "dispatch", ...(p.code ? { code: p.code } : {}), detail: p.summary, problems: p.problems, ...(p.issues.length ? { properties: p.issues.flatMap((i) => (i.key ? [i.key] : [])) } : {}) });
      throw new StartupError(`dispatch initialization failed: ${p.text}\nthe application did not start`, startupDiagnostics(p.issues.length ? p.issues.map((i) => ({ code: i.code, message: `${i.key ? `${i.key}: ` : ""}${i.message}` })) : p.problems.map((m) => ({ code: p.code ?? "PSO_DISPATCH_CONFIG", message: m }))));
    }
  }

  // ---- channels (optional): only when a module registers channel classes; the package is loaded on demand, like dispatch ----
  type ChannelsMod = {
    ChannelRegistry: new () => { add(module: string, classes: readonly Function[]): string[]; channels: unknown[] };
    ChannelPublisher: new () => unknown;
    loadChannelsConfig(projectDir: string, env: NodeJS.ProcessEnv): { enabled: boolean; path: string; [k: string]: unknown };
    attachChannels(o: Record<string, unknown>): Promise<{ hub: { metrics(): Record<string, unknown> }; health?: () => Promise<{ status: string; detail?: string }>; close(): Promise<void> }>;
  };
  let channelsMod: ChannelsMod | undefined;
  let channelsCfg: ReturnType<ChannelsMod["loadChannelsConfig"]> | undefined;
  let registry: { add(module: string, classes: readonly Function[]): string[]; channels: unknown[] } | undefined;
  if (channelModules.length > 0) {
    try { const spec = "@pso/channels"; /* a variable specifier: no compile-time cycle with the optional package */ channelsMod = (await import(spec)) as unknown as ChannelsMod; }
    catch { throw new StartupError("a module registers channels but @pso/channels is not installed; add the package to the orchestrator's dependencies\nnothing was started", []); }
    try { channelsCfg = channelsMod.loadChannelsConfig(projectDir, eff); }
    catch (e) { log("error", "channels configuration invalid", { detail: (e as Error).message.split("\n")[0] }); throw new StartupError(`${(e as Error).message}\nnothing was started`, []); }
    if (channelsCfg.enabled) {
      registry = new channelsMod.ChannelRegistry();
      const problems = channelModules.flatMap((m) => registry!.add(m.model.dir, (m.def as unknown as { channels: readonly Function[] }).channels));
      if (problems.length) { for (const p of problems) log("error", "channel declaration invalid", { detail: p }); throw new StartupError(`channel declarations are invalid; nothing was started:\n - ${problems.join("\n - ")}`, startupDiagnostics(problems.map((m) => ({ code: "PSO_CHANNEL_INVALID", message: m })))); }
    }
  }
  const upstream = new Upstream();
  const resolveDep = makeContainer([[Upstream, upstream], [UpstreamClient, new UpstreamClient()], ...(dispatchStarted && dispatchClass ? [[dispatchClass, dispatchStarted.dispatch] as [unknown, unknown]] : []), ...(channelsMod && channelsCfg?.enabled ? [[channelsMod.ChannelPublisher, new channelsMod.ChannelPublisher()] as [unknown, unknown]] : [])]);
  let uploadsInFlight = 0;
  /** multipart binding: parse (streaming, bounded), attach the files, then validate the whole DTO */
  const bindUpload = async (req: IncomingMessage, res: ServerResponse, dto: new () => unknown): Promise<unknown> => {
    if (!isMultipart(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "unsupported_media_type");
    if (limits.maxConcurrentUploads > 0 && uploadsInFlight >= limits.maxConcurrentUploads) { res.setHeader("retry-after", "1"); throw new HttpError(503, "server_busy"); }
    uploadsInFlight++;
    let released = false;
    const release = (): void => { if (!released) { released = true; uploadsInFlight--; } };
    if (res.closed) release(); else res.once("close", release);
    const specs = fileFieldsOf(dto);
    let parsed: ParsedMultipart;
    try {
      parsed = await parseMultipart(req, {
        limits: { maxTotalBytes: uploadLimitFor(dto, limits), maxFieldBytes: limits.maxBodyBytes, maxParts: limits.maxMultipartParts, maxHeaderBytes: 8192 },
        acceptFile: (name) => { const s = specs.get(name); return s ? { maxSize: s.maxSize, maxFiles: s.maxFiles } : undefined; },
      });
    } catch (e) {
      if (!(e instanceof MultipartError)) throw e;
      if (e.failure !== "aborted") midstream.add(req);
      log("warn", "upload refused", { correlationId: contexts.get(req)?.correlationId, reason: e.failure });
      switch (e.failure) {
        case "malformed": throw new HttpError(400, "malformed_multipart");
        case "file_too_large": throw new HttpError(413, "file_too_large");
        case "too_large": case "too_many_parts": throw new HttpError(413, "payload_too_large");
        case "too_many_files": throw new ValidationError([{ ...(e.field ? { field: e.field } : {}), message: "has more files than allowed" }]);
        default: throw new HttpError(400, "request_aborted");
      }
    }
    // temporary files live exactly as long as the response: removed on success, on every error and when the client disconnects
    const cleanup = (): void => { void parsed.dispose(); };
    if (res.closed) cleanup(); else res.once("close", cleanup);
    log("debug", "upload received", { correlationId: contexts.get(req)?.correlationId, files: [...parsed.files.values()].reduce((n, l) => n + l.length, 0), fields: parsed.fields.size });
    return validateDto(dto, formInput(dto, parsed), resolveValidator);
  };
  const compiled: CompiledRoute[] = [];
  const validatorInstances = new Map<unknown, FieldValidator>();
  const resolveValidator = (v: new (...a: never[]) => FieldValidator): FieldValidator => {
    const found = validatorInstances.get(v);
    if (!found) throw new Error(`validator ${v.name} was not registered at start-up`); // unreachable: start-up refuses unregistered validators
    return found;
  };
  for (const route of verdict.routes) {
    const mod = modules.find((m) => m.model.dir === route.module)!;
    const cls = (mod.def!.controllers as Array<new (...a: never[]) => unknown>).find((c) => c.name === route.controller)!;
    for (const p of (mod.def!.providers ?? []) as Array<new (...a: never[]) => unknown>) resolveDep(p);
    const instance = resolveDep(cls) as Record<string, (...a: unknown[]) => unknown>;
    const params = readMeta<ParamBinding[]>(K.params, Object.getPrototypeOf(instance), route.action) ?? [];
    for (const pb of params) if (pb.dto) {
      const dtoCls = pb.dto as new () => unknown;
      const bad = checkDeclaration(dtoCls);
      if (bad.length) { log("error", "DTO declaration invalid", { route: `${route.method} ${route.path}`, problems: bad.length }); throw new StartupError(`${route.method} ${route.path}: invalid DTO declaration\n  - ${bad.join("\n  - ")}\nnothing was started`, startupDiagnostics(bad.map((m) => ({ code: "PSO_DTO_INVALID", message: m })))); }
      const registered = new Set((mod.def!.providers ?? []) as unknown[]);
      for (const vc of validatorsOf(dtoCls)) {
        if (!registered.has(vc)) throw new StartupError(`${route.method} ${route.path}: validator ${vc.name} must be listed in the providers of module "${mod.model.dir}"\nnothing was started`, startupDiagnostics([{ code: "PSO_DTO_VALIDATOR_UNREGISTERED", message: `validator ${vc.name} is not a registered provider` }]));
        if (!validatorInstances.has(vc)) validatorInstances.set(vc, resolveDep(vc) as FieldValidator);
      }
    }
    const { re, names } = compile(route.path);
    compiled.push({
      route, re, names, httpCode: route.method === "POST" ? 201 : 200,
      handler: async ({ req, res, params: pv, url }) => {
        const args: unknown[] = [];
        const problems: Array<{ field?: string; message: string }> = [];
        let truncated = false;
        for (const p of params) {
          if (p.kind === "param" || p.kind === "query") {
            const raw = p.kind === "param" ? pv[p.name!] : url.searchParams.get(p.name!) ?? undefined;
            if (!p.spec) { args[p.index] = raw; continue; }
            const r = validateParam(`${p.kind === "param" ? "path" : "query"}.${p.name}`, raw, p.spec, p.kind === "param");
            problems.push(...r.errors); args[p.index] = r.value;
          } else if (p.kind === "body") {
            if (p.dto && fileFieldsOf(p.dto as new () => unknown).size > 0) {
              try { args[p.index] = await bindUpload(req, res, p.dto as new () => unknown); }
              catch (e) { if (e instanceof ValidationError) { problems.push(...e.errors); truncated ||= e.truncated; } else throw e; }
              continue;
            }
            const json = await readJson(req, maxBody);
            if (!p.dto) { args[p.index] = json; continue; }
            if (json === undefined) { problems.push({ message: "a JSON request body is required" }); continue; }
            try { args[p.index] = await validateDto(p.dto as new () => unknown, json, resolveValidator); }
            catch (e) { if (e instanceof ValidationError) { problems.push(...e.errors); truncated ||= e.truncated; } else throw e; }
          } else args[p.index] = p.kind === "req" ? req : p.kind === "res" ? res : currentPrincipal();
        }
        if (problems.length > 0) throw new ValidationError(problems, truncated); // the action is never called with invalid input
        return instance[route.action]!.apply(instance, args);
      },
    });
  }
  // matching: a literal segment wins over a parameter at the same position (/products/options before /products/:id), whatever order
  // the registry lists them in (the model sorts by path, where ":" sorts first); otherwise the registry order is kept
  const literalFirst = (a: string, b: string): number => {
    const x = a.split("/"), y = b.split("/");
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const px = x[i]!.startsWith(":"), py = y[i]!.startsWith(":");
      if (px !== py) return px ? 1 : -1;
    }
    return 0;
  };
  const matchOrder = compiled.map((c, i) => ({ c, i })).sort((a, b) => literalFirst(a.c.route.path, b.c.route.path) || a.i - b.i).map((x) => x.c);

  // rate limiting: local (default) or shared through Redis when explicitly configured; validated before anything listens
  let rl: Awaited<ReturnType<typeof createRateLimiting>>;
  try { rl = await createRateLimiting(eff, projectDir); }
  catch (e) {
    const detail = e instanceof RateLimitConfigError ? e.message : `rate limiting could not start: ${(e as Error).message.split("\n")[0]}`;
    log("error", "rate limiting initialization failed", { detail: detail.split("\n")[0] });
    throw new StartupError(`${detail}\nnothing was started`, []);
  }
  owned.add("rate-limit", () => rl.close());
  const rateRefusal = (res: ServerResponse, req: IncomingMessage, d: RateDecision, correlationId: string): void => {
    for (const [k, v] of Object.entries(rateHeaders(d))) res.setHeader(k, v);
    if (d.backendFailed) { res.setHeader("retry-after", "1"); sendProblem(res, req, "rate_limit_unavailable", correlationId); } // fail-closed policy and the shared backend is down
    else sendProblem(res, req, "too_many_requests", correlationId);
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = process.hrtime.bigint();
    const startedAtMs = Date.now();
    const incoming = req.headers["x-correlation-id"];
    const correlationId = typeof incoming === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID(); // same rule as the Spring filter: a malformed id is replaced, never echoed
    const url = new URL(req.url ?? "/", "http://localhost");
    // diagnostics: exists only with a strong token, answers only a caller presenting it, and is not counted in the metrics it reports
    if (url.pathname === "/_pso/telemetry" && req.method === "GET" && diag.token) {
      if (!tokenMatches(req.headers["authorization"], diag.token)) { sendProblem(res, req, "unauthorized", correlationId); return; }
      send(res, 200, telemetry.snapshot(), correlationId);
      return;
    }
    const trace = traceContextFrom(req.headers["traceparent"]);
    res.setHeader("traceparent", traceparentOf(trace));
    let route: ActiveRoute | undefined;
    telemetry.requestStarted();
    // recorded when the connection closes: covers every exit path, including a client that went away (status 499, never a fake 200)
    res.once("close", () => telemetry.requestFinished({ method: req.method ?? "GET", route: route ? route.path : "unmatched", status: res.writableFinished ? res.statusCode : 499, seconds: Number(process.hrtime.bigint() - started) / 1e9, trace, startedAtMs, correlationId }));
    const finish = (status: number) => log("info", "request", { correlationId, traceId: trace.traceId, method: req.method, path: url.pathname, status, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    try {
      const isHealth = url.pathname === "/health/live" || url.pathname === "/health/ready";
      const ip = clientAddress(req, rl.trusted); // X-Forwarded-For counts only when the TCP peer is a configured trusted proxy
      if (!isHealth && rl.limiter && rl.config.enabled) {
        const d = await rl.limiter.check(`ip:${ip}`, rl.config.policy);
        if (!d.allowed) { rateRefusal(res, req, d, correlationId); return finish(res.statusCode); }
        if (d.remaining >= 0) { res.setHeader("ratelimit-limit", String(d.limit)); res.setHeader("ratelimit-remaining", String(d.remaining)); }
      }
      let params: Record<string, string> = {};
      const hit = matchOrder.find((c) => {
        if (c.route.method !== req.method) return false;
        const m = c.re.exec(url.pathname);
        if (!m) return false;
        try { params = Object.fromEntries(c.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])); } catch { return false; }
        return true;
      });
      if (!hit) { sendProblem(res, req, "not_found", correlationId); return finish(404); } // undeclared == nonexistent
      route = hit.route;
      const requestContext = { correlationId, route, trace };
      contexts.set(req, requestContext);
      const deny = (status: 401 | 403): void => { sendProblem(res, req, status === 403 ? "forbidden" : "unauthorized", correlationId); finish(status); };

      // authentication: guards establish WHO is calling
      let principal: Principal | undefined;
      for (const g of route.guards) {
        const r = await guards.get(g)!(req, route);
        if (r === true) continue;
        if (r === false) return deny(401);
        if (!r.allow) return deny(r.status);
        if (r.principal) { principal ??= r.principal; setPrincipal(r.principal); }
      }
      // authorization: separate from authentication; requirements only ever add up (module, controller, action, route)
      const need = { scopes: route.scopes, roleSets: route.roleSets };
      if (!isEmptyRequirement(need)) {
        const label = `${route.method} ${route.path}`;
        if (!principal) { log("warn", "authorization denied: requirements declared but no guard established an identity", { route: label, correlationId }); return deny(403); }
        const d = sec ? sec.authorize(principal, need, { route: label, correlationId }) : evaluate(principal, need);
        if (!d.allowed) return deny(403);
      }
      // per-route and per-principal limits: the identity is known now (guards ran), so one caller cannot exhaust another's budget
      if (rl.limiter) {
        const routeKey = `${route.method} ${route.path}`;
        const rp = rl.config.routes.get(routeKey);
        if (rp || (principal && rl.config.perPrincipal && rl.config.enabled)) {
          const id = principal ? `p:${principal.subject}` : `ip:${ip}`;
          const d = await rl.limiter.check(`${rp ? `r:${routeKey}` : "pr"}:${id}`, rp ?? rl.config.policy);
          if (!d.allowed) { rateRefusal(res, req, d, correlationId); return finish(res.statusCode); }
        }
      }
      for (const m of route.middleware) { await middleware.get(m)!(req, res, route); if (res.writableEnded) return finish(res.statusCode); }

      // the action runs with its request as the current one: UpstreamClient reads the correlation id, the trace and the declared services from it
      const action = (): Promise<unknown> => hit.handler({ req, res, params, url });
      // interceptors wrap the action in the declared order: the first one named is the outermost
      const active = route;
      const chain = active.interceptors.reduceRight<() => Promise<unknown>>((next, name) => async () => interceptors.get(name)!({ req, res, route: active }, next), action);
      const result = await runWithRequest({ ...requestContext, req, res }, chain);
      if (!res.headersSent) {
        if (isActionResult(result)) send(res, result.status, result.body === undefined ? null : result.body, correlationId, result.headers);
        else send(res, hit.httpCode, result === undefined ? null : result, correlationId);
      }
      finish(res.statusCode);
    } catch (err) {
      let handled = false;
      for (const f of route?.filters ?? []) { if (await filters.get(f)!(err, req, res, route!)) { handled = true; break; } }
      if (!handled) {
        const status = err instanceof HttpError ? err.status : 500;
        const answer = midstream.has(req) ? sendAndClose : sendProblem; // an abandoned upload body is drained (bounded) before closing
        if (err instanceof ValidationError) answer(res, req, "validation_failed", correlationId, 400, { errors: err.truncated ? [...err.errors, { message: "more errors were found and are not listed" }] : err.errors });
        else if (status === 413) sendAndClose(res, req, err instanceof HttpError && kindOf(err.message) ? err.message : "payload_too_large", correlationId);
        else if (err instanceof HttpError) answer(res, req, err.message, correlationId, status, { ...(err.detail ? { detail: err.detail } : {}), ...(err.errors?.length ? { errors: err.errors } : {}) }); // application-raised: its message (and detail) is intentionally exposed
        else if (err instanceof UpstreamCallError) {
          // a call the action made to a service failed and the action did not handle it: a stable problem, never the service's body
          const kind = problemKindOf(err);
          log(kind === "upstream_policy" ? "error" : "warn", "an upstream call failed and the action did not handle it", { component: route ? `${route.controller}.${route.action}` : "request", correlationId, traceId: trace.traceId, route: route ? `${route.method} ${route.path}` : undefined, service: err.service, reason: err.kind, ...(err.status !== undefined ? { upstreamStatus: err.status } : {}), ...(err.kind === "policy" ? { detail: err.message } : {}), problem: kind });
          answer(res, req, kind, correlationId);
        } else {
          // The client always gets the same sanitized answer. The log says what failed and where: the error type, a stable code and
          // the place in the code in every environment; the message and the stack as well outside production (both pass through the
          // redaction of the logger). A message can carry request data, which is why production does not record it.
          log("error", "unhandled error in a request", { component: route ? `${route.controller}.${route.action}` : "request", correlationId, traceId: trace.traceId, route: route ? `${route.method} ${route.path}` : undefined, ...describeError(err, errorDetails) });
          sendProblem(res, req, "internal_error", correlationId);
        }
      }
      finish(res.statusCode || 500);
    }
  };
  // every request runs in its own security context: identities cannot leak between concurrent requests
  Upstream.telemetry = telemetry;
  let diag: ReturnType<typeof loadDiagnostics>;
  let otlp: ReturnType<typeof loadOtlp>;
  try { diag = loadDiagnostics(eff); otlp = loadOtlp(env, telemetry.service); }
  catch (e) {
    if (!(e instanceof DiagnosticsConfigError || e instanceof OtlpConfigError)) throw e;
    log("error", "telemetry configuration invalid", { detail: e.message });
    throw new StartupError(`${e.message}\nnothing was started`, []);
  }
  telemetry.externals.rateLimit = () => (rl.limiter ? { provider: rl.limiter.kind, ...(({ allowed, denied, backendFailures, keys }) => ({ allowed, denied, backendFailures, keys }))(rl.limiter.stats()) } : undefined);
  let dispatchHealth: { status: string; detail?: string } = { status: "unknown" };
  telemetry.externals.dispatch = () => (dispatchStarted ? { metrics: (dispatchStarted.dispatch as { metrics?: () => unknown }).metrics?.() ?? null, health: dispatchHealth } : undefined);
  let otel: OtelRuntime | undefined;
  let inFlight = 0;
  // graceful shutdown: how long requests that are already running may take to finish after close() was called
  const shutdownGraceMs = readinessMs("PSO_SHUTDOWN_GRACE_MS", 5000, 0, 300_000);
  // ... and how long releasing the dependents (WebSocket connections, consumers, stores, exporters) may take after that, in total
  const shutdownCleanupMs = readinessMs("PSO_SHUTDOWN_CLEANUP_MS", 10_000, 1000, 120_000);
  const shutdown = { graceMs: shutdownGraceMs, cleanupMs: shutdownCleanupMs, deadlineMs: shutdownGraceMs + shutdownCleanupMs + 1000 };
  let draining = false;
  // connections the application accepted whose first request has not been received yet: during a drain they are not "idle", the request
  // is simply still on its way (under load the gap between accept and the first byte is wide). They get a short, bounded window.
  const awaitingFirstRequest = new Set<object>();
  const tlsIn = inboundTls(env);
  if (tlsIn) log("info", "inbound TLS enabled", { component: "http", mutualTls: tlsIn.requestCert === true });
  const makeServer = (h: (req: IncomingMessage, res: ServerResponse) => void): Server => (tlsIn ? (createHttpsServer({ maxHeaderSize: limits.maxHeaderBytes, ...tlsIn }, h) as unknown as Server) : createServer({ maxHeaderSize: limits.maxHeaderBytes }, h));
  const server = makeServer((req, res) => {
    awaitingFirstRequest.delete(req.socket);
    if (draining) res.setHeader("connection", "close"); // a kept-alive connection ends with this response instead of waiting for another request
    if (limits.maxConcurrentRequests > 0 && inFlight >= limits.maxConcurrentRequests) { // shed load instead of queueing without bound
      res.setHeader("retry-after", "1");
      sendProblem(res, req, "server_busy", randomUUID());
      return;
    }
    inFlight++;
    let released = false;
    const release = (): void => { if (!released) { released = true; inFlight--; } };
    res.once("close", release);
    runInSecurityContext(() => handle(req, res)).catch((err: unknown) => {
      // an error raised while an error was being answered (for example by a filter): never silent
      const correlationId = randomUUID();
      log("error", "unhandled error outside the request pipeline", { component: "http", correlationId, ...describeError(err, errorDetails) });
      if (!res.headersSent) sendProblem(res, req, "internal_error", correlationId);
    });
  });
  server.on("connection", (socket) => { awaitingFirstRequest.add(socket); socket.once("close", () => { awaitingFirstRequest.delete(socket); }); });
  server.on("clientError", (err: NodeJS.ErrnoException, socket) => { // oversized or malformed headers: a controlled answer, not a silent drop
    if (!socket.writable) return socket.destroy();
    const overflow = err.code === "HPE_HEADER_OVERFLOW";
    const body = JSON.stringify(buildProblem(overflow ? 431 : 400, overflow ? "header_fields_too_large" : "bad_request", { correlationId: randomUUID() })); // no request object exists yet: no instance
    socket.end(`HTTP/1.1 ${overflow ? "431 Request Header Fields Too Large" : "400 Bad Request"}\r\ncontent-type: ${PROBLEM_CONTENT_TYPE}\r\nconnection: close\r\ncache-control: no-store\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  let channelsRuntime: Awaited<ReturnType<ChannelsMod["attachChannels"]>> | undefined;
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  // the listener is closed once (no new connections); what is still connected is cut only when the "http" resource is released
  let notListening: Promise<void> | undefined;
  const stopListening = (): Promise<void> => (notListening ??= new Promise<void>((r) => { server.close(() => r()); })); // safe when the server never listened
  owned.add("http", async () => { const closed = stopListening(); server.closeAllConnections(); await closed; });

  if (dispatchStarted && !opts.dryRun) {
    try { await dispatchStarted.start(resolveDep as (c: never) => unknown); }
    catch (e) {
      const p = startupProblems(e);
      log("error", "dispatch start failed", { component: "dispatch", ...(p.code ? { code: p.code } : {}), detail: p.summary, problems: p.problems });
      await dispatchStarted.stop().catch(() => undefined);
      throw new StartupError(`dispatch could not start: ${p.text}\nthe application did not start`, startupDiagnostics(p.problems.map((m) => ({ code: p.code ?? "PSO_DISPATCH_START", message: m }))));
    }
  }
  if (channelsMod && channelsCfg?.enabled && registry && !opts.dryRun) {
    const routeFor = { module: "channels", method: "WS", path: channelsCfg.path, scopes: [], roleSets: [] } as never;
    try {
      channelsRuntime = await channelsMod.attachChannels({
        server, registry, config: channelsCfg, service: serviceName(projectDir, env), production: environment === "production",
        authenticate: async (authorization: string) => { const g = guards.get("jwt"); if (!g) return undefined; const r = await g({ headers: { authorization } } as unknown as IncomingMessage, routeFor); return typeof r === "object" && r.allow && r.principal ? r.principal : undefined; },
        authorize: (principal: Principal, need: { scopes: readonly string[]; roleSets: readonly (readonly string[])[] }) => (sec ? sec.authorize(principal, need, { route: "WS channels" }) : evaluate(principal, need)).allowed,
        resolve: resolveDep, resolveValidator,
      });
      const c = channelsRuntime;
      owned.add("channels", () => c.close());
      telemetry.externals.channels = () => channelsRuntime!.hub.metrics();
    } catch (e) { throw new StartupError(`channels could not start: ${(e as Error).message.split("\n")[0]}\nnothing was started`, []); }
  }
  if (!opts.dryRun) {
    // the exporter starts BEFORE the listener: a start-up that fails here has never accepted a request
    if (otlp) {
      try { otel = await startOtel(otlp, telemetry); telemetry.sink = otel.sink; const o = otel; owned.add("otel", () => o.shutdown()); }
      catch (e) { log("error", "OpenTelemetry export could not start", { detail: (e as Error).message.split("\n")[0] }); throw new StartupError(`${(e as Error).message.split("\n")[0]}\nnothing was started`, []); }
    }
    // ---- readiness dependencies: what THIS instance needs to do its configured work (probed in the background, never per request) ----
    const optional = new Set((eff["PSO_READINESS_OPTIONAL"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (dispatchStarted?.runtime) {
      const d = dispatchStarted.dispatch as { health?: () => Promise<{ status: string; detail?: string }> };
      readiness.add({ name: "dispatch", required: !optional.has("dispatch"), probe: async () => {
        try { const h = await d.health?.(); if (h) dispatchHealth = { status: h.status, ...(h.detail ? { detail: h.detail } : {}) }; return { up: h?.status === "up", ...(h?.detail ? { detail: h.detail } : {}) }; }
        catch (e) { dispatchHealth = { status: "down", detail: "health probe failed" }; throw e; }
      } });
    }
    if (channelsRuntime?.health) { const h = channelsRuntime.health; readiness.add({ name: "channels", required: !optional.has("channels"), probe: async () => { const r = await h(); return { up: r.status === "up", ...(r.detail ? { detail: r.detail } : {}) }; } }); }
    // a shared rate-limit store is required only when its failure policy refuses requests; with "open" the instance still serves
    if (rl.limiter?.health) { const h = rl.limiter.health.bind(rl.limiter); readiness.add({ name: "rateLimit", required: rl.config.onFailure === "closed" && !optional.has("ratelimit"), probe: h }); }
    telemetry.externals.readiness = () => { const r = readiness.report(); const down = Object.entries(r.checks).filter(([, c]) => c.required && c.status !== "UP").map(([n]) => n); return { status: r.status, ...(down.length ? { detail: `required dependency unavailable: ${down.join(", ")}` } : r.state !== "ready" ? { detail: r.state } : {}) }; };
    await readiness.probeNow(); // the first answer of /health/ready is already based on a real probe
    owned.add("probes", () => readiness.stop());
    readiness.start();
    await new Promise<void>((res, rej) => {
      const onError = (e: NodeJS.ErrnoException): void => rej(new StartupError(`cannot listen on ${host}:${port}: ${e.code === "EADDRINUSE" ? "the address is already in use" : e.code === "EACCES" ? "permission denied" : e.code === "EADDRNOTAVAIL" ? "the address is not available on this machine" : (e.code ?? e.name)}\nnothing was started`, startupDiagnostics([{ code: "PSO_HTTP_LISTEN", message: `listen ${host}:${port} failed (${e.code ?? e.name})` }])));
      server.once("error", onError);
      server.listen(port, host, () => { server.off("error", onError); res(); });
    }).catch((e: unknown) => { log("error", "the HTTP listener could not start", { component: "http", host, port, detail: (e as Error).message.split("\n")[0] }); throw e; });
    // lifecycle hooks: providers that a module declares and that implement onReady / onShutdown (declared, never discovered)
    const hooks: LifecycleHook[] = [];
    for (const m of modules) for (const p of ((m.def?.providers ?? []) as Array<new (...a: never[]) => unknown>)) {
      if (!isLifecycleProvider(p)) continue;
      const instance = resolveDep(p) as LifecycleHook["instance"];
      if (!hooks.some((h) => h.instance === instance)) hooks.push({ name: p.name, instance });
    }
    if (hooks.length) {
      const started: LifecycleHook[] = [];
      owned.add("hooks", async () => {
        for (const h of [...started].reverse()) {
          if (typeof h.instance.onShutdown !== "function") continue;
          try { await h.instance.onShutdown(); }
          catch (e) { log("warn", "a shutdown hook failed; continuing", { component: "lifecycle", hook: h.name, ...describeError(e, errorDetails) }); }
        }
      });
      for (const h of hooks) {
        if (typeof h.instance.onReady === "function") {
          try { await h.instance.onReady(); }
          catch (e) {
            log("error", "a start-up hook failed", { component: "lifecycle", hook: h.name, ...describeError(e, errorDetails) });
            throw new StartupError(`the start-up hook ${h.name}.onReady failed (${e instanceof Error ? e.name : "error"}); the application did not start\nnothing was started`, startupDiagnostics([{ code: "PSO_HOOK_FAILED", message: `${h.name}.onReady failed` }]));
          }
        }
        started.push(h);
      }
      log("info", "lifecycle hooks ran", { component: "lifecycle", hooks: hooks.map((h) => h.name) });
    }
    telemetry.state = "ready"; // only now: every resource is up and the listener is bound
  }
  log("info", "orchestrator listening", { component: "http", host, port, routes: verdict.routes.length, modules: modules.length - 1 });
  let closing: Promise<void> | undefined;
  /** Graceful shutdown, idempotent: readiness turns 503 first, then resources are released once each, in this order, each bounded in time. */
  const close = (): Promise<void> => (closing ??= (async () => {
    telemetry.beginShutdown();
    log("info", "shutdown started", { inFlight: telemetry.snapshot()["http"] ? (telemetry.snapshot()["http"] as { inFlight: number }).inFlight : 0, graceMs: shutdownGraceMs, cleanupMs: shutdownCleanupMs });
    // 1. no new connections; requests that are already running get the grace period to finish, with everything they depend on
    //    (security, rate limiting, upstreams, dispatch publishing) still available. Bounded: never longer than the grace period.
    draining = true;
    void stopListening();
    server.closeIdleConnections();
    const deadline = Date.now() + shutdownGraceMs;
    const firstRequestDeadline = Date.now() + Math.min(shutdownGraceMs, 1000); // a connection that stays silent longer than this is not a request in transit
    while ((inFlight > 0 || (awaitingFirstRequest.size > 0 && Date.now() < firstRequestDeadline)) && Date.now() < deadline) { await new Promise((r) => { setTimeout(r, 15); }); server.closeIdleConnections(); }
    if (inFlight > 0) log("warn", "the shutdown grace period ended with requests still running; their connections are closed now", { component: "http", interrupted: inFlight, graceMs: shutdownGraceMs });
    else log("info", "in-flight requests finished", { component: "http", waitedMs: Date.now() - (deadline - shutdownGraceMs) });
    // 2. dependents, each released once and bounded: WebSocket connections, dispatch consumers (in-flight messages finish or are
    //    given back), then what requests needed; 3. whatever is still connected is cut and the listener is gone
    for (const name of ["hooks", "probes", "channels", "dispatch", "rate-limit", "security", "otel", "http"]) await owned.release(name);
    await owned.releaseAll();
    telemetry.endShutdown();
  })());
  return { server, routes: verdict.routes, security: sec, close, shutdown };
}
